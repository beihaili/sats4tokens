#!/bin/sh
# One-time setup of the demo stack on the relay server. Safe to re-run: every step checks first.
#   1. .env with fresh random secrets (0600)       3. root admin via new-api's /api/setup
#   2. build gateway, start mysql + new-api        4. sync-channels.sh, then start the gateway
# Admin + demo-user passwords end up in secrets/demo-accounts.txt (0600).
set -eu
cd "$(dirname "$0")"
umask 077
rnd() { openssl rand -hex "$1"; }

if [ ! -f .env ]; then
  cat > .env <<EOF
NEW_API_IMAGE=$(docker inspect -f '{{.Config.Image}}' new-api-relay-app)
MYSQL_ROOT_PASSWORD=$(rnd 24)
SESSION_SECRET=$(rnd 32)
CRYPTO_SECRET=$(rnd 32)
EPAY_KEY=$(rnd 24)
MINT_URL=https://testnut.cashu.space
EOF
fi
mkdir -p data/mysql data/new-api data/gateway logs/new-api secrets seed
chown 1000:1000 data/gateway # the gateway runs as the image's "node" user

docker compose build gateway
docker compose up -d mysql new-api
echo "waiting for new-api…"
until [ "$(docker inspect -f '{{.State.Health.Status}}' cashu-demo-newapi)" = healthy ]; do sleep 3; done

API=http://127.0.0.1:8530
if [ ! -f secrets/demo-accounts.txt ]; then
  ROOT_PW=$(rnd 8)
  DEMO_PW=$(rnd 6)
  curl -fsS "$API/api/setup" -H 'content-type: application/json' \
    -d "{\"username\":\"root\",\"password\":\"$ROOT_PW\",\"confirmPassword\":\"$ROOT_PW\",\"SelfUseModeEnabled\":false,\"DemoSiteEnabled\":false}"
  echo
  printf 'admin  root / %s\ndemo   demo / %s\n' "$ROOT_PW" "$DEMO_PW" > secrets/demo-accounts.txt
fi

./sync-channels.sh
echo "waiting for new-api after channel import…"
sleep 5
until [ "$(docker inspect -f '{{.State.Health.Status}}' cashu-demo-newapi)" = healthy ]; do sleep 3; done

# demo user (plain user, default group, zero balance — tops up with bitcoin on stage)
ROOT_PW=$(awk '/^admin/{print $4}' secrets/demo-accounts.txt)
DEMO_PW=$(awk '/^demo/{print $4}' secrets/demo-accounts.txt)
# this new-api fork authenticates API calls with a JWT (login → data.access_token), not cookies
TOKEN=$(curl -fsS "$API/api/user/login" -H 'content-type: application/json' \
  -d "{\"username\":\"root\",\"password\":\"$ROOT_PW\"}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -sS "$API/api/user/" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' \
  -d "{\"username\":\"demo\",\"password\":\"$DEMO_PW\",\"display_name\":\"demo\"}" | head -c 200
echo

docker compose up -d gateway
docker compose ps
