# Custom campaign chapters: choosing which maps a campaign plays

Status: **design, not started.** Spec written 2026-09-18. This is plan 2 of the custom campaign work.

Related:
- `docs/superpowers/specs/2026-09-18-custom-campaigns-design.md`: plan 1, the upload/install/pool/stats half. Shipped on branch `worktree-custom-campaigns`. Sections 4 and 4b of that spec are superseded here.
- `docs/superpowers/plans/2026-09-18-custom-campaigns-web.md`: plan 1's implementation plan, whose closing section sketched this work.
- `docs/superpowers/specs/2026-08-13-passifice-l4d1-design.md`: the precedent that decides how chapter lists work at all, and the measured warning about search-path order.

## Why

Plan 1 made custom campaigns uploadable, installable, votable and attributable. They play the chapter list their author shipped, and end on their own finale, exactly as the stock four do.

What it cannot do is choose. The owner asked for two things it does not deliver:

> some campaigns might not have full 5 maps, like for example swamp fever has 4 maps and the 4th map is sometimes skipped because it's finale. Maybe we should have some way for that too and something to make sure they're played in order?

and, on what ends a match:

> the plugin should change to the last map in the list that's enabled should count as last map

So: per-chapter include and exclude, chapter reordering, and a match that ends after the last chapter you kept. This applies to stock campaigns too, where excluding a finale is the same operation.

On that last point the plugin is already most of the way there, which section 3 covers: it ends after the last scored map completes, counting chapters from the mission file. Rewriting the mission may be the entire change.

The database already carries `included` and `play_order` on `custom_campaign_chapters` from plan 1's first commit, so none of this reshapes what exists.

## What the spike established

The question plan 1 deferred was where a generated mission file must live to beat the one a campaign ships. Measured and reasoned on `/home/volence/l4d1-ds`, 2026-09-18:

| Finding | Evidence | Confidence |
|---|---|---|
| Stock mission files live loose in `left4dead/missions/` | `airport.txt`, `credits.txt`, `farm.txt`, `garage.txt`, `hospital.txt`, `lighthouse.txt`, `smalltown.txt` are all present as plain files | Measured |
| Rotoblin overrides every stock mission from inside an addon VPK | `l4d1_mission_nav.vpk` contains `missions/{smalltown,river,hospital,garage,farm,airport}.txt` | Measured |
| Those overrides genuinely differ from the loose copies | `VersusModifier` is `1.2` in the VPK against `1.3` loose, same chapter of Death Toll | Measured |
| Therefore a VPK's mission beats a loose one | That VPK exists to apply those overrides, and Rotoblin is a production config where they are known to take effect | **Inferred, not measured** |
| Search paths are `metamod` then `left4dead_dlc3` then `left4dead` then `hl2` | `gameinfo.txt` on the test server | Measured |

The direct measurement was attempted and abandoned: `sv_lan 1` disables rcon on this engine, and driving the console over a stdin pipe did not come up. That is a gap in method, not a blocker, because of the next section.

## The design: precedence is avoidable

A custom campaign's mission file exists **only inside its own VPK**. Nothing else on the server declares that campaign. So editing the mission inside that VPK means there is no competing file and no precedence question at all. It cannot lose a fight it is not in.

That is strictly better than arguing with search-path order, which Passifice measured behaving counter-intuitively and whose header says in capitals not to retry the VPK-override route without new evidence.

### Two copies, not one

The naive version of this rewrites the file players download, and that is a bad trade. Toggle one chapter on a 300 MB campaign and its bytes change, its hash changes, and all eight players re-download 300 MB because one line of text differs.

Split them instead:

| Copy | Where | Contents | Changes when chapters change |
|---|---|---|---|
| **Server copy** | each game server's `addons/` | mission rewritten to the included chapters, in order | yes, rewritten and reinstalled |
| **Player copy** | the download page | the pristine uploaded VPK, untouched | **no, never** |

Only the server's copy decides what gets played. The player's copy only needs to carry the maps. So a chapter toggle costs a server-side rewrite and reinstall, and costs players nothing. Their file also stays byte-identical to the community's copy from gamemaps, which helps anyone who already has it.

### The assumption this rests on

**That a client does not need a mission file matching the server's.** The expectation is that it does not: in a server-driven versus match the server says which map to load and the client obeys, and the chapter list drives lobby UI this site does not use.

That expectation is load bearing and unverified, and its failure mode is a map not loading mid-match. **It is the first thing plan 2 tests**, before any of the rest is built. See Testing.

If it turns out clients do need the matching file, the fallback is rewriting the distributed copy as well, and chapter selection becomes something set once when a campaign is added rather than adjusted casually. The design does not change shape, only the cost of a toggle.

### Where the player copy lives

Plan 1 serves downloads from the server's `addons/` directory, on the reasoning that one copy cannot drift from itself. That reasoning expires here: there are now deliberately two different files, so the download must come from the pristine one.

Owner decision, 2026-09-18: **host the player copy on R2** if local disk becomes the pinch. Plan 1's spec recorded that R2 could not help because the server needed the VPK locally regardless; under the two-copy design that is no longer true, because the player copy has no reason to be on the box at all. R2's egress is unmetered and the file is written once and read whole, which is the same shape as demos.

Implementation order: keep both copies local first, since it is simpler and disk is no longer expected to bind once demos move to R2, and move the player copy to R2 behind the existing `src/r2.ts` if it does.

## Architecture

### 1. Mission generation

From the included chapters in `play_order`, generate a mission file listing exactly those chapters and nothing else.

- **Included means played**, including the last one. No terminal padding chapter. What ends the match is the plugin, see 3.
- Per-chapter versus tuning is copied **verbatim** from the source chapter: `VersusModifier`, `versus_boss_spawning` and its whole block, `VersusConvertPills`, `VersusFinaleProgressScoreFactor`, `TankVariant`, `WitchVariant`, `Image`. Passifice's header records what happens otherwise: copying from the wrong source silently undid a deliberate competitive setting and nothing reported an error.
- `Name` must be preserved exactly. It is the key the engine binds a mission by.
- `coop` and `survival` blocks are copied through untouched. They are not what this site plays and rewriting them is scope nobody asked for.

### 2. VPK rewriting

New module, `src/vpkWrite.ts`, alongside plan 1's read-only `src/vpk.ts`.

Given a source VPK and a replacement mission file, produce a new VPK with that mission swapped in. The directory tree must be rebuilt because the entry's length and offset change.

Constraints:
- Every other file in the archive is copied byte for byte. This rewrites one entry, not the archive's contents.
- Mission files are a few kilobytes and live in the directory file, which plan 1's reader already relies on. A campaign whose mission is in a numbered archive is rejected at upload today and stays rejected.
- The rewritten VPK is written to a temp name and renamed into place, for the same reason plan 1's transports do: srcds mounts whatever is in `addons/` at map load and must never see a half-written file.

### 3. Match end: probably already correct

**Corrected 2026-09-18 after reading the plugin rather than trusting an earlier reading of it.**

Plan 1's spec, and the first draft of this one, said the plugin ends when the engine reports the
finale map loaded, and that the finale therefore loads and is immediately discarded. That is
wrong, and the correction matters because it removes most of this section.

There are two end triggers:

- `plugin/pug-match.sp:3066`, the normal path. `FinishSecondHalf()` calls `NextMapIsFinale()` and
  ends with `"last scored map done"` when the map that just finished is the one before the
  finale. The finale never loads.
- `plugin/pug-match.sp:2574`, the older finale-loaded trigger, kept as a failsafe for when the
  chapter read fails.

So the plugin already ends after the last scored map completes, which is exactly the behaviour
the owner asked for. It is not a hardcoded count either: `NextMapIsFinale()` at
`plugin/pug-match.sp:3076` asks left4dhooks for `L4D_GetCurrentChapter()` and
`L4D_GetMaxChapters()`, the latter counting the mode's maps **from the mission file**.

That last detail is the whole point. Rewriting the mission to list only the included chapters
changes what `L4D_GetMaxChapters()` returns, so the plugin's existing logic should follow the
edited chapter list with no change at all.

**Therefore: assume no plugin change, and test that assumption before writing any.** If it holds,
plan 2 needs no plugin work, no staging on an empty server, and none of the live-match-flow risk
that came with it. That is a materially smaller and safer piece of work than this spec first
described.

What still needs checking, in the same session as the client-mission test:

- Does `L4D_GetMaxChapters()` read the rewritten mission, or something cached from load time? A
  value cached before our rewrite would end the match at the wrong map.
- `NextMapIsFinale()`'s guard rejects `chapters < 3`. A campaign cut to two included chapters
  would fail that check and fall through to the finale-loaded failsafe, which for a rewritten
  mission may never fire. Either forbid cutting below three chapters in the admin UI, or relax
  the guard deliberately and say why.
- The excluded-finale case: if an admin keeps every chapter including the finale, `chapter ==
  chapters - 1` is never true on the last map and the match would not end. This is the one case
  that may genuinely need the plugin taught something new, and it is precisely the case the owner
  asked for ("the last map in the list that's enabled should count as last map").

Only if those tests fail does the original plan apply: extend `sm_pug_match` with the ordered
included map list and fire the existing `EndMatchNow()` path, which `!endpug` already uses at
`plugin/pug-match.sp:1730`.

### 4. Stock campaigns get chapters

Plan 1's registry carries `maps: []` for stock campaigns, because the orchestrator only ever needed each one's first map.

Read the real lists from `left4dead/missions/*.txt` at startup, using plan 1's existing KeyValues parser. Do not hardcode four chapter lists: a hardcoded list can drift from what the server actually runs, and the files are right there.

This is what lets the admin panel list stock campaigns alongside custom ones, and lets an admin exclude a stock finale.

Stock campaigns have no uploaded VPK to rewrite, so excluding a stock chapter takes the other route: a generated mission written into a server-side location that beats the loose `left4dead/missions/` copy. **This is the one place the unmeasured precedence question still bites**, and it is why stock chapter control is staged after custom chapter control rather than with it. See Open questions.

### 5. Admin UI

On the existing Campaigns tab:
- Stock campaigns listed alongside custom ones, with their chapters, no upload or delete controls.
- A checkbox per chapter, and reordering.
- Changing either rewrites the server copy and reinstalls, with the same per-server state rows plan 1 already shows.
- The UI must say plainly that a change reinstalls to every server, because that is a transfer, not a database write.

**Do not ship the checkbox before the rewrite works.** Today `included` is read in exactly one place, `campaignRegistry.ts`, to compute `firstMap`. So a checkbox wired only to the database would change the starting map when you untick chapter 1 and do nothing at all when you untick a middle chapter: the same control, two different outcomes, no feedback saying which you got. That is the shape of the "In the pool" bug plan 1's final review caught, and repeating it knowingly would be worse than the first time.

## Testing

**First, before building anything else**, two probes in one session on the local test server.

**Probe one, the plugin question.** Rewrite a campaign's mission to drop a chapter and confirm `L4D_GetMaxChapters()` reflects the edited list rather than a cached value, and that the match ends on the new last map. The plugin logs both values at `plugin/pug-match.sp:3080` on every second-half end, so this is readable from the log without new instrumentation. Also exercise the two edge cases section 3 names: a campaign cut to two chapters, and one where every chapter including the finale is kept.

**Probe two, the client mission question.** Put a campaign on the local test server with a rewritten mission that drops a chapter, connect a real client running the pristine VPK, and confirm the match plays the server's chapter list without the client erroring or failing to load a map. If that fails, stop and revisit the two-copy split.

Then:
- `vpkWrite.ts` round trip: rewrite a mission, read it back with `vpk.ts`, confirm every other entry is byte identical to the source.
- Mission generation: chapter order, excluded chapters absent, verbatim tuning copy including the nested `versus_boss_spawning` block.
- A campaign whose first chapter is excluded starts on the right map.
- Match end on the last included map, including the case where it **is** the campaign's finale, and the failsafe still firing for a self-started match with no backend list.
- Stock chapter lists parsed from `left4dead/missions/` match what the four stock campaigns actually play.
- Reinstall after a chapter change lands the new bytes on every server, verified by size as plan 1 does.
- The player download still serves the pristine file after a rewrite, not the server's copy.

## Open questions

- **Does a client need a mission file matching the server's?** The first test above. Everything else assumes no.
- **Stock chapter control needs the precedence answer** that this spike did not get. Custom campaigns avoid it by construction; stock campaigns cannot, because their mission is a loose file we would have to beat. Options are a generated file in a higher-priority search path (`left4dead_dlc3` is one on the test server), or a Rotoblin-style override VPK, which is what `l4d1_mission_nav.vpk` already does successfully. Measure before building.
- **Reordering across campaigns**, as Passifice does by hand, is not in scope. The data model would carry it, but nobody has asked and the admin UI for it is a different problem.
- **File consistency** remains out of scope, as in plan 1.

## Decisions, and why

| Decision | Reason |
|---|---|
| Rewrite the mission inside the VPK | A custom campaign's mission exists only there, so there is no competing file and no precedence question. Sidesteps the trap Passifice measured |
| Two copies: rewritten for servers, pristine for players | Otherwise every chapter toggle changes the download's hash and costs all eight players a re-download of up to 300 MB for one line of text |
| Player copy may move to R2 | Owner, 2026-09-18. Plan 1's "R2 cannot help" reasoning assumed one copy and expires under this design |
| Assume no plugin change until tested | The plugin already ends after the last scored map completes via NextMapIsFinale(), which counts chapters from the mission file, so rewriting the mission may be enough on its own |
| Stock chapters read from `left4dead/missions/` | Hardcoding four lists lets them drift from what the server runs, and the files are already on disk |
| Stock chapter control staged after custom | It is the only part that still needs the unmeasured precedence answer |
| No checkbox before the rewrite works | `included` currently affects only `firstMap`, so a database-only checkbox would behave differently for the first chapter than for a middle one, with nothing telling the admin which they got |
