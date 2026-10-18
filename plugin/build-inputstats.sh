#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build-sprayreport.sh, but builds only l4d_inputstats.
#
#   ./build-inputstats.sh            l4d_inputstats.smx, the one to stage
#   DEBUG=1 ./build-inputstats.sh    l4d_inputstats_debug.smx, with the
#                                    sm_inputstats_emit self-test. Never stage it.
set -euo pipefail
cd "$(dirname "$0")"
# PUG_SCRIPTING overrides the tree, for testing the build against a scratch copy.
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_inputstats.sp "$SCRIPTING/l4d_inputstats.sp"
# Signed log lines: shared with pug-match, l4d_lilac_report, l4d_spray_report,
# l4d_cvarwatch and consistency/plugin/l4d_consistency, which need the same
# two files beside them when they are compiled.
cp pug-logauth.inc "$SCRIPTING/pug-logauth.inc"
cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"
trap 'rm -f "$SCRIPTING/l4d_inputstats.sp" "$SCRIPTING/pug-logauth.inc" "$SCRIPTING/pug-hmac.inc"' EXIT
OUT=l4d_inputstats.smx
DEFS=""
if [ "${DEBUG:-0}" = "1" ]; then OUT=l4d_inputstats_debug.smx; DEFS="DEBUG=1"; fi
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_inputstats.sp -o "$OUT" -iinclude $DEFS)
mv "$SCRIPTING/$OUT" "./$OUT"
echo "built: $(pwd)/$OUT"
