# Self-hosting

Run your own Sats4Tokens shop in front of a [new-api](https://github.com/QuantumNous/new-api) relay.
Customers pay sats, the gateway creates a new-api key capped at what they paid. The gateway never needs a
Lightning node: the Cashu mint receives the Lightning payment and signs ecash to the gateway's wallet.

```
                    https://shop.example.com
customer ──► reverse proxy ──┬── /v1/*  ──► new-api :3000   (API calls with the sold key)
                             └── rest   ──► gateway :8090   (shop, checkout, order API)
                                              │  ├── Cashu mint (⚡ invoices, swaps, NUT-17 push)
                                              │  └── new-api admin API as the pool user (create keys)
                                              └── /data: seed + ledger (bearer money)
```

## What you need

1. **A running new-api** with channels and pricing set up (the gateway sells access to whatever it serves).
2. **A pool user** in new-api. Every sold key is a token of this user, so:
   - create a normal user (e.g. `keyshop`) — not an admin;
   - its **group** decides which models the keys can call (and their price ratio);
   - give it a large **quota** as root (Users → Edit). Each key has its own hard cap; the pool quota only
     needs to cover all keys sold. Top it up as you sell;
   - log in as that user, open personal settings and generate a **system access token**
     (API: `GET /api/user/token`). This token is user-level only: it can manage that user's tokens and
     read its logs, nothing else.
3. **A Cashu mint** that supports, per its `/v1/info`:
   - NUT-04 minting with `bolt11` + `sat` (Lightning in),
   - NUT-07 proof state checks and NUT-09 restore (crash recovery),
   - NUT-17 WebSocket subscriptions (recommended — without it the gateway falls back to slow polling).

   The gateway refuses to start if the first three are missing. Check a mint with:

   ```sh
   curl -s https://mint.example.com/v1/info | jq '.nuts | {"4": .["4"], "7": .["7"], "9": .["9"], "17": .["17"]}'
   ```

   The mint holds your money until you withdraw (see *Withdraw*), so pick one you trust, or run your own.
4. **HTTPS** on one domain (the camera QR scanner needs https; keys are bearer secrets).
5. Docker, or Node ≥ 22 (runs the TypeScript sources directly, no build step).

## Configure

| env | required | meaning |
|---|---|---|
| `NEWAPI_URL` | key shop | new-api base URL as the gateway reaches it, e.g. `http://new-api:3000` |
| `NEWAPI_USER_ID` | key shop | pool user's id |
| `NEWAPI_TOKEN` | key shop | pool user's system access token |
| `POOL_RESERVE` | | key shop: keep this much (in `FIAT`) of the pool user's quota unsold; an amount is offered only while it fits, default `10` |
| `POOL_ALERT` | | key shop: log a warning (at most hourly) when the pool can sell less than this, default `30` |
| `USD_PER_FIAT` | | fixed USD per 1 `FIAT` for the homepage price check and stablecoin amounts (offline tests); otherwise frankfurter.app (ECB) → Coinbase → mempool.space, 10 min cache |
| `STABLE_ADDR_TRON` / `STABLE_ADDR_EVM` / `STABLE_ADDR_SOL` | | USDT/USDC receiving addresses (see [Stablecoins](#stablecoins-usdt--usdc-optional)); a network without one is off |
| `KEY_BONUS` | | key shop: bonus quota for larger amounts, `amount:percent` pairs, e.g. `5:5,10:10` (€5 → €5.25, €10 → €11). Keys, top-ups and auto top-ups, ⚡ and 🥜 alike; default none |
| `AUTO_TOPUP_EVERY_S` | | key shop: how often keys with auto top-up (Nostr Wallet Connect) get their balance checked, default `60` |
| `KEY_BASE_URL` | | endpoint shown with each key, e.g. `https://shop.example.com/v1` (default: new-api's server address + `/v1`) |
| `FIAT` | key shop | order currency, e.g. `eur`; must be the currency of new-api's top-up price `Price` (below); default `cny` |
| `MINT_URL` | yes | the mint; default `https://testnut.cashu.space` (test mint, fake sats) |
| `EPAY_KEY` | yes | signing key for top-ups (below). Set a long random string even if you don't use top-ups |
| `EPAY_PID` | | merchant id for top-ups, default `1001` |
| `ADMIN_KEY` | recommended | operator key for `/admin` (falls back to `EPAY_KEY`). **Keep it different from `EPAY_KEY`**: that one can sign "paid" callbacks |
| `DATA_DIR` | | wallet seed + ledger, default `data` (`/data` in the Docker image) |
| `SEED` | | wallet seed as hex; otherwise `DATA_DIR/seed.hex` is created on first start |
| `UPSTREAMS_FILE` | | turns on the `/network` page: an anonymized snapshot made by `scripts/export-upstreams.ts` from a dump of new-api's channels, re-read when it changes |
| `MODEL_ALIAS_SUFFIX` | | regex of name suffixes for extra routes of one model, e.g. `-alt$\|-backup$`. A name matching it whose base name exists too stays callable with a key, but `/api/models` and `/network` leave it out and show its calls under the base name |
| `PORT` | | default `8090` |
| `ORDER_TTL_MIN` | | how long an unpaid order stays open, default `30` |
| `CHECKOUT_TAB` | | tab the checkout opens on: `ln` (default) or `cashu` |
| `WITHDRAW_TOKEN_OVER_HTTP` | | `1` = the admin page shows the withdrawn token for copying. Only if you reach the admin page over https or an ssh tunnel |
| `BTC_PRICE` | | fixed BTC price in `FIAT` (offline tests); otherwise CoinGecko → Coinbase → mempool.space |

Generate secrets with e.g. `openssl rand -hex 24`. Keep them in an `.env` file with mode `600`.

## Run with Docker Compose

Put the gateway next to new-api, on the same Docker network:

```yaml
services:
  gateway:
    build: ./sats4tokens          # a clone of this repo
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"     # local only; the public goes through the reverse proxy
    volumes:
      - ./data/gateway-mint-example-com:/data   # one directory per mint (see below)
    environment:
      MINT_URL: https://mint.example.com
      FIAT: eur
      CHECKOUT_TAB: ln
      EPAY_KEY: ${EPAY_KEY}
      ADMIN_KEY: ${ADMIN_KEY}
      NEWAPI_URL: http://new-api:3000
      NEWAPI_USER_ID: ${NEWAPI_USER_ID}
      NEWAPI_TOKEN: ${NEWAPI_TOKEN}
      KEY_BASE_URL: https://shop.example.com/v1
      # Node gives each connect attempt 250 ms (happy eyeballs); far-away mints need more
      NODE_OPTIONS: --network-family-autoselection-attempt-timeout=2000
```

The image runs as the `node` user (uid 1000), so create the data directory first:

```sh
mkdir -p data/gateway-mint-example-com && sudo chown 1000:1000 data/gateway-mint-example-com
docker compose up -d --build gateway
docker compose logs -f gateway
```

A good start logs the mint, the balance and `keyshop=http://new-api:3000`. If the mint lacks a required
NUT the gateway exits with `mint … can't be used: …`.

Without Docker: `npm ci --omit=dev`, set the same variables, `npm run gateway`.

## HTTPS and routing

One domain, two upstreams: `/v1/*` goes to new-api (that's where keys are used, including Claude Code's
`/v1/messages`), everything else to the gateway. With Caddy:

```
shop.example.com {
    handle /v1/* {
        reverse_proxy new-api:3000
    }
    handle {
        reverse_proxy gateway:8090
    }
}
```

With a Cloudflare tunnel (no open port), the same as ingress rules:

```yaml
ingress:
  - hostname: shop.example.com
    path: ^/v1/
    service: http://new-api:3000
  - hostname: shop.example.com
    service: http://gateway:8090
  - service: http_status:404
```

Then set `KEY_BASE_URL=https://shop.example.com/v1`. Keys keep the endpoint they were shown with, so set it
before you sell. Don't expose `/admin` publicly beyond what's needed: it only answers with the right
`ADMIN_KEY`, but the safest way in is an ssh tunnel to the local port.

Behind a CDN: the gateway sends `cache-control: no-cache` for static files, but some CDNs (Cloudflare) rewrite
the browser TTL. After changing anything in `web/`, bump the `?v=` query in the HTML so browsers fetch the new file.

## Stablecoins: USDT / USDC (optional)

The checkout gets a third tab when at least one receiving address is set. **Watch only**: the gateway knows public
addresses and reads the chains; the keys stay in your own wallet, so a broken-into server can't move the money.

| env | default | meaning |
|---|---|---|
| `STABLE_ADDR_TRON` | | Tron address (`T…`) → rail `tron-usdt` (USDT TRC-20) |
| `STABLE_ADDR_EVM` | | one `0x…` address for every EVM chain → `base-usdc` (+ chains in `STABLE_EVM_CHAINS`) |
| `STABLE_ADDR_SOL` | | Solana **wallet** address → `solana-usdc`, `solana-usdt` (we watch its associated token accounts) |
| `STABLE_TRON_RPC` | `https://api.trongrid.io` | TronGrid-compatible API |
| `STABLE_TRON_API_KEY` | | TronGrid key (sent as `TRON-PRO-API-KEY`); free, and the keyless limits are low |
| `STABLE_BASE_RPC` | `https://mainnet.base.org` | Base JSON-RPC. The public one refuses many `eth_getLogs` calls: use a provider URL (key in the URL). A free-tier provider may cap `eth_getLogs` at a few blocks (one we tried: 10): then set `"maxRange"` in `STABLE_EVM_CHAINS` (`[{"id":"base","maxRange":10}]`); a pass reads up to 5 ranges, which keeps up with Base's 2 s blocks |
| `STABLE_SOL_RPC` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC (rate-limited; a provider URL with key is better) |
| `STABLE_<NET>_CONFIRMATIONS` | Tron `19`, Base `30` | blocks, the transfer's own included. Solana waits for `finalized` |
| `STABLE_EVM_CHAINS` | | JSON list of more EVM chains (or overrides of `base`): `[{"id":"arbitrum","name":"Arbitrum","rpc":"https://…","confirmations":20,"blockTime":0.25,"explorer":"https://arbiscan.io/tx/","tokens":{"USDC":"0x…"}}]`; a token may be `{"contract":"0x…","decimals":18}`. Each chain also reads `STABLE_<ID>_RPC` / `_CONFIRMATIONS` |
| `STABLE_RAILS` | all | allow-list, e.g. `tron-usdt,base-usdc,solana-usdc` |
| `STABLE_LATE_HOURS` | `24` | a transfer that lands this long after its order expired still pays it (as a late Lightning invoice) |

On EVM networks, the watcher checks block timestamps before skipping older blocks. It resumes a backlog on each watcher tick until it catches up. The configured block time is only a lookup hint.

The gateway refuses to start on a malformed address (bad Tron checksum, bad EIP-55 checksum, a Solana token account
instead of the wallet). Check the addresses the admin page shows against your wallet before going live, then pay a
small order yourself on each network.

How transfers are matched to orders (one address, no memo: the amount's cents tell orders apart), and what happens
when someone pays too little, too much or on the wrong network: [how it works](how-it-works.md#usdt--usdc). The
admin page lists everything that needs a human: console top-ups paid short (**held**, not credited), overpayments,
and transfers no order could claim (**unmatched**). Refunds are manual, from your own wallet.

## Money: seed, data directory, mints

`DATA_DIR` holds `seed.hex` (the wallet seed), `ledger.json` (orders and the ecash proofs you own) and
`withdrawals/`. **This is bearer money**: whoever copies it can spend the balance.

- Back up `seed.hex` off the server right after the first start, and keep the directory out of git and logs.
- Ecash belongs to the mint that signed it. **Use one data directory per mint.** To switch mints, withdraw
  first (or keep the old directory — pointing back at it later still works), then start with a fresh directory.
- The mint is custodial until you withdraw. Withdraw often.

## Withdraw

The whole balance becomes **one Cashu token**, always written to `DATA_DIR/withdrawals/withdraw-*.txt`
before the proofs leave the ledger (a lost reply can't lose money).

- **Admin page:** open `/admin.html#key=<ADMIN_KEY>` (the key stays in the URL fragment, out of access
  logs), ideally through an ssh tunnel: `ssh -N -L 18090:127.0.0.1:8090 your-server`, then
  `http://localhost:18090/admin.html#key=…`. It shows the balance and all orders; **Withdraw** creates the
  token, and with `WITHDRAW_TOKEN_OVER_HTTP=1` a **Copy** button shows it.
- **CLI:** `docker compose exec gateway node --disable-warning=ExperimentalWarning src/cli.ts balance`
  (or `withdraw`). It talks to the running gateway over HTTP, so it never races its ledger.
- Then receive the token in a Cashu wallet (e.g. cashu.me; accept the mint), and melt it to Lightning
  if you want it out of the mint.

## Top-ups for existing users (optional)

Besides selling keys, the gateway plugs into new-api's built-in online-payment settings, so existing users get
a Bitcoin button on new-api's top-up page. In new-api → payment settings:

- `PayAddress` = the gateway's public URL
- `EpayId` = `EPAY_PID`, `EpayKey` = `EPAY_KEY`
- `PayMethods` = `[{"name":"Bitcoin","color":"#f7931a","type":"bitcoin"}]`
- the callback address must reach new-api from the gateway (e.g. `http://new-api:3000` on the same network)

new-api redirects the customer to the gateway's `/submit.php` with a signed form; the customer pays on the same
checkout page; the gateway then calls new-api's signed callback until new-api confirms. new-api charges
`units × Price` for a top-up and only accepts whole units, so set `Price` in the gateway's `FIAT`: e.g. with
model prices in CNY (1 unit = ¥1) and `FIAT=eur`, `Price` = 0.1333 (€1 = ¥7.5). The key shop uses the same
`Price` (a €1 key holds 7.5 units), so a key costs what the same top-up would. To show prices in that currency
in new-api too, set its display to custom with the symbol and the same rate.

## Operating

- **Logs** (`docker compose logs -f gateway`): 🔑 key order / key created, 🧾 top-up order, ⚡ / 🥜 payment
  settled, 🔔 mint push (NUT-17), 📨 top-up callback, 🔁 crash recovery decision, and mint errors.
- **Restarts are safe at any time**, also mid-payment: unfinished settlements are recovered on start
  (see [How it works](how-it-works.md)). `npm run crash-demo` demonstrates it.
- **Upgrade:** `git pull`, then `docker compose up -d --build gateway` (the image contains `src/` and `web/`,
  so a plain restart keeps the old code).
- **Revoke a key:** delete the token `btc-<orderId>` of the pool user in new-api (UI, or
  `DELETE /api/token/<id>` with the pool user's token).
- **Be polite to the mint.** Public mints firewall or rate-limit IPs that poll hard. The gateway relies on NUT-17
  push and keeps HTTP polling within a fixed budget; don't lower those limits.

## Security checklist

- [ ] `ADMIN_KEY` and `EPAY_KEY` are long, random and different; `.env` is mode 600.
- [ ] The gateway port is bound to `127.0.0.1`; the public reaches it only through the HTTPS proxy.
- [ ] The pool user is a normal user, not an admin; the gateway has no admin credentials.
- [ ] `seed.hex` is backed up off the server; `DATA_DIR` is not in git, backups you share, or logs.
- [ ] `WITHDRAW_TOKEN_OVER_HTTP=1` only when the admin page is reached over https or an ssh tunnel.
- [ ] Sold keys and `/pay/…` links are bearer secrets: don't paste real ones into screenshots or issues.

## Local development

```sh
npm install
EPAY_KEY=dev ADMIN_KEY=dev-admin CHECKOUT_TAB=cashu PORT=8091 npm run gateway   # testnut, no key shop
npm test && npm run typecheck        # offline units
npm run edge-checks                  # end-to-end against testnut (~40 s)
```

On testnut, invoices are paid automatically by the mint about 2 s after they are created, so opening the ⚡ tab
pays the order. If you point a local gateway at a real new-api with the key shop on, delete the test keys it creates.
