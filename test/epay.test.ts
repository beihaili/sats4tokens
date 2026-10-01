// EPay signing must match go-epay (what new-api uses) byte for byte, in both directions.
// The expected signatures below were produced by go-epay itself with pid 1001 / key "s3cr3t-key".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, signed, signingString, verify } from '../src/epay.ts';

const KEY = 's3cr3t-key';

// what new-api POSTs to /submit.php
const purchase = {
  pid: '1001',
  type: 'bitcoin',
  out_trade_no: 'USR1NOabc1231759400000',
  notify_url: 'http://localhost:3000/api/user/epay/notify',
  return_url: 'http://localhost:3000/usage-logs',
  name: 'TUC10',
  money: '73.00',
  device: 'pc',
};

// what we GET back on notify_url
const notify = {
  pid: '1001',
  trade_no: 'CE1',
  out_trade_no: 'USR1NOabc1231759400000',
  type: 'bitcoin',
  name: 'TUC10',
  money: '73.00',
  trade_status: 'TRADE_SUCCESS',
};

test('purchase signature matches go-epay', () => {
  assert.equal(sign(purchase, KEY), '4138440e5ca23b9ca66d1f8298429ced');
});

test('notify signature matches go-epay', () => {
  assert.equal(sign(notify, KEY), '3eafbc27e83fc553173839a6ac7c9536');
});

test('signing string: sorted, raw values, sign/sign_type/empty dropped', () => {
  const s = signingString({ b: '2', a: 'x y&z', sign: 'zz', sign_type: 'MD5', empty: '' });
  assert.equal(s, 'a=x y&z&b=2');
});

test('signed() adds sign + sign_type and verifies', () => {
  const p = signed(notify, KEY);
  assert.equal(p.sign_type, 'MD5');
  assert.ok(verify(p, KEY));
  assert.ok(verify({ ...p, sign: p.sign.toUpperCase() }, KEY), 'hex case does not matter');
});

test('verify rejects tampering, wrong key, missing sign', () => {
  const p = signed(purchase, KEY);
  assert.equal(verify({ ...p, money: '0.01' }, KEY), false);
  assert.equal(verify(p, 'other-key'), false);
  const { sign: _drop, ...unsigned } = p;
  assert.equal(verify(unsigned, KEY), false);
  assert.equal(verify({ ...p, sign: 'short' }, KEY), false);
});
