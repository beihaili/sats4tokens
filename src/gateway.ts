// The payment engine: one Cashu wallet (deterministic, seed-backed) + the ledger.
//
// Two ways for a customer to pay an order:
//   lightning — we ask the mint for a bolt11 quote; the customer pays the invoice from any LN wallet;
//               when the quote turns PAID we mint ecash to ourselves. No Lightning node on our side.
//   cashu     — the customer pastes an ecash token; we swap it at the mint for fresh proofs of our own.
// Either way the mint signs blinded messages derived from (seed, counter). Before that request we
// write the counter range into the order (ledger.beginSettle + save), so after any crash
// recover() can ask the mint "did you sign these?" (NUT-09 restore) and never pay out twice.
import {
  Wallet,
  MintQuoteState,
  sumProofs,
  serializeProofs,
  deserializeProofs,
  getEncodedToken,
  getTokenMetadata,
  type MintInfo,
  type Proof,
  type Token,
} from '@cashu/cashu-ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Ledger,
  beginSettle,
  finishSettle,
  abortSettle,
  isTokenRetry,
  tokenFingerprint,
  decideSettle,
  type Order,
  type SettleFacts,
} from './ledger.ts';

const sats = (proofs: Proof[]): number => sumProofs(proofs).toNumber();
const LATE_PAYMENT_MS = 24 * 3600_000;
// Be gentle with the mint: public mints rate-limit per IP (Coinos answers 429 above ~20 quote calls/min)
// and firewall IPs that keep going (Minibits banned the demo VPS after hours of 4 quotes × every 2s).
// Primary signal is NUT-17: one WebSocket, the mint pushes "quote PAID" (then one HTTP check confirms and mints).
// HTTP polling is the safety net, slow while the subscription is up, faster only if it isn't.
const QUOTE_GAP_MS = 8_000; // at most one quote check per this, across all orders (≤7.5/min)
const POLL_WATCHED_MS = 8_000; // no subscription, checkout page open (polled /api/order in the last WATCH_MS)
const POLL_PENDING_MS = 30_000; // no subscription, nobody looking
const POLL_SUBSCRIBED_MS = 60_000; // subscription up: the push should come first
const WS_RETRY_MS = 30_000; // after a subscription error, wait this long before subscribing again
const POLL_LATE_MS = 120_000; // expired order, waiting for a late invoice payment
const WATCH_MS = 20_000;
const MINT_BACKOFF_MAX_MS = 60_000; // mint unreachable / 429: pause all polling, doubling from 5s up to this
const normUrl = (u: string): string => u.replace(/\/+$/, '');
/** Reject if `p` hasn't settled after `ms` (a hung WebSocket handshake must not stall the watcher). */
const withTimeout = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref())]);

/** Fault injection for the crash demo: CRASH_AT=after-writeahead | after-mint */
function crashPoint(name: string): void {
  if (process.env.CRASH_AT === name) {
    console.error(`💥 CRASH_AT=${name} — killing the process`);
    process.kill(process.pid, 'SIGKILL');
  }
}

/** Load the wallet seed from SEED (hex) or data/seed.hex, creating it on first run. */
export function loadSeed(dataDir: string): Uint8Array {
  if (process.env.SEED) return Buffer.from(process.env.SEED, 'hex');
  const file = path.join(dataDir, 'seed.hex');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

/**
 * What this gateway needs from a mint, per its NUT-06 info. Empty list = OK.
 * Without NUT-09 restore (and NUT-07 state checks) a crash mid-payment can't be recovered,
 * so the gateway refuses to start rather than silently losing its exactly-once guarantee.
 */
export function mintProblems(info: Pick<MintInfo, 'isSupported'>): string[] {
  const problems: string[] = [];
  const mint = info.isSupported(4);
  if (mint.disabled || !mint.params.some((m) => m.method === 'bolt11' && m.unit === 'sat'))
    problems.push('no bolt11 minting in sat (NUT-04)');
  if (!info.isSupported(7).supported) problems.push('no proof state check (NUT-07)');
  if (!info.isSupported(9).supported) problems.push('no restore (NUT-09), crash recovery impossible');
  return problems;
}

export class Gateway {
  ledger: Ledger;
  wallet: Wallet;
  mintUrl: string;
  private queue: Promise<unknown> = Promise.resolve();
  private nextPoll = new Map<string, number>(); // order id → earliest next quote check
  private watched = new Map<string, number>(); // order id → last time its checkout page asked for status
  private lastQuoteCheck = 0;
  private subs = new Map<string, () => void>(); // order id → cancel its NUT-17 quote subscription
  private wsRetryAt = 0;
  private mintDownUntil = 0;
  private mintFailures = 0;

  private constructor(ledger: Ledger, wallet: Wallet, mintUrl: string) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.mintUrl = mintUrl;
  }

  static async open(ledger: Ledger, mintUrl: string, seed: Uint8Array): Promise<Gateway> {
    const wallet = new Wallet(mintUrl, { unit: 'sat', bip39seed: seed });
    await wallet.loadMint();
    const problems = mintProblems(wallet.getMintInfo());
    if (problems.length) throw new Error(`mint ${mintUrl} can't be used: ${problems.join('; ')}`);
    return new Gateway(ledger, wallet, normUrl(mintUrl));
  }

  /** Every wallet/ledger mutation runs through here, one at a time (counter ranges must not interleave). */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  balance(): number {
    return sats(deserializeProofs(this.ledger.data.proofs));
  }

  // ---------------------------------------------------------------- lightning

  /**
   * Give a PENDING order its bolt11 invoice (a mint quote), once. Created lazily when the customer
   * picks Lightning, so cashu-only payers never leave an orphan quote behind. No money moves yet.
   */
  ensureQuote(orderId: string): Promise<Order> {
    return this.serial(async () => {
      const order = this.ledger.order(orderId);
      if (!order) throw new Error('unknown order');
      if (order.quote || order.state !== 'PENDING') return order;
      if (Date.now() > order.expiresAt) throw new Error('order expired');
      const q = await this.wallet.createMintQuoteBolt11(order.sats, `order ${order.id}`);
      order.quote = { id: q.quote, request: q.request };
      this.ledger.save();
      return order;
    });
  }

  /** Poll one PENDING order's quote; mint if it has been paid. */
  private async pollQuote(order: Order): Promise<void> {
    if (!order.quote) {
      if (order.state === 'PENDING' && Date.now() > order.expiresAt) {
        order.state = 'EXPIRED';
        this.ledger.save();
      }
      return;
    }
    const q = await this.wallet.checkMintQuoteBolt11(order.quote.id);
    if (q.state === MintQuoteState.PAID) return this.mintForOrder(order, this.ledger.data.nextCounter, true);
    if (q.state === MintQuoteState.ISSUED) throw new Error('quote ISSUED but order not settled — needs a human');
    if (order.state === 'PENDING' && Date.now() > order.expiresAt) {
      order.state = 'EXPIRED'; // still polled for a day: a late invoice payment is still credited
      this.ledger.save();
    }
  }

  /**
   * Mint `order.sats` from the order's PAID quote using outputs at `counter`.
   * fresh=true: claim the range now (write-ahead). fresh=false: retry inside an existing claim.
   */
  private async mintForOrder(order: Order, counter: number, fresh: boolean): Promise<void> {
    const quote = await this.wallet.checkMintQuoteBolt11(order.quote!.id);
    const preview = await this.wallet.prepareMint('bolt11', order.sats, quote, undefined, {
      type: 'deterministic',
      counter,
    });
    if (fresh) {
      const keysetId = preview.outputData[0].blindedMessage.id;
      beginSettle(this.ledger.data, order, { via: 'lightning', keysetId, count: preview.outputData.length }, Date.now());
      this.ledger.save(); // ← write-ahead: the counter range is durable BEFORE the mint signs
      crashPoint('after-writeahead');
    }
    const proofs = await this.wallet.completeMint(preview);
    crashPoint('after-mint'); // the mint signed, we haven't stored the proofs: worst moment to die
    finishSettle(this.ledger.data, order, serializeProofs(proofs), sats(proofs), Date.now());
    this.ledger.save();
    console.log(`⚡ ${order.id} paid via lightning: ${sats(proofs)} sat`);
  }

  // ---------------------------------------------------------------- cashu token

  /** Validate a pasted token against the order. Throws a user-facing message. */
  private checkToken(order: Order, token: string): Token {
    if (order.state !== 'PENDING') throw new Error(`order is ${order.state.toLowerCase()}`);
    if (Date.now() > order.expiresAt) throw new Error('order expired — go back and create a new one');
    // Mint first: decodeToken needs the issuing mint's keysets, so a token from another mint would only
    // fail with "not a valid cashu token". getTokenMetadata reads the mint URL without them.
    let meta: ReturnType<typeof getTokenMetadata>;
    try {
      meta = getTokenMetadata(token.trim());
    } catch {
      throw new Error('not a valid cashu token');
    }
    if (normUrl(meta.mint) !== this.mintUrl) {
      throw new Error(`this token is from ${meta.mint} — ecash only works at the mint that issued it; send one from ${this.mintUrl}, or pay with ⚡ instead (any wallet, including yours, can pay the invoice)`);
    }
    let t: Token;
    try {
      t = this.wallet.decodeToken(token.trim());
    } catch {
      throw new Error('not a valid cashu token');
    }
    if (normUrl(t.mint) !== this.mintUrl) throw new Error(`token is from ${t.mint}; we accept ${this.mintUrl}`);
    if ((t.unit ?? 'sat') !== 'sat') throw new Error('token must be in sat');
    const amount = sats(t.proofs);
    if (amount < order.sats) throw new Error(`token is ${amount} sat, order needs ${order.sats} sat`);
    return t;
  }

  /** Customer pasted a token: swap it into our wallet. Overpayment is kept (tokens can't be split here). */
  payWithToken(orderId: string, token: string): Promise<Order> {
    token = token.trim().replace(/^cashu:/i, ''); // some wallets share a cashu: URI
    return this.serial(async () => {
      const order = this.ledger.order(orderId);
      if (!order) throw new Error('unknown order');
      if (isTokenRetry(order, token)) return order; // same token again (client retry): same 200, nothing new happens
      const t = this.checkToken(order, token);
      const states = await this.wallet.checkProofsStates(t.proofs);
      if (states.some((s) => s.state !== 'UNSPENT')) throw new Error('token already spent');
      await this.swapForOrder(order, t, this.ledger.data.nextCounter, true, token);
      return order;
    });
  }

  private async swapForOrder(order: Order, t: Token, counter: number, fresh: boolean, raw?: string): Promise<void> {
    const preview = await this.wallet.ops.receive(t).asDeterministic(counter).prepare();
    const outs = preview.keepOutputs ?? [];
    if (fresh) {
      const keysetId = outs[0].blindedMessage.id;
      beginSettle(this.ledger.data, order, { via: 'cashu', keysetId, count: outs.length, token: raw }, Date.now());
      if (raw) order.tokenHash = tokenFingerprint(raw);
      this.ledger.save(); // ← write-ahead
      crashPoint('after-writeahead');
    }
    const { keep } = await this.wallet.completeSwap(preview);
    crashPoint('after-mint');
    finishSettle(this.ledger.data, order, serializeProofs(keep), sats(keep), Date.now());
    this.ledger.save();
    console.log(`🥜 ${order.id} paid via cashu: ${sats(keep)} sat (fee ${preview.fees.toNumber()})`);
  }

  // ---------------------------------------------------------------- recovery

  /** An order is SETTLING: we claimed a counter range but don't know if the mint signed. Find out. */
  private async recover(order: Order): Promise<void> {
    const s = order.settle!;
    const { proofs } = await this.wallet.restore(s.counter, s.count, { keysetId: s.keysetId });
    const facts: SettleFacts = { restored: proofs.length };
    let token: Token | undefined;
    if (s.via === 'lightning') {
      facts.quoteState = (await this.wallet.checkMintQuoteBolt11(order.quote!.id)).state as SettleFacts['quoteState'];
    } else {
      token = this.wallet.decodeToken(s.token!);
      const st = await this.wallet.checkProofsStates(token.proofs);
      facts.inputState = st.some((x) => x.state === 'SPENT') ? 'SPENT' : st.some((x) => x.state === 'PENDING') ? 'PENDING' : 'UNSPENT';
    }
    const action = decideSettle(s.via, facts);
    console.log(`🔁 recover ${order.id} (${s.via}, counters ${s.counter}..${s.counter + s.count - 1}):`, facts, '→', action);
    switch (action) {
      case 'finish':
        finishSettle(this.ledger.data, order, serializeProofs(proofs), sats(proofs), Date.now());
        this.ledger.save();
        return;
      case 'retry':
        if (s.via === 'lightning') return this.mintForOrder(order, s.counter, false);
        return this.swapForOrder(order, token!, s.counter, false);
      case 'abort':
        abortSettle(order, 'token was spent somewhere else');
        this.ledger.save();
        return;
      case 'wait':
        return;
      case 'conflict':
        order.lastError = `CONFLICT: ${JSON.stringify(facts)} — needs a human`;
        this.ledger.save();
        throw new Error(`order ${order.id}: ${order.lastError}`);
    }
  }

  /** One pass over all unfinished orders. Called by the watcher loop and at startup. */
  /** The checkout page is showing this order; check its quote more often. */
  watch(orderId: string): void {
    this.watched.set(orderId, Date.now());
  }

  /** Check this order's quote on the next pass (an auto top-up's wallet says it just paid). */
  checkSoon(orderId: string): void {
    this.nextPoll.set(orderId, 0);
    this.watch(orderId);
  }

  /**
   * One watcher pass, called every 2s and at startup. SETTLING orders (crash recovery) are all handled;
   * then at most ONE quote is checked — the most overdue one — and only if QUOTE_GAP_MS has passed.
   */
  tick(): Promise<void> {
    return this.serial(async () => {
      if (Date.now() < this.mintDownUntil) return; // mint unreachable or rate-limiting us: back off
      try {
        for (const o of this.ledger.data.orders) if (o.state === 'SETTLING') await this.tryMint(o, () => this.recover(o));
        const now = Date.now();
        for (const o of this.ledger.data.orders) {
          // no invoice → nothing to ask the mint; just expire it
          if (o.state === 'PENDING' && !o.quote && now > o.expiresAt) {
            o.state = 'EXPIRED';
            this.ledger.save();
          }
        }
        await this.syncSubscriptions();
        if (now - this.lastQuoteCheck < QUOTE_GAP_MS) return;
        const due = this.ledger.data.orders
          .filter((o) => o.quote && (o.state === 'PENDING' || (o.state === 'EXPIRED' && now - o.expiresAt < LATE_PAYMENT_MS)))
          .map((o) => ({ o, at: this.nextPoll.get(o.id) ?? 0 }))
          .filter((x) => x.at <= now)
          .sort((a, b) => a.at - b.at);
        if (!due.length) return;
        const o = due[0].o;
        const interval =
          o.state === 'EXPIRED' ? POLL_LATE_MS
          : this.subs.has(o.id) ? POLL_SUBSCRIBED_MS
          : now - (this.watched.get(o.id) ?? 0) < WATCH_MS ? POLL_WATCHED_MS
          : POLL_PENDING_MS;
        this.nextPoll.set(o.id, now + interval);
        this.lastQuoteCheck = now;
        await this.tryMint(o, () => this.pollQuote(o));
      } catch {
        // tryMint already logged and set the backoff; stop this pass
      }
    });
  }

  /**
   * Keep exactly the PENDING orders with an invoice subscribed (NUT-17 bolt11_mint_quote). A PAID push only
   * makes that order due now; the normal pollQuote path (HTTP check → write-ahead → mint) does the rest.
   */
  private async syncSubscriptions(): Promise<void> {
    const want = new Set(this.ledger.data.orders.filter((o) => o.state === 'PENDING' && o.quote).map((o) => o.id));
    for (const [id, cancel] of this.subs) {
      if (!want.has(id)) {
        cancel();
        this.subs.delete(id);
      }
    }
    if (Date.now() < this.wsRetryAt) return;
    for (const id of want) {
      if (this.subs.has(id)) continue;
      const o = this.ledger.order(id)!;
      const quoteId = o.quote!.id;
      try {
        const cancel = await withTimeout(10_000, this.wallet.on.mintQuoteUpdates(
          [quoteId],
          (q) => {
            if (q.state === MintQuoteState.PAID || q.state === MintQuoteState.ISSUED) {
              console.log(`🔔 ${id}: mint says quote ${q.state}`);
              this.nextPoll.set(id, 0);
              this.lastQuoteCheck = 0; // a push is worth a request right away
            }
          },
          (e) => {
            console.warn(`🔔 ${id}: subscription error: ${e.message} — HTTP polling only for ${WS_RETRY_MS / 1000}s`);
            this.subs.get(id)?.();
            this.subs.delete(id);
            this.wsRetryAt = Date.now() + WS_RETRY_MS;
          },
        ));
        this.subs.set(id, cancel);
      } catch (e) {
        console.warn(`🔔 ${id}: can't subscribe: ${(e as Error).message} — HTTP polling only for ${WS_RETRY_MS / 1000}s`);
        this.wsRetryAt = Date.now() + WS_RETRY_MS;
        return;
      }
    }
  }

  /** Run one mint interaction for `o`. Network failures and 429 pause all polling (and rethrow); others are logged. */
  private async tryMint(o: Order, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.mintFailures = 0;
    } catch (e) {
      const msg = (e as Error).message;
      if (!/fetch failed|timed? ?out|ECONN|network|429|too many/i.test(msg)) {
        console.error(`tick ${o.id}:`, msg);
        return;
      }
      const wait = Math.min(MINT_BACKOFF_MAX_MS, 5_000 * 2 ** this.mintFailures++);
      this.mintDownUntil = Date.now() + wait;
      console.error(`tick ${o.id}: ${msg} — pausing mint polls for ${wait / 1000}s`);
      throw e;
    }
  }

  // ---------------------------------------------------------------- operator

  /**
   * Move the whole balance out as one cashu token (import it into any cashu wallet).
   * The token is written to data/withdrawals/ BEFORE the proofs leave the ledger, so it can't get lost.
   */
  withdrawAsToken(dir: string): Promise<{ file: string; sats: number }> {
    return this.serial(async () => {
      const proofs = deserializeProofs(this.ledger.data.proofs);
      if (!proofs.length) throw new Error('balance is 0');
      const token = getEncodedToken({ mint: this.mintUrl, proofs, unit: 'sat' });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `withdraw-${Date.now()}.txt`);
      fs.writeFileSync(file, token + '\n', { mode: 0o600 });
      this.ledger.data.proofs = [];
      this.ledger.save();
      return { file, sats: sats(proofs) };
    });
  }
}
