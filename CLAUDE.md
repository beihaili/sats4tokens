# cashu-epay

EPay (易支付)-compatible Bitcoin payment gateway for new-api: customers top up with Lightning or
Cashu ecash, no account details, no KYC. bitcoin++ Berlin 2026 (payments edition) hackathon project.

## Layout

- `src/epay.ts` — EPay MD5 signing/verification (same rule as go-epay, both directions)
- `src/ledger.ts` — orders + durable JSON ledger + pure decision logic (`checkSubmit`, `beginSettle`,
  `finishSettle`, `decideSettle` recovery table, notify backoff). No network.
- `src/gateway.ts` — the engine: one deterministic (seed-backed) cashu-ts wallet. Lightning = mint
  quote → mint when PAID; Cashu = swap the pasted token. Write-ahead of the counter range before every
  mint call; `recover()` uses NUT-09 restore after crashes. `CRASH_AT=after-writeahead|after-mint`
  kills the process for the crash demo. On startup `mintProblems()` checks the mint's NUT-06 info and
  refuses to start without bolt11 sat minting (NUT-04), state checks (NUT-07) and restore (NUT-09).
  Pasted tokens may carry a `cashu:` URI prefix.
- `src/server.ts` — node:http: `/submit.php` (from new-api), `/pay/:id` checkout, `/api/order/:id[...]`,
  `/admin?key=` (JSON), `POST /admin/withdraw?key=` (balance → token file in `DATA_DIR/withdrawals/`,
  written before the proofs leave the ledger; the token is also returned only if `WITHDRAW_TOKEN_OVER_HTTP=1`),
  notify loop (GET notify_url until it answers `success`).
- `src/cli.ts` — operator CLI (`balance`, `withdraw`); goes through HTTP so it never races the server's ledger.
- `src/price.ts` — fiat→BTC (CoinGecko, 60s cache, or `BTC_PRICE`).
- `web/admin.html` — operator page, `/admin.html#key=EPAY_KEY` (key stays in the hash, out of access logs):
  balance, orders, one-click withdraw with a Copy button for the token (when the gateway returns it).
- `web/` — mobile checkout page (Lightning invoice created lazily when the ⚡ tab is opened; opening tab
  from `CHECKOUT_TAB` or `#ln`/`#cashu`; pasting a whole token pays at once; token errors stay visible across polls).
- `test/` — `node:test` units (18): go-epay signature vectors, submit idempotency, write-ahead settle,
  `decideSettle`, notify (`ledger`/`epay` tests), mint capability check (`gateway.test.ts`).
- `scripts/` — `crash-demo.ts` (kill -9 mid-payment → restart → credited once), `edge-checks.ts` (unhappy paths +
  withdraw), `harness.ts` (shared by those two), `fake-merchant.ts` (stands in for new-api),
  `customer-wallet.ts mint <sats>`, `smoke.ts` (raw NUT-09 idea). All local against testnut, ports 8095/3995.
- `Dockerfile`, `deploy/demo/` — demo stack on the relay server (see `deploy/demo/README.md`).

## Run

```sh
EPAY_KEY=demo-key PORT=8091 npm run gateway         # env: EPAY_PID MINT_URL DATA_DIR ORDER_TTL_MIN FIAT BTC_PRICE SEED CHECKOUT_TAB=ln|cashu WITHDRAW_TOKEN_OVER_HTTP=1
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 node scripts/fake-merchant.ts
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 npm run cli balance   # or: withdraw
npm test && npm run typecheck                         # units (offline)
npm run edge-checks                                   # 15 e2e checks against testnut (~40s)
npm run crash-demo -- cashu after-mint                # or lightning / after-writeahead; all 4 verified
```

(zsh doesn't word-split `$var`; pass the two crash-demo args literally.)

new-api side: 支付设置 → PayAddress = gateway URL, EpayId = `EPAY_PID`, EpayKey = `EPAY_KEY`,
PayMethods `[{"name":"Bitcoin","color":"#f7931a","type":"bitcoin"}]`, payment compliance confirmed.

## Demo deployment (live)

`api-relay:/opt/cashu-epay-demo` — new-api demo on :8530, gateway on :8531, channels copied
read-only from production. Verified end to end 2026-10-01: cashu token and lightning top-ups credited
in new-api (`topup` status success), a real model call works through the copied channels.
Production `/opt/new-api-relay/AGENTS.md` has a one-line note about this stack (top of 项目说明).
Plan/pitch: `../dev-plan.md`, `../pitch.md`.

## Rules

- `data/` (seed, ledger proofs, withdrawals) is bearer money: never commit, never print.
- Never touch production containers/DB/Redis on api-relay; the demo stack is separate on purpose.
