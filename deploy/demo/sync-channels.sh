#!/bin/sh
# Copy the relay's channels into the demo DB, so the demo serves exactly the same models.
#
# Production is only READ: one mysqldump --single-transaction (consistent snapshot, no locks) of
#   channels, abilities            — the routing table (upstream base_url + keys)
#   options (pricing keys only)    — model/group ratios, so the demo bills like production
# Users, tokens, logs, top-ups and every other option stay behind.
# Then the demo-only options are written: EPay → cashu-epay gateway, registration off, demo notice.
#
# Re-runnable: replaces the demo's channels/abilities each time. Restarts only cashu-demo-newapi.
set -eu
cd "$(dirname "$0")"
. ./.env
PROD=new-api-relay-mysql
DEMO=cashu-demo-mysql
PUBLIC_IP=${PUBLIC_IP:?set PUBLIC_IP to the server public IP}

PRICING_KEYS="'ModelRatio','CompletionRatio','CacheRatio','CreateCacheRatio','ModelPrice','GroupRatio',
'UserUsableGroups','AutoGroups','DefaultUseAutoGroup','group_ratio_setting.group_special_usable_group',
'billing_setting.billing_expr','billing_setting.billing_mode','channel_affinity_setting.rules',
'AudioRatio','AudioCompletionRatio','ImageRatio','QuotaPerUnit','USDExchangeRate',
'general_setting.custom_currency_exchange_rate','general_setting.custom_currency_symbol',
'general_setting.quota_display_type','AutomaticRetryStatusCodes','AutomaticDisableStatusCodes',
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
  q ServerAddress "http://$PUBLIC_IP:8530"
  q PayAddress "http://$PUBLIC_IP:8531"
  q CustomCallbackAddress "http://new-api:3000" # the gateway reaches new-api on the private network
  q EpayId 1001
  q EpayKey "$EPAY_KEY"
  q PayMethods '[{"name":"Bitcoin ⚡ Lightning / 🥜 Cashu","color":"#f7931a","type":"bitcoin"}]'
  q MinTopUp 1
  q Price 1 # CNY per balance unit; production's recharge sidecar also sells ¥1 = 500000 quota = "¥1"
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
