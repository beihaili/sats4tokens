# Sats4Tokens (repo: beihaili/sats4tokens)

Bitcoin checkout for AI APIs: customers pay with Lightning or Cashu ecash and get a capped new-api key
(key shop), or top up an existing new-api account. No account details, no KYC, exactly-once settlement.
bitcoin++ Berlin 2026 (payments edition) hackathon project. MIT license (`LICENSE`, since 2026-10-07).

Naming: the GitHub repo was renamed from `cashu-epay` on 2026-10-02 (old URL redirects) and public copy (README, submission)
no longer mentions EPay. Internally the top-up path still speaks the EPay protocol (`/submit.php`,
`src/epay.ts`, `EPAY_KEY`/`EPAY_PID`); `/opt/cashu-epay-demo` and container names keep the old name on purpose
(deployment unchanged).

Server/ops details (live deployment, server paths, tunnel, EUR settings) are in the gitignored `CLAUDE.local.md`
(only on the maintainer's laptop); keep them out of this public file.

## Layout

- `src/epay.ts` — EPay MD5 signing/verification (same rule as go-epay, both directions)
- `src/ledger.ts` — orders + durable JSON ledger + pure decision logic (`checkSubmit`, `beginSettle`,
  `finishSettle`, `decideSettle` recovery table, notify backoff). No network.
- `src/gateway.ts` — the engine: one deterministic (seed-backed) cashu-ts wallet. Lightning = mint
  quote → mint when PAID; Cashu = swap the pasted token. Write-ahead of the counter range before every
  mint call; `recover()` uses NUT-09 restore after crashes. `CRASH_AT=after-writeahead|after-mint`
  kills the process for the crash demo. On startup `mintProblems()` checks the mint's NUT-06 info and
  refuses to start without bolt11 sat minting (NUT-04), state checks (NUT-07) and restore (NUT-09).
  Pasted tokens may carry a `cashu:` URI prefix. **Token retries are idempotent**: the swap stores
  `order.tokenHash` (`tokenFingerprint` = sha256 of the trimmed token), and `isTokenRetry` answers a re-POST of the same
  token for a SETTLING/PAID order with 200 + the order (a different token → 400 `order is paid`; `abortSettle` clears it). Paid invoices are detected by **NUT-17 push**
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
- **Key shop** (`src/keyshop.ts` + server): `GET /` buy page (web/index.html), `GET /api/shop` `{enabled, amounts, fiat, sats, soldOut}`
  (`sats` = today's `satsFor` per amount for the buttons "Buy a €1 key / ≈ 1,337 sat"; waits ≤1.5s for the price, else omitted),
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
  **Model aliases**: `MODEL_ALIAS_SUFFIX` (regex, server `.env` only, so upstream-named suffixes stay out of the repo)
  → `aliasesOf()`: a name matching it whose base name is also listed is hidden from `/api/models` and `/network`
  (routes dropped, node model lists and live calls mapped to the base name). Still callable with a key. Variants
  priced differently (`-max`, `-max-all`) are real models, not aliases.
  **Key top-ups** (since 2026-10-07): `POST /api/buy {money, key}` (key in the body, ±`sk-`; `findKeyOrder` = only keys
  sold here, else 404 `unknown key`) → order `kind:'keytopup'` (`makeTopupOrder`: `CK…` id, name `Top-up · €2 for key sk-…a1b2`,
  `topup {of, tokenId, keyHint}`; `publicOrder` never returns `of` or the key, so the link can go to a third party). On PAID the
  notify loop runs `makeTopupOnce` → `KeyShop.topUp(o, save)`: checkpoint = new-api's `remain_quota + used_quota` (only grows
  when quota is added; calls/reservations/refunds move quota between the two). Write-ahead `topup.base = remain+used`,
  `topup.add = money/price×qpu` (saved before any change), then add `decideTopup(total, base, add)` = what is still missing,
  re-read and verify (`total ≥ base+add`, status ≠ 4), else throw → notify backoff. rc.22 facts (checked in a throwaway
  container): `PUT /api/token/` writes **every** editable field from the body (a partial body clears name/group/model_limits/
  expiry), so send the whole GET object back, with its own status (a PUT with status 1 on a status-4 token is refused); a
  used-up key (status 4) comes back only via `PUT /api/token/?status_only=true {id,status:1}` once remain > 0. One key's
  top-ups run in order (`topupBlocked`: another unfinished top-up of the same token already took its `base`). Token gone
  (`record not found`) → `topup.needsRefund`, listed red on admin.html for a manual refund. Key page: "Top up this key"
  buttons (`showTopup`), `topups` history; `examples/agent-buy-key.ts --topup sk-… <amount>`.
  **Auto top-up over Nostr Wallet Connect** (since 2026-10-08): `src/nwc.ts` = minimal NIP-47 client (`parseNwc`,
  `walletInfo` = kind 13194 methods/encryption, `payInvoice` = ONE kind 23194 `pay_invoice` → waits for the wallet-signed
  23195; NIP-44 v2 if the info event lists `nip44_v2`, else NIP-04; `expiration` tag; secp256k1/schnorr from @noble/curves
  (cashu-ts already depends on it, now declared), chacha20/HKDF/AES from node:crypto; checked against the NIP-44 spec vectors
  and nostr-tools both ways). Relay I/O through a `Connect` (default: Node 22's global WebSocket; tests plug in a fake
  relay + wallet). `src/autotopup.ts`: key order `auto {nwc (BEARER), wallet, relay, money, below, perDay, failures,
  nextTryAt, lastError, pausedAt}`; auto top-up orders carry `topup.auto {sentAt, outcome: paid|declined|unknown, error}`.
  `AutoTopups.tick()` every `AUTO_TOPUP_EVERY_S` (60): per key, an open auto order (SETTLING / PAID-not-applied /
  PENDING unexpired & not declined) blocks a new one; a PENDING one without `sentAt` is sent now (crash before send),
  one with `sentAt` and no outcome → `unknown` (crash mid-request: never resent). Else `remaining(tokenId)` < `below`,
  backoff and `autoSpent24h` (paid or maybe-paid auto orders) + money ≤ `perDay` → `newShopOrder` (same pool check as
  /api/buy; a sold-out reason is shown, not counted as a failure) → `gw.ensureQuote` → save `sentAt` → `payInvoice` →
  `paid` (`gw.checkSoon`: quote checked next pass) / `declined` (wallet error codes, relay refused) / `unknown` (TIMEOUT,
  unreadable answer). Failures back off 10 min × n, 3 in a row → paused until the customer saves again; a deleted
  token pauses it. Declined auto orders don't hold pool space (`pendingMoney`). `POST /api/autotopup {key, nwc?, money,
  below, perDay}` / `{key, off:true}` / `{key}` (status); saving checks `checkNwc` (only public `wss://` hostnames: no IP,
  localhost, single-label docker names) and the info event (400 without `pay_invoice`; no info → saved with a note).
  `publicAuto` = what the key page sees (no connection string; wallet pubkey prefix + relay host); admin JSON drops `auto.nwc`.
  Key page "Auto top-up" form (`setupAuto`/`renderAuto` in checkout.js). Verified 2026-10-08 locally: testnut + a throwaway
  fake new-api + a fake NWC wallet on the public relay nos.lol (pay, daily cap stop, refusal `QUOTA_EXCEEDED`, secret
  absent from admin/order/log), plus the form in the browser.
  **Bonus tiers** (since 2026-10-08): `KEY_BONUS="5:5,10:10"` (`parseBonusTiers`, amount:percent, 0 < % ≤ 50, only
  KEY_AMOUNTS) → `order.bonus` locked at creation (makeKeyOrder/makeTopupOrder opts, name "… + 5% bonus"); `creditOf(o)` =
  money × (1 + bonus/100) is what createKey/topUp put on the token, what `pendingMoney` and `fits` count. Same for ⚡ and 🥜
  (a Lightning-only bonus would punish Cashu payers) and for auto top-ups. `/api/shop` has `bonus`; buttons, key-page top-ups,
  the auto top-up select and the calculator (`bonusText` in models.js) show it. Orders made before have no `bonus` → none.
  **Pool protection**: `KeyShop.pool()` (cached 30s, cleared after createKey/topUp) = pool user quota (`/api/user/self`) −
  Σ `remain_quota` of its limited tokens with status 1/4 (`/api/token/?p=&page_size=100`, paged) → `{quota, owed, available}`
  in FIAT. `poolLeft()` = available − `pendingMoney` (open/settling/paid-not-made key + top-up orders). An amount is sold
  only while `money + POOL_RESERVE (10) ≤ left`: `/api/shop` filters `amounts` (empty → `soldOut`, buy page says "Sold
  out right now"), `/api/buy` → 503. Fail open (new-api unreadable or >1.5s on `/api/shop` → unfiltered). `POOL_ALERT` (30) →
  hourly `⚠️ key pool low` log line (checked at start and every 10 min). Admin JSON has `pool {…, pending, reserve, alert}`.
  Homepage (`web/index.html`): og/twitter meta (`og:image` = `/og-card.png`, 1200×630 from `../gallery/og-card.html`;
  absolute URLs on our domain, self-hosters change them), nav (🛰 /network, 📖 user guide, GitHub) and a "Who runs this"
  card (BHBTC relay, privacy, exactly-once, agents). Key page shows `#low` ("Running low" / "used up" → "Top it up ↓") when ≤10% of the key is left.
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
  The 4th stats tile shows real requests in the last 24 h, or (when 0 / not live) the cross-provider fallback count.
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
- `test/` — `node:test` units (58; `autotopup.test.ts` = NWC parse/relay filter, NIP-44 spec vectors, payInvoice against a fake relay +
  wallet (nip44/nip04, wallet error codes, TIMEOUT, forged answers ignored), decideAuto/caps, engine crash points; `topup.test.ts` = top-up helpers + `KeyShop.topUp`/`pool` against a fake new-api with rc.22's PUT semantics: crash after write-ahead / after the PUT, calls in between, status 4, refund race, deleted key, paging; `upstreams.test.ts` = anonymize/no host leak/tiers; `keyshop.test.ts` = `aliasesOf`): go-epay signature vectors, submit idempotency, write-ahead settle,
  `decideSettle`, notify (`ledger`/`epay` tests), mint capability check (`gateway.test.ts`).
- `scripts/` — `crash-demo.ts` (kill -9 mid-payment → restart → credited once), `edge-checks.ts` (unhappy paths +
  withdraw), `harness.ts` (shared by those two), `fake-merchant.ts` (stands in for new-api),
  `customer-wallet.ts mint <sats>`, `smoke.ts` (raw NUT-09 idea). All local against testnut, ports 8095/3995.
- `examples/agent-buy-key.ts` — no-dependency agent script: buy → pay (Cashu token arg, else prints the bolt11) → poll
  until `apiKey`; `SHOP=` picks the shop; `--topup sk-… <amount>` tops up a key and prints `{added, remaining}`. Verified on
  testnut with a fake new-api (both paths); `--topup` end to end against a throwaway new-api rc.22 container. Typechecked (tsconfig include).
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

## Rules

- `data/` (seed, ledger proofs, withdrawals) is bearer money: never commit, never print.
- Public repo: no server IP, tunnel URLs, keys, passwords or upstream provider names (suffixes go in `MODEL_ALIAS_SUFFIX`
  in the server `.env`), no "EPay" in public copy. Order ids (`CK…`), `/pay/` URLs and sold keys are bearer secrets.
- Screenshots/images only from `../gallery/` mocks, never from a real `/pay/` page.
