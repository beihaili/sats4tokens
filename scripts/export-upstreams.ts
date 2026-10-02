// Anonymized upstream snapshot for the /network page. Runs on the server (inside the gateway container, which
// has node), fed by deploy/demo/export-upstreams.sh:
//
//   {"channels":[{id,status,host,priority,weight,latencyMs}], "abilities":[{group,model,channel,enabled}]}  (stdin)
//   node scripts/export-upstreams.ts [group=default] > upstreams.json
//
// The output has no channel names, hosts or keys — see src/upstreams.ts. It does keep the numeric channel ids
// (the gateway maps call logs with them and strips them before anything is served).
import { anonymize, type RawAbility, type RawChannel } from '../src/upstreams.ts';

const group = process.argv[2] ?? 'default';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { channels, abilities } = JSON.parse(input) as { channels: RawChannel[]; abilities: RawAbility[] };
const snap = anonymize(channels, abilities, group);
if (!snap.providers.length) throw new Error(`no channel serves group "${group}"`);
process.stdout.write(JSON.stringify(snap, null, 1) + '\n');
const nodes = snap.providers.flatMap((p) => p.nodes);
console.error(
  `${snap.providers.length} providers, ${nodes.length} channels (${nodes.filter((n) => n.active).length} enabled), ` +
    `${Object.keys(snap.routes).length} models routed for group "${group}"`,
);
