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
| `src/price.ts` | fiat → BTC price with fallbacks |

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
   - key order → find-or-create the new-api token `btc-<orderId>` with `remain_quota = money × quota_per_unit`,
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
| `GET /api/status` | `quota_per_unit` (quota units per USD) and the server address (default key endpoint) |
| `GET /api/token/search?keyword=btc-<id>` | find-or-create: is this order's token already there? |
| `POST /api/token/` | create the token: `remain_quota = money × quota_per_unit`, `unlimited_quota: false`, `expired_time: -1` |
| `POST /api/token/:id/key` | read the full key |
| `GET /api/token/:id`, `GET /api/log/self?type=2&token_name=btc-<id>` | usage page: balance and the last 20 calls |
| `GET /api/pricing`, `GET /api/user/self` | model list and prices for the pool user's group |

Each key has its own hard cap, enforced by new-api. new-api also reserves quota for a request's `max_tokens` up
front, which is why clients with a large default output limit (Claude Code) need a lower one on small keys.
