# Drafts plan D1: signups, the cut and captain selection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A draft-kind event takes individual signups. Each signup gives a captain preference and a short note. Signups close on the clock. Staff then run the cut on the Events desk: the team count, the captains (with the fallback of captaincy offers down the SR list by DM), and pool against bench. Publishing the cut shows captains, pool and bench on the event page, and every signup gets a DM with their role and the draft time. Plan D2 (the draft room) picks up from a published cut.

**Architecture:**
- **One writer.** A new module `src/events/drafts.ts` owns the two new tables, `draft_signups` and `draft_captain_offers`, and the event columns the cut sets. Like `events.ts` and `entries.ts`, each mutation is one transaction that re-reads, checks, writes and adds exactly one `event_log` row through `E.logEvent`.
- **Pure rules.** A pure module `src/events/draftRules.ts` holds the arithmetic that needs no database: team count, the default pool cut, captain offer order and publish validation.
- **Reliability facts.** A read-only `src/events/draftFacts.ts` reads SR, PUG reliability and eligibility facts for the desk.
- **The clock.** The existing `EventRunner` minute tick closes signups at their time and moves captaincy offers along.
- **Routes and DMs.** Routes go in `src/routes/events.ts` (player) and `src/routes/adminEvents.ts` (desk). DMs go through the existing `Notifier`, `messages.ts` and `notices.ts`.
- **Web.** The web gets a desk `DraftPanel` and draft sections on the public event page.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npx vitest run <file>`; web tests from the repo root with `npx vitest run --project web web/src/...`), `npm run typecheck`, `npm run build`. Web: Preact + preact-iso + @testing-library/preact. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md`, sections 1 (Signups) and 2 (The cut), Error handling, Testing, Rollout item 1. It depends on T1a/T1b (`docs/superpowers/plans/2026-10-01-tournaments-1a-events.md`, `2026-10-05-tournaments-1b-registration.md`), whose events module, eligibility and writer guards this plan reuses.

## Rulings this plan makes (for the owner to confirm)

1. **Captain preference has three values: `want`, `willing`, `no`.** The spec names both "players volunteer" and "signups who ticked willing to captain", which are two levels, but gives one boolean. Volunteers are `want`. The fallback offers go to `willing`, highest SR first. A `no` is never offered captaincy. Staff may still make anyone a captain by hand, and the desk marks that "(did not volunteer)".
2. **Event status reuses `registration` for "signups open".** `openRegistration` now accepts draft events. Signups close at the event's `signupsCloseAt` (the clock), or when staff press Close signups. Either sets `events.locked_at`. After that nobody signs up or withdraws on their own; staff can still remove a signup with a reason.
3. **Two new event fields live in a JSON column `draft_json`: `{ signupsCloseAt, draftAt }`, ISO UTC.** They are required for a draft event, with `signupsCloseAt <= draftAt <= startsAt`. Plan D2 adds its own keys (first pick, pick seconds). The parser keeps unknown keys it does not own, so D2 does not need a migration.
4. **The cut is a staff draft stored in the database, then published once.**
   - The working cut lives on the signups' `role` column, together with `events.draft_teams`.
   - `events.cut_at` stays NULL until Publish. Before it, players and the public see nothing of the cut.
   - Publish validates and stamps `cut_at`, then sends the DMs. A published cut is final in D1, and nothing changes it.
   - D2's room reads it. Plan D3 handles dropouts through stand-ins.
5. **The default cut follows the spec.** Teams = floor(active signups / 4). The pool is the first teams x 3 non-captains by signup time, and everyone else is bench.
   - Changing the team count or the captains recomputes pool and bench from signup order.
   - Staff swaps between pool and bench (one in, one out) survive until the next team-count or captain change. The desk says so.
   - Staff may lower the team count (minimum 2) but never raise it above floor(active / 4).
6. **Captaincy offers follow the spec: one at a time, by DM, with a 30-minute answer window** (setting `draft_offer_minutes`, default 30).
   - Staff press "Offer captaincy" once.
   - From then on the runner offers to the next eligible `willing` signup by SR each time an offer is declined or expires, while chosen captains are fewer than the team count and the cut is unpublished.
   - Offers stop on their own when the count is met. They also stop when staff press "Stop offers", when the list runs out (a problem on the admin feed), or when the cut is published.
   - An accepted offer makes the player a captain in the working cut.
   - A player declines once per event. The runner never re-offers to the same player.
7. **Eligibility (T1b's `problemsOf`, role `starter`) applies at signup and again at publish.**
   - Publish refuses while any active signup has a problem, and lists them.
   - Staff then remove those signups, with reason `ineligible`, which DMs the player.
   - "Nobody who signed up is turned away" means nobody is turned away for numbers: everyone eligible ends up captain, pool or bench.
8. **Reliability on the desk is PUG reliability over 30 days, shown beside each signup:**
   - abandons: bans with `reason LIKE 'Abandoned match #%'` that staff did not lift by hand, with the same exclusion `abandonBanMinutes` uses;
   - no-shows: uncleared `penalties` rows of kind `no_show`.
   Two small read functions are added beside the existing SQL. This plan does not touch scrim reliability.
9. **The public event page before publish shows the signup count and names only** (the spec says no SR ranks and no notes). After publish it shows Captains, Pool and Bench as name lists, in signup order within each list. It never shows SR, notes or captain preference.
10. **Notes are free text of 1 to 80 characters, optional.** They run through the existing name/slur filter used for team names, and are shown to staff only in D1 (D2's player cards show them to captains).
11. **DMs:**
    - `draft_cut_role` goes to every active signup at publish: your role, the draft time and the event link.
    - `draft_captain_offer` asks the player to accept or decline on the event page, and says when the offer expires.
    - `draft_signup_removed` tells a player staff removed their signup, and why.
    A signup itself is not DMed; the page confirms it.
12. **`startEvent` keeps refusing draft events.** D2 creates the entries.

## Global Constraints

- Only draft-kind events (`entry_kind = 'draft'`) use these paths. Team events behave exactly as before. A team event's `draft_json` is NULL and ignored.
- Event status `'draft'` (unpublished) is a different thing from entry kind `'draft'`. Never test `status === 'draft'` when you mean the kind, or the other way round. A draft-kind event in status `'draft'` is a 404 to non-staff, like any unpublished event.
- One active signup per player per event: a unique partial index on `(event_id, steamid) WHERE withdrawn_at IS NULL`. Withdrawing and signing up again before close is allowed, and adds a new row.
- Every write to `draft_signups`, `draft_captain_offers`, `events` (draft columns) and `event_log` from this plan is in `src/events/drafts.ts`. Each mutation is one transaction that writes exactly one `event_log` row on success and nothing on refusal. `tests/eventLogGuard.test.ts` enforces it: `drafts.ts` joins its `ENGINE` set, and a new describe block covers its mutations as the entries block does. Admin routes also `logAdmin`.
- `draft_signups.steamid` and `draft_captain_offers.steamid` reference `players`. Both columns join `MERGE_HANDLED_PLAYER_COLUMNS` in `src/mergePlayers.ts`, and the merge moves them (the keeper keeps one active signup per event; drop the duplicate the way the T1b entry-player merge does). `tests/mergePlayers.test.ts` enforces it.
- Public routes follow `competitive_enabled` exactly as T1a's do (a closed switch is a 404). Player actions use `allowedActive`. The desk routes follow the existing split: staff (mods) read with `requireStaff`, admins write with `requireAdmin`.
- Privacy: SR, notes, captain preference, reliability and offers never appear in a public or player response, except the player's own signup (their own preference and note) and their own open offer.
- Every number a person might tune is a setting: `draft_offer_minutes` (default 30, 5 to 240) in the Competitive group, with `DEFAULT_SETTINGS` + `SETTINGS_SCHEMA` (parity test `tests/adminSettings.test.ts`).
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`. Work in the worktree `/home/volence/l4d/pug/.claude/worktrees/drafts-1` (branch `drafts-1`). Run `npm ci` in it and in `web/`. The 7 `tests/skeetStreakPoster.test.ts` failures depend on the wall clock and fail on master too. Ignore them, and keep every other test passing.

## Review Focus

1. **Kind against status confusion.** A draft-kind event in status `registration` takes signups. A team event in `registration` refuses `POST .../signup` with `not_draft`. An unpublished draft-kind event is a 404 to a non-staff signup. Task 2 pins all three.
2. **A signup at the closing minute.** Signups close at `signupsCloseAt` even if the tick runs late. `signUp` checks `at < signupsCloseAt` itself, not only `locked_at`. Task 2 pins a signup one second after close with `locked_at` still NULL (refused, `closed`).
3. **Publishing over a stale working cut.** Between building the cut and Publish, a signup may be removed or an offer accepted. Publish re-derives the counts in its transaction and refuses with a reason (`cut_changed` naming the counts). It never publishes a cut whose pool is not exactly teams x 3. Task 3 pins it.
4. **The offer chain under concurrency with staff.** An offer accepted after staff set the captain count lower (so it is no longer needed) still makes the player a captain. Captains over the count make Publish refuse (`too_many_captains`), and staff choose. The runner never has two open offers for one event. Task 4 pins both.
5. **Privacy in every response.** A non-staff `GET /api/events/:slug` and `/mine` on a draft event, before and after publish, contain no `sr`, `note`, `captainPref`, reliability or other players' offers. Task 2 and Task 6 assert on the JSON.

---

### Task 1: Schema, draft fields, and opening signups

**Files:**
- Modify: `src/db.ts`: new tables and `ensureColumn`s, next to the event tables (around l.364-457 and the T1b `ensureColumn`s at ~l.1875):
  ```sql
  CREATE TABLE IF NOT EXISTS draft_signups (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    steamid TEXT NOT NULL REFERENCES players(steamid),
    captain_pref TEXT NOT NULL CHECK (captain_pref IN ('want','willing','no')),
    note TEXT,
    created_at TEXT NOT NULL,
    withdrawn_at TEXT,
    withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR withdraw_reason IN ('withdrawn','removed','ineligible')),
    role TEXT CHECK (role IS NULL OR role IN ('captain','pool','bench')),
    role_manual INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS draft_signups_active ON draft_signups (event_id, steamid) WHERE withdrawn_at IS NULL;
  CREATE TABLE IF NOT EXISTS draft_captain_offers (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    steamid TEXT NOT NULL REFERENCES players(steamid),
    offered_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answer TEXT CHECK (answer IS NULL OR answer IN ('accept','decline','expired','stopped')),
    answered_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS draft_offers_open ON draft_captain_offers (event_id) WHERE answer IS NULL;
  ```
  The `players` key column may not be `steamid`. Check the players table and the FK style of `event_entry_players`, and match it.
  New event columns, added with `ensureColumn`: `draft_json TEXT`, `draft_teams INTEGER`, `cut_at TEXT`, `offers_on INTEGER NOT NULL DEFAULT 0`.
- Modify: `src/events/validate.ts`: `DraftFields { signupsCloseAt: string; draftAt: string }` and `EventFields.draft: DraftFields | null`. `parseEventFields` requires `draft` for kind `draft` (errors `bad_draft_times`, plus `draft_times_order` when the order `signupsCloseAt <= draftAt <= startsAt` fails) and ignores it for kind `team` (stored NULL). Add sentences to the error map in the file's style.
- Modify: `src/events/events.ts`: `fieldsOf` reads `draft_json` (keep unknown keys when writing back: merge parsed fields over the stored object). The create/update paths store it. `openRegistration` drops the `draft_signups_later` refusal for draft kind. `startEvent` still refuses draft kind (unchanged).
- Modify: `web/src/routes/admin/events/EventFieldsForm.tsx` and `web/src/api.ts`: when the entry kind is Draft, two datetime inputs, "Signups close" and "Draft night", with help text "When signups close and staff can run the cut." and "When the live draft runs (plan D2). Everyone gets this time in their role DM." Use the form's existing datetime input pattern for `startsAt`.
- Modify: the tests that pinned the old refusal (`tests/events.test.ts:213` expects `draft_signups_later`). It now expects success for a draft event with draft fields.
- Test: `tests/events.test.ts`, `tests/draftFields.test.ts` (new), the existing EventFieldsForm test file.

**Interfaces:**
- Produces: `EventFields.draft`, `fieldsOf(row).draft`, and the new tables and columns. `V.fail` gains the errors named in this task.

- [ ] **Step 1: Write the failing tests.**
  - `tests/draftFields.test.ts`, through the events module the way `tests/events.test.ts` creates events:
    1. A draft-kind event without `draft` is refused `bad_draft_times`.
    2. `signupsCloseAt` after `draftAt` is refused `draft_times_order`, and so is `draftAt` after `startsAt`.
    3. A valid draft event stores `draft_json`, and `fieldsOf` returns it.
    4. A team event's `draft` is ignored and stored as NULL.
    5. Updating a draft event's name keeps `draft_json`, including an unknown key `{"firstPick":"lowest_sr"}` written directly into the column.
    6. `openRegistration` on an announced draft event succeeds.
    7. `startEvent` on a draft event still refuses.
  - Web: the fields form shows the two inputs only for Draft, and sends `draft: { signupsCloseAt, draftAt }`.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/draftFields.test.ts tests/events.test.ts`
- [ ] **Step 3: Implement** the schema, validation, `fieldsOf`, `openRegistration` and the form.
- [ ] **Step 4: Run them and see them pass,** then `npm run typecheck`.
- [ ] **Step 5: Commit** "Draft events gain signup close and draft night times, open for signups, and two tables for signups and captaincy offers (plan D1)".

### Task 2: Signups (writer, rules, routes, views)

**Files:**
- Create: `src/events/drafts.ts`, the only writer of `draft_signups`, `draft_captain_offers` and the draft columns of `events`.
- Create: `src/events/draftRules.ts` (pure).
- Modify: `src/events/runner.ts`: close signups on the clock.
- Modify: `src/routes/events.ts`: `POST /api/events/:slug/signup`, `POST /api/events/:slug/withdraw-signup`; the `GET /:slug` and `/:slug/mine` views.
- Modify: `src/events/views.ts`: `eventView` gains `draft: { signupsCloseAt, draftAt, signups: number, names: string[] } | null` for draft-kind events (names in signup order, display names as entry views render them). `myEventView` gains `signup: { captainPref, note, role: null } | null`. Role stays null until Task 3 publishes.
- Modify: `src/mergePlayers.ts` (both new steamid columns; for `draft_signups`, keep at most one active row per event on the keeper), and `tests/eventLogGuard.test.ts` (`drafts.ts` in `ENGINE` and in the table writer regex; a new describe block like the entries guard at l.161-276, listing every `drafts.ts` export as a read or a mutation, each mutation tested for one `event_log` row and for nothing written when a trigger blocks the log insert).
- Test: `tests/draftSignups.test.ts` (new), `tests/draftSignupRoutes.test.ts` (new), `tests/eventLogGuard.test.ts`, `tests/mergePlayers.test.ts`, `tests/eventRunner.test.ts`.

**Interfaces:**
- Produces, in `drafts.ts`:
  ```ts
  export type CaptainPref = 'want' | 'willing' | 'no';
  export interface SignupRow { id: number; event_id: number; steamid: string; captain_pref: CaptainPref; note: string | null; created_at: string; withdrawn_at: string | null; withdraw_reason: 'withdrawn' | 'removed' | 'ineligible' | null; role: 'captain' | 'pool' | 'bench' | null; role_manual: number }
  export function activeSignups(db: DB, eventId: number): SignupRow[];               // signup order (created_at, id)
  export function signupOf(db: DB, eventId: number, steamid: string): SignupRow | null; // active only
  export function signUp(db: DB, o: { eventId: number; steamid: string; captainPref: CaptainPref; note: string | null; now: Date }): Checked<SignupRow>;
  export function withdrawSignup(db: DB, o: { eventId: number; steamid: string; now: Date }): Checked<null>;
  export function removeSignup(db: DB, o: { eventId: number; steamid: string; reason: 'removed' | 'ineligible'; actor: string; now: Date }): Checked<null>;
  export function closeSignups(db: DB, o: { eventId: number; actor: string | null; now: Date }): Checked<null>;
  ```
  `Checked` and `V.fail` are T1b's. Error names: `not_draft`, `closed`, `already_signed_up`, `not_signed_up`, `bad_note`, `ineligible` (with `detail` problems, as `refuseWith` sends), `not_found`.
- In `draftRules.ts`: `export const NOTE_MAX = 80; export function cleanNote(s: unknown): string | null | 'bad'` (trims; empty means null; longer than 80, a control character, or failing the existing name/slur filter means `'bad'`). Find the filter teams use for names in `src/teams/` and reuse it.

**Behaviour:**
- `signUp` (one transaction):
  - Re-read the event; `not_found` unless the event is published (status is not `'draft'`); `not_draft` unless the kind is `'draft'`.
  - `closed` unless status is `registration`, `locked_at` is NULL and `now < signupsCloseAt`.
  - Eligibility with T1b's `playerFacts` + `problemsOf(e, f, 'starter')`, giving `ineligible` with problems.
  - `already_signed_up`; then insert, and `logEvent(... 'draft_signup', { steamid, captainPref })`.
  - Do not put the note in the log detail. Notes are private.
- `withdrawSignup`: the same open-window rule, sets `withdrawn_at` and `withdraw_reason = 'withdrawn'`, logs `draft_withdraw`.
- `removeSignup` (staff): allowed until `cut_at` is set, sets the reason, logs `draft_signup_removed` with `{ steamid, reason }`. The route DMs `draft_signup_removed` (Task 3 adds the type; in this task the route only calls a `tellSignupRemoved` that Task 3 creates. To avoid a forward reference, create the DM type and `tellSignupRemoved` here, following the "a new DM type touches" list below).
- `closeSignups`: kind `draft`, status `registration`, `locked_at` NULL; sets `locked_at = now`, logs `draft_signups_closed` with `{ by: actor ?? 'clock', signups: <count> }`.
- Runner: in `step()`, a second query for draft-kind events in `registration` with `locked_at IS NULL` whose `draft_json.signupsCloseAt <= now` calls `closeSignups(actor null)`. Keep the team-event query unchanged.
- Adding a DM type (from the T1b pattern): (1) `NotifyType` and `NOTIFY_TYPES` in `src/notify/notify.ts`, labelled "Draft: signup removed by staff"; (2) `EventNotifyType` and a `switch` case in `src/events/messages.ts` (wording: `Staff removed your signup for <event>: <reason sentence>.`, where `removed` reads "an organizer removed it" and `ineligible` reads "you are not eligible for this event"; names via `escapeName`); (3) `tellSignupRemoved` in `src/events/notices.ts`; and the label assertion in `tests/notify.test.ts`.
- Routes: `POST /api/events/:slug/signup` body `{ captainPref, note }` → `allowedActive`, the visible-event check, `signUp`, reply `{ ok: true, signup }`, or `refuse`/`refuseWith` exactly as the entry POSTs do. `POST /:slug/withdraw-signup`. Admin: `POST /api/admin/events/:id/signups/:steamid/remove` body `{ reason }`, and `POST /:id/close-signups`, both `requireAdmin` + `logAdmin`.

- [ ] **Step 1: Write the failing tests.** `tests/draftSignups.test.ts`, with a fixture `draftFixture()` in a new `tests/draftFixture.ts`. Build it from `entryFixture`'s steps but with `entryKind: 'draft'` and draft times: switch everyone, 21 activated players with Discord and 5 completed PUGs each, SR set via `player_ratings` as `tests/entriesLifecycle.test.ts:17` does (SR 1000 + 25*i), event published and in registration, `signupsCloseAt = START - 2h`, `draftAt = START - 1h`. Cases:
  1. Sign up with `want` and the note "prefer infected": the row is stored, there is one `draft_signup` log without the note, and `signupOf` returns it.
  2. A second signup gives `already_signed_up`. Withdraw, then sign up again: allowed, with two rows and one active.
  3. A team event gives `not_draft`.
  4. An unpublished draft event gives `not_found`.
  5. One second after `signupsCloseAt` with `locked_at` NULL: `closed`.
  6. A player with 2 PUGs: `ineligible`, problems `['pugs']`.
  7. Notes: 81 characters, or one with a slur from the filter's test list, gives `bad_note`. "   " stores NULL.
  8. `closeSignups` sets `locked_at`. After it, signUp and withdraw give `closed` and removeSignup still works.
  9. Runner: a tick at `signupsCloseAt` closes signups once, and a second tick is a no-op.
  10. The writer-guard block passes for every `drafts.ts` export.
  11. The merge moves an active signup to the keeper, and keeps one if both had one.

  `tests/draftSignupRoutes.test.ts`, HTTP on the wall clock (`startsAt` days ahead, as `tests/eventEntryRoutes.test.ts` does):
  1. Sign up and withdraw over HTTP.
  2. A switch-closed 404.
  3. A non-staff `GET /api/events/:slug` has `draft.signups` and `draft.names`. A JSON string search finds none of `"sr"`, `"note"`, `"captainPref"` (the player's own `/mine` has their own note and preference).
  4. The admin remove sends the DM: assert the notifier fake as `tests/adminEventEntries.test.ts` does.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then the full suite once and `npm run typecheck`.
- [ ] **Step 5: Commit** "Draft events take individual signups with a captain preference and a private note, close them on the clock, and staff can remove a signup (plan D1)".

### Task 3: The cut (team count, captains, pool and bench, publish)

**Files:**
- Modify: `src/events/drafts.ts` (cut mutations) and `src/events/draftRules.ts` (pure cut arithmetic).
- Create: `src/events/draftFacts.ts` (read-only desk facts: SR, PUG reliability, eligibility problems per signup).
- Modify: `src/routes/adminEvents.ts` (desk GET + POSTs), `src/events/views.ts` (public cut lists after publish, the player's role), `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts` (DM `draft_cut_role`).
- Test: `tests/draftCut.test.ts` (new), `tests/draftRules.test.ts` (new), `tests/adminDraftRoutes.test.ts` (new), `tests/eventLogGuard.test.ts`.

**Interfaces:**
- `draftRules.ts`:
  ```ts
  export function maxTeams(activeCount: number): number;   // floor(n / 4)
  /** Roles for every active signup: captains as given, then pool = first teams*3 non-captains in signup order, rest bench. */
  export function defaultRoles(signups: { steamid: string }[], captains: ReadonlySet<string>, teams: number): Map<string, 'captain' | 'pool' | 'bench'>;
  export type CutProblem = 'too_few_teams' | 'too_many_teams' | 'too_few_captains' | 'too_many_captains' | 'pool_size' | 'unassigned' | 'ineligible';
  /** Why a working cut cannot be published, in this order of checks; [] = publishable. */
  export function cutProblems(o: { teams: number | null; active: number; captains: number; pool: number; unassigned: number; ineligible: number }): CutProblem[];
  ```
  `cutProblems`: `teams` null or < 2 gives `too_few_teams`; teams > maxTeams(active) gives `too_many_teams`; captains < teams `too_few_captains`; captains > teams `too_many_captains`; pool ≠ teams*3 `pool_size`; unassigned > 0 `unassigned`; ineligible > 0 `ineligible`.
- `drafts.ts` mutations (each one transaction, one log row, refused with `cut_published` once `cut_at` is set and `not_closed` while `locked_at` is NULL):
  ```ts
  export function setDraftTeams(db: DB, o: { eventId: number; teams: number; actor: string; now: Date }): Checked<null>;   // 2..maxTeams; recomputes non-manual roles
  export function setCaptain(db: DB, o: { eventId: number; steamid: string; captain: boolean; actor: string; now: Date }): Checked<null>; // recomputes non-manual roles
  export function swapPoolBench(db: DB, o: { eventId: number; poolSteamid: string; benchSteamid: string; actor: string; now: Date }): Checked<null>; // both role_manual = 1
  export function publishCut(db: DB, o: { eventId: number; actor: string; now: Date }): Checked<{ captains: string[]; pool: string[]; bench: string[] }>;
  ```
  "Recompute": `defaultRoles` over the active signups with the current captains. Swaps made by hand (`role_manual = 1`) are cleared and recomputed too (Ruling 5), so recompute sets `role_manual = 0` for all. On a fresh close, `closeSignups` (Task 2) already ran; the first `setDraftTeams` call fills roles. Make `closeSignups` also set `draft_teams = maxTeams(active)` and fill default roles with no captains (everyone non-captain, pool and bench by signup order), so the desk opens on the spec's default.
  `publishCut` re-reads active signups and eligibility facts inside the transaction and calls `cutProblems`. Problems give `cut_changed`, with detail the problem list and the counts. Otherwise it sets `cut_at = now` and `offers_on = 0`, marks any open offer `stopped`, and logs `draft_cut_published` with the three counts. The route then DMs everyone (`tellCutRole`).
- `draftFacts.ts`: `export interface SignupFacts { steamid: string; name: string; sr: number; captainPref: CaptainPref; note: string | null; signedUpAt: string; role: ...; manual: boolean; abandons30d: number; noShows30d: number; problems: Problem[] }` and `export function signupFacts(db: DB, eventId: number, now: Date): SignupFacts[]`. Base the abandon count on `src/abandon.ts:23-31` and the no-show count on `penalties` (kind `no_show`, `cleared_at IS NULL`, `at >= now - 30 days`; check the column names). Add the two helpers next to that SQL as exported functions (`abandonsSince`, `noShowsSince`) rather than copying the SQL.
- Desk routes (`requireStaff` for GET, `requireAdmin` + `logAdmin` for POSTs), mirroring the entries routes at `adminEvents.ts:306-360`:
  - `GET /api/admin/events/:id/draft` returns `{ lockedAt, cutAt, teams, maxTeams, offersOn, openOffer: { steamid, name, expiresAt } | null, problems: CutProblem[], signups: SignupFacts[] }`. The desk sorts by role, then SR descending for captains and volunteers, then signup order.
  - `POST /:id/draft/teams` `{ teams }`; `POST /:id/draft/captain` `{ steamid, captain }`; `POST /:id/draft/swap` `{ pool, bench }`; `POST /:id/draft/publish`.
- Views after publish (public): `draft.cut: { captains: string[]; pool: string[]; bench: string[] } | null` (names only, signup order). `/mine` `signup.role` becomes the player's published role (null before publish).
- DM `draft_cut_role`: label "Draft: your role after the cut". Wording by role:
  - captain: `You are a captain in <event>. The draft is <draftAt as the site formats event times in DMs>. Build your pick list before then: <event link>`
  - pool: `You are in the draft pool for <event>. The draft is <time>; captains pick you live: <link>`
  - bench: `You are on the free-agent bench for <event>. Captains can call on you as a stand-in, so keep the night free if you can: <link>`

  Find how existing event DMs format a time (`messages.ts`) and use the same helper.

- [ ] **Step 1: Write the failing tests.**
  - `tests/draftRules.test.ts`: `maxTeams` (0→0, 7→1, 8→2, 21→5); `defaultRoles` (21 signups, 5 teams, captains {s3, s10}: pool is the first 15 non-captains in order, bench the remaining 4); `cutProblems` for each problem and for the publishable case.
  - `tests/draftCut.test.ts`, on `draftFixture` with 21 signups:
    1. Closing gives `draft_teams` 5 and 15 pool / 6 bench with no captains. `cutProblems` is `too_few_captains`.
    2. 5 × `setCaptain` gives 5 captains, 15 pool (the first 15 non-captains), 1 bench, and `[]` problems.
    3. `swapPoolBench` moves both and marks them manual. A later `setDraftTeams(4)` recomputes: 4 teams need 4 captains, so `too_many_captains`. 12 pool, the rest bench, manual flags cleared.
    4. `setDraftTeams(6)` is refused, because 21 signups give at most 5 teams.
    5. Publish: `cut_at` set, the three lists, one log row. Any later cut mutation gives `cut_published`.
    6. Stale publish: remove a pool player right before publish. `cut_changed` with `pool_size` (14 vs 15), and `cut_at` stays NULL.
    7. An ineligible signup (PUG count lowered after signup) makes publish refuse `cut_changed` with `ineligible`.
    8. Before close every cut mutation gives `not_closed`.
    9. `signupFacts` shows abandons and no-shows from seeded `bans`/`penalties` rows, inside and outside the 30 days.
  - `tests/adminDraftRoutes.test.ts`:
    - A mod can GET and gets 403 on every POST.
    - Admin POSTs work and `logAdmin`.
    - Publish DMs every active signup with the right role text (notifier fake).
    - After publish, a non-staff `GET /api/events/:slug` has `draft.cut` names and no `sr`/`note`/`captainPref` strings.
    - `/mine` shows the player's own role.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Extend the writer-guard block with the new mutations.
- [ ] **Step 4: Run them and see them pass,** then the full suite once and typecheck.
- [ ] **Step 5: Commit** "Staff run a draft's cut on the desk, team count, captains and pool against bench with reliability beside each signup, and publishing it DMs every signup their role and the draft time (plan D1)".

### Task 4: Captaincy offers down the SR list

**Files:**
- Modify: `src/events/drafts.ts`, `src/events/draftRules.ts`, `src/events/runner.ts`, `src/routes/events.ts`, `src/routes/adminEvents.ts`, `src/events/views.ts` (`/mine` gains `offer: { expiresAt } | null` for the player's own open offer), the three DM files (type `draft_captain_offer`), `src/db.ts` + `src/settingsSchema.ts` (setting `draft_offer_minutes`), and the admin feed problem publish used by T3b (`publishAdminEvent` with a problem kind; find it).
- Test: `tests/draftOffers.test.ts` (new), `tests/draftSignupRoutes.test.ts`, `tests/adminSettings.test.ts` (parity is automatic), `tests/notify.test.ts`.

**Interfaces:**
- `draftRules.ts`: `export function nextOfferee(signups: { steamid: string; captainPref: CaptainPref; sr: number; role: string | null; eligible: boolean }[], offered: ReadonlySet<string>): string | null`. It returns the highest-SR `willing` signup that is not a captain, is eligible and was never offered in this event. Ties go to the earlier signup (input order is signup order).
- `drafts.ts`:
  ```ts
  export function startOffers(db: DB, o: { eventId: number; actor: string; now: Date; minutes: number }): Checked<{ offered: string | null }>; // offers_on = 1, offers the first now
  export function stopOffers(db: DB, o: { eventId: number; actor: string; now: Date }): Checked<null>;   // offers_on = 0, open offer -> stopped
  export function answerOffer(db: DB, o: { eventId: number; steamid: string; accept: boolean; now: Date }): Checked<null>; // accept -> setCaptain logic inline (same transaction)
  /** Runner step: expire a due offer and, while offers_on and captains < teams, offer the next; off when none left. Returns what happened for DMs/alerts. */
  export function stepOffers(db: DB, o: { eventId: number; now: Date; minutes: number }): { offered: string | null; exhausted: boolean };
  ```
  Each mutation is one transaction with one log row: `draft_offers_started`, `draft_offers_stopped`, `draft_offer_answered` `{ steamid, accept }`, `draft_offer_expired`, `draft_offer_made` `{ steamid }`. A `stepOffers` that both expires one offer and makes the next is ONE mutation by the guard's rule, so either log a single `draft_offer_expired` whose detail includes `{ next }`, or split it into two exported mutations that the runner calls in turn. Choose the one the guard test can express, and say which in the report.
  Refusals: `cut_published`, `not_closed`, `no_offer` (answer without an open offer of yours), `offer_expired` (answered after `expires_at` but before the runner expired it: treat as expired, and record it so), and `offers_not_needed` from `startOffers` when captains ≥ teams.
- An accepted offer adds the captain even if staff lowered the team count meanwhile (Review Focus 4). Publish's `too_many_captains` then makes staff choose.
- Runner: for draft events with `offers_on = 1` and `cut_at IS NULL`, call `stepOffers` each tick. On `offered`, DM `draft_captain_offer`. On `exhausted`, set `offers_on = 0` inside `stepOffers` and publish an admin-feed problem "Draft <event>: no more signups willing to captain; <n> of <teams> captains chosen."
- Player routes: `POST /api/events/:slug/captain-offer` `{ accept: boolean }`. Desk: `POST /api/admin/events/:id/draft/offers` `{ on: boolean }`.
- DM `draft_captain_offer`, labelled "Draft: captaincy offer". Wording: `<event> needs another captain and you said you were willing. Accept or decline on the event page by <expiresAt time>: <link>`
- Setting: `draft_offer_minutes`, group Competitive, label "Captaincy offer window", help "Minutes a signup has to accept a captaincy offer before it goes to the next willing player.", int 5 to 240, default 30.

- [ ] **Step 1: Write the failing tests.** `tests/draftOffers.test.ts` on `draftFixture` (21 signups; mark 3 `willing` with SR 1400, 1300 and 1200, one `no` with SR 1500, and one `want` already made captain; teams 5):
  1. `startOffers` offers the 1400 player (never the `no` player), and the open offer expires at +30 minutes.
  2. Decline: the next `stepOffers` offers 1300.
  3. Expiry: with no answer by +30 minutes, `stepOffers` expires the offer and offers 1200.
  4. Accept: the player becomes a captain and the next tick offers the next one while captains < teams.
  5. When the list runs out, `exhausted` is true, `offers_on` is 0, and one admin-feed problem goes out.
  6. Never two open offers at once: the unique index holds, and a double tick in the same minute makes one offer.
  7. Publish stops an open offer, and the record reads `stopped`.
  8. An answer after `expires_at` and before the tick gives `offer_expired`.
  9. An accept after `setDraftTeams` lowered the count still adds the captain, and publish then refuses `too_many_captains`.
  10. The writer-guard rows.
  - Routes: the player accept and decline over HTTP. `/mine` shows only the player's own open offer, and another player's `/mine` shows `offer: null`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass,** then the full suite once and typecheck.
- [ ] **Step 5: Commit** "When too few signups volunteer to captain, staff start captaincy offers that go one at a time by DM down the willing list by SR, each with an answer window (plan D1)".

### Task 5: The desk's Draft panel (web)

**Files:**
- Create: `web/src/routes/admin/events/DraftPanel.tsx` and `DraftPanel.test.tsx`.
- Modify: `web/src/routes/admin/events/EventEditor.tsx`. For a draft-kind event in status `registration` or later, mount `DraftPanel` where `EntriesPanel` mounts (l.209), with `canEdit={isAdmin}`. Show "Close signups" in place of "Open check-in" or "Close the entry list" for draft events.
- Modify: `web/src/api.ts`. `adminApi.eventDraft(id)`, `draftTeams`, `draftCaptain`, `draftSwap`, `draftPublish`, `draftOffers`, `closeSignups` and `removeSignup` call Tasks 2 to 4's routes. Add the types `AdminDraftView` and `SignupFacts`.

**Behaviour:** follow `EntriesPanel.tsx` (useFetch, useAction, confirm, `onChange`):
- **Header line.** Before close, "Signups open until <time>: <n> signed up". After close, "<n> signups · <teams> teams (most <maxTeams>)" with a number input and Set. After publish, "Cut published <time>".
- **Problems.** While unpublished, `problems` are shown as sentences: too_few_captains "Choose <teams - captains> more captain(s).", pool_size "The pool must be exactly <teams*3>.", ineligible "<n> signups are not eligible; remove them." The other kinds get sentences in the same style.
- **Signups table.** Columns:
  - Name
  - SR
  - Captain: Wants, Willing or No
  - Note
  - Signed up (time)
  - Reliability: "<a> abandons, <n> no-shows (30 d)", muted when both are 0
  - Role chip: Captain, Pool or Bench, with "(moved by hand)" when manual and "(did not volunteer)" on a captain whose preference is `no`
  - Actions (admins, unpublished only): Make captain or Remove captain; Swap with... (select a player in the other list); Remove signup (confirm, with a reason choice of "Removed by an organizer" or "Not eligible")

  Eligibility problems show as a warning line under the name, using T1b's problem sentences (`problemText`).
- **Captaincy offers.** "Offer captaincy to willing signups" or "Stop offers". When an offer is open: "Offered to <name>, answer by <time>".
- **Publish the cut.** The button is disabled while there are problems. Confirm with the title "Publish the cut?" and the body "Captains, pool and bench appear on the event page and every signup gets a DM with their role and the draft time. The cut cannot be changed afterwards."
- **Mods** see everything read-only, with the existing "Read only: admins run events." line.

- [ ] **Step 1: Write the failing tests** (`DraftPanel.test.tsx`, mocked `adminApi` as `EntriesPanel.test.tsx` does): it renders the header, problems and table from a fixture view; Make captain calls `draftCaptain(id, steamid, true)`; Publish is disabled with problems and asks for confirmation with the exact title when clear; a mod sees no action buttons; Remove signup sends the chosen reason.
- [ ] **Step 2: Run them and see them fail.** **Step 3: Implement.** **Step 4: Run them and see them pass** (web suite + `npx tsc --noEmit -p web`).
- [ ] **Step 5: Commit** "The Events desk gains a Draft panel for signups, the cut, captaincy offers and publishing (plan D1)".

### Task 6: Draft sections on the public event page (web)

**Files:**
- Modify: `web/src/routes/Event.tsx`. Replace the placeholder `Draft event: individual signups open later.` (l.127; its assertion is in `web/src/routes/Event.test.tsx:84-87`) with the draft sections.
- Create: `web/src/routes/event/DraftSignupPanel.tsx` (+ test), the signed-in player's own panel, shown where `EntryPanel` shows for team events.
- Modify: `web/src/api.ts`. `eventsApi.signUp(slug, body)`, `withdrawSignup(slug)` and `answerCaptainOffer(slug, accept)`, plus the view types from Tasks 2 to 4.

**Behaviour:**
- **The Draft section, for everyone.**
  - A line with "Signups close <time> · Draft night <time>".
  - Before publish: "<n> signed up", then the names in signup order as plain chips. No SR, notes or preferences.
  - After publish: three lists, Captains, Pool and Bench, with names only.
- **The player panel (signed in).**
  - **Not signed up, signups open.** A form with a captain choice and a note:
    - three radio rows: "I want to captain", "I'll captain if needed", "I don't want to captain";
    - an optional note input with the placeholder "e.g. prefer infected, can't play after 02:00 UTC" and 80 characters max;
    - a "Sign up" button.
    - Ineligible answers show T1b's problem sentences, as `EntryPanel` does.
  - **Signed up, open.** "You are signed up" plus their preference and note, and a "Withdraw" button with a confirm.
  - **Signups closed, before publish.** "Signups are closed. Staff are making the cut; you will get a DM with your role."
  - **After publish.** "Your role: Captain", "Pool" or "Bench", with one sentence each, matching the DM wording.
  - **Open captaincy offer.** A highlighted box: "<event> needs another captain. Accept by <time>?" with Accept and Decline buttons.
  - **Not signed in or not active.** The existing sign-in prompt.

- [ ] **Step 1: Write the failing tests.**
  - `Event.test.tsx`: the old placeholder assertion becomes a draft-section assertion (count and names before the cut, three lists after). The test also asserts that no SR, note or preference text renders.
  - `DraftSignupPanel.test.tsx`:
    - signing up sends `{ captainPref: 'willing', note: 'prefer infected' }`;
    - withdraw asks for confirmation;
    - the closed state shows its text;
    - the role states show their text;
    - the offer box calls `answerCaptainOffer(slug, true)`.
- [ ] **Step 2: Run them and see them fail.** **Step 3: Implement.** **Step 4: Run them and see them pass** (web suite + web typecheck). Take one 390 px and one desktop screenshot of the event page in each state on a scratch dev server, if the repo's `npm run shoot` or dev-login recipe makes that cheap (see `docs/` or the T1b/T3a ledgers for the scratch-DB dev server recipe), and list the paths in the report. Skip the screenshots if it is not cheap, and say so.
- [ ] **Step 5: Commit** "The event page shows a draft's signups, then its captains, pool and bench, and a signed-in player signs up, withdraws and answers a captaincy offer there (plan D1)".
