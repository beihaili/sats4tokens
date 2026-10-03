#!/bin/sh
# Copy the relay's usage totals into the demo DB, so the demo's /rankings counts both sites.
#
# Production is only READ: one SELECT of hourly token totals per model (quota_data, no users, tokens or
# channels). The demo gets them as extra quota_data rows tagged node_name = username = $TAG, user_id 0:
# one transaction deletes the previous copy and inserts the new one, so /rankings never sees a gap.
# The demo's own rows are untouched. Re-runnable; cron runs it hourly (see README).
set -eu
cd "$(dirname "$0")"
PROD=new-api-relay-mysql
DEMO=cashu-demo-mysql
TAG=bhbtc-relay

umask 077
mkdir -p seed
# model, hour, tokens, calls, quota (quota_data rows are already per hour)
docker exec "$PROD" sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" newapi -N -B -e "
  SELECT q.model_name, q.created_at, SUM(q.token_used), SUM(q.count), SUM(q.quota)
  FROM quota_data q WHERE q.model_name <> \"\" GROUP BY q.model_name, q.created_at"' 2>/dev/null > seed/usage.tsv
[ -s seed/usage.tsv ] || { echo "no usage rows from $PROD" >&2; exit 1; }

{
  echo "START TRANSACTION;"
  echo "DELETE FROM quota_data WHERE node_name = '$TAG';"
  # 1000 rows per INSERT; a model name with a quote or backslash is skipped rather than escaped
  awk -F'\t' -v tag="$TAG" -v q="'" '
    index($1, q) || index($1, "\\") { next }
    {
      printf "%s", (n % 1000 == 0 ? (n ? ";\n" : "") "INSERT INTO quota_data (user_id, username, model_name, created_at, node_name, token_used, `count`, quota) VALUES\n" : ",\n")
      printf "(0,%s%s%s,%s%s%s,%d,%s%s%s,%d,%d,%d)", q, tag, q, q, $1, q, $2, q, tag, q, $3, $4, $5
      n++
    }
    END { if (n) print ";" }' seed/usage.tsv
  echo "COMMIT;"
} | docker exec -i "$DEMO" sh -c 'exec mysql --default-character-set=utf8mb4 -uroot -p"$MYSQL_ROOT_PASSWORD" newapi' 2>&1 | grep -v 'Using a password' || true

echo "$(wc -l < seed/usage.tsv) hourly model totals copied from the relay"
rm -f seed/usage.tsv
