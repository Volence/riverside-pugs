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
| round.length_min | Round length (minutes) |
| tank.killed_rate | Tanks killed by survivors |
| tank.lifetime_killed_s | How long a killed tank lasted (s) |
| tank.damage_per_tank | Damage dealt per tank |
| tank.incaps_caused | Incaps caused per tank |
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
