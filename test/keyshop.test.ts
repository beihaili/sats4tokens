// aliasesOf(): which model names the public lists hide (MODEL_ALIAS_SUFFIX) and the base name their calls show as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesOf } from '../src/keyshop.ts';

test('aliasesOf: hides suffixed names only when the base model is listed too', () => {
  const names = ['opus-4', 'opus-4-x', 'gpt-5', 'gpt-5-compat', 'lonely-x', 'opus-4-max'];
  const got = aliasesOf(names, /-x$|-compat$/);
  assert.deepEqual([...got], [
    ['opus-4-x', 'opus-4'],
    ['gpt-5-compat', 'gpt-5'],
  ]); // lonely-x has no base → stays listed; opus-4-max doesn't match → a real variant
  assert.equal(aliasesOf(names, undefined).size, 0); // no MODEL_ALIAS_SUFFIX → nothing hidden
});
