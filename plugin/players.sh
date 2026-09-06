#!/usr/bin/env bash
# Print connected players as SteamID64, ready to paste into sm_pug_roster.
#
# `status` reports the legacy STEAM_X:Y:Z form, but the plugin keys the roster on
# SteamID64, so this converts: id64 = 76561197960265728 + Z*2 + Y.
#
# The conversion is done in Python, not awk: the base constant is larger than
# 2^53, so awk's double-precision arithmetic silently returns an id that is off
# by a few, which would look plausible and then fail to match anyone in game.
#
#   ./players.sh          name + SteamID64 per connected human
#   ./players.sh --roster ready-made sm_pug_roster lines, alternating a/b
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/../../deploy"
# shellcheck source=/dev/null
[ -f "$DEPLOY/server.env" ] && . "$DEPLOY/server.env"

if [ -z "${L4D_RCON_PW:-}" ]; then
  SECRETS="$DEPLOY/overrides/left4dead/cfg/secrets.cfg"
  [ -f "$SECRETS" ] && L4D_RCON_PW=$(sed -n 's/^[[:space:]]*rcon_password[[:space:]]*"\([^"]*\)".*/\1/p' "$SECRETS" | head -1)
  export L4D_RCON_PW
fi
[ -n "${L4D_RCON_PW:-}" ] || { echo "No RCON password (set L4D_RCON_PW)"; exit 1; }

MODE=list
[ "${1:-}" = "--roster" ] && MODE=roster

"$DEPLOY/rcon.py" status | MODE="$MODE" python3 -c '
import os, re, sys

BASE = 76561197960265728
mode = os.environ["MODE"]
# Client lines carry a quoted name. Matching on the quote rather than on field
# position handles both `# 2 "name"` and `#2 "name"` spacings.
line_re = re.compile(r"^#.*\"(?P<name>[^\"]*)\"")
sid_re = re.compile(r"STEAM_[0-9]:(?P<y>[0-9]):(?P<z>[0-9]+)")

rows = []
for line in sys.stdin:
    m = line_re.match(line)
    if not m or m.group("name") == "SourceTV":
        continue
    s = sid_re.search(line)
    rows.append((m.group("name"), BASE + int(s.group("z")) * 2 + int(s.group("y")) if s else None))

if not rows:
    print("No players connected.")
    sys.exit(0)

for i, (name, id64) in enumerate(rows):
    if id64 is None:
        print(f"{name:<24} (no STEAM id on this status line)")
    elif mode == "roster":
        team = "b" if i % 2 else "a"
        print("sm_pug_roster \"%d:%s\"   # %s" % (id64, team, name))
    else:
        print(f"{name:<24} {id64}")
'
