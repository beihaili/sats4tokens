# cashu-epay

**A Bitcoin checkout that speaks EPay.** Customers pay with **Lightning** or **Cashu ecash** — no account,
no KYC, no card — and the shop credits them **exactly once**, even if the gateway is killed mid-payment.

Built at [bitcoin++ Berlin 2026](https://btcpp.dev) (payments edition) for a real shop: my AI API relay
(310 users, ~12 billion tokens a month), which runs [new-api](https://github.com/QuantumNous/new-api).

> **Real money, verified.** 2026-10-02: a $1 top-up paid from a phone wallet on mainnet
> (1158 sat of Coinos ecash) → credited in new-api → withdrawn from the gateway as one Cashu token →
> received back in a phone wallet. No Lightning node on our side at any point.

## Why

Chinese shops — including AI API relays like new-api — take payments through **EPay (易支付)**, a simple
signed-redirect protocol in front of Alipay / WeChat Pay. Both need a real-name account, so every
purchase is tied to an ID card.

cashu-epay is a drop-in EPay payment provider. The shop changes **three settings** and gets a Bitcoin
checkout. **Zero code change** in the shop.

## Key shop: pay, get a key

An AI API relay pools accounts at OpenAI / Anthropic / Google upstream and resells access downstream
through one OpenAI-compatible endpoint. The AI companies see the relay, not the user — but signup and
real-name payment still tie every key to a person.

So the gateway can also sell keys **directly**: open `/`, pick $1 / $2 / $5 / $10, pay with ⚡ or 🥜, and
the checkout page shows an API key **with its endpoint**, capped at exactly what you paid. No signup, no
email, no password — **the key is the account**.

- The key is a new-api token of one pool user, with its own hard quota (`$1` → `$1` of quota).
  The gateway holds only that user's personal access token, not an admin key.
- Exactly once: the token name comes from the order id; the gateway looks it up before creating, so a
  crash between "created" and "saved" finds the same key instead of making a second one.
- The order id is 128 random bits and is the receipt: whoever has the `/pay/…` link can see the key.

## How it works

```
 customer            new-api (shop)                cashu-epay gateway                    Cashu mint
    │  top up $1  ──►  signed EPay form ──► /submit.php ── order, BTC price locked
    │ ◄──────────────────────────────────── /pay/:id checkout page
    │                                          │
    │  ⚡ pay invoice ─────────────────────────┼──── mint quote (bolt11) ─────────────►  receives the sats
    │  🥜 or paste token ──────────────────────┼──── swap (NUT-03) ───────────────────►  blind-signs new proofs
    │                                          │ ◄── "quote PAID" push (NUT-17) ───────
    │                                          │ ──► mint proofs to our seed (NUT-04/13)
    │                       ◄── signed notify ─┤     (retried until the shop says "success")
    │  balance +$1                              │
                                    operator: one click → whole balance as one Cashu token
```

- **The mint is my Lightning node.** For ⚡ the gateway asks the mint for an invoice; when it's paid
  the mint signs ecash for us. For 🥜 the customer pastes a token and we swap it for proofs of our own.
- **Private.** The mint signs blinded messages; it can't link the payer to the shop.
- **EPay both ways.** The incoming form and the outgoing notify are MD5-signed exactly like
  [go-epay](https://github.com/Calcium-Ion/go-epay), the library new-api uses (tested against its vectors).
- **Price.** Fiat → BTC is locked when the order is created (CoinGecko → Coinbase → mempool.space
  fallback, a ≤10-min-old price if all three are down). Sats are rounded up.

## Exactly once: write first, then ask the mint

The dangerous moment: the mint signs our outputs, and the gateway dies **before** saving them. The money
exists, but nobody holds it — or worse, a naive retry credits the order twice.

1. Every output comes from a seed and a counter (**NUT-13**), so it is deterministic.
2. Before **every** mint call, the gateway writes the counter range it will use into the order and saves
   the ledger (write-ahead). Only then does it call the mint.
3. After a crash, the order is in `SETTLING`. The gateway asks the mint "did you sign these exact
   outputs?" (**NUT-09 restore**) and follows one table:

| # | facts | action |
|---|---|---|
| 1 | restore finds our outputs | **finish** — the mint signed, we only lost the reply |
| 2 | lightning, quote PAID | **retry** with the same counter → identical outputs, signable only once |
| 3 | lightning, quote ISSUED / UNPAID | **conflict** → a human looks |
| 4 | cashu, customer's proofs UNSPENT | **retry** |
| 5 | cashu, proofs PENDING | **wait** |
| 6 | cashu, proofs SPENT | **abort** (the token was spent elsewhere) |

`npm run crash-demo` kills the gateway with `kill -9` at both crash points, for both payment paths.
All four cases end the same way: credited once, replaying the token is rejected.

The notify to the shop is at-least-once with backoff; new-api credits each order once on its side.

## Polite to public mints

Public mints rate-limit and firewall IPs that poll hard. (We learned this on demo day: one mint refused
our server after hours of polling 4 quotes every 2 s; another answered `429` at ~24 quote checks/min.)

- **NUT-17 push** is the primary signal: one WebSocket, the mint pushes "quote PAID", then a single
  HTTP check confirms it and we mint.
- HTTP polling is only a safety net with a hard budget: ≤ 1 quote check per 8 s across all orders,
  60 s per order while subscribed, open checkout pages first, and backoff (5 s → 60 s) on network errors or `429`.
- On startup the gateway refuses any mint without NUT-04 (bolt11, sat), NUT-07 and NUT-09.

## Cashu NUTs used

NUT-03 swap · NUT-04 mint from Lightning · NUT-06 mint info check · NUT-07 proof states ·
NUT-09 restore · NUT-13 deterministic secrets · NUT-17 WebSocket subscriptions

## Run it

Node ≥ 22 (runs TypeScript directly, no build step).

```sh
npm install
EPAY_KEY=demo-key PORT=8091 npm run gateway          # testnut by default
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 node scripts/fake-merchant.ts   # stands in for new-api
EPAY_KEY=demo-key GATEWAY=http://127.0.0.1:8091 npm run cli balance              # or: withdraw
```

| env | meaning |
|---|---|
| `EPAY_KEY` (required), `EPAY_PID` | merchant key / id — the same values go into new-api |
| `MINT_URL` | Cashu mint (default `https://testnut.cashu.space`) |
| `FIAT`, `BTC_PRICE` | currency of the shop's `money` field (default `cny`); fixed price for offline demos |
| `ADMIN_KEY` | operator page key — keep it different from `EPAY_KEY` (that one can sign "paid" notifies) |
| `DATA_DIR`, `ORDER_TTL_MIN`, `CHECKOUT_TAB=ln\|cashu`, `WITHDRAW_TOKEN_OVER_HTTP=1` | storage, order lifetime, default tab, show withdrawn token on the page (https only) |
| `NEWAPI_URL`, `NEWAPI_USER_ID`, `NEWAPI_TOKEN`, `KEY_BASE_URL` | turn on the key shop: new-api URL, pool user id + its personal access token, endpoint shown with the key (default new-api's ServerAddress + `/v1`). Needs `FIAT=usd` |

**new-api side** — 支付设置: `PayAddress` = gateway URL, `EpayId` = `EPAY_PID`, `EpayKey` = `EPAY_KEY`,
`PayMethods` = `[{"name":"Bitcoin","color":"#f7931a","type":"bitcoin"}]`.

**Operator** — `/admin.html#key=ADMIN_KEY`: balance, orders, one-click withdraw of the whole balance as
one Cashu token (always written to `DATA_DIR/withdrawals/` before the proofs leave the ledger).

## Tests

```sh
npm test && npm run typecheck      # 18 unit tests, offline: go-epay vectors, idempotent submit, write-ahead, decideSettle, notify, mint checks
npm run edge-checks                # 15 end-to-end checks against testnut (~40 s): bad signatures, underpaid / spent tokens, notify retries, withdraw
npm run crash-demo -- lightning after-mint   # or: cashu | after-writeahead
```

## Layout

```
src/epay.ts      EPay MD5 sign / verify
src/ledger.ts    orders, durable JSON ledger, pure decision logic (no network)
src/gateway.ts   the engine: seed-backed cashu-ts wallet, write-ahead settle, NUT-09 recovery, NUT-17 push
src/server.ts    HTTP: /submit.php, key shop (/ , /api/buy), checkout, order API, operator API, notify loop
src/keyshop.ts   paid key order → capped new-api token (find-or-create by name)
src/price.ts     fiat → BTC with fallbacks
web/             mobile checkout page + operator page
deploy/demo/     the live demo stack (a private copy of the relay, isolated from production)
```

About 1,500 lines for the gateway and pages, 600 for tests and scripts. Dependencies: `@cashu/cashu-ts`, `qrcode`.

## Limits and next steps

- **One mint per gateway.** A token from another mint is rejected with a clear message (pay with ⚡ instead).
  Next: a list of trusted mints, or melting foreign tokens to pay our invoice.
- **Overpayment is kept** (a pasted token can't be split here; the page shows the exact amount).
- **The mint is custodial** until you withdraw — so withdraw often, or run your own mint.
- Next: NUT-18 payment requests (scan instead of paste), automatic melt to the operator's Lightning
  wallet, pay-per-request with Cashu tokens in the API header.

## Safety

`data/` holds the wallet seed and ecash proofs — **bearer money**. It is git-ignored; back up `seed.hex`.
