#!/usr/bin/env bash
# Deploy the pug web app to the Dallas box.
#
# This is NOT /home/volence/l4d/deploy/deploy.sh, which pushes game-server
# overrides and restarts srcds. This one only touches /home/pug/app and the
# pug-web service; it never restarts the game server.
#
#   ./deploy-web.sh              # sync, install, build, restart
#   ./deploy-web.sh --no-restart # sync, install, build, leave the service alone
set -euo pipefail

HOST=${L4D_HOST:-45.32.199.85}
REMOTE=/home/pug/app
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# .env and data/ live ONLY on the server. They are excluded not just to avoid
# overwriting them but because --delete would otherwise remove them outright,
# which is exactly what happened on 2026-09-11: the sync wiped the env file and
# the service could not start. Do not remove these two excludes.
rsync -az --delete --info=stats1 \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '*.db' \
  --exclude '*.db-*' \
  --exclude '.superpowers/' \
  "$HERE/" "root@$HOST:$REMOTE/"

ssh "root@$HOST" "set -e
  chown -R pug:pug $REMOTE
  [ -f $REMOTE/.env ] || { echo 'FATAL: $REMOTE/.env is missing'; exit 1; }
  cd $REMOTE
  sudo -u pug npm ci
  sudo -u pug npm run build"

if [ "${1:-}" = "--no-restart" ]; then
  echo "==> Skipping restart (--no-restart)"
  exit 0
fi

ssh "root@$HOST" 'systemctl restart pug-web && sleep 4 && systemctl is-active pug-web'
curl -sf -o /dev/null -w "==> https://riversidepug.com HTTP %{http_code}\n" https://riversidepug.com/
