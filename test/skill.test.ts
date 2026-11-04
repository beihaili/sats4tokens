// The agent skill (skill/sats4tokens): error classification, caps, and exactly-once top-ups against a fake shop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  balance, capProblem, classifyError, loadState, Stop, topup,
  type Config, type Deps, type Wallet, type WalletResult,
} from '../skill/sats4tokens/lib.ts';

test('classifyError: new-api answers', () => {
  assert.equal(classifyError(401, { error: { message: 'Invalid token', type: 'new_api_error' } }), 'topup');
  assert.equal(classifyError(403, { error: { code: 'pre_consume_token_quota_failed', message: 'x' } }), 'check-balance');
  // Claude format keeps only the message
  assert.equal(classifyError(403, { type: 'error', error: { type: 'new_api_error', message: 'token quota is not enough, token remain quota: ＄0.01, need quota: ＄0.2' } }), 'check-balance');
  assert.equal(classifyError(403, { error: { code: 'insufficient_user_quota', message: '' } }), 'pool-empty');
  assert.equal(classifyError(403, { error: { message: 'Insufficient user quota, remaining quota: 0' } }), 'pool-empty');
  assert.equal(classifyError(500, { error: { message: 'upstream' } }), 'not-ours');
  assert.equal(classifyError(429, 'rate limited'), 'not-ours');
});

const H = 3600_000;
function cfg(over: Partial<Config> = {}): Config {
  return {
    shop: 'https://shop.test', key: 'sk-' + 'a'.repeat(48), baseUrl: 'https://api.test', pay: 'lightning',
    wallet: { name: 'manual' }, maxPerTopup: 2, maxPerDay: 5, minIntervalMin: 10,
    stateFile: join(mkdtempSync(join(tmpdir(), 's4t-')), 'state.json'), pollMs: 1, waitMin: 1, ...over,
  };
}

test('capProblem: per top-up, per day (maybe-paid counts), interval', () => {
  const c = cfg();
  const now = 100 * H;
  assert.match(capProblem({ attempts: [] }, 5, c, now)!, /per-top-up/);
  assert.equal(capProblem({ attempts: [] }, 2, c, now), null);
  const s = { attempts: [
    { id: 'a', money: 2, createdAt: now - 3 * H, final: 'applied' as const },
    { id: 'b', money: 2, createdAt: now - 2 * H, sentAt: now - 2 * H }, // outcome unknown: counts
    { id: 'c', money: 2, createdAt: now - 1 * H, final: 'expired' as const }, // nothing spent
    { id: 'd', money: 2, createdAt: now - 30 * H, final: 'applied' as const }, // older than a day
  ] };
  assert.match(capProblem(s, 2, c, now)!, /daily limit/);
  assert.equal(capProblem(s, 1, c, now), null);
  const recent = { attempts: [{ id: 'e', money: 1, createdAt: now - 5 * 60_000, final: 'applied' as const }] };
  assert.match(capProblem(recent, 1, c, now)!, /already topped up/);
});

// A fake shop with the real endpoints' shapes. `mintPays` = what the mint sees after the wallet's call.
function fakeShop(opts: { knownKey?: boolean; sats?: number } = {}) {
  const orders = new Map<string, any>();
  const calls: string[] = [];
  let n = 0;
  const shop = {
    orders, calls, tokensSeen: [] as string[],
    payInvoice(id: string) { const o = orders.get(id); o.state = 'PAID'; o.topup.applied = { at: 1, remaining: 3.5 }; },
  };
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (u.pathname === '/api/shop') return json(200, { enabled: true, amounts: ['1', '2', '5', '10'], fiat: 'eur' });
    if (u.pathname === '/api/buy') {
      if (opts.knownKey === false) return json(404, { error: 'unknown key' });
      const id = 'CK' + String(++n).padStart(32, '0');
      orders.set(id, { id, state: 'PENDING', sats: opts.sats ?? 1337, topup: { key: 'sk-…aaaa' } });
      return json(200, { id });
    }
    const m = u.pathname.match(/^\/api\/order\/(CK\d+)(\/invoice|\/token)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (m[2] === '/invoice') return json(200, { ...o, invoice: 'lnbc' + m[1] });
      if (m[2] === '/token') {
        shop.tokensSeen.push(body.token);
        if (o.state === 'PAID') return o.token === body.token ? json(200, o) : json(400, { error: 'order is paid' });
        o.token = body.token;
        shop.payInvoice(m[1]);
        return json(200, o);
      }
      return json(200, o);
    }
    if (u.pathname === '/v1/dashboard/billing/subscription') return json(200, { hard_limit_usd: 15 });
    if (u.pathname === '/v1/dashboard/billing/usage') return json(200, { total_usage: 750 });
    if (u.pathname === '/api/status') return json(200, { success: true, data: { price: 0.133333 } });
    return json(404, { error: 'no route' });
  }) as typeof fetch;
  return { shop, fetch: f };
}
const deps = (f: typeof fetch, logs: string[] = []): Deps => ({ fetch: f, now: () => Date.now(), sleep: async () => {}, log: (m) => logs.push(m) });

test('topup over Lightning: order saved before the wallet is called, invoice paid once', async () => {
  const { shop, fetch } = fakeShop();
  const c = cfg();
  const paid: string[] = [];
  c.wallet = {
    name: 'fake',
    async payInvoice(bolt11) {
      const s = loadState(c.stateFile);
      assert.equal(s.attempts.length, 1); // write-ahead: on disk before the money moves
      assert.ok(s.attempts[0].sentAt);
      paid.push(bolt11);
      shop.payInvoice(bolt11.slice(4));
      return { ok: true, out: '' };
    },
  };
  assert.deepEqual(await topup(c, 2, deps(fetch)), { added: 2, remaining: 3.5 });
  assert.equal(paid.length, 1);
  assert.equal(loadState(c.stateFile).attempts[0].final, 'applied');
  // a second top-up right away is refused by the interval rule, and the agent pays nothing
  await assert.rejects(topup(c, 1, deps(fetch)), (e) => e instanceof Stop && /already topped up/.test(e.message) && /\/pay\/CK/.test(e.message));
  assert.equal(paid.length, 1);
});

test('topup: a wallet timeout is never retried; a rerun resumes the same order', async () => {
  const { shop, fetch } = fakeShop();
  const c = cfg({ waitMin: 0 });
  let calls = 0;
  c.wallet = { name: 'fake', async payInvoice() { calls++; return { ok: false, error: 'timeout' }; } };
  await assert.rejects(topup(c, 2, deps(fetch)), (e) => e instanceof Stop && /Nothing will be paid again/.test(e.message));
  // the payment did go through after all
  shop.payInvoice([...shop.orders.keys()][0]);
  assert.deepEqual(await topup(c, 2, deps(fetch)), { added: 2, remaining: 3.5 });
  assert.equal(calls, 1);
  assert.equal(shop.calls.filter((x) => x === 'POST /api/buy').length, 1);
});

test('topup: expired unpaid order is closed, nothing counted', async () => {
  const { shop, fetch } = fakeShop();
  const c = cfg();
  c.wallet = { name: 'fake', async payInvoice(b) { shop.orders.get(b.slice(4)).state = 'EXPIRED'; return { ok: false, error: 'no route' }; } };
  await assert.rejects(topup(c, 2, deps(fetch)), (e) => e instanceof Stop && /nothing was spent/.test(e.message));
  const s = loadState(c.stateFile);
  assert.equal(s.attempts[0].final, 'expired');
  assert.equal(capProblem(s, 2, c, Date.now()), null);
});

test('topup: unknown key and over-limit stop before paying', async () => {
  const c = cfg();
  c.wallet = { name: 'fake', async payInvoice() { throw new Error('must not pay'); } };
  await assert.rejects(topup(c, 2, deps(fakeShop({ knownKey: false }).fetch)), (e) => e instanceof Stop && /unknown key/.test(e.message));
  await assert.rejects(topup(c, 5, deps(fakeShop().fetch)), (e) => e instanceof Stop && /per-top-up/.test(e.message));
  await assert.rejects(topup(c, 3, deps(fakeShop().fetch)), (e) => e instanceof Stop && /can't be bought/.test(e.message));
});

test('topup with Cashu: token saved before sending, re-sent to the same order after a crash', async () => {
  const { shop, fetch } = fakeShop({ sats: 1200 });
  const c = cfg({ pay: 'cashu' });
  let made = 0;
  const wallet: Wallet = { name: 'fake', async sendToken(sats): Promise<WalletResult> { made++; return { ok: true, out: `Token:\ncashuBtok${sats}x\n` }; } };
  // first run dies when sending: the fetch to /token throws every time
  c.wallet = wallet;
  const dying = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/token')) throw new Error('ECONNRESET');
    return fetch(url, init);
  }) as typeof fetch;
  await assert.rejects(topup(c, 1, deps(dying)));
  const s = loadState(c.stateFile);
  assert.equal(s.attempts[0].token, 'cashuBtok1200x');
  assert.equal(shop.tokensSeen.length, 0);
  assert.deepEqual(await topup(c, 1, deps(fetch)), { added: 1, remaining: 3.5 });
  assert.equal(made, 1); // the saved token, not a new one
  assert.deepEqual(shop.tokensSeen, ['cashuBtok1200x']);
  assert.match(readFileSync(c.stateFile, 'utf8'), /"final": "applied"/);
});

test('balance: from new-api billing endpoints with the key, in FIAT', async () => {
  const { fetch } = fakeShop();
  // 15 units total, 7.5 used, at €0.133333 a unit
  assert.deepEqual(await balance(cfg(), deps(fetch)), { remaining: 1, used: 1, fiat: 'eur' });
  const used = (async (url: string, init?: RequestInit) =>
    String(url).includes('/dashboard/') ? new Response('{"error":{"message":"Invalid token"}}', { status: 401 }) : fetch(url, init)) as typeof fetch;
  assert.equal(await balance(cfg(), deps(used)), null);
});
