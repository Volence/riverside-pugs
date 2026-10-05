# Tournaments plan T2: brackets, Swiss, leagues and standings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An event whose entry list is final goes live at its start time (or when an admin presses Start). Its first stage is built from the seeds: an elimination bracket (single or double), round robin groups, Swiss rounds or league rounds. Admins enter each match result on the Events desk (winner and campaign scores, or a forfeit). The bracket advances, the next Swiss round pairs itself, the stage finishes, the top teams carry over to the next stage, and the event finishes with placements. The public event page shows the live bracket or standings. Admins can run a whole tournament by hand this way before rollout plan 3 automates the match flow.

**Architecture:** There are three pure modules. `standings.ts` ranks a table stage with the spec's tiebreakers. `swiss.ts` pairs a Swiss round. `roundRobin.ts` draws a circle schedule. `bracket.ts` wraps brackets-manager.js over its in-memory store: a stage's whole bracket lives as one JSON value in `event_stages.bracket_json`, so the library runs fully in memory and the result is written in the same synchronous better-sqlite3 transaction as everything else. A new writer, `play.ts`, owns the new `event_matches` table and the event's moves to `live` and `finished`; like `events.ts` and `entries.ts`, each mutation is one transaction with exactly one `event_log` row. An async orchestrator, `flow.ts`, does the library calls, then hands their output to `play.ts`; it runs one event at a time through a per-event promise chain. The existing `EventRunner` minute tick starts due events and settles live ones. A view module feeds the public page and the desk. The web gets a bracket, standings and rounds on the event page and a Play section on the desk.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. New runtime dependencies: `brackets-manager` 1.11.1 (MIT) and `brackets-memory-db` 1.0.6 (ISC), pinned exactly.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md`, section 3 (Pairing and brackets), section 4 (the `event_matches` table, Result, No-show and forfeit as it applies to a disqualified entry), section 6 (desk: force a result, disqualify), section 7 (event page: standings and brackets), Error handling, Testing, Rollout item 2. T1a and T1b (`docs/superpowers/plans/2026-10-01-tournaments-1a-events.md`, `docs/superpowers/plans/2026-10-05-tournaments-1b-registration.md`) built the events, stages, entries and the desk this plan extends. Read their "Rulings" sections first.

## Global Constraints

- Team events only (`entry_kind = 'team'`). Draft events never reach `live` in T2.
- Results are entered by admins (mods read only) until rollout plan 3. A result is a winner plus both campaign scores with the winner strictly ahead, or a forfeit with no scores. There are no draws (spec section 3: ties are replayed).
- Swiss (spec section 3): win 1 point, loss 0. Round 1 pairs the top half of seeds against the bottom half (1 v N/2+1). Later rounds pair by points from the top, never repeating an opponent while any repeat-free pairing exists. With an odd count, the bye (a win) goes to the lowest-ranked entry without one. Standings order: points, Buchholz (median Buchholz from 5 rounds up), campaign score difference, head-to-head, seed.
- League (spec section 3, reshaped by the owner 2026-10-05): a season is a number of rounds, one result per team per round (`matches`, 1 to 40, picked per event), at 1 to 3 a week from an optional season start date. Pairing is Swiss by record or a repeating round robin (the stage's `pairing`). With an odd number of teams, one team a round gets a bye, which counts as a win as in Swiss (and as on FACEIT). League standings order: wins, head-to-head, campaign score difference, Buchholz, seed.
- Round robin stages use the order wins, head-to-head, campaign score difference, Buchholz, seed inside each group.
- Elimination and round robin structure come from brackets-manager.js. Swiss and league are in-house pure modules.
- Every write to `events`, `event_stages`, `event_log`, `event_entries` and the new `event_matches` is in `src/events/events.ts`, `src/events/entries.ts` or `src/events/play.ts`, plus the account merge's own lines in `src/mergePlayers.ts`. Only `play.ts` writes `event_matches`. Every mutation in those files is one transaction that writes exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`). Admin routes also `logAdmin`.
- Public routes follow `competitive_enabled` exactly as T1a's do. A draft is a 404 to anyone but staff.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch (`tournaments-t2`, made with superpowers:using-git-worktrees). Run `npm ci` inside the worktree (never symlink `node_modules`; see the deploy note in memory). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Admins enter results by hand in T2.** The desk takes the winner and both campaign scores, or a forfeit. Rollout plan 3 replaces this with results from our servers, vetoes and lineups. Until then an admin can run a real event: book the games, then enter the scores.
2. **An elimination bracket is always the last stage.** "Top N of a bracket advance" is not supported. Groups, Swiss or a league feed a final bracket. Publishing refuses any other order with `elim_not_last`.
3. **Round robin groups split the advance count evenly.** With 2 groups and "top 4 advance", the top 2 of each group go through. The next stage is seeded group winners first, then runners-up, and so on. Within a band the order is wins, then campaign score difference, then the earlier seed. A stage whose advance count does not divide by its groups is refused with `bad_group_advance`.
4. **Each stage is seeded by the rank in the stage before it.** Stage 1 uses the event seeds (T1b: SR, reordered by staff).
5. **The clock starts the event.** At `starts_at`, an event whose entry list is final and that has at least 2 active entries goes `live` by itself. With check-in off, the list is finalised in the same minute and the event starts on that tick. An admin may press Start earlier once the list is final. With fewer than 2 entries the event waits; staff cancel it.
6. **Everything after the start moves by itself.** A Swiss or Swiss-paired league round pairs once every match of the round before has a result. A stage finishes once every match has one, and the next stage starts at once. Proposing and enforcing match times is rollout plan 4, so in T2 a league's weeks are labels with dates: a match can be played any time and an admin enters it.
7. **A league season is a match count, not a length (owner, 2026-10-05).** The organizer picks matches per team (the FACEIT Overwatch league uses 16), matches a week, and optionally the season start date. The season is `matches` rounds whatever the team count, and `weeks = ceil(matches / matchesPerWeek)`. Round robin pairing repeats the full round robin, sides swapped each cycle, until the rounds are used up, so opponents come as evenly as the count allows. Swiss pairing pairs by record and never repeats while a fresh opponent is left.
18. **League byes count as wins (owner, 2026-10-05, as FACEIT does).** With an odd number of teams, one team sits out each round and is given the win. Every team ends the season with exactly `matches` results, played or bye. Byes rotate (fewest byes first, as in Swiss). When `matches` is not a multiple of the team count, some teams get one bye more than others, which is worth about half a win on average. The calculator says so, so the organizer can pick a count that splits evenly.
19. **Season dates.** Week 1 starts on the season start date, or on the day the stage starts if none is set. Each week is 7 days, and the event page shows each week's dates next to its label ("Week 3 · Oct 26 to Nov 1"); they are calendar days, shown as written, not shifted by time zone. In T2 the dates are information only; rollout plan 4 turns them into windows with a deadline.
20. **A season calculator in the stage editor.** It works both ways. Matches per team plus matches a week gives the number of weeks and, with a start date, the end date. A start and an end date give the matches a week needed, and it says so when even 3 a week does not fit. Given an expected team count (default the team cap), it also gives the byes per team: "7 teams: 2 or 3 byes each; 14 or 21 matches gives everyone the same". It writes only the stage's own fields (matches, matches a week, start date); nothing is stored that it computed.
8. **Corrections.** An admin may change a result while its stage is live and nothing depends on it yet: in a bracket, the next match is not yet played (brackets-manager refuses otherwise); in Swiss or a league, the next round is not yet paired. Otherwise the answer is `result_locked`. Replays and deeper repairs are rollout plan 3 desk tools.
9. **A team disqualified mid-event forfeits its open matches.** On the next settle, the engine records each open match as a forfeit win for the opponent (`result_source = 'forfeit'`, actor null). A match where both sides are out stays open for staff. Past results stand. A disqualified team never advances, gets no placement, and is listed last in standings. Pairings skip it.
10. **Byes.** A Swiss bye is a win: 1 point, 0 Buchholz, 0 score difference. It goes to the lowest-ranked entry with the fewest byes. In brackets, the field is padded to a power of two and the padding byes go to the top seeds, as standard.
11. **Rematches in Swiss** happen only when no repeat-free pairing of the round exists (for example, 4 teams playing 5 rounds).
12. **Forfeits and byes add 0** to campaign score difference.
13. **Placements.** The last stage ranks its entries: an elimination bracket by brackets-manager's final standings, which share places (without a third-place match, both semifinal losers are 3rd), and a table stage by its standings. Those entries become `placed`. Teams knocked out at an earlier stage become `eliminated`, placed below every team that advanced, in that stage's rank order.
14. **If fewer than 2 entries advance** (after disqualifications), the event finishes at that stage. Later stages stay `pending`.
15. **Two deviations from the spec's tooling.** (a) The bracket's state is stored as one JSON value per stage (`event_stages.bracket_json`) rather than in `bm_*` tables. The library runs in memory, and the result goes into the same synchronous transaction as the match row and the audit row; an async SQLite storage adapter could not join that transaction. (b) The bracket is drawn by our own Preact component (one column per round, no connector lines in v1) rather than brackets-viewer.js. That library is imperative DOM code with i18next and would fight the poster look.
16. **No DMs or Discord posts in T2.** Round pairings and result posts belong to rollout plan 5. While an event is live, the event page refetches once a minute (websocket push later).
17. **Mods read the desk's Play section.** Only admins start an event or enter a result, the same split as T1a.

## Not in this plan (and why)

- Veto room, lineups, bookings per match, connect, automatic results, disputes, `!sub`, `!admin`, replays of a chapter: rollout plan 3.
- Match times, windows, reschedules and `not_before`: rollout plan 4. The columns are created now, empty.
- Discord pairings and results, trophies, `event_awards`, prizes: rollout plan 5.
- Roster lock `after_round`: rollout plan 3 counts rounds for it (T1b Ruling 6 still holds).
- Rebuilding a Swiss round, editing a bracket, moving a match to another server: rollout plan 3 desk tools.

## Review Focus

- **Two admins saving a result for one match at the same moment, or an admin and the tick's forfeit.** The per-event chain runs them one after the other. The second one is a correction, or is refused, and the bracket never takes both. `bracket_rev` refuses a write built on an older bracket (`changed`). Task 6 tests both orders.
- **Double elimination grand final.** If the upper bracket winner wins the first grand final, there is no reset match: none is shown, and the stage finishes. If the lower bracket side wins, the reset appears as a match to play. Task 4 tests both at the library layer and Task 6 through the flow.
- **Odd counts and disqualifications in Swiss.** The bye rotates and never goes twice to one team while another has none. A disqualified team is never paired again, and its open match is a forfeit win for the opponent. Tasks 3 and 6 test.
- **A restart in the middle of an event.** Everything lives in the database. The first tick after a restart starts a due event or settles a live one, and a second settle changes nothing. Task 7 tests that `play()` twice is a no-op the second time.
- **A correction after a later match has been played.** It is refused with a sentence and writes nothing. Task 4 tests the library refusal and Task 6 the flow result and the untouched rows.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json` | `brackets-manager` 1.11.1, `brackets-memory-db` 1.0.6. |
| `src/db.ts` | `event_matches` table; `event_stages.entrants_json`, `bracket_json`, `bracket_rev`, `started_at`, `finished_at`; `events.live_at`. |
| `src/events/validate.ts` | New error codes, `parseResult`, `ResultInput`, `registration/checkin -> live -> finished`, elimination-last chain rule, even group advance, league config as matches per team and a season start. |
| `src/events/events.ts` | Row types gain the new columns; `chainOf` passes stage types; `stageSettingsOf` reads T1a league rows (weeks) as matches. |
| `src/events/standings.ts` | Pure: rank a table stage. |
| `src/events/swiss.ts` | Pure: pair a Swiss round. |
| `src/events/roundRobin.ts` | Pure: circle schedule. |
| `src/events/league.ts` | Pure: the league season (repeating round robin, weeks, week dates, matches a week between dates, byes); shared with the web editor. |
| `src/events/bracket.ts` | brackets-manager over the in-memory store: create, report, read matches, completeness, ranks, groups. |
| `src/events/play.ts` | Writer for `event_matches`, the stage moves and the event's `live`/`finished`. |
| `src/events/flow.ts` | Async orchestration: plan a stage, start an event, record a result, settle. Per-event chain. |
| `src/events/runner.ts` | `play(now)`: start due events, settle live ones. |
| `src/events/format.ts` | `roundLabel`. |
| `src/events/playViews.ts` | Stage views for the page and the desk. |
| `src/events/views.ts` | `EventView.play`, entry `placement`. |
| `src/routes/events.ts` | Nothing new (the event view carries `play`). |
| `src/routes/adminEvents.ts` | `GET /play`, `POST /start`, `POST /matches/:matchId/result`; settle after a live disqualification. |
| `tests/eventLogGuard.test.ts` | Widened to `play.ts` and `event_matches`. |
| `tests/playFixture.ts` | A published event with a final entry list of N entries. |
| `web/src/api.ts` | Play types, `EventView.play`, entry placement, desk calls. |
| `web/src/eventFormat.ts` | `placementText`, `weekRangeText`. |
| `web/src/routes/event/StagePlay.tsx`, `Bracket.tsx` | Bracket, standings, rounds. |
| `web/src/routes/Event.tsx` | Mounts the stage panels; refetches while live; placement marks. |
| `web/src/routes/admin/events/PlayPanel.tsx` | Start, the matches, result forms. |
| `web/src/routes/admin/events/EventEditor.tsx` | Mounts `PlayPanel`; passes the team cap to `StageForm`. |
| `web/src/routes/admin/events/StageForm.tsx`, `stageDraft.ts`, `SeasonCalc.tsx` | League fields (matches per team, matches a week, season start, pairing) and the season calculator. |
| `web/src/styles/app.css` | `.bracket*`, `.playtable`, `.playround*`. |

---

### Task 1: Library, schema and validation

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/db.ts` (event SQL block after `event_log`, and the `ensureColumn` block after the T1b lines near line 1737)
- Modify: `src/events/validate.ts`
- Modify: `src/events/events.ts` (`EventRow`, `StageRow`, `chainOf`)
- Test: `tests/eventsSchema.test.ts`, `tests/eventsValidate.test.ts`

**Interfaces:**
- Produces: table `event_matches`; columns `event_stages.entrants_json TEXT`, `bracket_json TEXT`, `bracket_rev INTEGER NOT NULL DEFAULT 0`, `started_at TEXT`, `finished_at TEXT`, `events.live_at TEXT`.
- Produces in `validate.ts`: `interface ResultInput { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean }`; `parseResult(raw: unknown): Checked<ResultInput>`; `SCORE_MAX = 100000`; error keys `list_not_final`, `too_few_entries`, `not_live`, `match_not_found`, `match_not_open`, `bad_result`, `result_locked`, `changed`, `elim_not_last`, `bad_group_advance`; `nextStatusAllowed` adds `registration -> live`, `checkin -> live`, `live -> finished`; `checkChain(stages: { type?: StageType; advanceCount: number | null }[], o)`; `StageConfigs['league']` becomes `{ matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null }` (`matches` 1 to 40, default 16; `seasonStart` a `YYYY-MM-DD` date or null); `LEAGUE_MATCHES_MAX = 40`.
- Produces in `events.ts`: `stageSettingsOf` reads a league stage stored in the T1a shape (`weeks`, no `matches`) as `matches = weeks x matchesPerWeek`, `seasonStart: null`, so nothing else ever sees `weeks`.
- Produces in `events.ts`: `EventRow.live_at: string | null`; `StageRow` gains `entrants_json: string | null; bracket_json: string | null; bracket_rev: number; started_at: string | null; finished_at: string | null`.

- [ ] **Step 1: Add the dependencies**

Run in the worktree:

```bash
npm install --save-exact brackets-manager@1.11.1 brackets-memory-db@1.0.6
```

Expected: both appear under `dependencies` in `package.json` with exact versions, and `package-lock.json` changes.

- [ ] **Step 2: Write the failing schema test**

Append to `tests/eventsSchema.test.ts` (inside its top-level `describe`, using its existing `openDb` import):

```ts
  it('has event_matches with every match-flow status and the stage bracket columns (plan T2)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('event_matches')).toEqual([
      'id', 'event_id', 'stage_id', 'grp', 'round', 'slot', 'bm_match_id', 'entry_a', 'entry_b', 'status', 'best_of',
      'not_before', 'scheduled_at', 'window_start', 'window_end', 'booking_id', 'winner_entry', 'score_a', 'score_b',
      'result_source', 'created_at', 'finished_at',
    ]);
    expect(cols('event_stages')).toEqual(expect.arrayContaining(['entrants_json', 'bracket_json', 'bracket_rev', 'started_at', 'finished_at']));
    expect(cols('events')).toContain('live_at');
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'event_matches'").get() as { sql: string }).sql;
    for (const s of ['pending', 'waiting', 'veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'done', 'forfeit', 'bye', 'admin_hold']) {
      expect(sql).toContain(`'${s}'`);
    }
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_matches'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['event_matches_slot', 'event_matches_bm']));
  });
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/eventsSchema.test.ts`
Expected: FAIL (`event_matches` has no columns).

- [ ] **Step 4: Add the table and columns**

In `src/db.ts`, right after the `CREATE INDEX IF NOT EXISTS event_log_event ...;` line, add:

```sql
-- Tournament matches (spec part 2 section 4; plan T2). One row per pairing of
-- a stage. Swiss and league rows are written by src/events/play.ts from
-- src/events/swiss.ts and roundRobin.ts. Elimination and round robin rows
-- mirror the stage's brackets-manager data (event_stages.bracket_json) by
-- bm_match_id. grp is 1 for Swiss and league, and the brackets-manager group
-- number otherwise: single elimination 1 main and 2 third place; double
-- elimination 1 upper, 2 lower, 3 grand final; round robin one per group.
-- The status CHECK holds every state of the match flow (rollout plan 3) now,
-- because widening it means rebuilding the table. T2 uses pending, waiting,
-- done, forfeit and bye. Only src/events/play.ts writes this table.
CREATE TABLE IF NOT EXISTS event_matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  stage_id      INTEGER NOT NULL REFERENCES event_stages(id),
  grp           INTEGER NOT NULL DEFAULT 1,
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  bm_match_id   INTEGER,
  entry_a       INTEGER REFERENCES event_entries(id),
  entry_b       INTEGER REFERENCES event_entries(id),
  status        TEXT NOT NULL
                CHECK (status IN ('pending','waiting','veto','lineup','booking','connect','live','confirming','done','forfeit','bye','admin_hold')),
  best_of       INTEGER NOT NULL DEFAULT 1,
  not_before    TEXT,
  scheduled_at  TEXT,
  window_start  TEXT,
  window_end    TEXT,
  booking_id    INTEGER REFERENCES bookings(id),
  winner_entry  INTEGER REFERENCES event_entries(id),
  score_a       INTEGER,
  score_b       INTEGER,
  result_source TEXT CHECK (result_source IN ('auto','admin','forfeit')),
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS event_matches_slot ON event_matches (stage_id, grp, round, slot);
CREATE UNIQUE INDEX IF NOT EXISTS event_matches_bm ON event_matches (stage_id, bm_match_id) WHERE bm_match_id IS NOT NULL;
```

After the T1b `ensureColumn(db, 'event_entries', 'additions', ...)` line, add:

```ts
  // Tournaments plan T2. A stage's entrants in its own seed order (set when
  // it starts), its brackets-manager data as one JSON value with a revision
  // that refuses a write built on an older copy, and when it started and
  // finished. live_at: when the event went live.
  ensureColumn(db, 'event_stages', 'entrants_json', 'TEXT');
  ensureColumn(db, 'event_stages', 'bracket_json', 'TEXT');
  ensureColumn(db, 'event_stages', 'bracket_rev', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'event_stages', 'started_at', 'TEXT');
  ensureColumn(db, 'event_stages', 'finished_at', 'TEXT');
  ensureColumn(db, 'events', 'live_at', 'TEXT');
```

In `src/events/events.ts`, add `live_at: string | null;` to `EventRow` (after `locked_at`), and to `StageRow` add after `status`:

```ts
  entrants_json: string | null; bracket_json: string | null; bracket_rev: number; started_at: string | null; finished_at: string | null;
```

- [ ] **Step 5: Run the schema test**

Run: `npx vitest run tests/eventsSchema.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing validation tests**

Append to `tests/eventsValidate.test.ts` (it already imports `* as V` from `../src/events/validate.js`; add the import if it is named differently):

```ts
describe('plan T2 rules', () => {
  const roster = V.defaultRoster();
  it('refuses an elimination bracket anywhere but last', () => {
    expect(V.checkChain([{ type: 'single_elim', advanceCount: 4 }, { type: 'swiss', advanceCount: null }], { teamCap: null, roster }))
      .toEqual({ ok: false, error: 'elim_not_last' });
    expect(V.checkChain([{ type: 'double_elim', advanceCount: 4 }, { type: 'single_elim', advanceCount: null }], { teamCap: null, roster }))
      .toEqual({ ok: false, error: 'elim_not_last' });
    expect(V.checkChain([{ type: 'swiss', advanceCount: 8 }, { type: 'double_elim', advanceCount: null }], { teamCap: null, roster }).ok).toBe(true);
    // Callers that pass no type (older call sites) are unchanged.
    expect(V.checkChain([{ advanceCount: 8 }, { advanceCount: null }], { teamCap: null, roster }).ok).toBe(true);
  });

  it('allows live from registration or checkin, and finished from live only', () => {
    expect(V.nextStatusAllowed('registration', 'live')).toBe(true);
    expect(V.nextStatusAllowed('checkin', 'live')).toBe(true);
    expect(V.nextStatusAllowed('live', 'finished')).toBe(true);
    expect(V.nextStatusAllowed('announced', 'live')).toBe(false);
    expect(V.nextStatusAllowed('checkin', 'finished')).toBe(false);
  });

  it('parses a result: winner ahead on scores, or a forfeit without scores', () => {
    expect(V.parseResult({ winner: 'a', scoreA: 1200, scoreB: 900 })).toEqual({ ok: true, value: { winner: 'a', scoreA: 1200, scoreB: 900, forfeit: false } });
    expect(V.parseResult({ winner: 'b', forfeit: true })).toEqual({ ok: true, value: { winner: 'b', scoreA: null, scoreB: null, forfeit: true } });
    expect(V.parseResult({ winner: 'b', forfeit: true, scoreA: 5, scoreB: 1 })).toEqual({ ok: true, value: { winner: 'b', scoreA: null, scoreB: null, forfeit: true } });
    for (const bad of [
      null, {}, { winner: 'c', scoreA: 1, scoreB: 0 }, { winner: 'a', scoreA: 900, scoreB: 900 }, { winner: 'a', scoreA: 800, scoreB: 900 },
      { winner: 'a', scoreA: -1, scoreB: -2 }, { winner: 'a', scoreA: 1.5, scoreB: 0 }, { winner: 'a', scoreA: V.SCORE_MAX + 1, scoreB: 0 },
      { winner: 'a', scoreA: '10', scoreB: 0 }, { winner: 'a', forfeit: 'yes' },
    ]) {
      expect(V.parseResult(bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'bad_result' });
    }
  });
});
```

Add to the `parseStage` tests in the same file (reuse that file's existing context helper for `StageContext`; it is the value the other `parseStage` tests pass):

```ts
  it('refuses a group advance count that does not split evenly (plan T2)', () => {
    const base = { type: 'round_robin', rulesetId: CUP, campaignPool: ['no_mercy'], advanceCount: 6, config: { groups: 4 } };
    expect(V.parseStage(base, ctx)).toEqual({ ok: false, error: 'bad_group_advance' });
    expect(V.parseStage({ ...base, advanceCount: 8 }, ctx).ok).toBe(true);
    expect(V.parseStage({ ...base, advanceCount: null }, ctx).ok).toBe(true);
  });
```

(If that file names its context `context` or its Standard Cup ruleset id differently, use its names; do not add a second context helper.)

Replace the existing league default test line (`expect(V.parseStageConfig('league', {})).toEqual({ ok: true, value: { weeks: 6, ... } })`) and add league cases:

```ts
  it('a league season is a match count, matches a week, a pairing and an optional start date (plan T2)', () => {
    expect(V.parseStageConfig('league', {})).toEqual({ ok: true, value: { matches: 16, matchesPerWeek: 1, pairing: 'swiss', seasonStart: null } });
    expect(V.parseStageConfig('league', { matches: 14, matchesPerWeek: 2, pairing: 'round_robin', seasonStart: '2026-10-12' }))
      .toEqual({ ok: true, value: { matches: 14, matchesPerWeek: 2, pairing: 'round_robin', seasonStart: '2026-10-12' } });
    for (const bad of [{ matches: 0 }, { matches: V.LEAGUE_MATCHES_MAX + 1 }, { matchesPerWeek: 4 }, { seasonStart: '2026-13-01' },
      { seasonStart: '12/10/2026' }, { seasonStart: '2026-02-30' }, { seasonStart: 5 }]) {
      expect(V.parseStageConfig('league', bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'bad_stage_config' });
    }
  });
```

And in `tests/events.test.ts`, add:

```ts
  it('reads a league stage stored with weeks as matches = weeks x matches a week (plan T2)', () => {
    const f = eventFixture('draft');
    f.db.prepare("UPDATE event_stages SET type = 'league', config_json = ? WHERE id = ?")
      .run(JSON.stringify({ weeks: 6, matchesPerWeek: 2, pairing: 'swiss' }), f.s1);
    expect(E.stageSettingsOf(E.getStage(f.db, f.s1)!).config).toEqual({ matches: 12, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null });
  });
```

In `tests/eventFormat.test.ts`, change the league `stageSummary` case to:

```ts
    expect(stageSummary('league', { matches: 16, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null }, 4)).toBe('League, 16 matches, 2 a week, top 4 advance');
```

- [ ] **Step 7: Run them to make sure they fail**

Run: `npx vitest run tests/eventsValidate.test.ts`
Expected: FAIL (`parseResult` is not a function; `elim_not_last` not returned).

- [ ] **Step 8: Implement the validation changes**

In `src/events/validate.ts`, add to `EVENT_ERRORS` (before the closing `} as const`):

```ts
  list_not_final: { status: 409, text: 'The entry list is not final yet.' },
  too_few_entries: { status: 409, text: 'A stage needs at least 2 teams to start.' },
  not_live: { status: 409, text: 'That stage is not being played.' },
  match_not_found: { status: 404, text: 'No such match in this event.' },
  match_not_open: { status: 409, text: 'That match does not have two teams to report on yet.' },
  bad_result: { status: 400, text: 'A result names the winner and gives both campaign scores with the winner ahead, or is a forfeit.' },
  result_locked: { status: 409, text: 'Later matches already depend on this result, so it can no longer be changed here.' },
  changed: { status: 409, text: 'The event changed while this was being saved. Reload and try again.' },
  elim_not_last: { status: 400, text: 'An elimination bracket is always the last stage.' },
  bad_group_advance: { status: 400, text: 'With groups, the advance count has to split evenly across the groups.' },
```

Below `EventFields`, add:

```ts
export const SCORE_MAX = 100000;
/** A match result as an admin enters it (plan T2 Ruling 1). */
export interface ResultInput { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean }

/** Winner a or b. A forfeit carries no scores (any sent are dropped);
 *  otherwise both scores are integers 0..SCORE_MAX with the winner strictly
 *  ahead, as ties are replayed (spec section 3). */
export function parseResult(raw: unknown): Checked<ResultInput> {
  if (!isObj(raw) || (raw.winner !== 'a' && raw.winner !== 'b')) return fail('bad_result');
  const forfeit = raw.forfeit ?? false;
  if (typeof forfeit !== 'boolean') return fail('bad_result');
  if (forfeit) return ok({ winner: raw.winner, scoreA: null, scoreB: null, forfeit: true });
  if (!isInt(raw.scoreA, 0, SCORE_MAX) || !isInt(raw.scoreB, 0, SCORE_MAX)) return fail('bad_result');
  const ahead = raw.winner === 'a' ? raw.scoreA > raw.scoreB : raw.scoreB > raw.scoreA;
  return ahead ? ok({ winner: raw.winner, scoreA: raw.scoreA, scoreB: raw.scoreB, forfeit: false }) : fail('bad_result');
}
```

In `parseStage`, after `if (advanceCount === undefined) return fail('bad_advance');` add:

```ts
  if (type === 'round_robin' && advanceCount !== null && advanceCount % (config.value as StageConfigs['round_robin']).groups !== 0) {
    return fail('bad_group_advance');
  }
```

Change `checkChain`'s signature and loop head:

```ts
export function checkChain(stages: { type?: StageType; advanceCount: number | null }[], o: { teamCap: number | null; roster: RosterRules }): Checked<null> {
  if (stages.length === 0) return fail('no_stages');
  for (let i = 0; i < stages.length; i++) {
    const t = stages[i].type;
    if (i < stages.length - 1 && (t === 'single_elim' || t === 'double_elim')) return fail('elim_not_last');
    const a = stages[i].advanceCount;
```

(the rest of the loop is unchanged). Change `nextStatusAllowed`:

```ts
export function nextStatusAllowed(from: EventStatus, to: EventStatus): boolean {
  if (to === 'cancelled') return CANCELLABLE.has(from);
  return (from === 'draft' && to === 'announced') || (from === 'announced' && to === 'registration')
    || (from === 'registration' && to === 'checkin')
    || ((from === 'registration' || from === 'checkin') && to === 'live')
    || (from === 'live' && to === 'finished');
}
```

Change the league config (owner, 2026-10-05: a season is a match count). In `StageConfigs`:

```ts
  league: { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null };
```

Add `export const LEAGUE_MATCHES_MAX = 40;` next to `POOL_MAX`, and replace the `league` case of `parseStageConfig`:

```ts
    case 'league': {
      const matches = c.matches ?? 16;
      const matchesPerWeek = c.matchesPerWeek ?? 1;
      const pairing = c.pairing ?? 'swiss';
      const seasonStart = c.seasonStart ?? null;
      return isInt(matches, 1, LEAGUE_MATCHES_MAX) && isInt(matchesPerWeek, 1, 3) && oneOf(['swiss', 'round_robin'] as const, pairing)
        && (seasonStart === null || isDay(seasonStart))
        ? ok({ matches, matchesPerWeek, pairing, seasonStart: seasonStart as string | null })
        : fail('bad_stage_config');
    }
```

with, above `parseStageConfig`:

```ts
/** A real calendar day written YYYY-MM-DD. Day 30 of February parses but
 *  rolls over to March, so the round trip refuses it; month 13 does not
 *  parse at all. Never throws. */
function isDay(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
```

In `src/events/format.ts` `stageSummary`, the league line becomes:

```ts
  if (type === 'league') parts.push(`${c.matches} matches`, `${c.matchesPerWeek} a week`);
```

In `src/events/events.ts` `stageSettingsOf`, read old league rows in the new shape:

```ts
export function stageSettingsOf(s: StageRow): V.StageSettings {
  let config = JSON.parse(s.config_json) as V.StageConfig;
  if (s.type === 'league') {
    // T1a stored weeks; plan T2 counts matches (owner, 2026-10-05).
    const c = config as Partial<V.StageConfigs['league']> & { weeks?: number };
    config = {
      matches: c.matches ?? (c.weeks !== undefined ? c.weeks * (c.matchesPerWeek ?? 1) : 16), matchesPerWeek: c.matchesPerWeek ?? 1,
      pairing: c.pairing ?? 'swiss', seasonStart: c.seasonStart ?? null,
    };
  }
  return {
    type: s.type, config, rulesetId: s.ruleset_id, gameConfig: s.game_config,
    campaignPool: JSON.parse(s.campaign_pool_json) as string[], vetoType: s.veto_type, chapters: s.chapters,
    scheduling: s.scheduling, advanceCount: s.advance_count,
  };
}
```

In `src/events/events.ts` `chainOf`, pass the type:

```ts
  return V.checkChain(stagesOf(db, ev.id).map((s) => ({ type: s.type, advanceCount: s.advance_count })), { teamCap: f.teamCap, roster: f.roster });
```

- [ ] **Step 9: Run the tests, the event suites and typecheck**

Run: `npx vitest run tests/eventsValidate.test.ts tests/eventsSchema.test.ts tests/events.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS. If an existing `events.test.ts` case builds an elimination stage before another stage, it now fails with `elim_not_last`. Change that fixture so the bracket is last; never relax the rule.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/db.ts src/events/validate.ts src/events/events.ts src/events/format.ts tests/eventsSchema.test.ts tests/eventsValidate.test.ts tests/events.test.ts tests/eventFormat.test.ts
git commit -m "Tournaments T2: brackets-manager, the event_matches table, stage bracket columns, result parsing, elimination-last and even group advance rules"
```

---

### Task 2: Standings

**Files:**
- Create: `src/events/standings.ts`
- Test: `tests/standings.test.ts`

**Interfaces:**
- Produces:
  - `type TableKind = 'swiss' | 'league' | 'round_robin'`
  - `interface TableResult { a: number; b: number | null; winner: number; scoreA: number | null; scoreB: number | null }`, where `b` null is a bye for `a`.
  - `interface TableEntry { id: number; seed: number; out: boolean }`, where `seed` is the stage seed, 1 at the top, unique.
  - `interface StandingRow { entryId: number; rank: number; played: number; wins: number; losses: number; byes: number; points: number; buchholz: number; scoreDiff: number; out: boolean }`
  - `standings(kind: TableKind, entries: TableEntry[], results: TableResult[], o: { rounds: number }): StandingRow[]`, in rank order, ranks 1..n unique, `out` entries after all others. Results that name an entry not in `entries` are ignored for that side.

- [ ] **Step 1: Write the failing tests**

Create `tests/standings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { standings, type TableEntry, type TableResult } from '../src/events/standings.js';

const ents = (n: number, out: number[] = []): TableEntry[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, seed: i + 1, out: out.includes(i + 1) }));
const win = (w: number, l: number, sw: number | null = null, sl: number | null = null): TableResult => ({ a: w, b: l, winner: w, scoreA: sw, scoreB: sl });
const bye = (id: number): TableResult => ({ a: id, b: null, winner: id, scoreA: null, scoreB: null });
const order = (rows: { entryId: number }[]) => rows.map((r) => r.entryId);

describe('standings', () => {
  it('counts wins, losses, byes, points and score difference; forfeits and byes add no score', () => {
    const rows = standings('swiss', ents(3), [win(1, 2, 1000, 800), bye(3), win(3, 1, null, null)], { rounds: 2 });
    const r = Object.fromEntries(rows.map((x) => [x.entryId, x]));
    expect(r[1]).toMatchObject({ played: 2, wins: 1, losses: 1, byes: 0, points: 1, scoreDiff: 200 });
    expect(r[2]).toMatchObject({ played: 1, wins: 0, losses: 1, points: 0, scoreDiff: -200 });
    expect(r[3]).toMatchObject({ played: 1, wins: 2, byes: 1, points: 2, scoreDiff: 0 });
    expect(rows.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('Swiss: points, then Buchholz (byes add 0), then score difference, then head-to-head, then seed', () => {
    // 1 and 2 both on 1 point. 1 beat 3 (who has 1 point), 2 beat 4 (who has 0): Buchholz puts 1 first.
    const r1 = standings('swiss', ents(4), [win(1, 3, 10, 5), win(2, 4, 50, 0), win(3, 2, 10, 9), win(4, 1, 10, 9)], { rounds: 2 });
    expect(order(r1).slice(0, 2)).toEqual([1, 2]);
    // Equal Buchholz, so score difference decides.
    const r2 = standings('swiss', ents(4), [win(1, 3, 10, 9), win(2, 4, 50, 0)], { rounds: 1 });
    expect(order(r2)).toEqual([2, 1, 3, 4]);
    // Equal down to score difference (forfeits), so head-to-head decides: 4 beat 3.
    const r3 = standings('swiss', ents(4), [win(4, 3)], { rounds: 1 });
    expect(order(r3).slice(0, 1)).toEqual([4]);
    // Nothing separates them: seed.
    expect(order(standings('swiss', ents(3), [], { rounds: 1 }))).toEqual([1, 2, 3]);
  });

  it('Swiss median Buchholz from 5 rounds drops the best and worst opponent', () => {
    const results = [win(1, 2), win(1, 3), win(1, 4), win(1, 5), win(1, 6), win(2, 3), win(2, 4), win(2, 5)];
    const at4 = standings('swiss', ents(6), results, { rounds: 4 }).find((x) => x.entryId === 1)!;
    const at5 = standings('swiss', ents(6), results, { rounds: 5 }).find((x) => x.entryId === 1)!;
    // Opponents' points: 2 has 3, 3 has 0, 4 has 0, 5 has 0, 6 has 0.
    expect(at4.buchholz).toBe(3);
    expect(at5.buchholz).toBe(0);
  });

  it('league and round robin: wins, then head-to-head among the tied teams, then score difference', () => {
    // 1, 2, 3 each 1 win in a cycle; h2h among the three is 1-1-1, so score difference decides.
    const cycle = [win(1, 2, 10, 0), win(2, 3, 30, 0), win(3, 1, 5, 0)];
    expect(order(standings('league', ents(3), cycle, { rounds: 2 }))).toEqual([2, 1, 3]);
    // Two tied on wins, the one who won their meeting is first despite worse score difference.
    expect(order(standings('round_robin', ents(3), [win(2, 1, 1, 0), win(1, 3, 100, 0), win(3, 2, 1, 0)], { rounds: 2 })).slice(0, 1))
      .toEqual([1]);
    expect(order(standings('round_robin', ents(2), [win(2, 1, 1, 0)], { rounds: 1 }))).toEqual([2, 1]);
  });

  it('puts out entries last whatever their record, and ignores results for unknown entries', () => {
    const rows = standings('swiss', ents(3, [1]), [win(1, 2), win(1, 3), win(99, 2)], { rounds: 2 });
    expect(order(rows)).toEqual([2, 3, 1]);
    expect(rows[2]).toMatchObject({ out: true, wins: 2, rank: 3 });
    expect(rows.find((x) => x.entryId === 2)!.losses).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/standings.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/events/standings.ts`:

```ts
/**
 * Ranks a table stage (tournaments spec section 3; plan T2). Pure. Swiss
 * orders by points, Buchholz (median from 5 rounds), campaign score
 * difference, head-to-head, seed. League and round robin order by wins,
 * head-to-head, score difference, Buchholz, seed. Head-to-head is counted
 * among the teams still tied at that step only. A bye is a win worth a point,
 * with no opponent and no score; a forfeit counts as a win and a loss with no
 * score. Entries that are out (disqualified) are ranked after everyone else.
 */

export type TableKind = 'swiss' | 'league' | 'round_robin';
export interface TableResult { a: number; b: number | null; winner: number; scoreA: number | null; scoreB: number | null }
export interface TableEntry { id: number; seed: number; out: boolean }
export interface StandingRow {
  entryId: number; rank: number; played: number; wins: number; losses: number; byes: number; points: number;
  buchholz: number; scoreDiff: number; out: boolean;
}

type Key = (ids: number[]) => Map<number, number>;

export function standings(kind: TableKind, entries: TableEntry[], results: TableResult[], o: { rounds: number }): StandingRow[] {
  const rows = new Map<number, StandingRow>(entries.map((e) => [e.id, {
    entryId: e.id, rank: 0, played: 0, wins: 0, losses: 0, byes: 0, points: 0, buchholz: 0, scoreDiff: 0, out: e.out,
  }]));
  const seed = new Map(entries.map((e) => [e.id, e.seed]));
  const opponents = new Map<number, number[]>(entries.map((e) => [e.id, []]));
  const beat = new Map<string, number>();

  for (const r of results) {
    if (r.b === null) {
      const row = rows.get(r.a);
      if (row) { row.byes++; row.wins++; row.points++; }
      continue;
    }
    const sides: [number, number, number | null, number | null][] = [[r.a, r.b, r.scoreA, r.scoreB], [r.b, r.a, r.scoreB, r.scoreA]];
    for (const [me, them, mine, theirs] of sides) {
      const row = rows.get(me);
      if (!row) continue;
      row.played++;
      if (r.winner === me) { row.wins++; row.points++; } else row.losses++;
      if (mine !== null && theirs !== null) row.scoreDiff += mine - theirs;
      opponents.get(me)!.push(them);
    }
    const loser = r.winner === r.a ? r.b : r.a;
    beat.set(`${r.winner}:${loser}`, (beat.get(`${r.winner}:${loser}`) ?? 0) + 1);
  }

  for (const row of rows.values()) {
    let pts = opponents.get(row.entryId)!.map((id) => rows.get(id)?.points ?? 0);
    if (kind === 'swiss' && o.rounds >= 5 && pts.length >= 3) pts = [...pts].sort((x, y) => x - y).slice(1, -1);
    row.buchholz = pts.reduce((s, p) => s + p, 0);
  }

  const by = (f: (r: StandingRow) => number): Key => (ids) => new Map(ids.map((id) => [id, f(rows.get(id)!)]));
  const headToHead: Key = (ids) => new Map(ids.map((id) => [id, ids.reduce((n, other) => n + (other === id ? 0 : beat.get(`${id}:${other}`) ?? 0), 0)]));
  const bySeed: Key = (ids) => new Map(ids.map((id) => [id, -(seed.get(id) ?? 0)]));
  const keys: Key[] = kind === 'swiss'
    ? [by((r) => r.points), by((r) => r.buchholz), by((r) => r.scoreDiff), headToHead, bySeed]
    : [by((r) => r.wins), headToHead, by((r) => r.scoreDiff), by((r) => r.buchholz), bySeed];

  const sort = (ids: number[], ks: Key[]): number[] => {
    if (ids.length <= 1 || ks.length === 0) return ids;
    const values = ks[0](ids);
    const bands = new Map<number, number[]>();
    for (const id of ids) {
      const v = values.get(id)!;
      bands.set(v, [...(bands.get(v) ?? []), id]);
    }
    return [...bands.keys()].sort((x, y) => y - x).flatMap((v) => sort(bands.get(v)!, ks.slice(1)));
  };

  const ids = entries.map((e) => e.id);
  const ranked = [...sort(ids.filter((id) => !rows.get(id)!.out), keys), ...sort(ids.filter((id) => rows.get(id)!.out), keys)];
  return ranked.map((id, i) => ({ ...rows.get(id)!, rank: i + 1 }));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/standings.test.ts`
Expected: PASS. If a hand-worked expectation above is wrong (recheck it on paper against the rule order in this task's doc comment), fix the test only when the code follows the spec order. Never change the order to fit a test.

- [ ] **Step 5: Commit**

```bash
git add src/events/standings.ts tests/standings.test.ts
git commit -m "Tournaments T2: standings for Swiss, league and round robin with the spec's tiebreakers"
```

---

### Task 3: Swiss pairing, the round robin circle and the league season

**Files:**
- Create: `src/events/swiss.ts`, `src/events/roundRobin.ts`, `src/events/league.ts`
- Test: `tests/swiss.test.ts`, `tests/roundRobin.test.ts`, `tests/league.test.ts`

**Interfaces:**
- Consumes: `standings`, `TableResult` from Task 2.
- Produces:
  - `swiss.ts`: `interface Pairing { pairs: [number, number][]; bye: number | null }`; `pairSwiss(entries: { id: number; seed: number }[], results: TableResult[], rounds: number): Pairing`. `entries` are the entries still in (never out ones); `results` are this stage's results so far; the first id of a pair is the higher ranked.
  - `roundRobin.ts`: `circleRounds(ids: number[]): Pairing[]`, giving `n - 1` rounds for even `n` and `n` rounds for odd `n` (one bye each), every pair meeting once.
  - `league.ts` (pure, also imported by the web stage editor in Task 11, so it imports nothing but `./roundRobin.js` and `./swiss.js` types):
    - `repeatedRoundRobin(ids: number[], rounds: number): Pairing[]`: full round robins back to back, sides swapped every other cycle, cut at `rounds`
    - `leagueWeeks(matches: number, perWeek: number): number`
    - `weekOfRound(round: number, perWeek: number): number`
    - `weekDates(seasonStart: string, week: number): { from: string; to: string }` (`YYYY-MM-DD`, 7 days, inclusive)
    - `perWeekFor(matches: number, from: string, to: string): number | null`: the fewest matches a week that fit between the two days (inclusive), or null when more than 3 would be needed or `to` is before `from`
    - `byeSpread(matches: number, teams: number): { min: number; max: number; even: number[] } | null`: byes per team for an odd team count (null for even), and the nearest match counts at or around `matches` that give everyone the same number of byes

- [ ] **Step 1: Write the failing tests**

Create `tests/swiss.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pairSwiss } from '../src/events/swiss.js';
import type { TableResult } from '../src/events/standings.js';

const seeds = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, seed: i + 1 }));
const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
/** Plays a round: the higher seed (lower id) always wins. */
const play = (pairs: [number, number][], bye: number | null): TableResult[] => [
  ...pairs.map(([a, b]) => ({ a, b, winner: Math.min(a, b), scoreA: 10, scoreB: 5 })),
  ...(bye !== null ? [{ a: bye, b: null, winner: bye, scoreA: null, scoreB: null }] : []),
];

describe('pairSwiss', () => {
  it('round 1 pairs the top half against the bottom half', () => {
    expect(pairSwiss(seeds(8), [], 4)).toEqual({ pairs: [[1, 5], [2, 6], [3, 7], [4, 8]], bye: null });
  });

  it('round 1 with an odd count gives the bye to the lowest seed', () => {
    expect(pairSwiss(seeds(5), [], 3)).toEqual({ pairs: [[1, 3], [2, 4]], bye: 5 });
  });

  it('never repeats an opponent while a repeat-free pairing exists, and pairs within score groups', () => {
    let results: TableResult[] = [];
    const met = new Set<string>();
    for (let round = 1; round <= 5; round++) {
      const p = pairSwiss(seeds(8), results, 5);
      expect(p.bye).toBeNull();
      expect(new Set(p.pairs.flat()).size).toBe(8);
      for (const [a, b] of p.pairs) {
        expect(met.has(key(a, b)), `round ${round} repeats ${a}-${b}`).toBe(false);
        met.add(key(a, b));
      }
      results = [...results, ...play(p.pairs, p.bye)];
    }
    // After round 1 (1, 2, 3, 4 won), round 2 pairs winners with winners.
    const r2 = pairSwiss(seeds(8), play([[1, 5], [2, 6], [3, 7], [4, 8]], null), 5);
    for (const [a, b] of r2.pairs) expect(a <= 4).toBe(b <= 4);
  });

  it('rotates the bye: nobody gets a second bye while someone has none', () => {
    let results: TableResult[] = [];
    const byes: number[] = [];
    for (let round = 1; round <= 5; round++) {
      const p = pairSwiss(seeds(5), results, 5);
      expect(p.bye).not.toBeNull();
      byes.push(p.bye!);
      results = [...results, ...play(p.pairs, p.bye)];
    }
    expect(new Set(byes).size).toBe(5);
  });

  it('allows a rematch only when no repeat-free pairing is left', () => {
    let results: TableResult[] = [];
    for (let round = 1; round <= 3; round++) results = [...results, ...play(pairSwiss(seeds(4), results, 5).pairs, null)];
    // 4 teams have each met all 3 others; round 4 must still pair everyone.
    const p = pairSwiss(seeds(4), results, 5);
    expect(new Set(p.pairs.flat()).size).toBe(4);
  });

  it('pairs only the entries it is given (a disqualified team is left out by the caller)', () => {
    const results = play([[1, 3], [2, 4]], null);
    const p = pairSwiss(seeds(4).filter((e) => e.id !== 1), results, 3);
    expect(p.pairs.flat().includes(1)).toBe(false);
    expect(p.bye).not.toBeNull();
  });

  it('handles 0, 1 and 2 entries', () => {
    expect(pairSwiss([], [], 3)).toEqual({ pairs: [], bye: null });
    expect(pairSwiss(seeds(1), [], 3)).toEqual({ pairs: [], bye: 1 });
    expect(pairSwiss(seeds(2), [], 3)).toEqual({ pairs: [[1, 2]], bye: null });
  });
});
```

Create `tests/roundRobin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { circleRounds } from '../src/events/roundRobin.js';

const everyPairOnce = (ids: number[], rounds: { pairs: [number, number][] }[]) => {
  const seen = new Map<string, number>();
  for (const r of rounds) for (const [a, b] of r.pairs) {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  expect(seen.size).toBe((ids.length * (ids.length - 1)) / 2);
  expect([...seen.values()].every((n) => n === 1)).toBe(true);
};

describe('circleRounds', () => {
  it('even count: n - 1 rounds, no byes, everyone once per round', () => {
    const ids = [11, 12, 13, 14, 15, 16];
    const rounds = circleRounds(ids);
    expect(rounds).toHaveLength(5);
    for (const r of rounds) {
      expect(r.bye).toBeNull();
      expect(new Set(r.pairs.flat()).size).toBe(6);
    }
    everyPairOnce(ids, rounds);
  });

  it('odd count: n rounds, one bye each, every team sits out once', () => {
    const ids = [1, 2, 3, 4, 5];
    const rounds = circleRounds(ids);
    expect(rounds).toHaveLength(5);
    expect(new Set(rounds.map((r) => r.bye))).toEqual(new Set(ids));
    everyPairOnce(ids, rounds);
  });

  it('two teams play once; one team only sits out', () => {
    expect(circleRounds([1, 2])).toEqual([{ pairs: [[1, 2]], bye: null }]);
    expect(circleRounds([7])).toEqual([{ pairs: [], bye: 7 }]);
  });
});
```

Create `tests/league.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { byeSpread, leagueWeeks, perWeekFor, repeatedRoundRobin, weekDates, weekOfRound } from '../src/events/league.js';

describe('league season', () => {
  it('repeats the round robin, swapping sides, until the rounds are used', () => {
    const ids = [1, 2, 3, 4];
    const rounds = repeatedRoundRobin(ids, 7);
    expect(rounds).toHaveLength(7);
    const meetings = new Map<string, number>();
    for (const r of rounds) for (const [a, b] of r.pairs) {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      meetings.set(k, (meetings.get(k) ?? 0) + 1);
    }
    // 7 rounds of 4 teams = two full cycles (6 rounds) plus one: every pair twice, two pairs three times.
    expect([...meetings.values()].sort()).toEqual([2, 2, 2, 2, 3, 3]);
    // Cycle 2 plays cycle 1's first round with sides swapped.
    expect(rounds[3]!.pairs).toEqual(rounds[0]!.pairs.map(([a, b]) => [b, a]));
  });

  it('gives each team of an odd field one bye per cycle', () => {
    const rounds = repeatedRoundRobin([1, 2, 3, 4, 5], 10);
    const byes = new Map<number, number>();
    for (const r of rounds) byes.set(r.bye!, (byes.get(r.bye!) ?? 0) + 1);
    expect([...byes.values()]).toEqual([2, 2, 2, 2, 2]);
  });

  it('weeks, the week of a round and its dates', () => {
    expect(leagueWeeks(16, 2)).toBe(8);
    expect(leagueWeeks(16, 3)).toBe(6);
    expect([1, 2, 3, 4, 5].map((r) => weekOfRound(r, 2))).toEqual([1, 1, 2, 2, 3]);
    expect(weekDates('2026-10-12', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(weekDates('2026-10-12', 8)).toEqual({ from: '2026-11-30', to: '2026-12-06' });
  });

  it('works out matches a week from two dates', () => {
    // Oct 12 to Nov 29 inclusive is exactly 7 weeks: 16 matches need 3 a week.
    expect(perWeekFor(16, '2026-10-12', '2026-11-29')).toBe(3);
    expect(perWeekFor(16, '2026-10-12', '2026-12-06')).toBe(2);
    expect(perWeekFor(16, '2026-10-12', '2026-10-25')).toBeNull();
    expect(perWeekFor(16, '2026-10-12', '2026-10-01')).toBeNull();
  });

  it('says how byes fall for an odd field and which counts split them evenly', () => {
    expect(byeSpread(16, 8)).toBeNull();
    expect(byeSpread(16, 7)).toEqual({ min: 2, max: 3, even: [14, 21] });
    expect(byeSpread(14, 7)).toEqual({ min: 2, max: 2, even: [14] });
    expect(byeSpread(3, 5)).toEqual({ min: 0, max: 1, even: [5] });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/swiss.test.ts tests/roundRobin.test.ts tests/league.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `src/events/swiss.ts`:

```ts
import { standings, type TableResult } from './standings.js';

/**
 * Pairs one Swiss round (tournaments spec section 3; plan T2). Pure. Round 1
 * (no result among these entries yet) pairs seed order top half against
 * bottom half. Later rounds take the Swiss standings order and pair from the
 * top, each team with the first one below it it has not met, backtracking
 * when the rest cannot be paired; only when no repeat-free pairing exists at
 * all is a rematch allowed (Ruling 11). With an odd count the bye goes first,
 * to the lowest-ranked entry among those with the fewest byes (Ruling 10).
 */

export interface Pairing { pairs: [number, number][]; bye: number | null }

/** Enough for any field this site will see; past it, rematches are allowed. */
const STEP_CAP = 200_000;

export function pairSwiss(entries: { id: number; seed: number }[], results: TableResult[], rounds: number): Pairing {
  if (entries.length === 0) return { pairs: [], bye: null };
  const ids = new Set(entries.map((e) => e.id));
  const mine = results.filter((r) => ids.has(r.a) || (r.b !== null && ids.has(r.b)));
  const first = mine.length === 0;
  const order = first
    ? [...entries].sort((x, y) => x.seed - y.seed).map((e) => e.id)
    : standings('swiss', entries.map((e) => ({ ...e, out: false })), mine, { rounds }).map((s) => s.entryId);

  let bye: number | null = null;
  if (order.length % 2 === 1) {
    const byes = new Map<number, number>();
    for (const r of mine) if (r.b === null) byes.set(r.a, (byes.get(r.a) ?? 0) + 1);
    const fewest = Math.min(...order.map((id) => byes.get(id) ?? 0));
    for (let i = order.length - 1; i >= 0; i--) {
      if ((byes.get(order[i]!) ?? 0) === fewest) { bye = order[i]!; break; }
    }
    order.splice(order.indexOf(bye!), 1);
  }

  if (first) {
    const half = order.length / 2;
    return { pairs: order.slice(0, half).map((a, i): [number, number] => [a, order[half + i]!]), bye };
  }
  const met = new Set<string>();
  for (const r of mine) if (r.b !== null) { met.add(`${r.a}:${r.b}`); met.add(`${r.b}:${r.a}`); }
  return { pairs: pairOff(order, met) ?? pairOff(order, new Set())!, bye };
}

function pairOff(order: number[], met: Set<string>): [number, number][] | null {
  let steps = 0;
  const used = order.map(() => false);
  const out: [number, number][] = [];
  const go = (): boolean => {
    if (++steps > STEP_CAP) return false;
    const i = used.indexOf(false);
    if (i === -1) return true;
    used[i] = true;
    for (let j = i + 1; j < order.length; j++) {
      if (used[j] || met.has(`${order[i]}:${order[j]}`)) continue;
      used[j] = true;
      out.push([order[i]!, order[j]!]);
      if (go()) return true;
      used[j] = false;
      out.pop();
    }
    used[i] = false;
    return false;
  };
  return go() ? out : null;
}
```

Create `src/events/roundRobin.ts`:

```ts
import type { Pairing } from './swiss.js';

/**
 * A full round robin by the circle method (league stages with round robin
 * pairing; plan T2). Pure. The first team stays put and the rest rotate; an
 * odd field gets a bye seat, so each round one team sits out. Sides
 * alternate for the fixed team so it is not always first.
 */
export function circleRounds(ids: number[]): Pairing[] {
  const seats: (number | null)[] = [...ids];
  if (seats.length % 2 === 1) seats.push(null);
  const n = seats.length;
  const rounds: Pairing[] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    let bye: number | null = null;
    for (let i = 0; i < n / 2; i++) {
      const x = seats[i]!;
      const y = seats[n - 1 - i]!;
      if (x === null) bye = y;
      else if (y === null) bye = x;
      else pairs.push(i === 0 && r % 2 === 1 ? [y, x] : [x, y]);
    }
    rounds.push({ pairs, bye });
    seats.splice(1, 0, seats.pop()!);
  }
  return rounds;
}
```

Note: `seats[i]!` keeps `null` (the `!` only drops `undefined` for the compiler). If the compiler objects, type the reads as `const x = seats[i] as number | null;`.

Create `src/events/league.ts`:

```ts
import { circleRounds } from './roundRobin.js';
import type { Pairing } from './swiss.js';

/**
 * A league season (plan T2 Rulings 7, 18 to 20; owner 2026-10-05): a number
 * of rounds, one result per team per round, played some a week from a start
 * day. Pure, and imported by the web stage editor's season calculator, so it
 * must not import anything that reaches the database or node.
 */

/** Mirrors src/events/validate.ts LEAGUE_MATCHES_MAX (not imported: the web
 *  bundle must not pull in the validator). */
const MATCHES_MAX = 40;
const DAY = 86_400_000;

/** Full round robins back to back, every other one with sides swapped, cut
 *  at `rounds`. An odd field sits each team out once per cycle. */
export function repeatedRoundRobin(ids: number[], rounds: number): Pairing[] {
  const cycle = circleRounds(ids);
  const out: Pairing[] = [];
  for (let c = 0; out.length < rounds && cycle.length > 0; c++) {
    for (const r of cycle) {
      if (out.length >= rounds) break;
      out.push(c % 2 === 0 ? r : { pairs: r.pairs.map(([a, b]): [number, number] => [b, a]), bye: r.bye });
    }
  }
  return out;
}

export const leagueWeeks = (matches: number, perWeek: number): number => Math.ceil(matches / perWeek);
export const weekOfRound = (round: number, perWeek: number): number => Math.floor((round - 1) / perWeek) + 1;

const day = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`);
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Week N runs 7 days from seasonStart + 7 x (N - 1), both ends inclusive. */
export function weekDates(seasonStart: string, week: number): { from: string; to: string } {
  const from = day(seasonStart) + 7 * (week - 1) * DAY;
  return { from: ymd(from), to: ymd(from + 6 * DAY) };
}

/** The fewest matches a week that fit `matches` into the full weeks from
 *  `from` to `to` (both inclusive), or null past 3 a week. */
export function perWeekFor(matches: number, from: string, to: string): number | null {
  const weeks = Math.floor((day(to) - day(from) + DAY) / (7 * DAY));
  if (weeks < 1) return null;
  const per = Math.ceil(matches / weeks);
  return per <= 3 ? per : null;
}

/** Byes per team over `matches` rounds with an odd field (each team sits
 *  once per `teams` rounds), and the match counts nearest `matches` at
 *  which everyone gets the same number. Null for an even field. */
export function byeSpread(matches: number, teams: number): { min: number; max: number; even: number[] } | null {
  if (teams % 2 === 0) return null;
  const min = Math.floor(matches / teams);
  const max = Math.ceil(matches / teams);
  const even = [...new Set([min * teams, max * teams])].filter((n) => n >= 1 && n <= MATCHES_MAX);
  return { min, max, even };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/swiss.test.ts tests/roundRobin.test.ts tests/league.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/swiss.ts src/events/roundRobin.ts src/events/league.ts tests/swiss.test.ts tests/roundRobin.test.ts tests/league.test.ts
git commit -m "Tournaments T2: Swiss pairing with bye rotation and rematch avoidance, the round robin circle, and the league season (repeating round robin, weeks, dates, byes)"
```

---

### Task 4: The bracket wrapper

**Files:**
- Create: `src/events/bracket.ts`
- Test: `tests/bracket.test.ts`

**Interfaces:**
- Consumes: `StageConfigs` from `validate.ts`.
- Produces:
  - `type BracketType = 'single_elim' | 'double_elim' | 'round_robin'`
  - `interface BracketData { v: 1; tables: Record<string, unknown[]> }` (plain JSON)
  - `interface BracketMatch { bmId: number; group: number; round: number; number: number; a: number | null; b: number | null; state: 'pending' | 'ready' | 'done'; winner: number | null; scoreA: number | null; scoreB: number | null; forfeit: boolean }`, with `a`/`b` being entry ids (null = not known yet)
  - `class BracketError extends Error { code: 'locked' | 'not_ready' | 'too_few' }`
  - `createBracket(type: BracketType, config: StageConfigs[BracketType], seeded: number[]): Promise<BracketData>` (seeded = entry ids, best first)
  - `reportResult(data: BracketData, bmId: number, r: ResultInput): Promise<BracketData>` (never mutates `data`; a completed match is reset and re-reported, which is a correction)
  - `bracketMatches(data: BracketData): BracketMatch[]` (sync; no byes; a double elimination reset only once it must be played)
  - `bracketComplete(data: BracketData): boolean`
  - `bracketRanks(data: BracketData): Promise<{ entryId: number; rank: number }[]>` (elimination only)
  - `bracketGroups(data: BracketData): Map<number, number>` (entry id to group number; round robin)

- [ ] **Step 1: Write the failing tests**

Create `tests/bracket.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BracketError, bracketComplete, bracketGroups, bracketMatches, bracketRanks, createBracket, reportResult, type BracketData,
} from '../src/events/bracket.js';
import type { ResultInput } from '../src/events/validate.js';

const aWins: ResultInput = { winner: 'a', scoreA: 10, scoreB: 5, forfeit: false };
const bWins: ResultInput = { winner: 'b', scoreA: 5, scoreB: 10, forfeit: false };
const ready = (d: BracketData) => bracketMatches(d).filter((m) => m.state === 'ready');
/** Plays every ready match with `pick` until none is left. */
async function playAll(d: BracketData, pick: (m: ReturnType<typeof bracketMatches>[number]) => ResultInput): Promise<BracketData> {
  for (let i = 0; i < 64 && ready(d).length > 0; i++) for (const m of ready(d)) d = await reportResult(d, m.bmId, pick(m));
  return d;
}

describe('bracket', () => {
  it('single elimination of 5 gives the top 3 seeds byes and shows no bye matches', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [101, 102, 103, 104, 105]);
    expect(ready(d).map((m) => [m.a, m.b])).toEqual([[104, 105]]);
    expect(bracketMatches(d).every((m) => m.a !== null || m.state === 'pending')).toBe(true);
    const done = await playAll(d, () => aWins);
    expect(bracketComplete(done)).toBe(true);
    expect((await bracketRanks(done))[0]).toEqual({ entryId: 101, rank: 1 });
  });

  it('survives a JSON round trip and never mutates its input', async () => {
    const d = await createBracket('single_elim', { thirdPlace: true }, [1, 2, 3, 4]);
    const copy = JSON.parse(JSON.stringify(d)) as BracketData;
    const before = JSON.stringify(copy);
    const after = await reportResult(copy, ready(copy)[0]!.bmId, aWins);
    expect(JSON.stringify(copy)).toBe(before);
    expect(bracketMatches(after).filter((m) => m.state === 'done')).toHaveLength(1);
  });

  it('third place: semifinal losers meet, and ranks are 1 to 4', async () => {
    const d = await playAll(await createBracket('single_elim', { thirdPlace: true }, [1, 2, 3, 4]), () => aWins);
    expect(bracketMatches(d).filter((m) => m.group === 2)).toHaveLength(1);
    expect((await bracketRanks(d)).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('double elimination: no reset match when the upper winner takes the grand final', async () => {
    const d = await playAll(await createBracket('double_elim', { grandFinalReset: true }, [1, 2, 3, 4]), () => aWins);
    expect(bracketMatches(d).filter((m) => m.group === 3).map((m) => m.round)).toEqual([1]);
    expect(bracketComplete(d)).toBe(true);
    expect((await bracketRanks(d))[0]).toEqual({ entryId: 1, rank: 1 });
  });

  it('double elimination: the reset appears when the lower side wins the first grand final', async () => {
    let d = await createBracket('double_elim', { grandFinalReset: true }, [1, 2, 3, 4]);
    d = await playAll(d, (m) => (m.group === 3 ? bWins : aWins));
    const gf = bracketMatches(d).filter((m) => m.group === 3);
    expect(gf.map((m) => [m.round, m.state])).toEqual([[1, 'done'], [2, 'done']]);
    expect(bracketComplete(d)).toBe(true);
  });

  it('a forfeit advances the other side and is marked', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [1, 2]);
    const after = await reportResult(d, ready(d)[0]!.bmId, { winner: 'b', scoreA: null, scoreB: null, forfeit: true });
    expect(bracketMatches(after)[0]).toMatchObject({ state: 'done', winner: 2, forfeit: true, scoreA: null, scoreB: null });
  });

  it('a correction is taken until the next match is played, then refused as locked', async () => {
    let d = await createBracket('single_elim', { thirdPlace: false }, [1, 2, 3, 4]);
    const [m1, m2] = ready(d);
    d = await reportResult(d, m1!.bmId, aWins);
    d = await reportResult(d, m1!.bmId, bWins);
    expect(bracketMatches(d).find((m) => m.bmId === m1!.bmId)!.winner).toBe(m1!.b);
    d = await reportResult(d, m2!.bmId, aWins);
    const final = ready(d)[0]!;
    expect([final.a, final.b]).toContain(m1!.b);
    d = await reportResult(d, final.bmId, aWins);
    await expect(reportResult(d, m1!.bmId, aWins)).rejects.toMatchObject({ code: 'locked' });
    await expect(reportResult(d, m1!.bmId, aWins)).rejects.toBeInstanceOf(BracketError);
  });

  it('refuses a result for a match whose teams are not both known', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [1, 2, 3, 4]);
    const pending = bracketMatches(d).find((m) => m.state === 'pending')!;
    await expect(reportResult(d, pending.bmId, aWins)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('round robin of 7 in 2 groups: groups of 4 and 3, every pair inside a group once', async () => {
    const d = await createBracket('round_robin', { groups: 2 }, [1, 2, 3, 4, 5, 6, 7]);
    const g = bracketGroups(d);
    const sizes = [1, 2].map((n) => [...g.values()].filter((x) => x === n).length).sort();
    expect(sizes).toEqual([3, 4]);
    expect(bracketMatches(d)).toHaveLength(6 + 3);
    expect(bracketMatches(d).every((m) => g.get(m.a!) === m.group && g.get(m.b!) === m.group)).toBe(true);
    expect(bracketComplete(await playAll(d, () => aWins))).toBe(true);
  });

  it('caps groups so every group has at least 2 teams, and refuses fewer than 2 entries', async () => {
    const d = await createBracket('round_robin', { groups: 4 }, [1, 2, 3, 4, 5]);
    expect(new Set(bracketGroups(d).values()).size).toBe(2);
    await expect(createBracket('single_elim', { thirdPlace: false }, [1])).rejects.toMatchObject({ code: 'too_few' });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/bracket.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/events/bracket.ts`:

```ts
import { BracketsManager } from 'brackets-manager';
import { InMemoryDatabase } from 'brackets-memory-db';
import type { ResultInput, StageConfigs } from './validate.js';

/**
 * brackets-manager.js over its in-memory store (plan T2 Ruling 15). A stage's
 * whole bracket is one plain JSON value, BracketData. Each call copies it
 * into a fresh store, lets the library work, and returns a new copy, so
 * src/events/play.ts can write it in the same synchronous transaction as the
 * match row and the audit row. Participants are named by entry id. One stage
 * per store, always stage id 0.
 *
 * Library facts this module leans on (pinned by tests/bracket.test.ts): the
 * field must be a power of two for elimination, padded with null seeds (byes)
 * that the default inner_outer ordering gives to the top seeds; a match with
 * a null opponent is a bye; status 2 or 3 means both teams are known, and 4 or
 * more means done; a double elimination grand final reset stays "ready" even
 * when the upper winner took the first grand final, so it is hidden unless the
 * lower side won it; a result on a match whose next match is done throws
 * "locked".
 */

export type BracketType = 'single_elim' | 'double_elim' | 'round_robin';
export interface BracketData { v: 1; tables: Record<string, unknown[]> }
export interface BracketMatch {
  bmId: number; group: number; round: number; number: number; a: number | null; b: number | null;
  state: 'pending' | 'ready' | 'done'; winner: number | null; scoreA: number | null; scoreB: number | null; forfeit: boolean;
}

export class BracketError extends Error {
  constructor(readonly code: 'locked' | 'not_ready' | 'too_few') { super(`bracket: ${code}`); }
}

interface BmOpponent { id: number | null; score?: number; result?: 'win' | 'loss' | 'draw'; forfeit?: boolean }
interface BmMatch { id: number; group_id: number; round_id: number; number: number; status: number; opponent1: BmOpponent | null; opponent2: BmOpponent | null }
interface Tables {
  participant: { id: number; name: string }[]; stage: { type: string }[]; group: { id: number; number: number }[];
  round: { id: number; number: number }[]; match: BmMatch[];
}

const STAGE = 0;
const DONE = 4;

function open(data: BracketData | null): { store: InMemoryDatabase; manager: BracketsManager } {
  const store = new InMemoryDatabase();
  if (data) store.setData(structuredClone(data.tables) as never);
  return { store, manager: new BracketsManager(store) };
}
const tablesOf = (store: InMemoryDatabase): Tables => (store as unknown as { data: Tables }).data;
const snapshot = (store: InMemoryDatabase): BracketData => ({ v: 1, tables: structuredClone(tablesOf(store)) as unknown as Record<string, unknown[]> });

export async function createBracket(type: BracketType, config: StageConfigs[BracketType], seeded: number[]): Promise<BracketData> {
  if (seeded.length < 2) throw new BracketError('too_few');
  const { store, manager } = open(null);
  const names = seeded.map(String);
  if (type === 'round_robin') {
    const groupCount = Math.max(1, Math.min((config as StageConfigs['round_robin']).groups, Math.floor(seeded.length / 2)));
    await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'round_robin', seeding: names, settings: { groupCount } });
  } else {
    const size = 2 ** Math.ceil(Math.log2(seeded.length));
    const seeding = [...names, ...Array<null>(size - names.length).fill(null)];
    if (type === 'single_elim') {
      const thirdPlace = (config as StageConfigs['single_elim']).thirdPlace && seeded.length >= 4;
      await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'single_elimination', seeding, settings: { consolationFinal: thirdPlace } });
    } else {
      const reset = (config as StageConfigs['double_elim']).grandFinalReset;
      await manager.create.stage({ tournamentId: 0, name: 'stage', type: 'double_elimination', seeding, settings: { grandFinal: reset ? 'double' : 'simple' } });
    }
  }
  return snapshot(store);
}

export async function reportResult(data: BracketData, bmId: number, r: ResultInput): Promise<BracketData> {
  const { store, manager } = open(data);
  const cur = tablesOf(store).match.find((m) => m.id === bmId);
  if (!cur || cur.opponent1?.id == null || cur.opponent2?.id == null) throw new BracketError('not_ready');
  const side = (me: 'a' | 'b', score: number | null) => {
    const won = r.winner === me;
    if (r.forfeit) return won ? {} : { forfeit: true };
    return won ? { score: score!, result: 'win' as const } : { score: score! };
  };
  try {
    if (cur.status >= DONE) await manager.reset.matchResults(bmId);
    await manager.update.match({ id: bmId, opponent1: side('a', r.scoreA), opponent2: side('b', r.scoreB) });
  } catch (err) {
    if (err instanceof Error && /locked/i.test(err.message)) throw new BracketError('locked');
    throw err;
  }
  return snapshot(store);
}

export function bracketMatches(data: BracketData): BracketMatch[] {
  const t = data.tables as unknown as Tables;
  const entryOf = new Map(t.participant.map((p) => [p.id, Number(p.name)]));
  const groupNo = new Map(t.group.map((g) => [g.id, g.number]));
  const roundNo = new Map(t.round.map((r) => [r.id, r.number]));
  const double = t.stage[0]?.type === 'double_elimination';
  const out: BracketMatch[] = [];
  for (const m of t.match) {
    if (m.opponent1 === null || m.opponent2 === null) continue;
    const group = groupNo.get(m.group_id)!;
    const round = roundNo.get(m.round_id)!;
    if (double && group === 3 && round === 2) {
      const first = t.match.find((x) => x.group_id === m.group_id && roundNo.get(x.round_id) === 1);
      if (first?.opponent2?.result !== 'win') continue;
    }
    const a = m.opponent1.id === null ? null : entryOf.get(m.opponent1.id) ?? null;
    const b = m.opponent2.id === null ? null : entryOf.get(m.opponent2.id) ?? null;
    const done = m.status >= DONE;
    const winner = m.opponent1.result === 'win' ? a : m.opponent2.result === 'win' ? b : null;
    out.push({
      bmId: m.id, group, round, number: m.number, a, b,
      state: done ? 'done' : a !== null && b !== null ? 'ready' : 'pending',
      winner: done ? winner : null,
      scoreA: done ? m.opponent1.score ?? null : null, scoreB: done ? m.opponent2.score ?? null : null,
      forfeit: done && (m.opponent1.forfeit === true || m.opponent2.forfeit === true),
    });
  }
  return out;
}

export function bracketComplete(data: BracketData): boolean {
  const ms = bracketMatches(data);
  return ms.length > 0 && ms.every((m) => m.state === 'done');
}

export async function bracketRanks(data: BracketData): Promise<{ entryId: number; rank: number }[]> {
  const { manager } = open(data);
  const rows = (await manager.get.finalStandings(STAGE)) as { name: string; rank: number }[];
  return rows.map((r) => ({ entryId: Number(r.name), rank: r.rank }));
}

export function bracketGroups(data: BracketData): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of bracketMatches(data)) {
    if (m.a !== null) out.set(m.a, m.group);
    if (m.b !== null) out.set(m.b, m.group);
  }
  return out;
}
```

If the compiler rejects an argument shape (`settings`, `seeding` with nulls, or the opponent objects), check `node_modules/brackets-manager/dist/*.d.ts` and `brackets-model` for the exact input type. Cast at that call only (`as never` on the one argument); do not loosen the module's own types. If `manager.reset.matchResults` does not exist in 1.11.1, find the reset call in `node_modules/brackets-manager/dist/reset.d.ts` and use that; the correction test pins the behaviour.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bracket.test.ts`
Expected: PASS. If the double elimination tests fail because the library numbers groups or rounds differently from the facts in the module comment, print `data.tables.group`, `round` and `match` once in a scratch test, correct the comment and the filter, and keep the tests' intent: no reset unless the lower side won.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/events/bracket.ts tests/bracket.test.ts
git commit -m "Tournaments T2: brackets-manager wrapper over the in-memory store; single and double elimination, round robin groups, corrections and ranks"
```

---

### Task 5: The play writer and its guard

**Files:**
- Create: `src/events/play.ts`, `tests/playFixture.ts`, `tests/play.test.ts`
- Modify: `tests/eventLogGuard.test.ts`

**Interfaces:**
- Consumes: `bracketMatches`, `BracketData` (Task 4); `ResultInput` (Task 1); `E.logEvent`, `E.getEvent`, `E.getStage`, `E.stagesOf`, `E.stageSettingsOf`; `N.entriesOf`, `N.isActive`.
- Produces (all in `src/events/play.ts`):
  - `type MatchStatus` (the twelve statuses); `interface MatchRow` (every `event_matches` column, `grp` included)
  - `interface NewRound { round: number; pairs: [number, number][]; bye: number | null }`
  - `interface StagePlan { stageId: number; entrants: number[]; bracket: BracketData | null; rounds: NewRound[] }`
  - `interface StageOutcome { ranks: { entryId: number; rank: number }[]; advance: number[] }`
  - `RESOLVED: ReadonlySet<MatchStatus>` (`done`, `forfeit`, `bye`)
  - reads: `getMatch(db, id)`, `matchesOf(db, stageId)`, `stageEntrants(stage): number[]`, `stageBracket(stage): BracketData | null`, `activeSeeded(db, eventId): number[]`, `totalRounds(stage): number | null` (Swiss: `rounds`; league with Swiss pairing: `matches`; otherwise null, because those stages write every match at the start)
  - mutations (each returns `V.Checked<...>`, one transaction, one `event_log` row):
    - `startEvent(db, { eventId, by: string | null, plan: StagePlan, now?: Date }): Checked<E.EventRow>`, logging `event_started`
    - `recordResult(db, { matchId, by: string | null, result: ResultInput, bracket: { data: BracketData; baseRev: number } | null, now?: Date }): Checked<MatchRow>`, logging `result_recorded`
    - `addRound(db, { stageId, round: NewRound, now?: Date }): Checked<null>`, logging `round_paired` (actor null)
    - `finishStage(db, { stageId, outcome: StageOutcome, next: StagePlan | null, now?: Date }): Checked<{ eventFinished: boolean }>`, logging `stage_finished` (actor null)
- Produces in `tests/playFixture.ts`: `playFixture(o: { stages: Record<string, unknown>[]; entries: number }): PlayFixture` with `interface PlayFixture { db: DB; eventId: number; stages: number[]; entries: number[] }`. The event is published, its status is `checkin` with `locked_at` set, and its entries `Team 1..N` are checked in and seeded 1..N in id order. ADMIN is an active admin.

- [ ] **Step 1: Write the fixture**

Create `tests/playFixture.ts`:

```ts
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, must, stageBody } from './eventFixture.js';

/** A published team event whose entry list is final (status checkin,
 *  locked_at set) with `entries` checked-in entries seeded 1..N in id order.
 *  Entries are inserted directly: these tests are about play, not
 *  registration (tests/entries.test.ts covers that). Stage bodies are passed
 *  through stageBody, so each needs only what differs from a Swiss stage. */
export interface PlayFixture { db: DB; eventId: number; stages: number[]; entries: number[] }

export function playFixture(o: { stages: Record<string, unknown>[]; entries: number }): PlayFixture {
  const db = openDb(':memory:');
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, []);
  db.prepare("UPDATE players SET is_admin = 1, status = 'active' WHERE steamid = ?").run(ADMIN);
  const ev = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Play Cup', startsAt: START, entryKind: 'team' }, now: NOW }));
  for (const s of o.stages) must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, s), now: NOW }));
  must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  db.prepare("UPDATE events SET status = 'checkin', locked_at = ? WHERE id = ?").run(NOW.toISOString(), ev.id);
  const ins = db.prepare(
    "INSERT INTO event_entries (event_id, name, tag, seed, status, registered_by, created_at) VALUES (?, ?, ?, ?, 'checked_in', ?, ?)",
  );
  const entries = Array.from({ length: o.entries }, (_, i) =>
    Number(ins.run(ev.id, `Team ${i + 1}`, `T${i + 1}`, i + 1, ADMIN, NOW.toISOString()).lastInsertRowid));
  return { db, eventId: ev.id, stages: E.stagesOf(db, ev.id).map((s) => s.id), entries };
}

export const SWISS = (rounds: number, advanceCount: number | null) => ({ type: 'swiss', config: { rounds }, advanceCount });
export const SE = (thirdPlace = false) => ({ type: 'single_elim', config: { thirdPlace }, advanceCount: null });
export const DE = (grandFinalReset = true) => ({ type: 'double_elim', config: { grandFinalReset }, advanceCount: null });
export const RR = (groups: number, advanceCount: number | null) => ({ type: 'round_robin', config: { groups }, advanceCount });
export const LEAGUE = (matches: number, matchesPerWeek: number, pairing: 'swiss' | 'round_robin', advanceCount: number | null, seasonStart: string | null = null) =>
  ({ type: 'league', config: { matches, matchesPerWeek, pairing, seasonStart }, scheduling: 'window', advanceCount });
```

- [ ] **Step 2: Write the failing writer tests**

Create `tests/play.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { createBracket, bracketMatches } from '../src/events/bracket.js';
import { ADMIN, NOW } from './eventFixture.js';
import { SE, SWISS, playFixture } from './playFixture.js';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const swissPlan = (stageId: number, entrants: number[]): P.StagePlan => ({
  stageId, entrants, bracket: null,
  rounds: [{ round: 1, pairs: [[entrants[0]!, entrants[2]!], [entrants[1]!, entrants[3]!]], bye: null }],
});
const aWins = { winner: 'a' as const, scoreA: 10, scoreB: 5, forfeit: false };

describe('play writer', () => {
  it('startEvent: live, stage 1 live with its entrants and round, one event_started row', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    const ev = ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    expect(ev).toMatchObject({ status: 'live', live_at: NOW.toISOString() });
    const s = E.getStage(f.db, f.stages[0]!)!;
    expect(s).toMatchObject({ status: 'live', started_at: NOW.toISOString(), bracket_json: null });
    expect(P.stageEntrants(s)).toEqual(f.entries);
    expect(P.matchesOf(f.db, s.id).map((m) => [m.round, m.slot, m.entry_a, m.entry_b, m.status]))
      .toEqual([[1, 1, f.entries[0], f.entries[2], 'waiting'], [1, 2, f.entries[1], f.entries[3], 'waiting']]);
    expect(E.eventLog(f.db, f.eventId).at(-1)).toMatchObject({ action: 'event_started', actor: ADMIN });
  });

  it('startEvent refuses a list that is not final, fewer than 2 entries, or a plan for other entrants', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, [...f.entries].reverse()), now: NOW }))
      .toEqual({ ok: false, error: 'changed' });
    f.db.prepare('UPDATE events SET locked_at = NULL WHERE id = ?').run(f.eventId);
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }))
      .toEqual({ ok: false, error: 'list_not_final' });
    const g = playFixture({ stages: [SE()], entries: 1 });
    expect(P.startEvent(g.db, { eventId: g.eventId, by: ADMIN, plan: { stageId: g.stages[0]!, entrants: g.entries, bracket: null, rounds: [] }, now: NOW }))
      .toEqual({ ok: false, error: 'too_few_entries' });
  });

  it('startEvent with a bracket mirrors every non-bye bracket match as a row', async () => {
    const f = playFixture({ stages: [SE()], entries: 5 });
    const bracket = await createBracket('single_elim', { thirdPlace: false }, f.entries);
    ok(P.startEvent(f.db, { eventId: f.eventId, by: null, plan: { stageId: f.stages[0]!, entrants: f.entries, bracket, rounds: [] }, now: NOW }));
    const rows = P.matchesOf(f.db, f.stages[0]!);
    expect(rows).toHaveLength(bracketMatches(bracket).length);
    expect(rows.filter((m) => m.status === 'waiting').map((m) => [m.entry_a, m.entry_b])).toEqual([[f.entries[3], f.entries[4]]]);
    expect(E.getStage(f.db, f.stages[0]!)!.bracket_rev).toBe(1);
  });

  it('recordResult on a table match: result, source admin, then a correction while no later round exists', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const [m1] = P.matchesOf(f.db, f.stages[0]!);
    expect(ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW })))
      .toMatchObject({ status: 'done', winner_entry: m1!.entry_a, score_a: 10, score_b: 5, result_source: 'admin' });
    const fixed = ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: { winner: 'b', scoreA: null, scoreB: null, forfeit: true }, bracket: null, now: NOW }));
    expect(fixed).toMatchObject({ status: 'forfeit', winner_entry: m1!.entry_b, score_a: null, result_source: 'forfeit' });
    expect(JSON.parse(E.eventLog(f.db, f.eventId).at(-1)!.detail)).toMatchObject({ matchId: m1!.id, correction: true, forfeit: true });
  });

  it('recordResult refuses a correction once the next round exists, and a write on an older bracket', async () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const [m1, m2] = P.matchesOf(f.db, f.stages[0]!);
    for (const m of [m1!, m2!]) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    ok(P.addRound(f.db, { stageId: f.stages[0]!, round: { round: 2, pairs: [[m1!.entry_a!, m2!.entry_a!], [m1!.entry_b!, m2!.entry_b!]], bye: null }, now: NOW }));
    expect(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW })).toEqual({ ok: false, error: 'result_locked' });

    const g = playFixture({ stages: [SE()], entries: 2 });
    const bracket = await createBracket('single_elim', { thirdPlace: false }, g.entries);
    ok(P.startEvent(g.db, { eventId: g.eventId, by: null, plan: { stageId: g.stages[0]!, entrants: g.entries, bracket, rounds: [] }, now: NOW }));
    const [only] = P.matchesOf(g.db, g.stages[0]!);
    expect(P.recordResult(g.db, { matchId: only!.id, by: ADMIN, result: aWins, bracket: { data: bracket, baseRev: 0 }, now: NOW }))
      .toEqual({ ok: false, error: 'changed' });
  });

  it('addRound refuses a round while one is open, a skipped number, or one past the last', () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const round2 = { round: 2, pairs: [[f.entries[0]!, f.entries[1]!]] as [number, number][], bye: null };
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: round2, now: NOW })).toEqual({ ok: false, error: 'changed' });
    for (const m of P.matchesOf(f.db, f.stages[0]!)) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: { ...round2, round: 3 }, now: NOW })).toEqual({ ok: false, error: 'changed' });
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: round2, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
  });

  it('finishStage: losers eliminated with places below the advancers, next stage live; last stage places everyone and finishes the event', async () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    for (const m of P.matchesOf(f.db, f.stages[0]!)) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    const [e1, e2, e3, e4] = f.entries as [number, number, number, number];
    const ranks = [e1, e2, e3, e4].map((entryId, i) => ({ entryId, rank: i + 1 }));
    const bracket = await createBracket('single_elim', { thirdPlace: false }, [e1, e2]);
    const next: P.StagePlan = { stageId: f.stages[1]!, entrants: [e1, e2], bracket, rounds: [] };
    expect(ok(P.finishStage(f.db, { stageId: f.stages[0]!, outcome: { ranks, advance: [e1, e2] }, next, now: NOW }))).toEqual({ eventFinished: false });
    expect(N.getEntry(f.db, e3)).toMatchObject({ status: 'eliminated', placement: 3 });
    expect(N.getEntry(f.db, e4)).toMatchObject({ status: 'eliminated', placement: 4 });
    expect(E.getStage(f.db, f.stages[0]!)!.status).toBe('finished');
    expect(E.getStage(f.db, f.stages[1]!)!.status).toBe('live');

    const [final] = P.matchesOf(f.db, f.stages[1]!);
    expect(P.finishStage(f.db, { stageId: f.stages[1]!, outcome: { ranks: [], advance: [] }, next: null, now: NOW })).toEqual({ ok: false, error: 'changed' });
    f.db.prepare("UPDATE event_matches SET status = 'done', winner_entry = ? WHERE id = ?").run(e1, final!.id);
    expect(ok(P.finishStage(f.db, { stageId: f.stages[1]!, outcome: { ranks: [{ entryId: e1, rank: 1 }, { entryId: e2, rank: 2 }], advance: [] }, next: null, now: NOW })))
      .toEqual({ eventFinished: true });
    expect(N.getEntry(f.db, e1)).toMatchObject({ status: 'placed', placement: 1 });
    expect(E.getEvent(f.db, f.eventId)).toMatchObject({ status: 'finished', finished_at: NOW.toISOString() });
  });

  it('activeSeeded lists active seeded entries in seed order, without disqualified ones', () => {
    const f = playFixture({ stages: [SE()], entries: 3 });
    f.db.prepare("UPDATE event_entries SET status = 'disqualified', seed = NULL WHERE id = ?").run(f.entries[1]);
    expect(P.activeSeeded(f.db, f.eventId)).toEqual([f.entries[0], f.entries[2]]);
  });
});
```

(The direct `UPDATE event_matches` in the last test is test setup and is allowed: the guard scans `src/` only.)

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run tests/play.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the writer**

Create `src/events/play.ts`:

```ts
import type { DB } from '../db.js';
import { bracketMatches, type BracketData } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as V from './validate.js';

/**
 * Every write to event_matches, and the moves of an event and its stages
 * once play starts (tournaments plan T2). Same shape as events.ts and
 * entries.ts: each mutation is one synchronous transaction that re-reads,
 * checks, writes and adds exactly one event_log row; a refusal writes
 * nothing (tests/eventLogGuard.test.ts). The async work (brackets-manager,
 * pairing) happens before, in src/events/flow.ts, which passes its output in
 * here. Anything that may have moved since is checked again inside the
 * transaction and refused as 'changed', and a bracket write carries the
 * revision it was built on.
 */

export type MatchStatus = 'pending' | 'waiting' | 'veto' | 'lineup' | 'booking' | 'connect' | 'live' | 'confirming' | 'done' | 'forfeit' | 'bye' | 'admin_hold';
export interface MatchRow {
  id: number; event_id: number; stage_id: number; grp: number; round: number; slot: number; bm_match_id: number | null;
  entry_a: number | null; entry_b: number | null; status: MatchStatus; best_of: number; not_before: string | null;
  scheduled_at: string | null; window_start: string | null; window_end: string | null; booking_id: number | null;
  winner_entry: number | null; score_a: number | null; score_b: number | null; result_source: 'auto' | 'admin' | 'forfeit' | null;
  created_at: string; finished_at: string | null;
}
export interface NewRound { round: number; pairs: [number, number][]; bye: number | null }
export interface StagePlan { stageId: number; entrants: number[]; bracket: BracketData | null; rounds: NewRound[] }
export interface StageOutcome { ranks: { entryId: number; rank: number }[]; advance: number[] }

export const RESOLVED: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['done', 'forfeit', 'bye']);

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
const sameList = (x: number[], y: number[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);

export function getMatch(db: DB, id: number): MatchRow | undefined {
  return db.prepare('SELECT * FROM event_matches WHERE id = ?').get(id) as MatchRow | undefined;
}
export function matchesOf(db: DB, stageId: number): MatchRow[] {
  return db.prepare('SELECT * FROM event_matches WHERE stage_id = ? ORDER BY grp, round, slot').all(stageId) as MatchRow[];
}
export function stageEntrants(stage: E.StageRow): number[] {
  return stage.entrants_json ? JSON.parse(stage.entrants_json) as number[] : [];
}
export function stageBracket(stage: E.StageRow): BracketData | null {
  return stage.bracket_json ? JSON.parse(stage.bracket_json) as BracketData : null;
}
/** Entries still in the event that have a seed, best seed first. */
export function activeSeeded(db: DB, eventId: number): number[] {
  return N.entriesOf(db, eventId).filter((e) => N.isActive(e) && e.seed !== null)
    .sort((a, b) => a.seed! - b.seed!).map((e) => e.id);
}
/** Rounds a paired-as-it-goes stage plays; null for bracket stages and
 *  round robin leagues, whose matches all exist from the start. */
export function totalRounds(stage: E.StageRow): number | null {
  const s = E.stageSettingsOf(stage);
  if (s.type === 'swiss') return (s.config as V.StageConfigs['swiss']).rounds;
  if (s.type === 'league') {
    const c = s.config as V.StageConfigs['league'];
    return c.pairing === 'swiss' ? c.matches : null;
  }
  return null;
}

function insertRound(db: DB, eventId: number, stageId: number, r: NewRound, at: string): void {
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, created_at, finished_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  r.pairs.forEach(([a, b], i) => ins.run(eventId, stageId, r.round, i + 1, a, b, 'waiting', null, at, null));
  if (r.bye !== null) ins.run(eventId, stageId, r.round, r.pairs.length + 1, r.bye, null, 'bye', r.bye, at, at);
}

/** Brings the stage's rows in line with its bracket: inserts new matches,
 *  updates teams, states and results, and deletes rows of matches that are no
 *  longer played and have no result (a grand final reset that turned out not
 *  to be needed after a correction). result_source is set by recordResult for
 *  the match it reports; a row whose result the bracket dropped loses it. */
function syncBracket(db: DB, eventId: number, stageId: number, data: BracketData, at: string): void {
  const rows = new Map(matchesOf(db, stageId).filter((m) => m.bm_match_id !== null).map((m) => [m.bm_match_id!, m]));
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, bm_match_id, entry_a, entry_b, status, winner_entry, score_a, score_b, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare(
    `UPDATE event_matches SET entry_a = ?, entry_b = ?, status = ?, winner_entry = ?, score_a = ?, score_b = ?,
       result_source = ?, finished_at = ? WHERE id = ?`,
  );
  const seen = new Set<number>();
  for (const b of bracketMatches(data)) {
    seen.add(b.bmId);
    const status: MatchStatus = b.state === 'done' ? (b.forfeit ? 'forfeit' : 'done') : b.state === 'ready' ? 'waiting' : 'pending';
    const resolved = b.state === 'done';
    const row = rows.get(b.bmId);
    if (!row) {
      ins.run(eventId, stageId, b.group, b.round, b.number, b.bmId, b.a, b.b, status, b.winner, b.scoreA, b.scoreB, at, resolved ? at : null);
      continue;
    }
    upd.run(b.a, b.b, status, b.winner, b.scoreA, b.scoreB, resolved ? row.result_source : null, resolved ? row.finished_at ?? at : null, row.id);
  }
  const del = db.prepare('DELETE FROM event_matches WHERE id = ?');
  for (const [bmId, row] of rows) if (!seen.has(bmId) && !RESOLVED.has(row.status)) del.run(row.id);
}

function openStage(db: DB, eventId: number, plan: StagePlan, at: string): void {
  db.prepare(
    "UPDATE event_stages SET status = 'live', started_at = ?, entrants_json = ?, bracket_json = ?, bracket_rev = 1, updated_at = ? WHERE id = ?",
  ).run(at, JSON.stringify(plan.entrants), plan.bracket ? JSON.stringify(plan.bracket) : null, at, plan.stageId);
  if (plan.bracket) syncBracket(db, eventId, plan.stageId, plan.bracket, at);
  for (const r of plan.rounds) insertRound(db, eventId, plan.stageId, r, at);
}

/** Ruling 5: checkin or registration -> live, once the list is final, with
 *  the first stage built from the active seeded entries. by is null when the
 *  clock starts it. */
export function startEvent(db: DB, o: { eventId: number; by: string | null; plan: StagePlan; now?: Date }): V.Checked<E.EventRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<E.EventRow> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'live')) return V.fail('wrong_status');
    if (ev.locked_at === null) return V.fail('list_not_final');
    const first = E.stagesOf(db, ev.id)[0];
    if (!first || first.status !== 'pending') return V.fail('wrong_status');
    const seeded = activeSeeded(db, ev.id);
    if (seeded.length < 2) return V.fail('too_few_entries');
    if (o.plan.stageId !== first.id || !sameList(o.plan.entrants, seeded)) return V.fail('changed');
    db.prepare("UPDATE events SET status = 'live', live_at = ?, updated_at = ? WHERE id = ?").run(at, at, ev.id);
    openStage(db, ev.id, o.plan, at);
    E.logEvent(db, ev.id, o.by, 'event_started', at, { stageId: first.id, entries: seeded.length });
    return V.ok(E.getEvent(db, ev.id)!);
  })();
}

function laterRound(db: DB, stageId: number, round: number): boolean {
  return !!db.prepare('SELECT 1 FROM event_matches WHERE stage_id = ? AND round > ? LIMIT 1').get(stageId, round);
}

/** A result or a correction (Rulings 1 and 8). For a bracket match, bracket
 *  is the stage's bracket after the library took the result, built on
 *  baseRev. by null is the engine (a disqualification forfeit, Ruling 9). */
export function recordResult(
  db: DB, o: { matchId: number; by: string | null; result: V.ResultInput; bracket: { data: BracketData; baseRev: number } | null; now?: Date },
): V.Checked<MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<MatchRow> => {
    const m = getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const stage = E.getStage(db, m.stage_id)!;
    const ev = E.getEvent(db, m.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    if (m.entry_a === null || m.entry_b === null || !(m.status === 'waiting' || m.status === 'done' || m.status === 'forfeit')) {
      return V.fail('match_not_open');
    }
    if ((m.bm_match_id === null) !== (o.bracket === null)) return V.fail('bad_request');
    const correction = m.status !== 'waiting';
    if (correction && m.bm_match_id === null && laterRound(db, stage.id, m.round)) return V.fail('result_locked');
    const winner = o.result.winner === 'a' ? m.entry_a : m.entry_b;
    if (o.bracket) {
      if (stage.bracket_rev !== o.bracket.baseRev) return V.fail('changed');
      db.prepare('UPDATE event_stages SET bracket_json = ?, bracket_rev = bracket_rev + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(o.bracket.data), at, stage.id);
      syncBracket(db, ev.id, stage.id, o.bracket.data, at);
      if (getMatch(db, m.id)?.winner_entry !== winner) throw new Error(`bracket disagrees with the result of event match ${m.id}`);
    }
    db.prepare(
      'UPDATE event_matches SET status = ?, winner_entry = ?, score_a = ?, score_b = ?, result_source = ?, finished_at = ? WHERE id = ?',
    ).run(o.result.forfeit ? 'forfeit' : 'done', winner, o.result.scoreA, o.result.scoreB, o.result.forfeit ? 'forfeit' : 'admin', at, m.id);
    E.logEvent(db, ev.id, o.by, 'result_recorded', at, {
      matchId: m.id, winner, scoreA: o.result.scoreA, scoreB: o.result.scoreB, forfeit: o.result.forfeit, correction,
    });
    return V.ok(getMatch(db, m.id)!);
  })();
}

/** The next Swiss or Swiss-paired league round (Ruling 6), once every match
 *  of the stage has a result. Always the engine. */
export function addRound(db: DB, o: { stageId: number; round: NewRound; now?: Date }): V.Checked<null> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<null> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    const ev = E.getEvent(db, stage.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    const ms = matchesOf(db, stage.id);
    const last = Math.max(0, ...ms.map((m) => m.round));
    if (o.round.round !== last + 1 || ms.some((m) => !RESOLVED.has(m.status))) return V.fail('changed');
    const total = totalRounds(stage);
    if (total === null || o.round.round > total) return V.fail('wrong_status');
    insertRound(db, ev.id, stage.id, o.round, at);
    E.logEvent(db, ev.id, null, 'round_paired', at, { stageId: stage.id, round: o.round.round, pairs: o.round.pairs.length, bye: o.round.bye });
    return V.ok(null);
  })();
}

/** Ends a stage whose every match has a result (Rulings 13 and 14). With a
 *  next plan, entrants not advancing become eliminated, placed below the
 *  advancers in rank order, and the next stage goes live. Without one, the
 *  ranked entrants are placed and the event finishes. Disqualified entries
 *  are never touched. Always the engine. */
export function finishStage(db: DB, o: { stageId: number; outcome: StageOutcome; next: StagePlan | null; now?: Date }): V.Checked<{ eventFinished: boolean }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ eventFinished: boolean }> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    const ev = E.getEvent(db, stage.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    const ms = matchesOf(db, stage.id);
    if (ms.length === 0 || ms.some((m) => !RESOLVED.has(m.status))) return V.fail('changed');
    if (o.next) {
      const nextStage = E.getStage(db, o.next.stageId);
      if (!nextStage || nextStage.event_id !== ev.id || nextStage.ordinal !== stage.ordinal + 1 || nextStage.status !== 'pending'
        || !sameList(o.next.entrants, o.outcome.advance)) {
        return V.fail('changed');
      }
    }
    db.prepare("UPDATE event_stages SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(at, at, stage.id);
    const place = db.prepare("UPDATE event_entries SET status = ?, placement = ? WHERE id = ? AND status NOT IN ('dropped', 'disqualified')");
    const ranks = [...o.outcome.ranks].sort((x, y) => x.rank - y.rank);
    if (o.next) {
      const going = new Set(o.outcome.advance);
      let n = o.outcome.advance.length;
      for (const r of ranks) if (!going.has(r.entryId)) place.run('eliminated', ++n, r.entryId);
      openStage(db, ev.id, o.next, at);
    } else {
      for (const r of ranks) place.run('placed', r.rank, r.entryId);
      db.prepare("UPDATE events SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(at, at, ev.id);
    }
    E.logEvent(db, ev.id, null, 'stage_finished', at, { stageId: stage.id, advance: o.outcome.advance, eventFinished: !o.next });
    return V.ok({ eventFinished: !o.next });
  })();
}
```

- [ ] **Step 5: Run the writer tests**

Run: `npx vitest run tests/play.test.ts`
Expected: PASS.

- [ ] **Step 6: Widen the guard (failing first)**

In `tests/eventLogGuard.test.ts`:

1. Add imports: `import * as P from '../src/events/play.js';`, `import { createBracket } from '../src/events/bracket.js';`, `import { SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';`.
2. Change `ENGINE` to `new Set(['src/events/events.ts', 'src/events/entries.ts', 'src/events/play.ts'])` and the first test's name to `'only src/events/events.ts, entries.ts and play.ts write the event tables'`.
3. In the entry-tables test, allow `src/events/play.ts` too: `.filter((f) => f !== 'src/events/entries.ts' && f !== 'src/events/play.ts' && f !== 'src/mergePlayers.ts')`.
4. Add after the entries guard `describe`, inside the outer `describe`:

```ts
  /** Plan T2: src/events/play.ts is the only writer of event_matches, and
   *  its mutations follow the same one-row rule. */
  describe('play guard (src/events/play.ts)', () => {
    const MATCH_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+event_matches\b/gi;
    const PLAY_READS = new Set(['getMatch', 'matchesOf', 'stageEntrants', 'stageBracket', 'activeSeeded', 'totalRounds']);
    const aWins = { winner: 'a' as const, scoreA: 10, scoreB: 5, forfeit: false };
    const ok = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const plan = (f: PlayFixture): P.StagePlan => ({
      stageId: f.stages[0]!, entrants: f.entries, bracket: null,
      rounds: [{ round: 1, pairs: [[f.entries[0]!, f.entries[2]!], [f.entries[1]!, f.entries[3]!]], bye: null }],
    });
    const started = (f: PlayFixture) => ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: plan(f), now: NOW }));
    const allPlayed = (f: PlayFixture) => {
      for (const m of P.matchesOf(f.db, f.stages[0]!)) if (m.status === 'waiting') ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    };
    const PLAY_MUTATIONS: Record<string, { action: string; actor: string | null; setup: (f: PlayFixture) => void; run: (f: PlayFixture) => V.Checked<unknown> }> = {
      startEvent: { action: 'event_started', actor: ADMIN, setup: () => {}, run: (f) => P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: plan(f), now: NOW }) },
      recordResult: {
        action: 'result_recorded', actor: ADMIN, setup: started,
        run: (f) => P.recordResult(f.db, { matchId: P.matchesOf(f.db, f.stages[0]!)[0]!.id, by: ADMIN, result: aWins, bracket: null, now: NOW }),
      },
      addRound: {
        action: 'round_paired', actor: null, setup: (f) => { started(f); allPlayed(f); },
        run: (f) => P.addRound(f.db, { stageId: f.stages[0]!, round: { round: 2, pairs: [[f.entries[0]!, f.entries[1]!], [f.entries[2]!, f.entries[3]!]], bye: null }, now: NOW }),
      },
      finishStage: {
        action: 'stage_finished', actor: null, setup: (f) => { started(f); allPlayed(f); },
        run: (f) => P.finishStage(f.db, { stageId: f.stages[0]!, outcome: { ranks: f.entries.map((entryId, i) => ({ entryId, rank: i + 1 })), advance: [] }, next: null, now: NOW }),
      },
    };
    const fixture = () => playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const rows = (f: PlayFixture) => JSON.stringify(['events', 'event_stages', 'event_entries', 'event_matches']
      .map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

    it('only src/events/play.ts writes event_matches', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/play.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(MATCH_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
    });

    it('every exported function of play.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(P).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !PLAY_READS.has(k)).sort()).toEqual(Object.keys(PLAY_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(PLAY_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = fixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: m.actor });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = fixture();
        m.setup(f);
        const before = rows(f);
        f.db.exec(`CREATE TRIGGER play_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
      });
    }

    it('a bracket start and result write nothing either when the audit row fails', async () => {
      const f = playFixture({ stages: [SE()], entries: 4 });
      const bracket = await createBracket('single_elim', { thirdPlace: false }, f.entries);
      const before = rows(f);
      f.db.exec("CREATE TRIGGER bracket_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
      expect(() => P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: { stageId: f.stages[0]!, entrants: f.entries, bracket, rounds: [] }, now: NOW })).toThrow(/audit down/);
      expect(rows(f)).toBe(before);
    });
  });
```

`finishStage` itself only checks that every match of the stage has a result. Whether the stage has played all its rounds is the flow's question (Task 6), so the guard can finish a 2-round Swiss stage after round 1.

- [ ] **Step 7: Run the guard**

Run: `npx vitest run tests/eventLogGuard.test.ts tests/play.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/events/play.ts tests/play.test.ts tests/playFixture.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T2: the play writer for event_matches, event start, results, Swiss rounds and stage ends, held to the one audit row rule"
```

---

### Task 6: The flow

**Files:**
- Create: `src/events/flow.ts`
- Test: `tests/eventFlow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 to 5.
- Produces:
  - `serialize<T>(eventId: number, fn: () => Promise<T>): Promise<T>`, which runs one event's flow calls one at a time, in call order
  - `planStage(stage: E.StageRow, entrants: number[]): Promise<V.Checked<P.StagePlan>>`
  - `interface TableRow extends StandingRow { group: number; groupRank: number }`; `stageTable(db, stage): TableRow[]` (overall order; `rank` overall, `groupRank` inside the group)
  - `stageOutcome(db, stage): Promise<P.StageOutcome>`
  - `startEventFlow(db, { eventId, by: string | null, now?: Date }): Promise<V.Checked<E.EventRow>>`
  - `recordResultFlow(db, { eventId, matchId, by: string, result: unknown, now?: Date }): Promise<V.Checked<P.MatchRow>>`, which settles after a success
  - `settleEvent(db, { eventId, now?: Date }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/eventFlow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as F from '../src/events/flow.js';
import * as P from '../src/events/play.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { ADMIN, NOW } from './eventFixture.js';
import { DE, LEAGUE, RR, SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const live = (f: PlayFixture) => E.stagesOf(f.db, f.eventId).find((s) => s.status === 'live');
const open = (f: PlayFixture) => { const s = live(f); return s ? P.matchesOf(f.db, s.id).filter((m) => m.status === 'waiting') : []; };
/** Reports every open match (the lower entry id wins unless `pick` says
 *  otherwise) until nothing is open or the event is over. */
async function playOut(f: PlayFixture, pick: (m: P.MatchRow) => 'a' | 'b' = (m) => (m.entry_a! < m.entry_b! ? 'a' : 'b')) {
  for (let i = 0; i < 200 && open(f).length > 0; i++) {
    const m = open(f)[0]!;
    const w = pick(m);
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW,
      result: { winner: w, scoreA: w === 'a' ? 10 : 5, scoreB: w === 'a' ? 5 : 10 } }));
  }
}

describe('event flow', () => {
  it('Swiss to single elimination: rounds pair themselves, the top 4 carry over, and the event finishes with places', async () => {
    const f = playFixture({ stages: [SWISS(3, 4), SE(true)], entries: 8 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(open(f)).toHaveLength(4);
    await playOut(f);
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(ev.status).toBe('finished');
    const [s1, s2] = E.stagesOf(f.db, f.eventId);
    expect(Math.max(...P.matchesOf(f.db, s1!.id).map((m) => m.round))).toBe(3);
    expect(P.stageEntrants(s2!)).toHaveLength(4);
    const placed = N.entriesOf(f.db, f.eventId).map((e) => [e.status, e.placement]);
    expect(placed.filter(([s]) => s === 'placed').map(([, p]) => p).sort()).toEqual([1, 2, 3, 4]);
    expect(placed.filter(([s]) => s === 'eliminated').map(([, p]) => p).sort()).toEqual([5, 6, 7, 8]);
    // Seed 1 (lowest id) wins every match it plays.
    expect(N.getEntry(f.db, f.entries[0]!)!.placement).toBe(1);
  });

  it('double elimination where the lower side wins the first grand final plays the reset', async () => {
    const f = playFixture({ stages: [DE(true)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    await playOut(f, (m) => (m.grp === 3 ? 'b' : m.entry_a! < m.entry_b! ? 'a' : 'b'));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(P.matchesOf(f.db, s.id).filter((m) => m.grp === 3).map((m) => m.round)).toEqual([1, 2]);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
  });

  it('round robin groups advance the top of each group, group winners seeded first', async () => {
    const f = playFixture({ stages: [RR(2, 4), SE()], entries: 8 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s1 = E.stagesOf(f.db, f.eventId)[0]!;
    while (open(f).length > 0 && live(f)!.id === s1.id) {
      const m = open(f)[0]!;
      ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: m.entry_a! < m.entry_b! ? 'a' : 'b', forfeit: true } }));
    }
    const table = F.stageTable(f.db, E.getStage(f.db, s1.id)!);
    const s2 = E.stagesOf(f.db, f.eventId)[1]!;
    const carried = P.stageEntrants(s2);
    expect(carried).toHaveLength(4);
    const groupOf = new Map(table.map((r) => [r.entryId, r]));
    expect(carried.slice(0, 2).every((id) => groupOf.get(id)!.groupRank === 1)).toBe(true);
    expect(new Set(carried.slice(0, 2).map((id) => groupOf.get(id)!.group)).size).toBe(2);
  });

  it('a round robin league of 5 teams plays its full match count: every round written at the start, byes as wins, every team on 7 results', async () => {
    const f = playFixture({ stages: [LEAGUE(7, 2, 'round_robin', null)], entries: 5 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(new Set(P.matchesOf(f.db, s.id).map((m) => m.round)).size).toBe(7);
    await playOut(f);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
    const table = F.stageTable(f.db, E.getStage(f.db, s.id)!);
    expect(table.every((r) => r.played + r.byes === 7)).toBe(true);
    expect(table.map((r) => r.byes).sort()).toEqual([1, 1, 1, 2, 2]);
  });

  it('a 4-team round robin league of 7 matches meets every pair twice and two pairs a third time', async () => {
    const f = playFixture({ stages: [LEAGUE(7, 1, 'round_robin', null)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const ms = P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id);
    expect(ms).toHaveLength(14);
    expect(ms.every((m) => m.status === 'waiting')).toBe(true);
  });

  it('a Swiss-paired league plays its match count in rounds', async () => {
    const f = playFixture({ stages: [LEAGUE(4, 2, 'swiss', null)], entries: 6 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    await playOut(f);
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(Math.max(...P.matchesOf(f.db, s.id).map((m) => m.round))).toBe(4);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
  });

  it('a team disqualified mid-Swiss forfeits its open match, is never paired again, and gets no place', async () => {
    const f = playFixture({ stages: [SWISS(3, null)], entries: 6 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const out = f.entries[5]!;
    ok(N.disqualifyEntry(f.db, { entryId: out, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    const theirs = P.matchesOf(f.db, s.id).find((m) => m.entry_a === out || m.entry_b === out)!;
    expect(theirs).toMatchObject({ status: 'forfeit', result_source: 'forfeit' });
    expect(theirs.winner_entry).not.toBe(out);
    expect(E.eventLog(f.db, f.eventId).find((l) => l.action === 'result_recorded')!.actor).toBeNull();
    await playOut(f);
    const later = P.matchesOf(f.db, s.id).filter((m) => m.round > 1);
    expect(later.some((m) => m.entry_a === out || m.entry_b === out)).toBe(false);
    expect(N.getEntry(f.db, out)).toMatchObject({ status: 'disqualified', placement: null });
    expect(F.stageTable(f.db, E.getStage(f.db, s.id)!).at(-1)!.entryId).toBe(out);
  });

  it('a correction after the next bracket match is played is refused and changes nothing', async () => {
    const g = playFixture({ stages: [SE()], entries: 8 });
    ok(await F.startEventFlow(g.db, { eventId: g.eventId, by: ADMIN, now: NOW }));
    const r1 = open(g);
    for (const m of r1.slice(0, 2)) ok(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    const semi = open(g).find((m) => m.round === 2)!;
    ok(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: semi.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    const snap = JSON.stringify([g.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), g.db.prepare('SELECT bracket_json, bracket_rev FROM event_stages').all()]);
    expect(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: r1[0]!.id, by: ADMIN, now: NOW, result: { winner: 'b', scoreA: 1, scoreB: 2 } }))
      .toEqual({ ok: false, error: 'result_locked' });
    expect(JSON.stringify([g.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), g.db.prepare('SELECT bracket_json, bracket_rev FROM event_stages').all()])).toBe(snap);
  });

  it('two results for one match at once: one lands, the other is a correction, the bracket takes exactly one revision each', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const m = open(f)[0]!;
    const rev = () => E.stagesOf(f.db, f.eventId)[0]!.bracket_rev;
    const before = rev();
    const [x, y] = await Promise.all([
      F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }),
      F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'b', scoreA: 1, scoreB: 2 } }),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect(rev()).toBe(before + 2);
    expect(P.getMatch(f.db, m.id)!.winner_entry).toBe(m.entry_b);
    const logs = E.eventLog(f.db, f.eventId).filter((l) => l.action === 'result_recorded').map((l) => JSON.parse(l.detail).correction);
    expect(logs).toEqual([false, true]);
  });

  it('a refused result writes nothing: bad body, unknown match, another event, a pending match', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const pending = P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id).find((m) => m.status === 'pending')!;
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: open(f)[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 1, scoreB: 1 } }))
      .toEqual({ ok: false, error: 'bad_result' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: 99999, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_found' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId + 1, matchId: open(f)[0]!.id, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_found' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: pending.id, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_open' });
  });

  it('settle is idempotent: a second call changes nothing', async () => {
    const f = playFixture({ stages: [SWISS(2, null)], entries: 5 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
  });

  it('serialize runs one event in call order and lets other events through', async () => {
    const seen: string[] = [];
    const slow = (tag: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { seen.push(tag); r(); }, ms));
    await Promise.all([F.serialize(1, slow('1a', 20)), F.serialize(1, slow('1b', 0)), F.serialize(2, slow('2a', 5))]);
    expect(seen).toEqual(['2a', '1a', '1b']);
    await expect(F.serialize(3, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await F.serialize(3, async () => 'after')).toBe('after');
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/eventFlow.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/events/flow.ts`:

```ts
import type { DB } from '../db.js';
import { BracketError, bracketComplete, bracketGroups, bracketRanks, createBracket, reportResult, type BracketType } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import { repeatedRoundRobin } from './league.js';
import { standings, type StandingRow, type TableResult } from './standings.js';
import { pairSwiss } from './swiss.js';
import * as V from './validate.js';

/**
 * Runs an event once it plays (tournaments plan T2). Every call that changes
 * an event goes through serialize, so one event's starts, results and
 * settles never interleave; different events run side by side. The async
 * steps (brackets-manager, pairing) run here, and src/events/play.ts writes
 * their output in one transaction. settleEvent moves an event as far as it
 * can: forfeits for disqualified teams (Ruling 9), the end of a stage and the
 * start of the next (Rulings 6, 13, 14), the next Swiss round. Each step is
 * one play.ts mutation, and settle stops when a pass changes nothing, so
 * calling it again is harmless.
 */

const chains = new Map<number, Promise<unknown>>();

export function serialize<T>(eventId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(eventId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(eventId, tail);
  void tail.then(() => { if (chains.get(eventId) === tail) chains.delete(eventId); });
  return run;
}

const isBracket = (t: V.StageType): t is BracketType => t === 'single_elim' || t === 'double_elim' || t === 'round_robin';
const OUT: ReadonlySet<string> = new Set(['dropped', 'disqualified']);

function outOf(db: DB, ids: number[]): Set<number> {
  return new Set(ids.filter((id) => OUT.has(N.getEntry(db, id)?.status ?? 'dropped')));
}
const toResult = (m: P.MatchRow): TableResult => ({
  a: m.entry_a!, b: m.status === 'bye' ? null : m.entry_b, winner: m.winner_entry!, scoreA: m.score_a, scoreB: m.score_b,
});

/** The first matches of a stage for these entrants (best seed first). */
export async function planStage(stage: E.StageRow, entrants: number[]): Promise<V.Checked<P.StagePlan>> {
  if (entrants.length < 2) return V.fail('too_few_entries');
  const s = E.stageSettingsOf(stage);
  if (isBracket(s.type)) {
    return V.ok({ stageId: stage.id, entrants, bracket: await createBracket(s.type, s.config as V.StageConfigs[BracketType], entrants), rounds: [] });
  }
  if (s.type === 'league' && (s.config as V.StageConfigs['league']).pairing === 'round_robin') {
    const rounds = repeatedRoundRobin(entrants, (s.config as V.StageConfigs['league']).matches);
    return V.ok({ stageId: stage.id, entrants, bracket: null, rounds: rounds.map((r, i) => ({ round: i + 1, ...r })) });
  }
  const seeds = entrants.map((id, i) => ({ id, seed: i + 1 }));
  return V.ok({ stageId: stage.id, entrants, bracket: null, rounds: [{ round: 1, ...pairSwiss(seeds, [], P.totalRounds(stage) ?? 1) }] });
}

export interface TableRow extends StandingRow { group: number; groupRank: number }

/** A table stage's standings: one table per round robin group, else one.
 *  With groups, the overall order is group place first, then wins, score
 *  difference and stage seed (Ruling 3); rank is that overall place. */
export function stageTable(db: DB, stage: E.StageRow): TableRow[] {
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);
  const s = E.stageSettingsOf(stage);
  const kind = s.type === 'swiss' ? 'swiss' : s.type === 'league' ? 'league' : 'round_robin';
  const rounds = P.totalRounds(stage) ?? 0;
  const results = P.matchesOf(db, stage.id).filter((m) => P.RESOLVED.has(m.status) && m.winner_entry !== null).map(toResult);
  const seed = new Map(entrants.map((id, i) => [id, i + 1]));
  const bracket = P.stageBracket(stage);
  const groupOf = s.type === 'round_robin' && bracket ? bracketGroups(bracket) : new Map<number, number>();
  const groups = new Map<number, number[]>();
  for (const id of entrants) {
    const g = groupOf.get(id) ?? 1;
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const rows: TableRow[] = [];
  for (const [g, ids] of [...groups].sort((x, y) => x[0] - y[0])) {
    const inGroup = new Set(ids);
    const table = standings(kind, ids.map((id) => ({ id, seed: seed.get(id)!, out: out.has(id) })), results.filter((r) => inGroup.has(r.a)), { rounds });
    for (const r of table) rows.push({ ...r, group: g, groupRank: r.rank });
  }
  if (groups.size <= 1) return rows;
  return rows
    .sort((x, y) => Number(x.out) - Number(y.out) || x.groupRank - y.groupRank || y.wins - x.wins || y.scoreDiff - x.scoreDiff
      || seed.get(x.entryId)! - seed.get(y.entryId)!)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Who placed where in a finished stage and who carries over. Disqualified
 *  entries are left out of both. */
export async function stageOutcome(db: DB, stage: E.StageRow): Promise<P.StageOutcome> {
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);
  const type = E.stageSettingsOf(stage).type;
  if (type === 'single_elim' || type === 'double_elim') {
    const ranks = (await bracketRanks(P.stageBracket(stage)!)).filter((r) => !out.has(r.entryId));
    return { ranks, advance: [] };
  }
  const ranked = stageTable(db, stage).filter((r) => !r.out);
  const n = Math.min(stage.advance_count ?? 0, ranked.length);
  return { ranks: ranked.map((r, i) => ({ entryId: r.entryId, rank: i + 1 })), advance: ranked.slice(0, n).map((r) => r.entryId) };
}

function stageComplete(db: DB, stage: E.StageRow): boolean {
  const ms = P.matchesOf(db, stage.id);
  if (ms.length === 0 || ms.some((m) => !P.RESOLVED.has(m.status))) return false;
  const bracket = P.stageBracket(stage);
  if (bracket) return bracketComplete(bracket);
  const total = P.totalRounds(stage);
  return total === null || Math.max(...ms.map((m) => m.round)) >= total;
}

/** Inside serialize only. */
async function report(db: DB, m: P.MatchRow, by: string | null, result: V.ResultInput, now?: Date): Promise<V.Checked<P.MatchRow>> {
  if (m.bm_match_id === null) return P.recordResult(db, { matchId: m.id, by, result, bracket: null, now });
  const stage = E.getStage(db, m.stage_id)!;
  if (stage.status !== 'live') return V.fail('not_live');
  const base = P.stageBracket(stage);
  if (!base) return V.fail('wrong_status');
  let data;
  try {
    data = await reportResult(base, m.bm_match_id, result);
  } catch (err) {
    if (err instanceof BracketError) return V.fail(err.code === 'locked' ? 'result_locked' : 'match_not_open');
    throw err;
  }
  return P.recordResult(db, { matchId: m.id, by, result, bracket: { data, baseRev: stage.bracket_rev }, now });
}

export function startEventFlow(db: DB, o: { eventId: number; by: string | null; now?: Date }): Promise<V.Checked<E.EventRow>> {
  return serialize(o.eventId, async (): Promise<V.Checked<E.EventRow>> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'live')) return V.fail('wrong_status');
    if (ev.locked_at === null) return V.fail('list_not_final');
    const first = E.stagesOf(db, ev.id)[0];
    if (!first) return V.fail('no_stages');
    const plan = await planStage(first, P.activeSeeded(db, ev.id));
    if (!plan.ok) return plan;
    return P.startEvent(db, { eventId: ev.id, by: o.by, plan: plan.value, now: o.now });
  });
}

export async function recordResultFlow(
  db: DB, o: { eventId: number; matchId: number; by: string; result: unknown; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const parsed = V.parseResult(o.result);
  if (!parsed.ok) return parsed;
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    return report(db, m, o.by, parsed.value, o.now);
  });
  if (r.ok) await settleEvent(db, { eventId: o.eventId, now: o.now });
  return r;
}

export function settleEvent(db: DB, o: { eventId: number; now?: Date }): Promise<void> {
  return serialize(o.eventId, async () => {
    for (let i = 0; i < 100; i++) if (!(await settleOnce(db, o.eventId, o.now))) return;
    console.error(`[events] settle of event ${o.eventId} did not come to rest`);
  });
}

/** One step; true when it changed something. */
async function settleOnce(db: DB, eventId: number, now?: Date): Promise<boolean> {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status !== 'live') return false;
  const stage = E.stagesOf(db, ev.id).find((s) => s.status === 'live');
  if (!stage) return false;
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);

  for (const m of P.matchesOf(db, stage.id)) {
    if (m.status !== 'waiting' || m.entry_a === null || m.entry_b === null) continue;
    const aOut = out.has(m.entry_a);
    if (aOut === out.has(m.entry_b)) continue;
    const r = await report(db, m, null, { winner: aOut ? 'b' : 'a', scoreA: null, scoreB: null, forfeit: true }, now);
    if (r.ok) return true;
  }

  if (stageComplete(db, stage)) {
    const outcome = await stageOutcome(db, stage);
    const nextStage = E.stagesOf(db, ev.id).find((s) => s.ordinal === stage.ordinal + 1);
    let next: P.StagePlan | null = null;
    if (nextStage && outcome.advance.length >= 2) {
      const plan = await planStage(nextStage, outcome.advance);
      if (!plan.ok) {
        console.error(`[events] event ${ev.id}: stage ${nextStage.ordinal} cannot start: ${plan.error}`);
        return false;
      }
      next = plan.value;
    }
    return P.finishStage(db, { stageId: stage.id, outcome, next, now }).ok;
  }

  const total = P.totalRounds(stage);
  const ms = P.matchesOf(db, stage.id);
  if (P.stageBracket(stage) === null && total !== null && ms.every((m) => P.RESOLVED.has(m.status))) {
    const last = Math.max(0, ...ms.map((m) => m.round));
    if (last < total) {
      const still = entrants.filter((id) => !out.has(id)).map((id) => ({ id, seed: entrants.indexOf(id) + 1 }));
      const results = ms.filter((m) => m.winner_entry !== null).map(toResult);
      return P.addRound(db, { stageId: stage.id, round: { round: last + 1, ...pairSwiss(still, results, total) }, now }).ok;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/eventFlow.test.ts`
Expected: PASS. In the `serialize` test, `1b` has no delay but must still come after `1a`, which takes 20 ms, while `2a` (another event) is free to finish first.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npx vitest run tests/play.test.ts tests/eventLogGuard.test.ts`
Expected: PASS.

```bash
git add src/events/flow.ts tests/eventFlow.test.ts
git commit -m "Tournaments T2: the event flow, start, results and corrections through the bracket, forfeits for disqualified teams, Swiss rounds, stage hand-over and the finish"
```

---

### Task 7: The clock starts and settles events

**Files:**
- Modify: `src/events/runner.ts`
- Test: `tests/eventRunner.test.ts`

**Interfaces:**
- Consumes: `startEventFlow`, `settleEvent` (Task 6).
- Produces: `EventRunner.play(now: Date): Promise<void>`. `tick()` now runs `step` and then `play`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventRunner.test.ts`. Import `playFixture`, `SWISS`, `SE` from `./playFixture.js`, `ADMIN` from `./eventFixture.js`, `type DB` from `../src/db.js`, `upsertPlayer` from `../src/players.js`, and `* as E`, `* as P`, `* as N` as needed. If the file already builds an `EventRunner` with a stub notifier, use that stub in place of the one below.

```ts
describe('EventRunner.play (plan T2)', () => {
  const runner = (db: DB) => new EventRunner({ db, notifier: { notify: () => {} } as never, publicUrl: 'http://x' });
  const START_AT = new Date('2026-10-10T20:00:00.000Z');

  it('starts a final event at its start time, not before', async () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    const r = runner(f.db);
    await r.play(new Date(START_AT.getTime() - 60_000));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    await r.play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('live');
    expect(E.eventLog(f.db, f.eventId).at(-1)).toMatchObject({ action: 'event_started', actor: null });
  });

  it('leaves an event with fewer than 2 entries waiting, writing nothing', async () => {
    const f = playFixture({ stages: [SE()], entries: 1 });
    const logs = E.eventLog(f.db, f.eventId).length;
    await runner(f.db).play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(logs);
  });

  it('with check-in off, closes the list and starts in the same tick', async () => {
    const f = playFixture({ stages: [SE()], entries: 2 });
    f.db.prepare("UPDATE events SET status = 'registration', locked_at = NULL, checkin_json = ? WHERE id = ?")
      .run(JSON.stringify({ enabled: false, opensMinutes: 60, closesMinutes: 15 }), f.eventId);
    f.db.prepare("UPDATE event_entries SET status = 'registered'").run();
    // The entries were inserted directly, so they have no starters; give each 4 so the list keeps them.
    const add = f.db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)");
    let n = 900;
    for (const id of f.entries) for (let i = 0; i < 4; i++) {
      const sid = `76561199000000${n++}`;
      upsertPlayer(f.db, { steamid: sid, name: sid, avatar: null }, []);
      add.run(id, sid, START_AT.toISOString());
    }
    const r = runner(f.db);
    r.step(START_AT);
    await r.play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('live');
  });

  it('settles live events: a disqualification on the desk becomes a forfeit on the next tick, and a second tick changes nothing', async () => {
    const f = playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const r = runner(f.db);
    await r.play(START_AT);
    N.disqualifyEntry(f.db, { entryId: f.entries[3]!, by: ADMIN, reason: 'gone', now: START_AT });
    await r.play(START_AT);
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(P.matchesOf(f.db, s.id).some((m) => m.status === 'forfeit')).toBe(true);
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await r.play(START_AT);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/eventRunner.test.ts`
Expected: FAIL (`r.play` is not a function).

- [ ] **Step 3: Implement**

In `src/events/runner.ts`, add the import `import { settleEvent, startEventFlow } from './flow.js';`. Then change `tick()` and add `play`:

```ts
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      this.step(now);
      await this.play(now);
    } catch (err) {
      console.error('[events] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Plan T2 Rulings 5 and 6: start every team event whose list is final and
   * whose start time has come (one with fewer than 2 entries just waits), then
   * settle every live event. Each event is caught on its own.
   */
  async play(now: Date): Promise<void> {
    const { db } = this.deps;
    const due = db.prepare(
      `SELECT id FROM events WHERE entry_kind = 'team' AND status IN ('registration','checkin')
       AND locked_at IS NOT NULL AND starts_at <= ? ORDER BY id`,
    ).all(now.toISOString()) as { id: number }[];
    for (const { id } of due) {
      try {
        await startEventFlow(db, { eventId: id, by: null, now });
      } catch (err) {
        console.error(`[events] start of event ${id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    const live = db.prepare("SELECT id FROM events WHERE status = 'live' ORDER BY id").all() as { id: number }[];
    for (const { id } of live) {
      try {
        await settleEvent(db, { eventId: id, now });
      } catch (err) {
        console.error(`[events] settle of event ${id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
```

Update the class doc comment's first sentence to mention the start and settle step: "... and, from plan T2, start events at their start time and settle live ones (play)."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/eventRunner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/runner.ts tests/eventRunner.test.ts
git commit -m "Tournaments T2: the event tick starts events at their start time and settles live ones"
```

---

### Task 8: Views and routes

**Files:**
- Modify: `src/events/format.ts` (`roundLabel`), `src/events/views.ts`, `src/routes/adminEvents.ts`
- Create: `src/events/playViews.ts`
- Test: `tests/eventFormat.test.ts`, `tests/eventPlayRoutes.test.ts`

**Interfaces:**
- Consumes: `stageTable` (Task 6), `startEventFlow`, `recordResultFlow`, `settleEvent`, `P.matchesOf`, `P.activeSeeded`.
- Produces:
  - `format.ts`: `roundLabel(type: StageType, config: StageConfig, grp: number, round: number, lastRound: number): string`; `groupLabel(type: StageType, grp: number): string`
  - `playViews.ts`: `PlayEntry`, `PlayMatch`, `PlayRound`, `PlayStanding`, `StagePlayView` (shapes below); `stagePlayViews(db, ev): StagePlayView[]` (every stage that has started)
  - `views.ts`: `EventView.play: StagePlayView[]`; `EventEntryView.placement: number | null`
  - Routes: `GET /api/admin/events/:id/play` (staff), giving `AdminEventPlay { status; lockedAt; startsAt; seeded: number; stages: StagePlayView[] }`; `POST /api/admin/events/:id/start` (admin); `POST /api/admin/events/:id/matches/:matchId/result` (admin) with body `{ winner, scoreA?, scoreB?, forfeit? }`. A disqualification of an entry in a live event settles the event before replying.

```ts
export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean;
}
export interface PlayRound { group: number; round: number; label: string; dates: { from: string; to: string } | null; matches: PlayMatch[] }
export interface PlayStanding {
  entry: PlayEntry; group: number; rank: number; groupRank: number; played: number; wins: number; losses: number;
  points: number; buchholz: number; scoreDiff: number;
}
export interface StagePlayView {
  ordinal: number; type: V.StageType; status: 'live' | 'finished'; layout: 'bracket' | 'table';
  groups: { number: number; label: string }[]; rounds: PlayRound[]; standings: PlayStanding[]; advanceCount: number | null;
}
```

- [ ] **Step 1: Write the failing label test**

Append to `tests/eventFormat.test.ts` (import `roundLabel`, `groupLabel` from `../src/events/format.js`):

```ts
describe('round and group labels (plan T2)', () => {
  it('names elimination rounds from the end', () => {
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 3, 3)).toBe('Final');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 2, 3)).toBe('Semifinals');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 2, 4)).toBe('Quarterfinals');
    expect(roundLabel('single_elim', { thirdPlace: true }, 1, 1, 5)).toBe('Round 1');
    expect(roundLabel('single_elim', { thirdPlace: true }, 2, 1, 1)).toBe('Third place');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 1, 2, 3)).toBe('Upper round 2');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 1, 3, 3)).toBe('Upper final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 2, 4, 4)).toBe('Lower final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 3, 1, 2)).toBe('Grand final');
    expect(roundLabel('double_elim', { grandFinalReset: true }, 3, 2, 2)).toBe('Grand final reset');
  });
  it('names table rounds and league weeks', () => {
    expect(roundLabel('swiss', { rounds: 4 }, 1, 2, 4)).toBe('Round 2');
    expect(roundLabel('round_robin', { groups: 2 }, 2, 3, 3)).toBe('Round 3');
    expect(roundLabel('league', { matches: 4, matchesPerWeek: 1, pairing: 'swiss', seasonStart: null }, 1, 3, 4)).toBe('Week 3');
    expect(roundLabel('league', { matches: 8, matchesPerWeek: 2, pairing: 'swiss', seasonStart: null }, 1, 3, 8)).toBe('Week 2, match 1');
  });
  it('names groups', () => {
    expect(groupLabel('round_robin', 1)).toBe('Group A');
    expect(groupLabel('round_robin', 3)).toBe('Group C');
    expect(groupLabel('double_elim', 2)).toBe('Lower bracket');
    expect(groupLabel('single_elim', 1)).toBe('Bracket');
    expect(groupLabel('swiss', 1)).toBe('Rounds');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails, then implement**

Run: `npx vitest run tests/eventFormat.test.ts` (Expected: FAIL.) Then append to `src/events/format.ts`:

```ts
/** What a round is called on the event page (plan T2). lastRound is the
 *  highest round number in the same group. */
export function roundLabel(type: StageType, config: StageConfig, grp: number, round: number, lastRound: number): string {
  switch (type) {
    case 'single_elim': {
      if (grp === 2) return 'Third place';
      const left = lastRound - round;
      return left === 0 ? 'Final' : left === 1 ? 'Semifinals' : left === 2 ? 'Quarterfinals' : `Round ${round}`;
    }
    case 'double_elim':
      if (grp === 3) return round === 1 ? 'Grand final' : 'Grand final reset';
      return `${grp === 1 ? 'Upper' : 'Lower'} ${round === lastRound ? 'final' : `round ${round}`}`;
    case 'league': {
      const per = (config as StageConfigs['league']).matchesPerWeek;
      const week = Math.floor((round - 1) / per) + 1;
      return per === 1 ? `Week ${week}` : `Week ${week}, match ${((round - 1) % per) + 1}`;
    }
    default:
      return `Round ${round}`;
  }
}

export function groupLabel(type: StageType, grp: number): string {
  if (type === 'round_robin') return `Group ${String.fromCharCode(64 + grp)}`;
  if (type === 'single_elim') return grp === 2 ? 'Third place' : 'Bracket';
  if (type === 'double_elim') return grp === 1 ? 'Upper bracket' : grp === 2 ? 'Lower bracket' : 'Grand final';
  return 'Rounds';
}
```

Run: `npx vitest run tests/eventFormat.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the views module**

Create `src/events/playViews.ts`:

```ts
import type { DB } from '../db.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import { stageTable } from './flow.js';
import { groupLabel, roundLabel } from './format.js';
import { weekDates, weekOfRound } from './league.js';
import type * as V from './validate.js';

/** Brackets, standings and rounds of the stages that have started (plan T2),
 *  for the public event page and the desk alike. Never SR. */

export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean;
}
/** dates: a league round's week, first and last day (YYYY-MM-DD); null for
 *  every other stage type. */
export interface PlayRound { group: number; round: number; label: string; dates: { from: string; to: string } | null; matches: PlayMatch[] }
export interface PlayStanding {
  entry: PlayEntry; group: number; rank: number; groupRank: number; played: number; wins: number; losses: number;
  points: number; buchholz: number; scoreDiff: number;
}
export interface StagePlayView {
  ordinal: number; type: V.StageType; status: 'live' | 'finished'; layout: 'bracket' | 'table';
  groups: { number: number; label: string }[]; rounds: PlayRound[]; standings: PlayStanding[]; advanceCount: number | null;
}

export function stagePlayViews(db: DB, ev: E.EventRow): StagePlayView[] {
  const entries = new Map(N.entriesOf(db, ev.id).map((e): [number, PlayEntry] => [e.id, {
    id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, seed: e.seed, out: e.status === 'dropped' || e.status === 'disqualified',
  }]));
  const entry = (id: number | null) => (id === null ? null : entries.get(id) ?? null);
  return E.stagesOf(db, ev.id).filter((s) => s.status !== 'pending').map((s) => {
    const st = E.stageSettingsOf(s);
    const elim = st.type === 'single_elim' || st.type === 'double_elim';
    const ms = P.matchesOf(db, s.id);
    // Ruling 19: week 1 starts on the season start, or the day the stage started.
    const league = st.type === 'league' ? st.config as V.StageConfigs['league'] : null;
    const seasonStart = league ? league.seasonStart ?? (s.started_at ?? ev.starts_at).slice(0, 10) : null;
    const leagueDates = (round: number) => (league && seasonStart ? weekDates(seasonStart, weekOfRound(round, league.matchesPerWeek)) : null);
    const last = new Map<number, number>();
    for (const m of ms) last.set(m.grp, Math.max(last.get(m.grp) ?? 0, m.round));
    const rounds: PlayRound[] = [];
    for (const m of ms) {
      let r = rounds.find((x) => x.group === m.grp && x.round === m.round);
      if (!r) {
        r = { group: m.grp, round: m.round, label: roundLabel(st.type, st.config, m.grp, m.round, last.get(m.grp)!), dates: leagueDates(m.round), matches: [] };
        rounds.push(r);
      }
      const resolved = P.RESOLVED.has(m.status);
      r.matches.push({
        id: m.id, group: m.grp, round: m.round, slot: m.slot, a: entry(m.entry_a), b: entry(m.entry_b), status: m.status,
        winner: !resolved || m.winner_entry === null ? null : m.winner_entry === m.entry_a ? 'a' : 'b',
        scoreA: m.score_a, scoreB: m.score_b, forfeit: m.status === 'forfeit', bye: m.status === 'bye',
      });
    }
    const groups = [...new Set(ms.map((m) => m.grp))].sort((x, y) => x - y).map((n) => ({ number: n, label: groupLabel(st.type, n) }));
    const standings = elim ? [] : stageTable(db, s).map((t): PlayStanding => ({
      entry: entry(t.entryId)!, group: t.group, rank: t.rank, groupRank: t.groupRank, played: t.played, wins: t.wins, losses: t.losses,
      points: t.points, buchholz: t.buchholz, scoreDiff: t.scoreDiff,
    }));
    return {
      ordinal: s.ordinal, type: st.type, status: s.status as 'live' | 'finished', layout: elim ? 'bracket' : 'table',
      groups, rounds, standings, advanceCount: st.advanceCount,
    };
  });
}
```

In `src/events/views.ts`:
- import `{ stagePlayViews, type StagePlayView } from './playViews.js'`;
- add `placement: number | null` to `EventEntryView` and `placement: e.placement` to the object `entryViews` returns;
- add `play: StagePlayView[];` to `EventView` and `play: stagePlayViews(db, ev),` to `eventView`'s return (after `entries`).

- [ ] **Step 4: Write the failing route tests**

Create `tests/eventPlayRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import * as P from '../src/events/play.js';
import { ADMIN } from './eventFixture.js';
import { startEventFlow } from '../src/events/flow.js';
import { stagePlayViews } from '../src/events/playViews.js';
import { LEAGUE, SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';

const MOD = '76561199000000830';
let f: PlayFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
  upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
  f.db.prepare("UPDATE players SET is_mod = 1, status = 'active' WHERE steamid = ?").run(MOD);
  f.db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'event-play-')) },
    db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [ADMIN, MOD]) cookies[s] = authedCookie(app, f.db, s);
});
afterEach(async () => { await app.close(); });

const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
const get = (url: string, as?: string) => app.inject({ method: 'GET', url, ...(as ? { cookies: cookies[as] } : {}) });
const firstOpen = () => P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id).find((m) => m.status === 'waiting')!;

describe('event play routes', () => {
  it('a mod reads the desk play view but cannot start or report', async () => {
    const view = await get(`/api/admin/events/${f.eventId}/play`, MOD);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'checkin', seeded: 4, stages: [] });
    expect((await post(`/api/admin/events/${f.eventId}/start`, MOD)).statusCode).toBe(403);
  });

  it('an admin starts the event; the public page then shows Swiss standings and round 1', async () => {
    const r = await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    expect(r.statusCode).toBe(200);
    const ev = E.getEvent(f.db, f.eventId)!;
    const page = (await get(`/api/events/${ev.slug}`)).json();
    expect(page.status).toBe('live');
    expect(page.play).toHaveLength(1);
    expect(page.play[0]).toMatchObject({ ordinal: 1, layout: 'table', status: 'live' });
    expect(page.play[0].rounds[0]).toMatchObject({ label: 'Round 1' });
    expect(page.play[0].rounds[0].matches).toHaveLength(2);
    expect(page.play[0].standings).toHaveLength(4);
    expect(JSON.stringify(page)).not.toMatch(/"sr"/i);
    expect((await post(`/api/admin/events/${f.eventId}/start`, ADMIN)).statusCode).toBe(409);
  });

  it('an admin reports a result; bad bodies get the sentence; a mod gets 403', async () => {
    await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    const m = firstOpen();
    const url = `/api/admin/events/${f.eventId}/matches/${m.id}/result`;
    expect((await post(url, MOD, { winner: 'a', scoreA: 2, scoreB: 1 })).statusCode).toBe(403);
    const bad = await post(url, ADMIN, { winner: 'a', scoreA: 1, scoreB: 2 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/winner/);
    expect((await post(url, ADMIN, { winner: 'a', scoreA: 2, scoreB: 1 })).statusCode).toBe(200);
    expect(P.getMatch(f.db, m.id)).toMatchObject({ status: 'done', result_source: 'admin' });
    expect((await post(`/api/admin/events/${f.eventId}/matches/99999/result`, ADMIN, { winner: 'a', forfeit: true })).statusCode).toBe(404);
    const audit = f.db.prepare("SELECT action FROM admin_actions WHERE action IN ('event_start','event_result') ORDER BY id").all();
    expect(audit).toEqual([{ action: 'event_start' }, { action: 'event_result' }]);
  });

  it('disqualifying a team in a live event forfeits its open match before the reply', async () => {
    await post(`/api/admin/events/${f.eventId}/start`, ADMIN);
    const m = firstOpen();
    const r = await post(`/api/admin/events/${f.eventId}/entries/${m.entry_a}/disqualify`, ADMIN, { reason: 'left' });
    expect(r.statusCode).toBe(200);
    expect(P.getMatch(f.db, m.id)).toMatchObject({ status: 'forfeit', winner_entry: m.entry_b });
  });

  it('a league round carries its week\'s dates from the season start', async () => {
    const g = playFixture({ stages: [LEAGUE(4, 2, 'round_robin', null, '2026-10-12')], entries: 4 });
    const r = await startEventFlow(g.db, { eventId: g.eventId, by: ADMIN });
    expect(r.ok).toBe(true);
    const rounds = stagePlayViews(g.db, E.getEvent(g.db, g.eventId)!)[0]!.rounds;
    expect(rounds.map((x) => [x.label, x.dates])).toEqual([
      ['Week 1, match 1', { from: '2026-10-12', to: '2026-10-18' }], ['Week 1, match 2', { from: '2026-10-12', to: '2026-10-18' }],
      ['Week 2, match 1', { from: '2026-10-19', to: '2026-10-25' }], ['Week 2, match 2', { from: '2026-10-19', to: '2026-10-25' }],
    ]);
  });

  it('the public page is a 404 while the switch is closed to the viewer, as before', async () => {
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    const ev = E.getEvent(f.db, f.eventId)!;
    expect((await get(`/api/events/${ev.slug}`)).statusCode).toBe(404);
  });
});
```

(If `admin_actions` is named differently, use the table `logAdmin` writes, as `tests/adminEventEntries.test.ts` checks it. If the switch's closed value is not `'off'`, use the value `tests/eventRoutes.test.ts` uses.)

- [ ] **Step 5: Run them to make sure they fail**

Run: `npx vitest run tests/eventPlayRoutes.test.ts`
Expected: FAIL (404 on the new routes; `play` undefined).

- [ ] **Step 6: Implement the routes**

In `src/routes/adminEvents.ts`:
- import `{ recordResultFlow, settleEvent, startEventFlow } from '../events/flow.js'`, `* as P from '../events/play.js'` and `{ stagePlayViews, type StagePlayView } from '../events/playViews.js'`;
- export the desk shape next to the other interfaces:

```ts
export interface AdminEventPlay { status: V.EventStatus; lockedAt: string | null; startsAt: string; seeded: number; stages: StagePlayView[] }
```

- at the end of the plugin, add:

```ts
  /**
   * Play (tournaments plan T2): staff read the stages that have started with
   * every match; admins start the event early once its list is final and
   * enter or correct a result. Every rule is in src/events/flow.ts and
   * play.ts; the route maps a refusal to its sentence and adds logAdmin.
   */
  app.get('/api/admin/events/:id/play', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const out: AdminEventPlay = {
      status: ev.status, lockedAt: ev.locked_at, startsAt: ev.starts_at, seeded: P.activeSeeded(db, ev.id).length, stages: stagePlayViews(db, ev),
    };
    return out;
  });

  app.post('/api/admin/events/:id/start', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = await startEventFlow(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_start', ev.id, { slug: ev.slug });
    return {};
  });

  app.post('/api/admin/events/:id/matches/:matchId/result', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    if (!ev || matchId === null) return refuse(reply, 'match_not_found');
    const r = await recordResultFlow(db, { eventId: ev.id, matchId, by: me, result: req.body ?? {} });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_result', ev.id, {
      matchId, winner: r.value.winner_entry, scoreA: r.value.score_a, scoreB: r.value.score_b, source: r.value.result_source,
    });
    return {};
  });
```

- in the existing `/entries/:entryId/:action` route, right before `logAdmin(...)` (after the `if (!r.ok) return refuseWith(reply, r);`), add:

```ts
    if (p.action === 'disqualify' && E.getEvent(db, ev.id)?.status === 'live') await settleEvent(db, { eventId: ev.id });
```

- [ ] **Step 7: Run the route tests and the existing event suites**

Run: `npx vitest run tests/eventPlayRoutes.test.ts tests/eventRoutes.test.ts tests/adminEventRoutes.test.ts tests/adminEventEntries.test.ts tests/eventEntryRoutes.test.ts tests/eventFormat.test.ts`
Expected: PASS. If an existing `eventRoutes` test compares a whole `EventView` or entry object with `toEqual`, add `play: []` or `placement: null` to its expectation. Those fields are new and empty before an event plays.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/events/format.ts src/events/playViews.ts src/events/views.ts src/routes/adminEvents.ts tests/eventFormat.test.ts tests/eventPlayRoutes.test.ts tests/eventRoutes.test.ts
git commit -m "Tournaments T2: stage views with brackets, standings and round names; desk routes to start an event and enter results; a live disqualification settles at once"
```

---

### Task 9: The event page shows brackets and standings

**Files:**
- Modify: `web/src/api.ts`, `web/src/eventFormat.ts`, `web/src/routes/Event.tsx`, `web/src/styles/app.css`, `web/src/routes/Event.test.tsx` (its `view()` default)
- Create: `web/src/routes/event/StagePlay.tsx`, `web/src/routes/event/Bracket.tsx`, `web/src/routes/event/StagePlay.test.tsx`

**Interfaces:**
- Consumes: the `StagePlayView` JSON from Task 8.
- Produces:
  - `api.ts`: `PlayEntry`, `PlayMatch`, `PlayRound`, `PlayStanding`, `StagePlayView` (same fields as Task 8, with `type: string`); `EventView.play: StagePlayView[]`; `EventEntryView.placement: number | null`
  - `eventFormat.ts`: `placementText(n: number): string` ("1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd")
  - `StagePlay({ stage }: { stage: StagePlayView })`, `Bracket({ stage })`, `MatchCard({ m })`

- [ ] **Step 1: Write the failing component tests**

Create `web/src/routes/event/StagePlay.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/preact';
import type { PlayEntry, PlayMatch, StagePlayView } from '../../api';
import { StagePlay } from './StagePlay';
import { placementText } from '../../eventFormat';

afterEach(cleanup);

const team = (id: number, name: string, out = false): PlayEntry => ({ id, name, tag: name.slice(0, 3).toUpperCase(), logoKey: null, seed: id, out });
const match = (over: Partial<PlayMatch>): PlayMatch => ({
  id: 1, group: 1, round: 1, slot: 1, a: team(1, 'Rats'), b: team(2, 'Bats'), status: 'waiting', winner: null,
  scoreA: null, scoreB: null, forfeit: false, bye: false, ...over,
});

describe('StagePlay', () => {
  it('draws a bracket: one column per round, scores, the winner marked, TBD for unknown teams', () => {
    const stage: StagePlayView = {
      ordinal: 2, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
      rounds: [
        { group: 1, round: 1, label: 'Semifinals', dates: null, matches: [match({ status: 'done', winner: 'a', scoreA: 1200, scoreB: 900 }), match({ id: 2, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'forfeit', winner: 'b', forfeit: true })] },
        { group: 1, round: 2, label: 'Final', dates: null, matches: [match({ id: 3, a: team(1, 'Rats'), b: null, status: 'pending' })] },
      ],
    };
    render(<StagePlay stage={stage} />);
    expect(screen.getByRole('heading', { name: /Stage 2/ })).toBeTruthy();
    const cols = document.querySelectorAll('.bracket__round');
    expect(cols).toHaveLength(2);
    expect(within(cols[0] as HTMLElement).getByText('Semifinals')).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByText('FF')).toBeTruthy();
    expect(screen.getByText('TBD')).toBeTruthy();
    expect(document.querySelectorAll('.matchcard__side--won')).toHaveLength(2);
  });

  it('draws a table stage: standings with Swiss columns, then the rounds; a bye and an out team are marked', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'swiss', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], advanceCount: 2,
      standings: [
        { entry: team(1, 'Rats'), group: 1, rank: 1, groupRank: 1, played: 1, wins: 1, losses: 0, points: 1, buchholz: 0, scoreDiff: 300 },
        { entry: team(3, 'Cats'), group: 1, rank: 2, groupRank: 2, played: 0, wins: 1, losses: 0, points: 1, buchholz: 0, scoreDiff: 0 },
        { entry: team(2, 'Bats', true), group: 1, rank: 3, groupRank: 3, played: 1, wins: 0, losses: 1, points: 0, buchholz: 1, scoreDiff: -300 },
      ],
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, matches: [
        match({ status: 'done', winner: 'a', scoreA: 1200, scoreB: 900 }),
        match({ id: 2, slot: 2, a: team(3, 'Cats'), b: null, status: 'bye', winner: 'a', bye: true }),
      ] }],
    };
    render(<StagePlay stage={stage} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Buchholz')).toBeTruthy();
    expect(within(table).getByText('+300')).toBeTruthy();
    expect(within(table).getByText('Disqualified')).toBeTruthy();
    expect(screen.getByText('Top 2 advance')).toBeTruthy();
    expect(screen.getByText('Bye')).toBeTruthy();
    expect(screen.getByText('Round 1')).toBeTruthy();
  });

  it('shows a league round\'s week dates next to its label', () => {
    render(<StagePlay stage={{
      ordinal: 1, type: 'league', status: 'live', layout: 'table', advanceCount: null, standings: [], groups: [{ number: 1, label: 'Rounds' }],
      rounds: [{ group: 1, round: 3, label: 'Week 3', dates: { from: '2026-10-26', to: '2026-11-01' }, matches: [] }],
    }} />);
    expect(screen.getByText('Week 3 · Oct 26 to Nov 1')).toBeTruthy();
  });

  it('shows one table per round robin group', () => {
    const s = (id: number, name: string, group: number) => ({ entry: team(id, name), group, rank: id, groupRank: 1, played: 0, wins: 0, losses: 0, points: 0, buchholz: 0, scoreDiff: 0 });
    render(<StagePlay stage={{
      ordinal: 1, type: 'round_robin', status: 'live', layout: 'table', advanceCount: null, rounds: [],
      groups: [{ number: 1, label: 'Group A' }, { number: 2, label: 'Group B' }], standings: [s(1, 'Rats', 1), s(2, 'Bats', 2)],
    }} />);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.getByText('Group B')).toBeTruthy();
  });

  it('placementText', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(placementText)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run web/src/routes/event/StagePlay.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Add the API types and placementText**

In `web/src/api.ts`, next to `EventEntryView`:

```ts
export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean;
}
export interface PlayRound { group: number; round: number; label: string; dates: { from: string; to: string } | null; matches: PlayMatch[] }
export interface PlayStanding {
  entry: PlayEntry; group: number; rank: number; groupRank: number; played: number; wins: number; losses: number;
  points: number; buchholz: number; scoreDiff: number;
}
export interface StagePlayView {
  ordinal: number; type: string; status: 'live' | 'finished'; layout: 'bracket' | 'table';
  groups: { number: number; label: string }[]; rounds: PlayRound[]; standings: PlayStanding[]; advanceCount: number | null;
}
```

Add `placement: number | null` to `EventEntryView`, and `play: StagePlayView[];` to `EventView`. In `web/src/routes/Event.test.tsx`, add `play: []` to the `view()` defaults.

In `web/src/eventFormat.ts`:

```ts
/** "Oct 26 to Nov 1" for a league week. The days are calendar days, so they
 *  are read and shown in UTC and never shift with the viewer's time zone. */
export function weekRangeText(from: string, to: string): string {
  const f = (d: string) => new Date(`${d}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(from)} to ${f(to)}`;
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function placementText(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
```

- [ ] **Step 4: Write the components**

Create `web/src/routes/event/Bracket.tsx`:

```tsx
import type { PlayEntry, PlayMatch, StagePlayView } from '../../api';

/** One side of a match card: the team (or TBD / Bye) and its score. */
function Side({ e, score, won, forfeitLoss, bye }: { e: PlayEntry | null; score: number | null; won: boolean; forfeitLoss: boolean; bye: boolean }) {
  return (
    <div class={`matchcard__side${won ? ' matchcard__side--won' : ''}${e?.out ? ' muted' : ''}`}>
      <span class="matchcard__name">{e ? e.name : bye ? 'Bye' : 'TBD'}</span>
      <span class="matchcard__score">{forfeitLoss ? 'FF' : score !== null ? String(score) : ''}</span>
    </div>
  );
}

export function MatchCard({ m }: { m: PlayMatch }) {
  return (
    <div class={`matchcard matchcard--${m.status}`}>
      <Side e={m.a} score={m.scoreA} won={m.winner === 'a'} forfeitLoss={m.forfeit && m.winner === 'b'} bye={false} />
      <Side e={m.b} score={m.scoreB} won={m.winner === 'b'} forfeitLoss={m.forfeit && m.winner === 'a'} bye={m.bye} />
    </div>
  );
}

/** An elimination stage: per group, one column per round (plan T2 Ruling
 *  15: no connector lines in v1). The columns scroll inside the panel at
 *  phone width; the page itself never scrolls sideways. */
export function Bracket({ stage }: { stage: StagePlayView }) {
  return (
    <>
      {stage.groups.map((g) => (
        <section key={g.number} class="bracketgroup">
          {stage.groups.length > 1 && <h4>{g.label}</h4>}
          <div class="bracket">
            {stage.rounds.filter((r) => r.group === g.number).map((r) => (
              <div key={r.round} class="bracket__round">
                <span class="eyebrow">{r.label}</span>
                {r.matches.map((m) => <MatchCard key={m.id} m={m} />)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
```

Create `web/src/routes/event/StagePlay.tsx`:

```tsx
import type { PlayStanding, StagePlayView } from '../../api';
import { Panel } from '../../components/bits';
import { weekRangeText } from '../../eventFormat';
import { Bracket, MatchCard } from './Bracket';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Standings({ rows, swiss }: { rows: PlayStanding[]; swiss: boolean }) {
  return (
    <div class="table-wrap">
      <table class="playtable">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>W-L</th>
            {swiss && <th>Pts</th>}
            {swiss && <th>Buchholz</th>}
            <th>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entry.id} class={r.entry.out ? 'muted' : ''}>
              <td>{r.groupRank}</td>
              <td>{r.entry.name}{r.entry.out && <span class="chip chip--bad">Disqualified</span>}</td>
              <td>{r.wins}-{r.losses}</td>
              {swiss && <td>{r.points}</td>}
              {swiss && <td>{r.buchholz}</td>}
              <td>{signed(r.scoreDiff)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One started stage on the event page (plan T2): an elimination bracket, or
 *  standings (one table per group) followed by the rounds. */
export function StagePlay({ stage }: { stage: StagePlayView }) {
  const swiss = stage.type === 'swiss';
  return (
    <Panel>
      <h3>Stage {stage.ordinal}: {stage.layout === 'bracket' ? 'bracket' : 'standings'}{stage.status === 'finished' ? ' (finished)' : ''}</h3>
      {stage.layout === 'bracket' ? <Bracket stage={stage} /> : (
        <>
          {stage.advanceCount !== null && <p class="muted">Top {stage.advanceCount} advance</p>}
          {stage.groups.map((g) => (
            <section key={g.number}>
              {stage.groups.length > 1 && <h4>{g.label}</h4>}
              <Standings rows={stage.standings.filter((r) => r.group === g.number)} swiss={swiss} />
            </section>
          ))}
          {stage.rounds.slice().reverse().map((r) => (
            <section key={`${r.group}-${r.round}`} class="playround">
              <span class="eyebrow">
                {`${stage.groups.length > 1 ? `${stage.groups.find((g) => g.number === r.group)?.label}, ` : ''}${r.label}${r.dates ? ` · ${weekRangeText(r.dates.from, r.dates.to)}` : ''}`}
              </span>
              <div class="playround__matches">{r.matches.map((m) => <MatchCard key={m.id} m={m} />)}</div>
            </section>
          ))}
        </>
      )}
    </Panel>
  );
}
```

The test expects the text `Top 2 advance` exactly. JSX renders `Top {stage.advanceCount} advance` as a single text node in happy-dom. If `getByText` sees it as split, write it as one template string: `{`Top ${stage.advanceCount} advance`}`.

- [ ] **Step 5: Mount it on the event page and add the styles**

In `web/src/routes/Event.tsx`:
- import `StagePlay` from `./event/StagePlay` and `placementText` from `../eventFormat`;
- add the minute refetch while live, after the load effect:

```tsx
  // Plan T2 Ruling 16: while the event is live, refetch once a minute
  // without clearing the page, so brackets and standings move on their own.
  useEffect(() => {
    if (ev?.status !== 'live') return;
    const t = setInterval(() => { eventsApi.get(slug).then(setEv, () => { /* keep what is shown */ }); }, 60_000);
    return () => clearInterval(t);
  }, [slug, ev?.status]);
```

- render the stage panels right after the description panel: `{ev.play.map((s) => <StagePlay key={s.ordinal} stage={s} />)}`;
- in the entries list, after the existing chips: `{e.placement !== null && <span class="chip chip--ok">{placementText(e.placement)}</span>}`.

Add an Event test case to `web/src/routes/Event.test.tsx`:

```tsx
  it('shows a live stage and the placements of a finished event', async () => {
    mockEvents.get.mockResolvedValue(view({
      status: 'finished',
      entries: [{ id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, status: 'placed', waitlist: null, placement: 1 }],
      play: [{ ordinal: 1, type: 'single_elim', status: 'finished', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
        rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [] }] }],
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect(await screen.findByText(/Stage 1: bracket/)).toBeTruthy();
    expect(screen.getByText('1st')).toBeTruthy();
  });
```

Append to `web/src/styles/app.css` (next to the `.eventstrip` rules; use the file's existing tokens. Check the names it already uses for borders and muted text, for example by grepping `.evententry`, and use those in place of the ones below if they differ):

```css
/* Plan T2: brackets, standings and rounds on the event page. */
.bracket { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }
.bracket__round { display: flex; flex-direction: column; justify-content: space-around; gap: 8px; min-width: 180px; }
.matchcard { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.matchcard__side { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; }
.matchcard__side + .matchcard__side { border-top: 1px solid var(--border); }
.matchcard__side--won { font-weight: 700; }
.matchcard__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.matchcard__score { font-variant-numeric: tabular-nums; }
.matchcard--pending { opacity: 0.7; }
.playtable { width: 100%; border-collapse: collapse; }
.playtable th, .playtable td { padding: 4px 8px; text-align: left; font-variant-numeric: tabular-nums; }
.playround { margin-top: 12px; }
.playround__matches { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin-top: 4px; }
```

- [ ] **Step 6: Run the web tests, typecheck and build**

Run: `npx vitest run web/src/routes/event/StagePlay.test.tsx web/src/routes/Event.test.tsx && npm run typecheck && npm run build`
Expected: PASS, and the build succeeds.

- [ ] **Step 7: Look at it at phone width**

Start a scratch dev server against a copy of a test database with a live event. The T1 sessions used a scratch DB on API 8091 / vite 5181 with `/api/dev/login`; copy that setup and never point it at `data/pug.db`. Shoot `/event/<slug>` at 390 px and at desktop width with `npm run shoot` or the browser, and look at both. The page must not scroll sideways. The bracket columns may scroll inside their panel, and the standings table inside `.table-wrap`. Fix any overlap before committing.

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/eventFormat.ts web/src/routes/Event.tsx web/src/routes/Event.test.tsx web/src/routes/event/StagePlay.tsx web/src/routes/event/Bracket.tsx web/src/routes/event/StagePlay.test.tsx web/src/styles/app.css
git commit -m "Tournaments T2: the event page draws brackets, standings and rounds, refreshes while live, and marks placements"
```

---

### Task 10: The desk's Play section

**Files:**
- Modify: `web/src/api.ts` (desk calls), `web/src/routes/admin/events/EventEditor.tsx`
- Create: `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/routes/admin/events/PlayPanel.test.tsx`

**Interfaces:**
- Consumes: `AdminEventPlay` JSON (Task 8); `useFetch`, `useAction`, `Panel`, `Empty`.
- Produces:
  - `api.ts`: `interface AdminEventPlay { status: string; lockedAt: string | null; startsAt: string; seeded: number; stages: StagePlayView[] }`; `adminApi.eventPlay(id, signal?)`, `adminApi.startEvent(id)`, `adminApi.recordEventResult(id, matchId, body: { winner: 'a' | 'b'; scoreA?: number; scoreB?: number; forfeit?: boolean })`
  - `PlayPanel({ eventId, canEdit }: { eventId: number; canEdit: boolean })`

- [ ] **Step 1: Write the failing tests**

Create `web/src/routes/admin/events/PlayPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEventPlay, PlayMatch } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { eventPlay: vi.fn(), startEvent: vi.fn(), recordEventResult: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { PlayPanel } = await import('./PlayPanel');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const team = (id: number, name: string) => ({ id, name, tag: '', logoKey: null, seed: id, out: false });
const m = (over: Partial<PlayMatch> = {}): PlayMatch => ({
  id: 7, group: 1, round: 1, slot: 1, a: team(1, 'Rats'), b: team(2, 'Bats'), status: 'waiting', winner: null,
  scoreA: null, scoreB: null, forfeit: false, bye: false, ...over,
});
const play = (over: Partial<AdminEventPlay> = {}): AdminEventPlay => ({
  status: 'live', lockedAt: 'x', startsAt: '2026-10-10T20:00:00.000Z', seeded: 2, ...over,
  stages: over.stages ?? [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null,
    rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [m()] }] }],
});

describe('PlayPanel', () => {
  it('offers Start once the list is final and before the event is live', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ status: 'checkin', stages: [] }));
    mockAdmin.startEvent.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the event now' }));
    await waitFor(() => expect(mockAdmin.startEvent).toHaveBeenCalledWith(9));
  });

  it('says why Start is not offered when the list is not final', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ status: 'registration', lockedAt: null, stages: [] }));
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByText(/once the entry list is final/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('records a scored result for an open match', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.change(await screen.findByLabelText('Rats score'), { target: { value: '1200' } });
    fireEvent.change(screen.getByLabelText('Bats score'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Winner'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'a', scoreA: 1200, scoreB: 900, forfeit: false }));
  });

  it('records a forfeit without scores, and offers Correct on a finished match', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'swiss', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null,
      rounds: [{ group: 1, round: 1, label: 'Round 1', dates: null, matches: [m(), m({ id: 8, slot: 2, status: 'done', winner: 'b', scoreA: 1, scoreB: 2 })] }] }] }));
    mockAdmin.recordEventResult.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    const forfeit = (await screen.findAllByLabelText('Forfeit'))[0]!;
    fireEvent.click(forfeit);
    fireEvent.change(screen.getAllByLabelText('Winner')[0]!, { target: { value: 'b' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save result' })[0]!);
    await waitFor(() => expect(mockAdmin.recordEventResult).toHaveBeenCalledWith(9, 7, { winner: 'b', forfeit: true }));
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
  });

  it('a mod reads matches with no controls', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play());
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Winner')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run web/src/routes/admin/events/PlayPanel.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Add the desk calls**

In `web/src/api.ts`, near the other event desk types, add `AdminEventPlay` (shape above). In `adminApi`, next to `eventEntries`:

```ts
  eventPlay: (id: number, signal?: AbortSignal) => get<AdminEventPlay>(`/api/admin/events/${id}/play`, signal),
  startEvent: (id: number) => post(`/api/admin/events/${id}/start`),
  recordEventResult: (id: number, matchId: number, body: { winner: 'a' | 'b'; scoreA?: number; scoreB?: number; forfeit?: boolean }) =>
    post(`/api/admin/events/${id}/matches/${matchId}/result`, body),
```

- [ ] **Step 4: Write the panel**

Create `web/src/routes/admin/events/PlayPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type PlayMatch } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';

const OPEN = new Set(['waiting']);
const CORRECTABLE = new Set(['done', 'forfeit']);
const STATUS: Record<string, string> = { pending: 'Waiting for teams', waiting: 'To play', done: 'Done', forfeit: 'Forfeit', bye: 'Bye' };

/** One match's result form: its own state, so two rows never share inputs. */
function ResultForm({ eventId, m, run, busy, correcting }: { eventId: number; m: PlayMatch; run: Run; busy: boolean; correcting: boolean }) {
  const [winner, setWinner] = useState<'' | 'a' | 'b'>('');
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [forfeit, setForfeit] = useState(false);
  const a = m.a!.name;
  const b = m.b!.name;
  const save = () => {
    if (!winner) return;
    const body = forfeit ? { winner, forfeit: true } : { winner, scoreA: Number(scoreA), scoreB: Number(scoreB), forfeit: false };
    void run(() => adminApi.recordEventResult(eventId, m.id, body), correcting
      ? { title: `Change the result of ${a} vs ${b}?`, body: 'Later matches move with it. A result that later matches already depend on is refused.' }
      : undefined);
  };
  return (
    <div class="inlinerow">
      <label>Winner
        <select aria-label="Winner" value={winner} onChange={(e) => setWinner((e.target as HTMLSelectElement).value as '' | 'a' | 'b')}>
          <option value="">Pick</option>
          <option value="a">{a}</option>
          <option value="b">{b}</option>
        </select>
      </label>
      {!forfeit && (
        <>
          <input type="number" min={0} aria-label={`${a} score`} value={scoreA} onInput={(e) => setScoreA((e.target as HTMLInputElement).value)} />
          <input type="number" min={0} aria-label={`${b} score`} value={scoreB} onInput={(e) => setScoreB((e.target as HTMLInputElement).value)} />
        </>
      )}
      <label><input type="checkbox" aria-label="Forfeit" checked={forfeit} onChange={(e) => setForfeit((e.target as HTMLInputElement).checked)} /> Forfeit</label>
      <button class="btn btn--ghost" disabled={busy || !winner} onClick={save}>Save result</button>
    </div>
  );
}

function MatchRow({ eventId, m, canEdit, live, run, busy }: { eventId: number; m: PlayMatch; canEdit: boolean; live: boolean; run: Run; busy: boolean }) {
  const [correcting, setCorrecting] = useState(false);
  const editable = canEdit && live && m.a !== null && m.b !== null;
  return (
    <li>
      <strong>{m.a?.name ?? 'TBD'}</strong> vs <strong>{m.bye ? 'Bye' : m.b?.name ?? 'TBD'}</strong>
      <span class="muted"> · {STATUS[m.status] ?? m.status}
        {m.forfeit ? ` · forfeit, ${(m.winner === 'a' ? m.a : m.b)?.name ?? ''} wins` : m.scoreA !== null && m.scoreB !== null ? ` · ${m.scoreA} : ${m.scoreB}` : ''}
      </span>
      {editable && OPEN.has(m.status) && <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting={false} />}
      {editable && CORRECTABLE.has(m.status) && !correcting && (
        <button class="btn btn--ghost" disabled={busy} onClick={() => setCorrecting(true)}>Correct</button>
      )}
      {editable && CORRECTABLE.has(m.status) && correcting && <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting />}
    </li>
  );
}

/** The Play section of an event on the desk (plan T2 Ruling 17): Start once
 *  the list is final; each started stage's matches by round with a result
 *  form on open ones and Correct on finished ones while the stage is live. A
 *  mod (canEdit false) reads the same list with no control. */
export function PlayPanel({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventPlay(eventId, s), [eventId]);
  const { busy, error, run } = useAction(reload);
  if (loadError) return <Panel><h3>Play</h3><p class="error">Could not load the matches.</p></Panel>;
  if (!data) return <Panel><h3>Play</h3></Panel>;
  const before = data.status === 'registration' || data.status === 'checkin';
  return (
    <Panel>
      <h3>Play</h3>
      {before && data.lockedAt === null && <p class="muted">The event can start once the entry list is final. It starts by itself at the start time.</p>}
      {before && data.lockedAt !== null && (
        <>
          <p class="muted">{data.seeded} teams are seeded. The event starts by itself at the start time{data.seeded < 2 ? ' once it has 2 teams' : ''}.</p>
          {canEdit && data.seeded >= 2 && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.startEvent(eventId), {
              title: 'Start the event now?', body: 'Stage 1 is drawn from the current seeds, and seeds can no longer change.',
            })}>Start the event now</button>
          )}
        </>
      )}
      {error && <p class="error" role="alert">{error}</p>}
      {!before && data.stages.length === 0 && <Empty>No stage has started.</Empty>}
      {data.stages.map((s) => (
        <section key={s.ordinal}>
          <h4>Stage {s.ordinal}{s.status === 'finished' ? ' (finished)' : ''}</h4>
          {s.rounds.map((r) => (
            <div key={`${r.group}-${r.round}`}>
              <span class="eyebrow">{s.groups.length > 1 ? `${s.groups.find((g) => g.number === r.group)?.label}, ` : ''}{r.label}</span>
              <ul class="admin-list">
                {r.matches.map((m) => <MatchRow key={m.id} eventId={eventId} m={m} canEdit={canEdit} live={s.status === 'live'} run={run} busy={busy} />)}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </Panel>
  );
}
```

- [ ] **Step 5: Mount it**

In `web/src/routes/admin/events/EventEditor.tsx`, import `PlayPanel` and render it right after the `EntriesPanel` line:

```tsx
      {['registration', 'checkin', 'live', 'finished'].includes(ev.status) && <PlayPanel eventId={ev.id} canEdit={canEdit} />}
```

- [ ] **Step 6: Run the tests, typecheck and build**

Run: `npx vitest run web/src/routes/admin/events/ && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Look at it at phone width**

On the scratch dev server from Task 9, open the desk's event editor for a live event at 390 px and at desktop width. Each result row must fit without the page scrolling sideways; the inputs wrap onto their own line through `.inlinerow`. Enter one result and one correction by hand, and check that the event page changes too.

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/admin/events/EventEditor.tsx
git commit -m "Tournaments T2: the desk's Play section, start the event, enter, forfeit and correct results"
```

---

### Task 11: League settings and the season calculator in the stage editor

**Files:**
- Modify: `web/src/api.ts` (`StageConfigs['league']`), `web/src/routes/admin/events/stageDraft.ts`, `web/src/routes/admin/events/StageForm.tsx`, `web/src/routes/admin/events/EventEditor.tsx`
- Create: `web/src/routes/admin/events/SeasonCalc.tsx`, `web/src/routes/admin/events/SeasonCalc.test.tsx`
- Test: `web/src/routes/admin/events/StageForm.test.tsx`

**Interfaces:**
- Consumes: `leagueWeeks`, `weekDates`, `perWeekFor`, `byeSpread` from `src/events/league.ts` (Task 3), imported as `../../../../../src/events/league` like `web/src/api.ts` already imports from `../../src/...`.
- Produces:
  - `api.ts`: `StageConfigs['league'] = { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null }`
  - `StageDraft` replaces `weeks` with `matches: number` and adds `seasonStart: string | null`
  - `StageForm` takes a new optional prop `teamCap?: number | null`
  - `SeasonCalc({ matches, perWeek, seasonStart, teamCap, onUsePerWeek })`: `matches`, `perWeek` are numbers or null while the typed value is not a whole number; `onUsePerWeek(n: number)` sets the form's matches a week.

- [ ] **Step 1: Write the failing calculator tests**

Create `web/src/routes/admin/events/SeasonCalc.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SeasonCalc } from './SeasonCalc';

afterEach(cleanup);

describe('SeasonCalc', () => {
  it('turns matches and matches a week into weeks, and with a start date into an end date', () => {
    render(<SeasonCalc matches={16} perWeek={2} seasonStart="2026-10-12" teamCap={8} onUsePerWeek={() => {}} />);
    expect(screen.getByText('16 matches at 2 a week: 8 weeks, Oct 12 to Dec 6.')).toBeTruthy();
  });

  it('without a start date says the season starts with the stage', () => {
    render(<SeasonCalc matches={16} perWeek={3} seasonStart={null} teamCap={null} onUsePerWeek={() => {}} />);
    expect(screen.getByText('16 matches at 3 a week: 6 weeks from the day the stage starts.')).toBeTruthy();
  });

  it('from an end date, offers the matches a week that fit, or says nothing fits', () => {
    const use = vi.fn();
    render(<SeasonCalc matches={16} perWeek={1} seasonStart="2026-10-12" teamCap={8} onUsePerWeek={use} />);
    fireEvent.input(screen.getByLabelText('Season ends by'), { target: { value: '2026-11-29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use 3 a week' }));
    expect(use).toHaveBeenCalledWith(3);
    fireEvent.input(screen.getByLabelText('Season ends by'), { target: { value: '2026-10-25' } });
    expect(screen.getByText('16 matches do not fit by then, even at 3 a week.')).toBeTruthy();
  });

  it('with an odd team count says how byes fall and which counts split them evenly', () => {
    render(<SeasonCalc matches={16} perWeek={2} seasonStart={null} teamCap={8} onUsePerWeek={() => {}} />);
    fireEvent.input(screen.getByLabelText('Expected teams'), { target: { value: '7' } });
    expect(screen.getByText('With 7 teams each team gets 2 or 3 byes (a bye is a win). 14 or 21 matches gives everyone the same.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Expected teams'), { target: { value: '8' } });
    expect(screen.queryByText(/byes/)).toBeNull();
  });

  it('says nothing while matches or matches a week is not a whole number', () => {
    const { container } = render(<SeasonCalc matches={null} perWeek={2} seasonStart={null} teamCap={8} onUsePerWeek={() => {}} />);
    expect(container.querySelector('.seasoncalc__line')).toBeNull();
  });
});
```

Add to `web/src/routes/admin/events/StageForm.test.tsx`:

```tsx
describe('StageForm league', () => {
  it('saves matches, matches a week, pairing and the season start', () => {
    const onSave = vi.fn();
    render(<StageForm options={OPTIONS} initial={null} busy={false} onSave={onSave} onCancel={() => {}} teamCap={8} />);
    fireEvent.change(screen.getByLabelText('Stage type'), { target: { value: 'league' } });
    fireEvent.input(screen.getByLabelText('Matches per team'), { target: { value: '14' } });
    fireEvent.input(screen.getByLabelText('Matches a week'), { target: { value: '2' } });
    fireEvent.input(screen.getByLabelText('Season start'), { target: { value: '2026-10-12' } });
    expect(screen.getByText('14 matches at 2 a week: 7 weeks, Oct 12 to Nov 29.')).toBeTruthy();
    fireEvent.submit(screen.getByLabelText('Matches per team').closest('form')!);
    expect(onSave.mock.calls[0]![0].config).toEqual({ matches: 14, matchesPerWeek: 2, pairing: 'swiss', seasonStart: '2026-10-12' });
  });
});
```

(Add `vi` to that file's vitest import. If the type select's accessible name is not `Stage type`, use the label the form already gives it; do not rename it.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run web/src/routes/admin/events/SeasonCalc.test.tsx web/src/routes/admin/events/StageForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `web/src/api.ts`, change the league line of `StageConfigs`:

```ts
  league: { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null };
```

In `stageDraft.ts`: in `StageDraft`, replace `weeks: number;` with `matches: number; seasonStart: string | null;`. In `draftFrom`, replace `weeks: c.weeks ?? 6,` with `matches: c.matches ?? 16, seasonStart: c.seasonStart ?? null,`. In `configOf`:

```ts
    case 'league': return { matches: d.matches, matchesPerWeek: d.matchesPerWeek, pairing: d.pairing, seasonStart: d.seasonStart };
```

Create `web/src/routes/admin/events/SeasonCalc.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { byeSpread, leagueWeeks, perWeekFor, weekDates } from '../../../../../src/events/league';
import { weekRangeText } from '../../../eventFormat';

/**
 * The season calculator under a league stage's settings (plan T2 Ruling 20).
 * It only reads the form's values and suggests; it stores nothing. The
 * expected team count and the end date are its own inputs, used for the
 * bye line and the matches-a-week suggestion.
 */
export function SeasonCalc({ matches, perWeek, seasonStart, teamCap, onUsePerWeek }: {
  matches: number | null; perWeek: number | null; seasonStart: string | null; teamCap: number | null | undefined;
  onUsePerWeek: (n: number) => void;
}) {
  const [teams, setTeams] = useState(String(teamCap ?? 8));
  const [endBy, setEndBy] = useState('');
  if (matches === null || perWeek === null || matches < 1 || perWeek < 1) return null;
  const weeks = leagueWeeks(matches, perWeek);
  const span = seasonStart
    ? `, ${weekRangeText(seasonStart, weekDates(seasonStart, weeks).to)}.`
    : ' from the day the stage starts.';
  const n = Number(teams);
  const byes = Number.isInteger(n) && n >= 2 ? byeSpread(matches, n) : null;
  const fit = seasonStart && /^\d{4}-\d{2}-\d{2}$/.test(endBy) ? perWeekFor(matches, seasonStart, endBy) : undefined;
  return (
    <div class="seasoncalc">
      <p class="seasoncalc__line">{`${matches} matches at ${perWeek} a week: ${weeks} week${weeks === 1 ? '' : 's'}${span}`}</p>
      <div class="inlinerow">
        <label>Expected teams <input type="number" min={2} aria-label="Expected teams" value={teams} onInput={(e) => setTeams((e.target as HTMLInputElement).value)} /></label>
        {seasonStart && (
          <label>Season ends by <input type="date" aria-label="Season ends by" value={endBy} onInput={(e) => setEndBy((e.target as HTMLInputElement).value)} /></label>
        )}
      </div>
      {byes && (
        <p class="seasoncalc__line muted">
          {`With ${n} teams each team gets ${byes.min === byes.max ? byes.min : `${byes.min} or ${byes.max}`} bye${byes.max === 1 ? '' : 's'} (a bye is a win).`}
          {byes.min !== byes.max && byes.even.length > 0 ? ` ${byes.even.join(' or ')} matches gives everyone the same.` : ''}
        </p>
      )}
      {fit === null && <p class="seasoncalc__line warning">{`${matches} matches do not fit by then, even at 3 a week.`}</p>}
      {typeof fit === 'number' && fit !== perWeek && (
        <button type="button" class="btn btn--ghost" onClick={() => onUsePerWeek(fit)}>{`Use ${fit} a week`}</button>
      )}
    </div>
  );
}
```

The bye test expects the two sentences as one text node. If `getByText` sees two nodes, build the whole sentence as one template string and render it once.

In `StageForm.tsx`:
- `NumKey`: replace `'weeks'` with `'matches'`; in `NUM_LABEL` replace `weeks: 'Weeks'` with `matches: 'Matches per team'`; in `typedOf` replace `weeks: String(d.weeks)` with `matches: String(d.matches)`; in `usedNums` replace `'weeks' as const` with `'matches' as const`.
- Add the prop: `{ options, initial, busy, onSave, onCancel, teamCap }` with `teamCap?: number | null` in its type.
- Replace the league block with:

```tsx
        {d.type === 'league' && (
          <>
            <FormRow label="Matches per team" help="(1 to 40; a bye counts as one)" for={id('matches')}>
              <input id={id('matches')} aria-label="Matches per team" type="number" min={1} max={40} value={typed.matches} onInput={typeInto('matches')} />
            </FormRow>
            <FormRow label="Matches a week" help="(1 to 3)" for={id('mpw')}>
              <input id={id('mpw')} aria-label="Matches a week" type="number" min={1} max={3} value={typed.matchesPerWeek} onInput={typeInto('matchesPerWeek')} />
            </FormRow>
            <FormRow label="Season start" help="Week 1 starts this day. Empty: the day the stage starts." for={id('season')}>
              <input id={id('season')} aria-label="Season start" type="date" value={d.seasonStart ?? ''}
                onInput={(e) => set({ seasonStart: val(e) === '' ? null : val(e) })} />
            </FormRow>
            <FormRow label="Pairing" for={id('pairing')}>
              <select id={id('pairing')} aria-label="League pairing" value={d.pairing} onChange={(e) => set({ pairing: pick(e) as 'swiss' | 'round_robin' })}>
                <option value="swiss">Swiss by record</option>
                <option value="round_robin">Round robin, repeated until the season is played</option>
              </select>
            </FormRow>
            <SeasonCalc
              matches={wholeOrNull(typed.matches)} perWeek={wholeOrNull(typed.matchesPerWeek)} seasonStart={d.seasonStart} teamCap={teamCap}
              onUsePerWeek={(n) => setTyped((x) => ({ ...x, matchesPerWeek: String(n) }))}
            />
          </>
        )}
```

with, near `val`:

```ts
/** A typed field as a whole number for the live calculator, or null. */
const wholeOrNull = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s) : null);
```

and `import { SeasonCalc } from './SeasonCalc';`.

In `EventEditor.tsx`, pass `teamCap={ev.fields.teamCap}` to both `<StageForm ...>` uses.

Append to `web/src/styles/app.css`:

```css
/* Plan T2: the league season calculator. */
.seasoncalc { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
.seasoncalc input[type='number'] { width: 5em; }
```

- [ ] **Step 4: Run the tests, typecheck and build**

Run: `npx vitest run web/src/routes/admin/events/ && npm run typecheck && npm run build`
Expected: PASS. `npm run build` also proves the web bundle can take `src/events/league.ts` (it imports only `roundRobin.ts` and a type from `swiss.ts`). If vite pulls more than that in, stop and report; do not loosen the import.

- [ ] **Step 5: Look at it at phone width**

On the scratch dev server, open a league stage in the editor at 390 px. Type 16 matches, 2 a week and a start date, then try an end date and an odd team count. Check that the lines wrap and nothing scrolls sideways.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/events/stageDraft.ts web/src/routes/admin/events/StageForm.tsx web/src/routes/admin/events/StageForm.test.tsx web/src/routes/admin/events/SeasonCalc.tsx web/src/routes/admin/events/SeasonCalc.test.tsx web/src/routes/admin/events/EventEditor.tsx web/src/styles/app.css
git commit -m "Tournaments T2: league stages set matches per team and a season start, with a season calculator for weeks, end date, matches a week and byes"
```

---

### Task 12: Whole-branch check

- [ ] **Step 1: Full suite, typecheck, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: everything passes. `tests/scrimPoster.test.ts`'s scrim night reminder is known to fail on some wall-clock times on master too (memory note of 2026-10-01). If it fails, run it alone a second time and report it; do not change it in this branch.

- [ ] **Step 2: Walk a whole event on a scratch database**

On the scratch dev server (never `data/pug.db`):

1. Create an event with Swiss (3 rounds, top 4) then single elimination with a third-place match.
2. Publish it and open registration.
3. Register 6 teams, or insert them as `tests/playFixture.ts` does.
4. Close the list and press Start.
5. Enter every result from the desk, including one forfeit and one correction.
6. Disqualify one team in round 2.

Check that:
- the bye rotates;
- the disqualified team's open match becomes a forfeit and the team is never paired again;
- the bracket starts with the top 4;
- the event page shows the bracket and the placements, 1st to 6th, with the disqualified team unplaced.

Take a 390 px screenshot of the finished event page.

- [ ] **Step 3: Spec coverage note**

In the final report, list what of spec section 3 and Rollout item 2 is done, what is deferred and to which plan (the "Not in this plan" list), and every place the build differed from this plan.

---

## Self-review notes (for the reviewer of this plan)

- Spec section 3 elimination and round robin: Task 4 (library), Task 5 (rows), Task 6 (flow). Swiss: Tasks 2, 3, 6. League: Task 1 (settings), Task 3 (circle, season), Task 6 (both pairings, byes), Task 8 (week labels and dates), Task 11 (editor and calculator). Standings tiebreakers: Task 2. Brackets-manager errors (spec Error handling) surface as `result_locked` / `match_not_open` refusals that write nothing (Task 6). The spec's "leave the match in confirming and alert staff" belongs to the automatic flow of plan 3.
- Spec Testing: "brackets-manager adapter: round-trip of single elim, double elim with reset, round robin; result propagation" is Task 4. "Swiss: unit tests against known tables and edge cases (odd counts, forced repeats, late drops)" is Task 3, plus Task 6 for late drops.
- `event_matches` columns follow spec section 4, plus `grp`, `score_a`, `score_b`, which spec section 4 implies (campaign score difference, per-group brackets) but does not list.
