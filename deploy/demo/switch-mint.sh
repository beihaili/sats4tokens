#!/bin/sh
# Point the demo gateway at the test mint or a real (mainnet) mint, and back. Each side keeps its own
# wallet (seed + ledger) under data/, so switching never mixes proofs of two mints.
#   ./switch-mint.sh testnut                    → testnut, data/gateway/,         checkout opens on 🥜
#   ./switch-mint.sh mainnet [MINT_URL]         → real mint, data/gateway-mainnet/, checkout opens on ⚡
# The gateway refuses to start on a mint without NUT-04 bolt11 / NUT-07 / NUT-09 (see the log line below).
set -eu
cd "$(dirname "$0")"

setenv() { # setenv KEY VALUE — replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

case "${1:-}" in
  testnut)
    setenv MINT_URL https://testnut.cashu.space
    setenv GATEWAY_DATA gateway
    setenv CHECKOUT_TAB cashu # testnut pays its own invoices, so don't open on ⚡
    ;;
  mainnet)
    setenv MINT_URL "${2:-https://mint.minibits.cash/Bitcoin}"
    setenv GATEWAY_DATA gateway-mainnet
    # fresh wallet dir, owned like the testnut one (the container doesn't run as root); a new seed is made on first start
    [ -d data/gateway-mainnet ] || install -d -m 700 -o "$(stat -c %u data/gateway)" -g "$(stat -c %g data/gateway)" data/gateway-mainnet
    setenv CHECKOUT_TAB ln
    ;;
  *) echo "usage: $0 testnut | mainnet [MINT_URL]" >&2; exit 1 ;;
esac

docker compose up -d gateway
sleep 6
docker compose logs --tail 3 gateway
