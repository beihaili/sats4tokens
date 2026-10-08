// Funnel counts + price check: ref cleaning, day/ref rows joined with ledger orders, persistence; compare() rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Funnel, cleanRef } from '../src/funnel.ts';
import { compare, ROWS } from '../src/compare.ts';
import { makeKeyOrder } from '../src/ledger.ts';

const DAY1 = Date.parse('2026-10-09T10:00:00Z');
const opts = { fiat: 'eur', btcPrice: 100_000, now: DAY1, ttlMs: 30 * 60_000 };

test('cleanRef: short lowercase refs kept, empty → direct, junk → other', () => {
  assert.equal(cleanRef('HN'), 'hn');
  assert.equal(cleanRef(' x '), 'x');
  assert.equal(cleanRef(''), 'direct');
  assert.equal(cleanRef(undefined), 'direct');
  assert.equal(cleanRef('<script>'), 'other');
  assert.equal(cleanRef('a'.repeat(30)), 'other');
});

test('Funnel: views per day and ref, joined with orders and payments; survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-')), 'funnel.json');
  const f = new Funnel(file);
  f.hit('hn', true, DAY1);
  f.hit('hn', false, DAY1);
  f.hit('direct', true, DAY1);
  const paid = Object.assign(makeKeyOrder('5', opts), { ref: 'hn', state: 'PAID' as const });
  const open = Object.assign(makeKeyOrder('1', opts), { ref: 'hn' });
  const old = Object.assign(makeKeyOrder('1', { ...opts, now: DAY1 - 30 * 86400_000 }), { ref: 'x' });
  const rows = f.report([paid, open, old], 14, DAY1);
  assert.deepEqual(rows, [
    { day: '2026-10-09', ref: 'hn', views: 2, visitors: 1, orders: 2, paid: 1, money: 5 },
    { day: '2026-10-09', ref: 'direct', views: 1, visitors: 1, orders: 0, paid: 0, money: 0 },
  ]);
  f.flush(DAY1);
  assert.deepEqual(new Funnel(file).report([], 14, DAY1).map((r) => r.views), [2, 1]);
});

test('Funnel: at most 50 refs a day, the rest count as other', () => {
  const f = new Funnel(path.join(os.tmpdir(), 'never-written.json'));
  for (let i = 0; i < 60; i++) f.hit('r' + i, false, DAY1);
  const refs = f.report([], 1, DAY1).map((r) => r.ref);
  assert.equal(refs.length, 51);
  assert.ok(refs.includes('other'));
});

test('compare: our live price in USD next to list and ppq, minOff from the rows we can sell', () => {
  const models = [
    { model: 'claude-opus-5-5', vendor: 'Anthropic', input: 1.6, output: 8, fastTier: false, endpoints: [] },
    { model: 'gpt-6.1-sol', vendor: 'OpenAI', input: 0.25, output: 1.25, fastTier: false, endpoints: [] },
  ];
  const c = compare(models, 1.25); // € → $
  assert.equal(c.rows.length, 2); // fable / opus 4.8 not in the pool here → left out
  assert.deepEqual(c.rows[0].ours, [2, 10]);
  assert.equal(c.rows[0].off, 50); // $10 vs $20 list
  assert.equal(c.rows[1].off, 84);
  assert.equal(c.minOff, 50);
  assert.ok(ROWS.every((r) => r.ppq[1] > 0 && r.list[1] > 0));
});
