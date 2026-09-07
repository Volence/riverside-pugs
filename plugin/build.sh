#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az
cp pug-match.sp "$SCRIPTING/pug-match.sp"
cp pug-stats.inc "$SCRIPTING/pug-stats.inc"
cp /home/volence/l4d/L4D1_2-Plugins/l4d2_skill_detect/scripting/include/l4d2_skill_detect.inc "$SCRIPTING/include/l4d2_skill_detect.inc"
trap 'rm -f "$SCRIPTING/pug-match.sp" "$SCRIPTING/pug-stats.inc" "$SCRIPTING/include/l4d2_skill_detect.inc"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe pug-match.sp -o pug-match.smx -iinclude)
mv "$SCRIPTING/pug-match.smx" ./pug-match.smx
echo "built: $(pwd)/pug-match.smx"
