#!/bin/sh
# Fallback without a domain (the demo uses the named tunnel + CONSOLE_URL/SHOP_URL instead, see sync-channels.sh).
# Start the two Cloudflare quick tunnels (if needed), read their https URLs and point demo new-api at them:
# ServerAddress = shop URL (return links), PayAddress = gateway URL (checkout). Notify stays on the private
# network (CustomCallbackAddress=http://new-api:3000). Re-run after the tunnel containers restart: the URLs change.
#   ./https-tunnel.sh          # prints the two URLs
set -eu
cd "$(dirname "$0")"
docker compose --profile quick-tunnels up -d tunnel-shop tunnel-pay >/dev/null 2>&1
url() {  # wait until cloudflared logs its *.trycloudflare.com address
  for _ in $(seq 30); do
    u=$(docker compose logs "$1" 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
    [ -n "$u" ] && { echo "$u"; return; }
    sleep 2
  done
  echo "no URL from $1" >&2; exit 1
}
SHOP=$(url tunnel-shop); PAY=$(url tunnel-pay)
PW=$(awk '$2=="root"{print $4}' secrets/demo-accounts.txt)  # line: "admin  root / <password>"
B=http://127.0.0.1:8530
TOKEN=$(curl -sf $B/api/user/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"root\",\"password\":\"$PW\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["access_token"])')
for kv in "ServerAddress $SHOP" "PayAddress $PAY"; do
  set -- $kv
  curl -sf -X PUT $B/api/option/ -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' \
    -d "{\"key\":\"$1\",\"value\":\"$2\"}" | grep -q '"success":true' || { echo "failed to set $1" >&2; exit 1; }
done
echo "shop:     $SHOP"
echo "gateway:  $PAY   (operator page: $PAY/admin.html#key=<ADMIN_KEY>)"
