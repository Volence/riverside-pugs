# Drafts plan D2a: Make teams (auto-balance), draft entries and captains who run them

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a draft's cut is published, staff press **Make teams** on the desk and choose **Auto-balance**.
- The site builds one team of 4 around each captain from the pool, balanced by SR.
- Staff see the fairness readout, can move players between teams by hand, and publish.
- Publishing creates the event's entries: one per captain, starters = captain + 3, no subs.
- Captains name their team and upload a logo.
- Each captain runs their entry everywhere a team captain does today: check-in is not needed, but match room readiness, veto, lineups, prep and booking are. The event then starts and plays like any tournament.

The second choice at Make teams, **Let captains pick** (the live draft room), is plan D2b. It fills the same working assignment this plan creates and publishes through the same step.

**Architecture:**
- **The working assignment** is a new nullable column `draft_signups.draft_team`: which captain's team a pool player is on, keyed by the captain's signup id. `src/events/drafts.ts` writes it, as it writes every draft table.
- **A pure balancer.** `src/events/draftBalance.ts` builds and improves the assignment.
- **Entries.** `src/events/entries.ts` (already the only writer of `event_entries` and `event_entry_players`) gains `createDraftEntries`, which turns a final assignment into entries in one transaction. It also gains `setEntryIdentity`, for a draft entry's name, tag and logo.
- **Captain column.** `event_entries` gains `captain_steamid`. A shared `entryManagers(db, entry)` answers "who runs this entry": a site team's managers, or a draft entry's captain. It replaces the team-only `managersOf(db, teamId)` at every call site.
- **Starting.** `startEvent` and the runner's auto-start accept a draft event once its teams are made.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Fastify 5, better-sqlite3, openskill (`predictWin`, already a dependency), vitest (`npx vitest run <file>`; web from the repo root `npx vitest run --project web web/src/...`), `npm run typecheck`. Preact web. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` section 5 (After the draft), plus the owner's flow of 2026-10-07: after the cut, a desk **Make teams** step that offers Auto-balance by SR around the seeded captains, with staff swaps then publish, or a live captains' draft (D2b). It builds on D1 (`docs/superpowers/plans/2026-10-07-drafts-1-signups-and-cut.md`, branch `drafts-1`), whose rulings and writer split this plan keeps.

## Owner rulings this plan builds on (2026-10-07, given)

1. Make teams offers two choices, Auto-balance or Let captains pick. Staff choose at that step, not when creating the event.
2. Auto-balance uses SR only, around the seeded captains (one per team). Staff can swap players, then publish.
3. Pick captains (D1 addendum) takes the top SR among want and willing signups. Staff can switch any captain by hand.

## Rulings this plan makes (for the owner to confirm)

1. **D2 is split.** D2a covers the auto-balance path and everything that follows it: entries, captains running entries, identity, starting. D2b covers the live draft room, player cards, captains' pick lists and the caster scenes. D2a alone makes a draft event playable end to end.
2. **When Make teams opens.** It is available once the cut is published, with no clock gate; staff run it on draft night. Choosing a method stores `events.team_mode` (`'auto'` or `'live'`). In D2a, `'live'` is shown but disabled, with "Coming soon: the live draft room". Staff can reset the method until teams are published.
3. **The balancer's target.** It minimises the spread of team average SR (the highest team average minus the lowest). Ties go to the smaller sum of squared deviations from the mean team average. The algorithm:
   - Start from a snake deal of the pool by SR onto the captains. The weakest captain picks first, matching the spec's default first-pick rule.
   - Hill-climb with pairwise swaps of pool players between teams until no swap improves the target.
   - The result is deterministic for the same input, because ties keep signup order. Captains never move.
4. **What staff can change after balancing.** Staff can move one pool player to another team in exchange for one of that team's pool players, which keeps 4 per team. **Rebalance** recomputes from scratch and drops hand moves, after a confirm. The fairness readout refreshes after every change.
5. **The fairness readout is for staff and the event organizer only** (spec). Per team it shows the captain, average SR, total SR and the 4 names. Overall it shows the spread (highest average minus lowest) and a pairwise win forecast for each pair of teams. The forecast runs openskill `predictWin` over each player's current-season `{mu, sigma}`, as `matchForecast` does. It is never in a player or public response.
6. **What publishing teams does.** It creates the entries in one transaction:
   - one entry per captain, named "Team <captain display name>" (max 24 characters, cut cleanly);
   - an empty tag, no logo, and `team_id` NULL;
   - `captain_steamid` = the captain, starters = the captain + their 3, no subs;
   - seeds from team average SR through the existing `seedOrder`.

   It also sets `events.teams_made_at`. The cut's bench stays as `draft_signups` bench (D3 stand-ins use it). Each starter gets the DM `draft_team_made`.
7. **Captain identity.**
   - Until the event goes live, a draft entry's captain may set the name (team name rules: `normalizeName`, 3 to 24 characters, slur filter; it must be unique among the event's entries), the tag (`normalizeTag` rules, optional), and the logo (the team logo flow, 256 px PNG through `checkLogo` and `store.putLogo`).
   - Staff can do the same from the desk.
   - After live, the name is frozen, like a team entry's snapshot.
8. **Who runs a draft entry.** `entryManagers(db, entry)` returns `[captain_steamid]` for a draft entry. For a team entry it returns exactly what `managersOf(db, team_id)` returns today. Every call site switches to it, so the match room (ready, veto, lineups), the series pick, prep, notices and views all treat the draft captain as the team's captain.
9. **Booking.** A tournament side with `team_id` NULL books with the entry's name and its four starters, as `TournamentSide.teamId: number | null` already allows. `series.ts` stops refusing it.
10. **Starting.** A draft event can start once `teams_made_at` is set, with at least 2 active entries, following the same rules as a team event. `startEvent` drops its team-only refusal for that case. The runner's auto-start at `starts_at` includes draft events with `teams_made_at` set.
11. **The event page.** Once teams are made, the Teams list shows the draft entries (names, logos, the four players) where team events show theirs. The cut lists stay visible above it. The captain sees an identity panel (name, tag, logo).
12. **Writer split** (guard test). `draft_signups.draft_team` and `events.team_mode` are written by `drafts.ts`. `event_entries`, `event_entry_players` and `events.teams_made_at` are written by `entries.ts` (already in `ENGINE` and `ENTRY_WRITERS`). Every mutation is one transaction with one `event_log` row, and a refusal writes nothing.

## Global Constraints

- Team events behave exactly as before. `entryManagers` returns the same managers as today for a team entry, and its tests cover the team path at each call site that changes.
- Draft kind against event status `'draft'`: never test one when the other is meant.
- Privacy:
  - SR, the fairness readout, notes, preferences and forecasts never appear in a public or player response.
  - The public teams list shows names, logos and players only, like team entries.
- Writers: see Ruling 12. `tests/eventLogGuard.test.ts` lists every new export as a read or a mutation, with one row on success and nothing written when the audit insert is blocked.
- Admins write on the desk and mods read (`requireStaff` GET, `requireAdmin` + `logAdmin` POST). Player routes use `allowedActive`, and routes follow `competitive_enabled`.
- DMs go out only after commit, through `Notifier`, `messages.ts` and `notices.ts` (the D1 pattern: `NotifyType` + `NOTIFY_TYPES` label, `EventNotifyType` + case, `tellX`, and the label assertion in `tests/notify.test.ts`).
- Never write em dashes in code, comments, copy, commits or docs. Commit messages follow the repo style (plain sentences). Do not push. Do not deploy, restart, stage or rcon any box.
- Work in the worktree `/home/volence/l4d/pug/.claude/worktrees/drafts-2a` (branch `drafts-2a`, cut from `drafts-1`'s head). Run `npm ci` in it and in `web/`. The 7 `tests/skeetStreakPoster.test.ts` wall-clock failures are known; keep everything else passing.

## Review Focus

1. **The manager switch must not change team events.** Every former `managersOf(db, team_id)` call gives the same answer for a team entry. Task 1 adds a team-entry regression test at the room (ready/veto/lineup), the series pick, prep and the notices.
2. **A draft captain is a full captain.** The match room accepts the draft captain's Ready, veto steps and lineup lock. A non-captain starter of the draft entry is refused, as a non-manager of a team is today. Task 1 pins it.
3. **Publishing over a changed cut.** A signup removed after the cut, or a captain not on any team, must make publish refuse (`teams_changed`) rather than create a short entry. Each entry must have exactly 4 starters. Task 4 pins it.
4. **Balancer edge cases.** Two teams. Equal SRs (deterministic). A pool whose best player is far above everyone else (the spread is still minimised by putting them on the weakest captain's team). Unrated players: use the same display SR `seasonSr` returns, which gives the unrated default. Task 2 pins each.
5. **Identity after live.** A rename after the event goes live is refused (`entries_locked` or the existing equivalent). Name collisions within the event are refused (`name_taken`). Task 5 pins both.

---

### Task 1: Who runs an entry (captain column and `entryManagers`)

**Files:**
- Modify: `src/db.ts`, adding `ensureColumn` `event_entries.captain_steamid TEXT REFERENCES players(...)` (match the players key column and FK style used by `event_entry_players`). Add it to the account merge (`src/mergePlayers.ts`, `MERGE_HANDLED_PLAYER_COLUMNS`).
- Modify: `src/events/entries.ts`. Add `export function entryManagers(db: DB, entry: { team_id: number | null; captain_steamid: string | null }): string[]`, where a draft entry (team_id NULL) gives `[captain_steamid]` (or `[]` when null) and a team entry gives `managersOf(db, team_id)`. Keep `managersOf` itself, since team code may still use it for teams.
- Modify: every call site that today derives an entry's managers from `managersOf(db, entry.team_id)`:
  - `src/events/room.ts` (`sideOf` ~l.108, veto/lineup actions ~l.544 and ~l.863)
  - `src/events/series.ts` (the pick ~l.794)
  - `src/routes/events.ts` (prep ~l.303)
  - `src/events/notices.ts` (~l.31, 38, 94)
  - `src/events/views.ts` (~l.195-197)

  Run `grep -rn "managersOf" src` and convert each one that is about an event entry.
- Modify: `src/events/series.ts` ~l.296-298. Stop refusing a side whose entry has `team_id` NULL. Use the entry's `name` and its starters for the booking side (`TournamentSide.teamId` stays null).
- Test: `tests/entryManagers.test.ts` (new) and the existing room/series/prep/notices tests.

**Interfaces:**
- Produces `entryManagers` and the `captain_steamid` column. Task 4 writes the column, and later tasks and D2b read `entryManagers`.

- [ ] **Step 1: Write the failing tests.**
  1. `entryManagers` for a team entry equals `managersOf(team)` (captain + co-captain); for a draft entry it is `[captain]`.
  2. Regression on team entries: the existing room, series, prep and notices tests still pass unchanged (run them).
  3. A draft-entry fixture: build a draft event in the D1 fixture (`tests/draftFixture.ts`), then insert two entries directly with SQL in the test (team_id NULL, captain_steamid set, 4 starters each) and a stage + match the way the room tests set one up.
     - The draft captain can press Ready, take a veto step and lock a lineup.
     - Another starter of that entry is refused with the same error a non-manager gets today.
  4. Booking a series between two draft entries produces a side with the entry name and four starters (see how `tests/series.test.ts` asserts a side).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the full suite, then typecheck.**
- [ ] **Step 5: Commit:** "An event entry's managers come from its team or, for a draft entry, its captain, so a draft captain runs the match room, the pick, prep and booking (plan D2a)".

### Task 2: The balancer (pure)

**Files:**
- Create: `src/events/draftBalance.ts`, `tests/draftBalance.test.ts`.

**Interfaces:**
```ts
export interface BalancePlayer { steamid: string; sr: number; order: number }   // order = signup order, for ties
export interface BalancedTeam { captain: string; players: string[]; avgSr: number; totalSr: number } // players = the 3 pool players, in pick order
/** Ruling 3. captains.length >= 2, pool.length === captains.length * 3, else throws. */
export function balanceAroundCaptains(captains: BalancePlayer[], pool: BalancePlayer[]): BalancedTeam[];
/** The target for a given assignment: [spread, sumSquares]; lower is better, compared in that order. */
export function balanceScore(teams: { captain: BalancePlayer; players: BalancePlayer[] }[]): [number, number];
```
- Snake deal: sort the captains by SR ascending (ties by `order`). Sort the pool by SR descending (ties by `order`). Deal round 1 left to right, round 2 right to left, round 3 left to right.
- Improve: repeatedly try every swap of two pool players on different teams. Apply the best strictly improving swap. Stop when none improves. Cap at 1000 iterations as a guard.
- The returned teams keep the captain order of the input `captains` array, so callers map them back.

- [ ] **Step 1: Write the failing tests:**
  1. 2 captains (1000, 1500) and a pool of 6 (1600, 1400, 1300, 1200, 1100, 900). The result's spread is the minimum over all 10 possible splits. Brute-force the splits in the test to prove it.
  2. 5 captains and 15 pool players with SRs 1000 + 25*i. The spread is ≤ the snake deal's spread. Same input gives the same output (deterministic).
  3. All SRs equal: the result is the snake deal, in signup order.
  4. One pool star at 2500, everyone else about 1200: the star goes to the weakest captain's team.
  5. Wrong sizes throw.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**
- [ ] **Step 5: Commit:** "A pure balancer builds draft teams of four around the captains by SR, from a snake deal improved by swaps (plan D2a)".

### Task 3: Make teams (method, working assignment, staff moves, fairness readout)

**Files:**
- Modify: `src/db.ts`. Add `ensureColumn` for `draft_signups.draft_team INTEGER` (the captain's signup id, NULL for captains and bench), `events.team_mode TEXT CHECK (team_mode IS NULL OR team_mode IN ('auto','live'))` and `events.teams_made_at TEXT`.
- Modify: `src/events/drafts.ts`. Add the mutations below. Each is one transaction with one log row. Each is refused with `cut_not_published` before the cut, `teams_made` after teams are published, and the existing `wrong_status` outside registration and checkin.
  ```ts
  export function chooseTeamMode(db: DB, o: { eventId: number; mode: 'auto' | 'live' | null; actor: string; now: Date }): Checked<null>; // 'live' refused 'live_draft_later' in D2a; null resets and clears draft_team
  export function autoBalance(db: DB, o: { eventId: number; actor: string; now: Date }): Checked<{ teams: number }>; // team_mode must be 'auto'; writes draft_team for every pool player from balanceAroundCaptains; replaces any earlier assignment (log 'draft_teams_balanced')
  export function moveDraftPlayers(db: DB, o: { eventId: number; a: string; b: string; actor: string; now: Date }): Checked<null>; // a and b are pool players on different teams; swaps their draft_team (log 'draft_teams_swapped')
  export function draftTeamsOf(db: DB, eventId: number): { captain: SignupRow; players: SignupRow[] }[] | null; // read; null while any pool player has no team
  ```
  Use SR from `seasonSr` (as `draftFacts` does) and signup order for `order`.
- Create: `src/events/draftFairness.ts` (read only):
  ```ts
  export interface FairnessTeam { captain: string; captainName: string; names: string[]; avgSr: number; totalSr: number }
  export interface Fairness { teams: FairnessTeam[]; spread: number; forecasts: { a: number; b: number; winA: number }[] } // a, b = team indexes
  export function draftFairness(db: DB, eventId: number): Fairness | null;
  ```
  The forecasts use openskill `predictWin` over `{ mu, sigma }` from `player_ratings` for the current season. Unrated players get the defaults that `rating.ts` uses. Find how `matchForecast` builds them and reuse that helper rather than copying it.
- Modify: `src/routes/adminEvents.ts`:
  - `GET /api/admin/events/:id/draft/teams` returns `{ mode, teamsMadeAt, teams: [{ captain: {steamid,name}, players: [{steamid,name,sr}] }] | null, fairness }` (staff).
  - POST routes: `/draft/mode` `{ mode }`, `/draft/balance`, `/draft/move` `{ a, b }` (admin + `logAdmin`).
- Test: `tests/draftTeams.test.ts` (new), plus `tests/eventLogGuard.test.ts` (new reads and mutations, and `draft_team`/`team_mode` in the drafts writer regex).

- [ ] **Step 1: Write the failing tests** on `draftFixture` with 21 signups, 5 teams, 5 captains picked and the cut published:
  1. `chooseTeamMode('auto')` then `autoBalance`: every pool player has a `draft_team` matching `balanceAroundCaptains`, and bench players have none.
  2. `moveDraftPlayers` swaps two players. Two players on the same team are refused `bad_move`, and so is a captain or a bench player.
  3. `chooseTeamMode('live')` is refused `live_draft_later`.
  4. `chooseTeamMode(null)` clears the assignment.
  5. Before the cut: `cut_not_published`.
  6. `draftFairness`: the spread equals the max minus min of the team averages, there is one forecast per pair (10 for 5 teams), and each `winA` is in (0,1).
  7. Routes: a mod can GET and gets 403 on the POSTs, and the admin POSTs work. A non-staff `GET /api/events/:slug` contains no `avgSr`, `spread` or `winA`.
  8. Writer guard rows.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass (full suite once, then typecheck).**
- [ ] **Step 5: Commit:** "Staff choose how a draft's teams are made, auto-balance them by SR around the captains, swap players by hand and read a staff-only fairness readout (plan D2a)".

### Task 4: Publish teams (entries) and starting a draft event

**Files:**
- Modify: `src/events/entries.ts`:
  ```ts
  /** Ruling 6: entries from the final assignment, one transaction, one 'draft_teams_published' row. */
  export function createDraftEntries(db: DB, o: { eventId: number; actor: string; now: Date }): Checked<{ entries: number[] }>;
  ```
  Inside the transaction:
  - Re-read the assignment with `D.draftTeamsOf`. Refuse `teams_changed` unless every captain has exactly 3 pool players and every active pool signup is on a team.
  - Refuse `teams_made` if `teams_made_at` is set, and `wrong_status` outside registration and checkin.
  - Insert the entries:
    - `team_id` NULL, the name "Team <captain display name>" (cut to 24 characters, using the display-name source the views use), tag `''`, `logo_key` NULL;
    - `registered_by` = actor, `captain_steamid` = captain;
    - status `'registered'` (or whatever status a locked team entry carries before start; check `lockEntries`), with 4 starters through the private `addPlace`.
  - Set seeds by `seedOrder` over each entry's average SR. `entrySr` may already compute this; reuse it.
  - Set `events.teams_made_at = now`.

  The route then DMs every starter with `draft_team_made`.
- Modify: `src/events/play.ts` `startEvent` (~l.168-189). For a draft event, require `teams_made_at` instead of failing `wrong_status`. Keep every other check (locked_at, at least 2 seeded entries).
- Modify: `src/events/runner.ts`. Auto-start draft events with `teams_made_at` set at `starts_at`, alongside team events.
- Modify: `src/events/flow.ts` `startEventFlow` only if it needs the same allowance (check it).
- Modify: `src/routes/adminEvents.ts`. Add `POST /api/admin/events/:id/draft/publish-teams`.
- DM `draft_team_made`, label "Draft: your team". Wording: `You are on ${teamName} in ${event}, captained by ${captainName}. Your captain can rename the team before the event starts: ${link}` For the captain: `Your team in ${event} is set: ${names of the other three}. Name your team and upload a logo before the event starts: ${link}`
- Test: `tests/draftTeams.test.ts` (extend), `tests/play.test.ts` (draft start), `tests/eventRunner.test.ts` (draft auto-start).

- [ ] **Step 1: Write the failing tests:**
  1. Publish after `autoBalance` creates 5 entries: each has 4 starters, `captain_steamid` set, the default name, and seeds 1 to 5 by average SR. `teams_made_at` is set, there is one log row, and the DMs go to 20 starters (the captain variant to the 5 captains).
  2. A signup removed after balancing (pool short) gives `teams_changed`, and nothing is written.
  3. Publishing twice gives `teams_made`.
  4. `startEvent` on a draft event: before teams `wrong_status` (or `teams_not_made`; pick one and say which), after teams ok, and the first stage is planned with 5 entries.
  5. A runner tick at `starts_at` starts a draft event whose teams are made, and does not start one whose teams are not made.
  6. The writer guard: `createDraftEntries` is in the entries MUTATIONS.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass (full suite, typecheck).**
- [ ] **Step 5: Commit:** "Publishing a draft's teams creates one entry per captain with its four starters, seeded by average SR and DMed, and a draft event with its teams made starts like any tournament (plan D2a)".

### Task 5: Captain identity (name, tag, logo)

**Files:**
- Modify: `src/events/entries.ts`:
  ```ts
  export function setEntryIdentity(db: DB, o: { eventId: number; entryId: number; steamid: string; staff: boolean; name?: string; tag?: string; logoKey?: string | null; now: Date }): Checked<null>;
  ```
  - Draft entries only (`not_draft_entry` otherwise).
  - The caller must be the entry's `captain_steamid` unless `staff` (`not_captain`).
  - Refused `entries_locked` once the event status is `live`, `finished` or `cancelled`. Use the module's existing error name for "too late" if one fits.
  - Name through `normalizeName` (`bad_name`, `name_not_allowed`). It must be unique among the event's active entries by the normalized key (`name_taken`).
  - Tag through `normalizeTag`, or `''`.
  - One `entry_identity_set` log row.
- Modify: `src/routes/events.ts`:
  - `POST /api/events/:slug/entries/:entryId/identity` `{ name?, tag? }`.
  - `POST /api/events/:slug/entries/:entryId/logo` `{ png }`, copying `src/routes/teams.ts:327`: `checkLogo`, `store.canTake`, `store.putLogo`, then `setEntryIdentity` with `logoKey`.
  - The admin equivalents in `adminEvents.ts`.
- Modify: `src/events/views.ts`. `myEventView` gains `captainOf: { entryId, name, tag, logoKey } | null` for a draft captain.
- Test: `tests/draftIdentity.test.ts` (new).

- [ ] **Step 1: Write the failing tests:**
  1. The captain renames, sets a tag, and uploads a logo (a valid 256 px PNG fixture; see the team logo route tests).
  2. A non-captain starter gets `not_captain`, and staff are allowed.
  3. A duplicate name in the event gives `name_taken`.
  4. A slur or a bad length is refused.
  5. After the event goes live: `entries_locked`.
  6. A team entry gets `not_draft_entry`.
  7. The public event view shows the new name and logo.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**
- [ ] **Step 5: Commit:** "A draft captain names the team, sets a tag and uploads a logo until the event goes live (plan D2a)".

### Task 6: Desk and event page (web)

**Files:**
- Create: `web/src/routes/admin/events/DraftTeamsPanel.tsx` (+ test). Mount it in `EventEditor.tsx` after `DraftPanel` for draft-kind events once `cutAt` is set.
- Modify: `EventEditor.tsx`. Show `PlayPanel` and `EntriesPanel` for draft events once `teamsMadeAt` is set (their gates are `entryKind === 'team'` today).
- Create: `web/src/routes/event/DraftIdentityPanel.tsx` (+ test), shown to a draft captain on the event page.
- Modify: `web/src/routes/Event.tsx`. Show the Teams list for draft events once teams are made, and keep the cut lists.
- Modify: `web/src/api.ts`. Add the calls and types for Tasks 3 to 5.

**Behaviour, desk panel (admins write, mods read):**
- Heading: "Make teams".
- Before a method is chosen, two buttons:
  - "Auto-balance by SR"
  - "Let captains pick" (disabled, with the muted line "Coming soon: the live draft room").
- With auto chosen:
  - Show "Balance teams", or "Rebalance" with the confirm "Rebalance from scratch? Hand moves are lost."
  - Show the teams as cards: captain first, then three players with SR, and the average SR on the card.
  - A "Swap with..." select on each pool player (players on other teams) calls the move route.
  - Show the fairness block: "Spread: <n> SR between the strongest and weakest team" and a small table of pairwise forecasts ("<A> vs <B>: <p>% / <q>%").
  - A "Change method" link calls mode null after a confirm.
- "Publish teams" asks for confirmation with title "Publish the teams?" and body "Entries are created, every player gets a DM with their team, and captains can name their team until the event starts. Teams cannot be changed afterwards."
- After publish: "Teams published <time>", and the entries panel and Play panel take over.

**Behaviour, captain identity panel:** a heading "Your team". It has a name input (3 to 24 characters), a tag input (2 to 5 letters or digits, optional), and a logo upload using `web/src/teamLogo.ts` `toLogoPng`, plus a Save button. Errors show the server sentences. The panel is hidden after the event goes live.

- [ ] **Step 1: Write the failing tests:**
  - The panel's method buttons and the disabled live option.
  - The balance and rebalance confirm.
  - A swap calls the API.
  - The fairness numbers render.
  - Publish confirms with the exact title.
  - A mod sees no buttons.
  - The identity panel saves the name and tag and uploads a logo.
  - The event page shows the Teams list for a draft event with teams made, with no SR anywhere in the DOM.
- [ ] **Step 2: Fail. Step 3: Implement (styles in `web/src/styles/app.css` with existing tokens only, near the D1 draft rules). Step 4: Pass (web project, typecheck).**
- [ ] **Step 5: Commit:** "The desk gains a Make teams panel for auto-balance with swaps and the fairness readout, and the event page shows draft teams with a captain's name, tag and logo panel (plan D2a)".
