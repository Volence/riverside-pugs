# The L4D2 campaigns in the PUG rotation

Status: design approved in conversation 2026-09-20, spec written the same day. Nothing
built. Every fact below was measured on 2026-09-20 against the live boxes and the real
pack, not recalled.

Related: `2026-09-18-custom-campaigns-design.md` and
`2026-09-18-custom-campaign-chapters-design.md` (the uploader path this deliberately does
NOT use), `2026-09-19-file-consistency-phase2-design.md` (dlc4 content is out of the
enforced list for now), `2026-08-13-passifice-l4d1-design.md` (owns `ThePassing.txt`, and
collides with this in a way that matters).

## Decisions taken by the owner, 2026-09-20

1. **Goal is ranked rotation**, not casual or unranked. These campaigns go in the pool and
   count for SR like any other.
2. **No client-readiness subsystem.** A player without the pack is treated as a player with
   a broken install: they fail to load and take the normal no-show penalty. This was chosen
   over a verified-install flag and over a self-declared checkbox.
3. **Which campaigns are actually in the pool is a back-office decision**, made later with
   the existing checkboxes. This spec makes all eight *available* to check and takes no
   position on which get ticked.
4. **Chapter naming rides along.** Qualified chapter labels ship with this, not after.
5. **The publish-reaching-all-four-servers fix rides along**, because it blocks two
   campaigns already sitting in draft.
6. **Ship the pack unmodified.** No recompression, no stripping of server-only files. See
   "The player download".

## What is already true

### Server inventory

| id | server | dlc4 content | `gameinfo.txt` mounts dlc4 | transport | free / cap |
|---|---|---|---|---|---|
| 1 | Dallas | **6.0 GB, 32 BSP + 32 nav** | yes | local (root ssh) | 13 GB free of 47 GB |
| 2 | Chicago (NFO) | **none** | no | ftp | 9.26 GB used of a **20 GB** cap |
| 3 | Riverside #3 | **missions only, 52 KB** | **no** | (unconfigured) | 94 GB free of 116 GB |
| 4 | Riverside #4 | **missions only, 52 KB** | **no** | (unconfigured) | 94 GB free of 116 GB |

Riverside's half-state is the dangerous one. Both instances carry the eight mission `.txt`
files and nothing else, and `grep left4dead_dlc4 gameinfo.txt` returns 0, so the DLC is not
on the search path at all. Mission files are exactly what the site reads to decide a
campaign exists, so this is the one arrangement that can make the site confident about maps
that are not there.

Dallas reaches Riverside as `l4d@66.59.208.5` using `/home/pug/.ssh/id_riverside_addons`,
verified this session.

### Rotoblin already covers these maps

`Rotoblin-AZMod/left4dead/addons/stripper/Roto-AZMod/maps/` holds all 32 L4D2 map configs,
`c1m1` through `c14m2`, 10 KB to 106 KB each. They were written for this exact pack:
`c1m1_hotel.cfg` opens `; This map is part of left4deadDLC4-l4d2onl4d1`. Dallas has 138
stripper configs on disk, 32 of them L4D2. **No stripper work is needed.**

Competitive navs are a different story: `l4d1_mission_nav.vpk` holds 21 navs and every one
is L4D1. The L4D2 maps run on the pack's own converted navs. The owner reports these have
been played on Rotoblin and are fine, and Rotoblin's authors shipped no replacements, so
this spec treats them as acceptable. The one known exception is `c6m2_bedlam`, which
segfaults roughly half its loads (see the Passifice spec); that is an argument against
ticking The Passing, not against this feature.

### The pack

`l4d2-in-l4d1.zip`, v3.1e, gamemaps id 32168. 3,399,113,365 bytes compressed, 6.39 GB and
3375 files expanded, already extracted at `~/Downloads/l4d2onl4d1/staged/`. Eight campaigns,
all with a `versus` block:

| mission file | slug | chapters |
|---|---|---|
| `DeadCenter.txt` | `dead_center` | `c1m1_hotel` … `c1m4_atrium` (4) |
| `DarkCarnival.txt` | `dark_carnival` | `c2m1_highway` … `c2m5_concert` (5) |
| `SwampFever.txt` | `swamp_fever` | `c3m1_plankcountry` … `c3m4_plantation` (4) |
| `HardRain.txt` | `hard_rain` | `c4m1_milltown_a` … `c4m5_milltown_escape` (5) |
| `TheParish.txt` | `the_parish` | `c5m1_waterfront` … `c5m5_bridge` (5) |
| `ThePassing.txt` | `the_passing` | `c6m1_riverbank` … `c6m3_port` (3) |
| `ColdStream.txt` | `cold_stream` | `c13m1_alpinecreek` … `c13m4_cutthroatcreek` (4) |
| `campaign14.txt` | `the_last_stand` | `c14m1_junkyard`, `c14m2_lighthouse` (2) |

Two facts that shape the whole design:

- **Versus and coop share one BSP.** L4D1's stock campaigns have separate `l4d_` and
  `l4d_vs_` maps; these ports do not. The versus block of `DeadCenter.txt` lists
  `c1m1_hotel, c1m2_streets, c1m3_mall, c1m4_atrium`, the same names as coop. So
  `STOCK_FIRST` for these is the plain name, and the existing comment there ("These MUST be
  the `l4d_vs_` BSPs") needs amending rather than obeying.
- **`parseMission()` already reads the `versus` block specifically** (`src/vpk.ts:89`). It
  will pick up the right chapters with no change. Its `DisplayName` values carry a `(VS)`
  suffix ("Hotel (VS)", "Streets (VS)"), which matters for Piece 4.

## Piece 1: dlc4 onto the three servers that lack it

### Riverside #3 and #4

Both instances live on one box with 94 GB free. Copy once and share:

1. `rsync` `left4dead_dlc4/` from Dallas to `/home/l4d/shared/left4dead_dlc4` over the pug
   key. 6 GB between two Linux boxes.
2. Replace each instance's `left4dead_dlc4` with a symlink to the shared copy. The engine
   follows a symlinked Game path on Linux.
3. Add `Game left4dead_dlc4` to each instance's `left4dead/gameinfo.txt` as the **first**
   search path, above `left4dead_dlc3`. That order is measured, not guessed
   (`left4dead_dlc4` → `left4dead_dlc3` → `|gameinfo_path|.` → `hl2`).

### Chicago

1. Push `left4dead_dlc4/` over FTP with `ftpsync.py`. Roughly 6 GB, which takes the box from
   9.26 GB to about 15.3 GB against a hard 20 GB cap.
2. Same `gameinfo.txt` edit.

**The cap is the risk on this piece.** NFO's wording ("total size of custom files") may mean
only files beyond the base install, in which case there is far more room; this spec plans
against the pessimistic reading, which still fits with about 4.7 GB spare. If headroom is
wanted, Chicago carries about 1.25 GB of localized audio it will never use
(`left4dead_french`, `german`, `russian` and `spanish` at 270 MB each, plus thirteen smaller
ones). Deleting those is the cheapest reclaim on the box and needs the owner's say-so;
`ftpsync.py` copies and never deletes, so it would be by hand.

### Mission files must be identical on all four servers

This is the subtle one and it is easy to get wrong. **pug-web reads mission files from
Dallas's disk** and assumes every server agrees. Dallas's `ThePassing.txt` is not stock: it
is the Passifice five-chapter override chaining `c6m1 → c6m2 → l4d_river01 → 02 → 03`.
Riverside currently carries that same override (it was cloned from Dallas, including
`ThePassing.txt.pre-passifice`). Chicago will get whatever is pushed.

So the rule is: **whatever `missions/` Dallas has is what every server gets**, and that copy
is what the registry reads. Any future edit to a mission file is a four-server change, not a
Dallas change. `install-mappack.sh` re-copies dlc4 wholesale and deletes the Passifice
override, so that script must not be re-run on a live box without re-running `deploy.sh`
afterwards.

All three `gameinfo.txt` edits need a server restart to take effect, so this piece happens
on empty servers.

## Piece 2: the eight campaigns in the registry

### `src/campaigns.ts`

Add the eight slugs to `CAMPAIGNS`, and teach `campaignForMap` the second naming scheme. The
existing matcher is `/^l4d_(?:vs_)?([a-z]+)\d*/`, which `c1m1_hotel` does not match at all.
Add a second pattern `/^c(\d+)m\d+/` mapping the campaign number to a slug: 1 dead_center,
2 dark_carnival, 3 swamp_fever, 4 hard_rain, 5 the_parish, 6 the_passing, 13 cold_stream,
14 the_last_stand.

Keep returning null for anything unmatched. The module's existing comment ("Guessing would
silently file an L4D2 or custom map under a real campaign") stays true; this just stops L4D2
maps being the unknown case.

**A test asserts `CAMPAIGNS`' exact keys** and the Discord command module reads it at import
time. Both need updating in the same change.

### `src/stockMissions.ts` and `setMissionsDir`

`readStockMissions(dir)` reads one directory. It needs to read two: `left4dead/missions` and
`left4dead_dlc4/missions`. Change `setMissionsDir(dir)` to `setMissionsDirs(dirs)` and have
the reader walk each in turn. Slugs do not collide across the two directories, so order does
not matter. Every existing failure mode stays silent and empty, which is the module's stated
contract.

Config gains a second path alongside `MISSIONS_DIR`.

### A live bug found while verifying this, which this piece fixes

**`MISSIONS_DIR` is not set on the production box.** `/home/pug/app/.env` has 23 keys and
that is not one of them, so `config.missionsDir` is `''`, `readStockMissions('')` returns
empty on its first line, and **the stock four have had no chapter list the whole time.**

The visible consequence is that `stopAfterMap()` returns null for them
(`src/stopPoint.ts:20`), before it ever reads `getMapsToPlay`. So **the admin "maps to play"
setting is silently inert for No Mercy, Death Toll, Dead Air and Blood Harvest.** Setting it
changes nothing. Custom campaigns are unaffected, because their chapters come from
`chaptersOf(db, slug)` in the database rather than from mission files.

Nothing is visibly broken today only because the plugin applies its own second-from-last
default when the backend sends no stop point, which is exactly the fallback
`stopPoint.ts` documents. The setting has simply never done anything for those four.

Two consequences for this design:

- **Setting `MISSIONS_DIR` is a prerequisite, not a detail.** Without it the dlc4 campaigns
  get no chapter lists either, and Piece 4's labels have nothing to label.
- **`requiresDlc4` is derived from the slug set in `campaigns.ts`, not from which directory
  the mission file was read from.** Deriving it from the directory would make the pool gate
  collapse to "allowed" whenever the config is missing, which is the failure open rather
  than closed. A const set fails closed and works regardless of config.

This should be confirmed with the owner as a finding in its own right; it is a live bug
about a different feature that this work happens to sit on top of.

### `STOCK_FIRST` in `src/campaignRegistry.ts`

Eight new entries, plain names (`c1m1_hotel`, `c2m1_highway`, …), and the comment above it
amended to say why these are not `l4d_vs_` names.

## Piece 3: the pool gate

This is the piece that stops a match landing on a server that cannot load the map.

`poolableCampaigns()` currently offers every `!custom` campaign unconditionally, because the
stock four are on every install by definition. That assumption does not hold for dlc4
campaigns, and inheriting the free pass is exactly how the pool would hand Chicago a map it
does not have.

Design:

- **`CampaignEntry.requiresDlc4: boolean`**, true for the eight, derived from the slug set in
  `campaigns.ts`. Not from which directory the mission file came from: see the
  `MISSIONS_DIR` finding above for why that would fail open.
- **`servers.has_dlc4`**, an INTEGER column added through `ensureColumn` like every other
  server column.
- **`poolableCampaigns()`** offers a `requiresDlc4` campaign only when every enabled server
  has `has_dlc4 = 1`. The existing `alsoAllow` escape hatch applies unchanged, for the same
  reason it exists today: a campaign already in the pool must not make the settings page
  unsavable when a server loses its install.
- **`validateSetting`** on `map_pool` enforces the same rule, so a direct PUT cannot bypass
  what the panel shows.

**`has_dlc4` must be verified, not asserted.** A flag an admin ticks by hand drifts, and the
consequence of drift is a match that dies on a missing map. So the flag is set by a checker
that stats a known dlc4 file (`maps/c1m1_hotel.bsp`) through that server's own configured
transport, the same one `installCampaign` verifies uploads with. That gives one code path
covering local, ftp and sftp, and it makes the flag evidence rather than a promise. The
admin panel shows the result and offers a re-check; it does not offer a raw checkbox.

## Piece 4: chapter labels

The problem, in the owner's words: under a campaign heading a bare chapter name is fine, but
in a mixed list "I have no idea what maps these are".

Adding 32 chapters makes this a correctness problem rather than a polish one. Dead Center has
a chapter called **Streets** and City of the Dead Redux already has **Streets (VS)**. Dead
Center has **The Hotel** against the existing **The Hospital** and the hotel-named customs.
Hard Rain's five chapters are milltown variants that read almost identically to each other.
A bare chapter name stops being a unique label.

Rules:

- **Campaign-qualified where chapters from different campaigns are mixed.** The per-map stats
  view and the "maps you lose most" list are the cases seen. Format `<Campaign> <n> ·
  <Chapter>`, with the campaign part visually de-emphasized so the chapter name still reads
  first.
- **Bare where the campaign is already the heading.** The campaign stats table stays as it
  is. The owner called this out explicitly, and prefixing every row under a BLOOD HARVEST
  heading with "BH" is noise.
- **Strip the `(VS)` suffix** that dlc4 display names carry. "Hotel (VS)" reads as "Hotel".
  Every chapter the site plays is versus, so the suffix carries no information.
- **No display name: `Chapter <n>` plus the raw map name.** This is the `rombu01` case. The
  admin chapter editor keeps showing the raw map name, because for an admin that IS the
  useful identifier; it gains the display name alongside rather than instead.

One open question for spec review: full campaign names, or short codes ("BH 1 · The
Woods")? Full names need no abbreviation table and extend to custom campaigns for free,
which is why this spec recommends them; short codes fit better in a narrow bar-chart row.
The owner's example used a short code, so this may want to go the other way.

## Piece 5: publish reaching all four servers

`POST /api/admin/campaigns/:slug/publish` already fires `installCampaign` against every
enabled server. The failure is configuration, not code. Servers 3 and 4 are
`addons_transport='local'` with an empty `addons_dir`, `ftp_host`, `ftp_user` and
`ssh_key_path`, so `transportFor()` returns null and both are marked `failed`. Because
`poolableCampaigns()` gates on `isInstalledEverywhere()`, a campaign published today
succeeds on Dallas and Chicago and then never appears in the pool. This is the City 17
failure repeating.

The sftp transport is **already live**: `pug-web` runs `tsx src/index.ts` directly (`build`
is only the vite bundle), and `/home/pug/app/src/addonsTransport.ts` on the box carries the
sftp branch. The key is in place and reaches Riverside.

So the fix is five fields on each of two rows: `addons_transport='sftp'`, `ftp_host`,
`ftp_user`, `ssh_key_path=/home/pug/.ssh/id_riverside_addons`, and the per-instance
`addons_dir`. Verify by hitting Reinstall on an already-published campaign and watching both
rows reach `installed`.

**Do not publish Blood Harvest Apocalypse or City of the Dead Redux until this is done.**
Publishing first leaves two servers marked `failed` and the campaigns out of the pool.

One caveat inherited from the City 17 cleanup: the install rows for City 17 on servers 3 and
4 were written by hand, so the database claims Riverside has it. A re-upload of city17 would
not actually reach those boxes. Worth a re-check once sftp is configured.

## Piece 6: the player download and the guide

### What gets hosted

**The inner zip, renamed.** What is distributed on gamemaps is a wrapper containing a
ReadMe, two JPGs and `l4d2-in-l4d1.zip`. Hosting the wrapper makes players unzip twice, and
only the inner zip matters. Host the inner one as
`L4D2-Maps-for-L4D1-v3.1e.zip`, so the install is one extract straight into the game folder.

The version stays in the filename because the guide tells people how to check their version,
which is useless if the filename does not say what they should have.

### Unmodified, and why

Measured against the real files: a `.7z`/xz repack lands near 2.7 GB against the current
3.4 GB, about 21%.

| content | share | deflate (current) | zstd -19 | xz -9e |
|---|---|---|---|---|
| loose `.wav`, 1897 files | 1.82 GB | 90% | 88% | 83% |
| `.bsp`, 32 maps | 1.35 GB | 38% | 31% | 21% |
| `pak01_NNN.vpk`, 81 files | 2.67 GB | 39% | 35% | 31% |
| `.nav`, 32 files | 0.47 GB | | | 5% |

Not worth taking. R2 egress is free so the 700 MB costs nothing to serve; Windows 10 has no
native `.7z` support, so a repack adds a "go install 7-Zip" step to a guide whose whole job
is being easy; and repacking makes us the source of a pack that differs from the one every
guide and forum post links to.

Two things checked and rejected: the WAVs are genuinely raw 16-bit PCM and simply resist
general-purpose compression, so there is no win hiding in the largest chunk. And stripping
the server-only `.nav` files saves 24 MB compressed despite being 472 MB raw, while breaking
offline bot practice.

### Upload

Reuse `src/r2.ts`. `put()` is a single streamed PUT with hand-rolled SigV4 and no SDK;
R2's single-PUT ceiling is 5 GB, so 3.4 GB needs no multipart. A small script alongside
`scripts/upload-overviews.ts`, same `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
`R2_PUBLIC_URL` config. Set a long `cache-control` and a `content-disposition` filename.

### The guide

Drafted and approved in conversation: five steps (download, open the game folder via Steam's
Browse local files, drag everything in and overwrite, turn Shader Detail to Medium or lower,
verify with `map c1m1_hotel`), with previous-install cleanup, how to turn it back off, and
the version check collapsed underneath. Built against the site's own tokens so it drops into
How to Play.

Two departures from the pack's ReadMe, both deliberate. The shader-detail step is a crash
fix buried at position 4 of 5 in the original, so it gets its own warning. And a
verification step was added, because "did it work" with no answer is how this generates
support traffic.

## Testing

Unit:

- `campaignForMap` resolves every one of the 32 map names to the right slug, and still
  returns null for junk.
- `readStockMissions` across two directories returns all twelve campaigns with the versus
  chapter lists, including the `(VS)` display names.
- `poolableCampaigns` refuses a `requiresDlc4` campaign while any enabled server has
  `has_dlc4 = 0`, allows it when all do, and honours `alsoAllow` in both cases.
- `validateSetting` refuses a `map_pool` PUT containing a dlc4 campaign under the same
  conditions.
- The chapter label helper: qualified form, bare form, `(VS)` stripping, and the missing
  display name fallback.
- `stopAfterMap` returns a real map for a stock campaign once the missions paths are
  configured, and honours a `campaign_play_rules` entry. This is the regression test for
  the `MISSIONS_DIR` bug, and it would have caught it: today it returns null.

In game, per server, before anything is ticked into the pool:

- `changelevel c1m1_hotel` loads on all four.
- The dlc4 checker reports `has_dlc4 = 1` for all four and, as a negative control, 0 for a
  server with the files removed.
- One full Dead Center match, confirming chapter transitions, score carry, and that the
  match closes cleanly with maps attributed to `dead_center`.

## Ship order

1. **Riverside sftp rows.** Unblocks publish and is independent of everything else.
2. **dlc4 to Riverside and Chicago**, gameinfo edits, mission-file parity, on empty servers,
   with a restart.
3. **Run the dlc4 checker** and confirm all four report 1.
4. **Deploy web**: set `MISSIONS_DIR` and the dlc4 missions path in `/home/pug/app/.env`,
   then registry, pool gate, chapter labels. Setting those paths also un-breaks "maps to
   play" for the stock four, so check that setting on a stock campaign afterwards.
5. **Upload to R2, publish the guide** on How to Play.
6. **Owner ticks campaigns into the pool.**

Steps 1 through 3 touch live servers and each needs the owner's explicit go-ahead. Nothing
in steps 1 to 3 changes what players see until step 6.

## Out of scope

- **Overviews for the 32 new maps.** `overviewFor()` returns null and the viewer auto-fits,
  silently and correctly. This joins the existing Phase 2 overview queue rather than
  blocking here.
- **Extending the file-consistency list to dlc4 content.** The enforced list is built from a
  stock install; dlc4 is a separate question and a separate risk.
- **Which campaigns are ticked into the pool**, including whether The Passing goes in at all
  given `c6m2_bedlam`, and whether The Last Stand's two chapters are worth a
  `campaign_play_rules` entry.
- **Any client-readiness detection.** Decided against; see decision 2.
