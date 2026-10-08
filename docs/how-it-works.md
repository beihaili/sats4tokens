# How it works

The gateway is one Node process with one Cashu wallet and one JSON ledger. It has no Lightning node and
no database. This page follows an order from creation to credit, and explains why a crash at any point
credits it exactly once.

## Pieces

| file | role |
|---|---|
| `src/server.ts` | HTTP: shop, checkout, order API, operator API, top-up form; the watcher and notify loops |
| `src/gateway.ts` | the payment engine: seed-backed cashu-ts wallet, write-ahead settle, recovery, NUT-17 push, polling budget |
| `src/ledger.ts` | order records, the durable ledger file, and the pure decision logic (no network, unit-tested) |
| `src/keyshop.ts` | paid key order → capped new-api token; usage and model prices |
| `src/nwc.ts` | Nostr Wallet Connect (NIP-47) client: one `pay_invoice` per call, NIP-44 v2 / NIP-04 |
| `src/autotopup.ts` | auto top-up: which low keys get an order, send-once rules, caps, pause |
| `src/price.ts` | fiat → BTC price with fallbacks |
| `src/upstreams.ts` | anonymized upstream network for `/network`: providers as letters, routing per model, no names or hosts |

## Order lifecycle

```
              ┌─────────── paid (⚡ quote PAID, or 🥜 token accepted) ──────────┐
              │                                                                  ▼
  create ─► PENDING ──── write-ahead saved ────► SETTLING ──── proofs saved ───► PAID ──► credit
              │  ▲                                  │                                    (key / callback)
     TTL over │  └──── abort: token spent elsewhere ┘
              ▼
           EXPIRED ── invoice paid within 24 h ──► SETTLING ─► PAID
```

1. **Create.** `POST /api/buy` (key) or `/submit.php` (top-up). The BTC price is fetched (CoinGecko →
   Coinbase → mempool.space, or a ≤10-min-old price if all fail) and **locked into the order**; sats are
   rounded up. No mint call yet.
2. **Pay with ⚡.** When the customer opens the ⚡ tab, the gateway creates a mint quote (NUT-04 bolt11) and
   shows its invoice. It subscribes to that quote over the mint's WebSocket (NUT-17). When the mint pushes
   `PAID`, one HTTP check confirms it and the gateway mints ecash to its own wallet.
3. **Pay with 🥜.** The pasted token is checked locally (valid, `sat`, our mint, enough sats), then its proofs'
   states are checked at the mint (NUT-07, must be `UNSPENT`), then it is swapped (NUT-03) for fresh proofs that
   only the gateway can spend. The customer's token is now worthless to anyone else.
4. **PAID.** The new proofs go into the ledger; `paid` records how, how much arrived, and the mint fee.
5. **Credit.** The notify loop (every 2 s) picks up paid orders:
   - key order → find-or-create the new-api token `btc-<orderId>` with `remain_quota = money / price × quota_per_unit`,
     never expiring, then read its key. Stored on the order and shown on `/pay/<id>`.
   - top-up → the signed callback to new-api, until it answers `success`.

   Failures are retried with backoff (5 s, doubling, up to 10 min); the error is shown on the checkout page.
6. **Expire.** An unpaid order expires after `ORDER_TTL_MIN` (30). Tokens are no longer accepted, but an
   existing invoice is still watched for 24 hours: Lightning money that arrives late is still credited.

## The ledger

`DATA_DIR/ledger.json` holds every order, the proofs the gateway owns, and `nextCounter` (see below). Every
write goes to a temp file, is fsync'ed, and atomically renamed over the old one: after a crash the file is the
old version or the new one, never half of each. All mint-touching work runs in one serial queue, so two
payments never race for the same counters.

Bearer material is kept only as long as needed: a pasted token is stored while its order is `SETTLING` (recovery
needs it) and deleted once the order is `PAID`. The operator API never returns tokens and masks keys.

## Exactly once

The dangerous moment: the mint signs our outputs, and the process dies **before** saving them. The money exists,
but nobody holds it — or a naive retry pays twice.

**Deterministic outputs (NUT-13).** Every blinded output is derived from `(seed, counter)`. The same counter
always produces the same outputs, and a mint signs a given output only once.

**Write-ahead.** Before every mint call (`mint` for ⚡, `swap` for 🥜) the gateway claims a counter range:
it writes `{via, keysetId, counter, count}` into the order, moves it to `SETTLING`, advances `nextCounter` and
**saves the ledger**. Only then does it call the mint. So a crash leaves one of three states:

- before the save: the order is still `PENDING`, nothing was sent — it is simply paid again later;
- after the save, before the mint answered: `SETTLING`, unknown whether the mint signed;
- after the mint answered, before the proofs were saved: `SETTLING`, the mint signed but we lost the reply.

**Recovery.** On start and every watcher pass, each `SETTLING` order is resolved. The gateway asks the mint for
the signatures on exactly the claimed outputs (**NUT-09 restore**) and, if none, checks the quote or the
customer's proofs, then follows one table (`decideSettle` in `src/ledger.ts`):

| # | facts | action |
|---|---|---|
| 1 | restore finds our outputs | **finish** — the mint signed, we only lost the reply |
| 2 | ⚡, quote `PAID` (not yet issued) | **retry** with the same counter → identical outputs, signable once |
| 3 | ⚡, quote `ISSUED` / `UNPAID` but nothing restored | **conflict** → stop, a human looks |
| 4 | 🥜, customer's proofs `UNSPENT` | **retry** the swap with the same counter |
| 5 | 🥜, proofs `PENDING` at the mint | **wait**, check again next pass |
| 6 | 🥜, proofs `SPENT` but nothing restored | **abort** — spent elsewhere; the order goes back to `PENDING` |

`npm run crash-demo -- <lightning|cashu> <after-writeahead|after-mint>` kills the gateway with `kill -9` at
both points for both payment paths and restarts it. All four end the same way: credited once; replaying the
token is rejected.

**Crediting is idempotent too.** The key's name comes from the order id and is looked up before creating, so a
crash between "token created" and "key saved" finds the same token. Top-up callbacks may arrive more than once;
new-api credits each order once on its side.

## Being polite to the mint

Public mints rate-limit and firewall IPs that poll hard (during the hackathon one mint refused our server after
hours of 4 quotes every 2 s; another answered `429` at ~24 quote checks per minute). So:

- **NUT-17 push is the primary signal.** One WebSocket for all quotes. On a subscription error the gateway
  polls only for 30 s, then subscribes again.
- **HTTP polling is a budgeted safety net.** The watcher runs every 2 s but checks **at most one quote per 8 s**
  across all orders — the most overdue one. Per order: every 60 s while subscribed; without a subscription 8 s if a
  checkout page is open (it polled `/api/order/:id` in the last 20 s), else 30 s; expired orders every 120 s.
- **Backoff.** A network error or `429` pauses all polling, 5 s doubling up to 60 s.
- **Capability check.** On start the gateway reads the mint's NUT-06 info and refuses to run without NUT-04
  (bolt11, sat), NUT-07 and NUT-09 — without them a crash mid-payment couldn't be recovered.
- Invoices are created lazily (only when the ⚡ tab is opened), so Cashu payers leave no quote to watch.

## Withdraw

`POST /admin/withdraw` turns the whole balance into one Cashu token. The token file is written to
`DATA_DIR/withdrawals/` **before** the proofs are removed from the ledger, so a crash or a lost reply leaves the
money in the file, never nowhere. The operator receives the token in any Cashu wallet.

## Key shop and new-api

The gateway talks to new-api as one normal **pool user**, using that user's system access token
(`Authorization: <token>`, `New-Api-User: <id>`). It never holds admin credentials.

| call | why |
|---|---|
| `GET /api/status` | `quota_per_unit` (quota per unit), `price` (the top-up price of a unit, in `FIAT`) and the server address (default key endpoint) |
| `GET /api/token/search?keyword=btc-<id>` | find-or-create: is this order's token already there? |
| `POST /api/token/` | create the token: `remain_quota = money / price × quota_per_unit`, `unlimited_quota: false`, `expired_time: -1` |
| `POST /api/token/:id/key` | read the full key |
| `GET /api/token/:id`, `GET /api/log/self?type=2&token_name=btc-<id>` | usage page: balance and the last 20 calls |
| `GET /api/pricing`, `GET /api/user/self` | model list and prices for the pool user's group |

Each key has its own hard cap, enforced by new-api. new-api also reserves quota for a request's `max_tokens` up
front, which is why clients with a large default output limit (Claude Code) need a lower one on small keys.

### Topping up a key

| call | why |
|---|---|
| `GET /api/token/:id` | the key's `remain_quota`, `used_quota` and status, plus every other field to send back |
| `PUT /api/token/` | set `remain_quota`. new-api writes every editable field from the body, so the whole token goes back with only `remain_quota` changed |
| `PUT /api/token/?status_only=true` | turn a used-up key (status 4) back on, once it has quota again |

new-api moves quota between `remain_quota` and `used_quota` on every call, reservation and refund, so their sum
is everything ever put on the key. That sum is the top-up's checkpoint:

1. Read the key. If the order has no `base` yet, write `base = remain + used` and `add = money / price ×
   quota_per_unit` to the ledger and fsync it before anything changes.
2. `missing = base + add − (remain + used)`. If it is above 0, add `missing` to `remain_quota`.
3. Read the key again: done only if the sum reached `base + add` and the key isn't still marked used up;
   otherwise retry with backoff.

A crash before step 2 lands adds the money on the retry; a crash after it finds nothing missing. Calls in
between don't change the sum. Two top-ups of one key run one after the other (a second one doesn't take its
`base` while the first is unfinished). One small gap: the PUT sets an absolute value, so a charge that lands in
the milliseconds between the read and the write is overwritten (a few cents in the customer's favour); a refund
in that window leaves the sum short, step 3 notices and the retry adds the rest. If the key no longer exists, the
top-up is marked `needsRefund` for the operator.

### Auto top-up (Nostr Wallet Connect)

`src/nwc.ts` is a small NIP-47 client: it parses `nostr+walletconnect://` strings, reads the wallet's info event
(kind 13194: methods, and `nip44_v2` or NIP-04 encryption), and sends one `pay_invoice` request (kind 23194, signed
with the connection's secret, encrypted to the wallet, with an `expiration` tag). Then it waits for the answer
(kind 23195 tagged with the request id, signed by the wallet). Its NIP-44 code is checked against the spec's test
vectors and against nostr-tools.

`src/autotopup.ts` runs every `AUTO_TOPUP_EVERY_S`. For each key with auto top-up on, it reads the key's balance
and, below the threshold, makes a normal top-up order and sends its invoice to the wallet. The rest is the usual
path: the mint sees the invoice paid, the gateway mints, and the top-up is added once (above). The rules that keep
it from paying twice:

1. **One request per invoice.** `auto.sentAt` is written to the ledger and fsynced before the request goes out.
   After a restart, an order with `sentAt` but no answer is marked `unknown` and never sent again. An order
   without `sentAt` was never sent, so it is sent now.
2. **One open order per key.** A new order waits until the last one is finished, expired, or `declined` (the wallet
   answered with an error such as `INSUFFICIENT_BALANCE` or `QUOTA_EXCEEDED`, so it wasn't paid). Silence, or an
   answer we can't read, means it may have been paid: the order stays open until it expires, and a late payment is
   still credited.
3. **Caps.** Orders that were or may have been paid count toward `perDay`. Failures back off (10 minutes × the
   count), and 3 in a row pause auto top-up until the customer saves again. The wallet's own budget is the outer limit.

The connection string is a spending credential for the customer's wallet. It lives in the ledger (mode 600, like
the proofs) and never appears in an API answer, the admin JSON or the log. Relays must be public `wss://` hosts
(no IPs, `localhost` or single-label names), so a connection string can't make the gateway call internal services.

### The pool

Sold keys are capped tokens of one pool user, and new-api charges each call to the token and to the user. So
the user's quota must cover what all its keys can still spend: `available = user quota − Σ remain_quota` of its
limited, enabled (or used-up) tokens, read with `GET /api/user/self` and the token list (cached 30 s). The shop
offers an amount only while `amount + POOL_RESERVE ≤ available − open orders`; otherwise `/api/buy` answers 503
and the buy page shows "sold out". The check runs when an order is created; if new-api can't be read the shop
stays open. Below `POOL_ALERT` the gateway logs a warning: time to add quota to the pool user.
