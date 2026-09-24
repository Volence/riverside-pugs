#!/usr/bin/env bash
# Regenerate web/src/hud/dll-hud-strings.txt: the runs of client.dll's
# strings around its HUD code, which dllstrings.test.ts reads.
#
# The honest registry (audit item): the editor may offer a file key or add a
# child only if the game can read it, and a key is read only if client.dll
# names it. The weapons work learned that a key can look right, sit in a
# registry and a stock file, and still be one code never reads, so every
# KeyDef.key and every addable child name must appear, as a whole line, in
# the string runs this script saves. The first line records the dll's md5,
# so a game update that moves the strings shows as a failing test.
#
# Usage: bash scripts/dll-hud-strings.sh [path/to/client.dll]
# The dll is only read, never written.
set -euo pipefail
DLL="${1:-$HOME/.steam/steam/steamapps/common/left 4 dead/left4dead/bin/client.dll}"
OUT="$(dirname "$0")/../web/src/hud/dll-hud-strings.txt"
ANCHORS='resource/ui/hud/|LocalPlayerPanel|TeammatePanel|HealthPanel|CircularProgressBar|CHudAbilityTimer|CHudTerrorCrosshair|ZombieTeamDisplay|FrustrationBar'
{
  echo "# client.dll md5 $(md5sum "$DLL" | cut -d' ' -f1)"
  echo "# strings -a -n 3 client.dll | grep -i -C 30 -E '$ANCHORS'"
  strings -a -n 3 "$DLL" | grep -i -C 30 -E "$ANCHORS"
} > "$OUT"
