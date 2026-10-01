# cashu-epay demo stack (api-relay server)

A private copy of the BHBTC relay for the bitcoin++ Berlin demo: same new-api image, same 51
channels / 348 abilities / pricing as production, but its own users only, and the only payment
method is Bitcoin via the cashu-epay gateway.

Lives in `/opt/cashu-epay-demo` on `api-relay`. **Fully isolated from production**
(`/opt/new-api-relay`): own compose project `cashu-epay-demo`, own network, own MySQL, no Redis.
Production is only ever *read* (one `mysqldump --single-transaction` in `sync-channels.sh`).

| what | where |
|---|---|
| new-api demo | http://<server-ip>:8530 (container `cashu-demo-newapi`) |
| Bitcoin gateway | http://<server-ip>:8531 (container `cashu-demo-gateway`), admin view `/admin?key=$EPAY_KEY` |
| MySQL | `cashu-demo-mysql`, not published |
| accounts | `secrets/demo-accounts.txt` (root admin + `demo` user) |
| secrets | `.env` (0600): DB password, session secrets, EPay key, `MINT_URL` |
| gateway wallet | `data/gateway/` — seed + ecash proofs = **bearer money** |

new-api's EPay settings point at the gateway: `PayAddress=http://<server-ip>:8531`,
`CustomCallbackAddress=http://new-api:3000` (notify goes over the private network), `EpayId=1001`,
`PayMethods=[{type:"bitcoin"}]`, `Price=1` (¥1 = 500000 quota, like production's recharge).

## Commands

```sh
cd /opt/cashu-epay-demo
./bootstrap.sh                      # first-time setup (idempotent)
./sync-channels.sh                  # re-copy channels + pricing from production (restarts demo new-api only)
docker compose logs -f gateway      # watch ⚡ / 🥜 / 📨 events live during the demo
docker compose ps
cat secrets/demo-accounts.txt
K=$(grep ^EPAY_KEY .env | cut -d= -f2)
curl -s "127.0.0.1:8531/admin?key=$K"                       # orders + balance
curl -s -XPOST "127.0.0.1:8531/admin/withdraw?key=$K"       # balance → data/gateway/withdrawals/withdraw-*.txt
```

Update the gateway code: from the laptop
`rsync -a --exclude node_modules --exclude data --exclude deploy --exclude .git ./ api-relay:/opt/cashu-epay-demo/gateway/`,
then `docker compose up -d --build gateway`.

Switch to a real mint (real sats over Lightning): set `MINT_URL` in `.env`, **move `data/gateway`
aside first** (its proofs belong to the old mint), `docker compose up -d gateway`.
With testnut (default) invoices are paid automatically by the mint's fake wallet ~2s after creation.

Tear down: `docker compose down` (keeps data/), `rm -rf /opt/cashu-epay-demo` to remove everything.
Nothing in production needs undoing.
