# Health-run scoring: design

Date: 2026-11-18. Author: Malevolence (with Claude). Status: draft for owner approval.

Explainer for players (same idea, no implementation detail): https://claude.ai/artifact/E6jCXJRzE4pWHqaVDp7Dix

## Intent

Today almost all of a versus map's points come from reaching the saferoom. In 572 completed Season 0 PUGs a
typical wiped half scored 63, a half with four survivors in scored 804, and two teams that both wiped on the same
map were typically 5 points apart. How far a team got and how healthy it stayed are close to worthless unless it
makes the door, and on hard maps (Ranchhouse: 13 to 17% make rate) one lucky make decides the match.

Health-run scoring pays for staying healthy across the whole map, for beating the tank, and for reaching the
saferoom, all on one measure of health. It should reward what a team actually did, stay simple enough to explain
in a paragraph, and close the known tricks in today's bonus (a survivor on 1 health scores more after being downed
and picked up).

The owner wants it tried without risk first: computed in the background of every ranked match, visible to players
who ask for it, reviewable by admins, and only later switchable on for real test games.

## Goals

1. A scoring rule ("the rule", version `hr1`) defined precisely enough to implement once and recompute anywhere.
2. Stage 1, shadow: every match on our servers computes the rule alongside the real score. The real score, the
   winner, SR, the win chance model, `!health` and `!gg` are untouched.
3. Two player commands: `!healthalt` shows the current half's breakdown under the rule, and `!scoresalt` shows
   every round's scores under it.
4. An admin page that lists matches with real and alt scores side by side and the walking / tank / door split.
5. Raw components logged so other weights can be tried on the site without touching the servers again.

## Non-goals (this design)

- Stage 2 (a server switch that makes the rule the real score in unranked test games, chat lines when points
  land, a rebuilt `!health` panel, an opt-in `!scorehud` panel) and stage 3 (ranked switch at a season start,
  win chance retrain, `!gg` limits, site displays). They are outlined at the end so stage 1 does not block them,
  and each gets its own design before it is built.
- Changing the game's round-end score screen. It already disagrees with our multipliers and the owner accepts that.
- Individual credit. Every number is a team number.
- Finales. We do not play them.

## Anti-goals

- Any change to what a ranked match records as its score or winner while in shadow.
- A second source of truth for SR. SR-affecting data still comes only from `sm_pug_dump` as today.
- A rule players cannot check by hand from what `!scoresalt` prints.

## The rule (hr1)

### Stored health per survivor

Each survivor has three stores. Points = solid + 0.25 x pills + 0.25 x revives.

| Store | What counts | Weight | Max |
|---|---|---|---|
| Solid | permanent health (`m_iHealth` while standing) | 1.0 | 100 |
| Pills | temp health that came from pills, plus 50 for a bottle held in slot 4 | 0.25 | 12.5 from one bottle |
| Revives | temp health that came from a revive, plus the temp health each unused revive would give | 0.25 | 15 |

A fresh survivor is 127.5 points; that is "100%". With the pill and revive weights equal (as here), eaten-pill temp
and revive temp never need telling apart: the term is `0.25 x (current temp health + 50 if holding pills + unused
revive health)`. Temp health is the decayed buffer (`m_healthBuffer - (now - m_healthBufferTime) x
pain_pills_decay_rate`, floor 0), the same formula `GetAccurateTempHealth` in l4dscores.sp uses.

Unused revive health = the sum of the buffers the game would give for each revive still available:
`sum over k = m_currentReviveCount .. survivor_max_incapacitated_count - 1 of max(1, survivor_revive_health -
k x survivor_revive_successive_penalty)`. On our config that is 30 per revive with a max of 2 (builder: confirm the
penalty cvar's value on the boxes; read the cvars, do not hardcode 30).

States:

| State | Solid | Stores |
|---|---|---|
| Standing | `m_iHealth` | temp + held pills + unused revives |
| Incapacitated (not hanging) | 0 | held pills + the buffer the pending revive will give + unused revives after it |
| Hanging from a ledge | what the game would restore now (below) | held pills + unused revives + restored temp (below) |
| Dead | 0 | 0 |

Ledge hang, from `CTerrorPlayer::OnLedgeGrabbed` / `OnRevived` in the source rebuild (`/home/volence/l4d/source`,
main c86eec007): the grab saves the survivor's health and sets `m_iHealth` to `survivor_ledge_grab_health` (300 on
our boxes). A rescue does not increment the revive count. It restores solid health
`h = int(hang health now / ledge grab health x saved health)` when that is above 1, and sets the temp buffer to
`max(0, revive buffer - h)`. So a hanging survivor counts `h` solid and `0.25 x max(0, revive buffer - h)` temp.
The decompile labels the divisor `SurvivorIncapacitatedHealth`, not the ledge-grab cvar: the builder must confirm
which cvar it is before relying on the ratio (rig: `deploy/tools/ledge-fix-test`). The saved health is not a
netprop; record `m_iHealth` in a `player_ledge_grab` hook (or read the field) rather than guess.

Ledge clamp (Fable review 2026-11-18; kept by the owner's ruling, 2026-11-18): as the game works, a ledge grab
would raise a low-health survivor's points (1 solid, no temp: 16 before, about 23 while hanging and after rescue),
which breaks "going down never raises a score". Temp health granted by a ledge rescue is not counted beyond the
temp the survivor had just before the grab (decayed as usual): while hanging and after rescue, the counted temp is
`min(game temp, pre-grab temp decayed)`. The excess stops being tracked when the buffer is next replaced (an incap
and revive) or the survivor dies. Our servers have no game-side fix for health gained through a ledge rescue
(`l4d_ledge_fix` only blocks harmless grabs; `survivor_ledge_grab_health` is 300), so this clamp is what stops a
ledge grab from raising a score. A game-side ledge fix (plugin `l4d_ledge_heal_fix`) is being built separately;
the scoring clamp stays either way.

Team stored health % = sum of the four survivors' points / (4 x 127.5).

### The three payouts

Base pools per half: walking 700, tank 300, door 500. A perfect half is 1500 before multipliers.

1. **Walking (700).** Each survivor owns a quarter (175) and has a mark: the furthest distance already paid.
   At each sample (every 0.5 s) a survivor is paid `175 x (own points now / 127.5) x ((distance - mark) / 100)`
   and the mark moves to their distance, only when all of these hold: the survivor is standing (alive, not
   incapacitated, not hanging), no tank is up (no tank window open), and the distance is past the mark. In every
   other case the mark does not move, so ground covered while down, hanging or with a tank alive is paid later,
   the first sample the survivor stands with no tank up, at the health they have then. This mirrors how
   `l4d_tank_rules` freezes the real distance points while a tank lives and lets them catch up after. How the
   survivor got there does not matter (walked, flung, punched, warped or teleported): a warp or stuck-teleport
   never costs a team points, and a team that makes the map at full health always gets the full walking pool.
   (Owner ruling, 2026-11-18.)
   Distance (Claude's call, 2026-11-18): rescaled so the start saferoom is 0 and the end saferoom is 100.
   `distance = clamp((flow - startFlow) / (maxFlow - startFlow), 0, 1) x 100`, where `flow` is the survivor's own
   furthest flow so far (never decreasing), `maxFlow` is the map's max flow and `startFlow` is the lowest
   survivor flow at the moment the half goes live (one value for the team). At round end, each survivor who banks
   the door is credited the rest of the way from their mark to 100 at their points at that moment, so a clean make
   always walks the full map, including any ground held back while a tank was still up. Use raw float flow, not
   pug-match's rounded whole percent.
   Every survivor's mark starts at distance 0 when the half goes live (survivors with no nav area are ignored when
   taking `startFlow`). A body first seen mid-half (a bot added late) starts with its mark where it stands. A guard
   (Claude's call, 2026-11-18): a survivor who was dead and is alive again has their mark moved up to where they
   reappear without pay, since dying resets health and revives and paying the skipped ground would make dying pay
   better than limping. Versus has no rescue closets, so this cannot fire in a real match (only on an admin
   respawn); it is harmless.
2. **Tank (300).** Paid once per half, when the tank fight ends with the tank dead or vanished and at least one
   survivor standing (alive, not incapacitated, not hanging) at that moment: `300 x team stored health %` at that
   instant. All four down or hanging when the tank goes means the round is lost, and the tank pays nothing.
   Claude's calls, 2026-11-18: the tank's death pays whatever killed it (survivors, a fall, fire, a stuck-tank
   slay), because the survivors outlived it either way; with more than one tank alive it pays when the last one
   dies, as pug-match's `TANKDONE` window does (`pug-match.sp:3452-3498`, `5103-5105`). Owner ruling, 2026-11-18:
   a tank that vanishes (kick, disconnect, despawn) pays exactly like a dead one. A frustration pass keeps the
   window open. A tank removed by round-end cleanup pays nothing (the window is only judged while the half is
   live). If the survivors wipe with the tank alive, nothing is paid. The saferoom door cannot close with the tank
   alive on our config, so there is no "ran past it" case. Whenever a tank window closes, the team's stored-health
   snapshot at that instant is recorded whether or not it paid, with who ended it (`surv`, `other`, or `gone` for
   a tank that vanished) and how many tanks spawned in the half.
3. **Door (500).** At round end with at least one survivor up: each survivor who is alive and not incapacitated
   or hanging banks `125 x (own points / 127.5)`.

### Map multipliers

Two per map. The three parts are `walking x walkMult`, `tank` and `door x doorMult`, each rounded to the nearest
integer; the half score is the sum of the three integers, so a player can add up what the commands print.

- `walkMult`: set so the average team earns the same walking points on every map (fitted per season).
- `doorMult`: the map's existing versus multiplier (the mission file's `VersusModifier`, i.e. the Season 1
  saferoom-rate numbers), which l4dscores already loads as `MapVersusDifficulty`.
- A map with no fitted entry (custom campaigns, anything under 50 completed matches): `walkMult` 1.00 and
  `doorMult` = its mission-file multiplier. It gets fitted numbers at the next season recompute once it has
  50 matches of shadow data.

Starting `walkMult` table, fitted on Season 0 (Dead Air 0.85 / 1.00 / 1.15 / 1.05, Death Toll 0.95 / 1.05 / 0.90 /
1.15, No Mercy 0.95 / 0.95 / 1.05 / 1.15, Blood Harvest 0.90 / 0.80 / 1.00 / 1.15). These came from a cruder
health measure (see Evidence) and are placeholders until shadow data replaces them.

### Properties the builder must preserve (they are the tests)

- Going down never raises a survivor's points: just before an incap and just after the revive, stores are equal
  and solid has dropped to 1.
- Eating pills never raises points over holding them.
- A survivor standing still, or a team waiting, earns nothing and loses nothing except temp decay.
- Walking for one survivor never pays for distance another survivor covered.
- How a survivor moved never matters: a warp, fling or teleport forward is paid like walking, and a team that
  makes the map at full health always gets the full walking pool.
- The sum of a perfect half is exactly 700 x walkMult + 300 + 500 x doorMult.

## Evidence so far

Scratch analysis on the 2026-10-28 DB copy and replay snapshots (`data/win-dataset/`), scripts in the session
scratchpad (`rescore*.py`), using a cruder rule: team furthest progress, health = (solid + temp) / 400 from
5-second snapshots, no revive or pill stores.

- 54 of 572 matches (9.4%) change winner; about 50 at every door pool from 500 to 2000.
- Typical wipe 400, typical make 900 (today 63 and about 800). Points: walking 76%, tank 10%, door 13%.
- Same-map gap: make vs wipe 517, both wiped 63, so one make outweighs about 8 maps of getting further
  (today about 140).
- A wiped team outscores a made team on the same map in 4 of 980 cases.
- Split-half consistency (team ahead on maps 1+3 also ahead on 2+4) is 60% under both systems: the rule changes
  what is rewarded, with no evidence it picks the stronger team more often.

Stored replays merge solid and temp health and carry no revive counts, so hr1 itself cannot be backtested.
Shadow mode is how it gets measured.

## Approaches considered

1. **Compute in the plugin, log raw components, apply weights on the site (chosen).** l4dscores already owns
   per-survivor health, temp health, the map multiplier and the `!health` output, so the live computation and
   `!scoresalt` belong there. It reports the final hr1 numbers and the unweighted pieces. Reliable, exact
   (sub-second sampling, real health fields), and other weights can be tried offline.
2. **Compute on the site from replays.** No plugin change, but replays lack revive counts and pill-held state at
   the needed fidelity, R2-offloaded replays are slow to re-read, and players could not see it in game.
   Rejected: it cannot serve `!scoresalt` and would need a replay format change anyway.
3. **A new standalone plugin.** Clean separation, but it would duplicate l4dscores' logical-team tracking,
   multiplier loading and health helpers, and the two could drift. Rejected.

The owner picked: shadow in every match, `!scoresalt` for players, an admin page, a later config switch for test
games; walking per survivor; the store model above; quarter weights; door 500.

## Design, stage 1

### Plugin: l4dscores (deploy repo, `plugins-src/l4dscores.sp`, currently 8.5.9-riverside8)

- New include `plugins-src/l4dscores_alt.inc` holding all hr1 state and maths, so the existing file gains only
  hook calls. Cvar `l4d_score_alt` (default 1) turns the computation on; with 0 the plugin behaves exactly as today.
- State per half: per-survivor furthest flow %, the three walking integrals per team (solid part, temp+pills
  part, revive part, kept separately and unweighted), tank snapshot (three sums and a paid flag), door snapshot
  (three sums and survivors in). State follows the survivor body, not the player: carry it across
  `bot_player_replace` / `player_bot_replace`.
- Sampling: a repeating 0.5 s timer while a half is live and unpaused. Per-survivor flow should use the same
  source pug-match uses for its `LIVEHUD p=` field / `ROUND_FLOW` (see `pug-datafeeds.inc`), as a percentage of
  the map's max flow. Do not use `L4D_GetTeamScore(6)`, which is a team average.
- Tank: l4dscores does its own detection (so the commands work outside PUG matches too), mirroring pug-match's
  `TANKDONE` window logic rather than calling into pug-match (event semantics: `tank_death` also fires on a
  frustration pass, AI tanks have no `tank_spawn`).
- Door: computed inside the existing `Event_RoundEnd` path (a Pre hook, so it is ready before pug-match's Post
  handler reads it), using the same alive / incapped / hanging tests that code already makes. Keep the finished
  half's numbers readable until the next `round_start`: pug-match has a delayed retry path.
- Same-map reload: `campaignScores[]` is not reset on a reload, the half scores are subtracted
  (`l4dscores.sp:640-658`). The alt tally must make the same subtraction.
- Crash resume (Claude's call): the real tally is restored by `sm_l4dscores_seed`; the alt tally is not. After a
  resume `!scoresalt` shows only the rounds since the restart and says so. The site is unaffected, it rebuilds
  totals from its stored rows.
- Multipliers: `doorMult` = `MapVersusDifficulty`, or 1.0 if that is 0 (it starts at 0.0 and stays there when
  `OpenConfig()` fails, `l4dscores.sp:105`, `673-674`). `walkMult` from a new KeyValues file
  `addons/sourcemod/data/altscore_maps.txt` (map name to walk multiplier), default 1.0, read in `OnMapStart`.
- Match tally: alt half totals per logical team, kept and reset at exactly the points `campaignScores[]` is.
- New native `Score_GetAltHalf(...)` returning, for the half that just ended (valid from round end until the next
  round start): the half's walking / tank / door (multiplied, integer), the raw unweighted components, the tank
  snapshot's health %, who ended the tank window, tanks spawned, survivors in, and both multipliers. The exact
  signature is fixed in the plan.
- Isolation (Fable review): no alt code runs inside l4dscores' real handlers, because a runtime error there
  would abort the real scoring. The door snapshot is its own `round_end` Pre hook registered after the existing
  one; map setup is deferred with `RequestFrame` from the first line of `OnMapStart`; the sampler is its own timer
  callback. No new native imports unless marked optional (go-live comes from left4dhooks' first-survivor-left-
  safe-area forward, not from readyup). A ready-up round restart (`roundRestarting`, `l4dscores.sp:386`) discards
  the alt half exactly as the real handler returns early. `Command_SwapScores` swaps the alt tally; `sm_setscores`
  and the score vote mark it partial.
- Two player commands, mirroring the existing pair (owner ruling 2026-11-18: `!scoresalt` shows every round's
  scores, `!health` shows the parts of the bonus). In shadow the real `!health` and `!scores` keep showing today's
  scoring unchanged, so the alt versions are separate commands:
  - `!healthalt` (`sm_healthalt`, registered next to `sm_health`): the current half's breakdown, chat only, to
    the caller, in the style of `PrintGetNowScores`. Proposed lines (wording is the builder's to tune, content is
    fixed):

    ```
    [Alt] Walk: 171 so far, 26% of the map covered. 74% left, worth up to 487 (438 at this health).
    [Alt] Tank: up to 300 (269 at this health).
    [Alt] Door: up to 500 (449 at this health).
    [Alt] This half: 171 banked, 1327 if you finish at this health. Team health 90%.
    ```

    "% of the map covered" is the average of the survivors' paid marks; "left" is 100 minus that. "Worth up
    to" is the unpaid ground of every living survivor at full points, with the map's walk multiplier; "at this
    health" is the same ground for the standing survivors at their current points (a dead survivor adds
    nothing; a down or hanging one adds to "up to" only). While a tank window is open the walk line says
    "(paused while the tank is up)".
    "If you finish at this health" = banked walk + walk at this health + the tank at its current worth (if it
    has not paid and still can) + the door at its current worth, so the parts add up to it. After the tank is
    paid the tank line reads `Tank: 186 (team was at 62%)`; a window that closed with no survivor standing reads
    `Tank: 0, the window closed with no survivor standing.` In the second half a fifth line gives the other
    team's alt score for this map as the number to beat (`To beat: N.`).
  - `!scoresalt` (`sm_scoresalt`): every round played so far under the rule, one row per map with both teams'
    alt half scores, then the alt match totals. Mirror how the existing `!scores` output is built and shown
    (the score panel around `Menu_ScorePanel` in l4dscores.sp), with the alt numbers in place of the real ones.
    The plugin therefore keeps the alt half scores per map for the whole match, reset where `campaignScores[]` is.
  - In stage 2 test games, where the rule is the real score, `!health` and `!scores` themselves show these.
- Version bump to 8.5.9-riverside9. Build with `./build.sh l4dscores`.

### Plugin: pug-match (pug repo, `plugin/pug-match.sp`, currently 0.3.45)

- Declare `Score_GetAltScores` optional and feature-check it like the other l4dscores natives.
- At round end, after the real score is credited, emit one UDP line (within the 768-byte `EmitPug` limit, which
  truncates silently):
  `ALT_ROUND map=<n> half=<1|2> surv=<a|b> rule=hr1 walk=<int> tank=<int> door=<int> wm=<x100> dm=<x100>
  ws=<f> wt=<f> wr=<f> ts=<f> tt=<f> tr=<f> ds=<f> dt=<f> dr=<f> tankpct=<int|-1> tankby=<surv|other|gone|none>
  tanks=<n> in=<0..4>`
  where `ws/wt/wr`, `ts/tt/tr`, `ds/dt/dr` are the raw solid / temp+pills / revive components of walking, tank
  and door before weights and multipliers. `ts/tt/tr` and `tankpct` hold the snapshot whenever a tank window
  closed, paid or not (`tank=0` when unpaid); `tankby=none tankpct=-1` means no window closed. The line is sent
  before the match can end on the last half, and skipped when the survivor side is unknown, as `ROUND_END` is.
- Keep the same values per round in memory and add one `ALT` line per round to `sm_pug_dump`
  (`WriteDump`), same fields including `map=` (dump `MAP` lines carry no ordinal, it is their position), so the
  site has a reliable copy at match end. `DumpLine` is 1024 bytes. The `ALT` lines must come before `END`: the
  dump parser stops reading there (`dumpParse.ts:194`) and ignores verbs it does not know, so an older site is
  unaffected.
- No behaviour change when the native is missing or `l4d_score_alt` is 0: no `ALT_ROUND`, no `ALT` lines.
- Version bump; rebuild before `stage.sh`.

### Site (pug repo)

- `src/db.ts` `SCHEMA`: new table `match_round_alt` (match_id, ordinal, half, surv_team, rule, walk, tank, door,
  total, walk_mult, door_mult, the nine raw components, tank_pct, tank_by, tanks, survivors_in, source
  `udp|dump`, created_at;
  primary key match_id + ordinal + half + rule). No changes to existing tables.
- `src/logParse.ts`: parse `ALT_ROUND` (unknown keys ignored, like the other lines); `src/server.ts` dispatches to
  a new `recordAltRound` next to `recordRoundEnd` in `src/liveView.ts`, using the same ordinal resolution.
- `src/dumpParse.ts`: parse `ALT` lines. They are written with source `dump`, replacing UDP rows, AFTER the
  `completeMatch` transaction has committed and inside a try/catch that only logs: an alt write must never be
  able to roll back or fail a match result. A dump without `ALT` lines is normal (old plugin) and must not fail.
  An `ALT` line whose map has no `MAP` line (a forfeit mid-map) takes ordinal = the `MAP` count.
- A pure module `src/altScore.ts`: recompute a half's total from raw components for given weights and multipliers,
  and the match-level comparison (alt totals per team, alt winner, differs from real). Unit tested, including
  that hr1 weights reproduce the plugin's reported integers within rounding.
- Admin page: Balance desk, new tab "Alt scoring" (`BALANCE_TABS` in `web/src/routes/admin/adminRoutes.ts`,
  component modelled on `web/src/routes/admin/balance/TeamBalance.tsx`, route `GET /api/admin/balance/alt-scoring`
  guarded by `makeRequireAdmin`). Contents:
  - summary: matches with alt data, how many would have a different winner, points share (walking / tank / door);
  - per-map table: halves, average walking points, the `walkMult` that would equalise it;
  - recent matches: date, campaign, real score, alt score, same / different winner; expanding a match shows each
    half's walk / tank / door, tank health %, survivors in.
  - Only completed, unvoided PUGs count in the summary; all matches with data are listed.
  - Claude's call: a match counts toward "different winner" only when every half the real score recorded has an
    alt row. `!gg` forfeits and abandons end through `EndMatchNow` with no final round end, so their last half has
    none; they are listed with an "incomplete" mark and left out of the summary counts.
- No public page, no setting, no change to `/api/maps`, win chance, or any existing route.

### Rollout

Deploying plugins to the live boxes is the owner's call (stage on restart, never mid-match, push after deploy).
The site half can ship first: it ignores absent lines. Order: site, then pug-match, then l4dscores with
`altscore_maps.txt`. Rollback is `l4d_score_alt 0`.

## Known gaps accepted for hr1

- **Ledge rescue hands out temp health without spending a revive** (game behaviour). Today's bonus pays for it.
  hr1 clamps it out (see "Ledge clamp"); the owner kept the clamp.
- **Tank-less maps.** `!healthalt` says "Tank: up to 300" until the half ends even on a map that never spawns one.
  The data records how many tanks spawned.
- **First aid kits.** A held kit is worth nothing under hr1 and a heal raises solid health and resets revives.
  Settled: the owner confirmed ranked has no kits.
- **Pills cap.** The pills-use code is not in the converted source and the cap on total health was not verified.
  The rule counts a held bottle as a flat 50 and eaten pills as whatever temp health the game actually gave, so no
  constant needs to be right; the builder should note what the game does when verifying "eating never gains".
- **Health at the moment of pay.** Walking is paid at the survivor's health at the sample it is paid, so ground
  held back during a tank is paid at the health after the tank. Accepted (owner ruling).
- **Chip damage.** Common-infected scratches and friendly fire move the score all map long. Accepted; shadow data
  will show how much.

## Left to the builder

Native and field names, timer cadence (0.5 s is a starting point), chat wording, the admin page layout within the
desk's existing patterns, test rig details (local l4d1-ds with cheats; l4dscores has no existing tests, so a small
scripted scenario per property above is expected), and how the per-survivor state is keyed across bot takeovers.

## Later stages (outline only)

- **Stage 2, test games:** cvar switch that makes hr1 the real round score in unranked mixes or scrims, chat lines
  when the tank and door pay, `!health` rebuilt for the rule, optional `!scorehud` side panel (SourceMod panel
  refreshed each second; L4D1 has no working HUD text channel), multipliers refitted from shadow data.
- **Stage 3, ranked:** only at a season start, with the win chance model rebuilt on alt half scores, `!gg` limits,
  cast HUD and site score displays moved to the new scale.
