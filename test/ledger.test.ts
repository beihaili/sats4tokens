// Pure ledger logic: submit idempotency, pricing, write-ahead settle, recovery table, notify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Ledger, abortSettle, beginSettle, checkSubmit, decideSettle, dueForNotify, emptyLedger, finishSettle,
  makeOrder, notifyBackoffMs, notifyParams, satsFor,
} from '../src/ledger.ts';

const PID = '1001';
const submit = (over: Record<string, string> = {}) => ({
  pid: PID, type: 'bitcoin', out_trade_no: 'USR2NOx1', notify_url: 'http://new-api:3000/api/user/epay/notify',
  return_url: 'http://x/usage', name: 'TUC10', money: '10.00', ...over,
});
const NOW = 1_759_400_000_000;
const newOrder = (data = emptyLedger(), p = submit()) => {
  const o = makeOrder(p, { fiat: 'cny', btcPrice: 800_000, now: NOW, ttlMs: 30 * 60_000 });
  data.orders.push(o);
  return { data, o };
};

test('checkSubmit: new, idempotent resubmit, conflicting reuse', () => {
  const { data, o } = newOrder();
  assert.deepEqual(checkSubmit(emptyLedger(), submit(), PID), { kind: 'new' });
  assert.deepEqual(checkSubmit(data, submit(), PID), { kind: 'existing', order: o });
  assert.equal(checkSubmit(data, submit({ money: '20.00' }), PID).kind, 'reject');
  assert.equal(checkSubmit(data, submit({ notify_url: 'http://evil/' }), PID).kind, 'reject');
});

test('checkSubmit: validation', () => {
  const reason = (p: Record<string, string>) => {
    const r = checkSubmit(emptyLedger(), submit(p), PID);
    return r.kind === 'reject' ? r.reason : r.kind;
  };
  assert.equal(reason({ money: '' }), 'missing money');
  assert.equal(reason({ pid: '9' }), 'unknown pid');
  for (const m of ['0', '0.00', '-1', '1.234', 'abc', '1e3']) assert.equal(reason({ money: m }), 'bad money', m);
  assert.equal(reason({ notify_url: 'javascript:alert(1)' }), 'bad notify_url');
  assert.equal(reason({ money: '7' }), 'new');
});

test('satsFor rounds up and never returns 0', () => {
  assert.equal(satsFor('10.00', 800_000), 1250); // exact
  assert.equal(satsFor('10.00', 700_000), 1429); // 1428.57… → up
  assert.equal(satsFor('0.01', 10_000_000), 1); // 0.1 sat → 1
});

test('makeOrder locks price and sats, starts PENDING', () => {
  const { o } = newOrder();
  assert.equal(o.state, 'PENDING');
  assert.equal(o.sats, 1250);
  assert.equal(o.expiresAt - o.createdAt, 30 * 60_000);
  assert.match(o.id, /^CE[0-9A-Z]+$/);
});

test('beginSettle claims a fresh counter range (write-ahead) and finishSettle pays', () => {
  const { data, o } = newOrder();
  const o2 = newOrder(data, submit({ out_trade_no: 'USR2NOx2' })).o;
  const s1 = beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 4, token: 'cashuB…' }, NOW);
  const s2 = beginSettle(data, o2, { via: 'lightning', keysetId: 'k', count: 3 }, NOW);
  assert.equal(s1.counter, 1);
  assert.equal(s2.counter, 5, 'ranges never overlap');
  assert.equal(data.nextCounter, 8);
  assert.equal(o.state, 'SETTLING');
  assert.throws(() => beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 1 }, NOW), /SETTLING/);

  finishSettle(data, o, ['p1', 'p2'], 1249, NOW + 1);
  assert.equal(o.state, 'PAID');
  assert.deepEqual(o.paid, { at: NOW + 1, via: 'cashu', sats: 1249, fee: 1 });
  assert.equal(o.settle?.token, undefined, 'bearer token dropped once swapped');
  assert.deepEqual(data.proofs, ['p1', 'p2']);
  assert.ok(dueForNotify(o, NOW + 1));
  assert.throws(() => beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 1 }, NOW), /PAID/, 'no double pay');
});

test('expired orders: lightning may still settle, cashu may not', () => {
  const { data, o } = newOrder();
  o.state = 'EXPIRED';
  assert.throws(() => beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 1 }, NOW), /EXPIRED/);
  assert.equal(beginSettle(data, o, { via: 'lightning', keysetId: 'k', count: 1 }, NOW).via, 'lightning');
});

test('abortSettle returns to PENDING with a reason; counter range is not reused', () => {
  const { data, o } = newOrder();
  beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 2 }, NOW);
  abortSettle(o, 'token already spent');
  assert.equal(o.state, 'PENDING');
  assert.equal(o.lastError, 'token already spent');
  assert.equal(beginSettle(data, o, { via: 'cashu', keysetId: 'k', count: 2 }, NOW).counter, 3);
});

test('decideSettle recovery table', () => {
  assert.equal(decideSettle('lightning', { restored: 2, quoteState: 'ISSUED' }), 'finish');
  assert.equal(decideSettle('cashu', { restored: 1, inputState: 'SPENT' }), 'finish');
  assert.equal(decideSettle('lightning', { restored: 0, quoteState: 'PAID' }), 'retry');
  assert.equal(decideSettle('lightning', { restored: 0, quoteState: 'ISSUED' }), 'conflict');
  assert.equal(decideSettle('lightning', { restored: 0, quoteState: 'UNPAID' }), 'conflict');
  assert.equal(decideSettle('cashu', { restored: 0, inputState: 'UNSPENT' }), 'retry');
  assert.equal(decideSettle('cashu', { restored: 0, inputState: 'PENDING' }), 'wait');
  assert.equal(decideSettle('cashu', { restored: 0, inputState: 'SPENT' }), 'abort');
});

test('notify: params, backoff, due', () => {
  const { o } = newOrder();
  assert.deepEqual(Object.keys(notifyParams(o)).sort(), ['money', 'name', 'out_trade_no', 'pid', 'trade_no', 'trade_status', 'type']);
  assert.equal(notifyParams(o).trade_status, 'TRADE_SUCCESS');
  assert.deepEqual([0, 1, 2, 3].map(notifyBackoffMs), [5000, 10000, 20000, 40000]);
  assert.equal(notifyBackoffMs(20), 600_000);
  assert.equal(dueForNotify(o, NOW), false, 'not before PAID');
  o.state = 'PAID';
  o.notify.nextAt = NOW + 5000;
  assert.equal(dueForNotify(o, NOW), false);
  assert.equal(dueForNotify(o, NOW + 5000), true);
  o.notify.done = true;
  assert.equal(dueForNotify(o, NOW + 5000), false);
});

test('Ledger.save is atomic and private (0600), reload round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'ledger.json');
  const l = new Ledger(file);
  newOrder(l.data);
  l.data.proofs.push('secret');
  l.save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const again = new Ledger(file);
  assert.deepEqual(again.data, l.data);
  assert.ok(again.order(l.data.orders[0].id));
  fs.rmSync(dir, { recursive: true });
});
