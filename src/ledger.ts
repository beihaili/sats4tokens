// Order ledger. Pure logic + one durable save(); no network here.
//
// Exactly-once crediting rests on three rules:
//   * out_trade_no is the idempotency key: a resubmit with the same money returns the same order,
//     with different money it is rejected.
//   * Write-ahead: before ANY request that makes the mint sign for us, the order records the
//     deterministic counter range it will use (settle.counter/count), and the cursor moves past it.
//     That save happens BEFORE the mint call.
//   * Recovery only goes through decideSettle(): NUT-09 restore of that exact counter range tells us
//     whether the mint already signed. Either we find the proofs, or it is safe to retry with the same
//     counter (identical blinded messages, so at most one signing can ever count).
// Notify is at-least-once with backoff; new-api's RechargeEpay is idempotent on its side.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Params } from './epay.ts';
import type { ApiKey } from './keyshop.ts';
import type { AutoSend, AutoTopup } from './autotopup.ts';

export type OrderState = 'PENDING' | 'SETTLING' | 'PAID' | 'EXPIRED';
export type Via = 'lightning' | 'cashu';

export interface Settle {
  via: Via;
  keysetId: string;
  counter: number; // first deterministic counter of our outputs
  count: number; // how many outputs
  token?: string; // cashu path only: the customer's token (bearer until our swap lands)
  startedAt: number;
}

export interface Order {
  id: string; // our trade_no
  outTradeNo: string; // merchant's order id (new-api: USR{uid}NO…)
  pid: string;
  type: string;
  name: string;
  money: string; // fiat, exactly as the merchant sent it ("73.00")
  notifyUrl: string;
  returnUrl: string;
  fiat: string;
  btcPrice: number; // fiat per BTC, locked at creation
  sats: number; // amount due
  createdAt: number;
  expiresAt: number;
  quote?: { id: string; request: string };
  state: OrderState;
  settle?: Settle;
  lastError?: string; // shown on the checkout page (e.g. "token already spent")
  paid?: { at: number; via: Via; sats: number; fee: number };
  tokenHash?: string; // cashu path: tokenFingerprint() of the token that paid, so a retried POST gets the same answer
  notify: { done: boolean; attempts: number; nextAt: number; lastError?: string; doneAt?: number };
  // Key shop orders (no merchant): "notify" is the step that creates the API key in new-api ('key') or adds the paid
  // quota to a key sold earlier ('keytopup').
  kind?: 'key' | 'keytopup';
  bonus?: number; // key shop: extra quota in percent of `money` (KEY_BONUS tier), locked when the order is made
  apiKey?: ApiKey; // BEARER: whoever has it spends the quota; shown only to the order's own page
  topup?: Topup;
  auto?: AutoTopup; // key orders: auto top-up over Nostr Wallet Connect (holds a BEARER connection string)
}

/**
 * A top-up of a key sold earlier. Its page never shows the key (only `keyHint`), so the link can be sent to someone
 * else to pay. Exactly once rests on new-api keeping `remain_quota + used_quota` = all quota ever given to the token
 * (calls move quota from one to the other): `base` is that total before this top-up, saved together with `add`
 * before anything is changed in new-api, so a retry after a crash adds only what is still missing (decideTopup).
 */
export interface Topup {
  of: string; // id of the key order (a capability: never sent to this order's page)
  tokenId: number;
  keyHint: string; // "sk-…a1b2"
  base?: number; // token's remain + used before this top-up (write-ahead, with `add`)
  add?: number; // quota this top-up adds
  applied?: { at: number; remaining: number }; // the key's balance (FIAT) right after
  needsRefund?: string; // couldn't be applied (key deleted in new-api): paid, credited nowhere; a human refunds
  auto?: AutoSend; // made by auto top-up: was its invoice sent to the customer's wallet, and what it said
}

export interface LedgerData {
  version: 1;
  nextCounter: number; // next unused deterministic counter (positive: 0 means "auto" in cashu-ts)
  orders: Order[];
  proofs: string[]; // serializeProofs() output — BEARER MONEY, never commit data/
}

export const emptyLedger = (): LedgerData => ({ version: 1, nextCounter: 1, orders: [], proofs: [] });

export class Ledger {
  file: string;
  data: LedgerData;

  constructor(file: string) {
    this.file = file;
    this.data = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerData) : emptyLedger();
  }

  /** Durable write: tmp file + fsync + atomic rename. A crash leaves old or new, never half. */
  save(): void {
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify(this.data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.file);
  }

  order(id: string): Order | undefined {
    return this.data.orders.find((o) => o.id === id);
  }
}

// ------------------------------------------------------------------ submit

const REQUIRED = ['pid', 'type', 'out_trade_no', 'notify_url', 'name', 'money'] as const;

export type SubmitCheck =
  | { kind: 'existing'; order: Order }
  | { kind: 'new' }
  | { kind: 'reject'; reason: string };

/** Decide what a (signature-verified) submit means. Pure. */
export function checkSubmit(data: LedgerData, p: Params, pid: string): SubmitCheck {
  for (const k of REQUIRED) if (!p[k]) return { kind: 'reject', reason: `missing ${k}` };
  if (p.pid !== pid) return { kind: 'reject', reason: 'unknown pid' };
  if (!/^\d+(\.\d{1,2})?$/.test(p.money) || Number(p.money) <= 0) return { kind: 'reject', reason: 'bad money' };
  if (!/^https?:\/\//.test(p.notify_url)) return { kind: 'reject', reason: 'bad notify_url' };
  const prev = data.orders.find((o) => o.pid === p.pid && o.outTradeNo === p.out_trade_no);
  if (!prev) return { kind: 'new' };
  if (prev.money !== p.money || prev.notifyUrl !== p.notify_url) {
    return { kind: 'reject', reason: 'out_trade_no reused with different money/notify_url' };
  }
  return { kind: 'existing', order: prev };
}

/** Fiat → sats, rounded up so the merchant is never short. */
/** "€2", "$1", "¥5" — money with its currency symbol (or "2 CHF" for currencies without one here). */
const SYMBOLS: Record<string, string> = { usd: '$', eur: '€', cny: '¥', gbp: '£' };
export function moneyLabel(money: string, fiat: string): string {
  const s = SYMBOLS[fiat.toLowerCase()];
  return s ? s + money : `${money} ${fiat.toUpperCase()}`;
}

/**
 * Bonus tiers from env `KEY_BONUS`, e.g. "5:5,10:10" = a €5 order gets 5% extra quota, €10 gets 10%. Amounts not
 * listed get none. Bad entries are ignored (logged by the caller as an empty table).
 */
export function parseBonusTiers(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (s ?? '').split(',')) {
    const m = part.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (m && Number(m[2]) > 0 && Number(m[2]) <= 50) out[String(Number(m[1]))] = Number(m[2]);
  }
  return out;
}

/** What a key shop order puts on a key, in FIAT: what was paid plus its bonus. */
export const creditOf = (o: Pick<Order, 'money' | 'bonus'>): number => Number(o.money) * (1 + (o.bonus ?? 0) / 100);

const bonusLabel = (bonus?: number) => (bonus ? ` + ${bonus}% bonus` : '');

export function satsFor(money: string, btcPrice: number): number {
  // toFixed: 1/100000*1e8 is 1000.0000000000001 in floating point, which must not round up to 1001
  return Math.max(1, Math.ceil(Number(((Number(money) / btcPrice) * 1e8).toFixed(6))));
}

export function newOrderId(now: number): string {
  return 'CE' + now.toString(36).toUpperCase() + randomBytes(4).toString('hex').toUpperCase();
}

export function makeOrder(p: Params, o: { fiat: string; btcPrice: number; now: number; ttlMs: number }): Order {
  return {
    id: newOrderId(o.now),
    outTradeNo: p.out_trade_no,
    pid: p.pid,
    type: p.type,
    name: p.name,
    money: p.money,
    notifyUrl: p.notify_url,
    returnUrl: p.return_url ?? '',
    fiat: o.fiat,
    btcPrice: o.btcPrice,
    sats: satsFor(p.money, o.btcPrice),
    createdAt: o.now,
    expiresAt: o.now + o.ttlMs,
    state: 'PENDING',
    notify: { done: false, attempts: 0, nextAt: 0 },
  };
}

/**
 * A key shop order: the customer buys an API key directly, no merchant redirect. The id is 128 random bits
 * because the checkout URL (/pay/:id) is the only thing that later shows the key.
 */
export function makeKeyOrder(money: string, o: { fiat: string; btcPrice: number; now: number; ttlMs: number; bonus?: number }): Order {
  const id = 'CK' + randomBytes(16).toString('hex').toUpperCase();
  return {
    id,
    outTradeNo: id,
    pid: '',
    type: 'bitcoin',
    name: `AI API key · ${moneyLabel(money, o.fiat)}${bonusLabel(o.bonus)}`,
    money,
    notifyUrl: '',
    returnUrl: '',
    fiat: o.fiat,
    btcPrice: o.btcPrice,
    sats: satsFor(money, o.btcPrice),
    createdAt: o.now,
    expiresAt: o.now + o.ttlMs,
    state: 'PENDING',
    notify: { done: false, attempts: 0, nextAt: 0 },
    kind: 'key',
    ...(o.bonus ? { bonus: o.bonus } : {}),
  };
}

/** A top-up for the key sold by `parent`: same checkout and payment as buying a key, then makeTopupOnce. */
export function makeTopupOrder(parent: Order, money: string, o: { fiat: string; btcPrice: number; now: number; ttlMs: number; bonus?: number }): Order {
  if (parent.kind !== 'key' || !parent.apiKey) throw new Error('not a sold key');
  const keyHint = 'sk-…' + parent.apiKey.key.slice(-4);
  return {
    ...makeKeyOrder(money, o),
    name: `Top-up · ${moneyLabel(money, o.fiat)}${bonusLabel(o.bonus)} for key ${keyHint}`,
    kind: 'keytopup',
    topup: { of: parent.id, tokenId: parent.apiKey.tokenId, keyHint },
  };
}

/** The key order that sold `key` ("sk-…", with or without the prefix), if it was sold here. */
export function findKeyOrder(data: LedgerData, key: string): Order | undefined {
  const k = 'sk-' + key.trim().replace(/^sk-/, '');
  return k.length > 10 ? data.orders.find((o) => o.kind === 'key' && o.apiKey?.key === k) : undefined;
}

/** Quota still missing for a top-up: the token held `base` in total before it, and must hold `base + add` after. */
export const decideTopup = (total: number, base: number, add: number): number => Math.max(0, base + add - total);

/**
 * Another top-up of the same key is half-way (its base is saved, not finished): this one waits, because its own base
 * must be read after that one is fully added (else both would read the same base and one would be lost).
 */
export function topupBlocked(data: LedgerData, o: Order): boolean {
  return data.orders.some(
    (x) => x !== o && x.kind === 'keytopup' && x.topup!.tokenId === o.topup!.tokenId && x.topup!.base !== undefined && !x.notify.done,
  );
}

/**
 * FIAT (bonus included) promised to key shop orders that new-api doesn't hold as token quota yet: open or settling orders (they may
 * still be paid) and paid ones whose key / top-up isn't made yet. The pool check subtracts it from what's left.
 */
export function pendingMoney(data: LedgerData, now: number): number {
  let sum = 0;
  for (const o of data.orders) {
    if (o.kind !== 'key' && o.kind !== 'keytopup') continue;
    // an auto top-up the customer's wallet refused won't be paid: it doesn't hold pool space until it expires
    const refused = o.topup?.auto?.outcome === 'declined';
    const open = (o.state === 'PENDING' && o.expiresAt > now && !refused) || o.state === 'SETTLING' || (o.state === 'PAID' && !o.notify.done);
    if (open) sum += creditOf(o); // what it will put on a key, bonus included
  }
  return sum;
}

// ------------------------------------------------------------------ settle

/**
 * Write-ahead step: claim the counter range [nextCounter, nextCounter+count) for this order.
 * The caller MUST save() before sending anything to the mint.
 */
export function beginSettle(data: LedgerData, order: Order, s: Omit<Settle, 'counter' | 'startedAt'>, now: number): Settle {
  // EXPIRED is allowed for lightning only: an invoice paid after our TTL is still money received.
  const ok = order.state === 'PENDING' || (order.state === 'EXPIRED' && s.via === 'lightning');
  if (!ok) throw new Error(`order ${order.id} is ${order.state}`);
  const settle: Settle = { ...s, counter: data.nextCounter, startedAt: now };
  data.nextCounter += s.count;
  order.state = 'SETTLING';
  order.settle = settle;
  order.lastError = undefined;
  return settle;
}

export function finishSettle(data: LedgerData, order: Order, proofs: string[], sats: number, now: number): void {
  data.proofs.push(...proofs);
  order.state = 'PAID';
  order.paid = { at: now, via: order.settle!.via, sats, fee: Math.max(0, order.sats - sats) };
  if (order.settle) delete order.settle.token; // spent now; no need to keep bearer material
  order.notify.nextAt = now;
}

/** sha256 of a pasted token as the customer sent it (trimmed, no `cashu:` prefix). Not bearer: can't be spent. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token.trim().replace(/^cashu:/i, '')).digest('hex');
}

/** A token POSTed again for the order it already paid (or is paying): a client retry, answered like the first. */
export function isTokenRetry(order: Order, token: string): boolean {
  return order.state !== 'PENDING' && order.state !== 'EXPIRED' && !!order.tokenHash && order.tokenHash === tokenFingerprint(token);
}

/** Back to PENDING after a cashu attempt that can never succeed (token spent elsewhere). */
export function abortSettle(order: Order, reason: string): void {
  order.state = 'PENDING';
  order.settle = undefined;
  order.tokenHash = undefined;
  order.lastError = reason;
}

export type SettleFacts = {
  restored: number; // proofs found by NUT-09 restore of exactly settle.counter..+count
  quoteState?: 'UNPAID' | 'PAID' | 'ISSUED'; // lightning path
  inputState?: 'UNSPENT' | 'PENDING' | 'SPENT'; // cashu path: state of the customer's proofs
};
export type SettleAction = 'finish' | 'retry' | 'wait' | 'abort' | 'conflict';

/**
 * Recovery table for an order stuck in SETTLING (after a crash or an error), matched in order:
 *   1. restore found our outputs           → finish  (the mint signed; we just lost the reply)
 *   2. lightning, quote PAID               → retry   (same counter → same outputs; safe)
 *   3. lightning, quote ISSUED / UNPAID    → conflict (issued to someone else?? needs a human)
 *   4. cashu, inputs UNSPENT               → retry
 *   5. cashu, inputs PENDING               → wait
 *   6. cashu, inputs SPENT                 → abort   (customer double-spent the token elsewhere)
 */
export function decideSettle(via: Via, f: SettleFacts): SettleAction {
  if (f.restored > 0) return 'finish';
  if (via === 'lightning') return f.quoteState === 'PAID' ? 'retry' : 'conflict';
  if (f.inputState === 'UNSPENT') return 'retry';
  if (f.inputState === 'PENDING') return 'wait';
  return 'abort';
}

// ------------------------------------------------------------------ notify

/** 5s, 10s, 20s … capped at 10 min. */
export const notifyBackoffMs = (attempts: number): number => Math.min(5000 * 2 ** attempts, 600_000);

/** The callback new-api's EpayNotify expects (before signing). */
export function notifyParams(o: Order): Params {
  return {
    pid: o.pid,
    trade_no: o.id,
    out_trade_no: o.outTradeNo,
    type: o.type,
    name: o.name,
    money: o.money,
    trade_status: 'TRADE_SUCCESS',
  };
}

export const dueForNotify = (o: Order, now: number): boolean => o.state === 'PAID' && !o.notify.done && o.notify.nextAt <= now;
