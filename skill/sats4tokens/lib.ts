// The skill's engine: classify new-api errors, enforce spending caps, top up a key exactly once.
// No dependencies (Node ≥ 22.18). The CLI is s4t.ts; tests plug in a fake shop, wallet and clock.
//
// Exactly once, client side: the order id is saved before anything is paid, an invoice goes to the wallet at most
// once, a Cashu token is saved before it is sent (and only ever re-sent to the same order, which the shop answers
// idempotently). A run that dies anywhere resumes the open order instead of making a new one.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Config {
  shop: string; // https://… of the key shop
  key: string; // sk-… the key to top up (bearer)
  baseUrl?: string; // new-api root the key runs on (no /v1), for `balance`
  pay: 'lightning' | 'cashu';
  wallet: Wallet;
  maxPerTopup: number; // FIAT
  maxPerDay: number; // FIAT, any 24 hours, paid or maybe paid
  minIntervalMin: number; // no new top-up this soon after the last one (one per conversation, roughly)
  stateFile: string;
  pollMs: number;
  waitMin: number; // give up waiting for the credit after this long (the order stays open; next run resumes it)
}

// A top-up attempt as the local ledger keeps it. `id` is a capability: never print it except as the /pay/ link.
export interface Attempt {
  id: string;
  money: number;
  createdAt: number;
  sentAt?: number; // invoice handed to the wallet / token sent (write-ahead: set before the call)
  outcome?: 'sent' | 'failed' | 'manual';
  token?: string; // Cashu token made for this order (bearer until the shop swaps it)
  final?: 'applied' | 'expired' | 'refund' | 'declined';
  remaining?: number;
  error?: string;
}
export interface State {
  attempts: Attempt[];
}

export type WalletResult = { ok: true; out: string } | { ok: false; error: string };
export interface Wallet {
  name: string;
  payInvoice?(bolt11: string): Promise<WalletResult>;
  sendToken?(sats: number): Promise<WalletResult>; // ok.out holds the token
  receive?(token: string): Promise<WalletResult>;
}

/** What a failed API call means for the skill. */
export type Verdict = 'topup' | 'check-balance' | 'pool-empty' | 'not-ours';
export function classifyError(status: number, body: unknown): Verdict {
  const e: any = (body as any)?.error ?? body;
  const code = String(e?.code ?? e?.type ?? '');
  const msg = String(e?.message ?? (typeof body === 'string' ? body : ''));
  if (code === 'insufficient_user_quota' || /insufficient user quota|用户额度不足/i.test(msg)) return 'pool-empty';
  if (code === 'pre_consume_token_quota_failed' || /token quota is not enough|令牌额度不足/i.test(msg)) return 'check-balance';
  // new-api answers a used-up key exactly like a wrong one ("Invalid token"); the shop tells them apart
  if (status === 401) return 'topup';
  return 'not-ours';
}

const DAY = 24 * 3600_000;
const open = (a: Attempt) => !a.final;
const maybePaid = (a: Attempt) => a.final === 'applied' || a.final === 'refund' || (!a.final && !!a.sentAt);

export function spent24h(s: State, now: number): number {
  return s.attempts.filter((a) => a.createdAt > now - DAY && maybePaid(a)).reduce((t, a) => t + a.money, 0);
}

/** Why this top-up may not be paid by the agent, or null. */
export function capProblem(s: State, money: number, c: Config, now: number): string | null {
  if (money > c.maxPerTopup) return `€${money} is over the per-top-up limit (€${c.maxPerTopup})`;
  const day = spent24h(s, now);
  if (day + money > c.maxPerDay) return `€${day} spent in the last 24 h, €${money} more is over the daily limit (€${c.maxPerDay})`;
  const last = s.attempts.filter((a) => a.final === 'applied').at(-1);
  if (last && now - last.createdAt < c.minIntervalMin * 60_000)
    return `already topped up ${Math.round((now - last.createdAt) / 60_000)} min ago; ask a human before paying again`;
  return null;
}

export function loadState(file: string): State {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(s?.attempts) ? s : { attempts: [] };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { attempts: [] };
    throw new Error(`can't read ${file}: ${e.message} (fix or move it; it may hold an unpaid order or a token)`);
  }
}
export function saveState(file: string, s: State) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

export class Stop extends Error {} // ends the run: the message is for a human, nothing more will happen on its own

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}
export const realDeps: Deps = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.error(m),
};

async function call(d: Deps, url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await d.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      return { status: r.status, body };
    } catch (e) {
      last = e; // network error: the request may not have arrived; every call here is safe to repeat
      await d.sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${url}: ${(last as Error)?.message ?? last}`);
}
function shopApi(c: Config, d: Deps) {
  return async (path: string, body?: unknown) => {
    const r = await call(d, c.shop + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r;
  };
}

/** The key's balance in FIAT, straight from new-api with the key itself. null = the key is used up or unknown. */
export async function balance(c: Config, d: Deps): Promise<{ remaining: number; used: number; fiat: string } | null> {
  if (!c.baseUrl) throw new Stop('set S4T_BASE_URL (or ANTHROPIC_BASE_URL) to the API root the key runs on');
  const auth = { headers: { authorization: `Bearer ${c.key}` } };
  const [sub, use, st, shop] = await Promise.all([
    call(d, c.baseUrl + '/v1/dashboard/billing/subscription', auth),
    call(d, c.baseUrl + '/v1/dashboard/billing/usage', auth),
    call(d, c.baseUrl + '/api/status'),
    call(d, c.shop + '/api/shop'),
  ]);
  if (sub.status === 401 || use.status === 401) return null;
  if (sub.status !== 200 || use.status !== 200 || sub.body?.error || use.body?.error)
    throw new Error(`balance: new-api answered ${sub.status}/${use.status}`);
  const price = Number(st.body?.data?.price ?? st.body?.price);
  if (!(price > 0)) throw new Error('balance: no price in new-api /api/status');
  const totalUnits = Number(sub.body.hard_limit_usd);
  const usedUnits = Number(use.body.total_usage) / 100;
  const r = (x: number) => Math.round(x * 10_000) / 10_000;
  return { remaining: r((totalUnits - usedUnits) * price), used: r(usedUnits * price), fiat: String(shop.body?.fiat ?? '') };
}

/**
 * Top the key up by `money` (FIAT), or finish the open top-up first. Returns the key's balance afterwards.
 * Throws Stop when a human has to act (cap, sold out, unknown key, wallet refused, credit not seen in time).
 */
export async function topup(c: Config, money: number, d: Deps): Promise<{ added: number; remaining: number }> {
  const api = shopApi(c, d);
  const s = loadState(c.stateFile);
  const save = () => saveState(c.stateFile, s);
  const link = (a: Attempt) => `${c.shop}/pay/${a.id}`;

  let a = s.attempts.find(open);
  if (a) {
    d.log(`resuming the unfinished €${a.money} top-up (${a.outcome ?? 'not paid yet'})`);
  } else {
    const shop = (await api('/api/shop')).body;
    if (!shop?.enabled) throw new Stop(`${c.shop} has no key shop`);
    if (!shop.amounts?.map(Number).includes(money))
      throw new Stop(shop.soldOut ? 'the shop is sold out right now' : `€${money} can't be bought (amounts: ${shop.amounts?.join(', ')})`);
    const cap = capProblem(s, money, c, d.now());
    const r = await api('/api/buy', { money: String(money), key: c.key });
    if (r.status === 404) throw new Stop('this key was not sold by this shop (unknown key): it is not a used-up key, it is wrong');
    if (r.status === 503) throw new Stop('the shop is sold out right now');
    if (r.status !== 200 || !r.body?.id) throw new Error(`/api/buy: ${r.body?.error ?? r.status}`);
    a = { id: r.body.id, money, createdAt: d.now() };
    if (cap) {
      // made, never paid by us: a human can pay it on the page. Not counted against the agent's caps.
      a.final = 'declined';
      a.error = 'needs a human: ' + cap;
      s.attempts.push(a);
      save();
      throw new Stop(`${cap}. A human can pay this top-up here: ${link(a)}`);
    }
    s.attempts.push(a);
    save(); // the order exists on disk before any money moves
  }

  let o = (await api(`/api/order/${a.id}`)).body;
  // a token is re-sent to the same order until the shop answers (it answers a repeat with the same order)
  if (o?.state === 'PENDING' && (!a.sentAt || (a.token && a.outcome !== 'sent'))) await pay(c, a, o, api, save, d, link);

  const until = d.now() + c.waitMin * 60_000;
  for (;;) {
    if (o?.topup?.needsRefund) {
      a.final = 'refund';
      save();
      throw new Stop(`paid, but the key no longer exists. Keep ${link(a)} and ask the shop for a refund`);
    }
    if (o?.topup?.applied) {
      a.final = 'applied';
      a.remaining = o.topup.applied.remaining;
      save();
      return { added: a.money, remaining: a.remaining! };
    }
    if (o?.state === 'EXPIRED') {
      a.final = 'expired'; // the mint never saw a payment: nothing was spent
      if (a.token && c.wallet.receive && (await c.wallet.receive(a.token)).ok) a.token = undefined;
      save();
      throw new Stop(`the top-up expired unpaid (${a.outcome === 'failed' ? 'the wallet failed: ' + a.error : 'no payment arrived'}); nothing was spent`);
    }
    if (o?.keyError) d.log(`paid; the shop is still adding the credit (${o.keyError})`);
    if (d.now() > until)
      throw new Stop(`no credit yet after ${c.waitMin} min. Nothing will be paid again; run again later to check, or open ${link(a)}`);
    await d.sleep(c.pollMs);
    o = (await api(`/api/order/${a.id}`)).body;
  }
}

async function pay(c: Config, a: Attempt, o: any, api: ReturnType<typeof shopApi>, save: () => void, d: Deps, link: (a: Attempt) => string) {
  if (c.pay === 'cashu') {
    if (!a.token) {
      if (!c.wallet.sendToken) throw new Stop(`wallet ${c.wallet.name} can't make tokens; pay ${link(a)}`);
      const t = await c.wallet.sendToken(o.sats);
      const token = t.ok ? t.out.match(/cashu[AB][A-Za-z0-9_\-+/=]+/)?.[0] : undefined;
      if (!token) throw new Stop(`the wallet made no token (${t.ok ? 'no cashuA/B in its output' : t.error}); nothing was sent`);
      a.token = token;
      save(); // bearer ecash: on disk before it leaves
    }
    a.sentAt = d.now();
    save();
    const r = await api(`/api/order/${a.id}/token`, { token: a.token });
    if (r.status !== 200) {
      a.final = 'declined';
      a.error = String(r.body?.error ?? r.status);
      const back = c.wallet.receive && (await c.wallet.receive(a.token));
      if (back?.ok) a.token = undefined; // back in the wallet
      save();
      throw new Stop(`the shop refused the token: ${a.error}${a.token ? ' (the token is kept in the state file, unspent)' : ' (taken back into the wallet)'}`);
    }
    a.outcome = 'sent';
    save();
    return;
  }
  const inv = (await api(`/api/order/${a.id}/invoice`, {})).body;
  if (!inv?.invoice) throw new Error(`no invoice for the order (${inv?.error ?? inv?.state})`);
  if (!c.wallet.payInvoice) {
    a.sentAt = d.now();
    a.outcome = 'manual';
    save();
    d.log(`pay this Lightning invoice (${inv.sats} sat), or open ${link(a)}:\n${inv.invoice}`);
    return;
  }
  a.sentAt = d.now();
  save(); // from here on this invoice is never handed to the wallet again
  const r = await c.wallet.payInvoice(inv.invoice);
  a.outcome = r.ok ? 'sent' : 'failed';
  if (!r.ok) a.error = r.error.slice(0, 300);
  save();
  if (!r.ok) d.log(`the wallet reported a problem (${a.error}); checking whether the payment went through anyway`);
}

/** A wallet driven through its own command line. Arguments go to execFile (no shell); `{x}` is replaced. */
export function cliWallet(name: string, cmds: { pay?: string[]; send?: string[]; receive?: string[] }): Wallet {
  const run = (argv: string[], vars: Record<string, string>) =>
    new Promise<WalletResult>((resolve) => {
      const [bin, ...args] = argv.map((x) => x.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
      execFile(bin, args, { timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
        resolve(err ? { ok: false, error: String(stderr || err.message).trim() } : { ok: true, out: String(stdout) }));
    });
  return {
    name,
    payInvoice: cmds.pay && ((invoice) => run(cmds.pay!, { invoice })),
    sendToken: cmds.send && ((sats) => run(cmds.send!, { sats: String(sats) })),
    receive: cmds.receive && ((token) => run(cmds.receive!, { token })),
  };
}

export function walletFrom(env: NodeJS.ProcessEnv): Wallet {
  const w = env.S4T_WALLET ?? 'manual';
  if (w === 'manual') return { name: 'manual' };
  if (w === 'cashu-skill') {
    const cli = (env.S4T_CASHU_SKILL_DIR ?? `${env.HOME}/cashu-skill`) + '/cli/wallet.mjs';
    return cliWallet(w, {
      pay: ['node', cli, 'pay-invoice', '{invoice}'],
      send: ['node', cli, 'send', '{sats}'],
      receive: ['node', cli, 'receive', '{token}'],
    });
  }
  if (w === 'nutshell')
    return cliWallet(w, { pay: ['cashu', 'pay', '{invoice}', '--yes'], send: ['cashu', 'send', '{sats}'], receive: ['cashu', 'receive', '{token}'] });
  throw new Stop(`unknown S4T_WALLET=${w} (manual, cashu-skill or nutshell)`);
}

export function configFrom(env: NodeJS.ProcessEnv): Config {
  const key = env.S4T_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '';
  if (!/^(sk-)?[A-Za-z0-9]{16,}$/.test(key)) throw new Stop('set S4T_KEY to the sk-… key to top up');
  const root = (env.S4T_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const num = (v: string | undefined, dflt: number) => (v && Number(v) > 0 ? Number(v) : dflt);
  return {
    shop: (env.S4T_SHOP ?? 'https://sats4tokens.bhbtc.xyz').replace(/\/+$/, ''),
    key,
    baseUrl: root || undefined,
    pay: env.S4T_PAY === 'cashu' ? 'cashu' : 'lightning',
    wallet: walletFrom(env),
    maxPerTopup: num(env.S4T_MAX_PER_TOPUP, 2),
    maxPerDay: num(env.S4T_MAX_PER_DAY, 5),
    minIntervalMin: num(env.S4T_MIN_INTERVAL_MIN, 10),
    stateFile: env.S4T_STATE ?? `${env.HOME}/.sats4tokens/state.json`,
    pollMs: 3000,
    waitMin: num(env.S4T_WAIT_MIN, 10),
  };
}
