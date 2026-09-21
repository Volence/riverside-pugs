#!/usr/bin/env bash
# Check plugin/pug-hmac.inc against the shared vector table, in a real
# SourcePawn VM and with no game server: compile tests/logauth_vectors.sp with
# the same spcomp the plugins are built with, then run it under spshell.
#
# spshell is the SourcePawn VM's own test shell. Nothing ships one; build it
# once from https://github.com/alliedmodders/sourcepawn (ambuild, about five
# minutes) and point SPSHELL at obj/spshell/linux-x86_64/spshell.
#
# Compiles in a scratch directory, so unlike build.sh it never writes into the
# shared Rotoblin tree.
set -euo pipefail
cd "$(dirname "$0")"
: "${SPSHELL:?set SPSHELL to a built spshell binary}"
SCRIPTING=/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$SCRIPTING/spcomp.exe" pug-hmac.inc tests/logauth_vectors.sp "$WORK/"
ln -s "$SCRIPTING/include" "$WORK/include"
(cd "$WORK" && wine ./spcomp.exe logauth_vectors.sp -o logauth_vectors.smx -iinclude >/dev/null 2>&1)
OUT=$("$SPSHELL" "$WORK/logauth_vectors.smx")
echo "$OUT"
echo "$OUT" | tail -1 | grep -q '^PASS '
