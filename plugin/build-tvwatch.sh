#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build.sh, but builds only l4d_tvwatch.
set -euo pipefail
cd "$(dirname "$0")"
# PUG_SCRIPTING overrides the tree, for testing the build against a scratch copy.
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_tvwatch.sp "$SCRIPTING/l4d_tvwatch.sp"
# Signed log lines: shared with pug-match, l4d_inputstats, l4d_lilac_report,
# l4d_cvarwatch and consistency/plugin/l4d_consistency, which need the same
# two files beside them when they are compiled.
cp pug-logauth.inc "$SCRIPTING/pug-logauth.inc"
cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"
CLEANUP="$SCRIPTING/l4d_tvwatch.sp $SCRIPTING/pug-logauth.inc $SCRIPTING/pug-hmac.inc"
# geoip.inc is a stock SourceMod include, but this Rotoblin tree does not ship
# one. Only copy it in (and only trap-delete it) when it is not already
# there, same rule as build.sh, so a build here never clobbers a real copy
# another build left behind. (GeoipCode2 is feature-checked at runtime, so
# the extension being absent on a box is fine.)
GEOIP_INC="$SCRIPTING/include/geoip.inc"
if [ ! -e "$GEOIP_INC" ]; then
	cp /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/scripting/include/geoip.inc "$GEOIP_INC"
	CLEANUP="$CLEANUP $GEOIP_INC"
fi
# plugin/include is vendored includes (sourcetvmanager.inc here; ripext.inc
# for other plugins). Same as build.sh: a private, throwaway directory inside
# the scripting tree, put FIRST on the include path, so it wins over any
# same-named include the Rotoblin tree's own include/ may hold, and nothing
# in that include/ is ever written or deleted. Relative, because absolute
# unix paths break spcomp under wine.
VENDOR_DIR=$(mktemp -d "$SCRIPTING/pug-vendor-include.XXXXXX")
cp -r include/. "$VENDOR_DIR/"
VENDOR_REL=$(basename "$VENDOR_DIR")
trap 'rm -f '"$CLEANUP"'; rm -rf "'"$VENDOR_DIR"'"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_tvwatch.sp -o l4d_tvwatch.smx -i"$VENDOR_REL" -iinclude)
mv "$SCRIPTING/l4d_tvwatch.smx" ./l4d_tvwatch.smx
echo "built: $(pwd)/l4d_tvwatch.smx"
