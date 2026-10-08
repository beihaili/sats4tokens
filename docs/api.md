# HTTP API

Everything the gateway serves. JSON in and out unless noted; errors are `{"error": "<message>"}` with a
4xx/5xx status. Times are Unix milliseconds unless noted. API calls with a sold key don't go here: they go
to new-api's `/v1/*` (OpenAI / Anthropic compatible).

**Order ids are capabilities.** A key order id (`CK` + 32 hex = 128 random bits) is the only thing needed to
read the order and its key. Treat `/pay/<id>` and `/api/order/<id>` URLs as secrets.

## Key shop

### `GET /api/shop`

```json
{ "enabled": true, "amounts": ["1", "2", "5", "10"], "fiat": "eur", "sats": { "1": 1337, "2": 2674, "5": 6685, "10": 13369 }, "bonus": { "5": 5, "10": 10 }, "soldOut": false }
```

`enabled` is false when the key shop isn't configured (then `/api/buy` and `/api/models` return 404).
`amounts` are in `fiat`, the gateway's `FIAT`; all key shop money below is in that currency. `sats` is what each
amount costs at the current BTC price (an order locks its own price when it's created); omitted if the price feeds are slow or down.
`bonus` = extra quota in percent per amount (here €5 → €5.25 on the key, €10 → €11), for new keys, top-ups and auto
top-ups alike, paid with ⚡ or 🥜; amounts not listed get none. The bonus is locked into an order when it is made.

`amounts` only lists what the key pool can still cover (see `POOL_RESERVE` in the self-hosting guide); when it
can't cover even the smallest amount, `amounts` is empty and `soldOut` is true. If new-api can't be read in time
the list isn't filtered.

### `POST /api/buy`

Create a key order. The price in sats is locked now; no mint call is made yet.

```sh
curl -s -XPOST https://shop.example.com/api/buy -H 'content-type: application/json' -d '{"money": 1}'
```
```json
{ "id": "CK3F9A…" }
```

`money` must be one of `amounts` (string or number). Then send the customer to `/pay/<id>`, or drive the
order through the endpoints below. 503 `sold out right now: …` if the key pool can't cover `money` (try a smaller
amount, or later).

**Top up a key.** Add `key` (a key sold by this shop, with or without `sk-`) to put the money on that key instead
of making a new one:

```sh
curl -s -XPOST https://shop.example.com/api/buy -H 'content-type: application/json' -d '{"money": 2, "key": "sk-…"}'
```

It returns a top-up order (`kind: "keytopup"`, also a `CK…` id) that is paid exactly like a key order. When it is
`PAID`, the money is added to the key's balance, once. The key goes in the body so it never ends up in a URL or
an access log, and the top-up order never shows it (only its last 4 characters), so a top-up link can be sent to
someone else to pay. 404 `unknown key` if the key wasn't sold here.

### `POST /api/autotopup`

Auto top-up of a key sold here, paid by the customer's own wallet over [Nostr Wallet Connect](https://nwc.dev)
(NIP-47). The key in the body is the authorization, as for top-ups.

```sh
curl -s -XPOST https://shop.example.com/api/autotopup -H 'content-type: application/json' \
  -d '{"key": "sk-…", "nwc": "nostr+walletconnect://…", "money": 2, "below": 0.5, "perDay": 10}'
```

| field | meaning |
|---|---|
| `nwc` | connection string from the wallet (needs the `pay_invoice` permission; give it a budget there). Only public `wss://` relays are used. Omit it to change the settings of a saved connection (this also resumes a paused one) |
| `money` | each top-up, one of the shop's `amounts` |
| `below` | top up when the key holds less than this (in `fiat`), 0 < below ≤ 100 |
| `perDay` | at most this much in any 24 hours, from `money` up to 500 |

Saving asks the wallet's relay for its info event: 400 if the wallet says it can't `pay_invoice`; if no info is
found it is saved anyway with a note. `{"key": "sk-…", "off": true}` turns it off and deletes the connection;
`{"key": "sk-…"}` returns the status. All three answer `{"auto": …}` (the `auto` field below, or `null`). The
connection string is never returned.

How it runs: every `AUTO_TOPUP_EVERY_S` (default 60) the gateway reads each such key's balance. Below `below` it
makes a normal key top-up order (pool check included), creates its invoice and sends the wallet one `pay_invoice`.
The invoice of an order goes to the wallet at most once. A new order waits until the previous one is finished,
expired, or clearly refused by the wallet. Orders the wallet may have paid count toward `perDay`. Three failures
in a row pause it until the settings are saved again.

### `GET /api/models`

Models a sold key can call, with prices for the pool user's group (cached 5 minutes):

```json
[
  { "model": "deepseek-v4-flash", "vendor": "DeepSeek", "input": 0.14, "output": 0.28, "cacheRead": 0.028,
    "fastTier": false, "endpoints": ["openai"] },
  { "model": "some-image-model", "vendor": "…", "perCall": 0.04, "fastTier": false, "endpoints": ["openai"] }
]
```

`input` / `output` / `cacheRead` are `fiat` per 1M tokens; `perCall` is `fiat` per call (models billed per request);
`fastTier` means a faster service tier is available at a higher price; `endpoints` lists the API styles
(`openai`, `anthropic`). (Values above are illustrative.) Names matching `MODEL_ALIAS_SUFFIX` whose base model is listed too are left out
(they still work with a key); `/api/network` does the same.

### `GET /api/network`

Data for the `/network` page; 404 `network view not enabled` unless `UPSTREAMS_FILE` is set. Returns
`{ generatedAt, providers, routes, live, recent }`: `providers` are letters (`A`, `B`, …, one per upstream domain)
with their channel nodes (`A1`, `A2`, …), `routes` is the routing table per model (tiers by priority, share by
weight), `recent` the latest real calls of the key shop pool (hashed request id, time, model, node). No provider
names, hosts, keys or channel ids. The snapshot file is exported on the server from new-api's channels
(`scripts/export-upstreams.ts`) and re-read when it changes.

## Orders

### `GET /api/order/:id`

The order as the checkout page sees it. Polling it also tells the gateway someone is waiting, so this
order's invoice is checked first.

```json
{
  "id": "CK3F9A…",
  "kind": "key",
  "name": "AI API key · €1",
  "money": "1",
  "fiat": "eur",
  "sats": 1161,
  "btcPrice": 86134.5,
  "state": "PAID",
  "mint": "https://mint.example.com",
  "tab": "ln",
  "expiresAt": 1790930000000,
  "paid": { "at": 1790928612000, "via": "lightning", "sats": 1161, "fee": 0 },
  "apiKey": { "key": "sk-…", "baseUrl": "https://shop.example.com/v1", "tokenId": 42 },
  "returnUrl": ""
}
```

| field | meaning |
|---|---|
| `state` | `PENDING` (waiting for payment) · `SETTLING` (payment seen, ecash being minted) · `PAID` · `EXPIRED` |
| `invoice` | bolt11 invoice, present only while `PENDING`/`SETTLING` and after one was created |
| `mint` | the only mint whose Cashu tokens are accepted |
| `tab` | the checkout's default tab (`ln` / `cashu`) |
| `lastError` | why the last payment attempt failed (e.g. a rejected token), if any |
| `paid` | `via` = `lightning` / `cashu`; `sats` received after mint fees; `fee` = mint fee absorbed |
| `apiKey` | key orders, once `PAID` and the key is created. `baseUrl` is the endpoint to use |
| `keyError` | key orders: why creating the key failed so far; key top-ups: why adding the money failed so far (both retried with backoff) |
| `topups` | key orders: paid top-ups of this key, `[{at, money, fiat, applied, needsRefund, auto}]` (`auto`: made by auto top-up) |
| `auto` | key orders: auto top-up settings and state, or `null` when off: `{money, below, perDay, wallet, relay, paused, failures, lastError, spent24h, last: {at, money, state, outcome, applied}}`. `wallet` and `relay` are hints only (the wallet's pubkey prefix, the relay host); `outcome` = `paid` / `declined` / `unknown` (no readable answer: the order stays open until it expires, as it may have been paid) |
| `topup` | key top-ups: `{key: "sk-…a1b2", applied?: {at, remaining}, needsRefund}`. `applied.remaining` = the key's balance right after (in `fiat`). `needsRefund` is true if the key was deleted before the money could be added: the operator refunds by hand |
| `bonus` | key shop orders: extra quota in percent of `money` (the key gets `money × (1 + bonus/100)`), absent if none |
| `kind` | `key` for key orders, `keytopup` for key top-ups; absent for account top-up orders (`CE…` ids) |
| `returnUrl` | account top-up orders: where to send the customer back after payment (signed) |

Fields that don't apply are omitted (here: `invoice`, `lastError`, `keyError`). An `EXPIRED` order whose invoice is paid within 24 hours still becomes `PAID`.

### `POST /api/order/:id/invoice`

Create the Lightning invoice (a NUT-04 mint quote) if the order doesn't have one yet, and return the order
(as above, with `invoice`). Idempotent: an order that already has an invoice, or is no longer pending, is returned as is. The checkout
calls this only when the ⚡ tab is opened, so orders paid with Cashu never create a quote. 400 `order expired`
if the order expired before an invoice was created.

### `GET /api/order/:id/qr.svg`

QR code (SVG) of `lightning:<INVOICE>`. 404 until an invoice exists.

### `POST /api/order/:id/token`

Pay with a Cashu token.

```json
{ "token": "cashuB…" }
```

The token is checked (valid, `sat` unit, from our mint, at least `sats`, unspent), then swapped for proofs
of our own. On success returns the order, now `PAID`. On failure 400 with a message, for example:

- `this token is from https://other.mint — ecash only works at the mint that issued it; …`
- `token is 1000 sat, order needs 1161 sat`
- `token already spent`
- `order expired — go back and create a new one`

A `cashu:` prefix is accepted. Overpayment is kept (a token can't be split here).

**Retries are safe.** Sending the same token again for the order it paid (or is paying) returns `200` and the
order, and nothing happens twice. A different token for a paid order gets 400 `order is paid`.

### `GET /api/order/:id/usage`

Key orders only, once the key exists: balance and the latest 20 calls, straight from new-api. No prompts,
IPs or channels.

```json
{
  "used": 0.0123,
  "remaining": 0.9877,
  "fiat": "eur",
  "totalCalls": 3,
  "calls": [
    { "time": 1790928700, "model": "deepseek-v4-flash", "promptTokens": 812, "completionTokens": 240,
      "cost": 0.0041, "seconds": 2 }
  ]
}
```

`used` / `remaining` / `cost` are in `fiat`. `time` is in Unix seconds (new-api's log time). 404 `no key yet` before the key exists; 502 if new-api is unreachable.

## Pages

| path | page |
|---|---|
| `GET /` | key shop: amounts, model list with a cost calculator |
| `GET /pay/:id` | checkout: ⚡ invoice + QR, 🥜 paste / scan a token, then the key, snippets, usage and "Top up this key" (a key top-up shows only the amount added and the new balance) |
| `GET /network` | upstream network: anonymized providers (A, B, …) and channels, routing per model, latest real calls (only if `UPSTREAMS_FILE` is set) |
| `GET /admin.html#key=<ADMIN_KEY>` | operator page: balance, orders, withdraw |

## Operator

Both need `?key=<ADMIN_KEY>`; a wrong key gets `403 forbidden`.

### `GET /admin?key=…`

```json
{ "balance": 3476, "nextCounter": 120, "mint": "https://mint.example.com", "tokenOverHttp": false, "fiat": "eur",
  "pool": { "quota": 133.2, "owed": 21.5, "available": 111.7, "pending": 2, "reserve": 10, "alert": 30 },
  "orders": [ … ] }
```

`orders` are the full ledger orders minus bearer material (no token, keys masked to their first 7 characters).
`pool` (key shop only, in `fiat`): `quota` = the pool user's quota in new-api, `owed` = what sold keys can still
spend, `available` = the difference, `pending` = open orders that may still become keys or top-ups; the shop sells
an amount only while `amount + reserve ≤ available − pending`, and logs a warning when `available < alert`.
Absent if new-api didn't answer within 5 seconds. Top-ups with `topup.needsRefund` are listed on the admin page for a manual refund.

### `POST /admin/withdraw?key=…`

Move the whole balance into one Cashu token, written to `DATA_DIR/withdrawals/withdraw-*.txt` before the proofs
leave the ledger.

```json
{ "file": "/data/withdrawals/withdraw-….txt", "sats": 3476, "token": "cashuB…" }
```

`token` is included only with `WITHDRAW_TOKEN_OVER_HTTP=1`. 400 `balance is 0` when there's nothing to withdraw.

The CLI wraps both: `ADMIN_KEY=… GATEWAY=http://127.0.0.1:8090 npm run cli balance` (or `withdraw`).

## Top-ups

### `GET|POST /submit.php`

Entry point for new-api's online-payment top-ups. new-api redirects the customer here with a signed form
(`pid`, `type`, `out_trade_no`, `notify_url`, `return_url`, `name`, `money`, `sign`, `sign_type`). The gateway
verifies the signature, creates the order (idempotent per `out_trade_no`: the same request returns the same order,
the same request with a different amount is rejected) and answers `302 /pay/<id>`. Errors are plain-text `400`
(`invalid sign`, `unknown pid`, `bad money`, …).

After payment the gateway calls `notify_url` with signed parameters (`trade_status=TRADE_SUCCESS`) until it
answers `success`, backing off from 5 s to 10 min between attempts.
