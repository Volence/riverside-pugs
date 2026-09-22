#!/usr/bin/env bash
# Build a sample HUD VPK with the real generator and read it back with the Python vpk reader.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)/sample.vpk"
HUD_VPK_OUT="$OUT" npx vitest run --project web --dir web/src/hud sample.vpkcheck.test.ts >/dev/null
/home/volence/l4d/hud/.venv/bin/python - "$OUT" <<'PY'
import sys, vpk
pak = vpk.open(sys.argv[1])
names = sorted(pak)
assert pak.version == 1, pak.version
assert 'scripts/hudlayout.res' in names, names
for n in names: pak[n].read()          # every CRC is verified on read
print(len(names), 'files ok')
PY
