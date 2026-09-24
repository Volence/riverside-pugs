#!/usr/bin/env bash
# Run the bot rig against l4d_skypounce on the ISOLATED test instance.
#
#   rig/run.sh [map] [bare|roto]
#
# bare: nothing loaded but SourceMod's basics, the rig and the plugin under test.
# roto: the whole plugin set of the shared test install (Rotoblin-AZMod, as on
#       production) beside them, to catch a conflict with another plugin.
#
# Never touches /home/volence/l4d1-ds (the shared install) except to READ its
# plugins dir, and never goes near a live server.
set -euo pipefail
MAP=${1:-l4d_hospital01_apartment}
MODE=${2:-bare}
ALLOW=${3:-1}
RULE=${4:-1}     # l4d_skypounce_mode: 1 Zen, 2 surface
PITCH=${5:-12}   # pitch the bot holds under the sky
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST=/home/volence/l4d1-ds-skyprobe/server
SHARED=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
SM=$INST/left4dead/addons/sourcemod
PORT=27045

if pgrep -f "srcds_linux.*-port $PORT" >/dev/null; then echo "an instance is already on $PORT"; exit 1; fi

(cd "$SM/scripting" && ./spcomp "$HERE/../l4d_skypounce.sp" -o "$HERE/../l4d_skypounce.smx" -i include >/dev/null \
  && ./spcomp "$HERE/rig/skyrig.sp" -o "$HERE/rig/skyrig.smx" -i include >/dev/null)

rm -rf "$SM/plugins" && mkdir -p "$SM/plugins/disabled"
if [ "$MODE" = roto ]; then
  cp -a "$SHARED/." "$SM/plugins/"
  # Another session's test plugins live in the shared dir; they are not part of production.
  rm -f "$SM/plugins"/{l4d_probe,skyprobe,skyrig,l4d_skypounce}.smx
else
  cp "$SHARED/admin-flatfile.smx" "$SHARED/basecommands.smx" "$SM/plugins/"
fi
cp "$HERE/rig/skyrig.smx" "$SM/plugins/"
cp "$HERE/../l4d_skypounce.smx" "$SM/plugins/disabled/"
rm -f "$SM/logs/skyrig.log" "$SM/logs/skypounce.log"
# server.cfg runs at every map start, after plugins have loaded, so the rig's cvar exists by then.
sed -i '/^skyrig_/d' "$INST/left4dead/cfg/server.cfg"; printf 'skyrig_allow %s\nskyrig_mode %s\nskyrig_pitch %s\n' "$ALLOW" "$RULE" "$PITCH" >> "$INST/left4dead/cfg/server.cfg"

cd "$INST"
timeout 420 ./srcds_run -console -game left4dead -ip 127.0.0.1 -port $PORT -tickrate 100 -maxplayers 8 \
  -norestart -insecure -nomaster +sv_lan 1 +mp_gamemode coop +exec server +map "$MAP" \
  > "$HERE/rig/console-$MODE-$MAP.log" 2>&1 < /dev/null || true

echo "== $MODE $MAP allow=$ALLOW rule=$RULE pitch=$PITCH"
sed -E 's/^L [0-9/]+ - [0-9:]+: \[skyrig.smx\] //' "$SM/logs/skyrig.log" | grep -E "^RESULT|NOT FOUND|GIVING UP|never fired|^sky at|^wall at|^NO " || echo "(no rig output)"
echo "== plugin log"
sed -E 's/^L [0-9/]+ - [0-9:]+: \[l4d_skypounce.smx\] //' "$SM/logs/skypounce.log" 2>/dev/null || echo "(nothing blocked)"
