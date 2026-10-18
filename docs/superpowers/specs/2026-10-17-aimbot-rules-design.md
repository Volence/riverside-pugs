# Aimbot rules from the nepmir ground truth

Date: 2026-10-17. Owner-approved approach (brainstorm in session dc6aec01). Companion to
`2026-10-17-evader-fingerprints-design.md`.

## Why

nepmir (76561198129925325, dethisa's 5th account) hard-aimbotted match 722 and was banned on
2026-10-17. They are the second confirmed cheater (after Bella<3 on 10-10), and the first confirmed
aimbot. An analysis of Dallas game logs (3,167 player-matches) and 500 replays (520 player-matches)
found three separators. Their moment-to-moment aim at 10 Hz (trigger timing, snap rate, angular
speed) looked ordinary. That fits a "legit" aimbot: it shows in where the bullets land and in rare
huge snaps, not in reaction time.

| Signal | nepmir | Honest best |
|---|---|---|
| SMG headshot share on SI kills | 14/16, binomial p = 4e-5 vs pooled 0.367 | p = 8.7e-3 (#1 of 104) |
| LilAC aim-snap ldelta | 143.5° | every one of 42 other aimbot flags under 45° |
| 90°+ flick to an SI shot and back within 1 s | 2 in the match | max 1 (#1 of 520) |

Today's only aimbot opinion is LilAC, and it gave nepmir one flag that looked like the noisy 1-offs.
`integrity_rounds` is a wallhack analyzer. The site never sees headshots: they appear only in raw
game logs, which only Dallas keeps.

## Rules

- **A. Headshot share.**
  - **Groups:** survivor kills of human-controlled SI, per weapon group. `auto` is smg + pistol +
    dual pistols, the nepmir case. `rifle` is hunting_rifle, its own pool because honest snipers
    headshot a lot. Shotguns are excluded because pump kills never report a headshot.
  - **Fires when:** within one match, the player has >= 10 kills in a group AND
    P(X >= headshots | n, p_group) < 1e-3. p_group is the pooled headshot share for that group over
    the trailing 30 days. Until 500 kills exist in a group, p_group is fixed: `auto` at 0.367 (from
    the log study); `rifle` is measured before it is enabled.
- **B. Big snap.** A LilAC aimbot flag whose reason carries ldelta >= 60 is stored with severity
  `high` instead of `suspected`. Site-only, so it ships first.
- **C. Flick and return.** An SI kill counts as a flick-return when, in the 300 ms before the kill,
  the view yaw/pitch moved >= 90° in total angular distance, and in the 1000 ms after, it moved back
  to within 45° of where it started. Fires at >= 2 such kills in one match.
- **Escalation.**
  - Any two of A/B/C in one match: one `integrity_flags` row of kind `aimbot_multi`, severity
    `high`, posted to the mod channel with the mod-role ping.
  - Any one alone: its own flag (`hs_share`, `flick_return`, or the LilAC row now `high`), posted
    like other analyzer flags, no ping.
  - Nothing bans or holds anyone. A fired rule is a "cheat flag" second sign in the evader
    fingerprint spec.

## Data: plugin side

`plugin/l4d_inputstats.sp` goes to 0.4.0. It already hooks `OnPlayerRunCmdPre`, which receives the
real per-usercmd view angles before any plugin can alter them, and `player_death`.

- **Angle ring:** per client, the last 40 usercmds (400 ms at 100 tick) of view angles plus the server
  tick. It is reset on spawn, team change and disconnect.
- **On player_death:** when the victim is a human SI (not a ghost, not a bot, not a common infected,
  not the tank) and the attacker is a human survivor, take a kill record. It holds:
  - the weapon name (from the event)
  - the event's headshot flag
  - the attacker-to-victim distance
  - `pre`, the largest angular distance between the kill-tick view and any view in the previous
    300 ms
  - the kill-tick view angles
- **After 1000 ms:** a one-shot timer records `back`, the smallest angular distance, during that
  window, between the attacker's view and the view 300 ms before the kill. Then it emits one signed
  line:

```
L4DM id=<steamid64> k=sikill w=<weapon> hs=<0|1> dist=<units> pre=<deg> back=<deg> cls=<victim class> v=3
```

- **Edge cases:** if the attacker disconnects or dies before the timer, `back=-1` (unknown, never
  counted as a return). The line goes through the existing `PugLog` signing path like the other
  L4DM lines. One line per SI kill is a few dozen per match, well inside the log budget.

Angular distance is the great-circle angle between the two view directions (pitch and yaw), so a
roll-free 180° turn reads as 180.

## Data: site side

- **Parsing:** `src/logParse.ts` parses `k=sikill`. Anything malformed is rejected, as with the other
  L4DM kinds.
- **Table:**

```sql
CREATE TABLE si_kills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER, server_id INTEGER, steamid TEXT NOT NULL,
  weapon TEXT NOT NULL, headshot INTEGER NOT NULL, dist INTEGER NOT NULL,
  pre REAL NOT NULL, back REAL NOT NULL, victim_class TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX si_kills_match ON si_kills(match_id, steamid);
```

- **New module `src/aimRules.ts`:**
  - **A and C** are evaluated once per ended match, inside the same end-of-match sweep
    (`scanEndedMatches`) as the auto-bhop signature, so a mid-match prefix never fires.
  - **B** is applied where LilAC flags are inserted.
  - **Escalation** runs after A/B/C for the match.
  - Flag text gives the numbers: kills, headshots, p-value and pooled rate for A; the kills with
    pre/back degrees and map times for C.
- **Settings:** `aim_rules`, values `off` | `log` | `on`.
  - `log` writes flags but does not post them.
  - Ships as `log` for A and C until the thresholds are re-measured on plugin data (the plugin
    measures at 100 Hz, which is sharper than the 10 Hz replays the study used).
  - B ships `on`.

## Testing

- **Site unit tests (vitest):**
  - parse accept and reject for `k=sikill`
  - the binomial tail against known values
  - the group pooling and the fallback rate
  - each rule's threshold edges
  - escalation (two rules give one `aimbot_multi`)
  - B's severity mapping
  - a kill with `back=-1` never counts toward C
- **Plugin:** the existing in-plugin self-test (`EmitLine` with known values) gains a `sikill` case.
  On the local test server, with cheats on and a bot SI killed after a scripted 180° turn, check that
  `pre` and `back` come out right.
- **Calibration after one week of `log`:** report the honest distributions of A's p-values and of
  per-match flick-return counts, and confirm nepmir-like values would still fire. Thresholds are then
  set from that data, and A/C go `on`.

## Rollout

1. **Web:** parser, table, rules, B `on`, A/C `log`. Deployed with `deploy-web.sh`. Web deploys may go
   out during matches.
2. **Plugin 0.4.0:** stage on all five pool boxes. It applies at each box's next empty restart
   (`stage-on-restart.sh`), never mid-match.
3. **After one week:** recalibrate, switch A/C `on`.

## Limits

- One cheater, one match: the thresholds are optimistic until a second confirmed case.
- A shotgun-only aimbot is invisible to A, because pump kills report no headshot. C still applies to
  it.
- Silent aim does not beat C: it rewrites the usercmd angles the server receives, and those are what
  the ring records. It only hides the snap from the cheater's own screen and from demos.
