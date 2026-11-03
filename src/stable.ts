// USDT/USDC checkout: amounts, matching on-chain transfers to orders, and the watcher that settles them.
//
// The buyer picks a rail (network + token) on the checkout page; the order gets a quote: our address and an exact
// amount (money × USD per FIAT, rounded up to the cent). Every order waiting on one rail has a different amount (+0.01
// on a clash), because the amount is what tells transfers apart: one address per network, no memo. A confirmed transfer
// is then claimed, in this order, by
//   1. the waiting order whose amount it is exactly (or exactly what a part-paid order still lacks);
//   2. a paid order whose amount it is exactly (paid twice: noted as overpaid), or the one order still waiting on that
//      rail if it is ≥ half of what that order lacks (exchanges that keep their fee, typos; expired-but-in-window orders
//      count only when nothing is open) — not when both fit;
//   3. nobody: kept in `unmatched` for a human (wrong network, two orders and an odd amount, …).
// Paid in full → PAID, the same notify step as Lightning (key, top-up or the merchant's callback). Paid short → stays
// PENDING until it expires (the rest may still come), then PAID for what arrived: a key gets that share of its credit,
// a merchant (console) order is held for a human (its callback can only say "paid in full"). More than due → PAID in
// full, the rest noted as `overpaid` for a manual refund. Late transfers count for STABLE_LATE_HOURS after expiry,
// the same rule as a late Lightning invoice.
import type { LedgerData, Order, StablePayment, StableQuote, StableVia } from './ledger.ts';
import { Scanner, type Rail, type ScanState, type Transfer } from './chain.ts';

const SKEW_MS = 2 * 60_000; // a transfer stamped this much before its quote still counts (clocks differ)
const DUST_MICRO = 10_000n; // < 0.01: ignored (address-poisoning spam sends zero or dust amounts)
const MIN_SHARE = 0.5; // rule 2: a transfer to the only waiting order must bring at least this share of what it lacks

const pow10 = (n: number) => 10n ** BigInt(n);
/** Smallest units → micro-USD (6 decimals), so rails with different decimals add up. */
export const toMicro = (units: string | bigint, decimals: number): bigint =>
  decimals >= 6 ? BigInt(units) / pow10(decimals - 6) : BigInt(units) * pow10(6 - decimals);
/** micro-USD → "5.42" (cents), or more digits when it isn't whole cents ("5.419"). */
export function usd(micro: bigint): string {
  const neg = micro < 0n;
  const m = neg ? -micro : micro;
  let frac = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${m / 1_000_000n}.${frac}`;
}

/** money (FIAT) × rate, rounded up to the cent, in micro-USD. */
export function stableMicro(money: string, usdPerFiat: number): bigint {
  // toFixed: 5 × 1.1 is 5.500000000000001 in floating point, which must not round up to 5.51
  return BigInt(Math.ceil(Number((Number(money) * usdPerFiat * 100).toFixed(6)))) * 10_000n;
}

/** Still taking payments on its quotes: open, or expired less than `lateMs` ago (PENDING past expiry included). */
export const waiting = (o: Order, now: number, lateMs: number): boolean =>
  o.state === 'PENDING' || (o.state === 'EXPIRED' && now - o.expiresAt < lateMs);
const open = (o: Order, now: number) => o.state === 'PENDING' && now <= o.expiresAt;

export const received = (o: Order): bigint => (o.stable?.payments ?? []).reduce((s, p) => s + toMicro(p.units, p.decimals), 0n);
/** micro-USD due: the quote of the rail the first transfer came on (quotes differ only by a clash's cents). */
export function due(o: Order): bigint {
  const st = o.stable!;
  const q = st.quotes.find((x) => x.rail === st.payments[0]?.rail) ?? st.quotes[0];
  return toMicro(q.units, q.decimals);
}

/**
 * Give an open order a quote on `rail` (once per rail; the rate is locked by the first one). The amount is moved up
 * by 0.01 until no other waiting order on this rail has it. Synchronous: no two quotes can pick the same amount.
 */
export function quoteStable(data: LedgerData, o: Order, rail: Rail, usdPerFiat: number, now: number, lateMs: number): StableQuote {
  const have = o.stable?.quotes.find((q) => q.rail === rail.id);
  if (have) return have;
  if (!open(o, now)) throw new Error(o.state === 'PENDING' ? 'order expired' : `order is ${o.state.toLowerCase()}`);
  o.stable ??= { usdPerFiat, quotes: [], payments: [] };
  const taken = new Set<bigint>();
  for (const x of data.orders) {
    if (x === o || !waiting(x, now, lateMs)) continue;
    for (const q of x.stable?.quotes ?? []) if (q.rail === rail.id) taken.add(toMicro(q.units, q.decimals));
  }
  let micro = stableMicro(o.money, o.stable.usdPerFiat);
  while (taken.has(micro)) micro += 10_000n;
  const units = rail.decimals >= 6 ? micro * pow10(rail.decimals - 6) : micro / pow10(6 - rail.decimals);
  const q: StableQuote = { rail: rail.id, amount: usd(micro), units: units.toString(), decimals: rail.decimals, address: rail.address, at: now };
  o.stable.quotes.push(q);
  return q;
}

export type Match = { order: Order; how: 'exact' | 'only' | 'extra' } | undefined;

/** Which order a transfer on `rail` belongs to (rules 1–3 at the top). Doesn't change anything. */
export function matchTransfer(data: LedgerData, t: Pick<Transfer, 'rail' | 'units' | 'at'>, decimals: number, now: number, lateMs: number): Match {
  const micro = toMicro(t.units, decimals);
  const quoted = data.orders
    .map((o) => ({ o, q: o.stable?.quotes.find((q) => q.rail === t.rail) }))
    .filter((x): x is { o: Order; q: StableQuote } => !!x.q && t.at >= x.q.at - SKEW_MS);
  const lacks = (o: Order, q: StableQuote) => (o.stable!.payments.length ? due(o) - received(o) : toMicro(q.units, q.decimals));
  const wait = quoted.filter((x) => waiting(x.o, now, lateMs));
  const exact = wait.filter((x) => toMicro(x.q.units, x.q.decimals) === micro || (x.o.stable!.payments.length > 0 && lacks(x.o, x.q) === micro));
  if (exact.length === 1) return { order: exact[0].o, how: 'exact' };
  if (exact.length > 1) return undefined;
  // paid already (another transfer, Lightning or Cashu) but its amount comes again: a second payment, refund by hand
  const again = quoted.filter((x) => (x.o.state === 'PAID' || x.o.state === 'SETTLING') && now - x.q.at < lateMs + (x.o.expiresAt - x.o.createdAt)
    && toMicro(x.q.units, x.q.decimals) === micro);
  let only: Match;
  for (const pool of [wait.filter((x) => open(x.o, now)), wait]) {
    if (pool.length === 0) continue;
    if (pool.length > 1) break;
    const { o, q } = pool[0];
    if (Number(micro) >= MIN_SHARE * Number(lacks(o, q))) only = { order: o, how: 'only' };
    break;
  }
  // both readings fit (a second payment of a paid order, or a short one for the open order): a human decides
  if (again.length > 1 || (again.length === 1 && only)) return undefined;
  return again.length === 1 ? { order: again[0].o, how: 'extra' } : only;
}

/**
 * Count a confirmed transfer on `o` and move the order on: PAID when it's all there, or when it's expired and something
 * came; still PENDING while part-paid and open. On an order already settled it only adds to `overpaid`.
 */
export function applyPayment(o: Order, p: StablePayment, now: number): 'paid' | 'partial' | 'extra' {
  const st = (o.stable ??= { usdPerFiat: 0, quotes: [], payments: [] });
  st.payments.push(p);
  if (st.seen?.tx === p.tx) st.seen = undefined;
  if (o.state !== 'PENDING' && o.state !== 'EXPIRED') {
    const over = received(o) - BigInt(st.credited ?? 0); // paid by sats: nothing of it was credited
    if (over > 0n) st.overpaid = usd(over);
    return 'extra';
  }
  if (received(o) >= due(o) || o.state === 'EXPIRED' || now > o.expiresAt) {
    markPaid(o, now);
    return 'paid';
  }
  o.lastError = undefined;
  return 'partial';
}

/**
 * Part-paid and expired: settle for what came (applyPayment's rules). True if it changed the order. EXPIRED too: the
 * gateway's own pass expires orders without an invoice, part-paid or not.
 */
export function settleExpired(o: Order, now: number): boolean {
  if (!(o.state === 'EXPIRED' || (o.state === 'PENDING' && now > o.expiresAt)) || !o.stable?.payments.length) return false;
  markPaid(o, now);
  return true;
}

function markPaid(o: Order, now: number): void {
  const st = o.stable!;
  const got = received(o);
  const owed = due(o);
  st.credited = (got < owed ? got : owed).toString();
  if (got < owed) {
    // a key shop order can take part of its credit; a merchant's callback can't say "paid 74%"
    if (o.kind) st.ratio = Number(got) / Number(owed);
    else st.hold = `paid ${usd(got)} of ${usd(owed)} USD: credit or refund by hand`;
  }
  if (got > owed) st.overpaid = usd(got - owed);
  const last = st.payments.at(-1)!;
  o.state = 'PAID';
  o.paid = { at: now, via: st.payments[0].rail as StableVia, sats: 0, fee: 0, amount: usd(got), token: tokenOf(st.payments[0].rail), tx: last.tx };
  o.lastError = undefined;
  o.notify.nextAt = now;
}

const tokenOf = (rail: string) => rail.split('-').at(-1)!.toUpperCase();

/** Transfer keys already counted (on orders or unmatched): a transfer is never counted twice. */
export function counted(data: LedgerData): Set<string> {
  const s = new Set<string>();
  for (const o of data.orders) for (const p of o.stable?.payments ?? []) s.add(p.key);
  for (const p of data.stable?.unmatched ?? []) s.add(p.key);
  return s;
}

/** What the checkout page may see of the stablecoin side (addresses are public; no internals). */
export function publicStable(o: Order, rails: Rail[]) {
  const st = o.stable;
  if (!st) return undefined;
  const rail = (id: string) => rails.find((r) => r.id === id);
  const got = received(o);
  return {
    quotes: st.quotes.map((q) => ({ rail: q.rail, amount: q.amount, address: q.address, token: tokenOf(q.rail), net: rail(q.rail)?.netName ?? q.rail, need: rail(q.rail)?.confirmations })),
    seen: st.seen,
    received: st.payments.length ? usd(got) : undefined,
    lacks: st.payments.length && o.state === 'PENDING' ? usd(due(o) - got) : undefined,
    payments: st.payments.map((p) => ({ rail: p.rail, amount: usd(toMicro(p.units, p.decimals)), tx: p.tx, url: (rail(p.rail)?.explorer ?? '') + p.tx })),
    ratio: st.ratio,
    overpaid: st.overpaid,
    hold: !!st.hold,
  };
}

// ------------------------------------------------------------------ watcher

export interface StableDeps {
  data: () => LedgerData;
  save: () => void;
  now: () => number;
  log: (line: string) => void;
  rails: Rail[];
  scanner?: (rail: Rail) => Pick<Scanner, 'scan'>;
  lateMs: number;
  pollMs?: number; // a rail with an open order (default 15s)
  latePollMs?: number; // only expired orders in their late window (default 2 min)
}

export interface RailStatus {
  id: string;
  lastScan?: number;
  lastError?: string;
  failures: number;
}

/**
 * Polls each rail that has waiting quotes (nothing is asked while no order waits on it). RPC errors back off per rail,
 * 15s doubling to 5 min, and the next pass retries; nothing is counted from a failed pass.
 */
export class StableWatcher {
  private d: StableDeps;
  private scanners = new Map<string, Pick<Scanner, 'scan'>>();
  private nextAt = new Map<string, number>();
  status = new Map<string, RailStatus>();

  constructor(d: StableDeps) {
    this.d = d;
    for (const r of d.rails) {
      this.scanners.set(r.id, d.scanner ? d.scanner(r) : new Scanner(r));
      this.status.set(r.id, { id: r.id, failures: 0 });
    }
  }

  async tick(): Promise<void> {
    const data = this.d.data();
    const now = this.d.now();
    let changed = false;
    for (const o of data.orders) {
      if (settleExpired(o, now)) {
        changed = true;
        this.d.log(`💵 ${short(o)}: expired part-paid, settled for ${o.paid!.amount} USD${o.stable!.hold ? ' — HELD for a human' : ''}`);
      }
    }
    if (changed) this.d.save();
    for (const r of this.d.rails) await this.tickRail(r);
  }

  private async tickRail(rail: Rail): Promise<void> {
    const data = this.d.data();
    const now = this.d.now();
    const quotes = data.orders
      .filter((o) => waiting(o, now, this.d.lateMs))
      .flatMap((o) => (o.stable?.quotes ?? []).filter((q) => q.rail === rail.id).map((q) => ({ o, q })));
    if (!quotes.length || (this.nextAt.get(rail.id) ?? 0) > now) return;
    const st = this.status.get(rail.id)!;
    const since = Math.min(...quotes.map((x) => x.q.at)) - SKEW_MS;
    const state: ScanState = { cursor: data.stable?.cursors[rail.id] };
    let transfers: Transfer[];
    try {
      transfers = await this.scanners.get(rail.id)!.scan(since, state, counted(data), now);
    } catch (e) {
      st.failures++;
      st.lastError = (e as Error).message;
      const wait = Math.min(300_000, 15_000 * 2 ** (st.failures - 1));
      this.nextAt.set(rail.id, now + wait);
      this.d.log(`💵 ${rail.id}: scan failed (#${st.failures}): ${st.lastError} — retry in ${wait / 1000}s`);
      return;
    }
    st.failures = 0;
    st.lastError = undefined;
    st.lastScan = now;
    this.nextAt.set(rail.id, now + (quotes.some((x) => open(x.o, now)) ? (this.d.pollMs ?? 15_000) : (this.d.latePollMs ?? 120_000)));
    let changed = false;
    data.stable ??= { cursors: {}, unmatched: [] };
    if (state.cursor !== undefined && state.cursor !== data.stable.cursors[rail.id]) {
      data.stable.cursors[rail.id] = state.cursor;
      changed = true;
    }
    const done = counted(data);
    for (const t of transfers.sort((a, b) => a.at - b.at)) {
      if (done.has(t.key) || t.at < since || toMicro(t.units, rail.decimals) < DUST_MICRO) continue;
      const m = matchTransfer(data, t, rail.decimals, now, this.d.lateMs);
      const amount = usd(toMicro(t.units, rail.decimals));
      if (t.confirmations < t.need) {
        // shown on the checkout page ("seen, 3/19 confirmations"); nothing is counted yet
        const st2 = m && m.how !== 'extra' ? m.order.stable! : undefined;
        if (st2 && (st2.seen?.tx !== t.tx || st2.seen.confirmations !== t.confirmations)) {
          st2.seen = { rail: rail.id, tx: t.tx, amount, confirmations: t.confirmations, need: t.need };
          changed = true;
        }
        continue;
      }
      const p: StablePayment = { rail: rail.id, key: t.key, tx: t.tx, units: t.units.toString(), decimals: rail.decimals, at: t.at, from: t.from, countedAt: now };
      done.add(t.key);
      changed = true;
      if (!m) {
        data.stable.unmatched.push(p);
        this.d.log(`💵 ${rail.id}: ${amount} in ${t.tx} matches no order — kept as unmatched for a human`);
        continue;
      }
      const r = applyPayment(m.order, p, now);
      const o = m.order;
      this.d.log(
        r === 'paid' ? `💵 ${short(o)} paid via ${rail.id}: ${o.paid!.amount} USD (${m.how})${o.stable!.ratio ? ` — short, ${Math.round(o.stable!.ratio * 100)}% credit` : ''}${o.stable!.hold ? ' — HELD for a human' : ''}${o.stable!.overpaid ? ` — overpaid ${o.stable!.overpaid}` : ''}`
        : r === 'partial' ? `💵 ${short(o)}: ${amount} via ${rail.id}, still lacks ${usd(due(o) - received(o))}`
        : `💵 ${short(o)}: another ${amount} via ${rail.id} after it was paid — overpaid ${o.stable!.overpaid ?? '?'}, refund by hand`,
      );
    }
    if (changed) this.d.save();
  }
}

const short = (o: Order) => (o.kind ? o.id.slice(0, 10) + '…' : o.id);
