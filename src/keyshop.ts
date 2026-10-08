// Key shop: pay in bitcoin, get an AI API key. No signup, no login, no email — the key is the account.
//
// A paid key order becomes a new-api token whose own quota is exactly what was paid (€1 → €1 of quota).
// new-api counts quota in "units" (QuotaPerUnit quota each) and sells a unit for `Price` in the payment currency
// (the gateway's FIAT); the key shop uses that same Price, so a key costs what a console top-up of it would.
// All keys belong to one pool user in new-api; the gateway holds only that user's personal access token,
// so the worst it can do is make keys for that pool (whose total quota the operator sets).
//
//   NEWAPI_URL      new-api base, as the gateway reaches it (demo compose: http://new-api:3000)
//   NEWAPI_USER_ID  the pool user's id
//   NEWAPI_TOKEN    that user's personal access token (new-api → 个人设置 → 系统访问令牌)
//   KEY_BASE_URL    endpoint shown with the key (default: new-api's ServerAddress + /v1)
//
// Exactly once: the token's name is derived from the order id. Before creating, we look it up by name, so
// a crash between "created in new-api" and "saved in our ledger" finds the same token instead of making two.
// Top-ups (topUp) add quota to a sold key; exactly once via the token's remain + used total, see ledger.ts Topup.
// Every sold key spends the pool user's quota too, so pool() tells how much is left to sell.
import { decideTopup, type Order } from './ledger.ts';

export interface ApiKey {
  key: string; // sk-…
  baseUrl: string; // https://…/v1
  tokenId: number;
}

// Money amounts are in the payment currency (the gateway's FIAT), converted with new-api's Price.
export interface KeyUsage {
  used: number;
  remaining: number;
  calls: Array<{ time: number; model: string; promptTokens: number; completionTokens: number; cost: number; seconds: number }>;
  totalCalls: number;
}

/** The pool in FIAT: the pool user's quota, what sold keys still hold (owed), and the difference left to sell. */
export interface Pool {
  quota: number;
  owed: number;
  available: number;
}

export interface ModelPrice {
  model: string;
  vendor: string;
  input?: number; // fiat per 1M input tokens
  output?: number; // fiat per 1M output tokens
  cacheRead?: number; // fiat per 1M cached input tokens
  perCall?: number; // fiat per call (image models)
  fastTier: boolean; // service_tier fast/priority costs more
  endpoints: string[]; // 'openai' | 'anthropic'
}

// new-api's vendor names are the operator's labels (some in Chinese); the page is English
const VENDOR_NAMES: Record<string, string> = { 智谱: 'Zhipu GLM', 字节跳动: 'ByteDance' };

// MODEL_ALIAS_SUFFIX: regex of name suffixes the operator gives extra routes of one model (e.g. `-a$|-b$`). Such
// aliases still work with a key, but the public lists (/api/models, /network) leave them out and show their calls
// under the base name: they look like duplicates, and a suffix can name an upstream. Kept in env, not in the code.
const ALIAS_SUFFIX = process.env.MODEL_ALIAS_SUFFIX ? new RegExp(process.env.MODEL_ALIAS_SUFFIX) : undefined;

/** alias → base name, for every name matching `suffix` whose base name is in the list too (else it isn't hidden). */
export function aliasesOf(names: string[], suffix = ALIAS_SUFFIX): Map<string, string> {
  const all = new Set(names);
  const out = new Map<string, string>();
  if (!suffix) return out;
  for (const n of names) {
    const base = n.replace(suffix, '');
    if (base !== n && all.has(base)) out.set(n, base);
  }
  return out;
}

export class KeyShop {
  url: string;
  headers: Record<string, string>;
  baseUrlEnv?: string;

  constructor(url: string, userId: string, token: string, baseUrl?: string) {
    this.url = url.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', authorization: token, 'new-api-user': userId };
    this.baseUrlEnv = baseUrl;
  }

  /** From env, or undefined when the key shop isn't configured. */
  static fromEnv(): KeyShop | undefined {
    const { NEWAPI_URL, NEWAPI_USER_ID, NEWAPI_TOKEN, KEY_BASE_URL } = process.env;
    if (!NEWAPI_URL || !NEWAPI_USER_ID || !NEWAPI_TOKEN) return undefined;
    return new KeyShop(NEWAPI_URL, NEWAPI_USER_ID, NEWAPI_TOKEN, KEY_BASE_URL);
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.url + path, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; message?: string; data?: any };
    if (!r.ok || j.success === false) throw new Error(`new-api ${path}: ${j.message || `HTTP ${r.status}`}`);
    return j.data;
  }

  /** new-api's public settings: quota per unit, price of a unit (in FIAT, new-api's Price) and its public address. */
  private async status(): Promise<{ quotaPerUnit: number; price: number; serverAddress: string }> {
    const d = await this.api('GET', '/api/status');
    const quotaPerUnit = Number(d.quota_per_unit);
    const price = Number(d.price);
    if (!(quotaPerUnit > 0 && price > 0)) throw new Error(`new-api status: bad quota_per_unit/price (${d.quota_per_unit}/${d.price})`);
    return { quotaPerUnit, price, serverAddress: String(d.server_address ?? '') };
  }

  private async findToken(name: string): Promise<number | undefined> {
    const d = await this.api('GET', `/api/token/search?keyword=${encodeURIComponent(name)}`);
    const items: Array<{ id: number; name: string }> = Array.isArray(d) ? d : (d?.items ?? []);
    return items.find((t) => t.name === name)?.id;
  }

  /** A token as new-api stores it (all fields: a PUT must send them all back), or undefined if it was deleted. */
  private async token(id: number): Promise<any | undefined> {
    try {
      return await this.api('GET', `/api/token/${id}`);
    } catch (e) {
      if (/record not found/.test((e as Error).message)) return undefined;
      throw e;
    }
  }

  /** A sold key's balance in FIAT, or undefined if its token was deleted (auto top-up reads this). */
  async remaining(tokenId: number): Promise<number | undefined> {
    const t = await this.token(tokenId);
    if (!t) return undefined;
    const { quotaPerUnit, price } = await this.status();
    return (Number(t.remain_quota) / quotaPerUnit) * price;
  }

  /**
   * Add a paid top-up to its key, exactly once. Safe to call again after any crash or error: `o.topup.base/add` are
   * saved (write-ahead) before new-api is changed, and only what is still missing of `base + add` gets added.
   * Returns the key's balance in FIAT after, or undefined if the token no longer exists (needs a refund).
   * The caller runs top-ups of one key one after another (topupBlocked).
   *
   * new-api facts this relies on (checked against the image we run, rc.22):
   *   - PUT /api/token/ writes every editable field from the body (a partial body clears name, group, expiry …),
   *     so we send back the whole GET object with only remain_quota changed;
   *   - a token whose quota ran out has status 4 (exhausted). A PUT with status 1 is refused while it's 4, so the
   *     PUT keeps the status it read, and `?status_only=true` turns it back on once it has quota again;
   *   - PUT sets remain_quota absolutely: a call charged between our GET and PUT is overwritten (a gift of cents).
   */
  async topUp(o: Order, save: () => void): Promise<{ remaining: number } | undefined> {
    const tp = o.topup!;
    const { quotaPerUnit, price } = await this.status();
    let t = await this.token(tp.tokenId);
    if (!t) return undefined;
    const total = (t: any) => Number(t.remain_quota) + Number(t.used_quota);
    if (tp.base === undefined || tp.add === undefined) {
      tp.base = total(t);
      tp.add = Math.round((Number(o.money) / price) * quotaPerUnit);
      save(); // write-ahead: from here on a retry knows what the total was before this top-up
    }
    const missing = decideTopup(total(t), tp.base, tp.add);
    if (missing > 0) await this.api('PUT', '/api/token/', { ...t, remain_quota: Number(t.remain_quota) + missing });
    t = await this.token(tp.tokenId);
    if (!t) return undefined;
    if (t.status === 4 && t.remain_quota > 0) {
      await this.api('PUT', '/api/token/?status_only=true', { id: tp.tokenId, status: 1 });
      t = await this.token(tp.tokenId);
      if (!t) return undefined;
    }
    // a refund of an in-flight call can land between GET and PUT and undo part of it: then retry adds the rest
    if (total(t) < tp.base + tp.add) throw new Error(`top-up not complete yet (${tp.base + tp.add - total(t)} quota missing)`);
    if (t.status === 4) throw new Error('key still marked exhausted');
    this.poolCache = undefined;
    return { remaining: (Number(t.remain_quota) / quotaPerUnit) * price };
  }

  /**
   * What the pool can still sell (FIAT, cached 30s): the pool user's quota minus what its limited, usable tokens
   * still hold. Every call charges both the token and the user, so this doesn't move when keys are used; it drops
   * when a key is sold or topped up. Selling past it would leave sold keys failing once the user's quota is gone.
   */
  async pool(): Promise<Pool> {
    if (this.poolCache && Date.now() - this.poolCache.at < 30_000) return this.poolCache.pool;
    const { quotaPerUnit, price } = await this.status();
    const self = await this.api('GET', '/api/user/self');
    let owed = 0;
    for (let p = 1, seen = 0; ; p++) {
      const d = await this.api('GET', `/api/token/?p=${p}&page_size=100`);
      const items: any[] = Array.isArray(d) ? d : (d?.items ?? []);
      // status 1 enabled, 4 exhausted (≈0 left; a top-up turns it back on); 2 disabled and 3 expired can't spend
      for (const t of items) if (!t.unlimited_quota && (t.status === 1 || t.status === 4)) owed += Math.max(0, Number(t.remain_quota));
      seen += items.length;
      if (items.length === 0 || seen >= Number(d?.total ?? 0) || p >= 100) break;
    }
    const money = (q: number) => (q / quotaPerUnit) * price;
    const pool = { quota: money(Number(self.quota)), owed: money(owed), available: money(Number(self.quota) - owed) };
    this.poolCache = { at: Date.now(), pool };
    return pool;
  }
  poolCache?: { at: number; pool: Pool };

  /**
   * Models a sold key can call, with prices in FIAT per 1M tokens (per call for image models). new-api's
   * public /api/pricing gives a billing expression like `tier("base", p * 3.9 + c * 19.5 + cr * 0.39 + …)`
   * whose coefficients are units per 1M tokens; we read the base tier (fast/priority tiers cost more, noted on
   * the page) and convert units with new-api's Price.
   */
  async models(): Promise<ModelPrice[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.at < 5 * 60_000) return this.modelsCache.list;
    const r = await fetch(this.url + '/api/pricing', { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data: any[]; vendors?: Array<{ id: number; name: string }>; group_ratio?: Record<string, number> };
    const self = await this.api('GET', '/api/user/self');
    const group = String(self?.group || 'default');
    const { price } = await this.status();
    const ratio = Number(j.group_ratio?.[group] ?? 1) * price; // units → fiat, with the pool group's ratio
    const vendors = new Map((j.vendors ?? []).map((v) => [v.id, VENDOR_NAMES[v.name] ?? v.name]));
    const coef = (expr: string, v: string) => {
      const m = expr.match(new RegExp(`\\b${v} \\* ([0-9.]+)`));
      return m ? Number(m[1]) * ratio : undefined;
    };
    const inGroup = j.data.filter((m) => (m.enable_groups ?? []).includes(group));
    const aliases = aliasesOf(inGroup.map((m) => String(m.model_name)));
    const list: ModelPrice[] = inGroup
      .filter((m) => !aliases.has(String(m.model_name)))
      .map((m) => {
        const expr = String(m.billing_expr ?? '');
        const base = expr.slice(Math.max(0, expr.indexOf('tier("base"'))); // skip the fast tier of a ternary
        const perCall = m.quota_type === 1 ? Number(m.model_price) * ratio : undefined;
        return {
          model: String(m.model_name),
          vendor: vendors.get(m.vendor_id) ?? 'Other',
          input: perCall ? undefined : (coef(base, 'p') ?? Number(m.model_ratio) * 2 * ratio),
          output: perCall ? undefined : (coef(base, 'c') ?? Number(m.model_ratio) * 2 * Number(m.completion_ratio) * ratio),
          cacheRead: perCall ? undefined : coef(base, 'cr'),
          perCall,
          fastTier: expr.includes('"fast"'),
          endpoints: (m.supported_endpoint_types ?? []) as string[],
        };
      })
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || (a.input ?? 0) - (b.input ?? 0) || a.model.localeCompare(b.model));
    this.modelsCache = { at: now, list };
    return list;
  }
  private modelsCache?: { at: number; list: ModelPrice[] };

  /** What a sold key has spent: balance in FIAT + its latest calls (only fields safe to show the key holder). */
  async usage(o: Order): Promise<KeyUsage> {
    const id = o.apiKey!.tokenId;
    const { quotaPerUnit, price } = await this.status();
    const money = (q: number) => (Number(q) / quotaPerUnit) * price;
    const t = await this.api('GET', `/api/token/${id}`);
    // type=2: consume logs. new-api filters by token name; we re-check the id in case two names ever collide
    const d = await this.api('GET', `/api/log/self?p=1&page_size=20&type=2&token_name=${encodeURIComponent(`btc-${o.id}`)}`);
    const items: any[] = (Array.isArray(d) ? d : (d?.items ?? [])).filter((l: any) => l.token_id === id);
    return {
      used: money(t.used_quota),
      remaining: money(t.remain_quota),
      calls: items.map((l) => ({
        time: Number(l.created_at),
        model: String(l.model_name),
        promptTokens: Number(l.prompt_tokens),
        completionTokens: Number(l.completion_tokens),
        cost: money(l.quota),
        seconds: Number(l.use_time),
      })),
      totalCalls: Number(d?.total ?? items.length),
    };
  }

  /**
   * Latest calls of every key in the pool, for the /network page: which channel served which model when.
   * new-api's user log keeps the channel id (it only blanks the channel name); nothing else leaves here.
   */
  async recentCalls(n: number): Promise<Array<{ requestId: string; time: number; model: string; channel: number }>> {
    const d = await this.api('GET', `/api/log/self?p=1&page_size=${n}&type=2`);
    const items: any[] = Array.isArray(d) ? d : (d?.items ?? []);
    return items.map((l) => ({
      requestId: String(l.request_id || `${l.id}-${l.created_at}`),
      time: Number(l.created_at),
      model: String(l.model_name),
      channel: Number(l.channel),
    }));
  }

  /** Create (or find again) the key for a paid order. `money` is in FIAT; it buys money / Price units. */
  async createKey(o: Order): Promise<ApiKey> {
    const name = `btc-${o.id}`;
    const { quotaPerUnit, price, serverAddress } = await this.status();
    let id = await this.findToken(name);
    if (id === undefined) {
      await this.api('POST', '/api/token/', {
        name,
        remain_quota: Math.round((Number(o.money) / price) * quotaPerUnit),
        unlimited_quota: false,
        expired_time: -1,
      });
      id = await this.findToken(name);
      if (id === undefined) throw new Error('new-api: token created but not found');
    }
    this.poolCache = undefined;
    const { key } = await this.api('POST', `/api/token/${id}/key`);
    const base = this.baseUrlEnv || (serverAddress ? serverAddress.replace(/\/$/, '') + '/v1' : this.url + '/v1');
    return { key: 'sk-' + String(key).replace(/^sk-/, ''), baseUrl: base, tokenId: id };
  }
}
