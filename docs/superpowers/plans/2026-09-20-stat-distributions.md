# Stat Distributions: Implementation Plan

**Goal:** The reported statistics stop being season totals. A stat column answers
"what does this player usually get" (a median over matches) and "how does that
compare" (a percentile against the field), instead of "who has played the most".

**Problem this solves.** Every stat surface today reports a sum or a mean of
sums. `leaderboardData` returns `SUM(mps.value)` per player, so sorting the
board by skeets ranks attendance. The profile tiles divide a season total by
games played, which one 40-skeet night distorts for the rest of the season. The
map tables do the same through `perMapAverages`. `playerStandings` already
argues the per-match case in its own comments and is the only surface that acts
on it, and even there a player outside the top five is told nothing at all.

**Architecture:** One pure module, `src/quantiles.ts`, computes quantiles over a
sample of numbers and is the only place the formula lives. Three read models
(`leaderboardData`, `profileData`, `playerMapBreakdown`) grow a second stat bag
built from per-match samples rather than from sums, and keep the summed bag they
already return so a Totals view stays one toggle away. `playerStandings` stops
truncating at the top five and returns a percentile for every metric. The
frontend gains no new statistics of its own: it picks a bag and renders it.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, better-sqlite3,
Preact + preact-iso, vitest (node project for `tests/`, happy-dom for `web/`).

## Global Constraints

- No em dashes anywhere: code, comments, test names, commit messages, docs, page
  copy. Rephrase by meaning, never swap the character for a hyphen.
- Structural and behavioural changes go in separate commits.
- Commit messages match the repo: one short imperative sentence, no
  conventional-commit prefix.
- Run `npm run typecheck` before every commit touching `src/`, `tests/` or `web/`.
- No schema change. Every number in this plan is computed from rows that already
  exist. If a task seems to need a column, the task is wrong.
- A statistic is never shown without the sample size it rests on. This is the
  rule `MIN_SURVIVAL_SAMPLE` already applies to survival percentages, applied
  everywhere else.

## Facts about the existing code this plan depends on

Checked against the source on 2026-09-20.

**The plugin writes zeros, and writes nothing when it cannot measure.**
`consistency`-independent: `plugin/pug-stats.inc:124` `WriteSkillLines` loops
every key in `PS_MAX` for every rostered player and formats `key=%d` from
`g_iSkill`, so a player who scored nothing gets an explicit `key=0`. The only
skip is `if (!g_bSkillDetect && StatNeedsSkillDetect(...)) continue`, which drops
the key for the whole match. `src/matchResult.ts:61` mirrors the second half
(`if (def.needsSkillDetect && !d.skillDetect) continue`).

The consequence, and the rule every sample in this plan follows: **an absent
`match_player_stats` row means the stat was not measured, and a stored 0 is a
real 0.** Samples are built from the rows that exist. No zero is ever invented
for a missing row, and no existing zero is dropped.

**A fixed column can be a fake zero.** `si_damage`, `si_kills`, `common_kills`,
`ff_dealt` and `revives` live on `match_players` and default to 0. The
`UPDATE match_players SET ...` at `src/matchResult.ts:24` runs once per player in
the dump, so a player the dump had no row for keeps those defaults. That is the
case `web/src/components/StatTable.tsx` renders as an en dash via `captured`.
The same update is the only writer of `stats_json`, so **`stats_json IS NOT NULL`
is the captured test** for the fixed columns, and it is how their samples are
filtered.

**Two thresholds already exist and are enough.** `RANKED_MIN_GAMES = 3`
(`src/standings.ts:7`) is "enough games for a rating to be worth showing".
`standingMinGames(db)`, default 10, is "enough games for a per-match average to
mean anything", and its doc comment already explains why the two differ. This
plan adds no third threshold: a median is shown at `RANKED_MIN_GAMES`, a
percentile is claimed at `standingMinGames`.

**Rates are already pooled and must stay pooled.** `deriveLiveStats`
(`web/src/format.ts:364`) builds `boomer_rate` from summed `boom_successes` and
`boomer_spawns`, and `StatTable` re-derives it rather than summing it. A median
of per-match boomer rates would weigh a one-boomer night the same as a
four-boomer night, so `boomer_rate` and `winrate` are excluded from every
quantile in this plan and stay pooled ratios.

**Per-map stats come from snapshots, not the dump.** `playerMapBreakdown`
(`src/playerStats.ts:187`) reads `mapStatsFor(db, id)`, the end-of-map snapshot
differences, because the dump only carries match totals. Its per-playing values
are already in hand inside the loop and are currently summed on the spot, which
is the only reason per-map medians are cheap.

## Interpretation decisions

Decided once here so every task agrees.

1. **Quantile formula.** Linear interpolation between order statistics (the R-7
   and numpy default), rounded to one decimal, for p25, p50 and p75 alike. One
   formula, not a median by one rule and hinges by another. One decimal matches
   `perMapAverages`, which already rounds that way.
2. **What "per match" counts.** A sample is one completed match. It is never a
   per-map or per-round figure, so it stays comparable with `games`, with
   `standings.ts`, and with the W/L on the same row.
3. **`avgStats` on the by-map rows is replaced, not joined.** It answers exactly
   the question the median answers better, and carrying both would put two
   numbers behind one "Per map" tab. `MapDetail.avgStats`, the pooled map
   baseline, is a different quantity and is left alone.
4. **A percentile is a rank, not a score.** `pct` is the share of the compared
   field scoring strictly below, so the top player of 20 reads 95, not 100, and
   ties share it. It is only computed over the `standingMinGames` field, which
   is the field `rank` and `of` are already taken against.
5. **Absent beats zero, everywhere, still.** A stat with no samples is omitted
   from the bag rather than returned as a zero median, which is the rule
   `perMapAverages` and `leaderboardData` already follow.

## Tasks

### Task 1: The quantile primitive

- [ ] `src/quantiles.ts`: `export interface Quantiles { n: number; p25: number; p50: number; p75: number }`
      and `export function quantiles(values: number[]): Quantiles | null`, null for
      an empty sample. Pure, no database import.
- [ ] `tests/quantiles.test.ts`: empty sample, single value (all three quantiles
      equal it), even and odd lengths, unsorted input, a sample containing real
      zeros, one decimal of rounding.
- [ ] Commit: `Add a quantile helper for per-match statistics`

### Task 2: Leaderboard defaults to per match

- [ ] `src/playerQueries.ts`: in `leaderboardData`, add a per-match sample query
      beside the two existing aggregate queries. Skill samples: `mps.value` per
      completed season match, grouped by player and stat, no invented zeros.
      Fixed samples: `si_damage` and friends per completed season match
      `WHERE mp.stats_json IS NOT NULL`. Reduce both through `quantiles` into a
      new `medianStats: Record<string, number>` per row, keeping `stats` as is.
      Drop `self` visibility keys on the same rule the summed bag already uses.
- [ ] `web/src/api.ts`: `LeaderboardRow.medianStats?: Record<string, number>`,
      documented as per completed match, absent where nothing was measured.
- [ ] `web/src/routes/Leaderboard.tsx`: a `Tabs` control above the table,
      `'median' | 'total'`, defaulting to `'median'`, matching the
      `MapDetail.tsx` pattern. `valueOf` reads the bag the tab selects, so a
      header and its comparator still cannot disagree. A cell with no sample
      reads `n/a`, as it does today.
- [ ] `web/src/format.ts`: `statLeaders` takes the bag to read, so the cards
      above the table lead on the same measure the table is showing.
- [ ] `src/routes/stats.ts`: `/api/leaderboard/stat/:key` returns `median` beside
      `total` and orders by it, gated at `RANKED_MIN_GAMES`. The
      `visibility === 'public' && direction === 'high_good'` gate is untouched.
- [ ] Tests: `tests/api.test.ts` for the new bag and the route ordering;
      `web/src/routes/routes.test.tsx` for the tab default and switching.
- [ ] Commit: `Rank the leaderboard by per-match medians rather than season totals`

### Task 3: A percentile for every stat on the profile

- [ ] `src/standings.ts`: `Standing` gains `pct: number`. `playerStandings`
      returns an entry for every metric the player has, not only `rank <=
      STANDING_TOP`. `STANDING_TOP` stops filtering the return and becomes the
      UI's badge test only.
- [ ] `web/src/api.ts`: `Standing` gains `pct`, with the doc comment corrected:
      it is no longer top-five only.
- [ ] `web/src/routes/Profile.tsx`: **the `others` list must now filter on
      `sd.rank <= STANDING_TOP`**, or the "Other top five places" row renders
      every metric the player has. This is the one place the wider return can
      regress the page.
- [ ] `web/src/components/PageHeader.tsx`: `Figure` shows the percentile as
      sub-text when there is no top-five badge, so a player at #7 of 23 learns
      something where today they learn nothing.
- [ ] Tests: `tests/standings.test.ts` for ties sharing a percentile, the
      `standingMinGames` field, and a metric outside the top five still being
      returned; a `Profile.tsx` test that the others list is still top five only.
- [ ] Commit: `Report a percentile for every profile stat, not just the top five`

### Task 4: Median and spread in place of the mean

- [ ] `src/playerQueries.ts`: `profileData` gains
      `statQuantiles: Record<string, Quantiles>` over the same two sample sets as
      Task 2, for this player across every completed match.
- [ ] `web/src/routes/Profile.tsx`: `ProfileFigures` tiles show the median as the
      value and `p25 to p75 over n matches` as `sub`, replacing
      `per = n / games`. `winrate` and `boomer_rate` tiles are untouched: they
      are pooled ratios by decision 4 above.
- [ ] `src/playerStats.ts`: `perMapAverages` is replaced by a per-playing sample
      collected in the loop that currently sums, and `MapBreakdownRow.avgStats`
      becomes `medianStats`, one decimal, same absent-not-zero rule.
- [ ] `web/src/routes/Profile.tsx`: the by-map table reads `medianStats` under
      the "Per map" tab. The cell carries the IQR in its `title` rather than in
      the cell, because the table is already twenty-odd numeric columns wide.
- [ ] `MapLeaderRow` and `MapDetail.tsx` get the same treatment last, so the two
      pages do not disagree about what "Per map" means. `MapDetail.avgStats`, the
      pooled baseline, stays a mean.
- [ ] Tests: `tests/playerStats.test.ts` for the per-map medians including a
      never-measured key and a real zero; `web/src/routes/routes.test.tsx` for
      the tile sub-text.
- [ ] Commit: `Show per-match medians and spread instead of means`

## Out of scope, worth doing next

- The leaderboard header figures (`Tank damage`, `Skeets`) are still league-wide
  sums, and will read oddly above a table of medians. Replacing them with the
  league median per match and an SR median and p90 is a small follow-up, but it
  is a fourth surface and is not folded in here.
- A league baseline on the match page ("p92 for this map") needs per-map
  distributions on the wire and is a separate plan.
- Recent form (last 10 matches against the season median) reuses Task 4's
  samples and is the natural next task after it.

## Explicitly not doing

- Confidence intervals and significance tests. The samples are tens of matches,
  and a visible `n` beside every figure carries the same honesty at a fraction of
  the complexity.
- Wilson intervals on win rate. SR already carries its own uncertainty in sigma,
  and `displaySr` already discounts for it.
- Histograms or box plots per row. One IQR in a tooltip is the whole budget.
