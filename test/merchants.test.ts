import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantsFromEnv, submitMerchant, merchantKey, relayCheckout } from '../src/merchants.ts';
import { signed, verify, type Params } from '../src/epay.ts';
import { emptyLedger, makeOrder, checkSubmit, notifyParams } from '../src/ledger.ts';
import { btcPrice } from '../src/price.ts';
const eu = { pid: '1001', key: 'eu-test-key', fiat: 'eur' };
const main = { pid: '1002', key: 'main-test-key-00000000000000000000', fiat: 'cny', notifyUrl: 'https://main.example/api/user/epay/notify', returnUrl: 'https://main.example/console/topup' };
const config = { EPAY_PID: eu.pid, EPAY_KEY: eu.key, FIAT: eu.fiat, EPAY_MERCHANTS: JSON.stringify([main]) };
const params = (m = main) => ({ pid: m.pid, type: 'usdc', out_trade_no: 'same-reference', name: 'top-up', money: '10.00', notify_url: m.notifyUrl, return_url: m.returnUrl });
const opts = { fiat: 'cny', btcPrice: 700000, now: 1000, ttlMs: 60000 };
test('merchant isolation: independent signatures, callback pins, unknown merchants, callback replay', () => {
 const ms = merchantsFromEnv(config); const p = params();
 assert.equal(submitMerchant(ms, signed(p, main.key))?.fiat, 'cny');
 assert.equal(submitMerchant(ms, signed(p, eu.key)), undefined);
 for (const change of [{ pid: 'unknown' }, { notify_url: 'https://evil.example/callback' }, { return_url: 'https://evil.example/' }, { type: 'alipay' }, { money: '1.00', sign: 'invalid' }] as Params[]) {
  const bad = { ...signed(p, main.key), ...change };
  assert.equal(submitMerchant(ms, bad), undefined);
 }
 assert.equal(submitMerchant(ms, signed({ ...p, notify_url: 'https://evil.example/callback' }, main.key)), undefined);
 const o = makeOrder(p, opts); const n = signed(notifyParams(o), merchantKey(ms, o));
 assert.ok(verify(n, main.key)); assert.ok(!verify(n, eu.key));
 assert.throws(() => merchantKey(ms, { ...o, pid: 'missing' }), /unavailable/);
 assert.ok(relayCheckout(o)); assert.ok(!relayCheckout({ ...o, kind: 'key' }));
});
test('merchant config rejects duplicate identities, shared keys and unsafe endpoints', () => {
 for (const m of [{ ...main, pid: eu.pid }, { ...main, key: eu.key }, { ...main, fiat: 'invalid' }, { ...main, notifyUrl: 'http://main.example/notify' }, { ...main, returnUrl: 'https://main.example/ok?x=1' }]) {
  assert.throws(() => merchantsFromEnv({ ...config, EPAY_MERCHANTS: JSON.stringify([m]) }));
 }
});
test('same order reference is scoped to merchant; retries cannot change return URL or method', () => {
 const d = emptyLedger(); const p = params(); const o = makeOrder(p, opts); d.orders.push(o);
 assert.equal(checkSubmit(d, p, main.pid).kind, 'existing');
 assert.equal(checkSubmit(d, { ...p, pid: eu.pid }, eu.pid).kind, 'new');
 for (const change of [{ money: '11.00' }, { type: 'lightning' }, { return_url: 'https://main.example/different' }]) assert.equal(checkSubmit(d, { ...p, ...change }, main.pid).kind, 'reject');
});
test('BTC quotes use each merchant currency and reject invalid fixed quotes', async () => {
 process.env.BTC_PRICE_CNY = '700000'; process.env.BTC_PRICE_EUR = '90000';
 try {
  assert.equal(await btcPrice('cny'), 700000); assert.equal(await btcPrice('eur'), 90000);
  process.env.BTC_PRICE_CNY = 'Infinity'; await assert.rejects(btcPrice('cny'), /Invalid/);
 } finally { delete process.env.BTC_PRICE_CNY; delete process.env.BTC_PRICE_EUR; }
});
