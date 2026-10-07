# HTTP API

Everything the gateway serves. JSON in and out unless noted; errors are `{"error": "<message>"}` with a
4xx/5xx status. Times are Unix milliseconds unless noted. API calls with a sold key don't go here: they go
to new-api's `/v1/*` (OpenAI / Anthropic compatible).

**Order ids are capabilities.** A key order id (`CK` + 32 hex = 128 random bits) is the only thing needed to
read the order and its key. Treat `/pay/<id>` and `/api/order/<id>` URLs as secrets.

## Key shop

### `GET /api/shop`

```json
{ "enabled": true, "amounts": ["1", "2", "5", "10"], "fiat": "eur" }
```

`enabled` is false when the key shop isn't configured (then `/api/buy` and `/api/models` return 404).
`amounts` are in `fiat`, the gateway's `FIAT`; all key shop money below is in that currency.

### `POST /api/buy`

Create a key order. The price in sats is locked now; no mint call is made yet.

```sh
curl -s -XPOST https://shop.example.com/api/buy -H 'content-type: application/json' -d '{"money": 1}'
```
```json
{ "id": "CK3F9A…" }
```

`money` must be one of `amounts` (string or number). Then send the customer to `/pay/<id>`, or drive the
order through the endpoints below.

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
(`openai`, `anthropic`). (Values above are illustrative.)

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
| `keyError` | key orders: why creating the key failed so far (it is retried with backoff) |
| `kind` | `key` for key shop orders; absent for top-up orders (`CE…` ids) |
| `returnUrl` | top-up orders: where to send the customer back after payment (signed) |

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
| `GET /pay/:id` | checkout: ⚡ invoice + QR, 🥜 paste / scan a token, then the key, snippets and usage |
| `GET /network` | upstream network: anonymized providers (A, B, …) and channels, routing per model, latest real calls (only if `UPSTREAMS_FILE` is set) |
| `GET /admin.html#key=<ADMIN_KEY>` | operator page: balance, orders, withdraw |

## Operator

Both need `?key=<ADMIN_KEY>`; a wrong key gets `403 forbidden`.

### `GET /admin?key=…`

```json
{ "balance": 3476, "nextCounter": 120, "mint": "https://mint.example.com", "tokenOverHttp": false,
  "orders": [ … ] }
```

`orders` are the full ledger orders minus bearer material (no token, keys masked to their first 7 characters).

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
