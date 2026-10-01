#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build-tvwatch.sh. 1.1.0 signs its captain-command lines through
# pug-logauth.inc (pulls in pug-hmac.inc), so both are copied in and cleaned
# up the same way build-tvwatch.sh does for l4d_tvwatch.
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_booking.sp "$SCRIPTING/l4d_booking.sp"
cp pug-logauth.inc "$SCRIPTING/pug-logauth.inc"
cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"
trap 'rm -f "$SCRIPTING/l4d_booking.sp" "$SCRIPTING/pug-logauth.inc" "$SCRIPTING/pug-hmac.inc"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_booking.sp -o l4d_booking.smx -iinclude)
mv "$SCRIPTING/l4d_booking.smx" ./l4d_booking.smx
echo "built: $(pwd)/l4d_booking.smx"
