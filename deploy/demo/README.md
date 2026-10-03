# cashu-epay demo stack (api-relay server)

**Since 2026-10-04 this is the official BHBTC EU relay** ("BHBTC Relay · Europe", prices in EUR), no longer a demo; the
file/container names below keep "demo" only because renaming them would mean recreating the stack.

A private copy of the BHBTC relay for the bitcoin++ Berlin demo: same new-api image, same 51
channels / 348 abilities / pricing as production, but its own users only, and the only payment
method is Bitcoin via the cashu-epay gateway.

Lives in `/opt/cashu-epay-demo` on `api-relay`. **Fully isolated from production**
(`/opt/new-api-relay`): own compose project `cashu-epay-demo`, own network, own MySQL, no Redis.
Production is only ever *read* (one `mysqldump --single-transaction` in `sync-channels.sh`, one usage
`SELECT` per hour in `sync-usage.sh`).

| what | where |
|---|---|
| public https | Cloudflare named tunnel `tunnel-named` (below): shop + checkout + `/v1` `https://sats4tokens.bhbtc.xyz` (`SHOP_URL`), new-api console `https://btc.bhbtc.xyz` (`CONSOLE_URL`). Fallback without a domain: `./https-tunnel.sh` (quick tunnels, compose profile `quick-tunnels`, random `*.trycloudflare.com` URLs) |
| new-api demo | 127.0.0.1:8530 on the host (container `cashu-demo-newapi`) |
| Bitcoin gateway | 127.0.0.1:8531 on the host (container `cashu-demo-gateway`), operator page `/admin.html#key=$ADMIN_KEY` — open it only through the ssh tunnel (below) |
| MySQL | `cashu-demo-mysql`, not published |
| accounts | `secrets/demo-accounts.txt` (root admin + `demo` user) |
| secrets | `.env` (0600): DB password, session secrets, EPay key, `ADMIN_KEY`, `MINT_URL`, `GATEWAY_DATA`; plus `FIAT=eur`, `CONSOLE_URL`, `SHOP_URL`, `LOGO_URL`, `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (both set → sign-up open behind Turnstile, else closed) |
| gateway wallet | `data/gateway/` (testnut), `data/gateway-mainnet/` (real mint) — seed + ecash proofs = **bearer money** |

new-api's EPay settings point at the gateway (all written by `sync-channels.sh`): `PayAddress=$SHOP_URL`,
`ServerAddress=$CONSOLE_URL` (return links), `CustomCallbackAddress=http://new-api:3000` (notify goes over the
private network), `EpayId=1001`, `PayMethods=[{type:"bitcoin"}]`.

Money is **EUR**. Model prices are CNY like production's (1 unit = 500000 quota = ¥1); at €1 = ¥7.5 a unit costs
€0.1333…: `Price=0.133333333333` (new-api charges `units × Price`, the gateway takes it in `FIAT=eur`; the key
shop reads the same Price, so a €1 key holds 7.5 units) and the display is custom `€` with that rate
(`general_setting.quota_display_type=CUSTOM`). Top-ups are whole units: presets 15/30/75/150/375/750 units =
€2/4/10/20/50/100, minimum 15. `USDExchangeRate` = Price as well, so the wallet labels presets in € (2…100; the custom
amount field still takes units) and Model Square's "Recharge" view equals "Standard". English UI: root/demo have `language: en`. Logo = `LOGO_URL` (production's logo
option is a path on its own site, 404 here).

`/rankings` counts both sites: `sync-usage.sh` (root cron, minute 7 hourly, log `journalctl -t cashu-sync-usage`)
copies production's hourly token totals per model into the demo's `quota_data` as rows tagged
`node_name=bhbtc-relay` (one transaction: delete old copy, insert new). Only model + hour + totals leave production.

## Commands

```sh
cd /opt/cashu-epay-demo
./bootstrap.sh                      # first-time setup (idempotent)
./sync-channels.sh                  # re-copy channels + pricing from production (restarts demo new-api only)
./sync-usage.sh                     # re-copy production usage totals for /rankings (cron does it hourly)
./export-upstreams.sh               # refresh public/upstreams.json for /network (anonymized; sync-channels.sh runs it too)
docker compose logs -f gateway      # watch ⚡ / 🥜 / 📨 events live during the demo
docker compose ps
cat secrets/demo-accounts.txt
K=$(grep ^ADMIN_KEY .env | cut -d= -f2)
curl -s "127.0.0.1:8531/admin?key=$K"                       # orders + balance
curl -s -XPOST "127.0.0.1:8531/admin/withdraw?key=$K"       # balance → data/$GATEWAY_DATA/withdrawals/withdraw-*.txt
./switch-mint.sh mainnet [MINT_URL]  # real mint (default Minibits), checkout opens on ⚡
                                     # wallet dir: data/gateway-mainnet (Minibits) or data/gateway-<host> (others)
# live since 10/2 10:15: ./switch-mint.sh mainnet https://mint.coinos.io  (Minibits refuses connections from this VPS IP)
./switch-mint.sh testnut             # back to the test mint (its wallet dir is kept)
```

Without the https tunnels (fallback), from the laptop:

```sh
ssh -N -L 18530:127.0.0.1:8530 -L 18531:127.0.0.1:8531 api-relay
# http://localhost:18530 (new-api root)   http://localhost:18531/admin.html#key=<ADMIN_KEY>
```

Update the gateway code: from the laptop
`rsync -a --exclude node_modules --exclude data --exclude deploy --exclude .git ./ api-relay:/opt/cashu-epay-demo/gateway/`,
then `docker compose up -d --build gateway`.

Real mint: `switch-mint.sh` keeps one wallet dir per side, because proofs belong to the mint that
signed them. The gateway refuses mints without NUT-04 bolt11 sat / NUT-07 / NUT-09. Back up the new
`data/gateway-mainnet/seed.hex` off the server. Node needs `--network-family-autoselection-attempt-timeout=2000`
(set in compose): Minibits is ~265ms RTT from this VPS, above Node's 250ms happy-eyeballs default.
With testnut, invoices are paid automatically by the mint's fake wallet ~2s after creation.

Key shop (pay → capped API key, no signup): create a normal user in new-api (demo: `keyshop`, id 3), give it
a pool quota as root (`POST /api/user/manage {"id":3,"action":"add_quota","mode":"override","value":<quota>}`),
log in as it and get its personal access token (`GET /api/user/token`). Put `NEWAPI_USER_ID=3` and
`NEWAPI_TOKEN=<token>` in `.env` (chmod 600), then `docker compose up -d gateway`. The log line ends with
`keyshop=http://new-api:3000`; the buy page is the shop's `/`. Keys use `KEY_BASE_URL` (else new-api's ServerAddress + `/v1`).
Revoke a key: `DELETE /api/token/<id>` with the same token headers (`Authorization`, `New-Api-User`).

Stable URL (named tunnel, outbound only, server IP stays out of DNS): `cloudflared tunnel login` +
`cloudflared tunnel create sats4tokens` + `cloudflared tunnel route dns sats4tokens sats4tokens.bhbtc.xyz` on the
laptop, then on the server `secrets/cloudflared/credentials.json` (the tunnel's JSON) and `config.yml`
(tunnel id, `credentials-file: /etc/cloudflared/credentials.json`, ingress: shop host `^/v1/` → `http://new-api:3000`,
shop host rest → `http://gateway:8090`, console host → `http://new-api:3000`, catch-all `http_status:404`), both owned
by uid 65532 (cloudflared's user), mode 600. The console host was added with
`cloudflared tunnel route dns sats4tokens btc.bhbtc.xyz` (an explicit record beats the zone's `*` → Vercel wildcard).
`.env`: `COMPOSE_PROFILES=named-tunnel`, `KEY_BASE_URL=https://sats4tokens.bhbtc.xyz/v1` (endpoint shown with keys),
`CONSOLE_URL`, `SHOP_URL`, then `./sync-channels.sh` and `docker compose up -d gateway tunnel-named`. Keys sold before
that keep the endpoint they were shown with.

Tear down: `docker compose down` (keeps data/), `rm -rf /opt/cashu-epay-demo` to remove everything.
Nothing in production needs undoing.
