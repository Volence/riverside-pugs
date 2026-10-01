#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build-tvwatch.sh, but builds only l4d_booking (no includes of its own).
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_booking.sp "$SCRIPTING/l4d_booking.sp"
trap 'rm -f "$SCRIPTING/l4d_booking.sp"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_booking.sp -o l4d_booking.smx -iinclude)
mv "$SCRIPTING/l4d_booking.smx" ./l4d_booking.smx
echo "built: $(pwd)/l4d_booking.smx"
