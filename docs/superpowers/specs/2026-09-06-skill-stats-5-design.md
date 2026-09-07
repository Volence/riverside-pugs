# Sub-project 5: Skill Stats Capture and Display

## What this is

Capture the competitive skill events an L4D1 versus match already produces (skeets,
deadstops, boomer pops, crowns, tongue cuts, high pounces, tank damage) and carry them
through to the website, per player, per match, and aggregatable into season leaderboards.

Today `pug-match.smx` captures five stats: `sidmg sikill ck ff rev`. All five are
survivor-side. The infected half of every match is invisible, tank damage is explicitly
discarded, and none of the events players actually argue about are recorded anywhere.

Written 2026-09-06 after a live test session on the Dallas box. Design decisions below
that cite evidence cite that session.

## Why now, and what it depends on

The 2026-09-06 session established the two facts this design rests on:

1. **`l4d2_skill_detect` runs on L4D1 unmodified** and exposes its events as global
   forwards. Verified in game (`★★★ Mal shotgun-skeeted a hunter.`). The fork in use is
   fbef0102's, at `/home/volence/l4d/L4D1_2-Plugins/l4d2_skill_detect`, which is dual-engine
   and needs no porting.
2. **Rotoblin already computes richer stats than we do and exposes none of them.**
   `l4dcompstats.sp` tracks 23 stats in its `STATS` enum;
   `l4d_tank_witch_damage_announce_spawnAnnouncer.sp` tracks tank punches, rocks and
   survival time. Neither declares a single native, forward, or `RegPluginLibrary`.
   The data is computed and printed to chat, where it dies.

**Hard dependency, resolve first:** sub-project 5 is worthless until the `exec pug_match`
blocker is fixed. `src/orchestrator.ts:94` execs a config that does not exist, so a PUG
launched at a pub-configured server never reaches ready-up, never leaves `MS_Pending`,
and records `0-0` for every map. Stats of a match that scored nothing are not interesting.
`pug_match.cfg` must therefore do three things, decided 2026-09-06:

1. `exec rotoblin_hardcore_4v4.cfg` **Hardcore is the ranked ruleset.** Not lite.
2. Ensure `l4d2_skill_detect.smx` is loaded, or every ranked match silently records zeros
   for every skill stat.
3. `sm_skill_report_enable 0`. **skill_detect is a data source here, not a display.** Its
   starred chat callouts are how we verified it works, but a ranked match does not want
   them competing with Rotoblin's own announcements. The forwards fire regardless of the
   report cvar; only the `CPrintToChat` output is suppressed. To verify the plugin again in
   future, set the cvar back to 1 temporarily rather than assuming silence means broken.

## Scope

### Captured via skill_detect forwards

| Stat key | Forward | Side |
|---|---|---|
| `skeets` | `OnSkeet` + `OnSkeetSniper` / `Magnum` / `Shotgun` / `GL` / `Melee` | survivor |
| `skeets_hurt` | `OnSkeetHurt` + its five weapon variants | survivor |
| `team_skeets` | the above with `isTeamSkeet` true | survivor |
| `skeet_assists` | `OnTeamSkeetAssist` | survivor |
| `deadstops` | `OnHunterDeadstop` | survivor |
| `boomer_pops` | `OnBoomerPop` | survivor |
| `crowns` | `OnWitchCrown` | survivor |
| `draw_crowns` | `OnWitchCrownHurt` | survivor |
| `tongue_cuts` | `OnTongueCut` | survivor |
| `self_clears` | `OnSmokerSelfClear` | survivor |
| `rock_skeets` | `OnTankRockSkeeted` | survivor |
| `clears` | `OnSpecialClear` | survivor |
| `insta_clears` | `OnSpecialClear` where `timeA` < `sm_skill_instaclear_time`; a **subset** of `clears`, not additional to it | survivor |
| `dps_landed` | `OnHunterHighPounce` with `bReportedHigh` | infected |
| `pounce_damage_high` | sum of `actualDamage` from `OnHunterHighPounce` | infected |
| `biles_landed` | `OnBoomerVomitLanded` count | infected |
| `survivors_biled` | sum of `OnBoomerVomitLanded`'s `amount` | infected |
| `tank_rocks_landed` | `OnTankRockEaten` (credited to the tank) | infected |
| `times_skeeted` | `OnSkeet*` victim | infected, **private** |
| `times_deadstopped` | `OnHunterDeadstop` victim | infected, **private** |

Weapon breakdown of skeets (`skeets_shotgun`, `skeets_magnum`, ...) goes to the free-form
blob rather than to first-class keys. It is interesting on a match page and pointless as a
leaderboard.

### Captured via pug-match's own hooks

| Stat key | How | Side |
|---|---|---|
| `tank_damage` | remove the `ZC_TANK` exclusion at `pug-match.sp:817,850,886` and route to its own field | survivor |
| `damage_as_si` | infected to survivor damage in the existing `player_hurt` handler | infected |
| `tank_punches` | `player_hurt` where the attacker is a tank and the weapon is the claw | infected |

`tank_damage` is the cheapest real gain in this whole design. Those three hooks already
run for tanks and deliberately drop the result; this routes it into a field instead of
the floor. The existing `sidmg` stays tank-free, preserving the compstats convention that
motivated the exclusion. The convention exists so tank damage does not distort *survivor*
damage totals, which argues for a separate field rather than for discarding it.

### Non-goals for v1

Per-map stat granularity (per-match totals only); bunny hop streaks; car alarms; damage
from commons; witch damage totals; tank survival time; leaderboard **UI** (the schema and
API support it, the pages come later); backfilling stats for matches already recorded.

## Decisions

### Extend pug-match, do not write a second plugin

The user asked for "a plugin". This should nonetheless live inside `pug-match.smx`.

Every one of these stats has to be keyed to a roster slot so it survives reconnects and
map changes, and has to be emitted inside `sm_pug_dump`. `pug-match` owns the roster
(`g_sRosterId`, `g_iClientRoster`), owns dump emission, and owns match lifecycle. A
separate plugin would have to duplicate the roster or reach into it through a new native
interface, creating a second contract to keep in sync with the first, for no isolation
benefit: the two would still have to agree on slot identity, reset timing, and dump
ordering.

To keep `pug-match.sp` from becoming a junk drawer (890 lines today, roughly +250 with
this), the stat handlers go in **`plugin/pug-stats.inc`**, included by `pug-match.sp`.
`build.sh` copies one file into the Rotoblin scripting dir and compiles relative, because
absolute unix paths break `spcomp` under wine; it grows to copy two files and clean up
both. That is a two-line change and preserves the existing wine workaround.

### skill_detect is an optional dependency, and its absence must be visible

Global forwards do not require the declaring plugin to be loaded; the handlers simply never
fire. So no `LibraryExists` gate is needed for correctness.

But this creates a silent-failure mode that matters more than it first appears: a match
played without `skill_detect` loaded records zero skeets for all eight players, which is
indistinguishable from a match where nobody skeeted. Rating and leaderboards would ingest
those zeros as real.

So the dump declares its own capability. `DUMP` gains a `skilldetect=0|1` key, set from
`LibraryExists("l4d2_skill_detect")` checked at `MATCH_START` rather than at dump time, so
a mid-match unload cannot make a partial capture look complete. The backend refuses to
write skill stats when the flag is 0, and the match page says the data is unavailable
rather than showing zeros.

### A new `SKILL` dump line, not more keys on `STAT`

`dumpParse.ts:71` requires all five `STAT` keys and ignores unknown ones, so extra keys
would parse but silently do nothing until the parser was updated in lockstep. A separate
line type keeps the `STAT` contract frozen, makes the skill block legitimately optional
(absent, not zero-filled, when `skilldetect=0`), and lets an older backend read a newer
plugin's dump without misinterpreting it.

```
DUMP match=1000 skilldetect=1
MAP map=l4d_vs_airport01_greenhouse a=824 b=400
STAT steamid=765... team=a sidmg=1850 sikill=13 ck=44 ff=4 rev=2
SKILL steamid=765... skeets=2 deadstops=0 boomer_pops=1 ... tank_damage=1699
END winner=a a=824 b=400
```

Emission rule, stated once: **one `SKILL` line per roster slot, always.** The three
pug-match-native keys (`tank_damage`, `damage_as_si`, `tank_punches`) are always present on
it. The skill_detect-derived keys are present only when `skilldetect=1` and are **omitted
entirely** when it is 0, never zero-filled. A consumer therefore distinguishes "zero skeets"
from "skeets were not measurable" by key absence, not by value.

### Storage: a narrow key/value table, not a dozen columns

The user chose season leaderboards, which rules out burying everything in `stats_json`
(unindexed, and `json_extract` on every row for every leaderboard). The obvious
alternative, one column per stat, means a migration per stat forever and a `match_players`
table twenty columns wide.

```sql
CREATE TABLE IF NOT EXISTS match_player_stats (
  match_id  INTEGER NOT NULL REFERENCES matches(id),
  player_id TEXT    NOT NULL REFERENCES players(steamid),
  stat      TEXT    NOT NULL,
  value     INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id, stat)
);
CREATE INDEX IF NOT EXISTS idx_mps_stat ON match_player_stats(stat, value DESC);
```

Adding a stat later needs no migration at all, which matters because this list will grow.
Leaderboards are a single indexed group-by joined to `matches.season_id`:

```sql
SELECT mp.player_id, SUM(mp.value) AS total
FROM match_player_stats mp JOIN matches m ON m.id = mp.match_id
WHERE mp.stat = ? AND m.season_id = ? AND m.state = 'completed'
GROUP BY mp.player_id ORDER BY total DESC LIMIT ?
```

The existing five columns on `match_players` stay exactly as they are. They work, they are
already rendered, and moving them would be churn for its own sake.

The cost accepted: no type safety on stat keys at the DB level, and a typo in a key name
produces a silently empty leaderboard rather than an error. Mitigated by defining the key
set as a single exported constant shared by the parser and the API, and asserting in tests
that every key the plugin can emit appears in it.

### Stat visibility: public by default, `self` for the ones that sting

Stats where a high number is bad are captured and stored like any other, but shown only to
the player they describe. The stated purpose is self-improvement ("am I getting skeeted too
much?"), which is served by showing someone their own number and defeated by ranking
everyone by it.

Visibility is a field on the shared stat-key registry, alongside side and label, so it lives
in exactly one place:

```ts
{ key: 'times_skeeted', side: 'infected', visibility: 'self', label: 'Times skeeted' }
```

Three rules follow, and all three are enforced server-side in `src/routes/stats.ts`, never by
the UI hiding a value it was sent:

- **Profile** (`/api/players/:steamid`): `self` stats are included only when
  `getSession(req) === steamid`. This is the first authenticated read path in `stats.ts`,
  which is public today.
- **Match detail**: a match page carries all eight players. `self` keys are stripped from
  every row except the requesting player's own.
- **Leaderboards**: `self` stats are **never** eligible. Enforced by filtering the registry
  by visibility when resolving the requested stat key, so a "most skeeted" board cannot be
  built by guessing a URL.

No new page. `Profile.tsx` is already routed at `/player/:steamid`; viewing your own profile
gains a section the public one does not have.

**The privacy is real but partial, and the spec should say so rather than overclaim.** Every
skeet has a skeeter and a victim, and `skeets` is public. Someone can therefore infer that
skeets are happening to somebody. What stays private is *per-victim attribution* and your own
totals, which is what the feature is actually for. It is not a guarantee that nobody can work
out you had a bad night.

### Per-match totals, not per-map

Per-map would multiply both the wire format and the table by the map count for a granularity
nobody has asked to see. The schema can carry it later by adding `map_ordinal` to the primary
key; nothing here forecloses it.

## Data flow

```
skill_detect forward  ─┐
pug-match player_hurt ─┴─> g_iSkill[slot][STAT] ──> WriteDump() "SKILL ..." line
                                                          │
                                              RCON sm_pug_dump
                                                          v
                                        dumpParse.ts  parses SKILL lines
                                                          v
                                    matchResult.ts  writes match_player_stats
                                                          v
                              routes/stats.ts  match detail + leaderboard endpoints
                                                          v
                                    web/  MatchDetail.tsx skill columns
```

Unchanged from today: the dump is the only SR-affecting path, pulled over RCON, idempotent,
and the UDP stream stays lossy and cosmetic.

## Error handling

- **skill_detect absent:** `skilldetect=0`; `SKILL` lines still carry the three native keys,
  the skill_detect keys are absent, the backend writes no rows for them, and the UI shows those
  columns as unavailable rather than as zeros.
- **Unknown stat key in a `SKILL` line:** parser ignores it and logs once per dump. A newer
  plugin against an older backend degrades rather than fails.
- **`SKILL` line for a steamid not on the roster:** same treatment as the existing
  `matchResult.ts:30` warning path for unmatched `STAT` rows.
- **Idempotency:** `sm_pug_dump` may be called repeatedly, so the write uses
  `INSERT ... ON CONFLICT (match_id, player_id, stat) DO UPDATE`, matching the existing
  guard style in `applyMatchRatings`.
- **Stat overflow:** all counters are `int`; `tank_damage` across a full campaign stays far
  inside 2^31.

## Testing

- **Parser:** `SKILL` line parsing, unknown keys, missing keys, `skilldetect=0` dumps,
  malformed values. Follows `tests/dumpParse.test.ts`.
- **Storage:** idempotent double-dump writes one row per (match, player, stat); unmatched
  steamid warns and does not throw.
- **Leaderboard query:** season isolation, completed-matches-only, ordering, ties.
- **Key registry:** every key the plugin emits is in the shared constant. This is the test
  that catches the typo the EAV design allows.
- **Plugin:** manual, on the box, per `plugin/TESTING.md`. There is no unit test harness
  for SourcePawn here and building one is out of scope.

## Risks

- **Double counting versus l4dcompstats.** Both compute skeets independently. Measured on
  2026-09-06: they agreed exactly (2 and 2) on the same rounds. If they ever diverge, players
  will believe the in-game scoreboard over the site, so a divergence is a site bug regardless
  of which is technically right.
- **skill_detect threshold behaviour on L4D1.** `l4d2_skill_detect.sp:646` invents
  `z_pounce_damage_range_min/max` because L4D1 lacks them. `dps_landed` therefore depends on
  values the engine never defined. Worth sanity-checking against the Rotoblin infected table
  before trusting DP counts.
- **Silent zeros** if `pug_match.cfg` forgets to load skill_detect. The `skilldetect` flag is
  the mitigation, and it only works if the backend actually honours it.

## Resolved 2026-09-06

1. **Hardcore** is the ranked ruleset.
2. `skill_detect` stays loaded everywhere; it is a tracking dependency, and ranked matches
   silence its chat output with `sm_skill_report_enable 0`.
3. `times_skeeted` and `times_deadstopped` are kept, as `self`-visibility stats.

## Still open

- Whether the private section should grow beyond the two negative stats into a general
  self-review panel (accuracy, damage taken, clear times). Deferred until there is data to
  look at, since designing a coaching view before seeing real numbers is guesswork.
- Whether `sm_skill_report_enable 0` should also apply to the casual server. Left on there
  for now; players seem to like the callouts.
