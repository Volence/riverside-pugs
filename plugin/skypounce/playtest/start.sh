#!/usr/bin/env bash
# Local playtest instance for l4d_skypounce. Isolated copy, port 27045, LAN only.
#   connect <this machine's LAN ip>:27045     (or: connect localhost:27045)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST=/home/volence/l4d1-ds-skyprobe/server
SM=$INST/left4dead/addons/sourcemod
SHARED=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
MAP=${1:-l4d_vs_hospital01_apartment}
if ps -eo args | grep -q "[s]rcds_linux.*-port 27045"; then echo "already running on 27045"; exit 1; fi
(cd "$SM/scripting" && ./spcomp "$HERE/../l4d_skypounce.sp" -o "$HERE/../l4d_skypounce.smx" -i include >/dev/null \
  && ./spcomp "$HERE/playtest/firemeter.sp" -o "$HERE/playtest/firemeter.smx" -i include >/dev/null)
rm -rf "$SM/plugins" && mkdir -p "$SM/plugins"
for p in admin-flatfile basecommands basechat playercommands funcommands l4d2_pistol_delay; do
  [ -f "$SHARED/$p.smx" ] && cp "$SHARED/$p.smx" "$SM/plugins/"
done
cp "$HERE/../l4d_skypounce.smx" "$HERE/playtest/firemeter.smx" "$HERE/playtest/alwayshunter.smx" "$SHARED/left4dhooks.smx" "$SM/plugins/"
cp "$HERE/playtest/playtest.cfg" "$INST/left4dead/cfg/skyplaytest.cfg"
# A fresh rcon password per run; rcon.py reads it back out of this file.
printf 'rcon_password "%s"\n' "$(head -c 12 /dev/urandom | base64 | tr -dc A-Za-z0-9)" >> "$INST/left4dead/cfg/skyplaytest.cfg"
cd "$INST"
exec ./srcds_run -console -game left4dead -ip 0.0.0.0 -port 27045 -tickrate 100 -maxplayers 8 \
  -norestart -insecure -nomaster +sv_lan 1 +mp_gamemode versus +exec skyplaytest +map "$MAP"
