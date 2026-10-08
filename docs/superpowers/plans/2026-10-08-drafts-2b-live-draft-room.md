# Drafts plan D2b1: player cards, captains' pick lists and the live draft room

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a draft's cut is published, every captain can read a card for each pool player and build a private, ordered pick list. When staff choose **Let captains pick** in the existing Make teams step and press **Start**, the captains snake-draft their teams live at `/event/:slug/draft`: a pick clock per pick, auto-picks from the captain's list (or by SR) on timeout or absence, staff pause, resume, undo, hand-over and reset, every change pushed to the open pages, and a web restart resumes exactly where the draft was. When the last pick lands, the existing D2a panel shows the teams and the fairness readout and staff publish them through the existing publish step.

D2b is split. This plan is **D2b1**. The next plan, **D2b2**, adds the caster studio draft scenes (pick reveal, board, on-the-clock); it reads the room through `draftRoomView` and the `draft:<eventId>` hub event this plan creates, so nothing here should need to change for it.

**Architecture:**
- **Pure rules** (`src/events/draftRules.ts`, extended): the room settings in `events.draft_json`, the round 1 order, the snake slots, the auto-pick choice and pick list cleaning. No database.
- **One writer** (`src/events/draftRoom.ts`, new): every write to the three new tables `draft_rooms`, `draft_picks` and `draft_pick_lists`, plus `draft_signups.draft_team` for a picked player (so D2a's `draftTeamsOf`, `draftFairness` and `createDraftEntries` work unchanged). Each mutation is one transaction that re-reads, checks, writes and adds exactly one `event_log` row; a refusal writes nothing.
- **Mode and settings** stay in `src/events/drafts.ts` (it already owns `team_mode` and is allowed to write `events`): `chooseTeamMode('live')` is allowed, leaving live is refused once the room has started, staff swaps are refused in live mode, and `setRoomSettings` writes the two settings into `draft_json`.
- **Cards** (`src/events/draftCards.ts`, new, read only) reuse the profile's completed-PUG queries; "Chemistry with you" is a new pair query `pairChemistry` in `src/chemistry.ts`, next to `chemistryFor`.
- **Clock** (`src/events/draftClock.ts`, new): in-memory heartbeats (presence) and a 1 s tick that auto-picks any running pick past its stored `deadline_at`. All draft state is in the database, so a restart only loses presence.
- **View and routes**: `src/events/draftRoomView.ts` tailors one response per viewer (public, captain or delegate, staff or organizer); `src/routes/draftRoom.ts` serves the public room routes behind `competitive_enabled` and the desk's room controls. Every change broadcasts `draft:<eventId>` through `Hub.broadcast`; pages refetch.
- **Web**: the room page `web/src/routes/EventDraft.tsx` with player cards and a pick list drawer, a "Draft room" link on the event page, and room controls inside the existing desk Make teams panel.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, openskill (already used by `rating.ts`), vitest (`npx vitest run <file>`; web: `npx vitest run --project web <file>`), `npm run typecheck` (server and web). Preact + preact-iso + @testing-library/preact (happy-dom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` sections 3 (Player cards and captain prep) and 4 (The draft room), plus its Error handling and Testing sections. It builds on D1 (`docs/superpowers/plans/2026-10-07-drafts-1-signups-and-cut.md`), D2a (`docs/superpowers/plans/2026-10-07-drafts-2a-make-teams.md`) and D2c (`docs/superpowers/plans/2026-10-07-drafts-2c-records-players-replace.md`), whose rulings and writer split this plan keeps.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/drafts-2b` (branch `drafts-2b`, cut from master `43408568`). `node_modules` is installed. Never use bare `git stash`. Do not push. Do not deploy, restart, stage or rcon any box, and never touch `/home/volence/l4d1-ds`.
- Never write em dashes (or en dashes) in code, comments, copy, commits or docs: use a comma, a colon, parentheses or "to".
- Commit messages follow the repo style: one plain sentence (or two) describing the change, ending with "(plan D2b1)".
- Auto-balance events behave exactly as before. A draft whose method is `'auto'` never reads or writes a room table except the pick list (Ruling 1).
- Writers (`tests/eventLogGuard.test.ts`):
  - `draft_rooms`, `draft_picks`, `draft_pick_lists` are written only in `src/events/draftRoom.ts`.
  - `draftRoom.ts` writes `draft_signups` only as `UPDATE draft_signups SET draft_team = ... WHERE ...`.
  - `events` (including `draft_json`) is still written only by the ENGINE files; the room settings go through `drafts.ts`.
  - Every new mutation adds exactly one `event_log` row on success and nothing when that row cannot be written.
- Privacy (spec): chemistry, captains' pick lists, signup notes and the fairness readout never appear in any response for a viewer who is not staff, not the event organizer and not the owning captain (or that captain's delegate for their own team). Cards' stats are public, as they are on profiles.
- Only completed PUGs count toward cards and chemistry: every match query builds its filter with `completedPug()` from `src/matchKinds.ts` (`tests/matchKindGuard.test.ts` enforces it).
- Admins write on the desk and mods read (`requireStaff` GET, `requireAdmin` + `logAdmin` POST). Player routes use the competitive switch exactly as `src/routes/events.ts` does.
- DMs go out only after commit, through `Notifier`, `messages.ts` and `notices.ts` (the D1 pattern: `NotifyType` + `NOTIFY_TYPES` label, `EventNotifyType` + case, `tellX`, and the label assertion in `tests/notify.test.ts`). A DM failure never fails the request.
- Refusal codes are short snake_case keys of `EVENT_ERRORS` in `src/events/validate.ts`, each with a plain-English sentence the web shows as is (the `ApiError` message), as every desk refusal does today.
- The 7 `tests/skeetStreakPoster.test.ts` wall-clock failures are known on master (checked 2026-10-08); keep everything else passing.

## Review Focus

1. **A double click at a snake turn.** The captain at the end of an odd round also has the first pick of the next round, so a second click (or a second tab) on the same pick must never take a second player. Every pick carries the `pickNo` the client saw, and a stale one is refused `pick_moved`. Task 3 pins it.
2. **The deadline auto-pick racing a late click.** At the deadline the tick and a captain's click can arrive together: exactly one pick lands for that slot, the other gets `pick_moved` or `not_due`, and a partial unique index on live picks is the database backstop. Task 3 pins it.
3. **A web restart mid-draft.** A fresh process has no heartbeats. The running pick keeps its stored deadline (no reset, no extension), a tick before it does nothing, a tick after it auto-picks, and a paused room stays paused. Task 6 pins it with two `DraftClock` instances over one database.
4. **Undo after the forced final pick.** The final pick is made by the site in the same transaction as the pick before it, so undoing only it would re-force it at once. Undo then takes back both, the room returns to running, and publishing is refused (`draft_not_done`) until the draft is done again. Task 4 pins it.
5. **A stale pick list.** A list may name players who were picked already, moved to the bench or are not in the pool at all. Auto-pick skips them and takes the first free player on the list, saving drops them, and reading drops them. Task 3 (auto-pick) and Task 4 (save and read) pin it.

## Rulings

Owner rulings are marked **(owner)**; the rest are decided for this plan and await owner review.

1. **(owner) Lists and cards open at the cut.** Pick lists and player cards open to every captain as soon as the cut is published, whatever Make teams method is chosen later. The room page says lists are "used if captains pick live". The cut DMs stay neutral about the method (already true).
2. **Pick list storage.** New table `draft_pick_lists (event_id, captain_steamid, list_json, updated_at)`, PK `(event_id, captain_steamid)`, `list_json` an ordered array of pool steamids. Saving is refused (`lists_closed`) once the room is done or teams are published. Entries not in the current pool are dropped on save and on read. Private to the captain (and their delegate, Ruling 16), staff and the event organizer.
   - *Plan deviation:* the pool cannot change after the cut is published (`removeSignup` and `swapPoolBench` both refuse once `cut_at` is set), so filtering on read is a safety net, not a routine path.
3. **Player cards.** Current-season SR and its trend (SR after each of the last 10 rated games), survivor play (SI damage and common kills a game), infected play (damage as SI and DPs landed a game), best special infected class (the class with the most `dmg_as_<class>` damage), the public `high_good` skill counters with their totals, recent form (last 10 completed PUG results), and the signup note. Stats are public. The note is shown only to captains (and delegates), staff and the organizer. "Chemistry with you" is shown only to the viewing captain (or delegate).
   - *Plan deviation:* `chemistryFor` returns a player's top three teammate lines, not a pair. "Chemistry with you" is a new `pairChemistry(db, a, b)` in `src/chemistry.ts` with the same alias-resolving roster join and the same `completedPug` filter: games together and won together, games against and won against.
4. **Room state.** Tables `draft_rooms` (one row per event: `status` `'ready' | 'running' | 'paused' | 'done'`, `order_json`, `pick_seconds`, `deadline_at`, `paused_left_ms`, `started_at`, `finished_at`, `delegates_json`) and `draft_picks` (the spec's columns plus `id`; `undone_at` flags an undo, never a delete). A pick also writes the picked signup's `draft_team` (the captain's signup id). `src/events/draftRoom.ts` owns every write.
   - *Plan deviation:* the steamid columns of the new tables carry no `REFERENCES players` foreign key. The account merge (`MERGE_HANDLED_PLAYER_COLUMNS`, enforced by `tests/mergePlayers.test.ts`) would otherwise need new cases, including a collision rule for the live-pick unique index, for data that lives one night.
5. **Settings.** `draft_json` gains `draftFirstPick` (`'lowest_sr'` default, `'highest_sr'`, `'random'`) and `pickSeconds` (default 75, 30 to 300), editable on the desk until the room starts. The order is computed at Start from current-season SR, ties by signup order; random is a `crypto.randomInt` Fisher-Yates shuffle of the captains in signup order, stored in `order_json`. Snake: round r forward when odd, backward when even. 3 rounds.
6. **Flow.** Choosing `'live'` in `chooseTeamMode` is allowed. Switching away from live is allowed only while the room is `'ready'`. Staff press Start. Staff controls: pause; resume (deadline = now + time left, Ruling 17); undo the last pick (flags `undone_at`, clears that player's `draft_team`, the pick reopens with a full clock, works after done while teams are unpublished, returning to running); hand a team's picking to its first drafted player; Reset room (every live pick flagged undone, `draft_team` cleared, back to `'ready'`). All audited with `logEvent`. `moveDraftPlayers` is refused in live mode (`live_mode`).
   - *Plan deviation:* the room row is created at Start, not when the method is chosen, and a reset room keeps its row with status `'ready'`. A live draft with no row reads as `'ready'`. This keeps every room-table write inside `draftRoom.ts` (writer split): `chooseTeamMode` only reads the room's status.
7. **Clock.** Every running pick has a stored `deadline_at`. A 1 s tick (`DraftClock.tick`, the `RoomClock` pattern: `setInterval` + `unref` in `src/server.ts`) calls `autoPickDue` for every running room past its deadline. Auto-pick takes the highest-ranked free player on that captain's list, else the highest current-season SR (ties by signup order), flagged `auto = 1`, with a `null` log actor. A restart resumes exactly: an overdue pick is auto-picked on the first tick, a paused room stays paused.
8. **Absence.** A captain (or delegate) is present if they sent a room heartbeat (a POST every 10 s from the room page) within the last 25 s, kept in memory only. A pick request also counts as a heartbeat. When an absent picker comes on the clock the deadline is now + 5 s instead of the full clock. A picker who arrives mid-clock keeps the remaining time.
9. **Final pick and done.** With one pool player left the last pick is made at once in the same transaction, flagged auto, and the room goes `'done'`. The existing Make teams panel then shows the teams and the fairness readout (staff and organizer only, unchanged) and the existing Publish teams step.
10. **Live updates.** Every room change broadcasts `draft:<eventId>`. Pages refetch `GET /api/events/:slug/draft`, tailored per viewer. The root socket (`useLiveState`) ignores `draft:` events, so a running draft does not make every open page refetch the queue. The page animates a reveal for any pick it had not seen, and the picker hears `playPopSound` when their turn starts.
11. **Notifications.** At Start every captain gets the DM `draft_room_open` with the room link ("Draft: the live draft room opened"). No per-pick DMs.
12. **Routes.** Public (behind the switch): `GET /api/events/:slug/draft`, `POST .../draft/pick`, `POST .../draft/heartbeat`, `GET` and `PUT .../draft/list`, `GET .../draft/cards` (captains, delegates, staff, organizer). Desk: `GET /api/admin/events/:id/draft/room` and `POST /api/admin/events/:id/draft/room/{start,pause,resume,undo,reset,delegate,settings}`.
13. **Web.** The room page `/event/:slug/draft`: board, on-the-clock banner with a big countdown, pool grid of cards (name filter, sort by SR or name), Pick buttons for the picker, pick log, and the captain's pick list drawer (Up, Down, Remove, Add, Save), usable at 390 px. The event page gets a "Draft room" link once the cut is published. The desk enables "Let captains pick" and shows room controls and settings.
14. **(spec) Privacy test.** A dedicated test (Task 6) proves chemistry, lists, notes and fairness never reach anyone but the owning captain (or delegate), staff and the organizer.
15. **(spec) Integration test.** A 20-signup event from signups to cut to live draft to published entries, with one absent captain (all their picks auto), a simulated restart and an undo (Task 9).
16. **Delegates.** A delegate (the team's first drafted player, Ruling 6) picks for the team, heartbeats, reads and saves that team's pick list, and sees the notes and their own chemistry, exactly as an acting captain. Auto-pick always uses the captain's list.
17. **Resume floor.** Resume sets the deadline to now + the time left at pause, but never less than 5 s, so viewers see who is up before any auto-pick.
18. **Picks name their slot.** `POST .../draft/pick` carries `{ player, pickNo }`. A pick for any slot but the current one is refused `pick_moved` (Review Focus 1). A manual pick that arrives after the deadline but before the tick took it still counts.
19. **Publish gate.** In live mode `createDraftEntries` is refused `draft_not_done` until the room is done, on top of D2a's `teams_changed` check.
20. **Event log actions.** `draft_room_settings`, `draft_room_started`, `draft_pick` (detail: pickNo, captain, steamid, auto, last, done), `draft_room_paused`, `draft_room_resumed`, `draft_pick_undone`, `draft_delegate_set`, `draft_room_reset`, `draft_list_saved` (detail: captain and list size only, never its order).
21. **Card cost.** The public room response carries the free pool as cards. Cards are memoized per event for 60 s in the route module, so a pick that makes every viewer refetch does not recompute 15 to 45 cards per viewer.
22. **Before Start and outside live mode.** `GET .../draft` answers for any published cut: status `'none'` when the method is not live (cards and the captain's list still work, teams show captains only, and an auto-balance working assignment is never shown), `'ready'` in live mode before Start. Before the cut it is refused `cut_not_published`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/events/draftRules.ts` | modify | Pure: room settings, round 1 order, snake slots, auto-pick choice, pick list cleaning |
| `src/db.ts` | modify | `draft_rooms`, `draft_picks` (+ live-slot and live-player unique indexes), `draft_pick_lists` |
| `src/events/validate.ts` | modify | New `EVENT_ERRORS` keys; `live_draft_later` removed |
| `src/events/drafts.ts` | modify | `chooseTeamMode` allows live and guards leaving it; `moveDraftPlayers` refuses live; new `setRoomSettings` |
| `src/events/draftRoom.ts` | create | Every room write: start, pick, auto-pick, pause, resume, undo, delegate, reset, save list; reads `roomOf`, `livePicks`, `roomState`, `pickListOf`, `captainFor` |
| `src/events/entries.ts` | modify | `createDraftEntries` refuses `draft_not_done` in live mode |
| `src/events/draftCards.ts` | create | `playerCard` (read only) |
| `src/chemistry.ts` | modify | `pairChemistry` |
| `src/events/draftClock.ts` | create | Presence, the 1 s tick, push |
| `src/events/draftRoomView.ts` | create | The per-viewer room response |
| `src/routes/draftRoom.ts` | create | Public room routes and desk room controls |
| `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts` | modify | `draft_room_open` DM |
| `src/server.ts` | modify | Build `DraftClock`, tick it, register the routes |
| `web/src/api.ts` | modify | Types and calls |
| `web/src/hooks/useLiveState.ts` | modify | Ignore `draft:` events |
| `web/src/routes/EventDraft.tsx` | create | The room page |
| `web/src/routes/event/draft/draftText.ts` | create | Pure page helpers (fresh picks, pool sort, trend text) |
| `web/src/routes/event/draft/DraftCard.tsx` | create | One player card |
| `web/src/routes/event/draft/PickListDrawer.tsx` | create | The captain's list editor |
| `web/src/routes/Event.tsx` | modify | "Draft room" link |
| `web/src/AppRoutes.tsx` | modify | `/event/:slug/draft` |
| `web/src/routes/admin/events/DraftRoomControls.tsx` | create | Desk room controls and settings |
| `web/src/routes/admin/events/DraftTeamsPanel.tsx`, `EventEditor.tsx` | modify | Enable live, mount the controls, hide swaps in live mode |
| `web/src/styles/app.css` | modify | Room, card, board, drawer, controls (existing tokens only) |
| `tests/draftRoomFixture.ts` | create | Shared live-draft fixture for the server tests |
| tests | create/modify | See each task |

---

### Task 1: The room's pure rules

**Files:**
- Modify: `src/events/draftRules.ts`
- Test: `tests/draftRoomRules.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `src/events/draftRules.ts`):
  ```ts
  export type FirstPick = 'lowest_sr' | 'highest_sr' | 'random';
  export const FIRST_PICKS: readonly FirstPick[];
  export const PICK_SECONDS_DEFAULT = 75; export const PICK_SECONDS_MIN = 30; export const PICK_SECONDS_MAX = 300;
  export const ROUNDS = 3; export const LIST_MAX = 200;
  export interface RoomSettings { firstPick: FirstPick; pickSeconds: number }
  export function roomSettingsOf(draftJson: string | null): RoomSettings;
  export function parseRoomSettings(raw: unknown): RoomSettings | null;
  export interface RankedPlayer { steamid: string; sr: number; order: number }
  export function firstRoundOrder(captains: RankedPlayer[], mode: FirstPick, rand: (n: number) => number): string[];
  export interface Slot { pickNo: number; round: number; captain: string }
  export function snakeSlots(order: string[], rounds?: number): Slot[];
  export function autoPickChoice(available: RankedPlayer[], list: readonly string[]): string;
  export function cleanPickList(raw: unknown, pool: ReadonlySet<string>): string[] | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/draftRoomRules.test.ts
import { describe, it, expect } from 'vitest';
import {
  autoPickChoice, cleanPickList, firstRoundOrder, parseRoomSettings, roomSettingsOf, snakeSlots,
  PICK_SECONDS_DEFAULT, LIST_MAX,
} from '../src/events/draftRules.js';

describe('room settings', () => {
  it('reads the defaults from a draft_json without them, or with junk', () => {
    expect(roomSettingsOf(null)).toEqual({ firstPick: 'lowest_sr', pickSeconds: PICK_SECONDS_DEFAULT });
    expect(roomSettingsOf(JSON.stringify({ signupsCloseAt: 'x', draftAt: 'y' }))).toEqual({ firstPick: 'lowest_sr', pickSeconds: 75 });
    expect(roomSettingsOf(JSON.stringify({ draftFirstPick: 'coin', pickSeconds: 12 }))).toEqual({ firstPick: 'lowest_sr', pickSeconds: 75 });
    expect(roomSettingsOf(JSON.stringify({ draftFirstPick: 'random', pickSeconds: 120 }))).toEqual({ firstPick: 'random', pickSeconds: 120 });
  });

  it('parses a desk body, refusing anything out of range', () => {
    expect(parseRoomSettings({ firstPick: 'highest_sr', pickSeconds: 30 })).toEqual({ firstPick: 'highest_sr', pickSeconds: 30 });
    expect(parseRoomSettings({ firstPick: 'highest_sr', pickSeconds: 300 })).toEqual({ firstPick: 'highest_sr', pickSeconds: 300 });
    for (const bad of [null, 'x', { firstPick: 'coin', pickSeconds: 75 }, { firstPick: 'random', pickSeconds: 29 },
      { firstPick: 'random', pickSeconds: 301 }, { firstPick: 'random', pickSeconds: 75.5 }, { firstPick: 'random', pickSeconds: '75' }]) {
      expect(parseRoomSettings(bad)).toBeNull();
    }
  });
});

describe('round 1 order', () => {
  const caps = [{ steamid: 'x', sr: 1500, order: 0 }, { steamid: 'y', sr: 1400, order: 1 }, { steamid: 'z', sr: 1400, order: 2 }];
  it('puts the lowest SR first by default, ties by signup order', () => {
    expect(firstRoundOrder(caps, 'lowest_sr', () => 0)).toEqual(['y', 'z', 'x']);
  });
  it('puts the highest SR first when asked, ties by signup order', () => {
    expect(firstRoundOrder(caps, 'highest_sr', () => 0)).toEqual(['x', 'y', 'z']);
  });
  it('shuffles signup order with the given random source (Fisher-Yates)', () => {
    // rand always 0 swaps each position with the first: [x,y,z] -> [z,y,x] -> [y,z,x].
    expect(firstRoundOrder(caps, 'random', () => 0)).toEqual(['y', 'z', 'x']);
    // rand(n) = n - 1 swaps each position with itself: signup order stays.
    expect(firstRoundOrder(caps, 'random', (n) => n - 1)).toEqual(['x', 'y', 'z']);
  });
});

describe('the snake', () => {
  it('goes forward in odd rounds and back in even ones, numbering every pick', () => {
    expect(snakeSlots(['a', 'b', 'c'])).toEqual([
      { pickNo: 1, round: 1, captain: 'a' }, { pickNo: 2, round: 1, captain: 'b' }, { pickNo: 3, round: 1, captain: 'c' },
      { pickNo: 4, round: 2, captain: 'c' }, { pickNo: 5, round: 2, captain: 'b' }, { pickNo: 6, round: 2, captain: 'a' },
      { pickNo: 7, round: 3, captain: 'a' }, { pickNo: 8, round: 3, captain: 'b' }, { pickNo: 9, round: 3, captain: 'c' },
    ]);
    expect(snakeSlots([])).toEqual([]);
  });
});

describe('the auto-pick choice', () => {
  const free = [{ steamid: 'p1', sr: 1100, order: 1 }, { steamid: 'p2', sr: 1300, order: 2 }, { steamid: 'p3', sr: 1300, order: 0 }];
  it('takes the first free player on the list, skipping anyone taken or unknown', () => {
    expect(autoPickChoice(free, ['gone', 'bench', 'p1', 'p2'])).toBe('p1');
  });
  it('takes the highest SR with no usable list, ties by signup order', () => {
    expect(autoPickChoice(free, [])).toBe('p3');
    expect(autoPickChoice(free, ['gone'])).toBe('p3');
  });
});

describe('cleaning a pick list', () => {
  const pool = new Set(['a', 'b', 'c']);
  it('keeps pool players in order, once each', () => {
    expect(cleanPickList(['c', 'x', 'a', 'c', 'b'], pool)).toEqual(['c', 'a', 'b']);
    expect(cleanPickList([], pool)).toEqual([]);
  });
  it('refuses anything that is not a list of strings, or too long', () => {
    expect(cleanPickList('a', pool)).toBeNull();
    expect(cleanPickList(['a', 3], pool)).toBeNull();
    expect(cleanPickList(Array.from({ length: LIST_MAX + 1 }, () => 'a'), pool)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/draftRoomRules.test.ts`
Expected: FAIL, `roomSettingsOf` (and the rest) is not exported from `draftRules.js`.

- [ ] **Step 3: Implement**

Append to `src/events/draftRules.ts`:

```ts
/**
 * The live draft room's rules (drafts plan D2b1), pure like the rest of this
 * file: the two settings kept in events.draft_json next to the D1 times, the
 * round 1 order, the snake, the auto-pick choice and a saved pick list.
 */

export type FirstPick = 'lowest_sr' | 'highest_sr' | 'random';
export const FIRST_PICKS: readonly FirstPick[] = ['lowest_sr', 'highest_sr', 'random'];
export const PICK_SECONDS_DEFAULT = 75;
export const PICK_SECONDS_MIN = 30;
export const PICK_SECONDS_MAX = 300;
/** Captain + 3 picks per team (spec section 4). */
export const ROUNDS = 3;
/** A list longer than any pool is not a list this site sends. */
export const LIST_MAX = 200;

export interface RoomSettings { firstPick: FirstPick; pickSeconds: number }

const goodSeconds = (s: unknown): s is number =>
  typeof s === 'number' && Number.isInteger(s) && s >= PICK_SECONDS_MIN && s <= PICK_SECONDS_MAX;

/** Ruling 5: the settings as stored, each falling back to its default. */
export function roomSettingsOf(draftJson: string | null): RoomSettings {
  const d = draftJson ? (JSON.parse(draftJson) as Record<string, unknown>) : {};
  return {
    firstPick: FIRST_PICKS.includes(d.draftFirstPick as FirstPick) ? (d.draftFirstPick as FirstPick) : 'lowest_sr',
    pickSeconds: goodSeconds(d.pickSeconds) ? d.pickSeconds : PICK_SECONDS_DEFAULT,
  };
}

/** A desk body, or null when either field is missing or out of range. */
export function parseRoomSettings(raw: unknown): RoomSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!FIRST_PICKS.includes(r.firstPick as FirstPick) || !goodSeconds(r.pickSeconds)) return null;
  return { firstPick: r.firstPick as FirstPick, pickSeconds: r.pickSeconds };
}

/** A player as the room ranks them: current-season SR, then signup order. */
export interface RankedPlayer { steamid: string; sr: number; order: number }

/** Round 1 order (Ruling 5). Random shuffles the captains in signup order
 *  with rand(n) in [0, n), Fisher-Yates. */
export function firstRoundOrder(captains: RankedPlayer[], mode: FirstPick, rand: (n: number) => number): string[] {
  if (mode === 'random') {
    const out = [...captains].sort((a, b) => a.order - b.order).map((c) => c.steamid);
    for (let i = out.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  const dir = mode === 'lowest_sr' ? 1 : -1;
  return [...captains].sort((a, b) => dir * (a.sr - b.sr) || a.order - b.order).map((c) => c.steamid);
}

export interface Slot { pickNo: number; round: number; captain: string }

/** Every pick of the draft, in order: round r forward when r is odd, back
 *  when even; pickNo counts from 1 across the whole draft. */
export function snakeSlots(order: string[], rounds = ROUNDS): Slot[] {
  const out: Slot[] = [];
  for (let r = 1; r <= rounds; r++) {
    const seq = r % 2 === 1 ? order : [...order].reverse();
    for (const captain of seq) out.push({ pickNo: out.length + 1, round: r, captain });
  }
  return out;
}

/** Ruling 7: the first player on the list who is still free, else the
 *  highest SR free player, ties by signup order. available is never empty
 *  (the room only asks with a pick open). */
export function autoPickChoice(available: RankedPlayer[], list: readonly string[]): string {
  const free = new Set(available.map((p) => p.steamid));
  const fromList = list.find((s) => free.has(s));
  if (fromList) return fromList;
  return [...available].sort((a, b) => b.sr - a.sr || a.order - b.order)[0]!.steamid;
}

/** A pick list as saved (Ruling 2): pool players only, each once, in the
 *  given order. null when it is not a list of strings or is too long. */
export function cleanPickList(raw: unknown, pool: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(raw) || raw.length > LIST_MAX || raw.some((s) => typeof s !== 'string')) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw as string[]) {
    if (!pool.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run tests/draftRoomRules.test.ts tests/draftRules.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add src/events/draftRules.ts tests/draftRoomRules.test.ts
git commit -m "The live draft room's pure rules: settings with defaults, round 1 order by SR or shuffle, the snake, the auto-pick choice and pick list cleaning (plan D2b1)"
```

### Task 2: Room tables, live mode and room settings

**Files:**
- Modify: `src/db.ts` (SCHEMA string, right after `CREATE UNIQUE INDEX IF NOT EXISTS draft_offers_open ...`, about line 484)
- Modify: `src/events/validate.ts` (`EVENT_ERRORS`, import from `draftRules.js`)
- Modify: `src/events/drafts.ts` (`chooseTeamMode`, `moveDraftPlayers`, new `setRoomSettings`)
- Modify: `tests/draftTeams.test.ts` (the D2a "refuses the live draft room" test)
- Modify: `tests/eventLogGuard.test.ts` (drafts guard: `setRoomSettings`)
- Test: `tests/draftRoomMode.test.ts` (new)

**Interfaces:**
- Consumes: `roomSettingsOf`, `parseRoomSettings`, `RoomSettings`, `PICK_SECONDS_MIN`, `PICK_SECONDS_MAX` (Task 1).
- Produces:
  - Tables `draft_rooms`, `draft_picks`, `draft_pick_lists` (columns below), and the indexes `draft_picks_live_slot`, `draft_picks_live_player`.
  - `D.setRoomSettings(db: DB, o: { eventId: number; settings: unknown; actor: string; now: Date }): V.Checked<RoomSettings>` (log `draft_room_settings`).
  - `EVENT_ERRORS` keys used by later tasks: `room_started`, `live_mode`, `bad_room_settings`, `not_live_mode`, `room_not_ready`, `room_not_running`, `room_not_paused`, `not_your_pick`, `pick_moved`, `not_available`, `no_picks`, `no_delegate`, `bad_captain`, `not_a_captain`, `lists_closed`, `bad_list`, `draft_not_done`, `not_due`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/draftRoomMode.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { roomSettingsOf } from '../src/events/draftRules.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';

const T0 = new Date(NOW.getTime() + 3_600_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const mode = (f: DraftFixture, m: 'auto' | 'live' | null) => D.chooseTeamMode(f.db, { eventId: f.eventId, mode: m, actor: ADMIN, now: T0 });
const settings = (f: DraftFixture, s: unknown) => D.setRoomSettings(f.db, { eventId: f.eventId, settings: s, actor: ADMIN, now: T0 });
/** A room row as draftRoom.ts (Task 3) will write it; Task 2 only reads its status. */
const room = (f: DraftFixture, status: string) => f.db.prepare(
  "INSERT OR REPLACE INTO draft_rooms (event_id, status, order_json, pick_seconds, delegates_json) VALUES (?, ?, '[]', 75, '{}')",
).run(f.eventId, status);
const rows = (f: DraftFixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM events ORDER BY id').all(),
  f.db.prepare('SELECT * FROM draft_signups ORDER BY id').all(),
  f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);

describe('the live method (Ruling 6)', () => {
  it('can be chosen, and left again while no room has started', () => {
    const f = cutDraft();
    must(mode(f, 'live'));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBe('live');
    must(mode(f, 'auto'));
    must(mode(f, 'live'));
    room(f, 'ready');
    must(mode(f, null));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBeNull();
  });

  it('cannot be left once the room has started, and the refusal writes nothing', () => {
    for (const status of ['running', 'paused', 'done']) {
      const f = cutDraft();
      must(mode(f, 'live'));
      room(f, status);
      const before = rows(f);
      expect(err(mode(f, 'auto'))).toBe('room_started');
      expect(err(mode(f, null))).toBe('room_started');
      expect(rows(f)).toBe(before);
      must(mode(f, 'live'));
    }
  });

  it('refuses staff swaps in live mode', () => {
    const f = cutDraft();
    must(mode(f, 'live'));
    const [c0, c1] = D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'captain');
    const [p0, p1] = D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'pool');
    f.db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?').run(c0!.id, p0!.id);
    f.db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?').run(c1!.id, p1!.id);
    expect(err(D.moveDraftPlayers(f.db, { eventId: f.eventId, a: p0!.steamid, b: p1!.steamid, actor: ADMIN, now: T0 }))).toBe('live_mode');
  });
});

describe('room settings (Ruling 5)', () => {
  it('saves both settings into draft_json and keeps the draft times', () => {
    const f = cutDraft();
    const times = E.fieldsOf(E.getEvent(f.db, f.eventId)!).draft;
    expect(must(settings(f, { firstPick: 'random', pickSeconds: 60 }))).toEqual({ firstPick: 'random', pickSeconds: 60 });
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(roomSettingsOf(ev.draft_json)).toEqual({ firstPick: 'random', pickSeconds: 60 });
    expect(E.fieldsOf(ev).draft).toEqual(times);
    const log = f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'draft_room_settings'").all() as { actor: string; detail: string }[];
    expect(log.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: ADMIN, firstPick: 'random', pickSeconds: 60 }]);
  });

  it('refuses bad values, a started room and a cut not yet published', () => {
    const f = cutDraft();
    expect(err(settings(f, { firstPick: 'random', pickSeconds: 10 }))).toBe('bad_room_settings');
    must(mode(f, 'live'));
    room(f, 'running');
    expect(err(settings(f, { firstPick: 'random', pickSeconds: 60 }))).toBe('room_started');
    const g = cutDraft({ publish: false });
    expect(err(settings(g, { firstPick: 'random', pickSeconds: 60 }))).toBe('cut_not_published');
  });
});
```

In `tests/draftTeams.test.ts`, replace the test `it('refuses the live draft room in D2a', ...)` with:

```ts
  it('accepts the live method (plan D2b1) and still refuses an unknown one', () => {
    const f = cutFixture();
    must(mode(f, 'live'));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBe('live');
    expect(err(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'snake' as 'auto', actor: ADMIN, now: LATER }))).toBe('bad_team_mode');
  });
```

In `tests/eventLogGuard.test.ts`, inside `describe('drafts guard (src/events/drafts.ts)', ...)`, add to `DRAFT_MUTATIONS` after `moveDraftPlayers`:

```ts
      // Plan D2b1 Task 2: the live room's settings.
      setRoomSettings: {
        action: 'draft_room_settings', setup: published,
        run: (f) => D.setRoomSettings(f.db, { eventId: f.eventId, settings: { firstPick: 'random', pickSeconds: 60 }, actor: ADMIN, now: NOW }),
      },
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/draftRoomMode.test.ts tests/draftTeams.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL: `no such table: draft_rooms`, `live_draft_later` returned for live, and `D.setRoomSettings is not a function`.

- [ ] **Step 3: Implement**

`src/db.ts`, in SCHEMA after the `draft_offers_open` index:

```sql
-- Drafts plan D2b1: the live draft room. src/events/draftRoom.ts owns every
-- write. One room per event; status 'ready' before Start (a live draft with
-- no row reads as ready). A pick is undone by flagging undone_at, never by a
-- delete; the two partial unique indexes allow one live pick per slot and one
-- per player. No players foreign keys: the data lives one night and the
-- account merge needs no case for it (plan Ruling 4).
CREATE TABLE IF NOT EXISTS draft_rooms (
  event_id       INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('ready','running','paused','done')),
  order_json     TEXT NOT NULL DEFAULT '[]',
  pick_seconds   INTEGER NOT NULL,
  deadline_at    TEXT,
  paused_left_ms INTEGER,
  started_at     TEXT,
  finished_at    TEXT,
  delegates_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS draft_picks (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  pick_no         INTEGER NOT NULL,
  captain_steamid TEXT NOT NULL,
  steamid         TEXT NOT NULL,
  auto            INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1)),
  at              TEXT NOT NULL,
  undone_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_live_slot ON draft_picks (event_id, pick_no) WHERE undone_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_live_player ON draft_picks (event_id, steamid) WHERE undone_at IS NULL;
CREATE TABLE IF NOT EXISTS draft_pick_lists (
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  captain_steamid TEXT NOT NULL,
  list_json       TEXT NOT NULL DEFAULT '[]',
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, captain_steamid)
);
```

`src/events/validate.ts`: change the draftRules import to
`import { NOTE_MAX, PICK_SECONDS_MAX, PICK_SECONDS_MIN } from './draftRules.js';`, delete the `live_draft_later` entry, and add after `bad_move`:

```ts
  room_started: { status: 409, text: 'The live draft has started. Reset the room on the desk before changing the method or its settings.' },
  live_mode: { status: 409, text: 'Captains are picking these teams live. Undo a pick in the draft room instead of swapping players.' },
  bad_room_settings: { status: 400, text: `First pick is lowest SR, highest SR or random, and the pick clock is ${PICK_SECONDS_MIN} to ${PICK_SECONDS_MAX} seconds.` },
  not_live_mode: { status: 409, text: 'Choose Let captains pick before starting the draft room.' },
  room_not_ready: { status: 409, text: 'The draft room has already started.' },
  room_not_running: { status: 409, text: 'The draft is not running right now.' },
  room_not_paused: { status: 409, text: 'The draft is not paused.' },
  not_your_pick: { status: 403, text: 'It is not your turn to pick.' },
  pick_moved: { status: 409, text: 'That pick was already made. The room has moved on.' },
  not_available: { status: 409, text: 'That player is not in the pool, or was already picked.' },
  no_picks: { status: 409, text: 'There is no pick to undo.' },
  no_delegate: { status: 409, text: 'That captain has not drafted anyone yet, so there is nobody to hand picking to.' },
  bad_captain: { status: 400, text: 'That player is not a captain of this draft.' },
  not_a_captain: { status: 403, text: 'Only a captain of this draft can do that.' },
  lists_closed: { status: 409, text: 'The draft is over, so pick lists no longer change.' },
  bad_list: { status: 400, text: 'A pick list is an ordered list of players from the pool.' },
  draft_not_done: { status: 409, text: 'The live draft is not finished yet.' },
  not_due: { status: 409, text: 'No pick is due yet.' },
```

`src/events/drafts.ts`:
1. Import: `import { cleanNote, cutProblems, defaultRoles, maxTeams, nextOfferee, parseRoomSettings, type CutProblem, type RoomSettings } from './draftRules.js';`
2. Above `chooseTeamMode`, add:

```ts
/** Whether the live room has started (plan D2b1 Ruling 6): its row exists
 *  and is past 'ready'. Read only; src/events/draftRoom.ts writes the row. */
function roomStarted(db: DB, eventId: number): boolean {
  const r = db.prepare('SELECT status FROM draft_rooms WHERE event_id = ?').get(eventId) as { status: string } | undefined;
  return r !== undefined && r.status !== 'ready';
}
```

3. Replace the body of `chooseTeamMode`'s transaction and its doc comment:

```ts
/** Staff choose the method, or reset it with null. A change of method clears
 *  the working assignment. Leaving 'live' is refused once the room has
 *  started (plan D2b1 Ruling 6): staff reset the room first. */
export function chooseTeamMode(db: DB, o: { eventId: number; mode: TeamMode | null; actor: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  if (o.mode !== null && o.mode !== 'auto' && o.mode !== 'live') return V.fail('bad_team_mode');
  return db.transaction((): V.Checked<null> => {
    const found = makeTeamsOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.team_mode === 'live' && o.mode !== 'live' && roomStarted(db, ev.id)) return V.fail('room_started');
    if (ev.team_mode !== o.mode) clearAssignment(db, ev.id);
    db.prepare('UPDATE events SET team_mode = ?, updated_at = ? WHERE id = ?').run(o.mode, at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_team_mode', at, { mode: o.mode, from: ev.team_mode });
    return V.ok(null);
  })();
}
```

4. In `moveDraftPlayers`, right after `const ev = found.value;` add:
   `if (ev.team_mode === 'live') return V.fail('live_mode');`
5. After `moveDraftPlayers`, add:

```ts
/** The live room's settings (plan D2b1 Ruling 5), written into draft_json
 *  next to the D1 times (updateEvent's merge keeps them), until the room
 *  starts. Any method: staff may set them before choosing live. */
export function setRoomSettings(db: DB, o: { eventId: number; settings: unknown; actor: string; now: Date }): V.Checked<RoomSettings> {
  const at = o.now.toISOString();
  const s = parseRoomSettings(o.settings);
  if (!s) return V.fail('bad_room_settings');
  return db.transaction((): V.Checked<RoomSettings> => {
    const found = makeTeamsOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (roomStarted(db, ev.id)) return V.fail('room_started');
    const old = ev.draft_json ? (JSON.parse(ev.draft_json) as Record<string, unknown>) : {};
    db.prepare('UPDATE events SET draft_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...old, draftFirstPick: s.firstPick, pickSeconds: s.pickSeconds }), at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_room_settings', at, { ...s });
    return V.ok(s);
  })();
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/draftRoomMode.test.ts tests/draftTeams.test.ts tests/eventLogGuard.test.ts tests/draftCut.test.ts tests/mergePlayers.test.ts`
Expected: PASS. Then `npm run typecheck`: no errors (grep `live_draft_later` in `src`, `web/src` and `tests` first: nothing may still use it).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/events/validate.ts src/events/drafts.ts tests/draftRoomMode.test.ts tests/draftTeams.test.ts tests/eventLogGuard.test.ts
git commit -m "Staff can choose Let captains pick for a draft, staff swaps are refused in live mode, the method cannot leave live once the room has started, and the pick order and clock are draft settings, on three new room tables (plan D2b1)"
```

### Task 3: The room engine: start, picks, auto-picks, the final pick

**Files:**
- Create: `src/events/draftRoom.ts`
- Create: `tests/draftRoomFixture.ts`
- Modify: `tests/eventLogGuard.test.ts` (new `draft room guard` describe; the drafts guard's offender filter)
- Test: `tests/draftRoom.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`firstRoundOrder`, `snakeSlots`, `autoPickChoice`, `roomSettingsOf`, `Slot`, `RankedPlayer`), Task 2 (tables, error keys), `D.activeSignups`, `D.SignupRow`, `E.getEvent`, `E.logEvent`, `currentSeasonId`, `seasonSr`.
- Produces (`src/events/draftRoom.ts`; Task 4 adds the staff controls and lists to the same file):
  ```ts
  export type RoomStatus = 'ready' | 'running' | 'paused' | 'done';
  export interface RoomRow { event_id: number; status: RoomStatus; order_json: string; pick_seconds: number; deadline_at: string | null; paused_left_ms: number | null; started_at: string | null; finished_at: string | null; delegates_json: string }
  export interface PickRow { id: number; event_id: number; round: number; pick_no: number; captain_steamid: string; steamid: string; auto: 0 | 1; at: string; undone_at: string | null }
  export const ABSENT_SECONDS = 5;
  export type Present = (steamid: string) => boolean;
  export interface RoomState { room: RoomRow; order: string[]; slots: Slot[]; picks: PickRow[]; delegates: Record<string, string>; next: Slot | null; picker: string | null; signups: D.SignupRow[]; pool: D.SignupRow[]; available: D.SignupRow[] }
  export interface PickResult { pickNo: number; captain: string; steamid: string; auto: boolean; last: { pickNo: number; steamid: string } | null; done: boolean }
  export function roomOf(db: DB, eventId: number): RoomRow | null;
  export function livePicks(db: DB, eventId: number): PickRow[];
  export function roomState(db: DB, eventId: number): RoomState | null;
  export function pickListOf(db: DB, eventId: number, captain: string): string[];
  export function startRoom(db: DB, o: { eventId: number; actor: string; now: Date; present: Present; rand?: (n: number) => number }): V.Checked<{ order: string[] }>;
  export function makePick(db: DB, o: { eventId: number; steamid: string; player: string; pickNo: number; now: Date; present: Present }): V.Checked<PickResult>;
  export function autoPickDue(db: DB, o: { eventId: number; now: Date; present: Present }): V.Checked<PickResult>;
  ```
- `tests/draftRoomFixture.ts` produces `T0`, `at(s)`, `ALL`, `NONE`, `CAPTAINS`, `POOL`, `BENCH`, `must`, `err`, `liveDraft()`, `startedDraft(present?)`, `drive(f, n, from?, present?)`, used by Tasks 4, 6 and 9.

- [ ] **Step 1: Write the shared fixture**

```ts
// tests/draftRoomFixture.ts
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';

/** Drafts plan D2b1: a live draft over cutDraft (21 signups in P order, 5
 *  teams, captains P[16..20] by SR, pool P[0..14], bench P[15], cut
 *  published). Captain SR is 1000 + 25*i, so the lowest-SR-first order is
 *  P[16], P[17], P[18], P[19], P[20]. The room clock starts at T0. */
export const T0 = new Date(NOW.getTime() + 3_600_000);
export const at = (s: number) => new Date(T0.getTime() + s * 1000);
export const ALL: DR.Present = () => true;
export const NONE: DR.Present = () => false;
export const CAPTAINS = P.slice(16, 21);
export const POOL = P.slice(0, 15);
export const BENCH = P[15]!;

export const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
export const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

/** cutDraft with Let captains pick chosen at T0. */
export function liveDraft(): DraftFixture {
  const f = cutDraft();
  must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'live', actor: ADMIN, now: T0 }));
  return f;
}

/** liveDraft, then the room started at T0. */
export function startedDraft(present: DR.Present = ALL): DraftFixture {
  const f = liveDraft();
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present }));
  return f;
}

/** n picks, each by whoever picks next, of the first free pool player in
 *  signup order, one second apart starting at at(from). */
export function drive(f: DraftFixture, n: number, from = 1, present: DR.Present = ALL): void {
  for (let k = 0; k < n; k++) {
    const st = DR.roomState(f.db, f.eventId)!;
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: st.next!.pickNo, now: at(from + k), present }));
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/draftRoom.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import { snakeSlots } from '../src/events/draftRules.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, rate, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, NONE, POOL, T0, at, drive, err, liveDraft, must, startedDraft } from './draftRoomFixture.js';

const state = (f: DraftFixture) => DR.roomState(f.db, f.eventId)!;
const signup = (f: DraftFixture, s: string) => D.signupOf(f.db, f.eventId, s)!;
const iso = (d: Date) => d.toISOString();
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));
const logCount = (f: DraftFixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
const roomRows = (f: DraftFixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM draft_rooms').all(),
  f.db.prepare('SELECT * FROM draft_picks ORDER BY id').all(),
  f.db.prepare('SELECT id, draft_team FROM draft_signups ORDER BY id').all(),
  logCount(f),
]);
/** A saved list, written directly: savePickList arrives in Task 4. */
const setList = (f: DraftFixture, captain: string, list: string[]) => f.db.prepare(
  "INSERT OR REPLACE INTO draft_pick_lists (event_id, captain_steamid, list_json, updated_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
).run(f.eventId, captain, JSON.stringify(list));
const start = (f: DraftFixture, present = ALL, rand?: (n: number) => number) =>
  DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present, rand });

describe('starting the room', () => {
  it('orders round 1 lowest SR first, starts a full clock and logs the order', () => {
    const f = liveDraft();
    expect(must(start(f))).toEqual({ order: CAPTAINS });
    const st = state(f);
    expect(st.room.status).toBe('running');
    expect(st.room.started_at).toBe(iso(T0));
    expect(st.room.deadline_at).toBe(iso(at(75)));
    expect(st.next).toEqual({ pickNo: 1, round: 1, captain: CAPTAINS[0] });
    expect(st.picker).toBe(CAPTAINS[0]);
    expect(st.available.map((s) => s.steamid)).toEqual(POOL);
    expect(logs(f, 'draft_room_started')).toEqual([{ actor: ADMIN, order: CAPTAINS, firstPick: 'lowest_sr', pickSeconds: 75 }]);
  });

  it('follows the first-pick setting and the pick clock', () => {
    const f = liveDraft();
    must(D.setRoomSettings(f.db, { eventId: f.eventId, settings: { firstPick: 'highest_sr', pickSeconds: 60 }, actor: ADMIN, now: T0 }));
    must(start(f));
    expect(state(f).order).toEqual([...CAPTAINS].reverse());
    expect(state(f).room.deadline_at).toBe(iso(at(60)));
    expect(state(f).room.pick_seconds).toBe(60);

    const g = liveDraft();
    must(D.setRoomSettings(g.db, { eventId: g.eventId, settings: { firstPick: 'random', pickSeconds: 75 }, actor: ADMIN, now: T0 }));
    // rand always 0 rotates signup order left by one (see tests/draftRoomRules.test.ts).
    expect(must(start(g, ALL, () => 0)).order).toEqual([...CAPTAINS.slice(1), CAPTAINS[0]]);
  });

  it('gives an absent first captain 5 seconds', () => {
    const f = liveDraft();
    must(start(f, NONE));
    expect(state(f).room.deadline_at).toBe(iso(at(5)));
  });

  it('refuses outside live mode, a second start and a changed pool, writing nothing', () => {
    const auto = cutDraft();
    expect(err(DR.startRoom(auto.db, { eventId: auto.eventId, actor: ADMIN, now: T0, present: ALL }))).toBe('not_live_mode');
    const f = startedDraft();
    expect(err(start(f))).toBe('room_not_ready');
    const g = liveDraft();
    g.db.prepare("UPDATE draft_signups SET role = 'bench' WHERE event_id = ? AND steamid = ?").run(g.eventId, POOL[0]);
    const before = roomRows(g);
    expect(err(start(g))).toBe('teams_changed');
    expect(roomRows(g)).toBe(before);
    expect(DR.roomOf(g.db, g.eventId)).toBeNull();
  });
});

describe('picks', () => {
  it('puts the player on the captain\'s team and opens the next pick with a full clock', () => {
    const f = startedDraft();
    const r = must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[14]!, pickNo: 1, now: at(10), present: ALL }));
    expect(r).toEqual({ pickNo: 1, captain: CAPTAINS[0], steamid: POOL[14], auto: false, last: null, done: false });
    expect(signup(f, POOL[14]!).draft_team).toBe(signup(f, CAPTAINS[0]!).id);
    const st = state(f);
    expect(st.next).toEqual({ pickNo: 2, round: 1, captain: CAPTAINS[1] });
    expect(st.room.deadline_at).toBe(iso(at(85)));
    expect(st.picks).toEqual([expect.objectContaining({ pick_no: 1, round: 1, captain_steamid: CAPTAINS[0], steamid: POOL[14], auto: 0, at: iso(at(10)), undone_at: null })]);
    expect(logs(f, 'draft_pick')).toEqual([{ actor: CAPTAINS[0], ...r }]);
  });

  it('refuses the wrong picker, a player outside the pool and a taken player, writing nothing', () => {
    const f = startedDraft();
    const pick = (who: string, player: string, pickNo = state(f).next!.pickNo) =>
      DR.makePick(f.db, { eventId: f.eventId, steamid: who, player, pickNo, now: at(10), present: ALL });
    const before = roomRows(f);
    expect(err(pick(CAPTAINS[1]!, POOL[0]!))).toBe('not_your_pick');
    expect(err(pick(CAPTAINS[0]!, BENCH))).toBe('not_available');
    expect(err(pick(CAPTAINS[0]!, CAPTAINS[3]!))).toBe('not_available');
    expect(roomRows(f)).toBe(before);
    must(pick(CAPTAINS[0]!, POOL[0]!));
    expect(err(pick(CAPTAINS[1]!, POOL[0]!))).toBe('not_available');
  });

  it('refuses a pick while the room is not running', () => {
    const f = liveDraft();
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(1), present: ALL }))).toBe('room_not_running');
  });

  it('runs the snake: forward in odd rounds, back in even ones', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(state(f).picks.map((p) => p.captain_steamid)).toEqual(snakeSlots(CAPTAINS).map((s) => s.captain));
  });

  it('Review Focus 1: a second click at a snake turn does not take a second player', () => {
    const f = startedDraft();
    drive(f, 4);
    const turn = CAPTAINS[4]!; // last of round 1 and first of round 2
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[10]!, pickNo: 5, now: at(20), present: ALL }));
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[11]!, pickNo: 5, now: at(20), present: ALL }))).toBe('pick_moved');
    expect(state(f).picks.filter((p) => p.captain_steamid === turn)).toHaveLength(1);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[11]!, pickNo: 6, now: at(21), present: ALL }));
    expect(state(f).picks.filter((p) => p.captain_steamid === turn)).toHaveLength(2);
  });

  it('makes the last pick at once, flagged auto, and finishes the room in one log row', () => {
    const f = startedDraft();
    drive(f, 13);
    const st = state(f);
    expect(st.available).toHaveLength(2);
    const before = logCount(f);
    const r = must(DR.makePick(f.db, { eventId: f.eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: 14, now: at(30), present: ALL }));
    expect(r.last).toEqual({ pickNo: 15, steamid: st.available[1]!.steamid });
    expect(r.done).toBe(true);
    expect(logCount(f)).toBe(before + 1);
    const done = state(f);
    expect(done.room).toMatchObject({ status: 'done', deadline_at: null, finished_at: iso(at(30)) });
    expect(done.next).toBeNull();
    expect(done.picks.at(-1)).toMatchObject({ pick_no: 15, auto: 1, captain_steamid: CAPTAINS[4] });
    const teams = D.draftTeamsOf(f.db, f.eventId)!;
    expect(teams.map((t) => t.players.length)).toEqual([3, 3, 3, 3, 3]);
  });

  it('gives an absent next picker 5 seconds', () => {
    const f = startedDraft();
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(3), present: (s) => s !== CAPTAINS[1] }));
    expect(state(f).room.deadline_at).toBe(iso(at(8)));
  });
});

describe('auto picks', () => {
  it('waits for the deadline and writes nothing before it', () => {
    const f = startedDraft();
    const before = roomRows(f);
    expect(err(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(74), present: ALL }))).toBe('not_due');
    expect(roomRows(f)).toBe(before);
  });

  it('takes the highest SR free player with no list, ties by signup order, flagged auto with no actor', () => {
    const f = startedDraft();
    const r = must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(75), present: ALL }));
    expect(r).toMatchObject({ pickNo: 1, captain: CAPTAINS[0], steamid: POOL[14], auto: true });
    expect(state(f).picks[0]).toMatchObject({ auto: 1 });
    expect(logs(f, 'draft_pick')[0]!.actor).toBeNull();

    const g = startedDraft();
    rate(g.db, POOL[12]!, 2000);
    rate(g.db, POOL[13]!, 2000);
    expect(must(DR.autoPickDue(g.db, { eventId: g.eventId, now: at(75), present: ALL })).steamid).toBe(POOL[12]);
  });

  it('Review Focus 5: follows the captain\'s list, skipping players who are taken or not in the pool', () => {
    const f = startedDraft();
    setList(f, CAPTAINS[1]!, [BENCH, 'nobody', POOL[2]!, POOL[7]!, POOL[5]!]);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[2]!, pickNo: 1, now: at(1), present: ALL }));
    expect(must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(80), present: ALL })).steamid).toBe(POOL[7]);
  });

  it('Review Focus 2: the deadline auto-pick and a late click never both land', () => {
    const f = startedDraft();
    must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(75), present: ALL }));
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(75), present: ALL }))).toBe('pick_moved');
    expect(state(f).picks).toHaveLength(1);

    const g = startedDraft();
    must(DR.makePick(g.db, { eventId: g.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(75), present: ALL }));
    expect(err(DR.autoPickDue(g.db, { eventId: g.eventId, now: at(75), present: ALL }))).toBe('not_due');
    expect(state(g).picks).toHaveLength(1);
    // The database backstop: a second live pick for slot 1 cannot exist.
    expect(() => g.db.prepare("INSERT INTO draft_picks (event_id, round, pick_no, captain_steamid, steamid, auto, at) VALUES (?, 1, 1, ?, ?, 0, 'x')")
      .run(g.eventId, CAPTAINS[0], POOL[1])).toThrow(/UNIQUE/);
  });
});
```

In `tests/eventLogGuard.test.ts`:
1. Add imports: `import * as DR from '../src/events/draftRoom.js';` and `import { ALL, CAPTAINS, POOL, T0, at, drive, liveDraft, startedDraft } from './draftRoomFixture.js';`
2. In the drafts guard test `only src/events/drafts.ts (and the account merge) writes the draft tables`, change the filter to `.filter((f) => f !== 'src/events/drafts.ts' && f !== 'src/mergePlayers.ts' && f !== 'src/events/draftRoom.ts')` and rename the test to `'only src/events/drafts.ts (and the account merge, and draftRoom.ts for draft_team) writes the draft tables'`.
3. After the drafts guard describe, add:

```ts
  /** Drafts plan D2b1: src/events/draftRoom.ts is the only writer of the
   *  room tables and writes draft_signups only through draft_team; each
   *  mutation adds one event_log row or, when that row cannot be written,
   *  nothing. */
  describe('draft room guard (src/events/draftRoom.ts)', () => {
    const ROOM_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:draft_rooms|draft_picks|draft_pick_lists)\b/gi;
    const SIGNUP_WRITES = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+draft_signups\b[^'"`]*/gi;
    const ROOM_READS = new Set(['roomOf', 'livePicks', 'roomState', 'pickListOf', 'captainFor']);
    const ROOM_MUTATIONS: Record<string, { action: string; setup: () => DraftFixture; run: (f: DraftFixture) => V.Checked<unknown> }> = {
      startRoom: { action: 'draft_room_started', setup: liveDraft, run: (f) => DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }) },
      makePick: {
        action: 'draft_pick', setup: () => startedDraft(),
        run: (f) => DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(1), present: ALL }),
      },
      autoPickDue: { action: 'draft_pick', setup: () => startedDraft(), run: (f) => DR.autoPickDue(f.db, { eventId: f.eventId, now: at(80), present: ALL }) },
    };
    const roomRows = (f: DraftFixture) => JSON.stringify([
      f.db.prepare('SELECT * FROM draft_rooms ORDER BY event_id').all(),
      f.db.prepare('SELECT * FROM draft_picks ORDER BY id').all(),
      f.db.prepare('SELECT * FROM draft_pick_lists ORDER BY event_id, captain_steamid').all(),
      f.db.prepare('SELECT * FROM draft_signups ORDER BY id').all(),
    ]);

    it('only src/events/draftRoom.ts writes the room tables', () => {
      const offenders = walk('src')
        .filter((f) => f !== 'src/events/draftRoom.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(ROOM_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
      expect('update draft_picks set undone_at = ?'.match(ROOM_WRITERS)).toHaveLength(1);
    });

    it('draftRoom.ts writes draft_signups only through draft_team', () => {
      const writes = readFileSync(join(root, 'src/events/draftRoom.ts'), 'utf8').match(SIGNUP_WRITES) ?? [];
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w).toMatch(/^UPDATE\s+draft_signups\s+SET\s+draft_team\s*=\s*(?:\?|NULL)\s+WHERE\b/i);
    });

    it('every exported function of draftRoom.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(DR).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !ROOM_READS.has(k)).sort()).toEqual(Object.keys(ROOM_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(ROOM_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const f = m.setup();
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const f = m.setup();
        const before = roomRows(f);
        const logs = logCount(f);
        f.db.exec("CREATE TRIGGER room_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(roomRows(f)).toBe(before);
        expect(logCount(f)).toBe(logs);
      });
    }
  });
```

`drive` is imported now for Task 4's rows; leave it imported (Task 4 uses it in this describe).

- [ ] **Step 3: Run them and see them fail**

Run: `npx vitest run tests/draftRoom.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL: `Cannot find module '../src/events/draftRoom.js'`.

- [ ] **Step 4: Implement**

```ts
// src/events/draftRoom.ts
import { randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as V from './validate.js';
import { currentSeasonId } from '../players.js';
import { seasonSr } from '../rating.js';
import { autoPickChoice, firstRoundOrder, roomSettingsOf, snakeSlots, type RankedPlayer, type Slot } from './draftRules.js';

/**
 * The live draft room (drafts plan D2b1, spec section 4). Every write to
 * draft_rooms, draft_picks and draft_pick_lists, and the draft_team of a
 * picked pool player (the captain's signup id, so D2a's draftTeamsOf,
 * draftFairness and createDraftEntries read a live draft exactly as they
 * read an auto-balanced one). Same shape as src/events/drafts.ts: each
 * mutation is one transaction that re-reads, checks inside, writes and adds
 * exactly one event_log row; a refusal writes nothing. The room keeps no
 * timer of its own: every running pick has a stored deadline_at and
 * src/events/draftClock.ts calls autoPickDue once it has passed, so a
 * restart resumes exactly (Ruling 7). Presence comes in as a Present
 * function, so this module never holds in-memory state.
 */

export type RoomStatus = 'ready' | 'running' | 'paused' | 'done';
export interface RoomRow {
  event_id: number; status: RoomStatus; order_json: string; pick_seconds: number; deadline_at: string | null;
  paused_left_ms: number | null; started_at: string | null; finished_at: string | null; delegates_json: string;
}
export interface PickRow {
  id: number; event_id: number; round: number; pick_no: number; captain_steamid: string; steamid: string;
  auto: 0 | 1; at: string; undone_at: string | null;
}
/** Ruling 8: an absent picker's clock, long enough for viewers to see who is up. */
export const ABSENT_SECONDS = 5;
/** Whether the person picking for a team is in the room (DraftClock's heartbeats). */
export type Present = (steamid: string) => boolean;

export interface RoomState {
  room: RoomRow; order: string[]; slots: Slot[]; picks: PickRow[]; delegates: Record<string, string>;
  /** The first open slot; null before Start, after done, or in a reset room. */
  next: Slot | null;
  /** Who picks for next: that captain's delegate when set, else the captain. */
  picker: string | null;
  signups: D.SignupRow[]; pool: D.SignupRow[]; available: D.SignupRow[];
}
export interface PickResult {
  pickNo: number; captain: string; steamid: string; auto: boolean;
  /** The final pick, when this pick left one player and the site made it (Ruling 9). */
  last: { pickNo: number; steamid: string } | null;
  done: boolean;
}

export function roomOf(db: DB, eventId: number): RoomRow | null {
  return (db.prepare('SELECT * FROM draft_rooms WHERE event_id = ?').get(eventId) as RoomRow | undefined) ?? null;
}

/** Picks not undone, in pick order. */
export function livePicks(db: DB, eventId: number): PickRow[] {
  return db.prepare('SELECT * FROM draft_picks WHERE event_id = ? AND undone_at IS NULL ORDER BY pick_no').all(eventId) as PickRow[];
}

export function roomState(db: DB, eventId: number): RoomState | null {
  const room = roomOf(db, eventId);
  if (!room) return null;
  const order = JSON.parse(room.order_json) as string[];
  const slots = snakeSlots(order);
  const picks = livePicks(db, eventId);
  const filled = new Set(picks.map((p) => p.pick_no));
  const next = room.status === 'ready' ? null : slots.find((s) => !filled.has(s.pickNo)) ?? null;
  const delegates = JSON.parse(room.delegates_json) as Record<string, string>;
  const signups = D.activeSignups(db, eventId);
  const pool = signups.filter((s) => s.role === 'pool');
  const taken = new Set(picks.map((p) => p.steamid));
  return {
    room, order, slots, picks, delegates, next, picker: next ? delegates[next.captain] ?? next.captain : null,
    signups, pool, available: pool.filter((s) => !taken.has(s.steamid)),
  };
}

/** A captain's saved list, current pool players only (Ruling 2). */
export function pickListOf(db: DB, eventId: number, captain: string): string[] {
  const row = db.prepare('SELECT list_json FROM draft_pick_lists WHERE event_id = ? AND captain_steamid = ?').get(eventId, captain) as { list_json: string } | undefined;
  if (!row) return [];
  const pool = new Set(D.activeSignups(db, eventId).filter((s) => s.role === 'pool').map((s) => s.steamid));
  return (JSON.parse(row.list_json) as string[]).filter((s) => pool.has(s));
}

/** A draft in live mode whose cut is published and whose teams are not, before its event starts. */
function liveEvent(db: DB, eventId: number): V.Checked<E.EventRow> {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status === 'draft') return V.fail('not_found');
  if (ev.entry_kind !== 'draft') return V.fail('not_draft');
  if (ev.cut_at === null) return V.fail('cut_not_published');
  if (ev.teams_made_at !== null) return V.fail('teams_made');
  if (ev.status !== 'registration' && ev.status !== 'checkin') return V.fail('wrong_status');
  if (ev.team_mode !== 'live') return V.fail('not_live_mode');
  return V.ok(ev);
}

/** Current-season SR and signup order, the room's one ranking. */
function ranker(db: DB, signups: D.SignupRow[]): (s: D.SignupRow) => RankedPlayer {
  const season = currentSeasonId(db);
  const order = new Map(signups.map((s, i) => [s.id, i]));
  return (s) => ({ steamid: s.steamid, sr: seasonSr(db, s.steamid, season), order: order.get(s.id)! });
}

const deadlineFor = (now: Date, pickSeconds: number, here: boolean): string =>
  new Date(now.getTime() + (here ? pickSeconds : ABSENT_SECONDS) * 1000).toISOString();

/** Start (Ruling 5): the order from the settings, every draft_team cleared,
 *  the room running with pick 1 on the clock. A reset room ('ready' row)
 *  starts again the same way. */
export function startRoom(
  db: DB, o: { eventId: number; actor: string; now: Date; present: Present; rand?: (n: number) => number },
): V.Checked<{ order: string[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ order: string[] }> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const room = roomOf(db, ev.id);
    if (room && room.status !== 'ready') return V.fail('room_not_ready');
    const all = D.activeSignups(db, ev.id);
    const captains = all.filter((s) => s.role === 'captain');
    const pool = all.filter((s) => s.role === 'pool');
    if (captains.length < 2 || pool.length !== captains.length * 3) return V.fail('teams_changed');
    const settings = roomSettingsOf(ev.draft_json);
    const order = firstRoundOrder(captains.map(ranker(db, all)), settings.firstPick, o.rand ?? ((n) => randomInt(n)));
    db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND draft_team IS NOT NULL').run(ev.id);
    db.prepare(
      `INSERT INTO draft_rooms (event_id, status, order_json, pick_seconds, deadline_at, paused_left_ms, started_at, finished_at, delegates_json)
       VALUES (?, 'running', ?, ?, ?, NULL, ?, NULL, '{}')
       ON CONFLICT(event_id) DO UPDATE SET status = 'running', order_json = excluded.order_json, pick_seconds = excluded.pick_seconds,
         deadline_at = excluded.deadline_at, paused_left_ms = NULL, started_at = excluded.started_at, finished_at = NULL, delegates_json = '{}'`,
    ).run(ev.id, JSON.stringify(order), settings.pickSeconds, deadlineFor(o.now, settings.pickSeconds, o.present(order[0]!)), at);
    E.logEvent(db, ev.id, o.actor, 'draft_room_started', at, { order, firstPick: settings.firstPick, pickSeconds: settings.pickSeconds });
    return V.ok({ order });
  })();
}

/** Inside the caller's transaction: the pick for st.next, then either the
 *  forced final pick and done (Ruling 9) or the next slot's clock (full when
 *  its picker is present, ABSENT_SECONDS when not). */
function pickAndAdvance(db: DB, st: RoomState, player: string, auto: boolean, now: Date, present: Present): PickResult {
  const at = now.toISOString();
  const slot = st.next!;
  const eventId = st.room.event_id;
  const idOf = new Map(st.signups.map((s) => [s.steamid, s.id]));
  const insert = db.prepare('INSERT INTO draft_picks (event_id, round, pick_no, captain_steamid, steamid, auto, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const team = db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?');
  insert.run(eventId, slot.round, slot.pickNo, slot.captain, player, auto ? 1 : 0, at);
  team.run(idOf.get(slot.captain)!, idOf.get(player)!);
  const filled = new Set([...st.picks.map((p) => p.pick_no), slot.pickNo]);
  const after = st.slots.find((s) => !filled.has(s.pickNo)) ?? null;
  const rest = st.available.filter((s) => s.steamid !== player);
  let last: PickResult['last'] = null;
  if (after && rest.length === 1) {
    const only = rest[0]!.steamid;
    insert.run(eventId, after.round, after.pickNo, after.captain, only, 1, at);
    team.run(idOf.get(after.captain)!, idOf.get(only)!);
    last = { pickNo: after.pickNo, steamid: only };
  }
  const done = after === null || last !== null;
  if (done) {
    db.prepare("UPDATE draft_rooms SET status = 'done', deadline_at = NULL, paused_left_ms = NULL, finished_at = ? WHERE event_id = ?").run(at, eventId);
  } else {
    const picker = st.delegates[after!.captain] ?? after!.captain;
    db.prepare('UPDATE draft_rooms SET deadline_at = ? WHERE event_id = ?').run(deadlineFor(now, st.room.pick_seconds, present(picker)), eventId);
  }
  return { pickNo: slot.pickNo, captain: slot.captain, steamid: player, auto, last, done };
}

/** A captain's (or delegate's) pick for the slot they saw (Ruling 18): a
 *  stale pickNo is pick_moved, checked before anything else, so a double
 *  click at a snake turn never takes two players (Review Focus 1). */
export function makePick(
  db: DB, o: { eventId: number; steamid: string; player: string; pickNo: number; now: Date; present: Present },
): V.Checked<PickResult> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<PickResult> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const st = roomState(db, o.eventId);
    if (!st || st.room.status !== 'running' || !st.next) return V.fail('room_not_running');
    if (o.pickNo !== st.next.pickNo) return V.fail('pick_moved');
    if (o.steamid !== st.picker) return V.fail('not_your_pick');
    if (!st.available.some((s) => s.steamid === o.player)) return V.fail('not_available');
    const r = pickAndAdvance(db, st, o.player, false, o.now, o.present);
    E.logEvent(db, o.eventId, o.steamid, 'draft_pick', at, r);
    return V.ok(r);
  })();
}

/** The clock's pick (Ruling 7): only for a running room whose deadline has
 *  passed; from the captain's list, else by SR. not_due writes nothing. */
export function autoPickDue(db: DB, o: { eventId: number; now: Date; present: Present }): V.Checked<PickResult> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<PickResult> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const st = roomState(db, o.eventId);
    if (!st || st.room.status !== 'running' || !st.next || st.room.deadline_at === null
      || Date.parse(st.room.deadline_at) > o.now.getTime()) return V.fail('not_due');
    const choice = autoPickChoice(st.available.map(ranker(db, st.signups)), pickListOf(db, o.eventId, st.next.captain));
    const r = pickAndAdvance(db, st, choice, true, o.now, o.present);
    E.logEvent(db, o.eventId, null, 'draft_pick', at, r);
    return V.ok(r);
  })();
}
```

- [ ] **Step 5: Run them and see them pass**

Run: `npx vitest run tests/draftRoom.test.ts tests/eventLogGuard.test.ts tests/draftRoomRules.test.ts tests/draftTeams.test.ts`
Expected: PASS. Then `npm run typecheck`: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/events/draftRoom.ts tests/draftRoomFixture.ts tests/draftRoom.test.ts tests/eventLogGuard.test.ts
git commit -m "The live draft room starts in the chosen order, takes snake picks that name their slot, auto-picks from the captain's list or by SR once a stored deadline passes, gives an absent picker 5 seconds, and makes the final pick itself (plan D2b1)"
```

### Task 4: Staff controls, pick lists and the publish gate

**Files:**
- Modify: `src/events/draftRoom.ts` (add `pauseRoom`, `resumeRoom`, `undoPick`, `setDelegate`, `resetRoom`, `savePickList`, `captainFor`)
- Modify: `src/events/entries.ts` (`createDraftEntries`: `draft_not_done`)
- Modify: `tests/eventLogGuard.test.ts` (six rows in `ROOM_MUTATIONS`)
- Test: `tests/draftRoomControls.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 (`roomState`, `liveEvent` (module private), `pickListOf`, `ABSENT_SECONDS`, `RoomState`), `cleanPickList` (Task 1), `D.signupOf`.
- Produces:
  ```ts
  export function pauseRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ leftMs: number }>;
  export function resumeRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ deadlineAt: string }>;
  export function undoPick(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number[] }>;
  export function setDelegate(db: DB, o: { eventId: number; captain: string; on: boolean; actor: string; now: Date }): V.Checked<{ delegate: string | null }>;
  export function resetRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number }>;
  export function savePickList(db: DB, o: { eventId: number; steamid: string; list: unknown; now: Date }): V.Checked<string[]>;
  /** The captain a viewer picks for: themselves as a captain, or the captain whose delegate they are. */
  export function captainFor(db: DB, eventId: number, steamid: string): string | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/draftRoomControls.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import * as N from '../src/events/entries.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, at, drive, err, liveDraft, must, startedDraft } from './draftRoomFixture.js';

const state = (f: DraftFixture) => DR.roomState(f.db, f.eventId)!;
const iso = (d: Date) => d.toISOString();
const staff = (f: DraftFixture, s: number) => ({ eventId: f.eventId, actor: ADMIN, now: at(s) });
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

describe('pause and resume', () => {
  it('stops the clock with the time left, and resume gives it back', () => {
    const f = startedDraft();
    expect(must(DR.pauseRoom(f.db, staff(f, 30)))).toEqual({ leftMs: 45_000 });
    expect(state(f).room).toMatchObject({ status: 'paused', deadline_at: null, paused_left_ms: 45_000 });
    expect(err(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(500), present: ALL }))).toBe('not_due');
    expect(err(DR.pauseRoom(f.db, staff(f, 31)))).toBe('room_not_running');
    expect(must(DR.resumeRoom(f.db, staff(f, 600)))).toEqual({ deadlineAt: iso(at(645)) });
    expect(state(f).room).toMatchObject({ status: 'running', deadline_at: iso(at(645)), paused_left_ms: null });
    expect(err(DR.resumeRoom(f.db, staff(f, 601)))).toBe('room_not_paused');
  });

  it('never resumes with less than 5 seconds (Ruling 17)', () => {
    const f = startedDraft();
    must(DR.pauseRoom(f.db, staff(f, 74.5)));
    expect(must(DR.resumeRoom(f.db, staff(f, 100)))).toEqual({ deadlineAt: iso(at(105)) });
  });

  it('refuses before Start', () => {
    const f = liveDraft();
    expect(err(DR.pauseRoom(f.db, staff(f, 1)))).toBe('room_not_running');
  });
});

describe('undo', () => {
  it('takes back the last pick, frees the player and reopens the pick with a full clock', () => {
    const f = startedDraft();
    drive(f, 3);
    const third = state(f).picks[2]!;
    expect(must(DR.undoPick(f.db, staff(f, 40)))).toEqual({ undone: [3] });
    const st = state(f);
    expect(st.picks).toHaveLength(2);
    expect(st.next).toEqual({ pickNo: 3, round: 1, captain: CAPTAINS[2] });
    expect(st.room.deadline_at).toBe(iso(at(115)));
    expect(st.available.map((s) => s.steamid)).toContain(third.steamid);
    expect(D.signupOf(f.db, f.eventId, third.steamid)!.draft_team).toBeNull();
    const row = f.db.prepare('SELECT undone_at FROM draft_picks WHERE id = ?').get(third.id);
    expect(row).toEqual({ undone_at: iso(at(40)) });
    expect(logs(f, 'draft_pick_undone')).toEqual([{ actor: ADMIN, picks: [{ pickNo: 3, steamid: third.steamid }] }]);
  });

  it('refuses with nothing to undo', () => {
    const f = startedDraft();
    expect(err(DR.undoPick(f.db, staff(f, 2)))).toBe('no_picks');
  });

  it('keeps a paused room paused, with a full clock waiting', () => {
    const f = startedDraft();
    drive(f, 2);
    must(DR.pauseRoom(f.db, staff(f, 10)));
    must(DR.undoPick(f.db, staff(f, 11)));
    expect(state(f).room).toMatchObject({ status: 'paused', paused_left_ms: 75_000, deadline_at: null });
  });

  it('Review Focus 4: after the forced final pick, takes back both and holds publishing until done again', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(state(f).room.status).toBe('done');
    expect(must(DR.undoPick(f.db, staff(f, 60)))).toEqual({ undone: [15, 14] });
    const st = state(f);
    expect(st.room).toMatchObject({ status: 'running', finished_at: null, deadline_at: iso(at(135)) });
    expect(st.next).toEqual({ pickNo: 14, round: 3, captain: CAPTAINS[3] });
    expect(st.available).toHaveLength(2);
    expect(err(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: at(61) }))).toBe('draft_not_done');
    drive(f, 1, 62);
    expect(state(f).room.status).toBe('done');
    expect(must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: at(70) })).entries).toHaveLength(5);
    expect(err(DR.undoPick(f.db, staff(f, 71)))).toBe('teams_made');
  });
});

describe('handing picking to a team\'s first pick (Ruling 16)', () => {
  it('lets the delegate pick for the team, from the captain\'s list when the clock runs out', () => {
    const f = startedDraft();
    drive(f, 1);
    const first = state(f).picks[0]!.steamid;
    expect(must(DR.setDelegate(f.db, { ...staff(f, 5), captain: CAPTAINS[0]!, on: true }))).toEqual({ delegate: first });
    expect(DR.captainFor(f.db, f.eventId, first)).toBe(CAPTAINS[0]);
    drive(f, 8, 10); // to pick 10, CAPTAINS[0]'s second pick
    const st = state(f);
    expect(st.next).toEqual({ pickNo: 10, round: 2, captain: CAPTAINS[0] });
    expect(st.picker).toBe(first);
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: st.available[0]!.steamid, pickNo: 10, now: at(30), present: ALL }))).toBe('not_your_pick');
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: first, player: st.available[0]!.steamid, pickNo: 10, now: at(30), present: ALL }));
    expect(must(DR.setDelegate(f.db, { ...staff(f, 31), captain: CAPTAINS[0]!, on: false }))).toEqual({ delegate: null });
    expect(state(f).delegates).toEqual({});
  });

  it('refuses a captain with no pick yet, and anyone who is not a captain', () => {
    const f = startedDraft();
    expect(err(DR.setDelegate(f.db, { ...staff(f, 1), captain: CAPTAINS[0]!, on: true }))).toBe('no_delegate');
    expect(err(DR.setDelegate(f.db, { ...staff(f, 1), captain: POOL[0]!, on: true }))).toBe('bad_captain');
  });

  it('drops the delegate when their pick is undone', () => {
    const f = startedDraft();
    drive(f, 1);
    must(DR.setDelegate(f.db, { ...staff(f, 5), captain: CAPTAINS[0]!, on: true }));
    must(DR.undoPick(f.db, staff(f, 6)));
    expect(state(f).delegates).toEqual({});
  });
});

describe('reset', () => {
  it('takes back every pick and returns to Ready, after which the room starts again or the method can change', () => {
    const f = startedDraft();
    drive(f, 4);
    expect(must(DR.resetRoom(f.db, staff(f, 20)))).toEqual({ undone: 4 });
    const st = state(f);
    expect(st.room).toMatchObject({ status: 'ready', order_json: '[]', deadline_at: null, started_at: null, delegates_json: '{}' });
    expect(st.picks).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_picks WHERE event_id = ? AND undone_at IS NOT NULL').get(f.eventId)).toEqual({ n: 4 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_signups WHERE event_id = ? AND draft_team IS NOT NULL').get(f.eventId)).toEqual({ n: 0 });
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(30), present: ALL }));
    must(DR.resetRoom(f.db, staff(f, 31)));
    must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: at(32) }));
  });

  it('refuses a room that never started', () => {
    const f = liveDraft();
    expect(err(DR.resetRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0 }))).toBe('room_not_running');
  });
});

describe('pick lists (Rulings 1 and 2)', () => {
  const save = (f: DraftFixture, who: string, list: unknown, s = 1) => DR.savePickList(f.db, { eventId: f.eventId, steamid: who, list, now: at(s) });

  it('opens at the cut whatever the method, keeps pool players only and reads back in order', () => {
    const f = cutDraft();
    expect(must(save(f, CAPTAINS[0]!, [POOL[3], BENCH, POOL[3], 'nobody', POOL[1]]))).toEqual([POOL[3], POOL[1]]);
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[3], POOL[1]]);
    expect(logs(f, 'draft_list_saved')).toEqual([{ actor: CAPTAINS[0], captain: CAPTAINS[0], size: 2 }]);
    must(save(f, CAPTAINS[0]!, [POOL[1]], 2));
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[1]]);
  });

  it('refuses a pool player, a malformed list, and a cut not yet published', () => {
    const f = cutDraft();
    expect(err(save(f, POOL[0]!, [POOL[1]]))).toBe('not_a_captain');
    expect(err(save(f, CAPTAINS[0]!, 'nope'))).toBe('bad_list');
    expect(err(save(cutDraft({ publish: false }), CAPTAINS[0]!, []))).toBe('cut_not_published');
  });

  it('lets a delegate save the team\'s list', () => {
    const f = startedDraft();
    drive(f, 1);
    const first = state(f).picks[0]!.steamid;
    must(DR.setDelegate(f.db, { eventId: f.eventId, captain: CAPTAINS[0]!, on: true, actor: ADMIN, now: at(3) }));
    must(save(f, first, [POOL[9]], 4));
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[9]]);
  });

  it('closes once the draft is done', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(err(save(f, CAPTAINS[0]!, [POOL[1]], 40))).toBe('lists_closed');
  });

  it('Review Focus 5: drops a saved player who is no longer in the pool', () => {
    const f = cutDraft();
    must(save(f, CAPTAINS[0]!, [POOL[3], POOL[4]]));
    f.db.prepare("UPDATE draft_signups SET role = 'bench' WHERE event_id = ? AND steamid = ?").run(f.eventId, POOL[3]);
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[4]]);
  });
});
```

In `tests/eventLogGuard.test.ts`, add to `ROOM_MUTATIONS`:

```ts
      pauseRoom: { action: 'draft_room_paused', setup: () => startedDraft(), run: (f) => DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }) },
      resumeRoom: {
        action: 'draft_room_resumed',
        setup: () => { const f = startedDraft(); DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }); return f; },
        run: (f) => DR.resumeRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(20) }),
      },
      undoPick: { action: 'draft_pick_undone', setup: () => { const f = startedDraft(); drive(f, 1); return f; }, run: (f) => DR.undoPick(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }) },
      setDelegate: {
        action: 'draft_delegate_set', setup: () => { const f = startedDraft(); drive(f, 1); return f; },
        run: (f) => DR.setDelegate(f.db, { eventId: f.eventId, captain: CAPTAINS[0]!, on: true, actor: ADMIN, now: at(10) }),
      },
      resetRoom: { action: 'draft_room_reset', setup: () => { const f = startedDraft(); drive(f, 1); return f; }, run: (f) => DR.resetRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }) },
      savePickList: { action: 'draft_list_saved', setup: liveDraft, run: (f) => DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, list: [POOL[3]], now: at(1) }) },
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/draftRoomControls.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL: `DR.pauseRoom is not a function` (and the rest), and the guard's export list differs.

- [ ] **Step 3: Implement**

Add to `src/events/draftRoom.ts` (import `cleanPickList` from `./draftRules.js` alongside the others):

```ts
/** A live draft whose room has started (any status but 'ready'). */
function startedRoom(db: DB, eventId: number): V.Checked<RoomState> {
  const found = liveEvent(db, eventId);
  if (!found.ok) return found;
  const st = roomState(db, eventId);
  if (!st || st.room.status === 'ready') return V.fail('room_not_running');
  return V.ok(st);
}

/** Staff pause (Ruling 6): the time left is kept, the deadline cleared, so
 *  the clock never auto-picks a paused room. */
export function pauseRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ leftMs: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ leftMs: number }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (st.room.status !== 'running') return V.fail('room_not_running');
    const leftMs = Math.max(0, Date.parse(st.room.deadline_at!) - o.now.getTime());
    db.prepare("UPDATE draft_rooms SET status = 'paused', paused_left_ms = ?, deadline_at = NULL WHERE event_id = ?").run(leftMs, o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_paused', at, { leftMs });
    return V.ok({ leftMs });
  })();
}

/** Staff resume (Ruling 17): now + the time left, never under ABSENT_SECONDS. */
export function resumeRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ deadlineAt: string }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ deadlineAt: string }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (st.room.status !== 'paused') return V.fail('room_not_paused');
    const deadlineAt = new Date(o.now.getTime() + Math.max(st.room.paused_left_ms ?? 0, ABSENT_SECONDS * 1000)).toISOString();
    db.prepare("UPDATE draft_rooms SET status = 'running', deadline_at = ?, paused_left_ms = NULL WHERE event_id = ?").run(deadlineAt, o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_resumed', at, { deadlineAt });
    return V.ok({ deadlineAt });
  })();
}

/** Staff undo (Ruling 6, Review Focus 4): the last live pick is flagged
 *  undone and its player freed. When it is the final pick (always made by
 *  the site with the pick before it) both are taken back, or the final pick
 *  would be forced again at once. The reopened pick gets a full clock; a
 *  done room runs again, a paused one stays paused with the full clock
 *  waiting. A delegate whose pick was undone is dropped. */
export function undoPick(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ undone: number[] }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    const lastPick = st.picks.at(-1);
    if (!lastPick) return V.fail('no_picks');
    const back = lastPick.pick_no === st.slots.length && st.picks.length >= 2 ? st.picks.slice(-2).reverse() : [lastPick];
    const undo = db.prepare('UPDATE draft_picks SET undone_at = ? WHERE id = ?');
    const free = db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND steamid = ? AND withdrawn_at IS NULL');
    for (const p of back) {
      undo.run(at, p.id);
      free.run(o.eventId, p.steamid);
    }
    const gone = new Set(back.map((p) => p.steamid));
    const delegates = JSON.stringify(Object.fromEntries(Object.entries(st.delegates).filter(([, d]) => !gone.has(d))));
    const full = st.room.pick_seconds * 1000;
    if (st.room.status === 'paused') {
      db.prepare('UPDATE draft_rooms SET paused_left_ms = ?, delegates_json = ? WHERE event_id = ?').run(full, delegates, o.eventId);
    } else {
      db.prepare("UPDATE draft_rooms SET status = 'running', deadline_at = ?, finished_at = NULL, delegates_json = ? WHERE event_id = ?")
        .run(new Date(o.now.getTime() + full).toISOString(), delegates, o.eventId);
    }
    E.logEvent(db, o.eventId, o.actor, 'draft_pick_undone', at, { picks: back.map((p) => ({ pickNo: p.pick_no, steamid: p.steamid })) });
    return V.ok({ undone: back.map((p) => p.pick_no) });
  })();
}

/** Staff hand a team's picking to its first drafted player, or give it
 *  back (Ruling 16). The clock is not touched: the delegate gets the time
 *  left, as a captain arriving mid-clock does. */
export function setDelegate(
  db: DB, o: { eventId: number; captain: string; on: boolean; actor: string; now: Date },
): V.Checked<{ delegate: string | null }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ delegate: string | null }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (!st.order.includes(o.captain)) return V.fail('bad_captain');
    const delegates = { ...st.delegates };
    let delegate: string | null = null;
    if (o.on) {
      const first = st.picks.find((p) => p.captain_steamid === o.captain);
      if (!first) return V.fail('no_delegate');
      delegate = first.steamid;
      delegates[o.captain] = delegate;
    } else {
      delete delegates[o.captain];
    }
    db.prepare('UPDATE draft_rooms SET delegates_json = ? WHERE event_id = ?').run(JSON.stringify(delegates), o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_delegate_set', at, { captain: o.captain, delegate });
    return V.ok({ delegate });
  })();
}

/** Staff Reset room (Ruling 6): every live pick flagged undone, every
 *  draft_team cleared, the room back to 'ready' with no order, so the next
 *  Start recomputes it and the method may change again. */
export function resetRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ undone: number }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    db.prepare('UPDATE draft_picks SET undone_at = ? WHERE event_id = ? AND undone_at IS NULL').run(at, o.eventId);
    db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND draft_team IS NOT NULL').run(o.eventId);
    db.prepare(
      `UPDATE draft_rooms SET status = 'ready', order_json = '[]', deadline_at = NULL, paused_left_ms = NULL,
         started_at = NULL, finished_at = NULL, delegates_json = '{}' WHERE event_id = ?`,
    ).run(o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_reset', at, { undone: st.picks.length });
    return V.ok({ undone: st.picks.length });
  })();
}

/** The captain a viewer picks for (Ruling 16): their own team as a
 *  captain, or the team whose delegate they are; null otherwise. */
export function captainFor(db: DB, eventId: number, steamid: string): string | null {
  if (D.signupOf(db, eventId, steamid)?.role === 'captain') return steamid;
  const room = roomOf(db, eventId);
  if (!room) return null;
  const delegates = JSON.parse(room.delegates_json) as Record<string, string>;
  return Object.entries(delegates).find(([, d]) => d === steamid)?.[0] ?? null;
}

/** A captain (or delegate) saves their team's ordered list (Rulings 1, 2):
 *  any method, from the cut until the draft is done or teams are published.
 *  Unknown and non-pool entries are dropped; the log keeps only the size. */
export function savePickList(db: DB, o: { eventId: number; steamid: string; list: unknown; now: Date }): V.Checked<string[]> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<string[]> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    if (ev.entry_kind !== 'draft') return V.fail('not_draft');
    if (ev.cut_at === null) return V.fail('cut_not_published');
    if (ev.teams_made_at !== null || (ev.status !== 'registration' && ev.status !== 'checkin')) return V.fail('lists_closed');
    if (roomOf(db, ev.id)?.status === 'done') return V.fail('lists_closed');
    const captain = captainFor(db, ev.id, o.steamid);
    if (!captain) return V.fail('not_a_captain');
    const pool = new Set(D.activeSignups(db, ev.id).filter((s) => s.role === 'pool').map((s) => s.steamid));
    const list = cleanPickList(o.list, pool);
    if (!list) return V.fail('bad_list');
    db.prepare(
      `INSERT INTO draft_pick_lists (event_id, captain_steamid, list_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, captain_steamid) DO UPDATE SET list_json = excluded.list_json, updated_at = excluded.updated_at`,
    ).run(ev.id, captain, JSON.stringify(list), at);
    E.logEvent(db, ev.id, o.steamid, 'draft_list_saved', at, { captain, size: list.length });
    return V.ok(list);
  })();
}
```

`src/events/entries.ts`: add `import { roomOf } from './draftRoom.js';` and, in `createDraftEntries` right after `if (ev.cut_at === null) return V.fail('cut_not_published');`:

```ts
    // Plan D2b1 Ruling 19: a live draft publishes only once its room is done.
    if (ev.team_mode === 'live' && roomOf(db, ev.id)?.status !== 'done') return V.fail('draft_not_done');
```

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/draftRoomControls.test.ts tests/draftRoom.test.ts tests/eventLogGuard.test.ts tests/draftTeams.test.ts`
Expected: PASS. Then `npm run typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/events/draftRoom.ts src/events/entries.ts tests/draftRoomControls.test.ts tests/eventLogGuard.test.ts
git commit -m "Staff can pause, resume, undo the last pick (both picks after the forced final one), hand a team's picking to its first pick and reset the draft room; captains and delegates save private pick lists from the cut; and a live draft publishes only once its room is done (plan D2b1)"
```

### Task 5: Player cards and "Chemistry with you"

**Files:**
- Create: `src/events/draftCards.ts`
- Modify: `src/chemistry.ts` (add `pairChemistry`)
- Test: `tests/draftCards.test.ts` (new)

**Interfaces:**
- Consumes: `completedPug` (`src/matchKinds.ts`), `STAT_DEFS` (`src/statKeys.ts`), `displaySr`, `seasonSr` (`src/rating.ts`), `currentSeasonId`, `getPlayer` (`src/players.ts`), `resolveAlias` (`src/aliases.ts`).
- Produces:
  ```ts
  // src/events/draftCards.ts
  export const TREND_LEN = 10; export const FORM_LEN = 10;
  export type SiClass = 'hunter' | 'smoker' | 'boomer' | 'tank';
  export interface PlayerCard {
    steamid: string; name: string; avatar: string | null;
    sr: number; trend: number[]; pugs: number; form: ('W' | 'L' | 'D')[];
    survivor: { siDamage: number; commonKills: number }; infected: { damageAsSi: number; dpsLanded: number };
    bestClass: { cls: SiClass; damage: number } | null;
    skills: { key: string; label: string; total: number }[];
  }
  export function playerCard(db: DB, steamid: string, season?: number): PlayerCard;
  // src/chemistry.ts
  export interface PairChemistry { together: number; wonTogether: number; against: number; wonAgainst: number }
  export function pairChemistry(db: DB, a: string, b: string): PairChemistry;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/draftCards.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId, upsertPlayer } from '../src/players.js';
import { displaySr, UNRATED_SR } from '../src/rating.js';
import { playerCard } from '../src/events/draftCards.js';
import { pairChemistry } from '../src/chemistry.js';

const X = '76561199000000801';
const Y = '76561199000000802';
const Z = '76561199000000803';

function setup(): DB {
  const db = openDb(':memory:');
  for (const [s, n] of [[X, 'Xan'], [Y, 'Yul'], [Z, 'Zed']] as const) upsertPlayer(db, { steamid: s, name: n, avatar: null }, []);
  return db;
}

/** One match; X's survivor numbers and stats ride on it, everyone else has zeros. */
function match(db: DB, o: {
  kind?: 'pug' | 'scrim' | 'tournament'; state?: 'completed' | 'aborted'; voided?: boolean; winner: 'a' | 'b' | 'draw';
  teams: Record<string, 'a' | 'b'>; si?: number; ck?: number; stats?: Record<string, number>;
}): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, kind, ended_at, winner, voided_at) VALUES (?, ?, 'no_mercy', ?, '2026-09-01 10:00:00', ?, ?)",
  ).run(currentSeasonId(db), o.state ?? 'completed', o.kind ?? 'pug', o.winner, o.voided ? '2026-09-02 10:00:00' : null).lastInsertRowid);
  for (const [s, team] of Object.entries(o.teams)) {
    db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage, common_kills) VALUES (?, ?, ?, ?, ?)')
      .run(id, s, team, s === X ? o.si ?? 0 : 0, s === X ? o.ck ?? 0 : 0);
  }
  for (const [k, v] of Object.entries(o.stats ?? {})) {
    db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)').run(id, X, k, v);
  }
  return id;
}

describe('a player card', () => {
  it('counts completed, unvoided PUGs only, for form and survivor play', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a' }, si: 300, ck: 20 });
    match(db, { winner: 'b', teams: { [X]: 'a' }, si: 100, ck: 40 });
    match(db, { winner: 'draw', teams: { [X]: 'a' }, si: 200, ck: 30 });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { kind: 'tournament', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { state: 'aborted', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { voided: true, winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    const c = playerCard(db, X);
    expect(c).toMatchObject({ steamid: X, name: 'Xan', avatar: null, pugs: 3, form: ['D', 'L', 'W'], survivor: { siDamage: 200, commonKills: 30 } });
  });

  it('averages infected play, names the best class and lists the skill counters with totals', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a' }, stats: { damage_as_si: 500, dps_landed: 2, dmg_as_hunter: 300, dmg_as_smoker: 150, skeets: 3, crowns: 1, times_skeeted: 4 } });
    match(db, { winner: 'a', teams: { [X]: 'a' }, stats: { damage_as_si: 100, dmg_as_smoker: 200, skeets: 1 } });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a' }, stats: { skeets: 50, dmg_as_tank: 9999 } });
    const c = playerCard(db, X);
    expect(c.infected).toEqual({ damageAsSi: 300, dpsLanded: 1 });
    expect(c.bestClass).toEqual({ cls: 'smoker', damage: 350 });
    expect(c.skills).toEqual([
      { key: 'skeets', label: 'Skeets', total: 4 },
      { key: 'crowns', label: 'Crowns', total: 1 },
      { key: 'dps_landed', label: 'DPs landed', total: 2 },
    ]);
  });

  it('shows current-season SR and the SR after each of the last 10 rated games, oldest first', () => {
    const db = setup();
    const season = currentSeasonId(db);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, 30, 2)').run(X, season);
    for (let k = 0; k < 12; k++) {
      const id = match(db, { winner: 'a', teams: { [X]: 'a' } });
      db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, ?, ?, 25, 8, ?, 4)')
        .run(X, id, season, 20 + k);
    }
    const c = playerCard(db, X);
    expect(c.sr).toBe(Math.round(displaySr(30, 2)));
    expect(c.trend).toEqual(Array.from({ length: 10 }, (_, i) => Math.round(displaySr(22 + i, 4))));
    expect(c.form).toHaveLength(10);
  });

  it('is empty, not broken, for a player with no PUGs', () => {
    const c = playerCard(setup(), Y);
    expect(c).toEqual({
      steamid: Y, name: 'Yul', avatar: null, sr: Math.round(UNRATED_SR), trend: [], pugs: 0, form: [],
      survivor: { siDamage: 0, commonKills: 0 }, infected: { damageAsSi: 0, dpsLanded: 0 }, bestClass: null, skills: [],
    });
  });
});

describe('chemistry between two players', () => {
  it('counts PUGs together and against, from a\'s side, with aliases resolved and other kinds left out', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a', [Y]: 'a' } });
    match(db, { winner: 'b', teams: { [X]: 'a', [Y]: 'a' } });
    match(db, { winner: 'a', teams: { [X]: 'a', [Y]: 'b' } });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a', [Y]: 'a' } });
    // Z is Y's alt: a PUG with Z on X's team is a PUG with Y.
    db.prepare("INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by) VALUES (?, ?, '2026-09-01', 'admin')").run(Z, Y);
    match(db, { winner: 'a', teams: { [X]: 'a', [Z]: 'a' } });
    expect(pairChemistry(db, X, Y)).toEqual({ together: 3, wonTogether: 2, against: 1, wonAgainst: 1 });
    expect(pairChemistry(db, Y, X)).toEqual({ together: 3, wonTogether: 2, against: 1, wonAgainst: 0 });
    expect(pairChemistry(db, X, '76561199000000899')).toEqual({ together: 0, wonTogether: 0, against: 0, wonAgainst: 0 });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/draftCards.test.ts`
Expected: FAIL: `Cannot find module '../src/events/draftCards.js'`.

- [ ] **Step 3: Implement**

```ts
// src/events/draftCards.ts
import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { displaySr, seasonSr } from '../rating.js';
import { STAT_DEFS } from '../statKeys.js';

/**
 * A draft player card (drafts plan D2b1 Ruling 3, spec section 3): numbers
 * the profile already shows publicly, from completed, unvoided PUGs only
 * (completedPug), never scrims or tournament games. Read only. The signup
 * note and "Chemistry with you" are private and are added by the room view
 * for the viewers allowed them, never here.
 */

export const TREND_LEN = 10;
export const FORM_LEN = 10;
export type SiClass = 'hunter' | 'smoker' | 'boomer' | 'tank';

export interface PlayerCard {
  steamid: string; name: string; avatar: string | null;
  /** Current-season display SR, rounded. */
  sr: number;
  /** SR after each of the last TREND_LEN rated games this season, oldest first. */
  trend: number[];
  /** Completed PUGs played. */
  pugs: number;
  /** Newest first, up to FORM_LEN: W, L or D from this player's side. */
  form: ('W' | 'L' | 'D')[];
  /** Per completed PUG, one decimal. */
  survivor: { siDamage: number; commonKills: number };
  infected: { damageAsSi: number; dpsLanded: number };
  /** The class this player has dealt the most damage as, all time in PUGs. */
  bestClass: { cls: SiClass; damage: number } | null;
  /** The skill_detect counters a high value of which is good, with totals above 0, in registry order. */
  skills: { key: string; label: string; total: number }[];
}

const CLASS_STATS: [SiClass, string][] = [['hunter', 'dmg_as_hunter'], ['smoker', 'dmg_as_smoker'], ['boomer', 'dmg_as_boomer'], ['tank', 'dmg_as_tank']];
const SKILLS = STAT_DEFS.filter((d) => d.visibility === 'public' && d.direction === 'high_good' && d.needsSkillDetect);

export function playerCard(db: DB, steamid: string, season = currentSeasonId(db)): PlayerCard {
  const p = getPlayer(db, steamid);
  const done = `${completedPug('m')} AND m.voided_at IS NULL`;
  const trend = (db.prepare('SELECT mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id DESC LIMIT ?')
    .all(steamid, season, TREND_LEN) as { mu_after: number; sigma_after: number }[])
    .reverse().map((h) => Math.round(displaySr(h.mu_after, h.sigma_after)));
  const games = db.prepare(
    `SELECT m.winner, mp.team, mp.si_damage, mp.common_kills FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${done} ORDER BY m.id DESC`,
  ).all(steamid) as { winner: string | null; team: string; si_damage: number; common_kills: number }[];
  const totals = new Map((db.prepare(
    `SELECT s.stat, SUM(s.value) AS total FROM match_player_stats s JOIN matches m ON m.id = s.match_id
     WHERE s.player_id = ? AND ${done} GROUP BY s.stat`,
  ).all(steamid) as { stat: string; total: number }[]).map((r) => [r.stat, r.total]));
  const total = (k: string) => totals.get(k) ?? 0;
  const n = games.length;
  const per = (v: number) => (n > 0 ? Math.round((v / n) * 10) / 10 : 0);
  let bestClass: PlayerCard['bestClass'] = null;
  for (const [cls, key] of CLASS_STATS) {
    if (total(key) > 0 && (!bestClass || total(key) > bestClass.damage)) bestClass = { cls, damage: total(key) };
  }
  return {
    steamid, name: p?.name ?? steamid, avatar: p?.avatar ?? null,
    sr: Math.round(seasonSr(db, steamid, season)), trend, pugs: n,
    form: games.slice(0, FORM_LEN).map((g) => (g.winner === 'draw' || g.winner === null ? 'D' : g.winner === g.team ? 'W' : 'L')),
    survivor: { siDamage: per(games.reduce((t, g) => t + g.si_damage, 0)), commonKills: per(games.reduce((t, g) => t + g.common_kills, 0)) },
    infected: { damageAsSi: per(total('damage_as_si')), dpsLanded: per(total('dps_landed')) },
    bestClass,
    skills: SKILLS.map((d) => ({ key: d.key, label: d.label, total: total(d.key) })).filter((s) => s.total > 0),
  };
}
```

Append to `src/chemistry.ts`:

```ts
/** "Chemistry with you" on a draft player card (drafts plan D2b1 Ruling 3):
 *  completed PUGs where a and b were on the same side (and how many a's side
 *  won) and on opposite sides (and how many a won), aliases resolved on
 *  both sides with the same roster join as chemistryFor. Shown only to the
 *  captain it is about. */
export interface PairChemistry { together: number; wonTogether: number; against: number; wonAgainst: number }

export function pairChemistry(db: DB, a: string, b: string): PairChemistry {
  return db.prepare(
    `WITH roster AS (
       SELECT DISTINCT mp.match_id, COALESCE(pa.canonical_id, mp.player_id) AS pid, mp.team
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id AND ${completedPug('m')}
       LEFT JOIN player_aliases pa ON pa.steamid = mp.player_id
     )
     SELECT COALESCE(SUM(CASE WHEN x.team = y.team THEN 1 ELSE 0 END), 0) AS together,
            COALESCE(SUM(CASE WHEN x.team = y.team AND m.winner = x.team THEN 1 ELSE 0 END), 0) AS wonTogether,
            COALESCE(SUM(CASE WHEN x.team <> y.team THEN 1 ELSE 0 END), 0) AS against,
            COALESCE(SUM(CASE WHEN x.team <> y.team AND m.winner = x.team THEN 1 ELSE 0 END), 0) AS wonAgainst
     FROM roster x
     JOIN roster y ON y.match_id = x.match_id
     JOIN matches m ON m.id = x.match_id
     WHERE x.pid = ? AND y.pid = ?`,
  ).get(resolveAlias(db, a), resolveAlias(db, b)) as PairChemistry;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run tests/draftCards.test.ts tests/matchKindGuard.test.ts tests/chemistry.test.ts`
Expected: PASS (if `tests/chemistry.test.ts` does not exist, run the first two). Then `npm run typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/events/draftCards.ts src/chemistry.ts tests/draftCards.test.ts
git commit -m "Draft player cards read SR and its trend, survivor and infected play, the best class, skill counters and recent form from completed PUGs, and a pair query gives a captain's chemistry with each player (plan D2b1)"
```

### Task 6: The clock, the room view, the routes and the Start DM

**Files:**
- Create: `src/events/draftClock.ts`, `src/events/draftRoomView.ts`, `src/routes/draftRoom.ts`
- Modify: `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts` (`draft_room_open`)
- Modify: `src/server.ts` (build, tick and register)
- Modify: `tests/notify.test.ts` (label)
- Test: `tests/draftClock.test.ts`, `tests/draftRoomRoutes.test.ts`, `tests/draftRoomPrivacy.test.ts` (all new)

**Interfaces:**
- Consumes: Tasks 3 and 4 (`roomState`, `pickListOf`, `captainFor`, every mutation, `Present`), Task 5 (`playerCard`, `PlayerCard`, `pairChemistry`, `PairChemistry`), Task 2 (`D.setRoomSettings`), `roomSettingsOf` (Task 1).
- Produces:
  ```ts
  // src/events/draftClock.ts
  export const DRAFT_TICK_MS = 1_000; export const HEARTBEAT_FRESH_MS = 25_000;
  export class DraftClock {
    constructor(deps: { db: DB; push?: (eventId: number) => void; now?: () => number });
    nowDate(): Date; heartbeat(eventId: number, steamid: string): void; present(eventId: number): Present;
    push(eventId: number): void; tick(): void;
  }
  // src/events/draftRoomView.ts
  export interface RoomViewer { steamid: string | null; staff: boolean }
  export interface DraftRoomView { /* below */ }
  export function draftRoomView(db: DB, ev: E.EventRow, viewer: RoomViewer, now: Date, cardsOf: (steamids: string[]) => PlayerCard[]): DraftRoomView;
  // src/routes/draftRoom.ts
  export async function draftRoomRoutes(app: FastifyInstance, opts: { db: DB; clock: DraftClock; notifier?: Notifier; publicUrl?: string }): Promise<void>;
  // src/events/notices.ts
  export function tellDraftRoomOpen(d: NoticeDeps, eventId: number, captains: string[]): void;
  ```
  The hub event is the string `draft:<eventId>`. D2b2 (caster scenes) consumes `draftRoomView` with `{ steamid: null, staff: false }` and listens for that event.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/draftClock.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as DR from '../src/events/draftRoom.js';
import { DraftClock, HEARTBEAT_FRESH_MS } from '../src/events/draftClock.js';
import { ADMIN } from './eventFixture.js';
import { CAPTAINS, POOL, T0, at, liveDraft, must, startedDraft } from './draftRoomFixture.js';

describe('presence (Ruling 8)', () => {
  it('counts a heartbeat for 25 seconds, per event', () => {
    let t = T0.getTime();
    const clock = new DraftClock({ db: liveDraft().db, now: () => t });
    clock.heartbeat(7, 'a');
    expect(clock.present(7)('a')).toBe(true);
    expect(clock.present(8)('a')).toBe(false);
    t += HEARTBEAT_FRESH_MS;
    expect(clock.present(7)('a')).toBe(true);
    t += 1;
    expect(clock.present(7)('a')).toBe(false);
  });
});

describe('the tick (Ruling 7)', () => {
  it('auto-picks a running room once its deadline passes, pushes it, and gives an absent next picker 5 seconds', () => {
    const f = startedDraft();
    let t = at(74).getTime();
    const push = vi.fn();
    const clock = new DraftClock({ db: f.db, now: () => t, push });
    clock.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
    t = at(75).getTime();
    clock.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(1);
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect(DR.roomOf(f.db, f.eventId)!.deadline_at).toBe(new Date(t + 5000).toISOString());
  });

  it('never picks for a paused room', () => {
    const f = startedDraft();
    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }));
    new DraftClock({ db: f.db, now: () => at(500).getTime() }).tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(0);
  });

  it('Review Focus 3: a restart keeps the stored deadline, picks once it passes, and leaves a paused room paused', () => {
    const f = liveDraft();
    let t = T0.getTime();
    const before = new DraftClock({ db: f.db, now: () => t });
    for (const c of CAPTAINS) before.heartbeat(f.eventId, c);
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: before.present(f.eventId) }));
    t += 2000;
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: new Date(t), present: before.present(f.eventId) }));
    const deadline = DR.roomOf(f.db, f.eventId)!.deadline_at!;
    expect(deadline).toBe(new Date(t + 75_000).toISOString());

    const after = new DraftClock({ db: f.db, now: () => t }); // a new process: no heartbeats
    t += 30_000;
    after.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(1);
    expect(DR.roomOf(f.db, f.eventId)!.deadline_at).toBe(deadline);
    t = Date.parse(deadline);
    after.tick();
    expect(DR.livePicks(f.db, f.eventId)[1]).toMatchObject({ pick_no: 2, captain_steamid: CAPTAINS[1], auto: 1 });

    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t) }));
    new DraftClock({ db: f.db, now: () => t + 3_600_000 }).tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(2);
    expect(DR.roomOf(f.db, f.eventId)!.status).toBe('paused');
  });
});
```

```ts
// tests/draftRoomRoutes.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { draftRoomRoutes } from '../src/routes/draftRoom.js';
import { DraftClock } from '../src/events/draftClock.js';
import * as DR from '../src/events/draftRoom.js';
import type { Notifier } from '../src/notify/notify.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, liveDraft, must } from './draftRoomFixture.js';

const MOD = '76561199000000777';
let f: DraftFixture;
let app: FastifyInstance;
let clock: DraftClock;
let t: number;
const push = vi.fn();
const send = vi.fn(() => 1);

async function build(fx: DraftFixture): Promise<void> {
  f = fx;
  t = T0.getTime();
  push.mockReset();
  send.mockClear();
  clock = new DraftClock({ db: f.db, now: () => t, push });
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(draftRoomRoutes, { db: f.db, clock, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who?: string) => app.inject({ method: 'GET', url, cookies: who ? as(who) : undefined });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const put = (url: string, who: string, body: object) => app.inject({ method: 'PUT', url, cookies: as(who), payload: body });
const room = (p = '') => `/api/events/${f.slug}/draft${p}`;
const desk = (a: string) => `/api/admin/events/${f.eventId}/draft/room/${a}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });
const start = () => must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: ALL }));

describe('the public room', () => {
  it('serves anyone once the cut is published, and nothing private', async () => {
    await build(liveDraft());
    const res = await get(room());
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v).toMatchObject({ eventId: f.eventId, slug: f.slug, status: 'ready', totalPicks: 15, onClock: null, picks: [], lists: null, notes: null, staff: false });
    expect(v.me).toEqual({ role: null, team: null, onClock: false, list: null, chemistry: null });
    expect(v.order.map((o: { steamid: string }) => o.steamid)).toEqual(CAPTAINS);
    expect(v.pool).toHaveLength(15);
    expect(Object.keys(v.pool[0]).sort()).toEqual(['avatar', 'bestClass', 'form', 'infected', 'name', 'pugs', 'skills', 'sr', 'steamid', 'survivor', 'trend']);
  });

  it('answers 409 before the cut and 404 behind a closed switch', async () => {
    await build(cutDraft({ publish: false }));
    const res = await get(room());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(text('cut_not_published'));
    f.db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await get(room())).statusCode).toBe(404);
  });

  it('shows status none, captains only on the board, when staff chose auto-balance', async () => {
    const fx = cutDraft({ balance: true });
    await build(fx);
    const v = (await get(room())).json();
    expect(v.status).toBe('none');
    expect(v.teams.every((t: { players: unknown[] }) => t.players.length === 0)).toBe(true);
  });
});

describe('Start from the desk', () => {
  it('starts the room, pushes it and DMs every captain the room link; a mod cannot', async () => {
    await build(liveDraft());
    expect((await post(desk('start'), MOD)).statusCode).toBe(403);
    const res = await post(desk('start'), ADMIN);
    expect(res.statusCode).toBe(200);
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CAPTAINS, 'draft_room_open', expect.objectContaining({
      content: `The live draft for Draft Night has started and you are a captain. If you are not in the room when your turn comes, the site picks for you from your pick list. Join now: https://x/event/${f.slug}/draft`,
    }));
    expect((await get(room())).json().status).toBe('running');
  });

  it('saves settings, and runs pause, resume, undo, delegate and reset, each pushed', async () => {
    await build(liveDraft());
    expect((await post(desk('settings'), ADMIN, { firstPick: 'random', pickSeconds: 999 })).json()).toEqual(text('bad_room_settings'));
    expect((await post(desk('settings'), ADMIN, { firstPick: 'highest_sr', pickSeconds: 60 })).statusCode).toBe(200);
    expect((await post(desk('start'), ADMIN)).statusCode).toBe(200);
    expect((await get(room())).json().order[0].steamid).toBe(CAPTAINS[4]);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[4]!, player: POOL[0]!, pickNo: 1, now: new Date(t), present: ALL }));
    push.mockReset();
    for (const a of ['pause', 'resume', 'undo']) expect((await post(desk(a), ADMIN)).statusCode, a).toBe(200);
    expect((await post(desk('delegate'), ADMIN, { captain: CAPTAINS[4] })).statusCode).toBe(400);
    expect((await post(desk('delegate'), ADMIN, { captain: CAPTAINS[4], on: true })).json()).toEqual(text('no_delegate'));
    expect((await post(desk('reset'), ADMIN)).statusCode).toBe(200);
    expect(push).toHaveBeenCalledTimes(4);
  });

  it('serves the staff view to a mod', async () => {
    await build(liveDraft());
    const v = (await get(`/api/admin/events/${f.eventId}/draft/room`, MOD)).json();
    expect(v.staff).toBe(true);
    expect(Object.keys(v.lists).sort()).toEqual([...CAPTAINS].sort());
    expect((await get(`/api/admin/events/${f.eventId}/draft/room`, POOL[0])).statusCode).toBe(403);
  });
});

describe('picking', () => {
  it('takes a pick from the captain on the clock and refuses a stale pickNo, the wrong person and a bad body', async () => {
    await build(liveDraft());
    start();
    const ok = await post(room('/pick'), CAPTAINS[0]!, { player: POOL[0], pickNo: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ pickNo: 1, done: false });
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect((await post(room('/pick'), CAPTAINS[0]!, { player: POOL[1], pickNo: 1 })).json()).toEqual(text('pick_moved'));
    expect((await post(room('/pick'), CAPTAINS[0]!, { player: POOL[1], pickNo: 2 })).json()).toEqual(text('not_your_pick'));
    expect((await post(room('/pick'), POOL[5]!, { player: POOL[1], pickNo: 2 })).statusCode).toBe(403);
    expect((await post(room('/pick'), CAPTAINS[1]!, { player: 3, pickNo: 2 })).statusCode).toBe(400);
    expect(clock.present(f.eventId)(CAPTAINS[0]!)).toBe(true);
  });

  it('records heartbeats from captains only', async () => {
    await build(liveDraft());
    expect((await post(room('/heartbeat'), CAPTAINS[2]!)).json()).toEqual({ ok: true });
    expect((await post(room('/heartbeat'), POOL[2]!)).json()).toEqual({ ok: true });
    expect(clock.present(f.eventId)(CAPTAINS[2]!)).toBe(true);
    expect(clock.present(f.eventId)(POOL[2]!)).toBe(false);
  });
});

describe('lists and cards', () => {
  it('saves and reads a captain\'s own list, and refuses anyone else', async () => {
    await build(liveDraft());
    expect((await put(room('/list'), CAPTAINS[0]!, { list: [POOL[2], BENCH] })).json()).toEqual({ list: [POOL[2]] });
    expect((await get(room('/list'), CAPTAINS[0]!)).json()).toEqual({ list: [POOL[2]] });
    expect((await put(room('/list'), POOL[0]!, { list: [] })).json()).toEqual(text('not_a_captain'));
    expect((await get(room('/list'), POOL[0]!)).statusCode).toBe(403);
  });

  it('gives captains and staff every pool card with notes; chemistry only to a captain', async () => {
    await build(liveDraft());
    f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run('prefer infected', f.eventId, POOL[1]);
    const mine = (await get(room('/cards'), CAPTAINS[0]!)).json();
    expect(mine.cards).toHaveLength(15);
    expect(mine.notes).toEqual({ [POOL[1]!]: 'prefer infected' });
    expect(Object.keys(mine.chemistry)).toHaveLength(15);
    expect(mine.chemistry[POOL[0]!]).toEqual({ together: 0, wonTogether: 0, against: 0, wonAgainst: 0 });
    const staff = (await get(room('/cards'), MOD)).json();
    expect(staff.chemistry).toBeNull();
    expect(staff.notes).toEqual({ [POOL[1]!]: 'prefer infected' });
    expect((await get(room('/cards'), POOL[0]!)).statusCode).toBe(403);
  });
});
```

```ts
// tests/draftRoomPrivacy.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { draftRoomRoutes } from '../src/routes/draftRoom.js';
import { DraftClock } from '../src/events/draftClock.js';
import * as DR from '../src/events/draftRoom.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import type { DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, at, drive, liveDraft, must } from './draftRoomFixture.js';

/** Spec, Testing: chemistry, captains' lists, signup notes and the fairness
 *  readout never appear in any response for a viewer who is not staff, not
 *  the organizer and not the owning captain (Ruling 14). */
const NOTE = 'secret note 7731';
const MOD = '76561199000000777';
const ORG = '76561199000000778';
const LIST_A = [POOL[9]!, POOL[8]!];
const LIST_B = [POOL[3]!];
let f: DraftFixture;
let app: FastifyInstance;

async function setup(): Promise<void> {
  f = liveDraft();
  f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run(NOTE, f.eventId, POOL[4]);
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, list: LIST_A, now: T0 }));
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[1]!, list: LIST_B, now: T0 }));
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
  drive(f, 1);
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(draftRoomRoutes, { db: f.db, clock: new DraftClock({ db: f.db, now: () => at(5).getTime() }) });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  authedCookie(app, f.db, ORG);
  f.db.prepare('UPDATE events SET organizer_steamid = ? WHERE id = ?').run(ORG, f.eventId);
}
afterEach(async () => { await app?.close(); });
const get = (url: string, who: string | null) => app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, f.db, who) : undefined });
const FAIRNESS = ['avgSr', 'totalSr', 'spread', 'winA', 'forecasts'];

describe('draft room privacy', () => {
  it('shows a plain viewer, a pool player and the bench no list, note, chemistry or fairness', async () => {
    await setup();
    for (const who of [null, POOL[0]!, BENCH, POOL[5]!]) {
      const res = await get(`/api/events/${f.slug}/draft`, who);
      expect(res.statusCode, String(who)).toBe(200);
      const body = res.body;
      const v = res.json();
      expect(body).not.toContain(NOTE);
      expect(body).not.toContain('"together"');
      expect(body).not.toContain(JSON.stringify(LIST_A));
      expect(body).not.toContain(JSON.stringify(LIST_B));
      for (const k of FAIRNESS) expect(body).not.toContain(`"${k}"`);
      expect(v.lists).toBeNull();
      expect(v.notes).toBeNull();
      expect(v.me).toMatchObject({ list: null, chemistry: null });
      if (who) {
        expect((await get(`/api/events/${f.slug}/draft/cards`, who)).statusCode).toBe(403);
        expect((await get(`/api/events/${f.slug}/draft/list`, who)).statusCode).toBe(403);
        expect((await get(`/api/admin/events/${f.eventId}/draft/room`, who)).statusCode).toBe(403);
      }
    }
  });

  it('shows a captain their own list and chemistry, never another captain\'s list', async () => {
    await setup();
    const res = await get(`/api/events/${f.slug}/draft`, CAPTAINS[1]!);
    const v = res.json();
    expect(v.me.list).toEqual(LIST_B);
    expect(Object.keys(v.me.chemistry)).toHaveLength(15);
    expect(v.lists).toBeNull();
    expect(res.body).not.toContain(JSON.stringify(LIST_A));
    expect(v.notes).toEqual({ [POOL[4]!]: NOTE });
    for (const k of FAIRNESS) expect(res.body).not.toContain(`"${k}"`);
  });

  it('shows staff and the organizer every list, and the notes', async () => {
    await setup();
    for (const who of [MOD, ORG]) {
      const v = (await get(`/api/events/${f.slug}/draft`, who)).json();
      expect(v.lists).toEqual({ [CAPTAINS[0]!]: LIST_A, [CAPTAINS[1]!]: LIST_B, [CAPTAINS[2]!]: [], [CAPTAINS[3]!]: [], [CAPTAINS[4]!]: [] });
      expect(v.notes).toEqual({ [POOL[4]!]: NOTE });
      expect(v.me.chemistry).toBeNull();
    }
  });
});
```

In `tests/notify.test.ts`, at the end of the test `lists the draft signup removal and cut role DMs (plan D1)`, add:

```ts
    // Plan D2b1 Task 6: the room is open.
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_room_open')).toEqual({ type: 'draft_room_open', label: 'Draft: the live draft room opened' });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/draftClock.test.ts tests/draftRoomRoutes.test.ts tests/draftRoomPrivacy.test.ts tests/notify.test.ts`
Expected: FAIL: the three new modules cannot be found, and `draft_room_open` has no label.

- [ ] **Step 3: Implement the clock**

```ts
// src/events/draftClock.ts
import type { DB } from '../db.js';
import { autoPickDue, type Present } from './draftRoom.js';

export const DRAFT_TICK_MS = 1_000;
/** Ruling 8: a heartbeat every 10 s, so 25 s is two missed beats. */
export const HEARTBEAT_FRESH_MS = 25_000;

/**
 * The live draft room's clock (drafts plan D2b1 Rulings 7 and 8). Presence
 * is the only state it holds, in memory: who sent a room heartbeat in the
 * last 25 s, per event. A restart forgets it, so for up to 10 s every
 * picker reads as absent; the stored deadline of the running pick is never
 * touched by that. tick() runs every second from src/server.ts and
 * auto-picks for each running room whose deadline has passed; a fault in
 * one room is logged and never stops the rest. push tells the pages
 * (hub event draft:<eventId>) and never throws.
 */
export class DraftClock {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: { db: DB; push?: (eventId: number) => void; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  /** The one clock the room routes use, so tests can move it. */
  nowDate(): Date {
    return new Date(this.now());
  }

  heartbeat(eventId: number, steamid: string): void {
    this.seen.set(`${eventId}:${steamid}`, this.now());
  }

  present(eventId: number): Present {
    const t = this.now();
    return (steamid) => {
      const last = this.seen.get(`${eventId}:${steamid}`);
      return last !== undefined && t - last <= HEARTBEAT_FRESH_MS;
    };
  }

  push(eventId: number): void {
    try { this.deps.push?.(eventId); } catch (err) { console.warn('[draft] push failed:', err instanceof Error ? err.message : err); }
  }

  tick(): void {
    const t = this.now();
    for (const [k, last] of this.seen) if (t - last > HEARTBEAT_FRESH_MS) this.seen.delete(k);
    const now = new Date(t);
    const due = this.deps.db.prepare(
      "SELECT event_id FROM draft_rooms WHERE status = 'running' AND deadline_at IS NOT NULL AND deadline_at <= ?",
    ).all(now.toISOString()) as { event_id: number }[];
    for (const { event_id: eventId } of due) {
      try {
        const r = autoPickDue(this.deps.db, { eventId, now, present: this.present(eventId) });
        if (r.ok) this.push(eventId);
      } catch (err) {
        console.error(`[draft] auto-pick for event ${eventId} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}
```

- [ ] **Step 4: Implement the view**

```ts
// src/events/draftRoomView.ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { pairChemistry, type PairChemistry } from '../chemistry.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as DR from './draftRoom.js';
import { roomSettingsOf, type RoomSettings } from './draftRules.js';
import type { PlayerCard } from './draftCards.js';

/**
 * GET /api/events/:slug/draft, tailored per viewer (drafts plan D2b1
 * Rulings 10, 14, 16, 22). Everyone: status, settings, the clock (with the
 * server's now for skew), order, the pick log without undone picks, teams so
 * far and the free pool as public cards. The team's captain or delegate also
 * gets that team's list, the notes and chemistry with themselves. Staff and
 * the organizer get every list and the notes. Fairness is never here: it
 * stays on the desk's Make teams panel.
 */
export interface RoomViewer { steamid: string | null; staff: boolean }
export interface DraftPickView { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
export interface DraftRoomView {
  eventId: number; slug: string; eventName: string;
  status: 'none' | DR.RoomStatus; teamsMadeAt: string | null; settings: RoomSettings;
  serverNow: string; deadlineAt: string | null; pausedLeftMs: number | null; totalPicks: number;
  order: { steamid: string; name: string }[];
  onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
  picks: DraftPickView[];
  delegates: Record<string, string>;
  teams: { captain: { steamid: string; name: string }; players: { steamid: string; name: string }[] }[];
  pool: PlayerCard[];
  notes: Record<string, string> | null;
  me: { role: 'captain' | 'delegate' | null; team: string | null; onClock: boolean; list: string[] | null; chemistry: Record<string, PairChemistry> | null };
  lists: Record<string, string[]> | null;
  staff: boolean;
}

export function draftRoomView(db: DB, ev: E.EventRow, viewer: RoomViewer, now: Date, cardsOf: (steamids: string[]) => PlayerCard[]): DraftRoomView {
  const live = ev.team_mode === 'live';
  const st = live ? DR.roomState(db, ev.id) : null;
  const room = st?.room ?? null;
  const status: DraftRoomView['status'] = !live ? 'none' : room?.status ?? 'ready';
  const all = D.activeSignups(db, ev.id);
  const captains = all.filter((s) => s.role === 'captain');
  const pool = all.filter((s) => s.role === 'pool');
  const nameOf = (s: string) => getPlayer(db, s)?.name ?? s;
  const order = st && st.order.length > 0 ? st.order : captains.map((c) => c.steamid);
  const picks = st?.picks ?? [];
  const delegates = st?.delegates ?? {};
  const taken = new Set(picks.map((p) => p.steamid));
  const me = viewer.steamid;
  const ownCaptain = me !== null && captains.some((c) => c.steamid === me) ? me : null;
  const delegateFor = me !== null && !ownCaptain ? Object.entries(delegates).find(([, d]) => d === me)?.[0] ?? null : null;
  const team = ownCaptain ?? delegateFor;
  const seeAll = viewer.staff || (me !== null && me === ev.organizer_steamid);
  const settings = roomSettingsOf(ev.draft_json);
  return {
    eventId: ev.id, slug: ev.slug, eventName: ev.name, status, teamsMadeAt: ev.teams_made_at,
    settings: room && room.status !== 'ready' ? { ...settings, pickSeconds: room.pick_seconds } : settings,
    serverNow: now.toISOString(),
    deadlineAt: status === 'running' ? room!.deadline_at : null,
    pausedLeftMs: status === 'paused' ? room!.paused_left_ms : null,
    totalPicks: pool.length,
    order: order.map((s) => ({ steamid: s, name: nameOf(s) })),
    onClock: status === 'running' && st?.next ? { pickNo: st.next.pickNo, round: st.next.round, captain: st.next.captain, picker: st.picker! } : null,
    picks: picks.map((p) => ({ pickNo: p.pick_no, round: p.round, captain: p.captain_steamid, steamid: p.steamid, name: nameOf(p.steamid), auto: p.auto === 1, at: p.at })),
    delegates,
    teams: order.map((c) => ({
      captain: { steamid: c, name: nameOf(c) },
      players: picks.filter((p) => p.captain_steamid === c).map((p) => ({ steamid: p.steamid, name: nameOf(p.steamid) })),
    })),
    pool: cardsOf(pool.filter((s) => !taken.has(s.steamid)).map((s) => s.steamid)),
    notes: seeAll || team !== null ? Object.fromEntries(pool.filter((s) => s.note !== null).map((s) => [s.steamid, s.note!])) : null,
    me: {
      role: ownCaptain ? 'captain' : delegateFor ? 'delegate' : null,
      team,
      onClock: me !== null && status === 'running' && st?.picker === me,
      list: team ? DR.pickListOf(db, ev.id, team) : null,
      chemistry: team && me ? Object.fromEntries(pool.map((s) => [s.steamid, pairChemistry(db, me, s.steamid)])) : null,
    },
    lists: seeAll ? Object.fromEntries(captains.map((c) => [c.steamid, DR.pickListOf(db, ev.id, c.steamid)])) : null,
    staff: seeAll,
  };
}
```

- [ ] **Step 5: Implement the DM**

`src/notify/notify.ts`: add `| 'draft_room_open'` to the `NotifyType` union after `'draft_captain_set_old'`, and to `NOTIFY_TYPES` after the `draft_captain_set_old` entry:
`{ type: 'draft_room_open', label: 'Draft: the live draft room opened' },`

`src/events/messages.ts`: add `| 'draft_room_open'` to `EventNotifyType`, and a case in `eventMessage`'s switch:

```ts
    case 'draft_room_open':
      // Plan D2b1 Ruling 11: every captain, once, at Start.
      content = `The live draft for ${event} has started and you are a captain. If you are not in the room when your turn comes, the site picks for you from your pick list. Join now: ${publicUrl}/event/${ev.slug}/draft`;
      break;
```

`src/events/notices.ts`, at the end:

```ts
/** The live draft room started (drafts plan D2b1 Ruling 11): every captain,
 *  in pick order, with the room link. */
export function tellDraftRoomOpen(d: NoticeDeps, eventId: number, captains: string[]): void {
  tell(d, captains, eventId, 'draft_room_open', {});
}
```

- [ ] **Step 6: Implement the routes**

```ts
// src/routes/draftRoom.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { makeOptionalViewer, makeRequireActive, makeRequireAdmin, makeRequireMod } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import { logAdmin } from '../admin/audit.js';
import { pairChemistry } from '../chemistry.js';
import * as E from '../events/events.js';
import * as D from '../events/drafts.js';
import * as DR from '../events/draftRoom.js';
import * as V from '../events/validate.js';
import { playerCard, type PlayerCard } from '../events/draftCards.js';
import { draftRoomView } from '../events/draftRoomView.js';
import { tellDraftRoomOpen } from '../events/notices.js';
import type { DraftClock } from '../events/draftClock.js';
import type { Notifier } from '../notify/notify.js';

const NOT_FOUND = { error: 'not found' };
/** Ruling 21: cards are memoized per event this long. */
const CARD_TTL_MS = 60_000;
/** The body fields a desk room action may carry into the admin audit. */
const AUDIT_KEYS = ['captain', 'on', 'firstPick', 'pickSeconds'];

/**
 * The live draft room (drafts plan D2b1 Ruling 12). Public routes sit behind
 * competitive_enabled exactly as src/routes/events.ts does; a draft-status
 * (unpublished) event answers 404 as the signup routes do. The desk routes
 * follow the Events desk: mods read, admins write, logAdmin after commit.
 * Every room change pushes draft:<eventId> through the clock.
 */
export async function draftRoomRoutes(
  app: FastifyInstance, opts: { db: DB; clock: DraftClock; notifier?: Notifier; publicUrl?: string },
): Promise<void> {
  const { db, clock } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const isStaff = (s: string | null): boolean => {
    const p = s ? getPlayer(db, s) : undefined;
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const refuse = (reply: FastifyReply, error: V.EventError) =>
    reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  /** A published draft-kind event with its cut published, or the reply sent. */
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, 'not_draft'); return null; }
    if (ev.cut_at === null) { refuse(reply, 'cut_not_published'); return null; }
    return ev;
  };
  const memo = new Map<number, { at: number; cards: Map<string, PlayerCard> }>();
  const cardsOf = (eventId: number) => (ids: string[]): PlayerCard[] => {
    const nowMs = Date.now();
    let m = memo.get(eventId);
    if (!m || nowMs - m.at > CARD_TTL_MS) {
      const season = currentSeasonId(db);
      const pool = D.activeSignups(db, eventId).filter((s) => s.role === 'pool');
      m = { at: nowMs, cards: new Map(pool.map((s) => [s.steamid, playerCard(db, s.steamid, season)])) };
      memo.set(eventId, m);
    }
    const cards = m.cards;
    return ids.map((id) => cards.get(id) ?? playerCard(db, id));
  };
  const viewFor = (ev: E.EventRow, steamid: string | null, staff: boolean) => draftRoomView(db, ev, { steamid, staff }, clock.nowDate(), cardsOf(ev.id));
  type Slug = { slug: string };

  app.get('/api/events/:slug/draft', async (req, reply) => {
    const viewer = optionalViewer(req);
    if (!(viewer ? competitiveAccess(db, viewer) : competitivePublic(db))) return reply.code(404).send(NOT_FOUND);
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return viewFor(ev, viewer, isStaff(viewer));
  });

  app.post('/api/events/:slug/draft/pick', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const body = (req.body ?? {}) as { player?: unknown; pickNo?: unknown };
    if (typeof body.player !== 'string' || typeof body.pickNo !== 'number' || !Number.isInteger(body.pickNo)) return refuse(reply, 'bad_request');
    clock.heartbeat(ev.id, me); // a pick is presence too (Ruling 8)
    const r = DR.makePick(db, { eventId: ev.id, steamid: me, player: body.player, pickNo: body.pickNo, now: clock.nowDate(), present: clock.present(ev.id) });
    if (!r.ok) return refuse(reply, r.error);
    clock.push(ev.id);
    return { pickNo: r.value.pickNo, done: r.value.done };
  });

  /** Ruling 8: a captain's or delegate's room page beats every 10 s; anyone
   *  else's beat is accepted and ignored, so the page need not know. */
  app.post('/api/events/:slug/draft/heartbeat', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    if (DR.captainFor(db, ev.id, me)) clock.heartbeat(ev.id, me);
    return { ok: true };
  });

  app.get('/api/events/:slug/draft/list', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const captain = DR.captainFor(db, ev.id, me);
    if (!captain) return refuse(reply, 'not_a_captain');
    return { list: DR.pickListOf(db, ev.id, captain) };
  });

  /** No push: a list is private, so no other page needs to refetch. */
  app.put('/api/events/:slug/draft/list', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const r = DR.savePickList(db, { eventId: ev.id, steamid: me, list: ((req.body ?? {}) as { list?: unknown }).list, now: clock.nowDate() });
    if (!r.ok) return refuse(reply, r.error);
    return { list: r.value };
  });

  /** Every pool card (picked or not) for the list drawer, with the notes;
   *  chemistry with the viewer for a captain or delegate (Ruling 3). */
  app.get('/api/events/:slug/draft/cards', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const captain = DR.captainFor(db, ev.id, me);
    if (!captain && !isStaff(me) && me !== ev.organizer_steamid) return refuse(reply, 'not_a_captain');
    const pool = D.activeSignups(db, ev.id).filter((s) => s.role === 'pool');
    return {
      cards: cardsOf(ev.id)(pool.map((s) => s.steamid)),
      notes: Object.fromEntries(pool.filter((s) => s.note !== null).map((s) => [s.steamid, s.note!])),
      chemistry: captain ? Object.fromEntries(pool.map((s) => [s.steamid, pairChemistry(db, me, s.steamid)])) : null,
    };
  });

  // The desk (Ruling 12).
  const eventOf = (raw: unknown): E.EventRow | undefined => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? E.getEvent(db, n) : undefined;
  };
  app.get('/api/admin/events/:id/draft/room', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    if (ev.entry_kind !== 'draft') return refuse(reply, 'not_draft');
    return viewFor(ev, me, true);
  });
  const roomPost = <T>(
    path: string, run: (ev: E.EventRow, me: string, body: Record<string, unknown>) => V.Checked<T> | null, after?: (ev: E.EventRow, value: T) => void,
  ) => app.post(`/api/admin/events/:id/draft/room/${path}`, async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = run(ev, me, body);
    if (r === null) return refuse(reply, 'bad_request');
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, `event_draft_room_${path}`, ev.id, { slug: ev.slug, ...Object.fromEntries(AUDIT_KEYS.filter((k) => k in body).map((k) => [k, body[k]])) });
    clock.push(ev.id);
    after?.(ev, r.value);
    return { ok: true };
  });
  const staffOpts = (ev: E.EventRow, me: string) => ({ eventId: ev.id, actor: me, now: clock.nowDate() });
  roomPost('start', (ev, me) => DR.startRoom(db, { ...staffOpts(ev, me), present: clock.present(ev.id) }),
    (ev, v) => tellDraftRoomOpen(opts, ev.id, v.order));
  roomPost('pause', (ev, me) => DR.pauseRoom(db, staffOpts(ev, me)));
  roomPost('resume', (ev, me) => DR.resumeRoom(db, staffOpts(ev, me)));
  roomPost('undo', (ev, me) => DR.undoPick(db, staffOpts(ev, me)));
  roomPost('reset', (ev, me) => DR.resetRoom(db, staffOpts(ev, me)));
  roomPost('delegate', (ev, me, b) => (typeof b.captain !== 'string' || typeof b.on !== 'boolean' ? null
    : DR.setDelegate(db, { ...staffOpts(ev, me), captain: b.captain, on: b.on })));
  roomPost('settings', (ev, me, b) => D.setRoomSettings(db, { ...staffOpts(ev, me), settings: b }));
}
```

- [ ] **Step 7: Wire it into the server**

`src/server.ts`: add the imports next to the RoomClock ones:

```ts
import { DraftClock, DRAFT_TICK_MS } from './events/draftClock.js';
import { draftRoomRoutes } from './routes/draftRoom.js';
```

and right after `await app.register(eventRoutes, { ... });` (about line 2123):

```ts
  // Drafts plan D2b1: the live draft room. Its state lives in the database
  // with stored deadlines, so the clock only holds presence and a restart
  // resumes the draft; every second it auto-picks overdue picks. A change is
  // broadcast as draft:<eventId>, which only the room page and the desk
  // controls listen for (useLiveState ignores it).
  const draftClock = new DraftClock({ db: deps.db, push: (eventId) => hub.broadcast(`draft:${eventId}`) });
  const draftTick = setInterval(() => draftClock.tick(), DRAFT_TICK_MS);
  draftTick.unref();
  app.addHook('onClose', async () => { clearInterval(draftTick); });
  await app.register(draftRoomRoutes, { db: deps.db, clock: draftClock, notifier, publicUrl: deps.config.publicUrl });
```

- [ ] **Step 8: Run them and see them pass**

Run: `npx vitest run tests/draftClock.test.ts tests/draftRoomRoutes.test.ts tests/draftRoomPrivacy.test.ts tests/notify.test.ts tests/draftRoom.test.ts tests/draftRoomControls.test.ts`
Expected: PASS. Then the full server suite once, `npx vitest run --project server` (expected: only the 7 known `skeetStreakPoster` failures), and `npm run typecheck` (no errors).

- [ ] **Step 9: Commit**

```bash
git add src/events/draftClock.ts src/events/draftRoomView.ts src/routes/draftRoom.ts src/notify/notify.ts src/events/messages.ts src/events/notices.ts src/server.ts tests/draftClock.test.ts tests/draftRoomRoutes.test.ts tests/draftRoomPrivacy.test.ts tests/notify.test.ts
git commit -m "The draft room is served live: a one-second clock auto-picks overdue picks from stored deadlines, captains heartbeat and pick, save lists and read cards, staff run the room from the desk, captains get a DM at Start, and each viewer sees only what is theirs (plan D2b1)"
```

### Task 7: The room page, player cards and the pick list drawer (web)

**Files:**
- Modify: `web/src/api.ts` (types after `AdminDraftTeamsView`; calls in `eventsApi` and `adminApi`)
- Modify: `web/src/hooks/useLiveState.ts` (`wakesLiveState`)
- Create: `web/src/routes/event/draft/draftText.ts`, `DraftCard.tsx`, `PickListDrawer.tsx`
- Create: `web/src/routes/EventDraft.tsx`
- Modify: `web/src/AppRoutes.tsx`, `web/src/routes/Event.tsx` (the link), `web/src/styles/app.css`
- Test: `web/src/hooks/useLiveState.test.ts`, `web/src/routes/event/draft/draftText.test.ts`, `web/src/routes/event/draft/PickListDrawer.test.tsx`, `web/src/routes/EventDraft.test.tsx` (all new); `web/src/routes/Event.test.tsx`, `web/src/appRoutes.test.tsx` (one test each)

**Interfaces:**
- Consumes: the Task 6 routes and the `DraftRoomView` shape (mirrored below), the hub event `draft:<eventId>`, `playPopSound` (`web/src/popSound.ts`), `useHubEvent`, `clockText` (`web/src/routes/event/room/roomText.ts`), `Panel`, `Empty`, `PageHeader`.
- Produces (`web/src/api.ts`):
  ```ts
  export interface PlayerCardView { steamid: string; name: string; avatar: string | null; sr: number; trend: number[]; pugs: number; form: ('W' | 'L' | 'D')[]; survivor: { siDamage: number; commonKills: number }; infected: { damageAsSi: number; dpsLanded: number }; bestClass: { cls: 'hunter' | 'smoker' | 'boomer' | 'tank'; damage: number } | null; skills: { key: string; label: string; total: number }[] }
  export interface PairChemistryView { together: number; wonTogether: number; against: number; wonAgainst: number }
  export type DraftFirstPick = 'lowest_sr' | 'highest_sr' | 'random';
  export interface DraftPickView { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
  export interface DraftRoomView { /* mirrors src/events/draftRoomView.ts DraftRoomView */ }
  export interface DraftCardsView { cards: PlayerCardView[]; notes: Record<string, string>; chemistry: Record<string, PairChemistryView> | null }
  eventsApi.draftRoom(slug, signal?) / draftPick(slug, player, pickNo) / draftHeartbeat(slug) / draftCards(slug, signal?) / draftList(slug, signal?) / saveDraftList(slug, list)
  adminApi.draftRoom(id, signal?) / draftRoomAct(id, action) / draftRoomDelegate(id, captain, on) / draftRoomSettings(id, firstPick, pickSeconds)
  ```
  Task 8 uses the `adminApi` calls and `DraftRoomView`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/hooks/useLiveState.test.ts
import { describe, it, expect } from 'vitest';
import { wakesLiveState } from './useLiveState';

describe('wakesLiveState', () => {
  it('refetches the queue for everything but a draft room change (plan D2b1 Ruling 10)', () => {
    expect(wakesLiveState('refresh')).toBe(true);
    expect(wakesLiveState('live')).toBe(true);
    expect(wakesLiveState(null)).toBe(true);
    expect(wakesLiveState('draft:4')).toBe(false);
  });
});
```

```ts
// web/src/routes/event/draft/draftText.test.ts
import { describe, it, expect } from 'vitest';
import type { DraftPickView, PlayerCardView } from '../../../api';
import { freshPicks, sortedPool, trendText } from './draftText';

const pick = (pickNo: number, at: string, steamid = `p${pickNo}`): DraftPickView => ({ pickNo, round: 1, captain: 'c', steamid, name: steamid, auto: false, at });
const card = (name: string, sr: number) => ({ steamid: name, name, sr } as PlayerCardView);

describe('freshPicks', () => {
  it('marks everything seen on the first load and reveals nothing', () => {
    const r = freshPicks(null, [pick(1, 'a')]);
    expect(r.fresh).toEqual([]);
    expect(freshPicks(r.seen, [pick(1, 'a'), pick(2, 'b')]).fresh).toEqual([pick(2, 'b')]);
  });
  it('reveals a pick made again after an undo', () => {
    const r = freshPicks(null, [pick(1, 'a'), pick(2, 'b')]);
    expect(freshPicks(r.seen, [pick(1, 'a'), pick(2, 'c', 'p9')]).fresh).toEqual([pick(2, 'c', 'p9')]);
  });
});

describe('sortedPool', () => {
  const pool = [card('bob', 1200), card('Cy', 1350), card('di', 1200)];
  it('sorts by SR, ties by name, or by name, and filters by name ignoring case', () => {
    expect(sortedPool(pool, '', 'sr').map((c) => c.name)).toEqual(['Cy', 'bob', 'di']);
    expect(sortedPool(pool, '', 'name').map((c) => c.name)).toEqual(['bob', 'Cy', 'di']);
    expect(sortedPool(pool, ' C', 'sr').map((c) => c.name)).toEqual(['Cy']);
  });
});

describe('trendText', () => {
  it('says how far SR moved over the trend, or nothing with under two points', () => {
    expect(trendText([1000, 1020, 1044])).toBe('+44 SR across the last 3 rated games');
    expect(trendText([1000, 980])).toBe('-20 SR across the last 2 rated games');
    expect(trendText([1000])).toBeNull();
  });
});
```

```tsx
// web/src/routes/event/draft/PickListDrawer.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { PlayerCardView } from '../../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { draftCards: vi.fn(), draftList: vi.fn(), saveDraftList: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const { PickListDrawer } = await import('./PickListDrawer');
const { ApiError } = await import('../../../api');

const card = (steamid: string, name: string, sr: number) => ({ steamid, name, sr } as PlayerCardView);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PickListDrawer', () => {
  it('reorders, removes, adds and saves the list in order', async () => {
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200), card('p2', 'Cy', 1350), card('p3', 'Di', 1100)], notes: {}, chemistry: null });
    mockEvents.draftList.mockResolvedValue({ list: ['p1', 'p2'] });
    mockEvents.saveDraftList.mockResolvedValue({ list: ['p2', 'p3'] });
    render(<PickListDrawer slug="night" onClose={() => {}} />);
    expect(await screen.findByText('1. Bob')).toBeTruthy();
    expect(screen.getByText(/used if captains pick live/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Cy up' }));
    expect(screen.getByText('1. Cy')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob' }));
    fireEvent.change(screen.getByLabelText('Add a player'), { target: { value: 'p3' } });
    expect(screen.getByText('2. Di')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    await waitFor(() => expect(mockEvents.saveDraftList).toHaveBeenCalledWith('night', ['p2', 'p3']));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the server sentence when saving is refused', async () => {
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200)], notes: {}, chemistry: null });
    mockEvents.draftList.mockResolvedValue({ list: [] });
    mockEvents.saveDraftList.mockRejectedValue(new ApiError(409, 'The draft is over, so pick lists no longer change.'));
    render(<PickListDrawer slug="night" onClose={() => {}} />);
    await screen.findByLabelText('Add a player'); // Save is disabled until the cards load
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The draft is over, so pick lists no longer change.');
  });
});
```

```tsx
// web/src/routes/EventDraft.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DraftRoomView, PlayerCardView } from '../api';

const { mockEvents, pop, hub } = vi.hoisted(() => ({
  mockEvents: { draftRoom: vi.fn(), draftPick: vi.fn(), draftHeartbeat: vi.fn(), draftCards: vi.fn(), draftList: vi.fn(), saveDraftList: vi.fn() },
  pop: vi.fn(),
  hub: { fn: null as null | (() => void), names: [] as string[] },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../popSound', () => ({ playPopSound: pop }));
vi.mock('../hooks/useHubEvent', () => ({ useHubEvent: (names: string[], fn: () => void) => { hub.names = names; hub.fn = fn; } }));
const { EventDraftPage } = await import('./EventDraft');
const { ApiError } = await import('../api');

const card = (steamid: string, name: string, sr: number): PlayerCardView => ({
  steamid, name, avatar: null, sr, trend: [sr - 30, sr], pugs: 12, form: ['W', 'L'],
  survivor: { siDamage: 210.5, commonKills: 31 }, infected: { damageAsSi: 180, dpsLanded: 1.5 },
  bestClass: { cls: 'hunter', damage: 4000 }, skills: [{ key: 'skeets', label: 'Skeets', total: 9 }],
});
const view = (over: Partial<DraftRoomView> = {}): DraftRoomView => ({
  eventId: 4, slug: 'night', eventName: 'Draft Night', status: 'running', teamsMadeAt: null,
  settings: { firstPick: 'lowest_sr', pickSeconds: 75 },
  serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 75_000).toISOString(), pausedLeftMs: null, totalPicks: 6,
  order: [{ steamid: 'c1', name: 'Ann' }, { steamid: 'c2', name: 'Eve' }],
  onClock: { pickNo: 1, round: 1, captain: 'c1', picker: 'c1' },
  picks: [], delegates: {},
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  pool: [card('p1', 'Bob', 1200), card('p2', 'Cy', 1350), card('p3', 'Di', 1100)],
  notes: null,
  me: { role: null, team: null, onClock: false, list: null, chemistry: null },
  lists: null, staff: false,
  ...over,
});
const session = { kind: 'anonymous' } as const;
const cardNames = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mockEvents.draftHeartbeat.mockResolvedValue({ ok: true });
  mockEvents.draftPick.mockResolvedValue({ pickNo: 1, done: false });
});

describe('EventDraftPage', () => {
  it('shows who is on the clock with a countdown, and the pool by SR with no Pick button for a viewer', async () => {
    mockEvents.draftRoom.mockResolvedValue(view());
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('Ann is on the clock')).toBeTruthy();
    expect(screen.getByLabelText('Time left').textContent).toMatch(/^1:1[45]$/);
    expect(screen.getByText('Pick 1 of 6 · Round 1')).toBeTruthy();
    expect(cardNames()).toEqual(['Cy', 'Bob', 'Di']);
    expect(screen.getAllByText('+30 SR across the last 2 rated games')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Pick / })).toBeNull();
    expect(hub.names).toEqual(['draft:4']);
    expect(mockEvents.draftHeartbeat).not.toHaveBeenCalled();
  });

  it('lets the captain on the clock pick, beats, and chimes once when the turn starts', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: { p1: { together: 4, wonTogether: 3, against: 2, wonAgainst: 1 } } },
      notes: { p1: 'prefer infected' },
    }));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('You are on the clock')).toBeTruthy();
    expect(pop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockEvents.draftHeartbeat).toHaveBeenCalledWith('night'));
    expect(screen.getByText('With you: 4 games, 3 won · Against you: 2, you won 1')).toBeTruthy();
    expect(screen.getByText('Note: prefer infected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick Bob' }));
    await waitFor(() => expect(mockEvents.draftPick).toHaveBeenCalledWith('night', 'p1', 1));
    hub.fn!();
    await waitFor(() => expect(mockEvents.draftRoom).toHaveBeenCalledTimes(3));
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence when a pick is refused', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ me: { role: 'captain', team: 'c1', onClock: true, list: [], chemistry: {} } }));
    mockEvents.draftPick.mockRejectedValue(new ApiError(409, 'That pick was already made. The room has moved on.'));
    render(<EventDraftPage slug="night" session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Cy' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That pick was already made. The room has moved on.');
  });

  it('reveals a pick it had not seen, but none on first load', async () => {
    const first = { pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Old', auto: false, at: '2026-10-08T10:00:00.000Z' };
    mockEvents.draftRoom.mockResolvedValue(view({ picks: [first] }));
    render(<EventDraftPage slug="night" session={session} />);
    await screen.findByText('Ann is on the clock');
    expect(screen.queryByRole('status')).toBeNull();
    mockEvents.draftRoom.mockResolvedValue(view({ picks: [first, { pickNo: 2, round: 1, captain: 'c2', steamid: 'p2', name: 'Cy', auto: true, at: '2026-10-08T10:01:00.000Z' }] }));
    hub.fn!();
    const reveal = await screen.findByRole('status');
    expect(reveal.textContent).toContain('Pick 2');
    expect(reveal.textContent).toContain('Cy');
    expect(reveal.textContent).toContain("to Eve's team (auto pick)");
  });

  it('fills the board and the pick log, marking auto picks', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({
      picks: [{ pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Gus', auto: true, at: '2026-10-08T10:00:00.000Z' }],
      teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [{ steamid: 'p9', name: 'Gus' }] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
      onClock: { pickNo: 2, round: 1, captain: 'c2', picker: 'c2' },
    }));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('#1 Ann took Gus')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy();
    expect(screen.getAllByText('Open')).toHaveLength(5);
  });

  it('filters the pool by name and sorts by name', async () => {
    mockEvents.draftRoom.mockResolvedValue(view());
    render(<EventDraftPage slug="night" session={session} />);
    await screen.findByText('Ann is on the clock');
    fireEvent.input(screen.getByLabelText('Find a player'), { target: { value: 'b' } });
    expect(cardNames()).toEqual(['Bob']);
    fireEvent.input(screen.getByLabelText('Find a player'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name' } });
    expect(cardNames()).toEqual(['Bob', 'Cy', 'Di']);
  });

  it('says lists are used if captains pick live while staff have not chosen it, and opens a captain\'s list', async () => {
    mockEvents.draftRoom.mockResolvedValue(view({ status: 'none', onClock: null, deadlineAt: null, me: { role: 'captain', team: 'c1', onClock: false, list: [], chemistry: {} } }));
    mockEvents.draftCards.mockResolvedValue({ cards: [card('p1', 'Bob', 1200)], notes: {}, chemistry: {} });
    mockEvents.draftList.mockResolvedValue({ list: [] });
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText(/used if captains pick live/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'My pick list' }));
    expect(await screen.findByRole('heading', { name: 'My pick list' })).toBeTruthy();
  });

  it('says so when there is no such draft, or the cut is not published', async () => {
    mockEvents.draftRoom.mockRejectedValue(new ApiError(404, 'GET x'));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('No such draft.')).toBeTruthy();
    cleanup();
    mockEvents.draftRoom.mockRejectedValue(new ApiError(409, 'GET x'));
    render(<EventDraftPage slug="night" session={session} />);
    expect(await screen.findByText('The draft room opens once the cut is published.')).toBeTruthy();
  });
});
```

In `web/src/routes/Event.test.tsx`, add after `a published cut shows Captains, Pool and Bench as names only`:

```tsx
  it('links the draft room once the cut is published, and not before', async () => {
    mockEvents.get.mockResolvedValue(view({
      entryKind: 'draft', status: 'registration',
      draft: { signupsCloseAt: inMinutes(-60), draftAt: inMinutes(120), signups: 5, names: [], cut: { captains: ['Alice'], pool: ['Bob', 'Cy', 'Di'], bench: ['Ed'] } },
    }));
    render(<EventPage slug="riverside-cup" session={session} />);
    expect((await screen.findByRole('link', { name: 'Draft room' })).getAttribute('href')).toBe('/event/riverside-cup/draft');
    cleanup();
    mockEvents.get.mockResolvedValue(view({ entryKind: 'draft', status: 'registration', draft: { signupsCloseAt: inMinutes(60), draftAt: inMinutes(120), signups: 1, names: ['Ann'], cut: null } }));
    render(<EventPage slug="riverside-cup" session={session} />);
    await screen.findByText('1 signed up');
    expect(screen.queryByRole('link', { name: 'Draft room' })).toBeNull();
  });
```

In `web/src/appRoutes.test.tsx`, add to the describe:

```tsx
  it('mounts the draft room page, not the 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    open('/event/riverside-cup/draft');
    expect(await screen.findByText('No such draft.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project web web/src/hooks/useLiveState.test.ts web/src/routes/event/draft web/src/routes/EventDraft.test.tsx web/src/routes/Event.test.tsx web/src/appRoutes.test.tsx`
Expected: FAIL: the new modules do not exist, `wakesLiveState` is not exported, and there is no Draft room link.

- [ ] **Step 3: Implement the API types and calls**

`web/src/api.ts`, after `AdminDraftTeamsView`:

```ts
/** Drafts plan D2b1: mirrors src/events/draftCards.ts PlayerCard. Public numbers only. */
export interface PlayerCardView {
  steamid: string; name: string; avatar: string | null; sr: number; trend: number[]; pugs: number; form: ('W' | 'L' | 'D')[];
  survivor: { siDamage: number; commonKills: number }; infected: { damageAsSi: number; dpsLanded: number };
  bestClass: { cls: 'hunter' | 'smoker' | 'boomer' | 'tank'; damage: number } | null;
  skills: { key: string; label: string; total: number }[];
}
/** Mirrors src/chemistry.ts PairChemistry, from the viewing captain's side. */
export interface PairChemistryView { together: number; wonTogether: number; against: number; wonAgainst: number }
export type DraftFirstPick = 'lowest_sr' | 'highest_sr' | 'random';
export interface DraftPickView { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
/** Mirrors src/events/draftRoomView.ts DraftRoomView: notes, lists and
 *  chemistry are null unless this viewer may see them. */
export interface DraftRoomView {
  eventId: number; slug: string; eventName: string;
  status: 'none' | 'ready' | 'running' | 'paused' | 'done'; teamsMadeAt: string | null;
  settings: { firstPick: DraftFirstPick; pickSeconds: number };
  serverNow: string; deadlineAt: string | null; pausedLeftMs: number | null; totalPicks: number;
  order: { steamid: string; name: string }[];
  onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
  picks: DraftPickView[];
  delegates: Record<string, string>;
  teams: { captain: { steamid: string; name: string }; players: { steamid: string; name: string }[] }[];
  pool: PlayerCardView[];
  notes: Record<string, string> | null;
  me: { role: 'captain' | 'delegate' | null; team: string | null; onClock: boolean; list: string[] | null; chemistry: Record<string, PairChemistryView> | null };
  lists: Record<string, string[]> | null;
  staff: boolean;
}
export interface DraftCardsView { cards: PlayerCardView[]; notes: Record<string, string>; chemistry: Record<string, PairChemistryView> | null }
```

In `eventsApi`, after `answerCaptainOffer`:

```ts
  draftRoom: (slug: string, signal?: AbortSignal) => get<DraftRoomView>(`/api/events/${enc(slug)}/draft`, signal),
  draftPick: (slug: string, player: string, pickNo: number) => post<{ pickNo: number; done: boolean }>(`/api/events/${enc(slug)}/draft/pick`, { player, pickNo }),
  draftHeartbeat: (slug: string) => post<{ ok: true }>(`/api/events/${enc(slug)}/draft/heartbeat`),
  draftCards: (slug: string, signal?: AbortSignal) => get<DraftCardsView>(`/api/events/${enc(slug)}/draft/cards`, signal),
  draftList: (slug: string, signal?: AbortSignal) => get<{ list: string[] }>(`/api/events/${enc(slug)}/draft/list`, signal),
  saveDraftList: (slug: string, list: string[]) => put<{ list: string[] }>(`/api/events/${enc(slug)}/draft/list`, { list }),
```

In `adminApi`, after `draftPublishTeams`:

```ts
  draftRoom: (id: number, signal?: AbortSignal) => get<DraftRoomView>(`/api/admin/events/${id}/draft/room`, signal),
  draftRoomAct: (id: number, action: 'start' | 'pause' | 'resume' | 'undo' | 'reset') => post(`/api/admin/events/${id}/draft/room/${action}`),
  draftRoomDelegate: (id: number, captain: string, on: boolean) => post(`/api/admin/events/${id}/draft/room/delegate`, { captain, on }),
  draftRoomSettings: (id: number, firstPick: DraftFirstPick, pickSeconds: number) => post(`/api/admin/events/${id}/draft/room/settings`, { firstPick, pickSeconds }),
```

- [ ] **Step 4: Implement the socket filter**

`web/src/hooks/useLiveState.ts`: export, above `useLiveState`:

```ts
/** Whether a hub event should refetch the queue state. A draft room's change
 *  (draft:<eventId>, drafts plan D2b1) can come every few seconds and only
 *  the room page and the desk controls want it; they listen with
 *  useHubEvent. */
export function wakesLiveState(name: string | null): boolean {
  return name === null || !name.startsWith('draft:');
}
```

and in `ws.onmessage`, replace the body with:

```ts
        const name = eventName(m.data);
        // 'tickets' is for ticket pages, goes only to staff, and says nothing
        // about the queue: pass it on and leave the live state alone.
        if (name === 'tickets') {
          window.dispatchEvent(new Event(TICKETS_EVENT));
          return;
        }
        if (!wakesLiveState(name)) return;
        refreshRef.current();
```

- [ ] **Step 5: Implement the page helpers, the card and the drawer**

```ts
// web/src/routes/event/draft/draftText.ts
import type { DraftPickView, PlayerCardView } from '../../../api';

/** The room's status lines (drafts plan D2b1 Ruling 1 and 22). */
export const STATUS_TEXT = {
  none: 'Staff have not chosen live picking for this draft. Captains can still read the player cards and build a pick list, used if captains pick live.',
  ready: 'The draft starts when staff press Start. Captains: build your pick list now. It is used if you are away when your turn comes or your clock runs out.',
  paused: 'Paused by staff.',
  done: 'The draft is over. Staff publish the teams next.',
} as const;

export const CLASS_NAME = { hunter: 'Hunter', smoker: 'Smoker', boomer: 'Boomer', tank: 'Tank' } as const;

/** A pick's identity for the reveal: the same slot picked again after an
 *  undo is a new pick. */
export const pickKey = (p: DraftPickView): string => `${p.pickNo}:${p.at}:${p.steamid}`;

/** The picks this page has not shown yet. The first load (seen null) marks
 *  everything seen and reveals nothing. */
export function freshPicks(seen: ReadonlySet<string> | null, picks: DraftPickView[]): { seen: Set<string>; fresh: DraftPickView[] } {
  const next = new Set(picks.map(pickKey));
  return { seen: next, fresh: seen === null ? [] : picks.filter((p) => !seen.has(pickKey(p))) };
}

export type PoolSort = 'sr' | 'name';
export function sortedPool(cards: PlayerCardView[], filter: string, sort: PoolSort): PlayerCardView[] {
  const f = filter.trim().toLowerCase();
  const byName = (a: PlayerCardView, b: PlayerCardView) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return cards.filter((c) => f === '' || c.name.toLowerCase().includes(f))
    .sort((a, b) => (sort === 'sr' ? b.sr - a.sr || byName(a, b) : byName(a, b)));
}

/** How far SR moved across the card's trend; null with under two points. */
export function trendText(trend: number[]): string | null {
  if (trend.length < 2) return null;
  const d = trend[trend.length - 1]! - trend[0]!;
  return `${d >= 0 ? '+' : ''}${d} SR across the last ${trend.length} rated games`;
}
```

```tsx
// web/src/routes/event/draft/DraftCard.tsx
import type { ComponentChildren } from 'preact';
import type { PairChemistryView, PlayerCardView } from '../../../api';
import { CLASS_NAME, trendText } from './draftText';

/** One pool player's card (drafts plan D2b1 Ruling 3). note and chemistry
 *  arrive only for the viewers the server allows them. */
export function DraftCard({ card, note, chemistry, action }: {
  card: PlayerCardView; note?: string | null; chemistry?: PairChemistryView | null; action?: ComponentChildren;
}) {
  const trend = trendText(card.trend);
  return (
    <article class="draftcard" aria-label={card.name}>
      <header class="draftcard__head">
        <h4 class="draftcard__name">{card.name}</h4>
        <span class="draftcard__sr">{`SR ${card.sr}`}</span>
      </header>
      {trend && <p class="draftcard__line muted">{trend}</p>}
      <p class="draftcard__line">{`Survivor: ${card.survivor.siDamage} SI damage, ${card.survivor.commonKills} commons a game`}</p>
      <p class="draftcard__line">{`Infected: ${card.infected.damageAsSi} damage, ${card.infected.dpsLanded} DPs a game`}</p>
      {card.bestClass && <p class="draftcard__line">{`Best class: ${CLASS_NAME[card.bestClass.cls]}`}</p>}
      {card.skills.length > 0 && <p class="draftcard__line muted">{card.skills.slice(0, 4).map((s) => `${s.label} ${s.total}`).join(' · ')}</p>}
      <p class="draftcard__form" aria-label="Recent form">
        {card.pugs === 0 ? 'No PUGs yet' : card.form.map((r, i) => <span key={i} class={`chip draftcard__res draftcard__res--${r}`}>{r}</span>)}
      </p>
      {chemistry && <p class="draftcard__line">{`With you: ${chemistry.together} games, ${chemistry.wonTogether} won · Against you: ${chemistry.against}, you won ${chemistry.wonAgainst}`}</p>}
      {note && <p class="draftcard__note">{`Note: ${note}`}</p>}
      {action}
    </article>
  );
}
```

```tsx
// web/src/routes/event/draft/PickListDrawer.tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, eventsApi, type DraftCardsView } from '../../../api';

/** The captain's (or delegate's) ordered pick list (drafts plan D2b1
 *  Rulings 1, 2, 13): Up, Down, Remove, Add and an explicit Save, so one
 *  reorder is not one server write. */
export function PickListDrawer({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [cards, setCards] = useState<DraftCardsView | null>(null);
  const [list, setList] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([eventsApi.draftCards(slug), eventsApi.draftList(slug)]).then(
      ([c, l]) => { setCards(c); setList(l.list); },
      () => setProblem('Could not load your pick list.'),
    );
  }, [slug]);

  const nameOf = (s: string) => cards?.cards.find((c) => c.steamid === s)?.name ?? s;
  const edit = (fn: (l: string[]) => string[]) => { setSaved(null); setList(fn); };
  const move = (i: number, d: -1 | 1) => edit((l) => {
    const j = i + d;
    if (j < 0 || j >= l.length) return l;
    const n = [...l];
    [n[i], n[j]] = [n[j]!, n[i]!];
    return n;
  });
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await eventsApi.saveDraftList(slug, list);
      setList(r.list);
      setSaved('Saved.');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const rest = (cards?.cards ?? []).filter((c) => !list.includes(c.steamid)).sort((a, b) => b.sr - a.sr);

  return (
    <aside class="picklist" aria-label="My pick list">
      <header class="picklist__head">
        <h3>My pick list</h3>
        <button class="btn btn--ghost btn--sm" type="button" onClick={onClose}>Close</button>
      </header>
      <p class="muted">Used if captains pick live: when your turn comes and you are away, or your clock runs out, the site takes the highest player on this list who is still free. With no list, it takes the highest SR.</p>
      {problem && <p class="error" role="alert">{problem}</p>}
      {list.length === 0 ? <p class="empty">Your list is empty.</p> : (
        <ol class="picklist__rows">
          {list.map((s, i) => (
            <li key={s} class="picklist__row">
              <span class="picklist__name">{`${i + 1}. ${nameOf(s)}`}</span>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${nameOf(s)} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${nameOf(s)} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>Down</button>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Remove ${nameOf(s)}`} onClick={() => edit((l) => l.filter((x) => x !== s))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 && (
        <label class="picklist__add">
          Add a player
          <select value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) edit((l) => (l.includes(v) ? l : [...l, v])); }}>
            <option value="">Choose...</option>
            {rest.map((c) => <option key={c.steamid} value={c.steamid}>{`${c.name} (SR ${c.sr})`}</option>)}
          </select>
        </label>
      )}
      <div class="inlinerow">
        <button class="btn" type="button" disabled={busy || cards === null} onClick={() => void save()}>Save list</button>
        {saved && <span class="muted">{saved}</span>}
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Implement the page and the route**

```tsx
// web/src/routes/EventDraft.tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, eventsApi, type DraftPickView, type DraftRoomView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { useHubEvent } from '../hooks/useHubEvent';
import type { Session } from '../hooks/useLiveState';
import { playPopSound } from '../popSound';
import { clockText } from './event/room/roomText';
import { DraftCard } from './event/draft/DraftCard';
import { PickListDrawer } from './event/draft/PickListDrawer';
import { STATUS_TEXT, freshPicks, pickKey, sortedPool, type PoolSort } from './event/draft/draftText';

const HEARTBEAT_MS = 10_000;
/** A safety net under the hub push (a dropped socket, a status change made on the desk). */
const POLL_MS = 15_000;
const REVEAL_MS = 4_000;

/** The live draft room (drafts plan D2b1 Ruling 13). Everyone can watch; a
 *  captain or delegate also heartbeats, picks on their turn and edits their
 *  list. The server tailors what each viewer gets, so nothing private is
 *  hidden here: it was never sent. */
export function EventDraftPage({ slug, session: _session }: { slug: string; session: Session }) {
  const [v, setV] = useState<DraftRoomView | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<PoolSort>('sr');
  const [reveal, setReveal] = useState<DraftPickView | null>(null);
  const [drawer, setDrawer] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const wasOnClock = useRef(false);

  const load = () => eventsApi.draftRoom(slug).then((x) => {
    setV(x);
    setOffset(Date.parse(x.serverNow) - Date.now());
    const r = freshPicks(seen.current, x.picks);
    seen.current = r.seen;
    const latest = r.fresh.at(-1);
    if (latest) setReveal(latest);
    if (x.me.onClock && !wasOnClock.current) playPopSound();
    wasOnClock.current = x.me.onClock;
  }, (e) => {
    setMissing(e instanceof ApiError && e.status === 404 ? 'No such draft.'
      : e instanceof ApiError && e.status === 409 ? 'The draft room opens once the cut is published.' : 'Could not load the draft room.');
  });

  useEffect(() => { void load(); }, [slug]);
  useHubEvent([v ? `draft:${v.eventId}` : 'draft:none'], () => { void load(); });
  useEffect(() => {
    if (!v || v.status === 'done') return undefined;
    const poll = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.status]);
  const deadline = v?.deadlineAt ?? null;
  useEffect(() => {
    if (!deadline) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [deadline]);
  const role = v?.me.role ?? null;
  useEffect(() => {
    if (!role) return undefined;
    const beat = () => { void eventsApi.draftHeartbeat(slug).catch(() => {}); };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [slug, role]);
  useEffect(() => {
    if (!reveal) return undefined;
    const t = setTimeout(() => setReveal(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (missing) return <div class="page"><PageHeader title="Draft room" /><Empty>{missing}</Empty></div>;
  if (!v) return <div class="page"><PageHeader title="Draft room" /></div>;

  const nameOf = (s: string) => v.order.find((o) => o.steamid === s)?.name ?? v.picks.find((p) => p.steamid === s)?.name
    ?? v.pool.find((c) => c.steamid === s)?.name ?? s;
  const left = deadline ? Date.parse(deadline) - (now + offset) : 0;
  const pool = sortedPool(v.pool, filter, sort);
  const onClock = v.status === 'running' ? v.onClock : null;
  const canPick = v.me.onClock && onClock !== null;

  return (
    <div class="page draftroom">
      <PageHeader eyebrow="Draft room" title={v.eventName}>
        <p class="room__sub"><a href={`/event/${v.slug}`}>Back to the event</a></p>
      </PageHeader>
      {problem && <p class="error" role="alert">{problem}</p>}
      {reveal && (
        <div class="draftreveal" role="status">
          <span class="draftreveal__pick">{`Pick ${reveal.pickNo}`}</span>
          <strong class="draftreveal__name">{reveal.name}</strong>
          <span>{`to ${nameOf(reveal.captain)}'s team${reveal.auto ? ' (auto pick)' : ''}`}</span>
        </div>
      )}
      <Panel class="draftclock">
        {onClock ? (
          <>
            <p class="draftclock__who">{v.me.onClock ? 'You are on the clock' : `${nameOf(onClock.captain)} is on the clock`}</p>
            {onClock.picker !== onClock.captain && <p class="muted">{`${nameOf(onClock.picker)} picks for the team`}</p>}
            <p class="draftclock__time" aria-label="Time left">{clockText(left)}</p>
            <p class="muted">{`Pick ${onClock.pickNo} of ${v.totalPicks} · Round ${onClock.round}`}</p>
          </>
        ) : v.status === 'paused' ? (
          <>
            <p class="draftclock__who">{STATUS_TEXT.paused}</p>
            {v.pausedLeftMs !== null && <p class="muted">{`${clockText(v.pausedLeftMs)} left on the clock`}</p>}
          </>
        ) : (
          <p>{STATUS_TEXT[v.status === 'none' || v.status === 'ready' ? v.status : 'done']}</p>
        )}
        {v.me.role !== null && <button class="btn btn--ghost" type="button" onClick={() => setDrawer(true)}>My pick list</button>}
      </Panel>
      <Panel>
        <h3>Teams</h3>
        <div class="draftboard">
          {v.teams.map((t) => (
            <div key={t.captain.steamid} class={`draftboard__team${onClock?.captain === t.captain.steamid ? ' is-up' : ''}`}>
              <h4>{t.captain.name}</h4>
              <ol class="draftboard__slots">
                {[0, 1, 2].map((i) => <li key={i}>{t.players[i]?.name ?? <span class="muted">Open</span>}</li>)}
              </ol>
            </div>
          ))}
        </div>
      </Panel>
      {v.pool.length > 0 && (
        <Panel>
          <h3>Pool</h3>
          <div class="inlinerow draftpool__tools">
            <input type="search" aria-label="Find a player" placeholder="Find a player" value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
            <select aria-label="Sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as PoolSort)}>
              <option value="sr">SR, high to low</option>
              <option value="name">Name</option>
            </select>
          </div>
          {pool.length === 0 ? <Empty>No player matches that name.</Empty> : (
            <div class="draftpool">
              {pool.map((c) => (
                <DraftCard key={c.steamid} card={c} note={v.notes?.[c.steamid] ?? null} chemistry={v.me.chemistry?.[c.steamid] ?? null}
                  action={canPick ? (
                    <button class="btn" type="button" disabled={busy} onClick={() => void run(() => eventsApi.draftPick(slug, c.steamid, onClock!.pickNo))}>{`Pick ${c.name}`}</button>
                  ) : undefined} />
              ))}
            </div>
          )}
        </Panel>
      )}
      {v.picks.length > 0 && (
        <Panel>
          <h3>Pick log</h3>
          <ol class="draftlog" reversed>
            {[...v.picks].reverse().map((p) => (
              <li key={pickKey(p)}>
                <span>{`#${p.pickNo} ${nameOf(p.captain)} took ${p.name}`}</span>
                {p.auto && <span class="chip">Auto</span>}
              </li>
            ))}
          </ol>
        </Panel>
      )}
      {drawer && <PickListDrawer slug={slug} onClose={() => setDrawer(false)} />}
    </div>
  );
}

export default EventDraftPage;
```

`web/src/AppRoutes.tsx`: after `const EventMatchPage = lazy(...)` add

```tsx
// The live draft room (drafts plan D2b1): its own chunk, like the match room.
const EventDraftPage = lazy(() => import('./routes/EventDraft'));
```

and before the match route: `<Route path="/event/:slug/draft" component={EventDraftPage} session={session} />`.

`web/src/routes/Event.tsx`, in `DraftSection`, at the start of the `cut ? (<>...</>)` fragment, before the three lists:

```tsx
          <p class="inlinerow">
            <a class="btn btn--ghost" href={`/event/${ev.slug}/draft`}>Draft room</a>
            <span class="muted">Player cards, captains' pick lists and the live draft.</span>
          </p>
```

`web/src/styles/app.css`, after the `.chip--bad` rule (existing tokens only):

```css
/* Drafts plan D2b1: the live draft room. */
.draftroom { display: flex; flex-direction: column; gap: var(--sp-4); }
.draftclock { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
.draftclock p { margin: 0; }
.draftclock__who { font-family: var(--font-label); font-size: var(--fs-h3); color: var(--text-bright); overflow-wrap: anywhere; }
.draftclock__time { font-family: var(--font-display); font-size: clamp(3rem, 14vw, var(--fs-hero)); line-height: 1; color: var(--accent); font-variant-numeric: tabular-nums; }
.draftboard { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--sp-3); }
.draftboard__team { padding: var(--sp-3); border: 1px solid var(--border); background: var(--surface-2); min-width: 0; overflow-wrap: anywhere; }
.draftboard__team.is-up { border-color: var(--accent); }
.draftboard__team h4 { margin: 0 0 var(--sp-2); }
.draftboard__slots { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); }
.draftpool__tools { margin-bottom: var(--sp-3); }
.draftpool__tools input { flex: 1 1 12rem; min-width: 0; }
.draftpool { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--sp-3); }
.draftcard { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3); border: 1px solid var(--border); background: var(--surface-2); min-width: 0; overflow-wrap: anywhere; }
.draftcard__head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); }
.draftcard__name { margin: 0; min-width: 0; }
.draftcard__sr { color: var(--rating); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.draftcard__line, .draftcard__note, .draftcard__form { margin: 0; font-size: var(--fs-dense); }
.draftcard__note { color: var(--text-bright); }
.draftcard__form { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.draftcard__res--W { border-color: var(--win); color: var(--win); }
.draftcard__res--L { border-color: var(--loss); color: var(--loss); }
.draftcard__res--D { color: var(--draw); }
.draftlog { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-dense); }
.draftlog li { overflow-wrap: anywhere; }
.draftlog .chip { margin-left: var(--sp-2); }
.draftreveal {
  position: fixed; left: 50%; top: var(--sp-6); transform: translateX(-50%); z-index: 20;
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); padding: var(--sp-4) var(--sp-5);
  max-width: calc(100vw - 2 * var(--sp-4)); box-sizing: border-box; text-align: center; overflow-wrap: anywhere;
  background: var(--surface); border: 1px solid var(--accent); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  animation: draftreveal 0.35s ease-out;
}
.draftreveal__pick { font-family: var(--font-label); font-size: var(--fs-label); color: var(--text-muted); text-transform: uppercase; }
.draftreveal__name { font-family: var(--font-display); font-size: var(--fs-h2); color: var(--text-bright); }
@keyframes draftreveal {
  from { opacity: 0; transform: translate(-50%, -12px) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
@media (prefers-reduced-motion: reduce) { .draftreveal { animation: none; } }
.picklist {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); box-sizing: border-box; z-index: 30; overflow-y: auto;
  display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4);
  background: var(--surface); border-left: 1px solid var(--border-strong);
}
.picklist__head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); }
.picklist__head h3, .picklist p { margin: 0; }
.picklist__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.picklist__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
.picklist__name { flex: 1 1 8rem; min-width: 0; overflow-wrap: anywhere; }
.picklist__add { display: flex; flex-direction: column; gap: var(--sp-1); }
```

- [ ] **Step 7: Run them and see them pass**

Run: `npx vitest run --project web web/src/hooks/useLiveState.test.ts web/src/routes/event/draft web/src/routes/EventDraft.test.tsx web/src/routes/Event.test.tsx web/src/appRoutes.test.tsx web/src/styles/app.css.test.ts`
Expected: PASS. Then `npm run typecheck`: no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/hooks/useLiveState.ts web/src/hooks/useLiveState.test.ts web/src/routes/event/draft web/src/routes/EventDraft.tsx web/src/routes/EventDraft.test.tsx web/src/AppRoutes.tsx web/src/appRoutes.test.tsx web/src/routes/Event.tsx web/src/routes/Event.test.tsx web/src/styles/app.css
git commit -m "The draft room page shows the board, a big pick clock, the pool as player cards with a Pick button for the captain on the clock, a reveal for every new pick and the pick log, captains edit their pick list in a drawer, and the event page links the room once the cut is published (plan D2b1)"
```

### Task 8: Room controls on the Events desk (web)

**Files:**
- Create: `web/src/routes/admin/events/DraftRoomControls.tsx`
- Modify: `web/src/routes/admin/events/DraftTeamsPanel.tsx`, `web/src/routes/admin/events/EventEditor.tsx` (pass `slug`), `web/src/styles/app.css`
- Test: `web/src/routes/admin/events/DraftRoomControls.test.tsx` (new), `web/src/routes/admin/events/DraftTeamsPanel.test.tsx` (modify)

**Interfaces:**
- Consumes: `adminApi.draftRoom`, `draftRoomAct`, `draftRoomDelegate`, `draftRoomSettings`, `draftMode`, `DraftRoomView`, `DraftFirstPick` (Task 7), `useFetch`, `useAction`, `useHubEvent`.
- Produces: `DraftRoomControls({ eventId, slug, canEdit, onChange }: { eventId: number; slug: string; canEdit: boolean; onChange?: () => void })` and `statusLine(v: DraftRoomView): string`; `DraftTeamsPanel` gains an optional `slug?: string` prop.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/routes/admin/events/DraftRoomControls.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { DraftRoomView } from '../../../api';

const { mockAdmin, confirmMock } = vi.hoisted(() => ({
  mockAdmin: { draftRoom: vi.fn(), draftRoomAct: vi.fn(), draftRoomDelegate: vi.fn(), draftRoomSettings: vi.fn(), draftMode: vi.fn() },
  confirmMock: vi.fn(async () => true),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: confirmMock }));
vi.mock('../../../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));
const { DraftRoomControls } = await import('./DraftRoomControls');

const room = (over: Partial<DraftRoomView> = {}): DraftRoomView => ({
  eventId: 9, slug: 'night', eventName: 'Draft Night', status: 'ready', teamsMadeAt: null,
  settings: { firstPick: 'lowest_sr', pickSeconds: 75 }, serverNow: new Date().toISOString(), deadlineAt: null, pausedLeftMs: null, totalPicks: 6,
  order: [{ steamid: 'c1', name: 'Ann' }, { steamid: 'c2', name: 'Eve' }], onClock: null, picks: [], delegates: {},
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  pool: [], notes: null, me: { role: null, team: null, onClock: false, list: null, chemistry: null }, lists: { c1: [], c2: [] }, staff: true,
  ...over,
});
const running = (over: Partial<DraftRoomView> = {}) => room({
  status: 'running', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  onClock: { pickNo: 2, round: 1, captain: 'c2', picker: 'c2' },
  picks: [{ pickNo: 1, round: 1, captain: 'c1', steamid: 'p9', name: 'Gus', auto: false, at: '2026-10-08T10:00:00.000Z' }],
  teams: [{ captain: { steamid: 'c1', name: 'Ann' }, players: [{ steamid: 'p9', name: 'Gus' }] }, { captain: { steamid: 'c2', name: 'Eve' }, players: [] }],
  ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DraftRoomControls', () => {
  it('before Start: links the room, saves settings, starts with a confirm and can change the method', async () => {
    mockAdmin.draftRoom.mockResolvedValue(room());
    for (const fn of [mockAdmin.draftRoomSettings, mockAdmin.draftRoomAct, mockAdmin.draftMode]) fn.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect((await screen.findByRole('link', { name: 'Open the draft room' })).getAttribute('href')).toBe('/event/night/draft');
    expect(screen.getByText('Ready: captains are building their pick lists.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('First pick'), { target: { value: 'random' } });
    fireEvent.input(screen.getByLabelText('Pick clock (seconds)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mockAdmin.draftRoomSettings).toHaveBeenCalledWith(9, 'random', 60));
    fireEvent.click(screen.getByRole('button', { name: 'Start draft' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'start'));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Start the live draft?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change method' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, null));
  });

  it('while running: says who is up, pauses, undoes with a confirm and hands a team to its first pick', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running());
    mockAdmin.draftRoomAct.mockResolvedValue({});
    mockAdmin.draftRoomDelegate.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('Pick 2 of 6: Eve is on the clock.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo last pick' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'undo'));
    expect(confirmMock).toHaveBeenCalledWith('Undo the last pick? The player goes back to the pool and that pick gets a full clock.');
    expect(screen.queryByRole('button', { name: /Hand Eve's picking/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Hand Ann's picking to Gus" }));
    await waitFor(() => expect(mockAdmin.draftRoomDelegate).toHaveBeenCalledWith(9, 'c1', true));
  });

  it('gives picking back, resumes a paused room and resets with a confirm', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running({ status: 'paused', onClock: null, deadlineAt: null, pausedLeftMs: 30_000, delegates: { c1: 'p9' } }));
    mockAdmin.draftRoomAct.mockResolvedValue({});
    mockAdmin.draftRoomDelegate.mockResolvedValue({});
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('Paused at pick 2 of 6.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give picking back to Ann' }));
    await waitFor(() => expect(mockAdmin.draftRoomDelegate).toHaveBeenCalledWith(9, 'c1', false));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'resume'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset room' }));
    await waitFor(() => expect(mockAdmin.draftRoomAct).toHaveBeenCalledWith(9, 'reset'));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reset the draft room?' }));
  });

  it('when done: says to publish below and still offers undo', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running({ status: 'done', onClock: null, deadlineAt: null }));
    render(<DraftRoomControls eventId={9} slug="night" canEdit />);
    expect(await screen.findByText('The draft is over. Check the teams below and publish them.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo last pick' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('is read only for a mod', async () => {
    mockAdmin.draftRoom.mockResolvedValue(running());
    render(<DraftRoomControls eventId={9} slug="night" canEdit={false} />);
    expect(await screen.findByRole('link', { name: 'Open the draft room' })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
```

In `web/src/routes/admin/events/DraftTeamsPanel.test.tsx`:
1. Extend the hoisted `mockAdmin` with `draftRoom: vi.fn(), draftRoomAct: vi.fn(), draftRoomDelegate: vi.fn(), draftRoomSettings: vi.fn()`, and add `vi.mock('../../../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));` next to the Confirm mock.
2. Replace the test `offers the two methods before one is chosen, the live one disabled` with:

```tsx
  it('offers the two methods before one is chosen, and Let captains pick chooses the live room', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue({ mode: null, teamsMadeAt: null, teams: null, fairness: null });
    mockAdmin.draftMode.mockResolvedValue({});
    render(<DraftTeamsPanel eventId={9} slug="night" status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByRole('heading', { name: 'Make teams' })).toBeTruthy();
    expect(screen.queryByText('Coming soon: the live draft room')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Let captains pick' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, 'live'));
    fireEvent.click(screen.getByRole('button', { name: 'Auto-balance by SR' }));
    await waitFor(() => expect(mockAdmin.draftMode).toHaveBeenCalledWith(9, 'auto'));
  });

  it('in live mode shows the room controls, and the drafted teams with no swaps once the room is done', async () => {
    mockAdmin.draftTeamsView.mockResolvedValue(made({ mode: 'live' }));
    mockAdmin.draftRoom.mockResolvedValue({
      eventId: 9, slug: 'night', eventName: 'Draft Night', status: 'done', teamsMadeAt: null, settings: { firstPick: 'lowest_sr', pickSeconds: 75 },
      serverNow: new Date().toISOString(), deadlineAt: null, pausedLeftMs: null, totalPicks: 6, order: [], onClock: null, picks: [], delegates: {},
      teams: [], pool: [], notes: null, me: { role: null, team: null, onClock: false, list: null, chemistry: null }, lists: {}, staff: true,
    });
    render(<DraftTeamsPanel eventId={9} slug="night" status="registration" startsAt={SOON} canEdit />);
    expect(await screen.findByText('The draft is over. Check the teams below and publish them.')).toBeTruthy();
    expect(screen.queryByLabelText('Swap Bob with')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebalance' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish teams' })).toBeTruthy();
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project web web/src/routes/admin/events/DraftRoomControls.test.tsx web/src/routes/admin/events/DraftTeamsPanel.test.tsx`
Expected: FAIL: `DraftRoomControls` does not exist, and "Let captains pick" is disabled.

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/admin/events/DraftRoomControls.tsx
import { useState } from 'preact/hooks';
import { adminApi, type DraftFirstPick, type DraftRoomView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { useHubEvent } from '../../../hooks/useHubEvent';
import { useAction } from '../useAction';

const FIRST_PICK_TEXT: Record<DraftFirstPick, string> = {
  lowest_sr: 'Lowest SR captain first', highest_sr: 'Highest SR captain first', random: 'Random order',
};

/** One line on where the room is. */
export function statusLine(v: DraftRoomView): string {
  if (v.status === 'ready') return 'Ready: captains are building their pick lists.';
  if (v.status === 'paused') return `Paused at pick ${v.picks.length + 1} of ${v.totalPicks}.`;
  if (v.status === 'done') return 'The draft is over. Check the teams below and publish them.';
  if (v.status === 'running' && v.onClock) {
    return `Pick ${v.onClock.pickNo} of ${v.totalPicks}: ${v.order.find((o) => o.steamid === v.onClock!.captain)?.name ?? ''} is on the clock.`;
  }
  return '';
}

/** The live draft room on the desk (drafts plan D2b1 Rulings 5, 6, 13):
 *  settings and Start before the draft, then pause, resume, undo, hand-over
 *  and reset. Admins act (canEdit); a mod reads. Refreshes on draft:<id>. */
export function DraftRoomControls({ eventId, slug, canEdit, onChange }: { eventId: number; slug: string; canEdit: boolean; onChange?: () => void }) {
  const { data: v, error: loadError, reload } = useFetch((s) => adminApi.draftRoom(eventId, s), [eventId]);
  useHubEvent([`draft:${eventId}`], reload);
  const { busy, error, run } = useAction(() => { reload(); onChange?.(); });
  const [firstPick, setFirstPick] = useState<DraftFirstPick | null>(null);
  const [secs, setSecs] = useState<string | null>(null);
  if (loadError) return <p class="error">Could not load the draft room.</p>;
  if (!v) return null;
  const fp = firstPick ?? v.settings.firstPick;
  const sec = secs ?? String(v.settings.pickSeconds);
  const act = (a: 'start' | 'pause' | 'resume' | 'undo' | 'reset', ask?: Parameters<typeof run>[1]) => void run(() => adminApi.draftRoomAct(eventId, a), ask);
  const started = v.status === 'running' || v.status === 'paused' || v.status === 'done';

  return (
    <div class="draftcontrols">
      <p><a href={`/event/${slug}/draft`}>Open the draft room</a></p>
      {error && <p class="error" role="alert">{error}</p>}
      <p>{statusLine(v)}</p>
      {v.status === 'ready' && canEdit && (
        <>
          <div class="inlinerow">
            <label>
              First pick{' '}
              <select value={fp} onChange={(e) => setFirstPick((e.target as HTMLSelectElement).value as DraftFirstPick)}>
                {(Object.keys(FIRST_PICK_TEXT) as DraftFirstPick[]).map((k) => <option key={k} value={k}>{FIRST_PICK_TEXT[k]}</option>)}
              </select>
            </label>
            <label>
              Pick clock (seconds){' '}
              <input type="number" min={30} max={300} value={sec} onInput={(e) => setSecs((e.target as HTMLInputElement).value)} />
            </label>
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.draftRoomSettings(eventId, fp, Number(sec)))}>Save settings</button>
          </div>
          <div class="inlinerow">
            <button class="btn" disabled={busy} onClick={() => act('start', {
              title: 'Start the live draft?',
              body: 'Every captain gets a DM with the room link and the first clock starts now. A captain who is not in the room is picked for after 5 seconds.',
            })}>Start draft</button>
            <button class="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => void run(() => adminApi.draftMode(eventId, null), 'Change the method? The live draft has not started, so nothing is lost.')}>Change method</button>
          </div>
        </>
      )}
      {started && canEdit && (
        <>
          <div class="inlinerow">
            {v.status === 'running' && <button class="btn" disabled={busy} onClick={() => act('pause')}>Pause</button>}
            {v.status === 'paused' && <button class="btn" disabled={busy} onClick={() => act('resume')}>Resume</button>}
            <button class="btn btn--ghost" disabled={busy || v.picks.length === 0}
              onClick={() => act('undo', 'Undo the last pick? The player goes back to the pool and that pick gets a full clock.')}>Undo last pick</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act('reset', {
              title: 'Reset the draft room?', body: 'Every pick is taken back and the room goes back to Ready. The undone picks stay in the event log.',
            })}>Reset room</button>
          </div>
          {v.status !== 'done' && (
            <ul class="draftcontrols__delegates">
              {v.teams.map((t) => {
                const first = t.players[0];
                if (v.delegates[t.captain.steamid]) {
                  return (
                    <li key={t.captain.steamid}>
                      <button class="btn btn--ghost btn--sm" disabled={busy}
                        onClick={() => void run(() => adminApi.draftRoomDelegate(eventId, t.captain.steamid, false))}>{`Give picking back to ${t.captain.name}`}</button>
                    </li>
                  );
                }
                return first ? (
                  <li key={t.captain.steamid}>
                    <button class="btn btn--ghost btn--sm" disabled={busy}
                      onClick={() => void run(() => adminApi.draftRoomDelegate(eventId, t.captain.steamid, true), `Hand ${t.captain.name}'s picking to ${first.name}?`)}>
                      {`Hand ${t.captain.name}'s picking to ${first.name}`}
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
```

`DraftTeamsPanel.tsx`:
1. Import: `import { DraftRoomControls } from './DraftRoomControls';`
2. Signature: add `slug = ''` to the destructured props and `slug?: string` to the props type.
3. Replace the method block and the `'live'` line:

```tsx
      {!published && data.mode === null && write && (
        <div class="maketeams__modes">
          <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.draftMode(eventId, 'auto'))}>Auto-balance by SR</button>
          <button class="btn btn--ghost" disabled={busy} onClick={() => void run(() => adminApi.draftMode(eventId, 'live'))}>Let captains pick</button>
        </div>
      )}
      {!published && data.mode === 'live' && (
        <DraftRoomControls eventId={eventId} slug={slug} canEdit={write} onChange={() => { reload(); onChange?.(); }} />
      )}
```

4. The Balance/Rebalance/Change method row: change its condition from `data.mode !== null` to `data.mode === 'auto'` (the room controls carry Change method for live, and only while the room is ready).
5. The swap select: change `{write && !published && (` to `{write && !published && data.mode === 'auto' && (`.

`EventEditor.tsx`: pass `slug={ev.slug}` to `DraftTeamsPanel`.

`web/src/styles/app.css`, after the room rules from Task 7:

```css
.draftcontrols { display: flex; flex-direction: column; gap: var(--sp-3); }
.draftcontrols p { margin: 0; }
.draftcontrols label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.draftcontrols input[type='number'] { width: 6rem; }
.draftcontrols__delegates { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
```

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run --project web web/src/routes/admin/events`
Expected: PASS (all desk panel tests). Then `npm run typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/events/DraftRoomControls.tsx web/src/routes/admin/events/DraftRoomControls.test.tsx web/src/routes/admin/events/DraftTeamsPanel.tsx web/src/routes/admin/events/DraftTeamsPanel.test.tsx web/src/routes/admin/events/EventEditor.tsx web/src/styles/app.css
git commit -m "Let captains pick is live on the desk's Make teams panel, with the room's settings, Start, pause, resume, undo, hand-over and reset, and the drafted teams publish through the existing step once the room is done (plan D2b1)"
```

### Task 9: The integration test and a scratch walk

**Files:**
- Test: `tests/draftLiveIntegration.test.ts` (new)
- Scratch only (never committed): `$S/seed-d2b.ts`, `$S/shoot-draft.mjs`, `$S/d2b.sqlite`, `$S/shots/`, where `$S` is your session's scratchpad directory.

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Write the integration test**

```ts
// tests/draftLiveIntegration.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import * as N from '../src/events/entries.js';
import { DraftClock } from '../src/events/draftClock.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, draftFixture } from './draftFixture.js';
import { must } from './draftRoomFixture.js';

/** Spec, Testing (Ruling 15): a 20-signup event from signups to the cut to
 *  a live draft to published entries, with one absent captain, a web
 *  restart mid-draft and an undo. */
describe('a live draft from signups to entries', () => {
  it('runs with an absent captain, a restart and an undo, and publishes five full teams', () => {
    const f = draftFixture();
    P.slice(0, 20).forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date(NOW.getTime() + i * 1000) })));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    const captains = P.slice(15, 20); // SR 1375 to 1475, so lowest first is signup order
    expect(must(D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })).captains.sort()).toEqual([...captains].sort());
    must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'live', actor: ADMIN, now: NOW }));
    const absent = captains[4]!;
    const here = captains.slice(0, 4);
    for (const c of here) must(DR.savePickList(f.db, { eventId: f.eventId, steamid: c, list: P.slice(0, 15), now: NOW }));

    let t = NOW.getTime() + 3_600_000;
    let clock = new DraftClock({ db: f.db, now: () => t });
    const beat = () => { for (const c of here) clock.heartbeat(f.eventId, c); };
    const st = () => DR.roomState(f.db, f.eventId)!;
    beat();
    expect(must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: clock.present(f.eventId) })).order).toEqual(captains);

    let restarted = false;
    let undone = false;
    for (let guard = 0; guard < 60 && st().room.status !== 'done'; guard++) {
      const s = st();
      if (s.picks.length === 7 && !restarted) {
        // A web restart: a new process with no heartbeats; the stored deadline stands.
        restarted = true;
        const deadline = Date.parse(s.room.deadline_at!);
        clock = new DraftClock({ db: f.db, now: () => t });
        t += 1000;
        clock.tick();
        expect(st().picks).toHaveLength(7);
        t = deadline;
        clock.tick();
        expect(st().picks).toHaveLength(8);
        expect(st().picks[7]).toMatchObject({ auto: 1 });
        beat();
        continue;
      }
      if (s.picks.length === 10 && !undone) {
        undone = true;
        must(DR.undoPick(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t) }));
        expect(st().picks).toHaveLength(9);
        expect(st().room.deadline_at).toBe(new Date(t + 75_000).toISOString());
        continue;
      }
      if (s.picker === absent) {
        // The absent captain's clock is 5 seconds from when the pick opened.
        expect(Date.parse(s.room.deadline_at!) - t).toBe(5000);
        t = Date.parse(s.room.deadline_at!);
        clock.tick();
        continue;
      }
      t += 2000;
      beat();
      const free = new Set(s.available.map((a) => a.steamid));
      const choice = DR.pickListOf(f.db, f.eventId, s.next!.captain).find((x) => free.has(x))!;
      must(DR.makePick(f.db, { eventId: f.eventId, steamid: s.picker!, player: choice, pickNo: s.next!.pickNo, now: new Date(t), present: clock.present(f.eventId) }));
    }

    expect(restarted && undone).toBe(true);
    const picks = st().picks;
    expect(st().room.status).toBe('done');
    expect(picks).toHaveLength(15);
    const absentPicks = picks.filter((p) => p.captain_steamid === absent);
    expect(absentPicks).toHaveLength(3);
    expect(absentPicks.every((p) => p.auto === 1)).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_picks WHERE event_id = ? AND undone_at IS NOT NULL').get(f.eventId)).toEqual({ n: 1 });

    const out = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t) }));
    expect(out.entries).toHaveLength(5);
    for (const id of out.entries) {
      const e = N.getEntry(f.db, id)!;
      expect(N.rosterOf(f.db, id).starters).toHaveLength(4);
      expect(N.entryManagers(f.db, e)).toEqual([e.captain_steamid]);
    }
    expect(new Set(out.entries.map((id) => N.getEntry(f.db, id)!.captain_steamid))).toEqual(new Set(captains));
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/draftLiveIntegration.test.ts`
Expected: PASS (every piece it uses landed in Tasks 1 to 6). If it fails, the failure is a real bug in an earlier task: fix it there, with a unit test in that task's file, not by bending this test.

- [ ] **Step 3: Run everything**

Run: `npm test` and `npm run typecheck`
Expected: only the 7 known `tests/skeetStreakPoster.test.ts` failures; typecheck clean. Also `grep -rnP '\x{2014}' src web/src tests docs/superpowers/plans/2026-10-08-drafts-2b-live-draft-room.md` finds nothing.

- [ ] **Step 4: A scratch walk with screenshots**

Never against `data/pug.db`, `/home/volence/l4d1-ds` or a live box. Write the seed to `$S/seed-d2b.ts`:

```ts
// $S/seed-d2b.ts: a published live draft for the walk. Run from the worktree:
//   npx tsx $S/seed-d2b.ts $S/d2b.sqlite
import { openDb } from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/src/db.js';
import { activatePlayer, upsertPlayer } from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/src/players.js';
import * as E from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/src/events/events.js';
import * as D from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/src/events/drafts.js';
import * as DR from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/src/events/draftRoom.js';
import { givePugs, rate } from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/tests/draftFixture.js';
import { stageBody } from '/home/volence/l4d/pug/.claude/worktrees/drafts-2b/tests/eventFixture.js';

const db = openDb(process.argv[2]!);
const ADMIN = '76561198000000900';
const P = Array.from({ length: 20 }, (_, i) => `765611980000010${String(i).padStart(2, '0')}`);
const NAMES = ['Ash', 'Bea', 'Cole', 'Dax', 'Eli', 'Fen', 'Gia', 'Hux', 'Ivy', 'Jax', 'Kai', 'Lux', 'Mo', 'Nia', 'Oz', 'Pia', 'Quin', 'Rex', 'Sol', 'Tia'];
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
upsertPlayer(db, { steamid: ADMIN, name: 'walk admin', avatar: null }, [ADMIN]);
P.forEach((s, i) => {
  upsertPlayer(db, { steamid: s, name: NAMES[i]!, avatar: null }, []);
  activatePlayer(db, s);
  db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`walk${i}`, s);
  givePugs(db, s, 6);
  rate(db, s, 1000 + 30 * i);
});
const now = new Date();
const h = (n: number) => new Date(now.getTime() + n * 3_600_000).toISOString();
const ev = must(E.createEvent(db, { by: ADMIN, now, fields: { name: 'Walk Draft', startsAt: h(72), entryKind: 'draft', draft: { signupsCloseAt: h(1), draftAt: h(2) } } }));
must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, { advanceCount: null }), now }));
must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now }));
must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now }));
P.forEach((s, i) => must(D.signUp(db, { eventId: ev.id, steamid: s, captainPref: 'willing', note: i % 4 === 0 ? 'prefer infected' : null, now: new Date(now.getTime() + i) })));
must(D.closeSignups(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.pickCaptains(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.publishCut(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.chooseTeamMode(db, { eventId: ev.id, mode: 'live', actor: ADMIN, now }));
must(DR.savePickList(db, { eventId: ev.id, steamid: P[15]!, list: [P[3], P[2], P[1]], now }));
console.log(JSON.stringify({ slug: ev.slug, id: ev.id, admin: ADMIN, captains: P.slice(15) }));
```

Then:
1. `npx tsx $S/seed-d2b.ts $S/d2b.sqlite` and note the printed slug and id.
2. Start the API and the web on free ports, in the background: `DEV_MODE=1 DB_PATH=$S/d2b.sqlite PORT=8093 npx tsx src/index.ts` and `API_PORT=8093 npx vite --port 5193 --strictPort`. Check `ss -ltn | grep -E ':(8093|5193)\b'` first and pick other ports if either is taken (other sessions run dev servers).
3. Log in with curl and drive the draft: `curl -s -c $S/admin.jar -H 'content-type: application/json' -d '{"steamid":"76561198000000900"}' localhost:8093/api/dev/login`, the same for the first captain into `$S/cap.jar` (`76561198000001015`, the lowest SR captain), then `curl -s -b $S/admin.jar -X POST localhost:8093/api/admin/events/<id>/draft/room/start`, then two picks: `curl -s -b $S/cap.jar -H 'content-type: application/json' -d '{"player":"76561198000001003","pickNo":1}' localhost:8093/api/events/<slug>/draft/pick`, and let the 5 s absent clock auto-pick the next one (nobody else heartbeats).
4. Copy `scripts/shoot-pages.mjs` to `$S/shoot-draft.mjs` and change only: `OUT` to `$S/shots`; `ROUTES` to `[['draft-room', '/event/<slug>/draft'], ['event', '/event/<slug>']]`; and, right after `await send('Runtime.enable');`, `await send('Network.enable'); await send('Network.setCookie', { name: 'pug_session', value: '<the pug_session value from $S/cap.jar>', url: BASE });` so the page is the captain's view. Run `SHOOT_BASE=http://localhost:5193 node $S/shoot-draft.mjs`. Expected: four PNGs (390 and 1400 wide) and no `HORIZONTAL OVERFLOW` line.
5. Open `$S/shots/draft-room-390.png` and check: the clock is readable, the board wraps to two columns, cards stack one per row, nothing runs off the right edge. Open the pick list drawer at 390 px by hand in a browser if any doubt remains, and record what you saw.
6. Stop both background processes. Delete nothing outside `$S`.

- [ ] **Step 5: Commit**

```bash
git add tests/draftLiveIntegration.test.ts
git commit -m "An integration test runs a 20-signup draft from signups through the cut and a live draft with an absent captain, a restart and an undo, to five published teams (plan D2b1)"
```

List the screenshot paths and anything the walk showed in the task report.
