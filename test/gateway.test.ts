// mintProblems(): the startup check that refuses mints without what crash recovery needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MintInfo } from '@cashu/cashu-ts';
import { mintProblems } from '../src/gateway.ts';

/** A fake NUT-06 info: `nuts` lists the generic NUTs the mint claims, `bolt11` whether NUT-04 has bolt11/sat. */
const info = (nuts: number[], bolt11 = true, disabled = false) =>
  ({
    isSupported: (n: number) =>
      n === 4
        ? { disabled, params: bolt11 ? [{ method: 'bolt11', unit: 'sat' }] : [{ method: 'bolt11', unit: 'usd' }] }
        : { supported: nuts.includes(n) },
  }) as unknown as Pick<MintInfo, 'isSupported'>;

test('mintProblems: a mint with NUT-04 bolt11/sat, 07 and 09 is fine', () => {
  assert.deepEqual(mintProblems(info([7, 9])), []);
});

test('mintProblems: missing restore or state check is refused', () => {
  assert.deepEqual(mintProblems(info([7])), ['no restore (NUT-09), crash recovery impossible']);
  assert.deepEqual(mintProblems(info([9])), ['no proof state check (NUT-07)']);
});

test('mintProblems: minting disabled or no sat bolt11', () => {
  assert.equal(mintProblems(info([7, 9], true, true)).length, 1);
  assert.equal(mintProblems(info([7, 9], false)).length, 1);
});
