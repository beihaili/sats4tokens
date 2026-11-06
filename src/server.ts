// HTTP side of the gateway. Speaks EPay to new-api, serves the checkout page to the customer.
//
//   GET|POST /submit.php             new-api redirects the customer here (signed EPay params)
//   GET      /                       key shop: buy an AI API key with bitcoin, no account (web/index.html)
//   GET      /api/shop               key shop settings {enabled, amounts, fiat, sats, bonus, soldOut}
//   POST     /api/buy                {money} → new key order {id}; once paid, its page shows the key
//                                    {money, key} → top-up of a key sold here (its page never shows the key)
//   POST     /api/autotopup          {key, nwc?, money, below, perDay} → auto top-up over Nostr Wallet Connect on
//                                    {key, off: true} → turn it off; {key} → its status (never the connection string)
//   GET      /api/models             key shop: models a key can call + prices (FIAT per 1M tokens, from new-api)
//   GET      /api/compare            homepage price check: our live price vs list price and ppq.ai (USD per 1M tokens)
//   POST     /api/hit                homepage beacon {ref, first} for the funnel counts (no IP, no cookie)
//   GET      /pay/:id                checkout page (web/checkout.html)
//   GET      /api/order/:id          order status for the checkout page (polled)
//   POST     /api/order/:id/invoice  create the lightning invoice (lazily, when the customer picks ⚡)
//   GET      /api/order/:id/qr.svg   QR of the lightning invoice
//   POST     /api/order/:id/token    customer pastes a cashu token  {token}
//   POST     /api/order/:id/stable   customer picks a USDT/USDC network {rail} → our address + exact amount (stable.ts)
//   GET      /api/order/:id/stable.svg?rail=…  QR of that address
//   GET      /api/order/:id/usage    key shop: the sold key's balance + latest calls (from new-api)
//   GET      /network                upstream network page (web/network.html)
//   GET      /api/network            anonymized upstreams + routing (UPSTREAMS_FILE) + latest calls' nodes
//   GET      /admin?key=ADMIN_KEY    operator data: orders + balance (JSON; the page is /admin.html#key=…)
//   POST     /admin/withdraw?key=…   move the whole balance into a token file under DATA_DIR/withdrawals/
//                                    (+ the token itself in the reply if WITHDRAW_TOKEN_OVER_HTTP=1)
// Background: watcher every 2s (crash recovery; at most one quote check per 8s across all orders — open
// checkout pages first — paused with backoff on network errors / 429), notify loop every 2s (for key shop
// orders "notify" means: create the key in new-api or add the top-up to it, see keyshop.ts), auto top-up every
// AUTO_TOPUP_EVERY_S (keys running low → their wallet pays a top-up over NWC, see autotopup.ts), stablecoin watcher
// every 5s (each rail with waiting orders is scanned every 15s, read-only; see chain.ts / stable.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { signed, type Params } from './epay.ts';
import {
  Ledger, checkSubmit, makeOrder, makeKeyOrder, makeTopupOrder, findKeyOrder, topupBlocked, pendingMoney, moneyLabel, satsFor,
  parseBonusTiers, creditOf,
  notifyParams, dueForNotify, notifyBackoffMs, type Order,
} from './ledger.ts';
import { merchantsFromEnv, submitMerchant, merchantKey, relayCheckout, relayRails } from './merchants.ts';
import { Gateway, loadSeed } from './gateway.ts';
import { btcPrice, fiat, usdPerFiat, accountRate } from './price.ts';
import { tiers, bonuses, currencies, accountPrincipal } from './shop-pricing.ts';
import { KeyShop } from './keyshop.ts';
import { Network } from './upstreams.ts';
import { AutoTopups, checkNwc, checkSettings, publicAuto } from './autotopup.ts';
import { payInvoice, walletInfo } from './nwc.ts';
import { compare } from './compare.ts';
import { Funnel, cleanRef } from './funnel.ts';
import { bitcoinFromEnv, recordBitcoin } from './bitcoin.ts';
import { railsFromEnv } from './chain.ts';
import { StableWatcher, publicStable, quoteStable } from './stable.ts';

const PORT = Number(process.env.PORT ?? 8090);
const PID = process.env.EPAY_PID ?? '1001';
const KEY = process.env.EPAY_KEY ?? '';
const MERCHANTS = merchantsFromEnv(process.env);
const MINT_URL = process.env.MINT_URL ?? 'https://testnut.cashu.space';
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const TTL_MS = Number(process.env.ORDER_TTL_MIN ?? 30) * 60_000;
// Tab the checkout opens on. Opening ⚡ creates an invoice, and testnut pays its own invoices after ~2s,
// so on testnut use 'cashu' or every order is paid "by lightning" before anyone can paste a token.
const CHECKOUT_TAB = process.env.CHECKOUT_TAB === 'cashu' ? 'cashu' : 'ln';
// Withdrawn tokens are bearer money. By default they stay in a file on the gateway's disk; set this only
// when the admin page is reached over https (or the mint is a test mint), so the page can show and copy it.
const TOKEN_OVER_HTTP = process.env.WITHDRAW_TOKEN_OVER_HTTP === '1';
if (!KEY) throw new Error('EPAY_KEY is required (the same merchant key you put into new-api)');
// Operator key for /admin. Keep it different from EPAY_KEY: whoever holds EPAY_KEY can forge "paid" notifies
// to new-api, and the admin page may be opened over plain http. Falls back to EPAY_KEY for local runs.
const ADMIN_KEY = process.env.ADMIN_KEY || KEY;
// Key shop (optional, needs NEWAPI_URL/NEWAPI_USER_ID/NEWAPI_TOKEN). Amounts are in FIAT; new-api's Price must be
// in the same currency (it is: new-api's top-ups pay `units × Price` through this gateway in FIAT).
const shop = KeyShop.fromEnv();
const autoAmounts = ['1', '2', '5', '10']; // existing NWC budgets and authorizations
const legacyBonus = parseBonusTiers(process.env.KEY_BONUS);
// Pool protection (FIAT): every sold key spends the pool user's quota, so the shop sells (keys and top-ups) only while
// the pool keeps POOL_RESERVE on top of the order; below POOL_ALERT the log warns (hourly) to top the pool up.
const POOL_RESERVE = Number(process.env.POOL_RESERVE ?? 10);
const POOL_ALERT = Number(process.env.POOL_ALERT ?? 30);
// /network page (optional): UPSTREAMS_FILE from scripts/export-upstreams.ts; live calls come from the key shop pool
const network = Network.fromEnv(shop);
// Auto top-up: how often keys with it on get their balance read (one new-api call per such key)
const AUTO_EVERY_MS = Number(process.env.AUTO_TOPUP_EVERY_S ?? 60) * 1000;
// USDT/USDC (optional): one rail per network + token whose receiving address is set (STABLE_ADDR_EVM/_TRON/_SOL).
// Watch only: no keys here. A transfer up to STABLE_LATE_HOURS after the order expired still counts (as Lightning).
const bitcoin = bitcoinFromEnv(process.env);
const RAILS = railsFromEnv(process.env);
const STABLE_LATE_MS = Number(process.env.STABLE_LATE_HOURS || 24) * 3600_000;

const root = path.resolve(import.meta.dirname, '..', 'web');
const ledger = new Ledger(path.join(DATA_DIR, 'ledger.json'));
const gw = await Gateway.open(ledger, MINT_URL, loadSeed(DATA_DIR));
// homepage views per day and ref, joined with the ledger's orders on the admin page (written every minute)
const funnel = new Funnel(path.join(DATA_DIR, 'funnel.json'));

// ------------------------------------------------------------------ helpers

function send(res: http.ServerResponse, code: number, body: unknown, type = 'application/json'): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 64 * 1024) throw new Error('body too large');
  }
  return s;
}

/** EPay params from the query string (GET) or a urlencoded form (POST). */
async function epayParams(req: http.IncomingMessage, url: URL): Promise<Params> {
  const src = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams;
  return Object.fromEntries(src.entries());
}

/** Resolves to undefined if `p` takes longer than `ms` or fails (for pages that shouldn't wait on slow upstreams). */
const within = <T>(ms: number, p: Promise<T>): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(r, ms))]).catch(() => undefined);

/**
 * FIAT the key shop can still sell: the pool's available quota minus orders that may still turn into quota.
 * undefined if new-api can't be read: then the shop stays open (fail open, logged), as before pool checks existed.
 */
let poolAlertAt = 0;
async function poolLeft(): Promise<number | undefined> {
  if (!shop) return undefined;
  try {
    const p = await shop.pool();
    if (p.available < POOL_ALERT && Date.now() - poolAlertAt > 3600_000) {
      poolAlertAt = Date.now();
      console.warn(`⚠️ key pool low: ${p.available.toFixed(2)} ${fiat()} left to sell (alert below ${POOL_ALERT}): add quota to the pool user`);
    }
    return p.available - pendingMoney(ledger.data, Date.now());
  } catch (e) {
    console.warn(`key pool unknown (selling anyway): ${(e as Error).message}`);
    return undefined;
  }
}
function fits(amount: string, principal: string, bonus: number | undefined, left: number | undefined) {
  if (left === undefined) return Number(amount) < 100;
  return creditOf({ money: principal, bonus }) + POOL_RESERVE <= left;
}
/** What the customer's browser may see. No proofs, no token, no notify internals. */
function publicOrder(o: Order) {
  let returnUrl = '';
  // a held order (paid short in stablecoins) must not get the signed return URL: it carries the same signed params as
  // the "paid" callback, and replaying them to the merchant would credit the full amount
  if (o.state === 'PAID' && o.returnUrl && !o.stable?.hold) {
    const u = new URL(o.returnUrl);
    for (const [k, v] of Object.entries(signed(notifyParams(o), merchantKey(MERCHANTS, o)))) u.searchParams.set(k, v);
    returnUrl = u.toString();
  }
  return {
    id: o.id,
    name: o.name,
    money: o.money,
    purchase: o.purchase,
    fiat: o.fiat,
    sats: o.sats,
    btcPrice: o.btcPrice,
    state: o.state,
    invoice: o.state === 'PENDING' || o.state === 'SETTLING' ? o.quote?.request : undefined,
    mint: gw.mintUrl,
    tab: relayCheckout(o) ? (o.type === 'usdc' ? 'stable' : 'ln') : CHECKOUT_TAB,
    cashuEnabled: !relayCheckout(o),
    expiresAt: o.expiresAt,
    lastError: o.lastError,
    paid: o.paid,
    returnUrl,
    kind: o.kind,
    bonus: o.bonus,
    apiKey: o.state === 'PAID' ? o.apiKey : undefined, // the order id is the capability (128 random bits)
    keyError: (o.kind === 'key' && !o.apiKey) || (o.kind === 'keytopup' && !o.notify.done) ? o.notify.lastError : undefined,
    // a top-up's page may be someone else's (a friend paying): only the key's last 4 characters, never `of`
    topup: o.topup && { key: o.topup.keyHint, applied: o.topup.applied, needsRefund: !!o.topup.needsRefund },
    // the key's page: its paid top-ups, and auto top-up settings (without the connection string)
    topups: o.kind === 'key' && o.apiKey ? topupsOf(o) : undefined,
    auto: o.kind === 'key' && o.apiKey ? (publicAuto(ledger.data, o, Date.now()) ?? null) : undefined,
    // the stablecoin tab: networks on offer (only those with an address), and this order's quotes / payments
    bitcoinEnabled: !relayCheckout(o) && !!bitcoin && o.sats >= 330,
    bitcoin: o.bitcoin,
    rails: RAILS.filter(r => !relayCheckout(o) || relayRails.includes(r.id)).map((r) => ({ id: r.id, token: r.token, net: r.netName })),
    stable: publicStable(o, RAILS),
  };
}

function topupsOf(key: Order) {
  return ledger.data.orders
    .filter((x) => x.kind === 'keytopup' && x.topup!.of === key.id && x.state === 'PAID')
    .map((x) => ({ at: x.paid!.at, money: x.money, bonus: x.bonus, fiat: x.fiat, applied: !!x.topup!.applied, needsRefund: !!x.topup!.needsRefund, auto: !!x.topup!.auto }));
}

// ------------------------------------------------------------------ routes

let submitQueue: Promise<unknown> = Promise.resolve();
function submitSerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = submitQueue.then(fn, fn);
  submitQueue = run.catch(() => {});
  return run;
}

async function submit(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = await epayParams(req, url);
  const merchant = submitMerchant(MERCHANTS, p);
  if (!merchant) return send(res, 400, 'invalid merchant, signature or callback', 'text/plain');
  if (p.type === 'usdc' && !RAILS.some(r => relayRails.includes(r.id))) return send(res, 503, 'USDC unavailable', 'text/plain');
  // serialized so two concurrent submits of one out_trade_no can't both create an order
  // Own queue, not gw.serial: creating an order never talks to the mint, so a slow or unreachable mint
  // (the watcher holds gw.serial) must not make new-api's redirect hang.
  const r = await submitSerial(async (): Promise<Order | string> => {
    const c = checkSubmit(ledger.data, p, merchant.pid);
    if (c.kind === 'reject') return c.reason;
    if (c.kind === 'existing') return c.order; // idempotent: same order, same price, same invoice
    const order = makeOrder(p, { fiat: merchant.fiat, btcPrice: await btcPrice(merchant.fiat), now: Date.now(), ttlMs: TTL_MS });
    ledger.data.orders.push(order);
    ledger.save();
    console.log(`🧾 ${order.id} ← ${order.outTradeNo}: ${order.money} ${order.fiat} = ${order.sats} sat`);
    return order;
  });
  if (typeof r === 'string') return send(res, 400, r, 'text/plain');
  res.writeHead(302, { location: `/pay/${r.id}` });
  res.end();
}

/**
 * Key shop: a new order for an API key worth `money` FIAT, or with `key` a top-up of that key (only keys sold here;
 * the key goes in the body, not the URL, to stay out of access logs). Never talks to the mint (invoice comes later).
 */
async function buy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!shop) return send(res, 404, { error: 'key shop not enabled' });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const { money, key, ref, currency } = JSON.parse((await readBody(req)) || '{}') as { money?: unknown; key?: unknown; ref?: unknown; currency?: unknown };
  const selected = currency === undefined ? fiat() : String(currency).toLowerCase();
  if (currency !== undefined && !currencies.includes(selected)) return send(res, 400, { error: 'unsupported currency' });
  const legacy = currency === undefined && ['2', '5'].includes(String(money));
  if (!legacy && !tiers.includes(String(money))) return send(res, 400, { error: 'amount must be one of ' + tiers.join(', ') });
  const parent = key === undefined ? undefined : findKeyOrder(ledger.data, String(key));
  if (key !== undefined && !parent) return send(res, 404, { error: 'unknown key' });
  const order = await newShopOrder(String(money), parent, cleanRef(ref), selected);
  if (typeof order === 'string') return send(res, 503, { error: order });
  return send(res, 200, { id: order.id });
}

/** A saved key order, or a top-up order for `parent`; or why not (the pool can't take it). Shared with auto top-up. */
async function newShopOrder(amount: string, parent?: Order, ref = 'direct', currency = fiat(), isAuto = false): Promise<Order | string> {
  let price: number, rate: number;
  try {
    [price, rate] = await Promise.all([btcPrice(), accountRate(currency)]);
    if (!(price > 0) || !Number.isFinite(price)) throw new Error('Invalid BTC price');
  } catch { return 'Quote unavailable. Please try again.'; }
  const principal = accountPrincipal(amount, rate);
  const bonus = !isAuto && tiers.includes(amount) ? bonuses[amount] : legacyBonus[amount];
  return submitSerial(async () => {
    const left = await poolLeft();
    if (!fits(amount, principal, bonus, left)) return 'This amount is currently unavailable. Try a smaller amount or retry later.';
    const opts = { fiat: fiat(), btcPrice: price, now: Date.now(), ttlMs: TTL_MS, bonus };
    const order = parent ? makeTopupOrder(parent, principal, opts) : makeKeyOrder(principal, opts);
    if (currency !== fiat()) {
      order.purchase = { currency, amount, accountRate: rate };
      order.name = order.name.replace(moneyLabel(principal, fiat()), moneyLabel(amount, currency));
    }
    order.ref = ref;
    ledger.data.orders.push(order);
    ledger.save();
    return order;
  });
}

/**
 * Auto top-up settings of a key sold here (the key in the body is the authorization, as for top-ups). Saving checks
 * the connection string and asks the wallet's relay whether it can pay invoices; it never sends a payment itself.
 */
async function autotopup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!shop) return send(res, 404, { error: 'key shop not enabled' });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  const k = b.key === undefined ? undefined : findKeyOrder(ledger.data, String(b.key));
  if (!k) return send(res, 404, { error: 'unknown key' });
  const view = () => send(res, 200, { auto: publicAuto(ledger.data, k, Date.now()) ?? null });
  if (b.off) {
    delete k.auto;
    ledger.save();
    console.log(`🔁 ${k.id.slice(0, 10)}…: auto top-up off`);
    return view();
  }
  if (b.nwc === undefined && b.money === undefined) return view();
  const settings = checkSettings(b, autoAmounts);
  if (typeof settings === 'string') return send(res, 400, { error: settings });
  const uri = b.nwc === undefined ? k.auto?.nwc : String(b.nwc);
  if (!uri) return send(res, 400, { error: 'nwc connection string required' });
  let note: string | undefined;
  let c;
  try {
    c = checkNwc(uri);
  } catch (e) {
    return send(res, 400, { error: (e as Error).message });
  }
  if (b.nwc !== undefined) {
    const info = await walletInfo(c).catch(() => undefined);
    if (info && !info.methods.includes('pay_invoice')) return send(res, 400, { error: "this connection can't pay invoices: give it the pay_invoice permission" });
    if (!info) note = "couldn't read the wallet's info on its relay; we'll still try when the key runs low";
  }
  k.auto = { nwc: uri, wallet: c.wallet, relay: new URL(c.relays[0]).host, ...settings, since: Date.now(), failures: 0, lastError: note };
  ledger.save();
  console.log(`🔁 ${k.id.slice(0, 10)}…: auto top-up on (${settings.money} below ${settings.below}, ≤${settings.perDay}/day, relay ${k.auto.relay})`);
  void auto.tick(); // a key that is already low gets its top-up now
  return view();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  if (p === '/submit.php') return submit(req, res, url);
  if (p === '/api/buy') return buy(req, res);
  if (p === '/api/autotopup') return autotopup(req, res);
  if (p === '/api/shop') {
    // sats: today's price of each amount, for the buy buttons (an order locks its own price when it's made)
    // at most 1.5s: the buy page waits for this, and the price feeds can be slow (then no sats on the buttons)
    // amounts: only those the pool can still sell (all of them if the pool can't be read in time)
    const selected = url.searchParams.get('currency')?.toLowerCase() ?? fiat();
    if (selected !== fiat() && !currencies.includes(selected)) return send(res, 400, { error: 'unsupported currency' });
    const [price, left, rate] = await Promise.all([within(1500, btcPrice()), within(1500, poolLeft()), within(12000, accountRate(selected))]);
    if (!rate) return send(res, 503, { error: 'Currency quote unavailable. Retry or choose another currency.' });
    const amounts = tiers.filter(a => fits(a, accountPrincipal(a, rate), bonuses[a], left));
    const sats = price ? Object.fromEntries(amounts.map(a => [a, satsFor(accountPrincipal(a, rate), price)])) : undefined;
    return send(res, 200, { enabled: !!shop, amounts, tiers, fiat: selected, accountFiat: fiat(), accountRate: rate, sats,
      bitcoinEnabled: !!bitcoin, bonus: bonuses, autoBonus: legacyBonus, soldOut: !!shop && amounts.length === 0 });
  }
  if (p === '/api/models') {
    if (!shop) return send(res, 404, { error: 'key shop not enabled' });
    try {
      return send(res, 200, await shop.models());
    } catch (e) {
      return send(res, 502, { error: (e as Error).message });
    }
  }

  if (p === '/api/compare') {
    if (!shop) return send(res, 404, { error: 'key shop not enabled' });
    try {
      const [models, rate] = await Promise.all([shop.models(), usdPerFiat(fiat())]);
      return send(res, 200, compare(models, rate));
    } catch (e) {
      return send(res, 502, { error: (e as Error).message });
    }
  }
  if (p === '/api/hit') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const b = JSON.parse((await readBody(req)) || '{}') as { ref?: unknown; first?: unknown };
    if (!/bot|crawl|spider|preview|headless/i.test(req.headers['user-agent'] ?? '')) funnel.hit(cleanRef(b.ref), b.first === true, Date.now());
    return send(res, 204, '');
  }

  if (p === '/api/network') {
    if (!network) return send(res, 404, { error: 'network view not enabled' });
    try {
      return send(res, 200, await network.view());
    } catch (e) {
      return send(res, 502, { error: (e as Error).message });
    }
  }

  let m = p.match(/^\/api\/order\/(\w+)(\/qr\.svg|\/token|\/invoice|\/usage|\/bitcoin\.svg|\/bitcoin|\/stable\.svg|\/stable)?$/);
  if (m) {
    const o = ledger.order(m[1]);
    if (!o) return send(res, 404, { error: 'unknown order' });
    if (!m[2]) {
      gw.watch(o.id); // the checkout page polls this; its quote gets checked first
      return send(res, 200, publicOrder(o));
    }
    if (m[2] === '/qr.svg') {
      if (!o.quote) return send(res, 404, { error: 'no invoice' });
      const svg = await QRCode.toString('lightning:' + o.quote.request.toUpperCase(), { type: 'svg', margin: 1 });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (m[2] === '/bitcoin.svg') {
      if (!o.bitcoin) return send(res, 404, { error: 'no Bitcoin address' });
      const uri = 'bitcoin:' + o.bitcoin.address + '?amount=' + (o.sats / 1e8).toFixed(8);
      return send(res, 200, await QRCode.toString(uri, { type: 'svg', margin: 1 }), 'image/svg+xml');
    }
    if (m[2] === '/stable.svg') {
      // the address only: wallets and exchange apps read a plain address; the amount is shown (and copied) next to it
      const q = o.stable?.quotes.find((x) => x.rail === url.searchParams.get('rail'));
      if (!q) return send(res, 404, { error: 'no quote for that network' });
      return send(res, 200, await QRCode.toString(q.address, { type: 'svg', margin: 1 }), 'image/svg+xml');
    }
    if (m[2] === '/usage') {
      // the order id is the capability: whoever may see the key may see what it spent
      if (!shop || !o.apiKey) return send(res, 404, { error: 'no key yet' });
      try {
        return send(res, 200, { ...(await shop.usage(o)), fiat: fiat() });
      } catch (e) {
        return send(res, 502, { error: (e as Error).message });
      }
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (m[2] === '/bitcoin') {
      if (relayCheckout(o) || !bitcoin || o.sats < 330) return send(res, 400, { error: 'Bitcoin on-chain unavailable for this order' });
      try {
        // Concurrent tabs must see one durable address. Do not expose it before saving.
        await gw.serial(async () => {
          if (o.state !== 'PENDING' || Date.now() >= o.expiresAt) throw new Error('Order closed');
          if (o.bitcoin) return;
          const address = await bitcoin.address();
          if (Date.now() >= o.expiresAt || o.state !== 'PENDING') throw new Error('Order closed');
          o.bitcoin = { address, need: bitcoin.need, received: 0, confirmations: 0 };
          try { ledger.save(); }
          catch (e) { delete o.bitcoin; throw e; }
        });
        return send(res, 200, publicOrder(o));
      } catch {
        return send(res, 503, { error: 'Could not issue a Bitcoin address. Refresh to check the order or retry.' });
      }
    }
    if (m[2] === '/stable') {
      const { rail } = JSON.parse((await readBody(req)) || '{}') as { rail?: unknown };
      const r = RAILS.find((x) => x.id === rail && (!relayCheckout(o) || relayRails.includes(x.id)));
      if (!r) return send(res, 400, { error: 'unknown network' });
      try {
        const fresh = !o.stable?.quotes.some((q) => q.rail === r.id);
        const rate = o.stable?.usdPerFiat ?? (await usdPerFiat(o.fiat));
        const q = quoteStable(ledger.data, o, r, rate, Date.now(), STABLE_LATE_MS); // sync: amounts can't clash
        if (fresh) {
          ledger.save();
          console.log(`💵 ${o.kind ? o.id.slice(0, 10) + '…' : o.id}: ${q.amount} ${r.token} on ${r.netName} (${o.money} ${o.fiat} × ${o.stable!.usdPerFiat})`);
        }
        return send(res, 200, publicOrder(o));
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
    if (m[2] === '/invoice') {
      try {
        return send(res, 200, publicOrder(await gw.ensureQuote(o.id)));
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
    if (relayCheckout(o)) return send(res, 400, { error: 'Cashu unavailable for this order' });
    try {
      const { token } = JSON.parse(await readBody(req)) as { token?: string };
      const paid = await gw.payWithToken(o.id, String(token ?? ''));
      return send(res, 200, publicOrder(paid));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  if (p === '/admin/withdraw') {
    // the whole balance becomes one cashu token in DATA_DIR/withdrawals/ — always written to disk first,
    // so a reply lost on the way still leaves the money in the file
    if (url.searchParams.get('key') !== ADMIN_KEY) return send(res, 403, 'forbidden', 'text/plain');
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    try {
      const w = await gw.withdrawAsToken(path.join(DATA_DIR, 'withdrawals'));
      return send(res, 200, TOKEN_OVER_HTTP ? { ...w, token: fs.readFileSync(w.file, 'utf8').trim() } : w);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  if (p === '/admin') {
    if (url.searchParams.get('key') !== ADMIN_KEY) return send(res, 403, 'forbidden', 'text/plain');
    const orders = ledger.data.orders.map(({ settle, apiKey, auto, ...o }) => ({
      ...o,
      settle: settle && { ...settle, token: undefined },
      apiKey: apiKey && { ...apiKey, key: apiKey.key.slice(0, 7) + '…' }, // bearer; the operator doesn't need it
      auto: auto && { ...auto, nwc: undefined }, // the customer's wallet connection: bearer, never shown
    }));
    const pool = shop ? await within(5000, shop.pool()) : undefined;
    const pending = pendingMoney(ledger.data, Date.now());
    return send(res, 200, {
      balance: gw.balance(), nextCounter: ledger.data.nextCounter, mint: gw.mintUrl, tokenOverHttp: TOKEN_OVER_HTTP, orders,
      fiat: fiat(), pool: pool && { ...pool, pending, reserve: POOL_RESERVE, alert: POOL_ALERT },
      funnel: funnel.report(ledger.data.orders, 14, Date.now()),
      methods: funnel.methods(ledger.data.orders, 14, Date.now()),
      // rails without RPC URLs (a provider key may sit in the URL); unmatched = confirmed transfers no order claimed
      stable: RAILS.length || ledger.data.stable ? {
        lateHours: STABLE_LATE_MS / 3600_000,
        rails: RAILS.map((r) => ({ id: r.id, net: r.netName, token: r.token, address: r.address, confirmations: r.confirmations, explorer: r.explorer, rpcHost: new URL(r.rpc).host, ...stable?.status.get(r.id) })),
        unmatched: ledger.data.stable?.unmatched ?? [],
      } : undefined,
    });
  }

  // static files; /pay/:id is the checkout page, /claude-code-bitcoin the ad landing page
  m = p.match(/^\/pay\/\w+$/);
  const file = path.join(root, m ? 'checkout.html'
    : p === '/' ? 'index.html'
    : p === '/network' ? 'network.html'
    : p === '/claude-code-bitcoin' ? 'claude-code-bitcoin.html'
    : p);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain');
  }
  const u = '; charset=utf-8';
  const types: Record<string, string> = { '.html': 'text/html' + u, '.js': 'text/javascript' + u, '.css': 'text/css' + u,
    '.svg': 'image/svg+xml' + u, '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };
  // no-cache: the demo sits behind Cloudflare, whose default edge TTL (4h) kept serving old JS after a deploy
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ notify loop

/** Tell new-api an order is paid. At-least-once: retried with backoff until it answers "success". */
async function notifyOnce(o: Order): Promise<void> {
  if (o.kind === 'key') return makeKeyOnce(o);
  if (o.kind === 'keytopup') return makeTopupOnce(o);
  const u = new URL(o.notifyUrl);
  for (const [k, v] of Object.entries(signed(notifyParams(o), merchantKey(MERCHANTS, o)))) u.searchParams.set(k, v);
  let err = '';
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    const body = (await r.text()).trim();
    if (body === 'success') {
      o.notify = { ...o.notify, done: true, doneAt: Date.now(), lastError: undefined };
      ledger.save();
      console.log(`📨 ${o.id} → merchant: success`);
      return;
    }
    err = `HTTP ${r.status}: ${body.slice(0, 80)}`;
  } catch (e) {
    err = (e as Error).message;
  }
  o.notify.attempts++;
  o.notify.nextAt = Date.now() + notifyBackoffMs(o.notify.attempts);
  o.notify.lastError = err;
  ledger.save();
  console.warn(`📨 ${o.id} → merchant failed (#${o.notify.attempts}): ${err}`);
}

/** Key shop: turn a paid order into its API key. Same retry/backoff as a merchant notify. */
async function makeKeyOnce(o: Order): Promise<void> {
  try {
    if (!shop) throw new Error('key shop not configured (NEWAPI_*)');
    o.apiKey = await shop.createKey(o);
    o.notify = { ...o.notify, done: true, doneAt: Date.now(), lastError: undefined };
    ledger.save();
    console.log(`🔑 ${o.id.slice(0, 10)}…: key created (new-api token #${o.apiKey.tokenId}, ${moneyLabel(o.money, o.fiat)})`);
  } catch (e) {
    o.notify.attempts++;
    o.notify.nextAt = Date.now() + notifyBackoffMs(o.notify.attempts);
    o.notify.lastError = (e as Error).message;
    ledger.save();
    console.warn(`🔑 ${o.id.slice(0, 10)}…: key failed (#${o.notify.attempts}): ${o.notify.lastError}`);
  }
}

/**
 * Key shop: add a paid top-up to its key. Same retry/backoff; waits while another top-up of the same key is half-way.
 * A deleted key can't be topped up: the order is marked needsRefund (admin page) and not retried.
 */
async function makeTopupOnce(o: Order): Promise<void> {
  const tp = o.topup!;
  if (topupBlocked(ledger.data, o)) return; // the other one goes first; this one is due again next pass
  try {
    if (!shop) throw new Error('key shop not configured (NEWAPI_*)');
    const r = await shop.topUp(o, () => ledger.save());
    if (r) tp.applied = { at: Date.now(), remaining: r.remaining };
    else tp.needsRefund = 'key no longer exists in new-api';
    o.notify = { ...o.notify, done: true, doneAt: Date.now(), lastError: undefined };
    ledger.save();
    if (r) console.log(`🔋 ${o.id.slice(0, 10)}…: top-up added to token #${tp.tokenId} (${moneyLabel(o.money, o.fiat)}, now ${r.remaining.toFixed(2)})`);
    else console.warn(`🔋 ${o.id.slice(0, 10)}…: token #${tp.tokenId} is gone — top-up paid but NOT applied, needs a refund`);
  } catch (e) {
    o.notify.attempts++;
    o.notify.nextAt = Date.now() + notifyBackoffMs(o.notify.attempts);
    o.notify.lastError = (e as Error).message;
    ledger.save();
    console.warn(`🔋 ${o.id.slice(0, 10)}…: top-up failed (#${o.notify.attempts}): ${o.notify.lastError}`);
  }
}

let notifying = false;
async function notifyLoop(): Promise<void> {
  if (notifying) return;
  notifying = true;
  try {
    for (const o of ledger.data.orders.filter((x) => dueForNotify(x, Date.now()))) await notifyOnce(o);
  } finally {
    notifying = false;
  }
}

// ------------------------------------------------------------------ auto top-up

const auto = new AutoTopups({
  data: () => ledger.data,
  save: () => ledger.save(),
  remaining: (tokenId) => shop!.remaining(tokenId),
  newTopup: (key, money) => newShopOrder(money, key, 'auto', fiat(), true),
  invoice: async (id) => (await gw.ensureQuote(id)).quote!.request,
  checkSoon: (id) => gw.checkSoon(id),
  pay: (c, invoice) => payInvoice(c, invoice),
  now: () => Date.now(),
  log: (line) => console.log(line),
});

// ------------------------------------------------------------------ stablecoins

const stable = RAILS.length
  ? new StableWatcher({ data: () => ledger.data, save: () => ledger.save(), now: () => Date.now(), log: (l) => console.log(l), rails: RAILS, lateMs: STABLE_LATE_MS })
  : undefined;

// ------------------------------------------------------------------ start

await gw.tick(); // recover anything a crash left in SETTLING before taking new requests
// skip a beat while the previous pass is still running, so slow mint calls can't pile up ticks in gw.serial
// (that backlog once blocked every other wallet call — invoice, token — for minutes)
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  void gw.tick().finally(() => (ticking = false));
}, 2000);
setInterval(() => void notifyLoop(), 2000);
let bitcoinScanning = false;
if (bitcoin) setInterval(async () => {
  if (bitcoinScanning) return;
  bitcoinScanning = true;
  try {
    await bitcoin.scan(ledger.data.orders, (order, receipt, late) => gw.serial(async () => {
      recordBitcoin(order, receipt, late, Date.now());
      ledger.save();
    }));
  } catch { console.warn('Bitcoin wallet scan failed; retrying'); }
  finally { bitcoinScanning = false; }
}, 15000);
let stableTicking = false;
if (stable) setInterval(() => {
  if (stableTicking) return;
  stableTicking = true;
  void stable.tick().catch((e) => console.error('stable tick:', e)).finally(() => (stableTicking = false));
}, 5000);
if (shop) setInterval(() => void auto.tick(), AUTO_EVERY_MS);
setInterval(() => funnel.flush(), 60_000);
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (funnel.flush(), process.exit(0)));
// so the low-pool warning shows up in the log even with no visitors; the first run also warms the cache /api/shop reads
void poolLeft();
setInterval(() => void poolLeft(), 10 * 60_000);

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  })
  .listen(PORT, () => {
    console.log(`gateway on http://127.0.0.1:${PORT}  pid=${PID}  mint=${gw.mintUrl}  balance=${gw.balance()} sat  keyshop=${shop ? shop.url : 'off'}  network=${network ? network.file : 'off'}  stable=${RAILS.map((r) => r.id).join(',') || 'off'}`);
  });
