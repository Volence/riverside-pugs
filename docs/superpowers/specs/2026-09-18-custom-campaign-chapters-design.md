# Where a campaign stops: choosing whether the finale is played

Status: **design, not started.** Spec written 2026-09-18, rewritten the same day after the owner narrowed the scope. This is plan 2 of the custom campaign work.

Related:
- `docs/superpowers/specs/2026-09-18-custom-campaigns-design.md`: plan 1, the upload/install/pool/stats half. Shipped and live. Sections 4 and 4b of that spec are superseded here.
- `docs/superpowers/specs/2026-08-13-passifice-l4d1-design.md`: the mission-file precedent. It no longer constrains this design, and the reason why is worth reading below.

## What this replaces

The first draft of this spec supported arbitrary per-chapter include and exclude, plus reordering. Delivering that meant rewriting the mission file inside each uploaded VPK, keeping two copies of every campaign (a rewritten one for servers, a pristine one for players), possibly moving the player copy to R2, and answering an unmeasured question about search-path precedence that Passifice recorded behaving counter-intuitively.

The owner then narrowed it, 2026-09-18:

> Honestly thinking about it we'll only really want to choose whether to play finales or not, and which map constitutes as finale (is it third, fourth, fifth, or sixth map+?)

and, on the part that was driving all the machinery:

> let's skip the skipping middle chapters for now

That removes the entire apparatus. Choosing **where a campaign stops** does not require changing which chapters exist or what order they are in, so nothing has to touch a mission file, a VPK, or the search path. The engine keeps playing its own chapter list; the plugin simply stops at a different point.

Gone with it: VPK rewriting, generated mission files, the two-copy split, the R2 question, the client-mission-mismatch risk, and the precedence spike. What remains is a number and a plugin change that reuses a path the plugin already has.

**Explicitly out of scope:** skipping a middle chapter (playing 1, 2 and 4 but not 3) and reordering. Those genuinely need the engine handed a different chapter list, which is the design this replaced. The `included` and `play_order` columns stay unused rather than being removed, so that work stays additive if it is ever wanted.

## What the plugin already does

Worth establishing precisely, because it is most of the feature and I described it wrongly twice before reading it properly.

A match does **not** end when the finale loads. The finale does not load at all. There are two end triggers:

| Trigger | Where | When |
|---|---|---|
| `"last scored map done"` | `plugin/pug-match.sp:3066`, in `FinishSecondHalf()` | the map that just finished is the one before the finale |
| `"finale loaded"` | `plugin/pug-match.sp:2574` | failsafe, when the chapter read fails |

The first is the normal path. It asks `NextMapIsFinale()` (`plugin/pug-match.sp:3076`), which reads `L4D_GetCurrentChapter()` and `L4D_GetMaxChapters()` and returns true when `chapter == chapters - 1`. `L4D_GetMaxChapters()` counts the mode's maps from the mission file.

So today every campaign plays all but its last chapter, and the rule is derived, not hardcoded. A five-chapter campaign plays four. A four-chapter campaign plays three.

That guard is deliberately defensive: `chapters < 3 || chapter < 2 || chapter >= chapters` returns false on any implausible read, because its comment says a bad value here "ends a live match early". It logs both numbers on every second-half end, which is how this feature can be verified without new instrumentation.

## The design

One value per campaign: **the map it stops after**. The backend tells the plugin, the plugin ends the match when that map completes.

### 1. Storage

One table, covering stock and custom campaigns alike, because an admin wants to drop a stock finale for exactly the same reason:

```sql
CREATE TABLE IF NOT EXISTS campaign_play_rules (
  slug         TEXT PRIMARY KEY,
  maps_to_play INTEGER NOT NULL
);
```

No row means the default, which is today's behaviour: every chapter except the last. Stock campaigns have no row until someone changes one, so nothing about existing matches changes on deploy.

A single table rather than a column on `custom_campaigns`, because stock campaigns have no row there and a second mechanism for them is how the two-switch mess started.

### 2. What the backend sends

`sm_pug_match` currently takes `<matchid> <token> <campaign>` (`plugin/pug-match.sp:346`). It gains a fourth argument: **the name of the map to stop after**.

A map name rather than a count, deliberately. A count has to agree with whatever `L4D_GetMaxChapters()` reports, and if the two ever disagree the match ends in the wrong place with nothing saying why. A map name is checked against the map that just finished, which is a fact the plugin already holds in `g_sCurrentMap`, and it reads clearly in the log.

The backend computes it from the registry: take the campaign's maps in order and pick the `maps_to_play`th, defaulting to the second from last.

Stock campaigns need their chapter lists for this, which the registry does not carry today (`maps: []`). Read them from `left4dead/missions/*.txt`, which the spike confirmed are plain files on disk, using plan 1's existing KeyValues parser. Do not hardcode four lists: a hardcoded list can drift from what the server actually runs, and the files are right there.

### 3. What the plugin does

When a stop-after map is supplied and the map that just finalized matches it, call `EndMatchNow()`. That is the same helper `!endpug` already uses (`plugin/pug-match.sp:1741`), documented as "finish the match here, without loading the finale", and it already handles the pending-finalize case.

Keep `NextMapIsFinale()` as the fallback for when no stop-after map was supplied, which is every self-started and auto-tracked match. Those have no backend telling them anything and must keep working exactly as they do now.

**Playing the finale is the case that needs care.** It is the one the owner actually asked for, and the one today's logic cannot express: `chapter == chapters - 1` is never true on the last chapter, so nothing ends the match. Under the new rule the stop-after map is simply the finale, and the match ends when the finale completes. That path has never run, so it is the first thing to test on a real match, not the last.

### 4. Admin UI

On the Campaigns tab, per campaign: how many maps it plays, defaulting to all but the finale. The chapter list already rendered there shows which chapters are in and which are dropped, so the effect is visible before anyone saves.

Stock campaigns appear in this tab too, with their chapters and the same control, and without upload, reinstall or delete. That is the other half of the owner's request and it costs nothing extra once stock chapter lists are being read.

Changing the number writes a row and nothing else. No reinstall, no transfer, no VPK touched. Worth saying so in the UI, because plan 1 trained the admin that changing a campaign means waiting on both servers.

## Testing

**First, on the local test server at `/home/volence/l4d1-ds`, before the admin UI exists:**

1. **Stop early.** Set a five-chapter campaign to three maps, play it, confirm the match ends after the third and the dump reports three maps.
2. **Play the finale.** Set it to all five. This is the path that has never run: confirm the finale loads, is played, is scored, and ends the match. If anything is going to be wrong, it is here.
3. **Default unchanged.** A campaign with no row behaves exactly as today. This is the regression that matters most, because it covers every match the site currently runs.
4. **Self-started.** A match with no backend-supplied stop map still ends on `NextMapIsFinale()`.

Then ordinary unit coverage: the stop-after map computed from the registry and the rule, stock chapter lists parsed from `left4dead/missions/`, the default when no row exists, and a rule naming more maps than the campaign has.

## Open questions

- **A campaign cut to two maps** trips `NextMapIsFinale()`'s `chapters < 3` guard. Under the new rule that guard is not consulted when a stop map is supplied, so it may simply work, but the guard exists because a bad read ends a live match early and it deserves a deliberate answer rather than an accident.
- **What happens after the finale completes** in versus, when the engine would normally move on. The plugin freezes at `MS_Ended` and the backend reaps it, which is what already happens after `!endpug`, but it has not been observed following a real finale.
- **Whether the vote should say how many maps a campaign plays.** A five-chapter campaign set to three is a materially shorter match, and players voting for it cannot currently tell.

## Decisions, and why

| Decision | Reason |
|---|---|
| A stop point, not chapter selection | Owner narrowed the scope, and it removes VPK rewriting, mission generation, two copies, R2 and the precedence spike entirely |
| Stop-after map name, not a count | A count must agree with `L4D_GetMaxChapters()`; disagree and the match ends in the wrong place silently. A map name is checked against a fact the plugin already holds |
| One table for stock and custom | Stock campaigns have no `custom_campaigns` row, and a second mechanism for them is exactly how the two-switch confusion started |
| Absent row means today's behaviour | Nothing about existing matches changes on deploy, so the risky path is opt-in per campaign |
| Stock chapter lists read from `left4dead/missions/` | Hardcoding four lists lets them drift from what the server runs, and the spike confirmed the files are plain and on disk |
| Keep `NextMapIsFinale()` as the fallback | Self-started and auto-tracked matches get no backend list and must keep working unchanged |
| `included` and `play_order` stay, unused | Middle-chapter skipping is deferred, not refused. Leaving the columns keeps that additive |
