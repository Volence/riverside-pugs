#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
set -euo pipefail
cd "$(dirname "$0")"
# PUG_SCRIPTING overrides the tree, for testing the build against a scratch copy.
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp pug-match.sp "$SCRIPTING/pug-match.sp"
cp pug-stats.inc "$SCRIPTING/pug-stats.inc"
cp pug-balance.inc "$SCRIPTING/pug-balance.inc"
cp pug-balance-list.inc "$SCRIPTING/pug-balance-list.inc"
cp pug-leave.inc "$SCRIPTING/pug-leave.inc"
cp pug-pause.inc "$SCRIPTING/pug-pause.inc"
# Signed log lines: shared with l4d_inputstats, l4d_lilac_report and
# consistency/plugin/l4d_consistency, which need the same two files beside
# them when they are compiled.
cp pug-logauth.inc "$SCRIPTING/pug-logauth.inc"
cp pug-hmac.inc "$SCRIPTING/pug-hmac.inc"
cp pug-livepush.inc "$SCRIPTING/pug-livepush.inc"
# include/l4d2_skill_detect.inc is shared with other plugins that build against
# the same Rotoblin tree, so only copy it in (and only trap-delete it) when it
# is not already there. Otherwise a build here would overwrite a real copy and
# then the trap would delete it out from under whatever put it there.
SKILL_DETECT_INC="$SCRIPTING/include/l4d2_skill_detect.inc"
CLEANUP="$SCRIPTING/pug-match.sp $SCRIPTING/pug-stats.inc $SCRIPTING/pug-balance.inc $SCRIPTING/pug-balance-list.inc $SCRIPTING/pug-leave.inc $SCRIPTING/pug-pause.inc $SCRIPTING/pug-logauth.inc $SCRIPTING/pug-hmac.inc $SCRIPTING/pug-livepush.inc"
if [ ! -e "$SKILL_DETECT_INC" ]; then
	cp /home/volence/l4d/L4D1_2-Plugins/l4d2_skill_detect/scripting/include/l4d2_skill_detect.inc "$SKILL_DETECT_INC"
	CLEANUP="$CLEANUP $SKILL_DETECT_INC"
fi
# geoip.inc is a stock SourceMod include, but this Rotoblin tree does not ship
# one. Same borrow-and-clean-up rule as skill_detect above, so a fresh checkout
# builds without anyone having to know about it. (EmitClientNet feature-checks
# the native at runtime, so the extension being absent on a box is fine.)
GEOIP_INC="$SCRIPTING/include/geoip.inc"
if [ ! -e "$GEOIP_INC" ]; then
	cp /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/scripting/include/geoip.inc "$GEOIP_INC"
	CLEANUP="$CLEANUP $GEOIP_INC"
fi
# REST in Pawn's includes are vendored in plugin/include (1.3.2, the version
# installed on every server; ripext.inc MODIFIED to autoload = 0, required = 0
# so staging this plugin never loads rip.ext). They go into a private,
# throwaway directory inside the scripting tree that is put FIRST on the
# include path, so they win over any ripext.inc (upstream or otherwise) that
# the Rotoblin tree's own include/ may hold, and nothing in that include/ is
# ever written or deleted. Relative, because absolute unix paths break spcomp
# under wine.
VENDOR_DIR=$(mktemp -d "$SCRIPTING/pug-vendor-include.XXXXXX")
cp -r include/. "$VENDOR_DIR/"
VENDOR_REL=$(basename "$VENDOR_DIR")
trap 'rm -f '"$CLEANUP"'; rm -rf "'"$VENDOR_DIR"'"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe pug-match.sp -o pug-match.smx -i"$VENDOR_REL" -iinclude)
mv "$SCRIPTING/pug-match.smx" ./pug-match.smx
echo "built: $(pwd)/pug-match.smx"
