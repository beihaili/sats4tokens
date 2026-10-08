// Auto top-up over Nostr Wallet Connect: when a sold key runs low, ask the customer's own wallet to pay a top-up.
//
// The customer saves an NWC connection string on the key's page (or POST /api/autotopup) with: the amount of each
// top-up, the balance below which to top up, and a daily cap. Every AUTO_TOPUP_EVERY_S the gateway reads each such
// key's balance; under the threshold it makes an ordinary top-up order (makeTopupOrder, same pool check), creates
// its Lightning invoice and sends ONE `pay_invoice` to the wallet. From there it's the normal path: the mint sees
// the invoice paid → the gateway mints → makeTopupOnce adds the quota exactly once.
//
// Never pay twice: an order's invoice is sent to the wallet at most once (`auto.sentAt` is saved BEFORE sending),
// and a key gets a new auto order only when the previous one is finished, expired, or the wallet clearly said no.
// A lost answer ("unknown") keeps the order open until it expires, because the wallet may have paid it.
// Money limits: `perDay` here (counts every auto order that may have been paid), and the budget the customer sets
// on the connection in their wallet. 3 failures in a row pause it until the customer saves the settings again.
import type { LedgerData, Order } from './ledger.ts';
import { parseNwc, NwcError, type NwcConnection } from './nwc.ts';

export interface AutoTopup {
  nwc: string; // connection string: BEARER (spends the customer's wallet) — never to a page, the admin JSON or a log
  wallet: string; // wallet pubkey, shown shortened
  relay: string; // first relay's host, shown
  money: string; // each top-up (one of the shop's amounts)
  below: number; // FIAT: top up when the key holds less than this
  perDay: number; // FIAT: at most this much in any 24 h
  since: number;
  failures: number; // in a row; MAX_FAILURES pauses it
  nextTryAt?: number; // after a failure: wait before the next order
  lastError?: string; // shown on the key's page
  pausedAt?: number;
}

/** On an auto top-up order (`topup.auto`): whether its invoice went to the wallet and what the wallet said. */
export interface AutoSend {
  sentAt?: number; // saved before pay_invoice is sent: set = may have been paid
  outcome?: 'paid' | 'declined' | 'unknown'; // wallet said paid / clearly didn't pay / no readable answer
  error?: string;
}

export const MAX_FAILURES = 3;
const RETRY_AFTER_MS = 10 * 60_000; // × failures so far
const DAY_MS = 24 * 3600_000;
// wallet answers that mean the invoice was not paid (anything else after sending: maybe it was)
const NOT_PAID = new Set(['RELAY', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'NOT_IMPLEMENTED', 'RESTRICTED', 'UNAUTHORIZED', 'PAYMENT_FAILED', 'UNSUPPORTED_ENCRYPTION', 'NOT_FOUND']);

/** Relays we'll connect to: wss on a public host name (no IP literals, no single-label names like docker services). */
export function publicRelay(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'wss:' && u.hostname.includes('.') && !/^[\d.]+$/.test(u.hostname) && !u.hostname.includes(':') && u.hostname !== 'localhost';
  } catch {
    return false;
  }
}

/** Check a connection string for saving: parsed, only public wss relays kept, at most 3 (each may cost an 8s connect). */
export function checkNwc(uri: string): NwcConnection {
  const c = parseNwc(uri);
  const relays = c.relays.filter(publicRelay).slice(0, 3);
  if (relays.length === 0) throw new Error('the connection needs a public wss:// relay');
  return { ...c, relays };
}

/** Validate the settings part of a save. Returns the settings or an error message. */
export function checkSettings(
  b: { money?: unknown; below?: unknown; perDay?: unknown },
  amounts: string[],
): { money: string; below: number; perDay: number } | string {
  const money = String(b.money ?? '');
  const below = Number(b.below);
  const perDay = Number(b.perDay);
  if (!amounts.includes(money)) return `amount must be one of ${amounts.join(', ')}`;
  if (!(below > 0 && below <= 100)) return 'below must be more than 0 and at most 100';
  if (!(perDay >= Number(money) && perDay <= 500)) return `daily cap must be at least the amount (${money}) and at most 500`;
  return { money, below, perDay };
}

const autoOrders = (data: LedgerData, key: Order) => data.orders.filter((o) => o.kind === 'keytopup' && o.topup!.of === key.id && o.topup!.auto);

/** The key's unfinished auto order, if any: a new one waits for it. */
export function openAutoOrder(data: LedgerData, key: Order, now: number): Order | undefined {
  return autoOrders(data, key).find(
    (o) =>
      o.state === 'SETTLING' ||
      (o.state === 'PAID' && !o.notify.done) ||
      (o.state === 'PENDING' && o.expiresAt > now && o.topup!.auto!.outcome !== 'declined'),
  );
}

/** FIAT of the key's auto orders in the last 24 h that were (or may have been) paid. */
export function autoSpent24h(data: LedgerData, key: Order, now: number): number {
  return autoOrders(data, key)
    .filter((o) => o.createdAt > now - DAY_MS && (o.state === 'PAID' || o.state === 'SETTLING' || o.topup!.auto!.outcome !== 'declined'))
    .reduce((s, o) => s + Number(o.money), 0);
}

export type AutoDecision = { do: 'order' } | { do: 'wait'; why: string };

/** Should `key` get a new auto top-up order now, holding `balance` (FIAT)? Pure. */
export function decideAuto(data: LedgerData, key: Order, balance: number, now: number): AutoDecision {
  const a = key.auto;
  if (!a) return { do: 'wait', why: 'off' };
  if (a.pausedAt) return { do: 'wait', why: 'paused' };
  if (openAutoOrder(data, key, now)) return { do: 'wait', why: 'previous top-up not finished' };
  if (balance >= a.below) return { do: 'wait', why: 'balance ok' };
  if (a.nextTryAt && now < a.nextTryAt) return { do: 'wait', why: 'retrying later' };
  if (autoSpent24h(data, key, now) + Number(a.money) > a.perDay) return { do: 'wait', why: 'daily cap reached' };
  return { do: 'order' };
}

/** A failed attempt: count it, back off, pause after MAX_FAILURES. */
export function recordFailure(a: AutoTopup, error: string, now: number): void {
  a.failures++;
  a.lastError = error;
  a.nextTryAt = now + RETRY_AFTER_MS * a.failures;
  if (a.failures >= MAX_FAILURES) a.pausedAt = now;
}

/** What the key's page may show: no connection secret, wallet and relay only as hints. */
export function publicAuto(data: LedgerData, key: Order, now: number) {
  const a = key.auto;
  if (!a) return undefined;
  const last = autoOrders(data, key).at(-1);
  return {
    money: a.money,
    below: a.below,
    perDay: a.perDay,
    wallet: a.wallet.slice(0, 8) + '…',
    relay: a.relay,
    paused: !!a.pausedAt,
    failures: a.failures,
    lastError: a.lastError,
    spent24h: autoSpent24h(data, key, now),
    last: last && { at: last.createdAt, money: last.money, state: last.state, outcome: last.topup!.auto!.outcome, applied: !!last.topup!.applied },
  };
}

export interface AutoDeps {
  data: () => LedgerData;
  save: () => void;
  remaining: (tokenId: number) => Promise<number | undefined>; // key balance in FIAT, undefined = token deleted
  newTopup: (key: Order, money: string) => Promise<Order | string>; // a saved top-up order, or why not (pool)
  invoice: (orderId: string) => Promise<string>; // the order's bolt11 (created once)
  checkSoon: (orderId: string) => void; // the wallet says it paid: check the quote next
  pay: (c: NwcConnection, invoice: string) => Promise<{ preimage: string }>;
  now: () => number;
  log: (line: string) => void;
}

export class AutoTopups {
  private d: AutoDeps;
  private running = false;
  private sending = new Set<string>(); // order ids with a pay_invoice in flight in this process

  constructor(d: AutoDeps) {
    this.d = d;
  }

  /** One pass over the keys with auto top-up on. Skips if the previous pass is still running. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const key of this.d.data().orders.filter((o) => o.kind === 'key' && o.auto && o.apiKey)) {
        try {
          await this.step(key);
        } catch (e) {
          this.d.log(`🔁 auto top-up ${key.id.slice(0, 10)}…: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async step(key: Order): Promise<void> {
    const a = key.auto!;
    const now = this.d.now();
    const open = openAutoOrder(this.d.data(), key, now);
    if (open) {
      const s = open.topup!.auto!;
      if (s.sentAt === undefined && open.state === 'PENDING') return this.send(key, open); // crashed before sending
      if (s.sentAt !== undefined && !s.outcome && !this.sending.has(open.id)) {
        s.outcome = 'unknown'; // crashed while the wallet was asked: it may have paid, so never ask again
        this.d.save();
      }
      return;
    }
    if (a.pausedAt) return;
    const balance = await this.d.remaining(key.apiKey!.tokenId);
    if (balance === undefined) {
      a.pausedAt = now;
      a.lastError = 'the key no longer exists';
      this.d.save();
      return;
    }
    const dec = decideAuto(this.d.data(), key, balance, now);
    if (dec.do === 'wait') return;
    const o = await this.d.newTopup(key, a.money);
    if (typeof o === 'string') {
      if (a.lastError !== o) {
        a.lastError = o; // e.g. the pool is sold out: not the wallet's fault, no failure counted
        this.d.save();
      }
      return;
    }
    o.topup!.auto = {};
    this.d.save();
    this.d.log(`🔁 ${key.id.slice(0, 10)}…: balance ${balance.toFixed(2)} < ${a.below} → auto top-up ${o.id.slice(0, 10)}… (${o.money})`);
    return this.send(key, o);
  }

  private async send(key: Order, o: Order): Promise<void> {
    const a = key.auto!;
    const s = o.topup!.auto!;
    let conn: NwcConnection;
    let invoice: string;
    try {
      conn = checkNwc(a.nwc);
      invoice = await this.d.invoice(o.id);
    } catch (e) {
      s.outcome = 'declined'; // nothing was sent
      s.error = (e as Error).message;
      recordFailure(a, s.error, this.d.now());
      this.d.save();
      return;
    }
    s.sentAt = this.d.now();
    this.d.save(); // before sending: after a crash from here on, this invoice is never sent again
    this.sending.add(o.id);
    try {
      await this.d.pay(conn, invoice);
      s.outcome = 'paid';
      a.failures = 0;
      a.lastError = undefined;
      a.nextTryAt = undefined;
      this.d.checkSoon(o.id);
      this.d.log(`🔁 ${o.id.slice(0, 10)}…: wallet paid the auto top-up`);
    } catch (e) {
      const code = e instanceof NwcError ? e.code : 'OTHER';
      s.outcome = NOT_PAID.has(code) ? 'declined' : 'unknown';
      s.error = (e as Error).message;
      recordFailure(a, s.error, this.d.now());
      this.d.log(`🔁 ${o.id.slice(0, 10)}…: wallet ${s.outcome === 'declined' ? 'did not pay' : 'gave no clear answer'}: ${s.error}`);
    } finally {
      this.sending.delete(o.id);
      this.d.save();
    }
  }
}
