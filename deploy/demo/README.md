# cashu-epay demo stack (api-relay server)

A private copy of the BHBTC relay for the bitcoin++ Berlin demo: same new-api image, same 51
channels / 348 abilities / pricing as production, but its own users only, and the only payment
method is Bitcoin via the cashu-epay gateway.

Lives in `/opt/cashu-epay-demo` on `api-relay`. **Fully isolated from production**
(`/opt/new-api-relay`): own compose project `cashu-epay-demo`, own network, own MySQL, no Redis.
Production is only ever *read* (one `mysqldump --single-transaction` in `sync-channels.sh`).

| what | where |
|---|---|
| public https | stable: `https://sats4tokens.bhbtc.xyz` (Cloudflare named tunnel `tunnel-named`, below). Also `./https-tunnel.sh` prints the shop + gateway `*.trycloudflare.com` URLs (quick tunnels, new on every tunnel restart; new-api's `ServerAddress`/`PayAddress` use them) |
| new-api demo | 127.0.0.1:8530 on the host (container `cashu-demo-newapi`) |
| Bitcoin gateway | 127.0.0.1:8531 on the host (container `cashu-demo-gateway`), operator page `/admin.html#key=$ADMIN_KEY` — open it only through the ssh tunnel (below) |
| MySQL | `cashu-demo-mysql`, not published |
| accounts | `secrets/demo-accounts.txt` (root admin + `demo` user) |
| secrets | `.env` (0600): DB password, session secrets, EPay key, `ADMIN_KEY`, `MINT_URL`, `GATEWAY_DATA` |
| gateway wallet | `data/gateway/` (testnut), `data/gateway-mainnet/` (real mint) — seed + ecash proofs = **bearer money** |

new-api's EPay settings point at the gateway: `PayAddress=<gateway tunnel URL>` (set by https-tunnel.sh, as is `ServerAddress`),
`CustomCallbackAddress=http://new-api:3000` (notify goes over the private network), `EpayId=1001`,
`PayMethods=[{type:"bitcoin"}]`, `Price=1`, gateway `FIAT=usd` → a $1 top-up costs $1 in sats (whole dollars only; presets 1/2/5/10/20/50).
Display is English + USD: `general_setting.quota_display_type=USD`, root/demo have `language: en`.

## Commands

```sh
cd /opt/cashu-epay-demo
./bootstrap.sh                      # first-time setup (idempotent)
./sync-channels.sh                  # re-copy channels + pricing from production (restarts demo new-api only)
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
`keyshop=http://new-api:3000`; the buy page is the pay tunnel's `/`. Keys use new-api's ServerAddress + `/v1`.
Revoke a key: `DELETE /api/token/<id>` with the same token headers (`Authorization`, `New-Api-User`).

Stable URL (named tunnel, outbound only, server IP stays out of DNS): `cloudflared tunnel login` +
`cloudflared tunnel create sats4tokens` + `cloudflared tunnel route dns sats4tokens sats4tokens.bhbtc.xyz` on the
laptop, then on the server `secrets/cloudflared/credentials.json` (the tunnel's JSON) and `config.yml`
(tunnel id, `credentials-file: /etc/cloudflared/credentials.json`, ingress `^/v1/` → `http://new-api:3000`, rest →
`http://gateway:8090`, catch-all `http_status:404`), both owned by uid 65532 (cloudflared's user), mode 600.
`.env`: `COMPOSE_PROFILES=named-tunnel`, `KEY_BASE_URL=https://sats4tokens.bhbtc.xyz/v1` (endpoint shown with keys),
then `docker compose up -d gateway tunnel-named`. Keys sold before that keep the endpoint they were shown with.

Tear down: `docker compose down` (keeps data/), `rm -rf /opt/cashu-epay-demo` to remove everything.
Nothing in production needs undoing.
