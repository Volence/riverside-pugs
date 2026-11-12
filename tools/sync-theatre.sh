#!/usr/bin/env bash
# Copy the 3D theatre from the theatre spike into this checkout, in two sets
# (docs/theatre-3d.md "Syncing"):
#
#   small, same origin, ships with the site (deploy-web.sh), gitignored:
#     web/public/theatre/viewer/           index.html, the ES modules, demo-worker.js, vendor/ (three.js,
#                                          Draco, meshoptimizer): the page and its module workers
#     web/public/theatre/sound/            sound-worker.js, sounddecode.js, out/js/ (the sound worker
#                                          and its imports: a module worker must be same-origin)
#     web/public/theatre/manifest.json     version, which maps (and mirrors) the 3D tab offers, sizes
#
#   heavy, for R2 (assets.riversidepug.com/theatre/<version>/), never inside web/ so Vite
#   never copies it into dist and deploy-web.sh never sends it, gitignored:
#     theatre-assets/stage/                the working copy the next version is cut from
#     theatre-assets/<version>/            one immutable snapshot per content version (hard links
#                                          into stage, so an unchanged file costs no disk twice):
#       map/          per map: .lit.glb, .lit.low.glb, .lighting.json, atlas png, .proplight.bin,
#                     .dynamic.json, .ladders.json, and the sky files its .sky.json names (.sky.json,
#                     .sky.webp, .sky.low.webp, .sky.glb, .sky.low.glb, .sky.lightmap.png);
#                     per mirror: .mirror.json, .dynamic.json, .ladders.json (its sky is the original's)
#       models/out/   player, common, weapon, view model, item, prop glbs and the fx textures
#       sound/        out/manifest.json, out/a/*.ogg, map.json
#       light/        character light (index.json, <map>.ambient.bin), the viewer's ambbase=
#       manifest.json the same manifest as the small set's
#     theatre-assets/current               the newest version's name
#
# The version is a hash of every heavy file's path and content: an unchanged spike gives the
# same version (nothing to upload), any change gives a new folder, so R2 objects can be cached
# for a year and an old site build keeps working against its own folder.
# scripts/upload-theatre.ts pushes theatre-assets/<version>/ to R2.
#
# The viewer is still being built in the spike (~/l4d/research/theatre-spike, not git) by other
# sessions: this script only reads it, and nothing it writes is committed.
#
#   tools/sync-theatre.sh                     # everything, every finished map
#   tools/sync-theatre.sh --maps 'l4d_vs_hospital0*'   # only maps matching a glob (others kept)
#   tools/sync-theatre.sh --no-maps           # viewer, models, sounds, light; maps kept as staged
#   tools/sync-theatre.sh --allow-stale       # copy even if demo-worker.js is older than parser/
#
# Never copied: the spike's backups (*before*), logs, stats, screenshots, test pages, the bookmark
# files (viewer/bookmarks/: raw SteamID64 keys), the parser's research outputs (parser/sample-*.json:
# raw SteamIDs), per-demo sound streams. Every JSON and JS file of both sets is scanned for SteamIDs
# at the end and the sync fails if one turns up.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SPIKE="${THEATRE_SPIKE:-/home/volence/l4d/research/theatre-spike}"
SMALL="$REPO/web/public/theatre"
ASSETS="$REPO/theatre-assets"
STAGE="$ASSETS/stage"

MAPS_GLOB='*'
DO_MAPS=1
ALLOW_STALE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --maps) MAPS_GLOB="$2"; shift 2 ;;
    --no-maps) DO_MAPS=0; shift ;;
    --allow-stale) ALLOW_STALE=1; shift ;;
    -h|--help) sed -n '2,43p' "$0"; exit 0 ;;
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

# The heavy folders an older sync put under web/public/theatre/ (before the split): Vite would
# copy them into dist, so they go.
rm -rf "$SMALL/map" "$SMALL/models" "$SMALL/sound/out/a" "$SMALL/sound/out/streams" \
  "$SMALL/sound/out/manifest.json" "$SMALL/sound/map.json"

mkdir -p "$SMALL/viewer" "$SMALL/sound/out/js" "$STAGE/map" "$STAGE/models/out" "$STAGE/sound/out/a" "$STAGE/light"

# rsync filter shared by every copy: never the spike's backups (*.before-*, before-*/), logs,
# screenshots, or per-run stats.
COMMON_EXCLUDES=(--exclude '*before*' --exclude '*.log' --exclude '*.stats.json' --exclude '*.bak' --exclude '*.part')

# --- small set ------------------------------------------------------------------------------
# 1. The page: index.html, every top-level ES module (players.js, world.js, sound.js,
#    demo-worker.js, ...) and vendor/ whole. Not bookmarks/ (raw SteamIDs), light/ (heavy set),
#    tools/, test pages, *.mjs check scripts, fake tracks or screenshots.
rsync -a --delete --delete-excluded --prune-empty-dirs "${COMMON_EXCLUDES[@]}" \
  --include 'index.html' --include '/*.js' --include '/vendor/***' --exclude '*' \
  "$SPIKE/viewer/" "$SMALL/viewer/"

# 2. The sound worker and its imports (sound/README.md "Serving"): loaded as
#    ../sound/sound-worker.js next to the page whatever soundbase= says.
for f in sound-worker.js sounddecode.js; do
  rsync -a "$SPIKE/sound/$f" "$SMALL/sound/$f"
done
rsync -a --delete "${COMMON_EXCLUDES[@]}" "$SPIKE/sound/out/js/" "$SMALL/sound/out/js/"

# --- heavy set (stage) ----------------------------------------------------------------------
# 3. Models and effect textures: glb + json (+ the webp/png textures fx/ uses), every subfolder
#    except the backup ones.
rsync -a --delete --delete-excluded --prune-empty-dirs "${COMMON_EXCLUDES[@]}" \
  --include '*/' --include '*.glb' --include '*.json' --include '*.webp' --include '*.png' --include '*.bin' \
  --exclude '*' \
  "$SPIKE/models/out/" "$STAGE/models/out/"

# 4. Sounds: out/manifest.json, out/a/*.ogg, map.json. Not out/streams/ (per demo: the worker
#    reads a demo's sounds itself).
rsync -a --delete "${COMMON_EXCLUDES[@]}" "$SPIKE/sound/out/a/" "$STAGE/sound/out/a/"
rsync -a "$SPIKE/sound/out/manifest.json" "$STAGE/sound/out/manifest.json"
rsync -a "$SPIKE/sound/map.json" "$STAGE/sound/map.json"

# 5. Character light (viewer README "Character light"): light/index.json and <map>.ambient.bin.
#    The viewer reads them beside the page unless ambbase= says otherwise; the site passes
#    ambbase=<assets>light/ so they come from R2 with the maps.
if [ -d "$SPIKE/viewer/light" ]; then
  rsync -a --delete --delete-excluded "${COMMON_EXCLUDES[@]}" \
    --include 'index.json' --include '*.ambient.bin' --exclude '*' \
    "$SPIKE/viewer/light/" "$STAGE/light/"
fi

# 6. Maps. A map counts when its glb is finished: the batch converter in the spike may be
#    writing one right now, so a map with any file younger than two minutes is left for the
#    next run, and so is one missing a side file its lighting.json names.
#    Per map/README.md the viewer loads: <map>.lighting.json, then <map>.lit.low.glb (low tier)
#    or <map>.lit.glb, the atlas and proplight files lighting.json names, <map>.dynamic.json and
#    <map>.ladders.json; without baked light, <map>.low.glb / <map>.glb.
#    Mirror maps (map/README.md "Mirror maps at load") are not converted: the viewer loads the
#    original's files and reflects them, plus the mirror's own <m>.mirror.json, .dynamic.json and
#    .ladders.json. A mirror is copied when its original is.
#    Sky (map/README.md "Sky and portal fade", viewer/sky.js): the viewer fetches <map>.sky.json, then
#    the files it names: sky2d.file / sky2d.low (2D sky, full / low tier), sky3d.glb / sky3d.low (3D
#    skybox) and sky3d.lightmap. A mirror has no sky files: the viewer loads its original's. The
#    sky is optional: a map without sky.json, or whose sky.json names a missing file, ships without
#    a sky (plain background) rather than being held back. <map>.sky.stats.json is never copied.
if [ "$DO_MAPS" = 1 ]; then
  python3 -I - "$SPIKE/map" "$STAGE/map" "$MAPS_GLOB" <<'PY'
import fnmatch, json, os, shutil, sys, time

src, out, glob = sys.argv[1], sys.argv[2], sys.argv[3]
now = time.time()
listing = os.listdir(src)
names = sorted({f[:-len(ext)] for f in listing for ext in ('.lit.glb', '.glb')
                if f.endswith(ext) and 'before' not in f and not f.endswith(('.low.glb', '.sky.glb'))
                and (ext == '.lit.glb' or not f.endswith('.lit.glb'))})
mirrors = sorted(f[:-len('.mirror.json')] for f in listing if f.endswith('.mirror.json') and 'before' not in f)
p = lambda name, suffix: os.path.join(src, name + suffix)
young = lambda files: [f for f in files if now - os.path.getmtime(os.path.join(src, f)) < 120]

wanted, skipped, notes = {}, [], []
for name in names:
    if not fnmatch.fnmatch(name, glob):
        continue
    files = []
    lit = os.path.exists(p(name, '.lit.glb')) and os.path.exists(p(name, '.lighting.json'))
    if lit:
        try:
            meta = json.load(open(p(name, '.lighting.json')))
            side = [meta['atlas']['file'], meta['proplight']['file']]
        except Exception as e:
            skipped.append(f'{name} (lighting.json unreadable: {e})'); continue
        files = [name + '.lit.glb', name + '.lighting.json', *side]
        if os.path.exists(p(name, '.lit.low.glb')):
            files.append(name + '.lit.low.glb')
    elif os.path.exists(p(name, '.glb')):
        files = [name + '.glb'] + ([name + '.low.glb'] if os.path.exists(p(name, '.low.glb')) else [])
    else:
        continue
    files += [name + s for s in ('.dynamic.json', '.ladders.json') if os.path.exists(p(name, s))]
    if os.path.exists(p(name, '.sky.json')):
        try:
            sky = json.load(open(p(name, '.sky.json')))
            s2, s3 = sky.get('sky2d') or {}, sky.get('sky3d') or {}
            named = [x for x in (s2.get('file'), s2.get('low'), s3.get('glb'), s3.get('low'), s3.get('lightmap')) if x]
        except Exception as e:
            named = None; notes.append(f'{name} (no sky: sky.json unreadable: {e})')
        if named is not None:
            gone = [x for x in named if '/' in x or not os.path.exists(os.path.join(src, x))]
            if gone:
                notes.append(f'{name} (no sky: sky.json names missing {", ".join(gone)})')
            else:
                files += [name + '.sky.json', *named]
    missing = [f for f in files if not os.path.exists(os.path.join(src, f))]
    if missing:
        skipped.append(f'{name} (missing {", ".join(missing)})'); continue
    if young(files):
        skipped.append(f'{name} (being written: {young(files)[0]})'); continue
    wanted[name] = files

for m in mirrors:
    if not fnmatch.fnmatch(m, glob):
        continue
    try:
        orig = json.load(open(p(m, '.mirror.json')))['original']
    except Exception as e:
        skipped.append(f'{m} (mirror.json unreadable: {e})'); continue
    files = [m + '.mirror.json'] + [m + s for s in ('.dynamic.json', '.ladders.json') if os.path.exists(p(m, s))]
    if orig not in wanted and not os.path.exists(os.path.join(out, orig + '.lighting.json')) \
            and not os.path.exists(os.path.join(out, orig + '.glb')):
        skipped.append(f'{m} (original {orig} not synced)'); continue
    if young(files):
        skipped.append(f'{m} (being written: {young(files)[0]})'); continue
    wanted[m] = files

keep = set()
for name, files in wanted.items():
    for f in files:
        keep.add(f)
        a, b = os.path.join(src, f), os.path.join(out, f)
        st = os.stat(a)
        if not os.path.exists(b) or os.path.getsize(b) != st.st_size or os.path.getmtime(b) != st.st_mtime:
            # a new file, then a rename: a version folder hard-linked to the old file keeps it
            shutil.copy2(a, b + '.part'); os.replace(b + '.part', b)
# a narrowed run (--maps) keeps the other maps already there; a full run mirrors the spike
every = names + mirrors
for f in os.listdir(out):
    owner = next((n for n in every if f.startswith(n + '.')), None)
    if f.endswith('.part') or (f not in keep and (glob == '*' or (owner and fnmatch.fnmatch(owner, glob)))):
        os.remove(os.path.join(out, f))
for s in skipped:
    print('  skipped map', s)
for s in notes:
    print('  map without sky', s)
PY
fi

# 7. Version, manifest, snapshot, privacy scan.
python3 -I - "$SMALL" "$ASSETS" "$SPIKE" <<'PY'
import hashlib, json, os, re, sys, time
small, assets, spike = sys.argv[1], sys.argv[2], sys.argv[3]
stage = os.path.join(assets, 'stage')

def files_under(d):
    for r, _, fs in os.walk(d):
        for f in fs:
            yield os.path.relpath(os.path.join(r, f), d)

def size(d):
    return sum(os.path.getsize(os.path.join(d, f)) for f in files_under(d)) if os.path.isdir(d) else 0

# Content hash of the heavy set, file by file (cached by size and mtime: hashing 4 GB again
# on every run is a minute for nothing).
cache_path = os.path.join(assets, '.hashes.json')
try:
    cache = json.load(open(cache_path))
except Exception:
    cache = {}
fresh, listing = {}, hashlib.sha256()
for rel in sorted(f for f in files_under(stage) if f != 'manifest.json' and not f.endswith('.part')):
    st = os.stat(os.path.join(stage, rel))
    key = f'{st.st_size}:{st.st_mtime_ns}'
    hit = cache.get(rel)
    if hit and hit[0] == key:
        digest = hit[1]
    else:
        h = hashlib.sha256()
        with open(os.path.join(stage, rel), 'rb') as fh:
            for block in iter(lambda: fh.read(1 << 20), b''):
                h.update(block)
        digest = h.hexdigest()
    fresh[rel] = [key, digest]
    listing.update(f'{rel}\0{digest}\n'.encode())
json.dump(fresh, open(cache_path + '.part', 'w'))
os.replace(cache_path + '.part', cache_path)
version = listing.hexdigest()[:12]

# Which maps the 3D tab may offer.
mapdir = os.path.join(stage, 'map')
own = lambda n: [f for f in os.listdir(mapdir) if f.startswith(n + '.')]
maps = {}
for f in sorted(os.listdir(mapdir)):
    for ext, lit in (('.lit.glb', True), ('.glb', False)):
        if f.endswith(ext) and not f.endswith(('.low.glb', '.sky.glb')) and (lit or not f.endswith('.lit.glb')):
            n = f[:-len(ext)]
            m = maps.setdefault(n, {'lit': False, 'low': False, 'bytes': 0})
            m['lit'] = m['lit'] or lit
# the low tier's sky files (viewer/sky.js): a GPU viewer never fetches them
SKY_LOW = ('.sky.low.webp', '.sky.low.glb')
for n, m in maps.items():
    m['low'] = os.path.exists(os.path.join(mapdir, n + ('.lit.low.glb' if m['lit'] else '.low.glb')))
    # what a viewer on a GPU downloads: the full glb, the side files and the full sky files
    # (the software tier takes the .low.glb and the low sky files instead, which are smaller)
    m['bytes'] = sum(os.path.getsize(os.path.join(mapdir, f)) for f in own(n)
                     if not f.endswith(SKY_LOW) and not (f.endswith('.low.glb') and m['low']))
for f in sorted(os.listdir(mapdir)):
    if f.endswith('.mirror.json'):
        n = f[:-len('.mirror.json')]
        orig = json.load(open(os.path.join(mapdir, f)))['original']
        if orig in maps:
            o = maps[orig]
            maps[n] = {'lit': o['lit'], 'low': o['low'], 'mirror_of': orig,
                       'bytes': o['bytes'] - sum(os.path.getsize(os.path.join(mapdir, x)) for x in own(orig)
                                                 if x.endswith(('.dynamic.json', '.ladders.json')))
                                + sum(os.path.getsize(os.path.join(mapdir, x)) for x in own(n))}

# Does this viewer draw a mirror map from its original? It does once it reads <map>.mirror.json
# (map/README.md "What the viewer must do for a mirror demo"). Until then the tab says a mirror
# is not in 3D yet, and starts offering mirrors on the first sync after the viewer learns it.
viewer_dir = os.path.join(small, 'viewer')
viewer_mirrors = any('.mirror.json' in open(os.path.join(viewer_dir, f), encoding='utf-8', errors='replace').read()
                     for f in os.listdir(viewer_dir) if f.endswith(('.js', '.html')) and f != 'demo-worker.js')

sizes = {'viewer': size(viewer_dir), 'sound_worker': size(os.path.join(small, 'sound')),
         'models': size(os.path.join(stage, 'models')), 'sound': size(os.path.join(stage, 'sound')),
         'light': size(os.path.join(stage, 'light')), 'map': size(mapdir)}
manifest = {
    'format': 'theatre-manifest/2',
    'version': version,
    'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'source': spike,
    'viewer': {'mirrors': viewer_mirrors},
    'bytes': sizes,
    'maps': maps,
}

# Privacy: no SteamID may ship (viewer README "Fire, gibs and privacy"). The worker's own
# conversion constant (the SteamID64 base) and its documentation example are the only hits allowed.
ID = re.compile(rb'7656119\d{10}|STEAM_[0-5]:[01]:\d{4,}|\[U:1:\d{4,}\]')
ALLOWED = {b'76561197960265728'}
hits = []
for base in (small, stage):
    for rel in files_under(base):
        if rel.endswith(('.json', '.js', '.html', '.txt', '.md')):
            data = open(os.path.join(base, rel), 'rb').read()
            bad = sorted({m.group(0) for m in ID.finditer(data)} - ALLOWED)
            if bad:
                hits.append(f'{os.path.relpath(os.path.join(base, rel), os.path.dirname(assets))}: {len(bad)} id(s)')
if hits:
    print('PRIVACY: SteamIDs found, nothing published. Fix the source in the spike, then sync again:', file=sys.stderr)
    for h in hits:
        print('  ' + h, file=sys.stderr)
    sys.exit(1)

def write_json(path, obj):
    with open(path + '.part', 'w') as fh:
        json.dump(obj, fh, indent=1, sort_keys=True)
    os.replace(path + '.part', path)

# The snapshot: hard links into stage (stage files are only ever replaced by rename, never
# rewritten in place, so a link keeps the bytes it was made with).
snap = os.path.join(assets, version)
if not os.path.isdir(snap):
    tmp = snap + '.part'
    if os.path.isdir(tmp):
        import shutil; shutil.rmtree(tmp)
    for rel in sorted(files_under(stage)):
        if rel == 'manifest.json' or rel.endswith('.part'):
            continue
        os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
        os.link(os.path.join(stage, rel), os.path.join(tmp, rel))
    write_json(os.path.join(tmp, 'manifest.json'), manifest)
    os.replace(tmp, snap)
write_json(os.path.join(stage, 'manifest.json'), manifest)
write_json(os.path.join(small, 'manifest.json'), manifest)
with open(os.path.join(assets, 'current'), 'w') as fh:
    fh.write(version + '\n')

mb = lambda b: f'{b / 1e6:.1f} MB'
heavy = sizes['models'] + sizes['sound'] + sizes['light'] + sizes['map']
plain = sum(1 for m in maps.values() if 'mirror_of' not in m)
print(f"theatre {version}: {plain} maps + {len(maps) - plain} mirrors (viewer draws mirrors: {'yes' if viewer_mirrors else 'not yet'})")
print(f"  small (site): viewer {mb(sizes['viewer'])}, sound worker {mb(sizes['sound_worker'])}")
print(f"  heavy (R2, theatre-assets/{version}/): maps {mb(sizes['map'])}, models {mb(sizes['models'])}, "
      f"sound {mb(sizes['sound'])}, light {mb(sizes['light'])}; total {mb(heavy)}")
others = sorted(d for d in os.listdir(assets) if os.path.isdir(os.path.join(assets, d)) and d not in ('stage', version))
if others:
    print(f"  older versions kept in theatre-assets/: {', '.join(others)} (delete once no deployed build uses them)")
PY
