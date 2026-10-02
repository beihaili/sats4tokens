// HTTP side of the gateway. Speaks EPay to new-api, serves the checkout page to the customer.
//
//   GET|POST /submit.php             new-api redirects the customer here (signed EPay params)
//   GET      /pay/:id                checkout page (web/checkout.html)
//   GET      /api/order/:id          order status for the checkout page (polled)
//   POST     /api/order/:id/invoice  create the lightning invoice (lazily, when the customer picks ⚡)
//   GET      /api/order/:id/qr.svg   QR of the lightning invoice
//   POST     /api/order/:id/token    customer pastes a cashu token  {token}
//   GET      /admin?key=EPAY_KEY     operator data: orders + balance (JSON; the page is /admin.html#key=…)
//   POST     /admin/withdraw?key=…   move the whole balance into a token file under DATA_DIR/withdrawals/
//                                    (+ the token itself in the reply if WITHDRAW_TOKEN_OVER_HTTP=1)
// Background: watcher (quotes + crash recovery) every 2s, notify loop every 2s.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { verify, signed, type Params } from './epay.ts';
import { Ledger, checkSubmit, makeOrder, notifyParams, dueForNotify, notifyBackoffMs, type Order } from './ledger.ts';
import { Gateway, loadSeed } from './gateway.ts';
import { btcPrice, fiat } from './price.ts';

const PORT = Number(process.env.PORT ?? 8090);
const PID = process.env.EPAY_PID ?? '1001';
const KEY = process.env.EPAY_KEY ?? '';
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

const root = path.resolve(import.meta.dirname, '..', 'web');
const ledger = new Ledger(path.join(DATA_DIR, 'ledger.json'));
const gw = await Gateway.open(ledger, MINT_URL, loadSeed(DATA_DIR));

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

/** What the customer's browser may see. No proofs, no token, no notify internals. */
function publicOrder(o: Order) {
  let returnUrl = '';
  if (o.state === 'PAID' && o.returnUrl) {
    const u = new URL(o.returnUrl);
    for (const [k, v] of Object.entries(signed(notifyParams(o), KEY))) u.searchParams.set(k, v);
    returnUrl = u.toString();
  }
  return {
    id: o.id,
    name: o.name,
    money: o.money,
    fiat: o.fiat,
    sats: o.sats,
    btcPrice: o.btcPrice,
    state: o.state,
    invoice: o.state === 'PENDING' || o.state === 'SETTLING' ? o.quote?.request : undefined,
    mint: gw.mintUrl,
    tab: CHECKOUT_TAB,
    expiresAt: o.expiresAt,
    lastError: o.lastError,
    paid: o.paid,
    returnUrl,
  };
}

// ------------------------------------------------------------------ routes

async function submit(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = await epayParams(req, url);
  if (!verify(p, KEY)) return send(res, 400, 'invalid sign', 'text/plain');
  // serialized so two concurrent submits of one out_trade_no can't both create an order
  const r = await gw.serial(async (): Promise<Order | string> => {
    const c = checkSubmit(ledger.data, p, PID);
    if (c.kind === 'reject') return c.reason;
    if (c.kind === 'existing') return c.order; // idempotent: same order, same price, same invoice
    const order = makeOrder(p, { fiat: fiat(), btcPrice: await btcPrice(), now: Date.now(), ttlMs: TTL_MS });
    ledger.data.orders.push(order);
    ledger.save();
    console.log(`🧾 ${order.id} ← ${order.outTradeNo}: ${order.money} ${order.fiat} = ${order.sats} sat`);
    return order;
  });
  if (typeof r === 'string') return send(res, 400, r, 'text/plain');
  res.writeHead(302, { location: `/pay/${r.id}` });
  res.end();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  if (p === '/submit.php') return submit(req, res, url);

  let m = p.match(/^\/api\/order\/(\w+)(\/qr\.svg|\/token|\/invoice)?$/);
  if (m) {
    const o = ledger.order(m[1]);
    if (!o) return send(res, 404, { error: 'unknown order' });
    if (!m[2]) return send(res, 200, publicOrder(o));
    if (m[2] === '/qr.svg') {
      if (!o.quote) return send(res, 404, { error: 'no invoice' });
      const svg = await QRCode.toString('lightning:' + o.quote.request.toUpperCase(), { type: 'svg', margin: 1 });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (m[2] === '/invoice') {
      try {
        return send(res, 200, publicOrder(await gw.ensureQuote(o.id)));
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
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
    if (url.searchParams.get('key') !== KEY) return send(res, 403, 'forbidden', 'text/plain');
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    try {
      const w = await gw.withdrawAsToken(path.join(DATA_DIR, 'withdrawals'));
      return send(res, 200, TOKEN_OVER_HTTP ? { ...w, token: fs.readFileSync(w.file, 'utf8').trim() } : w);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  if (p === '/admin') {
    if (url.searchParams.get('key') !== KEY) return send(res, 403, 'forbidden', 'text/plain');
    const orders = ledger.data.orders.map(({ settle, ...o }) => ({ ...o, settle: settle && { ...settle, token: undefined } }));
    return send(res, 200, { balance: gw.balance(), nextCounter: ledger.data.nextCounter, mint: gw.mintUrl, tokenOverHttp: TOKEN_OVER_HTTP, orders });
  }

  // static files; /pay/:id is the checkout page
  m = p.match(/^\/pay\/\w+$/);
  const file = path.join(root, m ? 'checkout.html' : p === '/' ? 'index.html' : p);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain');
  }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': (types[path.extname(file)] ?? 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ notify loop

/** Tell new-api an order is paid. At-least-once: retried with backoff until it answers "success". */
async function notifyOnce(o: Order): Promise<void> {
  const u = new URL(o.notifyUrl);
  for (const [k, v] of Object.entries(signed(notifyParams(o), KEY))) u.searchParams.set(k, v);
  let err = '';
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
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

// ------------------------------------------------------------------ start

await gw.tick(); // recover anything a crash left in SETTLING before taking new requests
setInterval(() => void gw.tick(), 2000);
setInterval(() => void notifyLoop(), 2000);

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  })
  .listen(PORT, () => {
    console.log(`cashu-epay on http://127.0.0.1:${PORT}  pid=${PID}  mint=${gw.mintUrl}  balance=${gw.balance()} sat`);
  });
