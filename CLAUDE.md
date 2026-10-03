# Sats4Tokens (repo: beihaili/sats4tokens)

Bitcoin checkout for AI APIs: customers pay with Lightning or Cashu ecash and get a capped new-api key
(key shop), or top up an existing new-api account. No account details, no KYC, exactly-once settlement.
bitcoin++ Berlin 2026 (payments edition) hackathon project.

Naming: the GitHub repo was renamed from `cashu-epay` on 2026-10-02 (old URL redirects) and public copy (README, submission)
no longer mentions EPay. Internally the top-up path still speaks the EPay protocol (`/submit.php`,
`src/epay.ts`, `EPAY_KEY`/`EPAY_PID`); the local directory, `/opt/cashu-epay-demo` and container names
keep the old name on purpose (deployment unchanged).

## Layout

- `src/epay.ts` — EPay MD5 signing/verification (same rule as go-epay, both directions)
- `src/ledger.ts` — orders + durable JSON ledger + pure decision logic (`checkSubmit`, `beginSettle`,
  `finishSettle`, `decideSettle` recovery table, notify backoff). No network.
- `src/gateway.ts` — the engine: one deterministic (seed-backed) cashu-ts wallet. Lightning = mint
  quote → mint when PAID; Cashu = swap the pasted token. Write-ahead of the counter range before every
  mint call; `recover()` uses NUT-09 restore after crashes. `CRASH_AT=after-writeahead|after-mint`
  kills the process for the crash demo. On startup `mintProblems()` checks the mint's NUT-06 info and
  refuses to start without bolt11 sat minting (NUT-04), state checks (NUT-07) and restore (NUT-09).
  Pasted tokens may carry a `cashu:` URI prefix. Paid invoices are detected by **NUT-17 push**
  (`wallet.on.mintQuoteUpdates`, one WebSocket; a PAID push makes the order due, then the normal HTTP check →
  write-ahead → mint runs). HTTP polling is only the safety net and is budgeted: ≤1 quote check per 8s across all
  orders, each order every 60s while subscribed (8s/30s if not, open checkout pages first; expired 120s), and all
  polling pauses with backoff 5s→60s on network errors or 429. Public mints ban IPs that poll hard: Minibits
  firewalled the VPS after 4 quotes × 2s for hours; Coinos answers 429 above ~20 quote calls/min.
- `src/server.ts` — node:http: `/submit.php` (from new-api; own lock, never waits on the mint), `GET /api/order/:id`
  also marks the order as watched (checkout open), `/pay/:id` checkout, `/api/order/:id[...]`,
  `/admin?key=ADMIN_KEY` (JSON; ADMIN_KEY falls back to EPAY_KEY, keep them different in deployments), `POST /admin/withdraw?key=` (balance → token file in `DATA_DIR/withdrawals/`,
  written before the proofs leave the ledger; the token is also returned only if `WITHDRAW_TOKEN_OVER_HTTP=1`),
  notify loop (GET notify_url until it answers `success`). The watcher skips a beat while a tick is still running.
- **Key shop** (`src/keyshop.ts` + server): `GET /` buy page (web/index.html), `GET /api/shop` `{enabled, amounts, fiat}`,
  `POST /api/buy {money: 1|2|5|10}` → key order (`kind:'key'`, id `CK`+32 hex = 128-bit capability, no merchant).
  On PAID the notify loop runs `makeKeyOnce` instead of a merchant notify: `KeyShop.createKey` finds-or-creates new-api
  token `btc-<orderId>` (`remain_quota = money / price × quota_per_unit`, never expires) for the pool user, then
  `POST /api/token/:id/key` → `o.apiKey {key, baseUrl, tokenId}` (bearer; shown on `/pay/:id`, masked in admin).
  Errors retry with notify backoff (`keyError` shown on the page). `GET /api/order/:id/usage` → `KeyShop.usage`: token
  balance (`GET /api/token/:id`) + last 20 consume logs (`/api/log/self?type=2&token_name=`), only time/model/tokens/cost
  (no IP/channel/content); the checkout page shows it under the key, refreshed every 10s. Env `NEWAPI_URL NEWAPI_USER_ID NEWAPI_TOKEN
  [KEY_BASE_URL]`. Currency-agnostic: amounts are in `FIAT`, and new-api's `/api/status` `price` (its top-up
  `Price`, a unit's price in FIAT) converts money ↔ units for keys, usage (`{used, remaining, calls[].cost, fiat}`)
  and model prices, so a key costs what the same console top-up would. Pages format with `money(x, fiat)` from
  `web/models.js` (symbol map usd/eur/cny/gbp, else "2 CHF"); orders are named `AI API key · €2` (`moneyLabel`). new-api auth = user's personal access token (`GET /api/user/token`) as
  `Authorization` + `New-Api-User`.
  `GET /api/models` → `KeyShop.models()` (5-min cache): new-api `/api/pricing` filtered to the pool user's group;
  prices are the base-tier coefficients of `billing_expr` (`p`/`c`/`cr` = units per 1M input/output/cached tokens, × price → FIAT; verified
  against a real charge), `quota_type 1` = per call. `web/models.js` renders it (grouped by vendor) at the bottom of `/`
  and of the key page. On `/` (`renderModels(el, {calc: {amounts}})`) rows have checkboxes and a calculator shows, per ticked
  model, tokens for 1/2/5/10 (FIAT) if all input / all output, and chat calls (2K in + 500 out); images per call for per-call models.
  Phones (<480px) hide the cached column.
  Static files are sent `cache-control: no-cache`, but Cloudflare (stable URL) rewrites the browser TTL to 4h: after changing
  `web/*.js|css`, bump the `?v=` in the HTML/`import` URLs or browsers keep the old file. The key page also has a **Claude Code** one-liner: `ANTHROPIC_BASE_URL=<root, no /v1>
  ANTHROPIC_AUTH_TOKEN=<key> ANTHROPIC_MODEL=claude-opus-4-8 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4-6
  CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 … claude`. The output cap is required: new-api pre-reserves quota for
  max_tokens, and Claude Code's default asked for 1.26 units → 403 on a 1-unit key (then $1 = 1 unit; now €1 = 7.5
  units). One Claude Code turn ≈ 0.1 unit ≈ €0.013 (cache write).
- **Upstream network** (`src/upstreams.ts`, `web/network.html|js`): `GET /network` page + `GET /api/network`.
  Sats4Tokens as one node, upstream providers (letters A, B, … = one per registrable domain, ordered by first channel
  id) and their channels (A1, A2, …) fanned out above it. `anonymize()` builds the snapshot from new-api channels +
  abilities of the pool user's group: routes per model = new-api's rule (enabled abilities of enabled channels,
  tiers by priority high→low, share = weight/sum or equal if all 0; retry = next tier). No names, hosts or keys in it
  (domains not even hashed: a dictionary would reverse them). Built **on the server** by `deploy/demo/export-upstreams.sh`
  (demo DB → stdin → `scripts/export-upstreams.ts` in the gateway container → `public/upstreams.json`, mounted
  read-only as `UPSTREAMS_FILE`, re-read on mtime change; `sync-channels.sh` runs it at the end). The file keeps
  numeric channel ids to map call logs; `/api/network` strips them. Live calls: `KeyShop.recentCalls(30)` (pool user
  `/api/log/self?type=2`: `channel` id + request_id), cached 5s for all visitors, served as {sha256(request_id)[:10],
  time, model, node}. The page polls every 5s and animates each new real call (you → hub → provider → node → back);
  between them a lighter, labelled "route preview" samples the routing table (12% simulated failover to the next tier).
  The "why" copy computes its numbers from the routes (busiest provider, models with a cross-provider fallback).
  Local preview: `../gallery/mock-server.mjs` serves `/api/network` from `/tmp/upstreams.json` with fake calls.
- `README.md` — public overview (no secrets, no tunnel URLs).
- `src/cli.ts` — operator CLI (`balance`, `withdraw`); goes through HTTP so it never races the server's ledger.
- `src/price.ts` — fiat→BTC spot price (CoinGecko → Coinbase → mempool.space fallback, 60s cache, reuses a
  ≤10 min old price if all fail; or fixed `BTC_PRICE`). Locked into the order; sats rounded up.
- `web/admin.html` — operator page, `/admin.html#key=ADMIN_KEY` (key stays in the hash, out of access logs):
  balance, orders, one-click withdraw with a Copy button for the token (when the gateway returns it).
- `web/` — mobile checkout page (Lightning invoice created lazily when the ⚡ tab is opened; opening tab
  from `CHECKOUT_TAB` or `#ln`/`#cashu`; pasting a whole token pays at once; token errors stay visible across polls).
  The 🥜 tab has **📷 Scan QR**: camera (needs https) → `BarcodeDetector` where supported, else vendored
  `web/vendor/jsQR.js` (jsQR 1.4.0, Apache-2.0, lazy-loaded); a decoded `cashuA/B…` (also inside `cashu:` or a link)
  pays at once. **Animated NUT-16 QRs** (`ur:bytes/n-m/…` fountain frames; cashu.me shows them for any token with
  >2 proofs, i.e. every €1 key) go to `web/vendor/bcur.js` (bc-ur 1.1.12 bundle, lazy-loaded, progress "Animated QR: x%").
  bc-ur's GPL-2.0 dep `@apocentre/alias-sampling` is replaced by our own sampler (`web/vendor/bcur-src/`, build +
  licenses in `web/vendor/README.md`): never ship GPL code here. Scan loop: camera ideal 1920×1080 + continuous focus,
  a decode every 40ms (frames change every 150ms); jsQR alternates full frame / centre 80% square (≤960px); a
  non-rear camera preview is mirrored; the status line shows decoder + resolution (`native|jsQR, W×H`) for debugging
  phones. Verified with a fake camera (canvas stream of real UR frames): both decoders ~2.3s from mid-animation.
  The camera stops on tab switch, PAID/EXPIRED and pagehide. All page copy is English only.
  Testing tip: on testnut, opening the ⚡ tab auto-pays the invoice, so a local keyshop run creates a real key on
  the demo new-api — delete it afterwards (`DELETE /api/token/:id`).
- `test/` — `node:test` units (22; `upstreams.test.ts` = anonymize/no host leak/tiers): go-epay signature vectors, submit idempotency, write-ahead settle,
  `decideSettle`, notify (`ledger`/`epay` tests), mint capability check (`gateway.test.ts`).
- `scripts/` — `crash-demo.ts` (kill -9 mid-payment → restart → credited once), `edge-checks.ts` (unhappy paths +
  withdraw), `harness.ts` (shared by those two), `fake-merchant.ts` (stands in for new-api),
  `customer-wallet.ts mint <sats>`, `smoke.ts` (raw NUT-09 idea). All local against testnut, ports 8095/3995.
- `Dockerfile`, `deploy/demo/` — demo stack on the relay server (see `deploy/demo/README.md`).
- `docs/` — documentation (`README.md` index, `user-guide.md` buyer guide, `self-hosting.md` deploy guide, `api.md` every
  endpoint, `how-it-works.md` lifecycle/ledger/recovery; English, public: no EPay, no server IP/tunnel/secrets; keep in
  sync when endpoints, env vars or polling limits change) + `slides.pdf` + `images/*.png` (hackathon gallery; `logo.png` / `logo-dark-mode.png` = README header,
  transparent, picked by GitHub's theme). Logo sources in `../gallery/logo/` (SVG; the wordmark is live text in the
  system font, so ship the PNGs). `web/favicon.svg` + `web/apple-touch-icon.png` come from there too. Built outside the repo in `../gallery/`
  (HTML sources + headless-Chrome `shoot.mjs`, `mock-server.mjs` serves `web/` with fake orders), so no real
  order id / key / invoice ever appears in them. Regenerate there and copy in; never screenshot a real `/pay/` page.

## Run

```sh
EPAY_KEY=demo-key PORT=8091 npm run gateway         # env: EPAY_PID MINT_URL DATA_DIR ORDER_TTL_MIN FIAT BTC_PRICE SEED ADMIN_KEY CHECKOUT_TAB=ln|cashu WITHDRAW_TOKEN_OVER_HTTP=1
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 node scripts/fake-merchant.ts
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 npm run cli balance   # or: withdraw (ADMIN_KEY=… if set)
npm test && npm run typecheck                         # units (offline)
npm run edge-checks                                   # 15 e2e checks against testnut (~40s)
npm run crash-demo -- cashu after-mint                # or lightning / after-writeahead; all 4 verified
```

(zsh doesn't word-split `$var`; pass the two crash-demo args literally.)

new-api side: 支付设置 → PayAddress = gateway URL, EpayId = `EPAY_PID`, EpayKey = `EPAY_KEY`,
PayMethods `[{"name":"Bitcoin","color":"#f7931a","type":"bitcoin"}]`, payment compliance confirmed.

## Demo deployment (live)

**Since 2026-10-04 this stack is the official BHBTC EU relay** ("BHBTC Relay · Europe", EUR): no "demo" wording in
anything users see (site name/notice in `sync-channels.sh`, README). Internal names (`/opt/cashu-epay-demo`,
`cashu-demo-*` containers, `deploy/demo/`, user `demo`) keep the old name on purpose. Treat it as production: real users.

`api-relay:/opt/cashu-epay-demo` — new-api demo on :8530, gateway on :8531, channels copied
read-only from production. Verified end to end 2026-10-01: cashu token and lightning top-ups credited
in new-api (`topup` status success), a real model call works through the copied channels.
Since 2026-10-02 the demo gateway runs on a **mainnet mint**: first Minibits, then (10:15, after Minibits
firewalled the VPS IP for polling too hard — `Connection refused` from the VPS only) **Coinos `https://mint.coinos.io`**.
`./switch-mint.sh mainnet [URL]|testnut`, one wallet dir per mint: `data/gateway/` (testnut), `data/gateway-mainnet/`
(Minibits), `data/gateway-<host>/` (others, e.g. `gateway-mint-coinos-io`); seed backups on the laptop in
`~/.config/cashu-epay/`. Compose sets `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000`
because the VPS→Minibits RTT (~265ms) exceeds Node's 250ms happy-eyeballs attempt timeout (ETIMEDOUT otherwise).
Production `/opt/new-api-relay/AGENTS.md` has a one-line note about this stack (top of 项目说明).
Key shop on the demo: pool user `keyshop` (id 3, 1000 units set via `POST /api/user/manage add_quota` = ~€133 of keys at
the EUR price; top it up when low), its PAT in
`.env` (`NEWAPI_USER_ID`/`NEWAPI_TOKEN`, mode 600, password in `secrets/demo-accounts.txt`); buy page =
**https://sats4tokens.bhbtc.xyz/** (named tunnel, see Rules), key endpoint = `KEY_BASE_URL=https://sats4tokens.bhbtc.xyz/v1`. Verified 2026-10-02 locally (testnut + demo new-api): buy $1 →
key → real chat call, crash-resume found the same token.
Plan/pitch/video: `../dev-plan.md`, `../pitch.md`, `../recording-script.md`.

## Rules

- `data/` (seed, ledger proofs, withdrawals) is bearer money: never commit, never print.
- Never touch production containers/DB/Redis on api-relay; the demo stack is separate on purpose.
- Public access is **https only**, through the Cloudflare **named** tunnel `sats4tokens` (service `tunnel-named`,
  compose profile `named-tunnel`; config + credentials server-only in `secrets/cloudflared/`, owned by uid 65532, mode
  600): `https://sats4tokens.bhbtc.xyz` (shop/checkout/top-up `/submit.php`; `^/v1/` → new-api, rest → gateway) and,
  since 2026-10-03, `https://btc.bhbtc.xyz` (new-api console → new-api). new-api `ServerAddress`/`PayAddress` =
  `CONSOLE_URL`/`SHOP_URL` from the server `.env`, written by `sync-channels.sh`. The zone has a `*.bhbtc.xyz` →
  Vercel wildcard; explicit records (`cloudflared tunnel route dns …`) override it per name. The quick tunnels
  (`tunnel-shop`/`tunnel-pay`, random `*.trycloudflare.com`) are retired: compose profile `quick-tunnels`, only for
  `./https-tunnel.sh` as a no-domain fallback. Host ports 8530/8531 are bound to 127.0.0.1 (ssh -L only). The tunnel
  credentials (`~/.cloudflared/*.json`, `cert.pem` on the laptop) are secrets: never print or commit.
  The production Caddy is not involved (admin off → any change restarts it for all relay users).
- Demo new-api shows English (root/demo have `language: en` in their user setting) and **EUR** (since 2026-10-03):
  model prices are CNY (1 unit = ¥1, like production), €1 = ¥7.5 → `Price=0.133333333333` (€ per unit), display
  `quota_display_type=CUSTOM` symbol `€` rate 0.133333333333, gateway `FIAT=eur`. Until then it was USD with Price=1,
  i.e. $1 per ¥1 of quota (~6.7× too expensive). new-api top-ups are whole units (decimals → 参数错误): presets
  `payment_setting.amount_options=[15,30,75,150,375,750]` (= €2…€100), `MinTopUp=15`. `USDExchangeRate` = Price too: the
  wallet labels presets `units × USDExchangeRate` (→ 2…100) and Model Square's "Recharge" prices divide by it (backend
  uses it only for CNY display). All of it, plus the logo
  (`LOGO_URL` = production's PNG by absolute URL; production's `Logo` is a relative path, 404 on the demo), is
  demo-owned in `sync-channels.sh`, so a re-sync keeps it.
- `/rankings` merges production usage: `deploy/demo/sync-usage.sh` (root cron `7 * * * *`, syslog tag
  `cashu-sync-usage`) copies production `quota_data` hourly totals per model (read-only SELECT) into the demo's
  `quota_data` as `node_name=username='bhbtc-relay'`, `user_id=0` rows, replaced in one transaction.
