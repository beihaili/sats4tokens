// Local end-to-end checks of the unhappy paths (testnut + fake merchant, nothing else needed):
//   node scripts/edge-checks.ts
// submit: bad sign, idempotent resubmit, conflicting reuse · lightning: invoice only created when asked,
// same invoice twice, paid by testnut · cashu: garbage token, too-small token, token reused on a 2nd order ·
// notify: merchant answers "fail" twice, gateway retries until "success" · operator withdraw.
// Exits 1 on any failure.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Wallet, sumProofs } from '@cashu/cashu-ts';
import { signed } from '../src/epay.ts';
import { GW, KEY, MERCHANT, MINT, makeDataDir, run, until, up, step, customerToken, submitOrder, payToken, readLedger } from './harness.ts';

const dataDir = makeDataDir();
const merchant = run('merchant', 'scripts/fake-merchant.ts', { PORT: '3995', GATEWAY: GW, FAIL_FIRST: '2' });
const gw = run('gateway', 'src/server.ts', { PORT: '8095', DATA_DIR: dataDir });
const order = async (id: string) => (await (await fetch(`${GW}/api/order/${id}`)).json()) as Record<string, any>;
let ok = 0;
const check = (name: string, f: () => void) => {
  f();
  ok++;
  console.log(`   ✔ ${name}`);
};

try {
  await Promise.all([up(`${MERCHANT}/paid`), up(`${GW}/admin`)]);

  step('submit');
  const a = await submitOrder('1.00');
  const tampered = new URLSearchParams({ ...a.form, money: '0.01' });
  const bad = await fetch(`${GW}/submit.php`, { method: 'POST', body: tampered, redirect: 'manual' });
  check('tampered money → 400 invalid sign', () => assert.equal(bad.status, 400));
  const again = await fetch(`${GW}/submit.php`, { method: 'POST', body: new URLSearchParams(a.form), redirect: 'manual' });
  check('same out_trade_no → same order', () => assert.equal(again.headers.get('location'), `/pay/${a.id}`));
  const { sign: _s, sign_type: _t, ...unsigned } = a.form;
  const reuse = await fetch(`${GW}/submit.php`, { method: 'POST', body: new URLSearchParams(signed({ ...unsigned, money: '2.00' }, KEY)), redirect: 'manual' });
  check('same out_trade_no, different money → 400', () => assert.equal(reuse.status, 400));

  step('lightning (invoice is lazy)');
  check('no invoice until the ⚡ tab asks for one', () => assert.equal(readLedger(dataDir).orders[0].quote, undefined));
  const inv1 = await (await fetch(`${GW}/api/order/${a.id}/invoice`, { method: 'POST' })).json();
  const inv2 = await (await fetch(`${GW}/api/order/${a.id}/invoice`, { method: 'POST' })).json();
  check('invoice created, asking twice returns the same one', () => {
    assert.match(inv1.invoice, /^lnbc/);
    assert.equal(inv2.invoice, inv1.invoice);
  });
  await until('lightning order PAID', async () => ((await order(a.id)).state === 'PAID' ? true : undefined));
  check('testnut paid the invoice → order PAID via lightning', () => assert.equal(readLedger(dataDir).orders[0].paid?.via, 'lightning'));

  step('cashu');
  const b = await submitOrder('1.00');
  let [status, body] = await payToken(b.id, 'cashuBnotatoken');
  check('garbage → "not a valid cashu token"', () => assert.deepEqual([status, body.error], [400, 'not a valid cashu token']));
  const small = await customerToken(10);
  [status, body] = await payToken(b.id, small);
  check(`10 sat token on a ${b.sats} sat order → rejected, order still PENDING`, () => {
    assert.equal(status, 400);
    assert.match(String(body.error), /token is 10 sat, order needs \d+ sat/);
    assert.equal(readLedger(dataDir).orders.find((o) => o.id === b.id)?.state, 'PENDING');
  });
  const token = await customerToken(b.sats + 2);
  [status, body] = await payToken(b.id, token);
  check('enough → PAID via cashu', () => assert.deepEqual([status, body.state], [200, 'PAID']));
  const c = await submitOrder('1.00');
  [status, body] = await payToken(c.id, token);
  check('same token on another order → "token already spent"', () => assert.deepEqual([status, body.error], [400, 'token already spent']));

  step('notify (merchant answers "fail" for the first 2 notifies)');
  await until('merchant credited both', async () => {
    const paid = (await (await fetch(`${MERCHANT}/paid`)).json()) as string[];
    return paid.includes(a.outTradeNo) && paid.includes(b.outTradeNo) ? paid : undefined;
  }, 60_000);
  const paid = (await (await fetch(`${MERCHANT}/paid`)).json()) as string[];
  const l = readLedger(dataDir);
  check('both credited exactly once, order c not at all', () => assert.deepEqual(paid.sort(), [a.outTradeNo, b.outTradeNo].sort()));
  check('gateway retried failed notifies', () => assert.ok(l.orders.reduce((n, o) => n + o.notify.attempts, 0) >= 2));
  const { balance } = (await (await fetch(`${GW}/admin?key=${KEY}`)).json()) as { balance: number };
  check(`wallet balance ${balance} sat = sum received by the two orders`, () =>
    assert.equal(balance, l.orders.reduce((n, o) => n + (o.paid?.sats ?? 0), 0)));

  step('operator withdraw');
  const w = await (await fetch(`${GW}/admin/withdraw?key=${KEY}`, { method: 'POST' })).json();
  const t = new Wallet(MINT, { unit: 'sat' });
  await t.loadMint();
  const proofs = t.decodeToken(fs.readFileSync(w.file, 'utf8').trim()).proofs;
  const states = await t.checkProofsStates(proofs);
  check(`withdraw → token file worth ${w.sats} sat, all proofs unspent at the mint`, () => {
    assert.equal(w.sats, balance);
    assert.equal(sumProofs(proofs).toNumber(), balance);
    assert.ok(states.every((x) => x.state === 'UNSPENT'));
  });
  const w2 = await fetch(`${GW}/admin/withdraw?key=${KEY}`, { method: 'POST' });
  check('balance now 0, second withdraw refused', () => assert.equal(w2.status, 400));

  console.log(`\n\x1b[1;32m✅ ${ok} edge checks passed\x1b[0m`);
} catch (e) {
  console.error('\n\x1b[1;31m❌', (e as Error).message, '\x1b[0m');
  process.exitCode = 1;
} finally {
  merchant.child.kill('SIGKILL');
  gw.child.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true }); // testnut ecash only, worthless
}
