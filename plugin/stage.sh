#!/usr/bin/env bash
# Install (or reload) pug-match.smx on the L4D1 box for a testing session.
#
# Deliberately does NOT use deploy/deploy.sh: that rsyncs every override and
# restarts the service, which kicks everyone. SourceMod can load a plugin on a
# running server, so this copies one file and calls `sm plugins load`. No
# restart, no map change, nobody dropped.
#
# The plugin is inert until an sm_pug_match arrives (every hook early-returns at
# MS_None; the kick path in OnClientPostAdminCheck is gated too), so it is safe
# to leave installed on the casual server between test sessions.
#
#   ./stage.sh            install/reload, refuse if anyone is connected
#   ./stage.sh --solo     also set sm_pug_min_orient 1 + sm_pug_debug 1
#   ./stage.sh --force    skip the empty-server check (you are sure)
#   ./stage.sh --status   just print plugin + cvar state, change nothing
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/../../deploy"
[ -f "$DEPLOY/server.env" ] || { echo "no $DEPLOY/server.env"; exit 1; }
# shellcheck source=/dev/null
. "$DEPLOY/server.env"
HOST=${L4D_HOST:?set L4D_HOST in deploy/server.env}
REMOTE=/home/l4d/l4d1-server/left4dead/addons/sourcemod/plugins
RCON="$DEPLOY/rcon.py"

SOLO=0; FORCE=0; STATUS_ONLY=0
for a in "$@"; do
  case "$a" in
    --solo) SOLO=1 ;;
    --force) FORCE=1 ;;
    --status) STATUS_ONLY=1 ;;
    *) echo "unknown flag: $a"; exit 1 ;;
  esac
done

show_status() {
  echo "==> sm plugins list (pug-match):"
  "$RCON" "sm plugins list" | grep -i "pug-match" || echo "    NOT LOADED"
  echo "==> cvars:"
  "$RCON" "sm_pug_min_orient" || true
  "$RCON" "sm_pug_debug" || true
  echo "==> sm_pug_status:"
  "$RCON" "sm_pug_status" || true
}

if [ "$STATUS_ONLY" = 1 ]; then show_status; exit 0; fi

[ -f "$HERE/pug-match.smx" ] || { echo "no pug-match.smx; run ./build.sh first"; exit 1; }

# Refuse to touch a server with people on it.
#
# Counted two independent ways, taking the larger so the guard fails safe:
#  a) the "players : N humans" summary line
#  b) client lines, matched on the quoted name because some Source builds print
#     "#2 \"name\"" with no space after the hash, which a positional
#     ($2 is numeric) match silently reads as zero players. That exact case was
#     wrong in the first version of this script.
# SourceTV is subtracted from both; it is a spectator slot, not a player.
count_players() {
  local txt="$1" humans tv lines
  humans=$(printf '%s\n' "$txt" | sed -n 's/.*players *: *\([0-9]\+\) humans.*/\1/p' | head -1)
  humans=${humans:-0}
  tv=$(printf '%s\n' "$txt" | grep -c '^#.*"SourceTV"' || true)
  lines=$(printf '%s\n' "$txt" | grep -c '^#.*".*"' || true)
  lines=$(( lines - tv )); [ "$lines" -lt 0 ] && lines=0
  humans=$(( humans - tv )); [ "$humans" -lt 0 ] && humans=0
  if [ "$humans" -gt "$lines" ]; then echo "$humans"; else echo "$lines"; fi
}

echo "==> Checking whether anyone is playing..."
STATUS_OUT=$("$RCON" "status" || true)
printf '%s\n' "$STATUS_OUT" | sed -n '1,12p'
PLAYERS=$(count_players "$STATUS_OUT")
echo "    -> $PLAYERS player(s) connected"
if [ "$PLAYERS" -gt 0 ] && [ "$FORCE" != 1 ]; then
  echo
  echo "REFUSING: $PLAYERS player(s) connected."
  echo "Loading a plugin live is low risk, but this is your live casual server."
  echo "Wait for it to empty, or re-run with --force if you know who is on it."
  exit 1
fi

echo "==> Copying pug-match.smx to $HOST"
rsync -az --info=stats1 "$HERE/pug-match.smx" "root@$HOST:$REMOTE/pug-match.smx"
ssh "root@$HOST" "chown l4d:l4d $REMOTE/pug-match.smx"

# `sm plugins load` on an already-loaded plugin is a no-op, so reload if present.
echo "==> Loading plugin"
if "$RCON" "sm plugins list" | grep -qi "pug-match"; then
  "$RCON" "sm plugins reload pug-match"
else
  "$RCON" "sm plugins load pug-match"
fi

echo "==> Verifying"
if ! "$RCON" "sm plugins list" | grep -i "pug-match"; then
  echo
  echo "FAILED to load. Most likely cause is a missing dependency: this plugin"
  echo "needs left4dhooks. Check the SourceMod error log:"
  echo "  ssh root@$HOST 'ls -t $REMOTE/../logs/errors_*.log | head -1 | xargs tail -30'"
  exit 1
fi

if [ "$SOLO" = 1 ]; then
  echo "==> Solo test mode: min_orient=1, debug=1"
  "$RCON" "sm_pug_min_orient 1"
  "$RCON" "sm_pug_debug 1"
  echo "    REMEMBER: set sm_pug_min_orient back to 3 before a real match."
fi

echo
show_status
echo
echo "Ready. Runbook: plugin/TESTING.md"
