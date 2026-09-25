# Balance public page (piece 5): patch notes with measured effects

Date: 2026-09-24. Status: decided by the owner's delegate overnight (the owner asked
for decisions to be made by another agent); awaiting owner review before any deploy.

Parent design: `docs/superpowers/specs/2026-09-23-balance-analytics-design.md`
("Constraints for later pieces"). Builds on the compare engine of piece 3
(`src/metrics/compare`) and the patch tables of piece 1.

## Goal

A public page where players read each balance patch: what changed, why (the
admin's notes), and what the numbers measured afterwards, with the honest verdict
in the wording. No "noise" presented as a result.

## Which patches are public

- New column `balance_patches.published_at` (NULL = not public). Admins publish or
  unpublish from the Patches tab. Publishing requires a name, notes and at least one
  counted round. Notes stay editable after publishing.
- The Patches tab shows a **preview** of the public entry before publishing.
- Historical patches can be published; they show notes and the "approximate" badge
  but no change list (they have no recorded inputs).

## Each public entry

- Name, notes, and the date range of its counted rounds (first to last round, from
  the rounds themselves; ranges of different patches can overlap because 2v2 and
  auto-tracked games keep their own fingerprints).
- **What changed**, versus the previous published patch (by first counted round),
  as the diff of their inputs, so changes in unpublished patches in between still
  show: knob label old -> new (label from `knobs.json`, raw cvar when unlabelled),
  plugins added / removed / updated (name only), config and map files changed (name
  only). Never file contents, hashes or inventory internals. Versionless plugins can
  only appear or disappear.
- **Measured effect**: the piece 3 comparison of the previous published patch (side
  A) against this patch (side B), game type "all rated games", whole-round phase,
  map-mix adjusted. Benjamini-Hochberg runs over **the same full set of rows the
  admin dashboard uses**; the public list is then filtered to the allowlist. Admin
  and public verdicts can never disagree, and a smaller row set would be more
  lenient.
- Each row: public label, A value, B value, change, and wording that carries the
  verdict:
  - real: "Measured change: <label> went from X to Y (range ...)."
  - noise: "No clear change: within normal variation."
  - too_early: "Too early to tell: about N more matches needed."
  - no_data: "Not measured for this patch."
  Always "measured change", never "caused by". Matches per side shown.
- Banners shown publicly: the skill check and "approximate" banners from the
  comparison, worded for players.
- The first published patch has nothing to compare against and shows "first
  tracked patch". A published patch with no counted rounds left (after voids) shows
  its notes and "no rounds yet".

## Allowlist

`MetricDef` gains `public?: { label: string }`. Initial list:

| id | public label |
|---|---|
| round.saferoom | Rounds where survivors reached the saferoom |
| round.score | Survivor distance score |
| round.length_min | Round length |
| tank.killed_rate | Tanks killed by survivors |
| tank.lifetime_killed_s | How long a killed tank lasted |
| tank.damage_per_tank | Damage dealt per tank |
| tank.incaps_caused | Survivor incaps per tank |
| witch.crown_rate | Witches crowned |
| witch.startle_rate | Witches startled |
| hunter.skeet_rate | Hunters skeeted |
| hunter.damage_per_spawn | Hunter damage per spawn |
| smoker.pull_rate | Smoker pulls per spawn |
| boomer.boomed_per_spawn | Survivors boomed per boomer |
| boomer.pop_rate | Boomers popped before vomiting |
| pace.si_damage_per_min | Special infected damage per minute |
| si.pins_per_min | Pins per minute |
| weapons.hold.pumpshotgun | Time holding the pump shotgun |
| weapons.hold.smg | Time holding the Uzi |

A registry test fails if an allowlisted id does not exist. Left off on purpose:
heuristic metrics (witch incaps), unitless ones (survivor spread), rare ones (quad
caps), director-driven spawn counts, banned weapons, and per-weapon damage (no data
before pug-match 0.3.9).

## API

Public, unauthenticated, in the stats routes:

- `GET /api/balance/patches`: published patches, newest first: id, name, notes,
  source, approximate flag, date range, match and round counts.
- `GET /api/balance/patches/:id`: one published patch: the entry above (change
  list, rows, banners). 404 for an unpublished or unknown id.

Only fixed query shapes exist (no arbitrary side groups or filters). Results are
memoized with the existing compare cache keyed by its data stamp, plus
single-flight so concurrent cold requests share one computation. Work is bounded by
one compute per published pair per data stamp, so no rate limiting is needed.

## Page

Public route `/balance`, "Patch notes" in the public nav. Newest patch first, each
as a panel (`PageHeader` / `Panel` styling): header with name, dates and badges,
notes, "What changed" list, and "Measured effect" grouped by topic, with rows sorted
real changes first. Plain SVG-free layout; no charts in v1.

## Out of scope

Trend charts, per-map breakdowns, replay links, per-phase rows, links to the admin
compare, comments.

## Testing

- Registry: allowlisted ids exist; labels non-empty.
- Change list: knob diff with labels, plugin add/remove/update, files by name only,
  no hashes in the output, diff across an unpublished patch in between.
- Verdict parity: for a fixture comparison the public rows equal the admin rows
  (verdict, values) filtered to the allowlist.
- Wording for each verdict.
- API: only published ids; 404 otherwise; single-flight shares one compute.
- Page render tests: first patch, historical patch, no rounds, each verdict.
- Before ship: run against a copy of production with the historical patches
  published and read the page by eye.

## Planning review (2026-09-24, checked against the code)

Every allowlisted id exists in `src/metrics/defs` (checked by hand; the registry
test pins it). Gaps found and settled:

1. **Which patch is "previous".** Published patches are ordered by their first
   counted round, falling back to `first_seen_at` for a patch with none (then id).
   The baseline for both "What changed" and "Measured effect" is the nearest
   earlier published patch **that has counted rounds**: a published patch whose
   rounds were all voided cannot serve as side A (every row would be "no data").
2. **Previous patch without inputs.** A fingerprinted patch whose baseline is a
   historical patch (no recorded inputs) shows "the change list is not available
   because the previous patch predates recorded settings; see the notes" instead
   of an empty list.
3. **Knobs and files that appear or vanish from the inventory.** A cvar present
   on one side only means `knobs.json` started or stopped watching it, not that
   the game changed; it is left out. A watched config file or the per-map
   stripper directory that differs in any way (changed, added, removed) is listed
   once by its `knobs.json` label (the path when unlabelled). Plugins are shown
   without `.smx`. Ignored plugins are dropped and versionless plugins only
   count when they appear or disappear, as in the fingerprint.
4. **Same numbers as the admin page, same cache.** The public entry calls
   `compareSides` with exactly the admin default query (side A = baseline id,
   side B = this id, origin `all`, all maps, phases `all`) and memoizes it under
   the admin route's own cache key. Benjamini-Hochberg already runs as two
   families (whole-round, sub-phase), so the whole-round family is identical
   whether or not the admin asked for phase splitting: parity holds by
   construction. Only the compare result is cached; name, notes and the change
   list are read fresh, so a notes edit shows at once.
5. **Single-flight.** `compareSides` and `memo` are synchronous (better-sqlite3),
   so Node runs one computation to completion before the next request is
   handled; the second request finds the cache filled. No extra machinery; a
   test pins one computation for two concurrent requests.
6. **Allowlisted metric absent on both sides.** `compareSides` emits no row when
   neither side has samples. The public entry still lists every allowlisted
   metric; a missing one reads as no data.
7. **No-data wording** distinguishes the side: "Not measured for this patch."
   (B missing), "Not measured for the previous patch." (A missing), and "No maps
   in common with the previous patch, so no comparison." (`noSharedMaps`).
8. **Too early without an estimate** (`moreMatches` null): "Too early to tell:
   more matches needed." Estimates of 500 or more read "500+".
9. **Public skill banner** is a flag (`differs` / `unavailable`), worded for
   players on the page; the admin text carries rating numbers and is not sent.
10. **Real-change wording** gives the change and its range: "Measured change:
    <label> went from X to Y (+d, likely between lo and hi)."
11. **Per-spawn rates that cannot exceed one per spawn** (`hunter.skeet_rate`,
    `boomer.pop_rate`) are shown as percentages on the public page to match
    their labels ("Hunters skeeted"); every other value uses the admin
    formatter.
12. **A published patch whose name is later cleared** shows as "Patch N" (its
    time-ordered number); the admin edit route is not changed (piece 4 is
    editing the same file).
13. **Routes live in their own module** (`src/routes/balancePublic.ts`), public
    GETs plus the admin preview and publish routes, registered next to the stats
    routes. Same public, unauthenticated behaviour the spec asks for; kept out of
    `routes/stats.ts` and `routes/admin.ts` to limit merge conflicts with piece 4.
14. **Admin API:** `GET /api/admin/balance/patches/:id/public` returns the entry
    as if the patch were published (the preview); `POST
    /api/admin/balance/patches/:id/publish {published: boolean}` publishes (400
    naming what is missing: name, notes or a counted round) or unpublishes. Both
    are admin only and the POST is audit-logged.
