// USDT/USDC checkout: rail config + address checks, amounts and clashes, the three scanners against recorded API
// responses (test/fixtures/stable, synthetic addresses), and the watcher end to end: paid, not enough confirmations,
// short, over, late, clash, wrong network, RPC errors and retries. No real chain is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Scanner, isEvmAddress, isTronAddress, railsFromEnv, type Fetch, type Rail } from '../src/chain.ts';
import {
  StableWatcher, applyPayment, matchTransfer, quoteStable, stableMicro, toMicro, usd,
} from '../src/stable.ts';
import { creditOf, dueForNotify, emptyLedger, makeKeyOrder, makeOrder, type LedgerData, type Order } from '../src/ledger.ts';
import { Funnel } from '../src/funnel.ts';

const dir = path.join(import.meta.dirname, 'fixtures', 'stable');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const ADDR = load('addresses.json');
const NOW0 = Date.parse('2026-11-03T12:00:00Z'); // orders are made here; the recorded transfers are at 12:01
const T = NOW0 + 60_000;
const TTL = 30 * 60_000;
const LATE = 24 * 3600_000;
const RATE = 1.0832; // USD per EUR: €5 → 5.42, €10 → 10.84, €4 → 4.34
const ENV = {
  STABLE_ADDR_TRON: ADDR.tron, STABLE_ADDR_EVM: ADDR.evm, STABLE_ADDR_SOL: ADDR.sol,
  STABLE_TRON_RPC: 'http://tron.test', STABLE_BASE_RPC: 'http://base.test', STABLE_SOL_RPC: 'http://sol.test',
};
const rail = (rails: Rail[], id: string) => rails.find((r) => r.id === id)!;
const opts = { fiat: 'eur', btcPrice: 100_000, now: NOW0, ttlMs: TTL };
const epay = (money: string, no: string) =>
  makeOrder({ pid: '1001', type: 'bitcoin', out_trade_no: no, notify_url: 'http://merchant.test/notify', return_url: 'http://merchant.test/ok', name: 'top-up', money }, opts);

/** A fake chain: answers like the fixtures (cloned, so a test may edit them), records calls, can fail on demand. */
function chain(edit: (fx: { tron: any; base: any; solana: any }) => void = () => {}) {
  const fx = { tron: load('tron.json'), base: load('base.json'), solana: load('solana.json') };
  edit(fx);
  const calls: string[] = [];
  let fail: ((what: string) => Response | undefined) | undefined;
  const f: Fetch = async (u, init) => {
    const url = new URL(u);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const what = `${url.host} ${body?.method ?? url.pathname}`;
    calls.push(what);
    const failed = fail?.(what);
    if (failed) return failed;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url.host === 'tron.test') {
      if (url.pathname.endsWith('/transactions/trc20')) return json(fx.tron.trc20);
      if (url.pathname === '/wallet/getblock') return json(fx.tron.block);
      if (url.pathname === '/wallet/gettransactioninfobyid') return json(fx.tron.txinfo[body.value] ?? {});
    }
    if (url.host === 'base.test') {
      if (body.method === 'eth_blockNumber') return json(fx.base.blockNumber);
      if (body.method === 'eth_getLogs') return json(fx.base.logs);
      if (body.method === 'eth_getBlockByNumber') {
        const fixture = fx.base.block.result;
        const seconds = Number(fixture.timestamp) + 2 * (Number(body.params[0]) - Number(fixture.number));
        return json({ result: { timestamp: '0x' + Math.max(0, seconds).toString(16) } });
      }
    }
    if (url.host === 'sol.test') {
      if (body.method === 'getSignaturesForAddress') return json(fx.solana.signatures);
      if (body.method === 'getTransaction') return json(fx.solana.tx[body.params[0]] ?? { jsonrpc: '2.0', id: 1, result: null });
    }
    return new Response('not found', { status: 404 });
  };
  return { fx, f, calls, failWith: (fn: typeof fail) => (fail = fn) };
}

function watcher(c: ReturnType<typeof chain>, env: Record<string, string> = {}) {
  const rails = railsFromEnv({ ...ENV, ...env });
  const data: LedgerData = emptyLedger();
  const w = { now: NOW0 + 2 * 60_000, saves: 0, logs: [] as string[] };
  const sw = new StableWatcher({
    data: () => data, save: () => w.saves++, now: () => w.now, log: (l) => w.logs.push(l), rails, lateMs: LATE,
    scanner: (r) => new Scanner(r, c.f),
  });
  /** a new order with a quote on `id`, made at NOW0 + 30s */
  const order = (o: Order, id: string) => {
    data.orders.push(o);
    quoteStable(data, o, rail(rails, id), RATE, NOW0 + 30_000, LATE);
    return o;
  };
  return { rails, data, w, sw, order };
}

// ------------------------------------------------------------------ config

test('railsFromEnv: only networks with an address; ids, ATA, allow-list, extra EVM chains', () => {
  assert.deepEqual(railsFromEnv({}), []);
  const rails = railsFromEnv(ENV);
  assert.deepEqual(rails.map((r) => r.id), ['tron-usdt', 'base-usdc', 'solana-usdc', 'solana-usdt']);
  assert.equal(rail(rails, 'solana-usdc').account, ADDR.solUsdcAccount); // derived associated token account
  assert.notEqual(rail(rails, 'solana-usdt').account, ADDR.solUsdcAccount);
  assert.equal(rail(rails, 'tron-usdt').confirmations, 19);
  assert.equal(rail(rails, 'base-usdc').rpc, 'http://base.test');
  assert.deepEqual(railsFromEnv({ STABLE_ADDR_TRON: ADDR.tron }).map((r) => r.id), ['tron-usdt']);
  assert.deepEqual(railsFromEnv({ ...ENV, STABLE_RAILS: 'base-usdc, solana-usdc' }).map((r) => r.id), ['base-usdc', 'solana-usdc']);
  // one more EVM chain = config only (an 18-decimals token as {contract, decimals}); the address is the same 0x one
  const more = railsFromEnv({
    STABLE_ADDR_EVM: ADDR.evm, STABLE_BASE_CONFIRMATIONS: '12', STABLE_ARBITRUM_RPC: 'http://arb.test',
    STABLE_EVM_CHAINS: JSON.stringify([{ id: 'arbitrum', name: 'Arbitrum', rpc: 'http://default.test', confirmations: 20, blockTime: 0.25, explorer: 'https://x/tx/', tokens: { USDT: { contract: '0x' + '22'.repeat(20), decimals: 18 } } }]),
  });
  assert.deepEqual(more.map((r) => [r.id, r.confirmations, r.decimals, r.address]), [['base-usdc', 12, 6, ADDR.evm], ['arbitrum-usdt', 20, 18, ADDR.evm]]);
  assert.equal(more[1].rpc, 'http://arb.test');
  assert.throws(() => railsFromEnv({ STABLE_ADDR_EVM: ADDR.evm, STABLE_EVM_CHAINS: '[{"id":"x1","tokens":{"DAI":"0x' + '11'.repeat(20) + '"}}]' }), /only USDT\/USDC/);
});

test('addresses: Tron checksum, EIP-55, Solana wallet (not a token account) — a typo must not start', () => {
  assert.ok(isTronAddress(ADDR.tron));
  assert.ok(!isTronAddress(ADDR.tron.slice(0, -1) + (ADDR.tron.endsWith('n') ? 'm' : 'n')));
  assert.ok(isEvmAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')); // correct checksum
  assert.ok(isEvmAddress(ADDR.evm)); // all lowercase: no checksum to check
  assert.ok(!isEvmAddress('0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913')); // one letter's case flipped
  assert.throws(() => railsFromEnv({ STABLE_ADDR_TRON: 'T' + 'x'.repeat(33) }), /STABLE_ADDR_TRON/);
  assert.throws(() => railsFromEnv({ STABLE_ADDR_EVM: '0x1234' }), /STABLE_ADDR_EVM/);
  assert.throws(() => railsFromEnv({ STABLE_ADDR_SOL: ADDR.solUsdcAccount }), /token account/);
});

// ------------------------------------------------------------------ amounts

test('amounts: money × rate rounded up to the cent; micro-USD across decimals', () => {
  assert.equal(stableMicro('5', RATE), 5_420_000n); // 5.416 → 5.42
  assert.equal(stableMicro('5', 1.1), 5_500_000n); // 5.500000000000001 must not become 5.51
  assert.equal(stableMicro('2', 1), 2_000_000n);
  assert.equal(usd(5_420_000n), '5.42');
  assert.equal(usd(5_419_000n), '5.419');
  assert.equal(usd(1n), '0.000001');
  assert.equal(toMicro('5420000000000000000', 18), 5_420_000n);
});

test('quoteStable: unique per rail among waiting orders (+0.01 on a clash), rate locked by the first quote', () => {
  const rails = railsFromEnv(ENV);
  const data = emptyLedger();
  const base = rail(rails, 'base-usdc');
  const mk = () => {
    const o = makeKeyOrder('5', opts);
    data.orders.push(o);
    return o;
  };
  const [a, b, c] = [mk(), mk(), mk()];
  const at = NOW0 + 1000;
  assert.deepEqual([a, b, c].map((o) => quoteStable(data, o, base, RATE, at, LATE).amount), ['5.42', '5.43', '5.44']);
  assert.equal(quoteStable(data, a, base, 9, at, LATE).amount, '5.42'); // asked again: the same quote
  assert.equal(quoteStable(data, a, rail(rails, 'tron-usdt'), 9, at, LATE).amount, '5.42'); // other rail: no clash; rate stays locked
  assert.equal(a.stable!.usdPerFiat, RATE);
  // a paid order frees its amount; one expired longer than the late window too
  b.state = 'PAID';
  Object.assign(c, { state: 'EXPIRED', expiresAt: at - LATE - 1 });
  const d = mk();
  assert.equal(quoteStable(data, d, base, RATE, at, LATE).amount, '5.43');
  assert.equal(d.stable!.quotes[0].units, '5430000');
  // an expired order can't get a new quote
  const e = mk();
  assert.throws(() => quoteStable(data, e, base, RATE, e.expiresAt + 1, LATE), /expired/);
});

// ------------------------------------------------------------------ scanners

test('tron scanner: our address and contract only, reverted txs dropped, confirmations from the head block', async () => {
  const c = chain();
  const r = { ...rail(railsFromEnv(ENV), 'tron-usdt'), apiKey: 'test-key' };
  let header = '';
  const s = new Scanner(r, (u, init) => ((header = new Headers(init?.headers).get('TRON-PRO-API-KEY') ?? ''), c.f(u, init)));
  const got = await s.scan(NOW0, {}, new Set());
  assert.equal(header, 'test-key');
  // the fake-token transfer, the one to someone else and the reverted one are gone; dust is left to the watcher
  assert.deepEqual(got.map((t) => [t.units, t.confirmations, t.need]), [[5_420_000n, 6, 19], [1n, 6, 19]]);
  assert.equal(got[0].at, T);
  // the tx's block is remembered: the next pass asks only for the head
  c.calls.length = 0;
  await s.scan(NOW0, {}, new Set());
  assert.deepEqual(c.calls.filter((x) => x.includes('gettransactioninfobyid')).length, 0);
  // counted transfers are skipped without any lookup
  const s2 = new Scanner(r, c.f);
  c.calls.length = 0;
  assert.deepEqual(await s2.scan(NOW0, {}, new Set(c.fx.tron.trc20.data.map((t: any) => t.transaction_id))), []);
  assert.deepEqual(c.calls, ['tron.test /v1/accounts/' + ADDR.tron + '/transactions/trc20']);
});

test('evm scanner: Transfer logs to us, removed logs dropped, block time looked up when missing, cursor below unconfirmed', async () => {
  const c = chain();
  const r = rail(railsFromEnv(ENV), 'base-usdc');
  const state: { cursor?: number } = {};
  const head = 0x32fc4c1;
  const got = await new Scanner(r, c.f).scan(NOW0, state, new Set(), NOW0 + 2 * 60_000);
  assert.deepEqual(got.map((t) => [usd(t.units), t.confirmations, t.at]), [['5.43', head - 53462190 + 1, T], ['2.00', head - 53462200 + 1, T]]);
  assert.equal(got[0].from, '0x' + c.fx.base.logs.result[0].topics[1].slice(26)); // sender from topic 1
  assert.ok(c.calls.includes('base.test eth_getBlockByNumber')); // only for the log without blockTimestamp
  assert.equal(state.cursor, head - 30 + 2); // next pass starts at the first block without 30 confirmations
  // range cap: at most 5 calls of maxRange blocks per pass, the cursor resumes after the last one
  const small = { ...r, maxRange: 10 };
  const st2: { cursor?: number } = { cursor: head - 1000 };
  c.calls.length = 0;
  await new Scanner(small, c.f).scan(NOW0 - 3600_000, st2, new Set(), NOW0 + 2 * 60_000); // cursor newer than `since`
  assert.equal(c.calls.filter((x) => x.endsWith('eth_getLogs')).length, 5);
  assert.equal(st2.cursor, head - 1000 + 50);
});

test('BSC outage: faster blocks cannot hide a transfer before the estimated starting block', async () => {
  const head = 10000;
  const timestamp = (n: number) => Math.floor((NOW0 + 450 * n) / 1000);
  const since = timestamp(5000) * 1000;
  const first = Math.ceil((since - NOW0) / 450);
  const r = { ...rail(railsFromEnv(ENV), 'base-usdc'), blockTimeS: 0.75, maxRange: 10 };
  const log = load('base.json').logs.result[0];
  const scanner = new Scanner(r, async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    let result;
    if (method === 'eth_blockNumber') result = '0x2710';
    else if (method === 'eth_getBlockByNumber') result = { timestamp: '0x' + timestamp(Number(params[0])).toString(16) };
    else {
      const { fromBlock, toBlock } = params[0];
      assert.ok(Number(toBlock) - Number(fromBlock) < 10);
      result = Number(fromBlock) <= first && first <= Number(toBlock)
        ? [{ ...log, blockNumber: '0x' + first.toString(16), blockTimestamp: '0x' + timestamp(first).toString(16) }] : [];
    }
    return Response.json({ result });
  });
  for (const cursor of [undefined, first - 100, first]) {
    const state = { cursor, catchingUp: false };
    const got = await scanner.scan(since, state, new Set(), NOW0 + 450 * head);
    assert.equal(got[0]?.tx, log.transactionHash);
    assert.equal(state.cursor, first + 50);
    assert.equal(state.catchingUp, true);
  }
});

test('solana scanner: our token account gains, failed txs dropped, finalized = confirmed, v1 transactions asked for', async () => {
  const c = chain();
  let txParams: any;
  const r = rail(railsFromEnv(ENV), 'solana-usdc');
  const s = new Scanner(r, async (u, init) => {
    const b = JSON.parse(String(init!.body));
    if (b.method === 'getTransaction') txParams = b.params[1];
    if (b.method === 'getSignaturesForAddress') assert.equal(b.params[0], ADDR.solUsdcAccount);
    return c.f(u, init);
  });
  const got = await s.scan(NOW0, {}, new Set());
  assert.deepEqual(got.map((t) => [usd(t.units), t.confirmations]), [['2.00', 0], ['5.42', 1]]); // newest first, as listed
  assert.equal(txParams.maxSupportedTransactionVersion, 1);
});

// ------------------------------------------------------------------ watcher end to end

test('paid: an exact transfer with enough confirmations → PAID via tron-usdt, notify due, never counted twice', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680048 + 18));
  const { data, w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('5', opts), 'tron-usdt');
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.deepEqual(o.paid, { at: w.now, via: 'tron-usdt', sats: 0, fee: 0, amount: '5.42', token: 'USDT', tx: c.fx.tron.trc20.data[0].transaction_id });
  assert.ok(dueForNotify(o, w.now));
  assert.equal(creditOf(o), 5);
  w.now += 60_000;
  await sw.tick();
  assert.equal(o.stable!.payments.length, 1);
  assert.deepEqual(data.stable!.unmatched, []); // the 0.000001 dust is ignored, not listed
});

test('confirmations not enough: shown as seen, PAID once the head moves on', async () => {
  const c = chain(); // head = block + 5 → 6 of 19
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('5', opts), 'tron-usdt');
  await sw.tick();
  assert.equal(o.state, 'PENDING');
  assert.deepEqual(o.stable!.seen, { rail: 'tron-usdt', tx: c.fx.tron.trc20.data[0].transaction_id, amount: '5.42', confirmations: 6, need: 19 });
  c.fx.tron.block.block_header.raw_data.number += 13;
  w.now += 5_000;
  await sw.tick(); // polled every 15s: too early, nothing asked
  assert.equal(o.state, 'PENDING');
  w.now += 15_000;
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(o.stable!.seen, undefined);
});

test('underpaid key order: part-paid while open, settled for its share once expired', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('10', opts), 'tron-usdt'); // 10.84 due, 5.42 arrives (rule 2: the only waiting order)
  await sw.tick();
  assert.equal(o.state, 'PENDING');
  assert.equal(o.stable!.payments.length, 1);
  w.now = o.expiresAt + 1;
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(o.stable!.ratio, 0.5);
  assert.equal(creditOf(o), 5); // €10 order, half paid → €5 on the key
  assert.equal(o.paid!.amount, '5.42');
  assert.ok(dueForNotify(o, w.now));
});

test('part-paid order that the gateway already marked EXPIRED is settled too', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('10', opts), 'tron-usdt');
  await sw.tick();
  assert.equal(o.stable!.payments.length, 1);
  w.now = o.expiresAt + 1;
  o.state = 'EXPIRED'; // gw.tick: PENDING without a Lightning quote and past expiry → EXPIRED
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(o.stable!.ratio, 0.5);
});

test('underpaid console top-up: PAID but held for a human, never notified', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { w, sw, order } = watcher(c);
  const o = order(epay('10', 'USR1NOa'), 'tron-usdt');
  w.now = o.expiresAt + 60_000; // the transfer is only seen after expiry: settled at once
  o.state = 'EXPIRED';
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.match(o.stable!.hold!, /paid 5.42 of 10.84/);
  assert.equal(o.stable!.ratio, undefined);
  assert.ok(!dueForNotify(o, w.now));
});

test('overpaid: PAID in full, the rest noted for a refund', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { sw, order } = watcher(c);
  const o = order(makeKeyOrder('4', opts), 'tron-usdt'); // 4.34 due, 5.42 arrives
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(o.stable!.overpaid, '1.08');
  assert.equal(o.stable!.ratio, undefined);
  assert.equal(creditOf(o), 4);
});

test('late: a transfer seen after expiry counts inside the window; past it the rail is not even asked', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('5', opts), 'tron-usdt');
  o.state = 'EXPIRED';
  w.now = o.expiresAt + 3600_000;
  await sw.tick();
  assert.equal(o.state, 'PAID');

  const c2 = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const x = watcher(c2);
  const o2 = x.order(makeKeyOrder('5', opts), 'tron-usdt');
  o2.state = 'EXPIRED';
  x.w.now = o2.expiresAt + LATE + 1;
  await x.sw.tick();
  assert.equal(o2.state, 'EXPIRED');
  assert.deepEqual(c2.calls, []);
});

test('amount clash: two €5 orders on Base (5.42 / 5.43), the 5.43 transfer pays the second; an odd 2.00 stays unmatched', async () => {
  const c = chain();
  const { data, sw, order } = watcher(c, { STABLE_BASE_CONFIRMATIONS: '10' });
  const a = order(makeKeyOrder('5', opts), 'base-usdc');
  const b = order(makeKeyOrder('5', opts), 'base-usdc');
  assert.deepEqual([a, b].map((o) => o.stable!.quotes[0].amount), ['5.42', '5.43']);
  await sw.tick();
  assert.equal(b.state, 'PAID');
  assert.equal(a.state, 'PENDING'); // 2.00 is less than half of what a lacks: not claimed by rule 2
  assert.deepEqual(data.stable!.unmatched.map((p) => [p.rail, usd(toMicro(p.units, p.decimals))]), [['base-usdc', '2.00']]);
  assert.equal(data.stable!.cursors['base-usdc'], 0x32fc4c1 - 10 + 2);
});

test('wrong network: a Tron order\'s amount sent on Base is not credited to it (unmatched, for a human)', async () => {
  const c = chain((fx) => {
    fx.base.logs.result = [fx.base.logs.result[0]];
    fx.base.logs.result[0].data = '0x' + (5_420_000).toString(16).padStart(64, '0');
  });
  const { data, sw, order } = watcher(c, { STABLE_BASE_CONFIRMATIONS: '10' });
  const x = order(makeKeyOrder('5', opts), 'tron-usdt'); // 5.42 on Tron (Tron's own transfer not confirmed yet)
  order(makeKeyOrder('1', opts), 'base-usdc'); // 1.09 and 2.17 wait on Base: two candidates, neither exact
  order(makeKeyOrder('2', opts), 'base-usdc');
  await sw.tick();
  assert.equal(x.state, 'PENDING');
  assert.equal(x.stable!.payments.length, 0);
  assert.equal(data.stable!.unmatched.length, 1);
  assert.equal(data.stable!.unmatched[0].rail, 'base-usdc');
});

test('RPC errors: nothing counted, backoff, then the retry pays', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('5', opts), 'tron-usdt');
  c.failWith((what) => (what.includes('trc20') ? new Response('slow down', { status: 429 }) : undefined));
  await sw.tick();
  assert.equal(o.state, 'PENDING');
  assert.match(sw.status.get('tron-usdt')!.lastError!, /HTTP 429/);
  assert.match(w.logs.at(-1)!, /scan failed \(#1\).*retry in 15s/);
  const n = c.calls.length;
  w.now += 5_000;
  await sw.tick(); // backing off: not asked
  assert.equal(c.calls.length, n);
  c.failWith(undefined);
  w.now += 15_000;
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(sw.status.get('tron-usdt')!.failures, 0);
});

test('RPC errors: a JSON-RPC error (rate limit) on Base is a failed pass too; the cursor does not move', async () => {
  const c = chain();
  const { data, sw, order } = watcher(c, { STABLE_BASE_CONFIRMATIONS: '10' });
  order(makeKeyOrder('5', opts), 'base-usdc');
  c.failWith((what) => (what.endsWith('eth_getLogs') ? new Response(JSON.stringify(c.fx.base.limit)) : undefined));
  await sw.tick();
  assert.match(sw.status.get('base-usdc')!.lastError!, /eth_getLogs: RPC -32011: request limit reached/);
  assert.equal(data.stable?.cursors['base-usdc'], undefined);
});

test('solana: a finalized transfer pays; one only confirmed waits', async () => {
  const c = chain((fx) => (fx.solana.signatures.result[1].confirmationStatus = 'confirmed'));
  const { w, sw, order } = watcher(c);
  const o = order(makeKeyOrder('5', opts), 'solana-usdc');
  await sw.tick();
  assert.equal(o.state, 'PENDING');
  assert.equal(o.stable!.seen?.confirmations, 0);
  c.fx.solana.signatures.result[1].confirmationStatus = 'finalized';
  w.now += 15_000;
  await sw.tick();
  assert.equal(o.state, 'PAID');
  assert.equal(o.paid!.via, 'solana-usdc');
});

test('a transfer from before the quote is not claimed', async () => {
  const c = chain((fx) => (fx.tron.block.block_header.raw_data.number = 87680100));
  const { data, w, sw } = watcher(c);
  const rails = railsFromEnv(ENV);
  const o = makeKeyOrder('5', { ...opts, now: NOW0 + 10 * 60_000 });
  data.orders.push(o);
  quoteStable(data, o, rail(rails, 'tron-usdt'), RATE, NOW0 + 10 * 60_000, LATE); // 9 min after the transfer
  w.now = NOW0 + 11 * 60_000;
  await sw.tick();
  assert.equal(o.state, 'PENDING');
  assert.deepEqual(data.stable?.unmatched ?? [], []);
});

test('paid twice (Lightning, then the stablecoin amount): noted as overpaid on the order', () => {
  const rails = railsFromEnv(ENV);
  const data = emptyLedger();
  const o = makeKeyOrder('5', opts);
  data.orders.push(o);
  quoteStable(data, o, rail(rails, 'tron-usdt'), RATE, NOW0 + 1000, LATE);
  Object.assign(o, { state: 'PAID', paid: { at: NOW0, via: 'lightning', sats: 5000, fee: 0 } });
  const t = { rail: 'tron-usdt', units: 5_420_000n, at: T };
  const m = matchTransfer(data, t, 6, NOW0 + 5 * 60_000, LATE);
  assert.equal(m?.how, 'extra');
  assert.equal(applyPayment(o, { rail: 'tron-usdt', key: 'k', tx: 'k', units: '5420000', decimals: 6, at: T, countedAt: T }, NOW0), 'extra');
  assert.equal(o.stable!.overpaid, '5.42');
  assert.equal(o.paid!.via, 'lightning');
});

test('ambiguous: the amount of a paid order arrives while another order waits short of it → unmatched, for a human', () => {
  const rails = railsFromEnv(ENV);
  const data = emptyLedger();
  const paid = makeKeyOrder('5', opts);
  const open = makeKeyOrder('10', opts);
  data.orders.push(paid, open);
  quoteStable(data, paid, rail(rails, 'tron-usdt'), RATE, NOW0 + 1000, LATE); // 5.42
  quoteStable(data, open, rail(rails, 'tron-usdt'), RATE, NOW0 + 1000, LATE); // 10.84
  Object.assign(paid, { state: 'PAID', paid: { at: NOW0, via: 'tron-usdt', sats: 0, fee: 0 } });
  assert.equal(matchTransfer(data, { rail: 'tron-usdt', units: 5_420_000n, at: T }, 6, NOW0 + 5 * 60_000, LATE), undefined);
  assert.equal(matchTransfer(data, { rail: 'tron-usdt', units: 6_000_000n, at: T }, 6, NOW0 + 5 * 60_000, LATE)?.order, open);
});

test('funnel: payment methods picked and paid', () => {
  const rails = railsFromEnv(ENV);
  const data = emptyLedger();
  const ln = Object.assign(makeKeyOrder('2', opts), { quote: { id: 'q', request: 'lnbc' }, state: 'PAID' as const, paid: { at: NOW0, via: 'lightning' as const, sats: 1, fee: 0 } });
  const st = makeKeyOrder('10', opts);
  data.orders.push(ln, st);
  quoteStable(data, st, rail(rails, 'tron-usdt'), RATE, NOW0, LATE);
  quoteStable(data, st, rail(rails, 'base-usdc'), RATE, NOW0, LATE);
  Object.assign(st, { state: 'PAID', paid: { at: NOW0, via: 'tron-usdt', sats: 0, fee: 0 } });
  st.stable!.ratio = 0.5;
  assert.deepEqual(new Funnel('/nonexistent/funnel.json').methods(data.orders, 14, NOW0), [
    { via: 'lightning', picked: 1, paid: 1, money: 2 },
    { via: 'tron-usdt', picked: 1, paid: 1, money: 5 },
    { via: 'base-usdc', picked: 1, paid: 0, money: 0 },
  ]);
});

test('Base finalized mode: sequencer depth alone cannot credit; finalized RPC fails closed', async () => {
  const c = chain();
  const r = rail(railsFromEnv({ ...ENV, STABLE_BASE_FINALIZED: '1', STABLE_BASE_CONFIRMATIONS: '1' }), 'base-usdc');
  const bn = Number(c.fx.base.logs.result.find((l: any) => !l.removed).blockNumber);
  let finalized: number | undefined = bn - 1;
  const f: Fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'eth_getBlockByNumber' && body.params[0] === 'finalized') return new Response(JSON.stringify({ result: finalized === undefined ? null : { number: '0x' + finalized.toString(16) } }));
    return c.f(url, init);
  };
  const s = new Scanner(r, f); const state: { cursor?: number; catchingUp?: boolean } = {};
  const before = await s.scan(NOW0, state, new Set());
  assert.ok(before.length); assert.equal(before[0].confirmations, 0);
  assert.ok(state.cursor! <= bn);
  finalized = bn + 100;
  const after = await s.scan(NOW0, state, new Set());
  assert.ok(after[0].confirmations >= after[0].need);
  finalized = undefined;
  await assert.rejects(s.scan(NOW0, state, new Set()), /finalized/);
});
