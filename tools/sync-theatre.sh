#!/usr/bin/env bash
# Copy the 3D theatre (viewer, demo worker, models, effects, sounds, converted maps)
# from the theatre spike into web/public/theatre/, which the match page's 3D tab loads.
#
# The viewer is still being built in the spike (~/l4d/research/theatre-spike, not git),
# by other sessions, so nothing of it is copied into this repo by hand and nothing of it
# is committed: this script is the only way in, and web/public/theatre/ is gitignored.
# Run it again whenever the spike moves on. It only reads the spike.
#
#   tools/sync-theatre.sh                     # everything, every finished map
#   tools/sync-theatre.sh --maps 'l4d_vs_hospital0*'   # only maps matching a glob
#   tools/sync-theatre.sh --no-maps           # viewer, models and sounds only
#   tools/sync-theatre.sh --allow-stale       # copy even if demo-worker.js is older than parser/
#
# Layout (the viewer loads everything by relative paths, so the spike's layout is kept):
#   web/public/theatre/viewer/      index.html, ES modules, demo-worker.js   (~1.5 MB, the page)
#   web/public/theatre/models/out/  player, common, weapon, view model, item, prop glbs + fx
#   web/public/theatre/sound/       Opus waves, manifest, sound worker
#   web/public/theatre/map/         per map: .lit.glb, .lit.low.glb and the side files
#   web/public/theatre/manifest.json  which maps are there (the 3D tab reads it), sizes, when
#
# What ships where is in docs/theatre-3d.md: the page (viewer/) is small and rides with the
# site; the rest is hundreds of MB and is meant for R2 (assets.riversidepug.com/theatre/),
# like the overview layers. deploy-web.sh leaves this whole folder out until that is decided.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SPIKE="${THEATRE_SPIKE:-/home/volence/l4d/research/theatre-spike}"
OUT="$REPO/web/public/theatre"

MAPS_GLOB='*'
DO_MAPS=1
ALLOW_STALE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --maps) MAPS_GLOB="$2"; shift 2 ;;
    --no-maps) DO_MAPS=0; shift ;;
    --allow-stale) ALLOW_STALE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f "$SPIKE/viewer/index.html" ] || { echo "no viewer at $SPIKE/viewer/index.html (THEATRE_SPIKE?)" >&2; exit 1; }

# The worker is generated from parser/; a stale one would parse demos with old code.
if ! (cd "$SPIKE/parser" && node build-worker.ts --check >/dev/null 2>&1); then
  if [ "$ALLOW_STALE" = 1 ]; then
    echo "warning: viewer/demo-worker.js is stale against parser/ (copied anyway, --allow-stale)" >&2
  else
    echo "viewer/demo-worker.js is stale against parser/ ('cd $SPIKE/parser && node build-worker.ts --check')." >&2
    echo "Someone is mid-change in the spike: try again later, or pass --allow-stale." >&2
    exit 1
  fi
fi

mkdir -p "$OUT/viewer" "$OUT/models/out" "$OUT/sound" "$OUT/map"

# rsync filter shared by every copy: never the spike's backups (*.before-*), logs,
# screenshots, or per-run stats.
COMMON_EXCLUDES=(--exclude '*before*' --exclude '*.log' --exclude '*.stats.json' --exclude '*.bak')

# 1. The page: index.html plus every top-level ES module (players.js, world.js, sound.js,
#    demo-worker.js, ...). Test pages, check scripts, fake tracks and screenshots stay behind.
rsync -a --delete --prune-empty-dirs "${COMMON_EXCLUDES[@]}" \
  --include 'index.html' --include '*.js' --exclude '*' \
  "$SPIKE/viewer/" "$OUT/viewer/"

# 2. Models and effect textures: glb + json (+ the webp/png textures fx/ uses), every subfolder
#    except the backup ones.
rsync -a --delete --prune-empty-dirs "${COMMON_EXCLUDES[@]}" \
  --include '*/' --include '*.glb' --include '*.json' --include '*.webp' --include '*.png' --include '*.bin' \
  --exclude '*' \
  "$SPIKE/models/out/" "$OUT/models/out/"

# 3. Sounds (sound/README.md "Serving"): out/manifest.json, out/a/*.ogg, out/js/*.js (the sound
#    worker's demo reader), map.json, sound-worker.js, sounddecode.js. Not out/streams/ (per demo,
#    the worker reads a demo's sounds itself).
if [ -f "$SPIKE/sound/out/manifest.json" ]; then
  mkdir -p "$OUT/sound/out"
  rsync -a --delete "${COMMON_EXCLUDES[@]}" "$SPIKE/sound/out/a/" "$OUT/sound/out/a/"
  rsync -a --delete "${COMMON_EXCLUDES[@]}" "$SPIKE/sound/out/js/" "$OUT/sound/out/js/"
  rsync -a "$SPIKE/sound/out/manifest.json" "$OUT/sound/out/manifest.json"
  for f in map.json sound-worker.js sounddecode.js; do
    [ -f "$SPIKE/sound/$f" ] && rsync -a "$SPIKE/sound/$f" "$OUT/sound/$f"
  done
fi

# 4. Maps. A map counts when its glb is finished: the batch converter in the spike may be
#    writing one right now, so a map with any file younger than two minutes is left for the
#    next run, and so is one missing a side file its lighting.json names.
#    Per map/README.md the viewer loads: <map>.lighting.json, then <map>.lit.low.glb (low tier)
#    or <map>.lit.glb, the atlas and proplight files lighting.json names, <map>.dynamic.json and
#    <map>.ladders.json; without baked light, <map>.low.glb / <map>.glb.
if [ "$DO_MAPS" = 1 ]; then
  python3 -I - "$SPIKE/map" "$OUT/map" "$MAPS_GLOB" <<'PY'
import fnmatch, json, os, shutil, sys, time

src, out, glob = sys.argv[1], sys.argv[2], sys.argv[3]
now = time.time()
names = sorted({f[:-len(ext)] for f in os.listdir(src) for ext in ('.lit.glb', '.glb')
                if f.endswith(ext) and 'before' not in f and not f.endswith('.low.glb')
                and (ext == '.lit.glb' or not f.endswith('.lit.glb'))})
wanted, skipped = {}, []
for name in names:
    if not fnmatch.fnmatch(name, glob):
        continue
    p = lambda suffix: os.path.join(src, name + suffix)
    files = []
    lit = os.path.exists(p('.lit.glb')) and os.path.exists(p('.lighting.json'))
    if lit:
        try:
            meta = json.load(open(p('.lighting.json')))
            side = [meta['atlas']['file'], meta['proplight']['file']]
        except Exception as e:
            skipped.append(f'{name} (lighting.json unreadable: {e})'); continue
        files = [name + '.lit.glb', name + '.lighting.json', *side]
        if os.path.exists(p('.lit.low.glb')):
            files.append(name + '.lit.low.glb')
    elif os.path.exists(p('.glb')):
        files = [name + '.glb'] + ([name + '.low.glb'] if os.path.exists(p('.low.glb')) else [])
    else:
        continue
    files += [name + s for s in ('.dynamic.json', '.ladders.json') if os.path.exists(p(s))]
    missing = [f for f in files if not os.path.exists(os.path.join(src, f))]
    if missing:
        skipped.append(f'{name} (missing {", ".join(missing)})'); continue
    young = [f for f in files if now - os.path.getmtime(os.path.join(src, f)) < 120]
    if young:
        skipped.append(f'{name} (being written: {young[0]})'); continue
    wanted[name] = {'lit': lit, 'low': any(f.endswith('.low.glb') for f in files), 'files': files}

keep = set()
for name, m in wanted.items():
    for f in m['files']:
        keep.add(f)
        a, b = os.path.join(src, f), os.path.join(out, f)
        st = os.stat(a)
        if not os.path.exists(b) or os.path.getsize(b) != st.st_size or os.path.getmtime(b) != st.st_mtime:
            shutil.copy2(a, b + '.part'); os.replace(b + '.part', b)
# a narrowed run (--maps) keeps the other maps already there; a full run mirrors the spike
for f in os.listdir(out):
    owner = next((n for n in names if f.startswith(n + '.')), None)
    if f.endswith('.part') or (f not in keep and (glob == '*' or (owner and fnmatch.fnmatch(owner, glob)))):
        os.remove(os.path.join(out, f))
for s in skipped:
    print('  skipped map', s)
PY
fi

# 5. manifest.json: the maps that are really there (what the 3D tab offers), and sizes.
python3 -I - "$OUT" "$SPIKE" <<'PY'
import json, os, sys, time
out, spike = sys.argv[1], sys.argv[2]
def size(d):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)
mapdir = os.path.join(out, 'map')
maps = {}
for f in sorted(os.listdir(mapdir)):
    for ext, lit in (('.lit.glb', True), ('.glb', False)):
        if f.endswith(ext) and not f.endswith('.low.glb') and (lit or not f.endswith('.lit.glb')):
            n = f[:-len(ext)]
            m = maps.setdefault(n, {'lit': False, 'low': False, 'bytes': 0})
            m['lit'] = m['lit'] or lit
for n, m in maps.items():
    own = [f for f in os.listdir(mapdir) if f.startswith(n + '.')]
    m['low'] = any(f.endswith('.low.glb') for f in own)
    # what a viewer on a GPU downloads: the full glb and the side files (the software
    # tier takes the .low.glb instead, which is smaller)
    m['bytes'] = sum(os.path.getsize(os.path.join(mapdir, f)) for f in own
                     if not (f.endswith('.low.glb') and m['low']))
sizes = {k: size(os.path.join(out, k)) for k in ('viewer', 'models', 'sound', 'map')}
manifest = {
    'format': 'theatre-manifest/1',
    'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'source': spike,
    'bytes': sizes,
    'maps': maps,
}
with open(os.path.join(out, 'manifest.json.part'), 'w') as fh:
    json.dump(manifest, fh, indent=1, sort_keys=True)
os.replace(os.path.join(out, 'manifest.json.part'), os.path.join(out, 'manifest.json'))
mb = lambda b: f'{b / 1e6:.1f} MB'
print(f"theatre: {len(maps)} maps; viewer {mb(sizes['viewer'])}, models {mb(sizes['models'])}, "
      f"sound {mb(sizes['sound'])}, maps {mb(sizes['map'])}; total {mb(sum(sizes.values()))}")
PY
