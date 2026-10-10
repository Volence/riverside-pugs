# Abandon rating (owner rulings 2026-10-10)

Branch `abandon-rating`, pug-match 0.3.31. Built and tested locally. Nothing deployed.

## The rulings

1. "Decided" is exactly the !gg rule: the trailing team is behind by more than
   `pug_gg_ceiling` (1100) x VersusModifier summed over the survivor halves it
   still has, up to the stop map or the map before the finale.
2. A rostered player abandons a decided match: it is NOT aborted. It completes,
   the leading team wins (whichever side the quitter was on), and everyone else
   is rated normally.
3. The quitter never gains. Every abandon, decided or not, costs them a rating
   loss. An undecided abandon still aborts with no rating change for the other
   seven.
4. The abandon ban ladder is unchanged.
5. (Later ruling) Two or more quitters: EVERY quitter takes the loss and their
   own ban. A decided match still goes to the leading team, everyone else is
   rated normally, and a quitter on the winning team is still a loss.
6. (Later ruling) Lifting an abandon ban does NOT refund the loss. Staff give it
   back with an explicit, logged admin action, "Restore rating".

## What changed

### Plugin (pug-match 0.3.31)

- `pug-gg.inc`: `Gg_DecidedNow` reuses `Gg_Judge` (the !gg rule itself, with
  `pug_gg_enable` ignored because that switch is for the vote). Not live means
  not decided.
- `pug-leave.inc`: when the abandoner runs out, the server judges once whether
  the match was decided and keeps that judgement. `sm_pug_status` prints
  `STATUS gg decided=a|b|none gap=N ceiling=N known=0|1 at=abandon|now ended=0|1`.
  With no abandoner it shows the rule right now (`at=now`) for staff.
- Every player who runs out of reconnect time is an abandoner, not only the
  first: leave tracking carries on after the first abandon until the match
  ends (the game stays paused), every slot that runs out in the same tick is
  caught, each gets its own ABANDON line and heartbeat repeat, and
  `sm_pug_status` lists each as `STATUS abandon steamid=...` (the old
  `STATUS leave abandoner=` line still names the first, for older sites).
  The dump gets one `ABANDON steamid=...` line per quitter before END.
  "Decided" is judged once, at the first abandon. `sm_pug_leave` still
  refuses once someone has abandoned.
- New `sm_pug_abandon_end <token> <steamid64>`: ends a decided match like a
  !gg forfeit (partial map kept, technical pause closed, `EndMatchNow`). It is
  refused unless this server named that player as the abandoner, judged the
  match decided, and the same team still leads. Asked again it answers
  `PUGOK already ended`. `MATCH_END` and the dump's `END` line carry
  `abandon=<steamid64>`; older sites read past it. The ABANDON heartbeat stops
  once the match was ended this way.
- The chat line at the abandon now says what happens (decided: Team X wins and
  it is rated; otherwise: nobody else's rating changes) and that the quitter
  takes a loss and a ban. The kick message reads "Team A wins (decided, NAME
  abandoned)".
- `AB_TEST=1 ./build.sh` adds a rig-only `sm_pug_abtest <slot>`. Never stage
  that build.

### Site

- Schema: new table `match_abandons`, one row per quitter per match
  (PK match_id + player_id; team, decided, gap, ceiling, created_at,
  restored_at, restored_by, restore_reason). Each row is written with that
  quitter's ban in one transaction (`recordAbandons`). `forfeit_team` is untouched, so a
  decided abandon is never counted as a forfeit.
- `src/abandon.ts handleAbandon`: the same rcon confirm now also parses the
  STATUS gg line and every STATUS abandon line (`parseAbandonStatus`), and
  records ALL the abandoners the server names, so two players who ran out
  together are caught by one read. The decided state and the quitters come
  only from rcon, never from the UDP ABANDON line. A later quitter on a match
  still being ended as decided is added by their own line; one the site never
  heard about is added at collection from the dump's ABANDON lines
  (`completeMatch`, only for a match already on record as a decided abandon,
  before ratings, ban published after the commit).
  - Decided: row + ban, then `sm_pug_abandon_end`, then the ordinary collector
    (`finishWithRetry`), so completion, demos, replays, release and the result
    card go exactly the way a !gg forfeit does.
  - Not decided, a plugin without the STATUS gg line (pre-0.3.31), or a plugin
    that refuses the end: aborted as before, plus the quitter's loss.
  - Box unreachable while ending: the row and ban stand, the next ABANDON line
    retries only the end (no second confirm, no second ban).
- `src/rating.ts`:
  - `activeAbandons(matchId)`: the unrestored quitters of a match.
  - `quitterLoss(...)`: the quitter's rating (exact math below).
  - `applyMatchRatings`: everyone else is rated on the result with the
    quitters in the lineup as they played; each quitter gets `quitterLoss`
    and a loss on their W-L. If the match is too small to rate (`too_few`),
    the quitters still take the loss.
  - `applyAbandonPenalty(matchId)`: the quitters alone, for an aborted match.
    All are judged from the same pre-match ratings, so order and recompute do
    not change the numbers. Idempotent per (match, player) history row.
  - `recomputeSeasonRatings` replays completed PUGs AND aborted PUGs with an
    unrestored abandon, in end order. Recompute neither drops nor doubles the
    loss (tested twice in a row).
- Restore rating: `POST /api/admin/matches/:id/restore-abandon-rating`
  with `{ steamid, reason }` (admin only, reason required; steamid may be left
  out only when the match has one quitter, else 400; 404 not a quitter, 409
  already restored). Per quitter: marks that row restored and recomputes the season; audit row
  `restore_abandon_rating` with target = the player and detail
  `{ matchId, reason }`, so it shows on their file and in the admin feed.
  UI: beside Unban on the player file when the active ban is an abandon ban,
  an Abandons list on the player file (each with Restore rating), and on the
  Live desk's Recent results and Aborted rows. The People desk ban list and
  the file timeline show "rating loss restored by X: why".
- Wording: match page, /matches list and the Discord result card say
  "Team A (decided, NAME abandoned)" / "Team A wins (decided, NAME abandoned)".
  The admin feed abandon line says decided or not and that the quitter takes a
  rating loss. Aborted texts now say nobody who stayed was rated.
- Aggregates: the weekly SR climb counts an abandon loss on an aborted match;
  balance metrics read team mean mu from completed matches only. Standings
  `games` counts rating_history rows, so an abandon loss counts as a game,
  consistent with wins + losses.
- `mergePlayers` rewrites `match_abandons.player_id` and `restored_by`.

## The quitter's rating math

OpenSkill (Plackett-Luce, the library's defaults), the same model as every
match. Let A and B be the lineups that would be rated (rated = 1 roster rows
that played at least half the maps so far; with no maps played, everyone),
with the quitter always included on their side. Then

    [A', B'] = rate([A, B], rank = quitter's team last)
    quitter.mu, quitter.sigma = their entry in A' or B'
    losses += 1, wins unchanged

That is the update they would get had their team lost this match with this
lineup.

- Decided, quitter on the trailing (losing) side: identical to their normal loss.
- Decided, quitter on the leading (winning) side: their team-mates get the win;
  the quitter gets the loss instead.
- Undecided: nobody else moves; the quitter gets the same counterfactual loss.

Why not "one player against the other team": OpenSkill sums team skill, so
1 vs 4 is a certain loss and barely moves anyone. Example with fresh ratings
(SR 833): a normal 4v4 loss goes to SR 707 (mu 23.571), a 1v4 loss only to
SR 827 (mu 24.925). The team-based loss keeps the penalty the size of an
ordinary loss.

`newcomer_balance_offset` only affects team picking, never ratings, so it plays
no part here.

## Edge cases (decisions)

- Abandon before go-live (configuring, ready-up, no maps): never decided (the
  plugin only judges a live match). Aborted, quitter's loss against the full
  roster.
- Booked games (scrims, tournaments): still ignored entirely, no row, no loss.
- Two or more quitters: every one is on record, banned on their own ladder
  and rated a loss; restoring one leaves the others. Someone still away (not
  yet out of time) when the match ends is not a quitter.
- Repeat ABANDON lines: one ban, one row, one rating_history row.
- Void of a decided-abandon match: the result is dropped as usual, the
  quitter's loss stays (voiding is about the result; only Restore rating
  removes the loss).
- Abandons from before this ships have no `match_abandons` row: no retroactive
  loss. A backfill was not built.
- The abandon allowance / ban ladder (`abandonsSince`, `abandonBanMinutes`) is
  unchanged and still keyed on the ban rows.

## How it was tested

- `npx tsc --noEmit -p .` and `-p web/tsconfig.json`: clean.
- `npx vitest run`: 739 files, 11,295 tests, all passed.
- New `tests/abandonRating.test.ts` (33 tests). Several quitters: same team,
  opposite teams, both teams in a decided match, one in a decided match plus
  one named only by the dump after it ended, a late line while collecting,
  a dump on a match nobody abandoned, per-quitter restore. Also: STATUS gg parsing, undecided
  abort + loss with exact OpenSkill numbers, old plugin fallback, configuring,
  repeat lines, booked games, decided with quitter trailing and leading (exact
  numbers for all eight), plugin refusal fallback, unreachable box retry,
  second quitter, too-few-to-rate, recompute reproduces exactly (twice), void
  keeps the loss, restore + recompute equals a season with no abandon losses,
  People desk ban row, Discord card wording, dump parser, and the restore
  route (admin only, reason, audit row, 409, match page and list name).
- `web/src/routes/admin/RestoreRating.test.tsx`: the form and the labels.
- Plugin on an isolated rig copy (`~/l4d1-ds-cfgfp/abrate`, srcds under
  `unshare -rn`, AB_TEST build): see the rig results section below.

## Ship order

1. Web first: merge to master, `./deploy-web.sh`. The table is created on
   start. A 0.3.30 box has no STATUS gg line, so every abandon keeps aborting,
   now with the quitter's loss. Safe during matches per the deploy rules.
2. Then pug-match 0.3.31 (the release build, NOT an AB_TEST build) into the
   deploy repo and out through `deploy/tools/stage-on-restart.sh` on the five
   pool boxes, so it lands at each box's next srcds restart.
3. Verify: on an idle box `sm_pug_status` shows a `STATUS gg ... at=now` line;
   `sm plugins info pug-match` says 0.3.31.

## Rig results (2026-10-10, `~/l4d1-ds-cfgfp/abrate`, `unshare -rn`, AB_TEST build)

Resumed match 501, one finished map, 8 rostered, on hospital01 (mission read:
modifiers 1.0/1.2/1.4/1.5/2.0, ceiling 1100 x 5.1 = 5610 for the halves left).

1. A leads 6000-0, a team B player abandons:
   `STATUS gg decided=a gap=6000 ceiling=5610 known=1 at=abandon ended=0`.
   `sm_pug_abandon_end` for another player: `PUGERR not the abandoner`; wrong
   token: `PUGERR bad token`; the right one:
   `MATCH_END a=6000 b=0 winner=a abandon=76561199000000005`, `PUGOK ended
   winner=a`; asked again: `PUGOK already ended`; STATUS then shows `ended=1`.
2. A leads 1000-0, a team A player abandons: `decided=none gap=1000`,
   `sm_pug_abandon_end` answers `PUGERR not decided` (the site aborts).
3. B leads 6000-0 and a player on the LEADING team abandons: `decided=b`,
   `MATCH_END a=0 b=6000 winner=b abandon=76561199000000006`.

4. Two quitters (team B slot 5, then team A slot 1), A leading 6000-0:
   STATUS lists both (`STATUS abandon steamid=...` x2) with `decided=a`;
   `sm_pug_abandon_end` for the SECOND quitter ends it (`MATCH_END ... winner=a
   abandon=<first>`); the dump (hex nonce, state=ended) has an ABANDON line
   for each and `END winner=a a=6000 b=0 abandon=<first>`.

Not covered on the rig: the in-game chat lines (no clients on the rig).
