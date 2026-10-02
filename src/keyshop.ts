// Key shop: pay in bitcoin, get an AI API key. No signup, no login, no email — the key is the account.
//
// A paid key order becomes a new-api token whose own quota is exactly what was paid ($1 → $1 of quota).
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
import type { Order } from './ledger.ts';

export interface ApiKey {
  key: string; // sk-…
  baseUrl: string; // https://…/v1
  tokenId: number;
}

export interface KeyUsage {
  usedUsd: number;
  remainingUsd: number;
  calls: Array<{ time: number; model: string; promptTokens: number; completionTokens: number; costUsd: number; seconds: number }>;
  totalCalls: number;
}

export interface ModelPrice {
  model: string;
  vendor: string;
  input?: number; // $ per 1M input tokens
  output?: number; // $ per 1M output tokens
  cacheRead?: number; // $ per 1M cached input tokens
  perCall?: number; // $ per call (image models)
  fastTier: boolean; // service_tier fast/priority costs more
  endpoints: string[]; // 'openai' | 'anthropic'
}

// new-api's vendor names are the operator's labels (some in Chinese); the page is English
const VENDOR_NAMES: Record<string, string> = { 智谱: 'Zhipu GLM', 字节跳动: 'ByteDance' };

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

  /** new-api's public settings: quota units per $1 and its public address. */
  private async status(): Promise<{ quotaPerUnit: number; serverAddress: string }> {
    const d = await this.api('GET', '/api/status');
    return { quotaPerUnit: Number(d.quota_per_unit), serverAddress: String(d.server_address ?? '') };
  }

  private async findToken(name: string): Promise<number | undefined> {
    const d = await this.api('GET', `/api/token/search?keyword=${encodeURIComponent(name)}`);
    const items: Array<{ id: number; name: string }> = Array.isArray(d) ? d : (d?.items ?? []);
    return items.find((t) => t.name === name)?.id;
  }

  /**
   * Models a sold key can call, with prices in USD per 1M tokens (per call for image models). new-api's
   * public /api/pricing gives a billing expression like `tier("base", p * 3.9 + c * 19.5 + cr * 0.39 + …)`
   * whose coefficients are $/1M tokens; we read the base tier (fast/priority tiers cost more, noted on the page).
   */
  async models(): Promise<ModelPrice[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.at < 5 * 60_000) return this.modelsCache.list;
    const r = await fetch(this.url + '/api/pricing', { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data: any[]; vendors?: Array<{ id: number; name: string }>; group_ratio?: Record<string, number> };
    const self = await this.api('GET', '/api/user/self');
    const group = String(self?.group || 'default');
    const ratio = Number(j.group_ratio?.[group] ?? 1);
    const vendors = new Map((j.vendors ?? []).map((v) => [v.id, VENDOR_NAMES[v.name] ?? v.name]));
    const coef = (expr: string, v: string) => {
      const m = expr.match(new RegExp(`\\b${v} \\* ([0-9.]+)`));
      return m ? Number(m[1]) * ratio : undefined;
    };
    const list: ModelPrice[] = j.data
      .filter((m) => (m.enable_groups ?? []).includes(group))
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

  /** What a sold key has spent: balance in USD + its latest calls (only fields safe to show the key holder). */
  async usage(o: Order): Promise<KeyUsage> {
    const id = o.apiKey!.tokenId;
    const { quotaPerUnit } = await this.status();
    const usd = (q: number) => Number(q) / quotaPerUnit;
    const t = await this.api('GET', `/api/token/${id}`);
    // type=2: consume logs. new-api filters by token name; we re-check the id in case two names ever collide
    const d = await this.api('GET', `/api/log/self?p=1&page_size=20&type=2&token_name=${encodeURIComponent(`btc-${o.id}`)}`);
    const items: any[] = (Array.isArray(d) ? d : (d?.items ?? [])).filter((l: any) => l.token_id === id);
    return {
      usedUsd: usd(t.used_quota),
      remainingUsd: usd(t.remain_quota),
      calls: items.map((l) => ({
        time: Number(l.created_at),
        model: String(l.model_name),
        promptTokens: Number(l.prompt_tokens),
        completionTokens: Number(l.completion_tokens),
        costUsd: usd(l.quota),
        seconds: Number(l.use_time),
      })),
      totalCalls: Number(d?.total ?? items.length),
    };
  }

  /** Create (or find again) the key for a paid order. `money` is USD — new-api's quota is priced in USD. */
  async createKey(o: Order): Promise<ApiKey> {
    const name = `btc-${o.id}`;
    const { quotaPerUnit, serverAddress } = await this.status();
    let id = await this.findToken(name);
    if (id === undefined) {
      await this.api('POST', '/api/token/', {
        name,
        remain_quota: Math.round(Number(o.money) * quotaPerUnit),
        unlimited_quota: false,
        expired_time: -1,
      });
      id = await this.findToken(name);
      if (id === undefined) throw new Error('new-api: token created but not found');
    }
    const { key } = await this.api('POST', `/api/token/${id}/key`);
    const base = this.baseUrlEnv || (serverAddress ? serverAddress.replace(/\/$/, '') + '/v1' : this.url + '/v1');
    return { key: 'sk-' + String(key).replace(/^sk-/, ''), baseUrl: base, tokenId: id };
  }
}
