// anonymize(): the snapshot behind /network — no hosts in it, providers per domain, new-api's routing tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, providerKey, family, type RawChannel, type RawAbility } from '../src/upstreams.ts';

const ch = (id: number, host: string, priority: number, weight: number, status = 1): RawChannel => ({ id, status, host, priority, weight, latencyMs: 1200 });
const ab = (channel: number, model: string, group = 'default', enabled = 1): RawAbility => ({ group, model, channel, enabled });

const channels = [
  ch(3, 'api.alpha.example', 10, 0),
  ch(5, 'img.alpha.example', 1, 1),
  ch(7, '10.0.0.9:8080', 10, 0),
  ch(9, 'beta.example', 5, 3),
  ch(11, 'beta.example', 5, 1),
  ch(12, 'beta.example', 10, 50, 2), // disabled: listed, never routed
  ch(20, 'internal.example', 10, 1), // other group only: not listed at all
];
const abilities = [
  ab(3, 'claude-opus-5'),
  ab(7, 'claude-opus-5'),
  ab(9, 'claude-opus-5'),
  ab(11, 'claude-opus-5'),
  ab(12, 'claude-opus-5'),
  ab(5, 'gpt-image-2'),
  ab(9, 'deepseek-v4-pro', 'default', 0), // ability switched off
  ab(20, 'claude-opus-5', 'admin-internal'),
];

test('providerKey: one provider per registrable domain; IPs drop the port', () => {
  assert.equal(providerKey('api.alpha.example'), 'alpha.example');
  assert.equal(providerKey('IMG.alpha.example'), 'alpha.example');
  assert.equal(providerKey('10.0.0.9:8080'), '10.0.0.9');
  assert.equal(providerKey('localhost:3000'), 'localhost');
});

test('family: model name → label', () => {
  assert.equal(family('claude-fable-5-1'), 'Claude');
  assert.equal(family('gpt-image-2'), 'Images');
  assert.equal(family('gpt-5.6-sol'), 'GPT');
  assert.equal(family('doubao-seedance-2-0-720p'), 'Video');
  assert.equal(family('glm-5.3'), 'GLM');
});

test('anonymize: letters per provider by first channel id, no host anywhere', () => {
  const s = anonymize(channels, abilities, 'default', 1);
  assert.deepEqual(
    s.providers.map((p) => [p.name, p.nodes.map((n) => `${n.name}#${n.channel}`)]),
    [
      ['A', ['A1#3', 'A2#5']],
      ['B', ['B1#7']],
      ['C', ['C1#9', 'C2#11', 'C3#12']],
    ],
  );
  const json = JSON.stringify(s);
  for (const h of ['alpha', 'beta', '10.0.0.9', 'internal']) assert.ok(!json.includes(h), `leaks ${h}`);
  const c3 = s.providers[2].nodes[2];
  assert.equal(c3.active, false);
  assert.deepEqual(s.providers[2].nodes[0].models, ['claude-opus-5', 'deepseek-v4-pro']); // listed even if off
});

test('anonymize: tiers high → low priority; shares by weight, equal when all weights are 0', () => {
  const r = anonymize(channels, abilities, 'default').routes;
  assert.deepEqual(r['claude-opus-5'], [
    [ { node: 'A1', share: 0.5 }, { node: 'B1', share: 0.5 } ], // priority 10, weights 0/0 (C3 is disabled)
    [ { node: 'C1', share: 0.75 }, { node: 'C2', share: 0.25 } ], // priority 5, weights 3/1
  ]);
  assert.deepEqual(r['gpt-image-2'], [[{ node: 'A2', share: 1 }]]);
  assert.equal(r['deepseek-v4-pro'], undefined); // only a switched-off ability
});
