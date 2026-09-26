#!/usr/bin/env bash
# Deploy the pug web app to the Dallas box.
#
# This is NOT /home/volence/l4d/deploy/deploy.sh, which pushes game-server
# overrides and restarts srcds. This one only touches /home/pug/app and the
# pug-web service; it never restarts the game server.
#
#   ./deploy-web.sh              # sync, install, build, then restart once it is safe
#   ./deploy-web.sh --no-restart # sync, install, build, leave the service alone
#   ./deploy-web.sh --force      # restart without the live-match safety check
#
# Deploying during live matches is allowed (owner, 2026-09-26). A restart takes about
# 2 s; the game servers and their players never notice, the queue survives, and the
# new process re-registers every live match. Tested on matches 230 + 232 mid-play: one
# stats event lost, nothing else. What CAN go wrong is timing, so before restarting
# this waits (up to 15 min) until:
#   - no match is pending or configuring (setup is in flight),
#   - no enabled server is 'offline' (mid restart-after-match: a restart then strands
#     it offline for good, Chicago 2026-09-26),
#   - every live match is 10+ min in or has all 8 players marked connected (a connect
#     event lost in the gap lets the no-show reaper abort it, match 168 2026-09-24).
set -euo pipefail

HOST=${L4D_HOST:-45.32.199.85}
REMOTE=/home/pug/app
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Two .git excludes on purpose. In a normal checkout .git is a DIRECTORY and
# '.git/' matches it. In a git worktree .git is a FILE holding a gitdir pointer,
# which a trailing-slash pattern does not match, so deploying from a worktree
# would push a stray .git file naming a path that does not exist on the server.
#
# .env and data/ live ONLY on the server. They are excluded not just to avoid
# overwriting them but because --delete would otherwise remove them outright,
# which is exactly what happened on 2026-09-11: the sync wiped the env file and
# the service could not start. Do not remove these two excludes.
rsync -az --delete --info=stats1 \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude '.git/' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '*.db' \
  --exclude '*.db-*' \
  --exclude '.superpowers/' \
  `# Local Claude Code state: its worktrees are whole checkouts of other,
   # possibly unpushed branches (240 MB went up on 2026-09-25 before this).` \
  --exclude '.claude/' \
  `# The 4x overview layers: 182 files, 989 MB, served from R2 and not committed.
   # Gitignoring them keeps them out of git, not out of rsync, and this box moved
   # its demos off for disk in the first place. Excluding leaves the old 1x webp
   # in place on the server, which nothing references once the manifest points at
   # assets.riversidepug.com, and which are a free way back if it ever needs to.` \
  --exclude 'web/public/overviews/' \
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

if [ "${1:-}" != "--force" ]; then
  # One query, one line: "<pending/configuring> <offline servers> <young, not fully connected live matches>".
  unsafe() {
    ssh "root@$HOST" "sqlite3 $REMOTE/data/pug.db \"select
      (select count(*) from matches where state in ('pending','configuring')),
      (select count(*) from servers where enabled = 1 and status = 'offline'),
      (select count(*) from matches m where m.state = 'live'
         and (m.went_live_at is null or julianday('now') - julianday(m.went_live_at) < 10.0 / 1440)
         and (select count(*) from match_players p where p.match_id = m.id and p.connected_at is null) > 0);\"" | tr '|' ' '
  }
  for i in $(seq 90); do
    read -r setup offline young <<< "$(unsafe)"
    [ "$setup" = 0 ] && [ "$offline" = 0 ] && [ "$young" = 0 ] && break
    [ "$i" = 1 ] && echo "==> Waiting to restart: $setup match(es) in setup, $offline server(s) restarting, $young live match(es) under 10 min with players not yet connected"
    [ "$i" = 90 ] && { echo "==> Still not safe after 15 min; built but NOT restarted. Re-run, or --force."; exit 1; }
    sleep 10
  done
fi

ssh "root@$HOST" 'systemctl restart pug-web && sleep 4 && systemctl is-active pug-web'
curl -sf -o /dev/null -w "==> https://riversidepug.com HTTP %{http_code}\n" https://riversidepug.com/
