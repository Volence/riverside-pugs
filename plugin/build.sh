#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az
cp pug-match.sp "$SCRIPTING/pug-match.sp"
trap 'rm -f "$SCRIPTING/pug-match.sp"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe pug-match.sp -o pug-match.smx -iinclude)
mv "$SCRIPTING/pug-match.smx" ./pug-match.smx
echo "built: $(pwd)/pug-match.smx"
