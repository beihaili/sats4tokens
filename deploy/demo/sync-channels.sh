#!/bin/sh
# Copy the relay's channels into the demo DB, so the demo serves exactly the same models.
#
# Production is only READ: one mysqldump --single-transaction (consistent snapshot, no locks) of
#   channels, abilities            — the routing table (upstream base_url + keys)
#   options (pricing keys only)    — model/group ratios, so the demo bills like production
# Users, tokens, logs, top-ups and every other option stay behind.
# Then the demo-only options are written: EPay → cashu-epay gateway, public URLs, money in EUR, logo,
# registration off, demo notice.
#
# Re-runnable: replaces the demo's channels/abilities each time. Restarts only cashu-demo-newapi.
set -eu
cd "$(dirname "$0")"
. ./.env
PROD=new-api-relay-mysql
DEMO=cashu-demo-mysql
CONSOLE_URL=${CONSOLE_URL:?set CONSOLE_URL in .env: new-api console public URL, e.g. https://console.example.com}
SHOP_URL=${SHOP_URL:?set SHOP_URL in .env: gateway public URL, e.g. https://shop.example.com}

# Money: model prices are CNY like production's (1 unit = 500000 quota = ¥1). The demo sells and shows EUR
# at €1 = ¥7.5, so a unit costs €0.1333…: new-api Price (top-ups; the key shop reads it too) = display rate.
UNIT_PRICE=0.133333333333
[ "${FIAT:-}" = eur ] || { echo "set FIAT=eur in .env: the gateway charges new-api's Price in it" >&2; exit 1; }

PRICING_KEYS="'ModelRatio','CompletionRatio','CacheRatio','CreateCacheRatio','ModelPrice','GroupRatio',
'UserUsableGroups','AutoGroups','DefaultUseAutoGroup','group_ratio_setting.group_special_usable_group',
'billing_setting.billing_expr','billing_setting.billing_mode','channel_affinity_setting.rules',
'AudioRatio','AudioCompletionRatio','ImageRatio','QuotaPerUnit',
'AutomaticRetryStatusCodes','AutomaticDisableStatusCodes',
'AutomaticDisableChannelEnabled','AutomaticEnableChannelEnabled','ChannelDisableThreshold','RetryTimes',
'ModelRequestRateLimitEnabled','ModelRequestRateLimitCount','ModelRequestRateLimitDurationMinutes',
'ModelRequestRateLimitSuccessCount','ModelRequestRateLimitGroup','theme.frontend','Logo'"

umask 077
mkdir -p seed
DUMP='exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-triggers --no-create-info --complete-insert'
docker exec "$PROD" sh -c "$DUMP newapi channels abilities" > seed/channels.sql 2>/dev/null
docker exec "$PROD" sh -c "$DUMP --replace --where=\"\\\`key\\\` in ($(echo $PRICING_KEYS))\" newapi options" > seed/options.sql 2>/dev/null

# demo-only settings (values are ours, not production's)
q() { printf "REPLACE INTO options (\`key\`, value) VALUES ('%s', '%s');\n" "$1" "$2"; }
{
  q ServerAddress "$CONSOLE_URL" # return links after a top-up
  q PayAddress "$SHOP_URL"       # top-up checkout: the gateway's /submit.php
  q CustomCallbackAddress "http://new-api:3000" # the gateway reaches new-api on the private network
  q EpayId 1001
  q EpayKey "$EPAY_KEY"
  q PayMethods '[{"name":"Bitcoin ⚡ Lightning / 🥜 Cashu","color":"#f7931a","type":"bitcoin"}]'
  q Price "$UNIT_PRICE" # € per unit; new-api charges units × Price, the gateway takes it in FIAT=eur
  q general_setting.quota_display_type CUSTOM
  q general_setting.custom_currency_symbol "€"
  q general_setting.custom_currency_exchange_rate "$UNIT_PRICE" # shown = units × rate
  # the wallet labels presets "units × USDExchangeRate" and Model Square's "Recharge" prices divide by it:
  # = Price, so presets read 2…100 (€) and Recharge = Standard. Backend: only CNY display uses it.
  q USDExchangeRate "$UNIT_PRICE"
  # top-ups are whole units: presets and minimum in units (15 = €2, … 750 = €100)
  q payment_setting.amount_options "[15,30,75,150,375,750]"
  q MinTopUp 15
  # production's Logo is a path on its own site (404 here); LOGO_URL = an absolute URL of the same image
  [ -z "${LOGO_URL:-}" ] || q Logo "$LOGO_URL"
  q payment_setting.compliance_confirmed true
  q payment_setting.compliance_terms_version v1
  q payment_setting.compliance_confirmed_at "$(date +%s)"
  q payment_setting.compliance_confirmed_by 1
  q RegisterEnabled false
  q PasswordRegisterEnabled false
  q SystemName "BHBTC Relay · Bitcoin demo"
  q Notice "🧪 bitcoin++ Berlin demo instance. Top up with Bitcoin — Lightning or Cashu ecash. No account details, no KYC."
} > seed/demo-options.sql

docker stop cashu-demo-newapi >/dev/null
{
  echo "SET FOREIGN_KEY_CHECKS=0; TRUNCATE channels; TRUNCATE abilities;"
  cat seed/channels.sql seed/options.sql seed/demo-options.sql
  echo "SET FOREIGN_KEY_CHECKS=1;"
} | docker exec -i "$DEMO" sh -c 'exec mysql --default-character-set=utf8mb4 -uroot -p"$MYSQL_ROOT_PASSWORD" newapi' 2>&1 | grep -v 'Using a password' || true
docker start cashu-demo-newapi >/dev/null

docker exec "$DEMO" sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" newapi -N -e "select concat(count(*), \" channels (\", sum(status=1), \" enabled)\") from channels; select concat(count(*), \" abilities\") from abilities;"' 2>/dev/null
rm -f seed/channels.sql # holds upstream keys; the demo DB has them now
./export-upstreams.sh # refresh the anonymized /network snapshot
