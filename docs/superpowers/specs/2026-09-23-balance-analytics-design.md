# Balance analytics: patch tagging, metrics engine, compare dashboard

Date: 2026-09-23. Status: design approved in brainstorming, spec awaiting owner review.

## Why

Balance changes have always been judged by feel ("what feels better?"). We now
record every PUG round (events, round results, 10 Hz replays), so a change like
"tank HP 8000 to 7500" or "static shotgun spread" can be measured instead. Changes
also ripple: lower tank HP might mean survivors spend tank fights hunting spawns and
infected lean harder on booms. The system must show everything that moved, not
only the numbers someone expected to move, and it must say honestly when a shift
is noise.

Baseline available on 2026-09-22: 134 matches, 922 rounds, 915 replays since
2026-09-11.

## Scope

The whole idea is five sub-projects, built in order:

1. **Patch tagging** (this spec)
2. **Metrics engine** (this spec)
3. **Admin compare dashboard** (this spec)
4. Balance control panel: curated knobs with safe ranges, later plugin on/off.
   Its own design round. Constraints recorded below.
5. Public stats and patch notes page. Its own design round. Constraints below.

Testing model: **before/after** (everyone plays patch N, then everyone plays N+1).
Concurrent split tests (a coin flip per match between two variants) are a later
extension; this design must not block them.

Games counted: **all tracked games**, each tagged with its type (ranked, mix,
scrim). The dashboard defaults to ranked only, with a toggle to include the rest.

Built inside the PUG app (TypeScript, SQLite, existing admin site). No second
service.

## 1. Patch tagging

### Fingerprint

At every ROUND_START the plugin emits a `BALANCE` line carrying a fingerprint
hash and the raw inputs to it:

- **Watched cvars.** A curated list in one repo file, `balance/knobs.json`
  (name, cvar, type, safe range, group, plain-English label). The plugin reads
  the list of cvar names from a generated config it is shipped with. Piece 4
  reuses this same file as its list of adjustable knobs.
- **Loaded plugins.** Filename plus a hash of each `.smx`, sorted by filename.
  A new build of an existing plugin is a new fingerprint.
- **Balance data files.** Hash of each file in a listed set, starting with
  `data/l4d_info_editor_weapons.cfg` (where the Uzi revert lives and where a
  static shotgun spread would most likely live).
- **Stripper configs.** Hash of the global stripper cfg and of the per-map cfg
  for the current map. Stripper changes alter map geometry and entities (the
  City 17 fix, the bedlam fix).

The fingerprint is a stable hash of the canonicalised inputs. The raw inputs
travel with it so the site can show what differs between two patches, not only
that they differ. If a BALANCE line exceeds one datagram it is split into
sequenced parts, reassembled by round (the RCON multi-packet incident is the
reason to plan for this up front).

Plugin cost: file hashing runs once per round start, off the hot path.
Hashing every `.smx` and data file must be measured on the local test server
against the round-start budget before shipping; if it is too slow, hash at map
start and cache.

### Site tables

- `balance_patches(id, number, name, notes, fingerprint UNIQUE, inputs_json,
  first_seen_at, source)` where `source` is `announced` (created through the
  site, later the control panel), `detected` (first seen in a BALANCE line with
  no announcement) or `historical` (reconstructed, see below).
- `match_rounds` gains `patch_id` and `variant` (always NULL until split tests
  exist).
- `balance_patch_servers(patch_id, server_id, first_seen_at, last_seen_at)`.

A fingerprint seen for the first time with no announced patch creates a
`detected` patch named "Unnamed patch N" and raises an admin flag naming the
server: "config changed on Chicago, not through the panel". This doubles as a
server drift alarm (the Chicago-only `l4d_itemlimiter.smx` from the parity
audit would have tripped it). Admins can rename a detected patch and add notes.

If servers disagree while one patch is current, each round still carries its own
fingerprint, so no round is mislabelled; the dashboard warns that servers were
not identical during the comparison window.

### History (the 922 existing rounds)

Existing rounds have no fingerprint. They are assigned to `historical` patches
reconstructed from known change dates. Candidate boundaries, to be confirmed
against the l4d-deploy git log and the notes during planning:

- 2026-09-12: anti-bait stall horde re-enabled, stumble_door 1.1 swapped in
- 2026-09-20: bedlam and City 17 stripper fixes (map-specific)
- 2026-09-21: l4d_skypounce 0.4.0 on all four servers
- 2026-09-22: l4d_saferoom_lock 1.2 on all four servers

Historical patches carry an "approximate" badge everywhere they appear.

## 2. Metrics engine

### Unit and storage

One row set per round (one half of one map):

```
round_metrics(match_id, ordinal, half, metric, metric_version, phase,
              numerator REAL, denominator REAL,
              PRIMARY KEY (match_id, ordinal, half, metric, phase))
```

Rates are stored as numerator and denominator ("3 crowns / 5 witches") so
pooling rounds weights them correctly. Pure counts use denominator 1 per round;
per-minute metrics use minutes as the denominator.

Each round also records context used by the dashboard: map, game type, server,
patch, survivor side average rating, infected side average rating (from
`player_ratings` at match time via `rating_history`).

### Job

`computeRoundMetrics(match)` runs when a match has ended and every round's
replay file is present. Chicago and Riverside replays arrive by a 2-minute pull
timer, so the job retries on a schedule until the files are there or a timeout
passes; after the timeout it computes what it can from events and marks
replay-derived metrics missing for that round. A missing value is absent, never
a zero.

The same job over all history is the backfill. It is idempotent (upsert by
primary key).

### Metric registry

Each metric is a small pure function registered with: `id`, `group`,
`description` (plain English, reused by the dashboard and later the public
page), `version`, `sources` (events, replay, round result, match stats) and the
function itself. Bumping a metric's `version` recomputes that metric across all
history. Each metric has unit tests against saved replay and event fixtures.

### Phases

Derived from the replay timeline and events:

- `all`: the whole round
- `tank`: from tank spawn to tank death (tank HP in frames, tank_spawn and
  tank_death events)
- `witch`: a witch entity exists within a set radius of any survivor
- `normal`: none of the above
- `event`: panic events and finales. Needs the new plugin markers; absent for
  older rounds

Every metric is computed for `all` and for each phase where it makes sense.

### Catalogue (v1, all seven groups)

1. **Round outcomes:** saferoom reached, distance score, survivors alive at
   end, round length, distance at the point of the wipe
2. **Tank:** killed before round end, lifetime, damage to survivors, incaps
   and deaths caused, punches and rocks landed, survivor distance at spawn,
   rock skeets
3. **Witch:** crowns, draw crowns, killed after startle, survivor incapped or
   killed by witch, witch damage
4. **Hunter:** skeets (and by weapon: shotgun, sniper, melee, team), damage
   pounces, average pounce damage, pounces landed per hunter spawn, hunter
   lifetime, deadstops
5. **Smoker / boomer:** pulls, clears and time to clear, self clears, tongue
   cuts, booms landed, boomer popped before booming, damage taken while boomed
6. **Weapons:** pick rate (time held, from replay frames); damage and kills by
   weapon (needs plugin additions)
7. **Pace and pressure:** survivor damage taken per minute, SI damage per
   minute, average gap between SI hits, friendly fire, survivor spread
   (average distance between living survivors)

### Plugin additions (one release, together with the BALANCE line)

- Per-round damage and kills per weapon, emitted at ROUND_END
- Panic event and finale start markers as live events
- Per-round crowns and draw crowns (today these are per match only)

### Known traps

- Replays record temp=1 for survivors with no temp health. Any metric reading
  temp HP applies the viewer's workaround until the plugin fix lands.
- Rounds from standalone mix sessions have no match row; they are counted only
  when adopted into a match (current behaviour), so mix coverage may be partial.
- Replay side detection for pre-format-3 files relies on the header stamping the
  match route already does.

## 3. Admin compare dashboard (`/admin/balance`)

### Controls

Patch A and patch B (default: previous vs current), game type (default ranked),
servers, maps.

### "What changed" list

Every metric in every phase, one row each: value under A, value under B, change,
interval, verdict. Sorted real changes first, largest effect first. Verdicts:

- **Real change**: survives the false-discovery correction
- **Probably noise**
- **Too early**: fewer than 10 matches on either side, or the interval is too
  wide; shows an estimate of how many more matches are needed

### Method

- **Map mix adjustment.** Per-map rates are combined using patch A's map
  weights for both sides. Maps present in only one patch are excluded from the
  adjusted figure and listed.
- **Uncertainty.** Bootstrap by resampling whole matches (rounds within a match
  are correlated), 2000 resamples, 95% interval on the difference.
- **False alarms.** Benjamini-Hochberg across all rows in one comparison, 10%
  false discovery rate.
- **Skill check.** If the average rating gap between sides differs noticeably
  between the two patches, a banner says so.
- **Historical patches** show their "approximate" badge on the verdict.

Computation runs server-side and is cached per (patch A, patch B, filters),
invalidated when new rounds land.

### Trend view

Any metric over time (per match, with a rolling average), patch boundaries drawn
as vertical lines. Shows whether players are still adapting within a patch.

### Drill down

A metric opens its per-map breakdown and a list of example rounds (for example
"tanks that died fastest this patch"), each linking to the replay viewer at the
relevant moment.

### Access

Admin only. The API is shaped so the public page (piece 5) reads the same data
through an allowlist of approved metrics.

## Constraints for later pieces

- **Control panel (4):** knobs come only from `balance/knobs.json` with safe
  ranges; no raw cvar editing. Changes apply between matches only, to all
  servers identically, with rollback. Every applied change creates an
  `announced` patch before the servers pick it up, so its fingerprint is
  expected rather than detected.
- **Public page (5):** shows patch history with each change next to its
  measured effect, including all numbers across changes. Only allowlisted
  metrics; wording must carry the verdict (no "noise" presented as a result).
- **Split tests:** add a variant value on `match_rounds`, a matchmaker
  assignment and a dashboard mode comparing variants within one window. Nothing
  in pieces 1 to 3 may assume one fingerprint per time window.

## Testing

- Fingerprint canonicalisation: same inputs in any order give the same hash;
  any single change gives a different one.
- BALANCE parsing including split datagrams and duplicates.
- Detected patch creation and the admin flag.
- Each metric against fixtures with known answers.
- Phase windows on a fixture with a tank and a witch.
- Bootstrap, map reweighting and Benjamini-Hochberg against hand-computed
  small cases.
- Backfill run on a copy of the production database before deploy; spot-check a
  handful of rounds against their replays by eye.
- Plugin: BALANCE line and new per-round stats verified on the local test server
  before staging; round-start timing measured with hashing on and off.

## Deploy notes

Normal ship order: web first (tolerates missing BALANCE lines), then the plugin
on an empty server. Backfill runs once after the web deploy. No live-server
changes without the owner's go-ahead.
