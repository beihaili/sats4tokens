#!/bin/sh
# Write public/upstreams.json: the anonymized routing table behind the gateway's /network page.
#
# Reads the DEMO DB only (its channels/abilities are the copy sync-channels.sh made). Hosts go into the
# anonymizer on stdin and never touch the disk; the output has provider letters (A, B, …) instead of names,
# hosts or keys. The gateway mounts public/ read-only (UPSTREAMS_FILE) and re-reads the file when it changes,
# so no restart is needed. Re-run after sync-channels.sh (it calls this at the end) or after editing channels.
set -eu
cd "$(dirname "$0")"
DEMO=cashu-demo-mysql
GROUP=${1:-default} # the key shop pool user's group

SQL='select json_object(
  "channels", (select json_arrayagg(json_object("id", id, "status", status,
     "host", substring_index(substring_index(base_url, "://", -1), "/", 1),
     "priority", ifnull(priority, 0), "weight", ifnull(weight, 0), "latencyMs", response_time)) from channels),
  "abilities", (select json_arrayagg(json_object("group", `group`, "model", model, "channel", channel_id,
     "enabled", enabled)) from abilities))'

mkdir -p public
docker exec "$DEMO" sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" newapi -N -B --raw -e '$SQL'" 2>/dev/null \
  | docker exec -i cashu-demo-gateway node --disable-warning=ExperimentalWarning scripts/export-upstreams.ts "$GROUP" \
  > public/upstreams.json.tmp
mv public/upstreams.json.tmp public/upstreams.json # atomic: the gateway never reads half a file
chmod 644 public/upstreams.json
