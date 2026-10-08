// Key top-ups + pool: pure ledger helpers, and KeyShop.topUp / pool against a fake new-api that behaves like the
// rc.22 image we run (checked in a throwaway container 2026-10-07): PUT /api/token/ writes every editable field from
// the body, a token whose quota ran out has status 4 and only `?status_only=true` turns it back on, a deleted token
// answers success:false "record not found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditOf, decideTopup, emptyLedger, findKeyOrder, makeKeyOrder, makeTopupOrder, parseBonusTiers, pendingMoney, topupBlocked, type Order } from '../src/ledger.ts';
import { KeyShop } from '../src/keyshop.ts';

const NOW = 1_759_400_000_000;
const opts = { fiat: 'eur', btcPrice: 100_000, now: NOW, ttlMs: 30 * 60_000 };
const QPU = 500_000;
const PRICE = 0.5; // € per unit → €1 = 1,000,000 quota

function soldKey(tokenId = 7, key = 'sk-' + 'a'.repeat(44) + 'b2c3'): Order {
  const o = makeKeyOrder('1', opts);
  o.state = 'PAID';
  o.notify.done = true;
  o.apiKey = { key, baseUrl: 'https://x/v1', tokenId };
  return o;
}
const paid = (o: Order) => Object.assign(o, { state: 'PAID', paid: { at: NOW, via: 'cashu', sats: o.sats, fee: 0 } });

test('makeTopupOrder: names the key by its last 4 characters only, points at the key order', () => {
  const k = soldKey();
  const t = makeTopupOrder(k, '2', opts);
  assert.equal(t.kind, 'keytopup');
  assert.match(t.id, /^CK[0-9A-F]{32}$/);
  assert.equal(t.name, 'Top-up · €2 for key sk-…b2c3');
  assert.deepEqual(t.topup, { of: k.id, tokenId: 7, keyHint: 'sk-…b2c3' });
  assert.ok(!JSON.stringify(t).includes(k.apiKey!.key));
  assert.throws(() => makeTopupOrder(makeKeyOrder('1', opts), '1', opts)); // no key yet
});

test('findKeyOrder: only keys sold here, with or without sk-', () => {
  const data = emptyLedger();
  const k = soldKey();
  data.orders.push(k, makeKeyOrder('1', opts));
  assert.equal(findKeyOrder(data, k.apiKey!.key), k);
  assert.equal(findKeyOrder(data, ' ' + k.apiKey!.key.slice(3) + '\n'), k);
  assert.equal(findKeyOrder(data, 'sk-' + 'z'.repeat(48)), undefined);
  assert.equal(findKeyOrder(data, 'sk-'), undefined);
  assert.equal(findKeyOrder(data, ''), undefined);
});

test('decideTopup: adds only what is missing of base + add', () => {
  assert.equal(decideTopup(500, 500, 1000), 1000); // nothing added yet
  assert.equal(decideTopup(1500, 500, 1000), 0); // added before a crash
  assert.equal(decideTopup(1200, 500, 1000), 300); // partly undone by a refund race
  assert.equal(decideTopup(1600, 500, 1000), 0); // more (a charge overwritten): never take back
});

test('topupBlocked: a second top-up of the same key waits for one that is half-way', () => {
  const data = emptyLedger();
  const k = soldKey(7);
  const a = paid(makeTopupOrder(k, '1', opts));
  const b = paid(makeTopupOrder(k, '2', opts));
  const other = paid(makeTopupOrder(soldKey(8), '1', opts));
  data.orders.push(k, a, b, other);
  assert.equal(topupBlocked(data, a), false); // nobody started
  a.topup!.base = 100;
  assert.equal(topupBlocked(data, b), true);
  assert.equal(topupBlocked(data, a), false); // never by itself
  assert.equal(topupBlocked(data, other), false); // other keys go on
  a.notify.done = true;
  assert.equal(topupBlocked(data, b), false);
});

test('pendingMoney: open, settling and paid-but-not-made key shop orders', () => {
  const data = emptyLedger();
  const open = makeKeyOrder('2', opts);
  const expired = makeKeyOrder('5', { ...opts, ttlMs: -1 });
  const done = soldKey();
  const making = paid(makeKeyOrder('10', opts));
  const topup = makeTopupOrder(done, '1', opts);
  data.orders.push(open, expired, done, making, topup);
  assert.equal(pendingMoney(data, NOW), 2 + 10 + 1);
  open.state = 'EXPIRED';
  assert.equal(pendingMoney(data, NOW), 11);
});

// ------------------------------------------------------------------ fake new-api

type Tok = Record<string, any>;
function fakeNewApi(tokens: Tok[], userQuota = 100 * QPU) {
  const db = new Map<number, Tok>(tokens.map((t) => [t.id, { status: 1, used_quota: 0, unlimited_quota: false, name: `btc-x${t.id}`, group: 'default', expired_time: -1, model_limits: '', allow_ips: '', ...t }]));
  const log: string[] = [];
  const fx = { db, log, puts: 0, crashAfterPut: false, failGets: false, chargeBeforePut: 0, refundBeforePut: 0 };
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
  const fail = (message: string) => new Response(JSON.stringify({ success: false, message }));
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname === '/api/status') return ok({ quota_per_unit: QPU, price: PRICE, server_address: 'https://x' });
    if (u.pathname === '/api/user/self') return ok({ quota: userQuota, group: 'default' });
    let m = u.pathname.match(/^\/api\/token\/(\d+)$/);
    if (m && method === 'GET') {
      if (fx.failGets) throw new TypeError('fetch failed');
      const t = db.get(Number(m[1]));
      return t ? ok({ ...t }) : fail('record not found');
    }
    if (u.pathname === '/api/token/' && method === 'GET') {
      const size = Number(u.searchParams.get('page_size')), p = Number(u.searchParams.get('p'));
      const all = [...db.values()];
      return ok({ page: p, page_size: size, total: all.length, items: all.slice((p - 1) * size, p * size) });
    }
    if (u.pathname === '/api/token/' && method === 'PUT') {
      const t = db.get(body.id);
      if (!t) return fail('record not found');
      if (u.searchParams.get('status_only')) {
        if (body.status === 1 && t.remain_quota <= 0) return fail('Token quota is exhausted and cannot be enabled');
        t.status = body.status;
        return ok(t);
      }
      if (t.status === 4 && body.status === 1) return fail('Token quota is exhausted');
      // races in the ~50ms between our GET and PUT: a call charged (overwritten by the PUT) or refunded
      t.used_quota += fx.chargeBeforePut - fx.refundBeforePut;
      fx.chargeBeforePut = fx.refundBeforePut = 0;
      // like rc.22: every editable field comes from the body, missing ones are cleared
      for (const k of ['name', 'status', 'expired_time', 'remain_quota', 'unlimited_quota', 'model_limits', 'allow_ips', 'group']) t[k] = body[k] ?? (typeof t[k] === 'number' ? 0 : '');
      fx.puts++;
      if (fx.crashAfterPut) {
        fx.crashAfterPut = false;
        throw new TypeError('fetch failed'); // applied, but our side never hears back
      }
      return ok(t);
    }
    return fail(`fake: no route ${method} ${u.pathname}`);
  }) as typeof fetch;
  return fx;
}

const shop = () => new KeyShop('http://new-api', '3', 'pat', 'https://x/v1');
/** A top-up order + a "disk": save() snapshots it; restart() is what a crashed process reads back. */
function topupOnDisk(money = '2', tokenId = 7) {
  const o = paid(makeTopupOrder(soldKey(tokenId), money, opts));
  let disk = JSON.stringify(o);
  return { o, save: () => void (disk = JSON.stringify(o)), restart: () => JSON.parse(disk) as Order };
}

test('topUp: adds money / price × quota_per_unit, keeps every other field', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 200_000, used_quota: 800_000, model_limits: 'gpt-x', group: 'vip' }]);
  const { o, save, restart } = topupOnDisk('2');
  const r = await shop().topUp(o, save);
  const t = fx.db.get(7)!;
  assert.equal(t.remain_quota, 200_000 + 2_000_000);
  assert.equal(t.used_quota, 800_000);
  assert.deepEqual([t.name, t.group, t.model_limits, t.expired_time, t.status], ['btc-x7', 'vip', 'gpt-x', -1, 1]);
  assert.deepEqual(r, { remaining: 2.2 });
  assert.deepEqual(restart().topup, { ...o.topup, base: 1_000_000, add: 2_000_000 }); // write-ahead was on disk
  assert.equal(fx.puts, 1);
});

test('parseBonusTiers + creditOf: amount:percent tiers, bad entries ignored', () => {
  assert.deepEqual(parseBonusTiers('5:5, 10:10'), { 5: 5, 10: 10 });
  assert.deepEqual(parseBonusTiers('5.0:2.5,x:1,3:0,4:99,'), { 5: 2.5 }); // 0% and >50% are refused
  assert.deepEqual(parseBonusTiers(undefined), {});
  assert.equal(creditOf({ money: '10', bonus: 10 }), 11);
  assert.equal(creditOf({ money: '2' }), 2);
});

test('bonus: locked into the order, named, counted as pending, added to the key once', async () => {
  const k = makeKeyOrder('5', { ...opts, bonus: 5 });
  assert.equal(k.name, 'AI API key · €5 + 5% bonus');
  assert.equal(k.bonus, 5);
  assert.equal(k.sats, makeKeyOrder('5', opts).sats); // the bonus is free: same price
  const data = emptyLedger();
  data.orders.push(k);
  assert.equal(pendingMoney(data, NOW), 5.25);
  // a €10 top-up with 10% puts €11 on the key: 11 / 0.5 € per unit × 500,000 = 11,000,000 quota
  const fx = fakeNewApi([{ id: 7, remain_quota: 0, used_quota: 1_000_000 }]);
  const t = paid(makeTopupOrder(soldKey(), '10', { ...opts, bonus: 10 }));
  assert.equal(t.name, 'Top-up · €10 + 10% bonus for key sk-…b2c3');
  await shop().topUp(t, () => {});
  assert.equal(fx.db.get(7)!.remain_quota, 11_000_000);
  await shop().topUp(t, () => {}); // retry: nothing more
  assert.equal(fx.db.get(7)!.remain_quota, 11_000_000);
});

test('topUp: crash after the write-ahead, before the PUT → the retry adds it once', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 0, used_quota: 1_000_000 }]);
  const { o, save, restart } = topupOnDisk('1');
  fx.failGets = false;
  // first run: base saved, then the network dies before anything is changed
  const s = shop();
  const orig = globalThis.fetch;
  let gets = 0;
  globalThis.fetch = (async (i: any, init?: RequestInit) => {
    if (String(i).includes('/api/token/7') && ++gets === 2) throw new TypeError('fetch failed');
    if ((init?.method ?? 'GET') === 'PUT') throw new TypeError('fetch failed');
    return orig(i, init);
  }) as typeof fetch;
  await assert.rejects(s.topUp(o, save));
  globalThis.fetch = orig;
  assert.equal(fx.puts, 0);
  const again = restart();
  assert.equal(again.topup!.base, 1_000_000);
  await shop().topUp(again, save);
  assert.equal(fx.db.get(7)!.remain_quota, 1_000_000);
  assert.equal(fx.puts, 1);
});

test('topUp: crash after the PUT landed → the retry adds nothing more, even after calls in between', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 300_000, used_quota: 700_000 }]);
  const { o, save, restart } = topupOnDisk('1');
  fx.crashAfterPut = true;
  await assert.rejects(shop().topUp(o, save));
  assert.equal(fx.db.get(7)!.remain_quota, 1_300_000);
  // the key is used before we retry: remain ↓, used ↑, the total stays
  const t = fx.db.get(7)!;
  t.remain_quota -= 250_000;
  t.used_quota += 250_000;
  const r = await shop().topUp(restart(), save);
  assert.equal(fx.puts, 1);
  assert.equal(t.remain_quota, 1_050_000);
  assert.deepEqual(r, { remaining: 1.05 });
});

test('topUp: an exhausted key (status 4) is turned back on', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 0, used_quota: 1_000_000, status: 4 }]);
  const { o, save } = topupOnDisk('5');
  await shop().topUp(o, save);
  assert.deepEqual([fx.db.get(7)!.remain_quota, fx.db.get(7)!.status], [5_000_000, 1]);
  assert.ok(fx.log.includes('PUT /api/token/?status_only=true'));
});

test('topUp: a refund racing the PUT leaves it short → error, and the retry adds the rest', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 400_000, used_quota: 600_000 }]);
  const { o, save, restart } = topupOnDisk('1');
  fx.refundBeforePut = 100_000; // remain +100k / used −100k landed between our GET and PUT; the PUT overwrote remain
  await assert.rejects(shop().topUp(o, save), /not complete/);
  await shop().topUp(restart(), save);
  const t = fx.db.get(7)!;
  assert.equal(t.remain_quota + t.used_quota, 1_000_000 + 1_000_000);
  assert.equal(fx.puts, 2);
});

test('topUp: two top-ups of one key, one after the other, both count', async () => {
  const fx = fakeNewApi([{ id: 7, remain_quota: 100_000, used_quota: 900_000 }]);
  const a = topupOnDisk('1');
  const b = topupOnDisk('2');
  await shop().topUp(a.o, a.save);
  await shop().topUp(b.o, b.save);
  assert.equal(b.o.topup!.base, 2_000_000); // read after a was fully added
  assert.equal(fx.db.get(7)!.remain_quota, 100_000 + 3_000_000);
});

test('topUp: a deleted key → undefined (needs refund), nothing written', async () => {
  const fx = fakeNewApi([]);
  const { o, save } = topupOnDisk('1');
  assert.equal(await shop().topUp(o, save), undefined);
  assert.equal(fx.puts, 0);
  assert.equal(o.topup!.base, undefined);
});

test('pool: user quota minus what limited, usable tokens hold, across pages', async () => {
  const tokens: Tok[] = [];
  for (let i = 1; i <= 150; i++) tokens.push({ id: i, remain_quota: 100_000 }); // 150 × €0.10 = €15
  tokens.push({ id: 500, remain_quota: 9e9, unlimited_quota: true }, { id: 501, remain_quota: 9e9, status: 2 }, { id: 502, remain_quota: -5, status: 4 });
  const fx = fakeNewApi(tokens, 100 * QPU); // €50
  const p = await shop().pool();
  assert.deepEqual(p, { quota: 50, owed: 15, available: 35 });
  assert.equal(fx.log.filter((l) => l.startsWith('GET /api/token/?')).length, 2);
});
