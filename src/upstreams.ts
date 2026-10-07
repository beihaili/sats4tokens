// Upstream network: which upstreams a sold key's requests can go to, for the public /network page.
//
// The relay forwards each request to one of many upstream channels (new-api "channels"). Upstream names,
// base URLs and keys are the operator's business, so they never reach this process in the clear:
// `scripts/export-upstreams.ts` runs on the server, reads the routing table from new-api's DB and writes an
// anonymized snapshot — providers become "A", "B", … (one per upstream domain), their channels "A1", "A2", ….
// The gateway only reads that file (UPSTREAMS_FILE) plus the pool user's own call logs, whose `channel` field
// says which channel served each call. It needs no admin rights in new-api.
//
// Routing mirrors new-api's GetRandomSatisfiedChannel: of the enabled channels that serve a model for the
// group, the highest priority wins; inside that tier a channel is picked at random by weight (all weights 0 →
// equal chances). A failed call is retried on the next lower tier.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { aliasesOf, type KeyShop } from './keyshop.ts';

/** One channel row as the export script reads it from new-api's DB (host only for grouping, never stored). */
export interface RawChannel {
  id: number;
  status: number; // 1 = enabled, 2 = disabled by hand, 3 = disabled by auto-ban
  host: string; // base_url host[:port]
  priority: number;
  weight: number;
  latencyMs: number | null; // new-api's last channel test
}

export interface RawAbility {
  group: string;
  model: string;
  channel: number;
  enabled: boolean | number;
}

export interface UpstreamNode {
  name: string; // "A1"
  provider: string; // "A"
  channel: number; // new-api channel id: only inside the gateway, stripped from the public view
  active: boolean;
  latencyMs?: number;
  families: string[]; // "Claude", "GPT", …
  models: string[];
}

/** One candidate inside a routing tier. `share` = chance of being picked when this tier is tried. */
export interface Route {
  node: string;
  share: number;
}

export interface UpstreamSnapshot {
  generatedAt: number; // ms
  group: string;
  providers: Array<{ name: string; nodes: UpstreamNode[] }>;
  routes: Record<string, Route[][]>; // model → tiers, first = primary, then failovers (active nodes only)
}

/** Provider = registrable domain ("api.x.com" and "img.x.com" are one company); an IP stays itself. */
export function providerKey(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(h) || !h.includes('.')) return h;
  return h.split('.').slice(-2).join('.');
}

/** Model family for the page's labels. */
export function family(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'Claude';
  if (m.includes('image')) return 'Images';
  if (m.includes('seedance') || m.startsWith('doubao')) return 'Video';
  if (m.startsWith('gpt') || m.startsWith('codex') || /^o\d/.test(m)) return 'GPT';
  if (m.startsWith('deepseek')) return 'DeepSeek';
  if (m.startsWith('glm')) return 'GLM';
  if (m.startsWith('kimi')) return 'Kimi';
  if (m.startsWith('grok')) return 'Grok';
  return 'Other';
}

/** "A".."Z", then "AA", "AB", … */
function letters(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : letters(Math.floor(i / 26) - 1) + letters(i % 26);
}

/**
 * The anonymized snapshot for one user group. Only channels with at least one ability in that group appear.
 * Names follow the lowest channel id, so they stay put while the channel list doesn't change.
 */
export function anonymize(channels: RawChannel[], abilities: RawAbility[], group: string, now = Date.now()): UpstreamSnapshot {
  const mine = abilities.filter((a) => a.group === group);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const used = [...new Set(mine.map((a) => a.channel))].filter((id) => byId.has(id)).sort((a, b) => a - b);

  // providers in order of their first channel id
  const provOf = new Map<string, string>();
  const providers: UpstreamSnapshot['providers'] = [];
  const nodeOf = new Map<number, UpstreamNode>();
  for (const id of used) {
    const c = byId.get(id)!;
    const key = providerKey(c.host);
    if (!provOf.has(key)) {
      provOf.set(key, letters(provOf.size));
      providers.push({ name: provOf.get(key)!, nodes: [] });
    }
    const p = providers.find((x) => x.name === provOf.get(key))!;
    const models = [...new Set(mine.filter((a) => a.channel === id).map((a) => a.model))].sort();
    const node: UpstreamNode = {
      name: p.name + (p.nodes.length + 1),
      provider: p.name,
      channel: id,
      active: c.status === 1,
      latencyMs: c.latencyMs && c.latencyMs > 0 ? c.latencyMs : undefined,
      families: [...new Set(models.map(family))].sort(),
      models,
    };
    p.nodes.push(node);
    nodeOf.set(id, node);
  }

  // routing: per model, enabled abilities of enabled channels, grouped into priority tiers (high → low)
  const routes: UpstreamSnapshot['routes'] = {};
  for (const model of [...new Set(mine.map((a) => a.model))].sort()) {
    const cands = mine
      .filter((a) => a.model === model && Boolean(a.enabled) && nodeOf.get(a.channel)?.active)
      .map((a) => byId.get(a.channel)!);
    if (!cands.length) continue;
    const prios = [...new Set(cands.map((c) => c.priority))].sort((a, b) => b - a);
    routes[model] = prios.map((p) => {
      const tier = cands.filter((c) => c.priority === p);
      const sum = tier.reduce((s, c) => s + c.weight, 0);
      return tier.map((c) => ({ node: nodeOf.get(c.id)!.name, share: sum ? c.weight / sum : 1 / tier.length }));
    });
  }
  return { generatedAt: now, group, providers, routes };
}

// ------------------------------------------------------------------ gateway side

export interface RecentCall {
  id: string; // short hash of new-api's request id (for de-duplication on the page)
  time: number; // unix seconds
  model: string;
  node?: string;
}

/** Serves the snapshot (re-read when the file changes) plus the latest real calls, mapped to node names. */
export class Network {
  file: string;
  shop?: KeyShop;
  private cached?: { mtimeMs: number; snap: UpstreamSnapshot; nodeOfChannel: Map<number, string>; aliases: Map<string, string> };
  private recentCache?: { at: number; calls: Promise<RecentCall[]> };

  constructor(file: string, shop?: KeyShop) {
    this.file = file;
    this.shop = shop;
  }

  static fromEnv(shop?: KeyShop): Network | undefined {
    return process.env.UPSTREAMS_FILE ? new Network(process.env.UPSTREAMS_FILE, shop) : undefined;
  }

  private load() {
    const { mtimeMs } = fs.statSync(this.file);
    if (this.cached?.mtimeMs !== mtimeMs) {
      const snap = JSON.parse(fs.readFileSync(this.file, 'utf8')) as UpstreamSnapshot;
      const nodeOfChannel = new Map(snap.providers.flatMap((p) => p.nodes.map((n) => [n.channel, n.name] as [number, string])));
      // MODEL_ALIAS_SUFFIX (see keyshop.ts): names from the routes and from every node, switched-off ones too
      const aliases = aliasesOf([...new Set([...Object.keys(snap.routes), ...snap.providers.flatMap((p) => p.nodes.flatMap((n) => n.models))])]);
      this.cached = { mtimeMs, snap, nodeOfChannel, aliases };
    }
    return this.cached;
  }

  /**
   * Latest calls of all sold keys: only time, model and node (no key, tokens, cost or IP). Cached 5s and
   * shared between visitors, so an open /network page never adds more than one new-api query per 5s.
   */
  private recent(): Promise<RecentCall[]> {
    if (!this.shop) return Promise.resolve([]);
    const now = Date.now();
    if (!this.recentCache || now - this.recentCache.at > 5_000) {
      const { nodeOfChannel, aliases } = this.load();
      const calls = this.shop.recentCalls(30).then((cs) =>
        cs.map((c) => ({
          id: crypto.createHash('sha256').update(c.requestId).digest('hex').slice(0, 10),
          time: c.time,
          model: aliases.get(c.model) ?? c.model,
          node: nodeOfChannel.get(c.channel),
        })),
      );
      calls.catch(() => (this.recentCache = undefined)); // retry on the next request, not in 5s
      this.recentCache = { at: now, calls };
    }
    return this.recentCache.calls;
  }

  /** What /api/network returns. */
  async view() {
    const { snap, aliases } = this.load();
    let recent: RecentCall[] = [];
    let live = !!this.shop;
    try {
      recent = await this.recent();
    } catch {
      live = false;
    }
    return {
      generatedAt: snap.generatedAt,
      providers: snap.providers.map((p) => ({
        name: p.name,
        nodes: p.nodes.map(({ channel, ...n }) => ({ ...n, models: [...new Set(n.models.map((m) => aliases.get(m) ?? m))] })),
      })),
      routes: Object.fromEntries(Object.entries(snap.routes).filter(([m]) => !aliases.has(m))),
      live,
      recent,
    };
  }
}
