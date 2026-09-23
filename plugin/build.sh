#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az
cp pug-match.sp "$SCRIPTING/pug-match.sp"
cp pug-stats.inc "$SCRIPTING/pug-stats.inc"
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
CLEANUP="$SCRIPTING/pug-match.sp $SCRIPTING/pug-stats.inc $SCRIPTING/pug-leave.inc $SCRIPTING/pug-pause.inc $SCRIPTING/pug-logauth.inc $SCRIPTING/pug-hmac.inc $SCRIPTING/pug-livepush.inc"
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
# installed on every server; ripext.inc modified so the plugin never autoloads
# the extension). Same borrow-and-clean-up rule as above.
RIPEXT_INC="$SCRIPTING/include/ripext.inc"
RIPEXT_DIR_MADE=0
if [ ! -e "$RIPEXT_INC" ]; then
	[ -d "$SCRIPTING/include/ripext" ] || { mkdir "$SCRIPTING/include/ripext"; RIPEXT_DIR_MADE=1; }
	cp include/ripext.inc "$RIPEXT_INC"
	cp include/ripext/http.inc include/ripext/json.inc "$SCRIPTING/include/ripext/"
	CLEANUP="$CLEANUP $RIPEXT_INC $SCRIPTING/include/ripext/http.inc $SCRIPTING/include/ripext/json.inc"
fi
trap 'rm -f '"$CLEANUP"'; [ '"$RIPEXT_DIR_MADE"' = 1 ] && rmdir "'"$SCRIPTING"'/include/ripext" 2>/dev/null; true' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe pug-match.sp -o pug-match.smx -iinclude)
mv "$SCRIPTING/pug-match.smx" ./pug-match.smx
echo "built: $(pwd)/pug-match.smx"
