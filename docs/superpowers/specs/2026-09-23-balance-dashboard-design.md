# Balance dashboard (piece 3): compare two groups of patches

Date: 2026-09-23. Status: design approved in brainstorming, spec awaiting owner review.

Parent design: `docs/superpowers/specs/2026-09-23-balance-analytics-design.md` (section 3). Pieces 1 (patch tagging) and 2 (metrics engine) are shipped: every round has a `patch_id`, and `round_metrics` / `round_metric_context` hold per-round `num`/`den` rows per metric and phase.

## Goal

An admin page that answers "did this change do anything, and what else moved?" for any two groups of patches, with an honest verdict per metric: real change, probably noise, or too early.

## Decisions from brainstorming

1. **A side is a group of patches** (one or more ticked patches). Default: side B is the latest patch, side A the one before it. Groups keep samples larger without mixing rounds across a change the owner did not choose to include.
2. **Layout:** one page with a **Ranked / By topic** switch. Both views list every metric, including "too early" and "noise", so the owner can scan an area and spot something worth a look. Every row opens a **quick check**.
3. **Statistics are computed on the server on request**, cached per comparison. Not precomputed (would not support patch groups) and not in the browser (payload and duplicated maths).

## 1. Numbers and verdicts

For each metric and phase:

- **Side value.** Pool the side's rounds: `SUM(num) / SUM(den)`.
- **Map mix.** Compute the per-map rate on each side and combine both sides with side A's per-map weights (A's share of that metric's denominator by map). Maps present on only one side are excluded from the adjusted comparison and listed on the row.
- **Change.** Shown as a difference (points for shares, units otherwise) and as a relative change.
- **Range.** Bootstrap by resampling whole matches with replacement, independently per side, 1000 resamples, fixed seed. 95% percentile interval on the difference of map-adjusted values. Two-sided bootstrap p-value.
- **False-alarm control.** Benjamini-Hochberg across all rows of the comparison at a 10% false discovery rate.
- **Verdicts:**
  - **Real change:** passes the correction and each side has at least 10 matches.
  - **Too early:** does not pass, and either side has fewer than 30 matches or the interval is still wide. Shows "about N more matches", estimated from the current effect and its standard error (N capped for display at 500+). No estimate when the observed change is zero.
  - **Probably noise:** does not pass and both sides have 30+ matches.
  - **No data:** a side has no rows for the metric (e.g. per-weapon damage before pug-match 0.3.9). No verdict.
- **Banners:**
  - **Skill check:** shown when the sides differ by more than 1.0 mu in mean team rating level, or in mean survivor-minus-infected rating gap (from `round_metric_context.surv_mu` / `inf_mu`).
  - **Approximate:** shown when a side includes a `historical` patch.
- **Game type filter:** all rated games (default), queue only, in-game started only (`round_metric_context.origin`).

Only rounds of completed, unvoided matches count.

## 2. Page and API

**Location.** A new top-level admin section **Balance** with tabs **Compare** (new) and **Patches** (the existing page, moved from Setup; `/admin/setup/patches` redirects to `/admin/balance/patches`).

**Controls.** Side A and side B multi-selects of patches, newest first, each with its round count. Game type filter. Map filter (default all). The comparison is encoded in the URL so it can be bookmarked or shared.

**Views.**
- Summary chips ("3 real changes, 41 noise, 18 too early") that filter the list when clicked.
- **Ranked:** rows sorted real changes first (largest relative change first), then too early, then noise, then no data.
- **By topic:** the same rows grouped by metric group (tank, witch, hunter, smoker, boomer, special infected, weapons, pace, outcomes), each group headed by its verdict counts.
- Row: metric (plain-English label from the registry description), phase, A value, B value, change with range, verdict.
- **Phase control:** "all phases" (default) shows each metric's whole-round row; the control can add the tank / witch / event / normal rows or restrict to one phase.

**Quick check** (opens inline under the row):
- A and B values with match and round counts, the range, the "about N more matches" estimate, excluded maps, and an "includes older definition" note when a side has rounds whose context engine is not the current one (frozen rounds).
- **Trend:** the metric per match over time with a rolling average and vertical lines at patch boundaries.
- **Per map:** A vs B bars for maps with enough rounds (at least 5 on each side).
- **Example replays:** up to 5 rounds from side B at the extremes of the metric, each linking to the replay viewer.

**Charts** are hand-drawn SVG (no chart library), as the replay viewer already does.

**API** (admin only, `requireAdmin`):
- `GET /api/admin/balance/compare?a=<patchIds>&b=<patchIds>&origin=<all|queue|in_game>&maps=<optional>` returns all rows plus banners and counts.
- `GET /api/admin/balance/metric?metric=<id>&phase=<p>&a=...&b=...&origin=...` returns the quick-check detail (trend series, per-map bars, example rounds).
- Both are cached in memory per exact query and invalidated when the metrics job writes new rounds. The public page (piece 5) will read the same data through an allowlist of metrics.

## 3. Edge cases, performance, testing

- Empty side or identical sides: a plain message instead of a list.
- Voided and aborted matches: always excluded.
- Pub / 1v1 Hunters rounds have their own fingerprint, so they appear only if their patch is ticked.
- Frozen rounds (older metric definitions kept after their replay was pruned) are included, with the note above.
- Compute runs synchronously on the server with a fixed seed so results are reproducible; it is timed and logged when it takes over 2 seconds.
- **Tests:** the statistics (pooling, map reweighting, match bootstrap, Benjamini-Hochberg, matches-needed estimate) are pure functions tested against small hand-worked cases; the API routes get admin and non-admin tests; the page gets render tests for both views and the quick check.
- **Before ship:** run the comparison against a local copy of production (Sky pounce fix vs Saferoom lock) and sanity-check the verdicts by hand.

## Out of scope

Split tests (the `variant` column stays unused), the balance control panel (piece 4) and the public page (piece 5).
