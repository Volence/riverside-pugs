#!/usr/bin/env bash
# Install (or reload) l4d_skypounce.smx on one of the four servers with no
# restart. Same shape as pug/plugin/stage.sh, which documents why each step is
# here: empty-server guard, load_unlock / load / load_lock around Rotoblin's
# plugin lock, reload first and fall back to load.
#
#   ./stage.sh <target>            install/reload, refuse if anyone is connected
#   ./stage.sh <target> --force    skip the empty-server check
#   ./stage.sh <target> --status   print plugin + cvar state, change nothing
#   ./stage.sh <target> --remove   unload it and delete the file (rollback)
#
# <target>: dallas | riverside-a | riverside-b | chicago   (default: dallas)
#
# Dallas and Riverside are reached over ssh, with rcon through deploy/rcon.py's
# ssh tunnel. Chicago is an NFO box with no ssh: FTP upload and direct rcon.
# Every secret is read from the gitignored files under the deploy repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY=${L4D_DEPLOY:-/home/volence/l4d/deploy}
NAME="L4D1 sky pounce block"
SMX="$HERE/../l4d_skypounce.smx"

TARGET=dallas
case "${1:-}" in dallas|riverside-a|riverside-b|chicago) TARGET=$1; shift ;; esac
ACTION=${1:-}

pw_from() { sed -n 's/^[[:space:]]*rcon_password[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }
envval() { sed -n "s/^$2=//p" "$1" | head -1 | tr -d "\"'"; }

case "$TARGET" in
  dallas)
    HOST=$(envval "$DEPLOY/server.env" L4D_HOST); PORT=27015
    REMOTE=/home/l4d/l4d1-server/left4dead/addons/sourcemod/plugins
    PW=$(pw_from "$DEPLOY/overrides/left4dead/cfg/secrets.cfg") ;;
  riverside-a|riverside-b)
    HOST=$(envval "$DEPLOY/riverside1/riverside1.env" L4D_HOST)
    if [ "$TARGET" = riverside-a ]; then PORT=27015; INST=l4d1-a; else PORT=27016; INST=l4d1-b; fi
    REMOTE=/home/l4d/$INST/left4dead/addons/sourcemod/plugins
    PW=$(pw_from "$DEPLOY/riverside1/secrets.cfg") ;;
  chicago)
    REMOTE=/left4dead/addons/sourcemod/plugins ;;
esac

rcon() {
  if [ "$TARGET" = chicago ]; then python3 "$DEPLOY/nfo/rcon_direct.py" "$1"
  else L4D_HOST=$HOST L4D_PORT=$PORT L4D_RCON_PW=$PW "$DEPLOY/rcon.py" "$1"; fi
}

status() {
  rcon "sm plugins list" | grep -F "$NAME" || echo "    NOT LOADED"
  rcon "l4d_skypounce_mode" | grep -a '" = "' || true
  rcon "l4d_skypounce_enable" | grep -a '" = "' || true
  rcon "l4d_skypounce_debug" | grep -a '" = "' || true
}

echo "== $TARGET"
if [ "$ACTION" = --status ]; then status; exit 0; fi
if [ "$ACTION" = --remove ]; then
  rcon "sm plugins load_unlock" >/dev/null
  rcon "sm plugins unload l4d_skypounce" || true
  rcon "sm plugins load_lock" >/dev/null
  if [ "$TARGET" = chicago ]; then echo "Chicago: delete $REMOTE/l4d_skypounce.smx over FTP by hand (ftpsync.py only deletes directories)."
  else ssh "root@$HOST" "rm -f $REMOTE/l4d_skypounce.smx"; fi
  status; exit 0
fi

[ -f "$SMX" ] || { echo "no l4d_skypounce.smx; compile it first (rig/run.sh does, or spcomp by hand)"; exit 1; }
[ "$SMX" -nt "$HERE/../l4d_skypounce.sp" ] || { echo "the .smx is older than the .sp; recompile"; exit 1; }

# Refuse to touch a server with people on it. Counted two ways and the larger
# taken, so the guard fails safe; SourceTV and bots are not players.
OUT=$(rcon "status" || true)
printf '%s\n' "$OUT" | grep -aE "^hostname|^map|^players" || true
HUMANS=$(printf '%s\n' "$OUT" | sed -n 's/.*players *: *\([0-9]\+\) humans.*/\1/p' | head -1); HUMANS=${HUMANS:-0}
ROWS=$(printf '%s\n' "$OUT" | grep -a '^#.*".*"' | grep -avc 'BOT' || true)
PLAYERS=$(( HUMANS > ROWS ? HUMANS : ROWS ))
echo "    -> $PLAYERS human player(s) connected"
if [ "$PLAYERS" -gt 0 ] && [ "$ACTION" != --force ]; then echo "REFUSING: someone is on $TARGET."; exit 1; fi

if [ "$TARGET" = chicago ]; then
  TMP=$(mktemp -d); cp "$SMX" "$TMP/"
  python3 "$DEPLOY/nfo/ftpsync.py" upload "$TMP" "$REMOTE" | tail -2
  rm -rf "$TMP"
else
  rsync -az "$SMX" "root@$HOST:$REMOTE/l4d_skypounce.smx"
  ssh "root@$HOST" "chown l4d:l4d $REMOTE/l4d_skypounce.smx"
fi

rcon "sm plugins load_unlock" >/dev/null
R=$(rcon "sm plugins reload l4d_skypounce" 2>&1 || true); printf '%s\n' "$R"
if printf '%s' "$R" | grep -qiE "not loaded|not found|unable to|invalid|failed"; then rcon "sm plugins load l4d_skypounce"; fi
rcon "sm plugins load_lock" >/dev/null
echo "==> verifying"; status
