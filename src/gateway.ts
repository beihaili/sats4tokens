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
  decideSettle,
  type Order,
  type SettleFacts,
} from './ledger.ts';

const sats = (proofs: Proof[]): number => sumProofs(proofs).toNumber();
const LATE_PAYMENT_MS = 24 * 3600_000;
const normUrl = (u: string): string => u.replace(/\/+$/, '');

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

export class Gateway {
  ledger: Ledger;
  wallet: Wallet;
  mintUrl: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(ledger: Ledger, wallet: Wallet, mintUrl: string) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.mintUrl = mintUrl;
  }

  static async open(ledger: Ledger, mintUrl: string, seed: Uint8Array): Promise<Gateway> {
    const wallet = new Wallet(mintUrl, { unit: 'sat', bip39seed: seed });
    await wallet.loadMint();
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
    return this.serial(async () => {
      const order = this.ledger.order(orderId);
      if (!order) throw new Error('unknown order');
      const t = this.checkToken(order, token);
      const states = await this.wallet.checkProofsStates(t.proofs);
      if (states.some((s) => s.state !== 'UNSPENT')) throw new Error('token already spent');
      await this.swapForOrder(order, t, this.ledger.data.nextCounter, true, token.trim());
      return order;
    });
  }

  private async swapForOrder(order: Order, t: Token, counter: number, fresh: boolean, raw?: string): Promise<void> {
    const preview = await this.wallet.ops.receive(t).asDeterministic(counter).prepare();
    const outs = preview.keepOutputs ?? [];
    if (fresh) {
      const keysetId = outs[0].blindedMessage.id;
      beginSettle(this.ledger.data, order, { via: 'cashu', keysetId, count: outs.length, token: raw }, Date.now());
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
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const o of this.ledger.data.orders) {
        try {
          if (o.state === 'SETTLING') await this.recover(o);
          else if (o.state === 'PENDING') await this.pollQuote(o);
          else if (o.state === 'EXPIRED' && Date.now() - o.expiresAt < LATE_PAYMENT_MS) await this.pollQuote(o);
        } catch (e) {
          console.error(`tick ${o.id}:`, (e as Error).message);
        }
      }
    });
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
