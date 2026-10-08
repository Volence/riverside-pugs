# Drafts plan D3a: bench stand-ins

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a drafted player cannot play their team's next match, or drops out of the event, the captain (on the event page or with a Discord button) or staff (on the desk) asks the free-agent bench for a stand-in. The site offers the place to one bench player at a time, closest SR first and never more than the event's SR margin above the missing player, each with a DM carrying Accept and Decline and a 10 minute window. The player who accepts is put on the team for that match or for the rest of the event, carried into a lineup that is already locked (asking the game server first when a game is on it). No takers alerts staff and tells the captain; a dropout nobody could replace gets a staff-visible profile note.

**Architecture:**
- **Pure rules** (`src/events/draftRules.ts`, extended): the margin setting (`standinMarginOf`, `parseStandinMargin`), the offer order (`standinOrder`), the 10 minute window, and the Discord button prefixes. No database.
- **One writer of the stand-in tables** (`src/events/standins.ts`, new): `draft_standins` (one request per missing player) and `draft_standin_offers` (one row per offer). Request, offer the next bench player, decline, expire, cancel, lift the SR limit, fail an offer. Same shape as `drafts.ts`: each mutation is one transaction with one `event_log` row; a refusal writes nothing. Two write helpers (`markPlaced`, `markEnded`) run only inside `entries.ts` transactions, which log.
- **Placement** stays in `src/events/entries.ts`, the only writer of entry rosters: `placeStandin` (the accept, D2c's replace machinery reused through a shared `swapIntoLineups` helper) and `endStandin` (a match stand-in leaves the roster once the match is over). The game server half reuses `SeriesEngine.staffReplace`'s box dance, refactored into a private `swapThroughBox` that `standinPlace` also calls.
- **Auto lineup:** `RoomClock`'s timed-out lineup puts a match stand-in in place of the missing player (`withStandins`).
- **Flow** (`src/events/standinFlow.ts`, new): the `Standins` class used by routes, the Discord buttons and its own 15 s tick: requests, accepts (through the series engine when wired), declines, expiries, the next offer, the no-takers alert, the stranded note, and ending match stand-ins.
- **Surfaces:** `src/routes/standins.ts` (public and desk routes), `src/events/standinViews.ts` (per-viewer views), `src/discord/standinButtons.ts` (Accept, Decline, and the captain's request button), four new DM types, `web/src/routes/event/StandinPanel.tsx` on the event page and `web/src/routes/admin/events/StandinsPanel.tsx` on the desk.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npx vitest run <file>`; web: `npx vitest run --project web <file>`), `npm run typecheck` (server and web). Preact + preact-iso + @testing-library/preact (happy-dom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` section 6 (Bench and stand-ins), its Error handling ("A stand-in offer with no takers alerts staff; the match can then be delayed, played short-handed if both captains agree, or forfeited by staff") and Testing ("stand-in eligibility and offer order") sections. It builds on D1 (`docs/superpowers/plans/2026-10-07-drafts-1-signups-and-cut.md`, the one-at-a-time captaincy offer chain this plan copies), D2a (`2026-10-07-drafts-2a-make-teams.md`), D2c (`2026-10-07-drafts-2c-records-players-replace.md`, the staff replace whose machinery this plan reuses) and D2b1 (`2026-10-08-drafts-2b-live-draft-room.md`), whose rulings and writer split this plan keeps.

## Global Constraints

- Work in a new worktree on **branch `drafts-3`, cut from `drafts-2b2` or master as the controller says**. `node_modules` must be installed there (`npm ci` if missing). Never use bare `git stash`. Do not push. Do not deploy, restart, stage or rcon any box, and never touch `/home/volence/l4d1-ds`.
- Never write em dashes (or en dashes) in code, comments, copy, commits or docs: use a comma, a colon, parentheses or "to".
- Commit messages follow the repo style: one plain sentence (or two) describing the change, ending with "(plan D3a)".
- Owner rulings already made: tournaments never count as PUGs or touch scrim records; draft teams show their players publicly; staff can remove and replace a draft player (D2c) and transfer captaincy; the first draft events run by hand, so nothing here adds a series or a recurrence.
- Writers (`tests/eventLogGuard.test.ts`):
  - `draft_standins` and `draft_standin_offers` are written only in `src/events/standins.ts`.
  - `event_entries` and `event_entry_players` are still written only in `src/events/entries.ts` (and `play.ts`, `mergePlayers.ts` as today).
  - `events` (including `draft_json`) is still written only by the ENGINE files; the margin setting goes through `drafts.ts`.
  - Every new mutation adds exactly one `event_log` row on success and nothing when that row cannot be written.
- Privacy: bench players' SR, who was offered and who declined are shown only to staff. A captain sees their requests' status, how many bench players were asked, and the stand-in once filled. The public sees nothing new except the stand-in on the team's player list once placed (D2c Ruling 3 already lists current starters; a match stand-in is a sub and is not listed).
- Admins write on the desk and mods read (`requireStaff` GET, `requireAdmin` + `logAdmin` POST). Player routes use the competitive switch exactly as `src/routes/events.ts` does.
- DMs go out only after commit, through `Notifier`, `messages.ts` and `notices.ts` (the D1 pattern: `NotifyType` + `NOTIFY_TYPES` label, `EventNotifyType` + case, `tellX`, and the label assertion in `tests/notify.test.ts`). A DM failure never fails the request. Another branch may have added types to these unions (for example `draft_delegate_set`): append, never replace.
- Refusal codes are snake_case keys of `EVENT_ERRORS` in `src/events/validate.ts`, each with a plain-English sentence the web shows as is.
- The 7 `tests/skeetStreakPoster.test.ts` wall-clock failures are known on master; keep everything else passing.

## Review Focus

1. **An accept racing the expiry tick.** A bench player presses Accept a second before the window ends and the game server takes a few seconds to answer; the 15 s tick must not expire that offer underneath the placement, and the press time (not the finish time) decides whether the accept was in time. Task 5 pins it with a gated fake series engine and a tick in the middle.
2. **One bench player offered by two teams at once.** Two requests open together must not both offer the same player; a player with an open offer elsewhere (or already holding a place on any team) is skipped. Task 2 pins it.
3. **A stand-in for a match whose lineup is locked and whose game is mid-chapter.** The server refuses the sub; nothing is written, the offer stays open, and the stand-in is told to press Accept again between chapters. Task 4 pins it.
4. **The timed-out lineup picks the missing player.** With a match stand-in placed before lineups, the room's auto lineup must lock the stand-in, not the absent starter. Task 3 pins it through `RoomClock`.
5. **A match stand-in who never leaves.** Once that match is done, forfeit or bye (or the event ends) the stand-in's sub place closes, the team's next lineup is its four starters again, and the player is back on the bench for the next request. Task 5 pins it.

## Rulings

Owner rulings are marked **(owner)** or **(spec)**; the rest are decided for this plan and await owner review.

1. **(spec) Who asks.** The captain asks on the event page (either scope) or with a Discord button (next match only, Ruling 2). Staff ask for any draft team on the desk. The missing player cannot ask for themselves; they tell their captain.
2. **Two scopes.**
   - `match`: a stand-in for the team's **next unfinished match** (earliest by stage order, round, id; status not done, forfeit or bye). The site picks the match at request time and stores it; there is no match chooser. A team with no unfinished match is refused `standin_no_match` (so before the event goes live only `event` is possible).
   - `event`: the player has dropped out; the stand-in takes their place for the rest of the event.
   - The captain's Discord button asks for `match` only. Dropping a player for the rest of the event is a deliberate act made on the site, behind a confirm dialog.
3. **(spec) Offer order and margin.** Candidates are active bench signups (`draft_signups.role = 'bench'`, not withdrawn) who hold no place on any active entry of the event, have no open stand-in offer for another request, have not been offered this request before, and pass the event's starter eligibility now. Closest current-season SR first (ties by signup order); at most `margin` above the missing player's SR, any amount below. The margin is the event setting `standinSrMargin` in `draft_json` (default 100, a whole number 0 to 2000), set on the desk from the cut until the event ends, and copied into the request when it is made.
4. **(spec) Staff override.** Per request, staff press **Offer without the SR limit** (`margin_off = 1`). On an open request it widens the next offers; on an `unfilled` request it reopens it and offers at once. Staff can still place anyone directly with the D2c replace.
5. **(spec) Offers.** One open offer per request, 10 minutes each (`STANDIN_OFFER_MINUTES`). A DM with Accept and Decline buttons and a link, plus an Accept and Decline card on the event page. A decline moves on at once; an expiry moves on at the next tick (every 15 s, `STANDIN_TICK_MS`). An answer after the window is refused `standin_offer_expired` and records the expiry.
6. **Placement, `event` scope.** Exactly a D2c replace: the missing player's starter place closes, the stand-in becomes a starter, and any locked lineup of an unfinished match of the team that has the missing player is rewritten through the room's staff substitution path (game server first when a game is on it, the booking's people follow). Logged once as `standin_placed`.
7. **Placement, `match` scope.** The stand-in becomes a **sub** of the entry. If the missing player is in the target match's locked lineup, the stand-in is swapped into it the same way (game server first). If lineups are not locked yet, the room's timed-out lineup puts the stand-in in place of the missing player; a captain locking by hand chooses freely (the stand-in shows as a sub in the picker). When the target match is done, forfeit or bye, or the event finishes or is cancelled, the tick closes the sub place (`standin_ended`).
8. **Sub limit.** A stand-in swap never counts against the stage's subs per match (it is marked like a D2c staff sub). A captain's own later `!sub` of a stand-in counts as usual.
9. **The captain.** `event` scope for the captain is refused `standin_captain` (staff make another player captain first, D2c addendum). `match` scope for the captain is allowed; they stay captain.
10. **(spec) Stranded.** An `event` request that ends `unfilled` writes one staff-visible note on the dropout's profile (`player_notes`, author `system`): "Left <team> in <event> after the draft; no stand-in was found on the bench (stand-in request <id>)." Only on the first time that request goes unfilled. `match` requests and cancelled requests write no note.
11. **(spec) No takers.** The admin feed gets a `problem` with a link to the Events desk, and the captain gets the DM `draft_standin_none`. The spec's remedies are existing staff tools: delay (hold the match), forfeit, or lift the SR limit (Ruling 4). **Short-handed play is not built**: a lineup is always four (`readFour`), and changing that is a room rule change for the owner to ask for separately.
12. **A refused accept.** `player_entered` or `replace_ineligible` (about the player): that offer is marked failed and the next player is asked. A refusal about the request (the missing player is no longer a starter, the match is over, the event is over, the team is out): the request is cancelled. `replace_in_game` (the server is mid-chapter) or `standin_offer_gone` on a double press: nothing is written and the offer stays open until its window ends.
13. **(owner) Not PUGs, no scrim records.** Nothing here touches ratings or bookings' scrim records; the stand-in's games are tournament games like every other.
14. **Privacy.** Captains see status, how many were asked and the stand-in's name once filled. Never who was offered or declined, never bench SR. Staff see every offer with SR and answer.
15. **Event log actions.** `standin_requested`, `standin_offered`, `standin_declined`, `standin_offer_expired`, `standin_offer_failed`, `standin_unfilled`, `standin_cancelled`, `standin_margin_lifted`, `standin_placed`, `standin_ended`, `draft_standin_margin`.
16. *Plan deviation:* the steamid columns of the new tables carry no `REFERENCES players` foreign key and `match_id` carries no `event_matches` foreign key (a bracket resync deletes and recreates `event_matches` rows). Same reasoning as D2b1 Ruling 4: data for one event night, and the account merge needs no case for it.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/events/draftRules.ts` | modify | Pure: margin setting, offer order, window, button prefixes |
| `src/db.ts` | modify | `draft_standins`, `draft_standin_offers` |
| `src/events/validate.ts` | modify | New `EVENT_ERRORS` keys |
| `src/events/drafts.ts` | modify | `setStandinMargin` |
| `src/events/standins.ts` | create | Every write to the two stand-in tables; reads `requestOf`, `offerOf`, `openOfferOf`, `openRequestFor`, `requestsOf`, `offersOf`, `openRequests`, `endableStandins`, `matchStandins`, `nextMatchOf`, `unfilledCount`, `withStandins` |
| `src/events/entries.ts` | modify | `swapIntoLineups` helper (from `replaceDraftPlayer`), `placeStandin`, `endStandin` |
| `src/events/roomClock.ts` | modify | Timed-out lineup applies match stand-ins |
| `src/events/series.ts` | modify | `swapThroughBox` (from `staffReplace`), `standinPlace` |
| `src/events/standinFlow.ts` | create | `Standins`: request, accept, decline, cancel, lift limit, tick |
| `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts` | modify | Four DM types, the captain's request buttons on `draft_team_made` |
| `src/discord/standinButtons.ts` | create | `ds:` buttons |
| `src/events/standinViews.ts` | create | `myStandinView`, `adminStandinViews` |
| `src/routes/standins.ts` | create | Public and desk routes |
| `src/server.ts` | modify | Build `Standins`, tick it, the button, the routes |
| `web/src/api.ts` | modify | Types and calls |
| `web/src/routes/event/StandinPanel.tsx` | create | Captain requests, the bench player's offer card |
| `web/src/routes/admin/events/StandinsPanel.tsx` | create | Desk: margin, requests, offers, cancel, lift limit, ask for a team |
| `web/src/routes/Event.tsx`, `web/src/routes/admin/events/EventEditor.tsx` | modify | Mount the panels |
| `web/src/styles/app.css` | modify | Two small blocks, existing tokens only |
| `tests/standinFixture.ts` | create | Shared fixtures |
| tests | create/modify | See each task |

---

### Task 1: Rules, schema, refusals and the margin setting

**Files:**
- Modify: `src/events/draftRules.ts`, `src/db.ts`, `src/events/validate.ts`, `src/events/drafts.ts`, `tests/eventLogGuard.test.ts`
- Test: `tests/standinRules.test.ts` (new)

**Interfaces:**
- Consumes: `draftEvent` (private in `drafts.ts`), `E.logEvent(db, eventId, actor, action, at, detail)`.
- Produces:
  ```ts
  // src/events/draftRules.ts
  export const STANDIN_MARGIN_DEFAULT = 100;
  export const STANDIN_MARGIN_MAX = 2000;
  export const STANDIN_OFFER_MINUTES = 10;
  export const STANDIN_BUTTON_PREFIX = 'ds:';
  export function standinMarginOf(draftJson: string | null): number;
  export function parseStandinMargin(raw: unknown): number | null;
  export interface BenchCandidate { steamid: string; sr: number; order: number; eligible: boolean; busy: boolean }
  export function standinOrder(bench: readonly BenchCandidate[], outSr: number, margin: number | null, offered: ReadonlySet<string>): string[];
  // src/events/drafts.ts
  export function setStandinMargin(db: DB, o: { eventId: number; margin: unknown; actor: string; now: Date }): V.Checked<{ margin: number }>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/standinRules.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { roomSettingsOf } from '../src/events/draftRules.js';
import {
  STANDIN_MARGIN_DEFAULT, STANDIN_MARGIN_MAX, parseStandinMargin, standinMarginOf, standinOrder, type BenchCandidate,
} from '../src/events/draftRules.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, draftFixture } from './draftFixture.js';

const c = (steamid: string, sr: number, order: number, over: Partial<BenchCandidate> = {}): BenchCandidate =>
  ({ steamid, sr, order, eligible: true, busy: false, ...over });

describe('standinOrder (Ruling 3)', () => {
  it('offers the closest SR first, never more than the margin above, any amount below, ties by signup order', () => {
    const bench = [c('far', 1400, 0), c('up100', 1375, 1), c('down50', 1225, 2), c('up50', 1325, 3), c('low', 900, 4)];
    expect(standinOrder(bench, 1275, 100, new Set())).toEqual(['down50', 'up50', 'up100', 'low']);
  });

  it('skips ineligible players, busy players and players already offered this request', () => {
    const bench = [c('a', 1280, 0, { eligible: false }), c('b', 1281, 1, { busy: true }), c('d', 1282, 2), c('e', 1290, 3)];
    expect(standinOrder(bench, 1275, 100, new Set(['d']))).toEqual(['e']);
  });

  it('with the limit off (margin null) takes everyone eligible, still closest first', () => {
    const bench = [c('far', 1400, 0), c('near', 1290, 1)];
    expect(standinOrder(bench, 1000, null, new Set())).toEqual(['near', 'far']);
    expect(standinOrder(bench, 1000, 100, new Set())).toEqual([]);
  });

  it('a margin of 0 takes players at the same SR or below only', () => {
    expect(standinOrder([c('same', 1275, 0), c('above', 1276, 1), c('below', 1200, 2)], 1275, 0, new Set())).toEqual(['same', 'below']);
  });
});

describe('the stand-in margin setting', () => {
  it('reads the stored margin, and falls back to 100 for anything missing or out of range', () => {
    expect(standinMarginOf(null)).toBe(STANDIN_MARGIN_DEFAULT);
    expect(standinMarginOf(JSON.stringify({ standinSrMargin: 150 }))).toBe(150);
    for (const bad of [-1, STANDIN_MARGIN_MAX + 1, 1.5, '100', null]) {
      expect(standinMarginOf(JSON.stringify({ standinSrMargin: bad }))).toBe(STANDIN_MARGIN_DEFAULT);
    }
  });

  it('parses a desk body: whole numbers 0 to 2000 only', () => {
    expect(parseStandinMargin(0)).toBe(0);
    expect(parseStandinMargin(2000)).toBe(2000);
    for (const bad of [-1, 2001, 1.5, '100', null, undefined]) expect(parseStandinMargin(bad)).toBeNull();
  });

  it('setStandinMargin stores it next to the room settings once the cut is published, with one log row', () => {
    const f = cutDraft();
    D.setRoomSettings(f.db, { eventId: f.eventId, settings: { firstPick: 'random', pickSeconds: 60 }, actor: ADMIN, now: NOW });
    expect(D.setStandinMargin(f.db, { eventId: f.eventId, margin: 150, actor: ADMIN, now: NOW })).toEqual({ ok: true, value: { margin: 150 } });
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(standinMarginOf(ev.draft_json)).toBe(150);
    expect(roomSettingsOf(ev.draft_json)).toEqual({ firstPick: 'random', pickSeconds: 60 });
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'draft_standin_margin'").get()).toEqual({ detail: JSON.stringify({ margin: 150, from: 100 }) });
  });

  it('refuses a bad margin, and before the cut is published, and writes nothing', () => {
    const f = cutDraft({ publish: false });
    const go = (margin: unknown) => D.setStandinMargin(f.db, { eventId: f.eventId, margin, actor: ADMIN, now: NOW });
    expect(go(-5)).toEqual({ ok: false, error: 'bad_standin_margin' });
    expect(EVENT_ERRORS.bad_standin_margin.text).toBe('The stand-in SR margin is a whole number from 0 to 2000.');
    expect(go(100)).toEqual({ ok: false, error: 'wrong_status' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'draft_standin_margin'").get()).toEqual({ n: 0 });
  });
});

describe('the stand-in tables', () => {
  it('allow one open request per missing player of a team and one open offer per request', () => {
    const { db, eventId } = draftFixture();
    const req = db.prepare(
      "INSERT INTO draft_standins (event_id, entry_id, out_steamid, scope, match_id, margin, status, requested_by, requested_at) VALUES (?, 7, 'p', 'event', NULL, 100, ?, '1', 'x')",
    );
    const id = Number(req.run(eventId, 'open').lastInsertRowid);
    expect(() => req.run(eventId, 'open')).toThrow(/UNIQUE/);
    req.run(eventId, 'filled');
    const offer = db.prepare("INSERT INTO draft_standin_offers (request_id, steamid, offered_at, expires_at) VALUES (?, ?, 'x', 'y')");
    offer.run(id, 'b1');
    expect(() => offer.run(id, 'b2')).toThrow(/UNIQUE/);
    expect(() => req.run(eventId, 'maybe')).toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/standinRules.test.ts`
Expected: FAIL (`standinOrder` and the other names are not exported; the tables do not exist).

- [ ] **Step 3: Implement**

In `src/events/draftRules.ts`, append after the room settings block:

```ts
// ---------- bench stand-ins (plan D3a) ----------

/** Ruling 3: the event's stand-in SR margin, draft_json.standinSrMargin. */
export const STANDIN_MARGIN_DEFAULT = 100;
export const STANDIN_MARGIN_MAX = 2000;
/** Ruling 5: each stand-in offer is open this long. */
export const STANDIN_OFFER_MINUTES = 10;
/** Discord custom id prefix of the stand-in buttons (src/discord/standinButtons.ts). */
export const STANDIN_BUTTON_PREFIX = 'ds:';

const goodMargin = (m: unknown): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= STANDIN_MARGIN_MAX;

/** The margin as stored, or the default. */
export function standinMarginOf(draftJson: string | null): number {
  const d = draftJson ? (JSON.parse(draftJson) as Record<string, unknown>) : {};
  return goodMargin(d.standinSrMargin) ? d.standinSrMargin : STANDIN_MARGIN_DEFAULT;
}

/** A desk body's margin, or null. */
export function parseStandinMargin(raw: unknown): number | null {
  return goodMargin(raw) ? raw : null;
}

/** A bench player as the stand-in offers see them. busy: holds a place on a
 *  team of this event, or has an open offer for another request. */
export interface BenchCandidate { steamid: string; sr: number; order: number; eligible: boolean; busy: boolean }

/** Ruling 3: who is asked, in order. Eligible, not busy, not offered this
 *  request before, SR at most `margin` above the missing player's (any
 *  amount below; null is no limit), closest SR first, ties by signup order. */
export function standinOrder(bench: readonly BenchCandidate[], outSr: number, margin: number | null, offered: ReadonlySet<string>): string[] {
  return bench
    .filter((c) => c.eligible && !c.busy && !offered.has(c.steamid) && (margin === null || c.sr <= outSr + margin))
    .sort((a, b) => Math.abs(a.sr - outSr) - Math.abs(b.sr - outSr) || a.order - b.order)
    .map((c) => c.steamid);
}
```

In `src/db.ts`, after the `draft_pick_lists` table:

```sql
-- Drafts plan D3a: bench stand-ins. src/events/standins.ts owns every write.
-- One request per missing player of a team (scope 'match': the team's next
-- unfinished match, stored in match_id; 'event': the rest of the event), and
-- one row per offer to a bench player. No players or event_matches foreign
-- keys (plan Ruling 16).
CREATE TABLE IF NOT EXISTS draft_standins (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entry_id      INTEGER NOT NULL,
  out_steamid   TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('match','event')),
  match_id      INTEGER,
  margin        INTEGER NOT NULL,
  margin_off    INTEGER NOT NULL DEFAULT 0 CHECK (margin_off IN (0,1)),
  status        TEXT NOT NULL CHECK (status IN ('open','filled','unfilled','cancelled','ended')),
  requested_by  TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  filled_by     TEXT,
  closed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS draft_standins_open ON draft_standins (entry_id, out_steamid) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS draft_standin_offers (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES draft_standins(id) ON DELETE CASCADE,
  steamid     TEXT NOT NULL,
  offered_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  answer      TEXT CHECK (answer IS NULL OR answer IN ('accept','decline','expired','stopped','failed')),
  answered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS draft_standin_offers_open ON draft_standin_offers (request_id) WHERE answer IS NULL;
```

In `src/events/validate.ts`, import `STANDIN_MARGIN_MAX` from `./draftRules.js` (next to `NOTE_MAX`) and add to `EVENT_ERRORS` after `replace_bad_reason`:

```ts
  // Drafts plan D3a: bench stand-ins.
  standin_scope: { status: 400, text: 'A stand-in is for the next match or for the rest of the event.' },
  standin_captain: { status: 409, text: 'A captain who leaves the event needs a new captain first: ask staff to make another player captain.' },
  standin_no_match: { status: 409, text: 'Your team has no match left to find a stand-in for.' },
  standin_open: { status: 409, text: 'A stand-in is already being found for that player.' },
  standin_closed: { status: 409, text: 'That stand-in request is no longer open.' },
  standin_offer_open: { status: 409, text: 'An offer for this stand-in is already open.' },
  standin_offer_gone: { status: 409, text: 'That stand-in offer is no longer open.' },
  standin_offer_expired: { status: 409, text: 'That stand-in offer ran out before your answer. It has gone to the next player.' },
  standin_match_over: { status: 409, text: 'That match is already over.' },
  standin_running: { status: 409, text: 'That stand-in\'s match is not over yet.' },
  standin_margin_off: { status: 409, text: 'The SR limit is already off for this request.' },
  standins_closed: { status: 409, text: 'Stand-ins open once the teams are made and close when the event ends.' },
  bad_standin_margin: { status: 400, text: `The stand-in SR margin is a whole number from 0 to ${STANDIN_MARGIN_MAX}.` },
```

In `src/events/drafts.ts`, import `parseStandinMargin, standinMarginOf` from `./draftRules.js` and add after `setRoomSettings`:

```ts
/** Plan D3a Ruling 3: the event's stand-in SR margin, written into
 *  draft_json next to the D1 times and the room settings (updateEvent's merge
 *  keeps it), any time from the cut until the event ends. A request copies
 *  the margin when it is made. */
export function setStandinMargin(db: DB, o: { eventId: number; margin: unknown; actor: string; now: Date }): V.Checked<{ margin: number }> {
  const at = o.now.toISOString();
  const margin = parseStandinMargin(o.margin);
  if (margin === null) return V.fail('bad_standin_margin');
  return db.transaction((): V.Checked<{ margin: number }> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.cut_at === null || ev.status === 'finished' || ev.status === 'cancelled') return V.fail('wrong_status');
    const old = ev.draft_json ? (JSON.parse(ev.draft_json) as Record<string, unknown>) : {};
    db.prepare('UPDATE events SET draft_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...old, standinSrMargin: margin }), at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_standin_margin', at, { margin, from: standinMarginOf(ev.draft_json) });
    return V.ok({ margin });
  })();
}
```

In `tests/eventLogGuard.test.ts`, `DRAFT_MUTATIONS` gains:

```ts
      // Plan D3a Task 1: the stand-in SR margin.
      setStandinMargin: {
        action: 'draft_standin_margin', setup: published,
        run: (f) => D.setStandinMargin(f.db, { eventId: f.eventId, margin: 150, actor: ADMIN, now: NOW }),
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standinRules.test.ts tests/eventLogGuard.test.ts tests/draftRoomRules.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/draftRules.ts src/db.ts src/events/validate.ts src/events/drafts.ts tests/standinRules.test.ts tests/eventLogGuard.test.ts
git commit -m "Draft stand-ins have their rules (closest SR first, at most the event's margin above), their two tables and refusals, and staff can set the event's stand-in SR margin (plan D3a)"
```

### Task 2: The stand-in writer: requests and the offer chain

**Files:**
- Create: `src/events/standins.ts`, `tests/standinFixture.ts`
- Modify: `tests/eventLogGuard.test.ts`
- Test: `tests/standins.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `standinMarginOf`, `standinOrder`, `BenchCandidate`; `N.getEntry`, `N.placesOf`, `N.isActive`, `N.entryManagers`, `N.entryOfPlayer`, `N.playerFacts(db, steamid, now)` (its `sr` is current-season SR); `D.activeSignups(db, eventId)`; `R.problemsOf(elig, facts, 'starter')`; `E.getEvent`, `E.fieldsOf`, `E.logEvent`.
- Produces (all exported from `src/events/standins.ts`):
  ```ts
  export type StandinScope = 'match' | 'event';
  export const STANDIN_SCOPES: readonly StandinScope[];
  export type StandinStatus = 'open' | 'filled' | 'unfilled' | 'cancelled' | 'ended';
  export interface StandinRow { id: number; event_id: number; entry_id: number; out_steamid: string; scope: StandinScope; match_id: number | null;
    margin: number; margin_off: number; status: StandinStatus; requested_by: string; requested_at: string; filled_by: string | null; closed_at: string | null }
  export interface StandinOfferRow { id: number; request_id: number; steamid: string; offered_at: string; expires_at: string;
    answer: 'accept' | 'decline' | 'expired' | 'stopped' | 'failed' | null; answered_at: string | null }
  export interface StandinStep { offerId: number | null; offered: string | null; unfilled: boolean; cancelled: V.EventError | null }
  // reads
  export function requestOf(db: DB, id: number): StandinRow | undefined;
  export function offerOf(db: DB, id: number): StandinOfferRow | undefined;
  export function openOfferOf(db: DB, requestId: number): StandinOfferRow | undefined;
  export function openRequestFor(db: DB, entryId: number, out: string): StandinRow | undefined;
  export function requestsOf(db: DB, eventId: number): StandinRow[];
  export function offersOf(db: DB, requestId: number): StandinOfferRow[];
  export function openRequests(db: DB): StandinRow[];
  export function endableStandins(db: DB): StandinRow[];
  export function matchStandins(db: DB, matchId: number, entryId: number): { out: string; in: string }[];
  export function nextMatchOf(db: DB, eventId: number, entryId: number): number | null;
  export function unfilledCount(db: DB, requestId: number): number;
  export function withStandins(four: readonly string[], swaps: readonly { out: string; in: string }[]): string[];
  // mutations (one event_log row each)
  export function requestStandin(db: DB, o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean; now: Date }): V.Checked<{ requestId: number }>;
  export function offerNextStandin(db: DB, o: { requestId: number; now: Date; minutes: number }): V.Checked<StandinStep>;
  export function expireStandinOffer(db: DB, o: { requestId: number; now: Date }): V.Checked<null>;
  export function declineStandinOffer(db: DB, o: { offerId: number; steamid: string; now: Date }): V.Checked<{ requestId: number }>;
  export function cancelStandin(db: DB, o: { requestId: number; by: string; staff: boolean; now: Date }): V.Checked<null>;
  export function setStandinMarginOff(db: DB, o: { requestId: number; actor: string; now: Date }): V.Checked<{ reopened: boolean }>;
  export function failStandinOffer(db: DB, o: { offerId: number; why: V.EventError; cancel: boolean; now: Date }): V.Checked<null>;
  // write helpers, only inside an entries.ts transaction that logs
  export function markPlaced(db: DB, o: { requestId: number; offerId: number; steamid: string; at: string }): void;
  export function markEnded(db: DB, o: { requestId: number; at: string }): void;
  ```
- `tests/standinFixture.ts` produces `BENCH`, `standinFixture()`, `liveStandins()`, `entryOf(f, steamid)`, `asDraft(f)`, `benchOn(db, eventId, steamid)`, `offeredFor(f, entryId, out, scope?, now?)`, used by Tasks 3 to 7.

- [ ] **Step 1: Write the fixture and the failing test**

```ts
// tests/standinFixture.ts
import type { DB } from '../src/db.js';
import * as D from '../src/events/drafts.js';
import * as N from '../src/events/entries.js';
import * as S from '../src/events/standins.js';
import { startEventFlow } from '../src/events/flow.js';
import { ADMIN, NOW, must } from './eventFixture.js';
import { P, draftFixture, type DraftFixture } from './draftFixture.js';
import { A, B as BATS } from './entryFixture.js';
import type { RoomFixture } from './roomFixture.js';

/** Plan D3a: 21 signups a second apart in P order, 4 teams. Captains are the
 *  top four by SR (P[17..20]), the pool P[0..11] is auto-balanced onto them
 *  and published, and the bench is P[12..16] (SR 1300, 1325, 1350, 1375,
 *  1400). The event stays in registration with its teams made. */
export interface StandinFixture extends DraftFixture { entries: number[] }
export const BENCH = P.slice(12, 17);

export function standinFixture(): StandinFixture {
  const f = draftFixture();
  P.forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date(NOW.getTime() + i * 1000) })));
  must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: NOW }));
  must(D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: NOW }));
  must(D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  return { ...f, entries };
}

/** standinFixture with the event started by staff: round 1 matches waiting. */
export async function liveStandins(): Promise<StandinFixture> {
  const f = standinFixture();
  must(await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
  return f;
}

/** The active entry this player is a starter or sub of. */
export const entryOf = (f: { db: DB; eventId: number }, steamid: string): N.EntryRow => N.entryOfPlayer(f.db, f.eventId, steamid)!;

/** The room fixture's two team entries made into draft entries (test setup
 *  only, as tests/draftReplace.test.ts does): no site team, a captain each,
 *  A[4] (a team sub) off the roster, the event a draft with teams made. */
export function asDraft(f: RoomFixture): void {
  f.db.prepare("UPDATE events SET entry_kind = 'draft', teams_made_at = ? WHERE id = ?").run(NOW.toISOString(), f.eventId);
  f.db.prepare('UPDATE event_entries SET team_id = NULL, captain_steamid = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)')
    .run(f.entryA, A[0], BATS[0], f.entryA, f.entryB);
  f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), f.entryA, A[4]);
}

/** A bench signup (test setup only: the room fixture's event had no signups). */
export function benchOn(db: DB, eventId: number, steamid: string): void {
  db.prepare("INSERT INTO draft_signups (event_id, steamid, captain_pref, created_at, role) VALUES (?, ?, 'no', ?, 'bench')").run(eventId, steamid, NOW.toISOString());
}

/** A staff request for `out` with the SR limit off and its first offer made,
 *  as the flow would. */
export function offeredFor(f: { db: DB; eventId: number }, entryId: number, out: string, scope: S.StandinScope = 'match', now: Date = NOW): { requestId: number; offerId: number; steamid: string } {
  const { requestId } = must(S.requestStandin(f.db, { eventId: f.eventId, entryId, out, scope, by: ADMIN, staff: true, now }));
  must(S.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now }));
  const step = must(S.offerNextStandin(f.db, { requestId, now, minutes: 10 }));
  return { requestId, offerId: step.offerId!, steamid: step.offered! };
}
```

```ts
// tests/standins.test.ts
import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import * as S from '../src/events/standins.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, liveStandins, standinFixture, type StandinFixture } from './standinFixture.js';

const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const captainOf = (f: StandinFixture, steamid: string) => entryOf(f, steamid).captain_steamid!;
const ask = (f: StandinFixture, out: string, over: Partial<Parameters<typeof S.requestStandin>[1]> = {}) => {
  const entry = entryOf(f, out);
  return S.requestStandin(f.db, { eventId: f.eventId, entryId: entry.id, out, scope: 'event', by: entry.captain_steamid!, staff: false, now: NOW, ...over });
};
const next = (f: StandinFixture, requestId: number, now = NOW) => must(S.offerNextStandin(f.db, { requestId, now, minutes: 10 }));
const logs = (f: StandinFixture, action: string) => (f.db.prepare('SELECT detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { detail: string }[]).map((r) => JSON.parse(r.detail));

describe('requestStandin', () => {
  it('opens a request for a starter of the captain\'s team with the event margin, and logs it', () => {
    const f = standinFixture();
    const out = P[11]!;
    const { requestId } = must(ask(f, out));
    expect(S.requestOf(f.db, requestId)).toMatchObject({ entry_id: entryOf(f, out).id, out_steamid: out, scope: 'event', match_id: null, margin: 100, margin_off: 0, status: 'open' });
    expect(logs(f, 'standin_requested')).toEqual([{ requestId, entryId: entryOf(f, out).id, out, scope: 'event', matchId: null, staff: false }]);
  });

  it('refuses a non-captain, a non-starter, the captain for the rest of the event, a second request, a bad scope, and a match before the event is live', () => {
    const f = standinFixture();
    const out = P[11]!;
    expect(err(ask(f, out, { by: P[0]! === captainOf(f, out) ? P[1]! : P[0]! }))).toBe('not_manager');
    expect(err(ask(f, out, { out: BENCH[0]! }))).toBe('replace_not_starter');
    expect(err(ask(f, out, { out: captainOf(f, out) }))).toBe('standin_captain');
    expect(EVENT_ERRORS.standin_captain.text).toContain('ask staff to make another player captain');
    expect(err(ask(f, out, { scope: 'week' }))).toBe('standin_scope');
    expect(err(ask(f, out, { scope: 'match' }))).toBe('standin_no_match');
    must(ask(f, out));
    expect(err(ask(f, out))).toBe('standin_open');
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(ask(f, P[10]!))).toBe('standins_closed');
  });

  it('a match stand-in targets the team\'s next unfinished match once the event is live, and the captain may ask for themselves', async () => {
    const f = await liveStandins();
    const entry = entryOf(f, P[11]!);
    const m = f.db.prepare("SELECT id FROM event_matches WHERE (entry_a = ? OR entry_b = ?) AND status NOT IN ('done','forfeit','bye') ORDER BY round, id LIMIT 1").get(entry.id, entry.id) as { id: number };
    const { requestId } = must(ask(f, entry.captain_steamid!, { scope: 'match' }));
    expect(S.requestOf(f.db, requestId)).toMatchObject({ scope: 'match', match_id: m.id });
    expect(S.nextMatchOf(f.db, f.eventId, entry.id)).toBe(m.id);
  });
});

describe('the offer chain (Rulings 3 and 5)', () => {
  it('offers the bench closest SR first within the margin: P[12], P[13], P[14], P[15], then unfilled', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const order: string[] = [];
    for (let k = 0; k < 4; k++) {
      const step = next(f, requestId, at(k * 11));
      order.push(step.offered!);
      // Every other one declines, the rest run out.
      if (k % 2 === 0) must(S.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(k * 11 + 1) }));
      else must(S.expireStandinOffer(f.db, { requestId, now: at(k * 11 + 10) }));
    }
    expect(order).toEqual(BENCH.slice(0, 4));
    // P[16] is 125 above P[11]: never asked.
    expect(next(f, requestId, at(60))).toEqual({ offerId: null, offered: null, unfilled: true, cancelled: null });
    expect(S.requestOf(f.db, requestId)?.status).toBe('unfilled');
    expect(S.unfilledCount(f.db, requestId)).toBe(1);
  });

  it('a request nobody is close enough for goes unfilled at once; lifting the limit reopens it and asks the closest', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[0]!));
    expect(next(f, requestId).unfilled).toBe(true);
    expect(must(S.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: at(1) }))).toEqual({ reopened: true });
    expect(S.requestOf(f.db, requestId)).toMatchObject({ status: 'open', margin_off: 1, closed_at: null });
    expect(next(f, requestId, at(1)).offered).toBe(BENCH[0]);
    expect(err(S.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: at(2) }))).toBe('standin_margin_off');
  });

  it('Review Focus 2: a bench player with an open offer elsewhere, or a place on a team, is skipped', () => {
    const f = standinFixture();
    const a = must(ask(f, P[11]!)).requestId;
    const b = must(ask(f, P[10]!)).requestId;
    expect(next(f, a).offered).toBe(BENCH[0]);
    // P[10] (1250): P[12] is busy with a's offer, so P[13] (75 above) is next.
    expect(next(f, b).offered).toBe(BENCH[1]);
    expect(err(S.offerNextStandin(f.db, { requestId: a, now: NOW, minutes: 10 }))).toBe('standin_offer_open');
  });

  it('a decline after the window is refused, and records the expiry', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const step = next(f, requestId);
    expect(err(S.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(10) }))).toBe('standin_offer_expired');
    expect(S.offerOf(f.db, step.offerId!)?.answer).toBe('expired');
    expect(err(S.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: step.offered!, now: at(10) }))).toBe('standin_offer_gone');
    expect(err(S.expireStandinOffer(f.db, { requestId, now: at(11) }))).toBe('standin_offer_gone');
  });

  it('only the offered player declines, and an offer not yet due does not expire', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const step = next(f, requestId);
    expect(err(S.declineStandinOffer(f.db, { offerId: step.offerId!, steamid: BENCH[3]!, now: at(1) }))).toBe('standin_offer_gone');
    expect(err(S.expireStandinOffer(f.db, { requestId, now: at(9) }))).toBe('standin_offer_gone');
  });

  it('closes a request whose player is no longer a starter (staff replaced them) instead of offering', () => {
    const f = standinFixture();
    const out = P[11]!;
    const entry = entryOf(f, out);
    const { requestId } = must(ask(f, out));
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: entry.id, out, in: BENCH[4]!, reason: 'left', note: null, actor: ADMIN, now: at(1) }));
    expect(next(f, requestId, at(2))).toEqual({ offerId: null, offered: null, unfilled: false, cancelled: 'replace_not_starter' });
    expect(S.requestOf(f.db, requestId)?.status).toBe('cancelled');
  });
});

describe('cancel and fail', () => {
  it('the captain cancels an open request, and its open offer stops', () => {
    const f = standinFixture();
    const out = P[11]!;
    const { requestId } = must(ask(f, out));
    const step = next(f, requestId);
    expect(err(S.cancelStandin(f.db, { requestId, by: P[0]! === captainOf(f, out) ? P[1]! : P[0]!, staff: false, now: at(1) }))).toBe('not_manager');
    must(S.cancelStandin(f.db, { requestId, by: captainOf(f, out), staff: false, now: at(1) }));
    expect(S.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(S.offerOf(f.db, step.offerId!)?.answer).toBe('stopped');
    expect(err(S.cancelStandin(f.db, { requestId, by: ADMIN, staff: true, now: at(2) }))).toBe('standin_closed');
  });

  it('a failed offer moves on, or with cancel closes the request', () => {
    const f = standinFixture();
    const { requestId } = must(ask(f, P[11]!));
    const s1 = next(f, requestId);
    must(S.failStandinOffer(f.db, { offerId: s1.offerId!, why: 'player_entered', cancel: false, now: at(1) }));
    expect(S.requestOf(f.db, requestId)?.status).toBe('open');
    const s2 = next(f, requestId, at(1));
    expect(s2.offered).toBe(BENCH[1]);
    must(S.failStandinOffer(f.db, { offerId: s2.offerId!, why: 'standin_match_over', cancel: true, now: at(2) }));
    expect(S.requestOf(f.db, requestId)?.status).toBe('cancelled');
    expect(logs(f, 'standin_offer_failed').map((d) => d.why)).toEqual(['player_entered', 'standin_match_over']);
  });
});

describe('withStandins', () => {
  it('swaps each missing player for their stand-in, and never puts a player in twice', () => {
    expect(S.withStandins(['a', 'b', 'c', 'd'], [{ out: 'd', in: 'x' }])).toEqual(['a', 'b', 'c', 'x']);
    expect(S.withStandins(['a', 'b', 'c', 'x'], [{ out: 'a', in: 'x' }])).toEqual(['a', 'b', 'c', 'x']);
    expect(S.withStandins(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
```

In the two "not_manager" lines, the non-captain is any pool player on another team; `P[0]` and `P[1]` cannot both captain (captains are P[17..20]), so the expression always picks a non-captain.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/standins.test.ts`
Expected: FAIL (`src/events/standins.ts` does not exist).

- [ ] **Step 3: Implement `src/events/standins.ts`**

```ts
import type { DB } from '../db.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import { standinMarginOf, standinOrder, type BenchCandidate } from './draftRules.js';
import * as V from './validate.js';

/**
 * Bench stand-ins (drafts plan D3a): every write to draft_standins and
 * draft_standin_offers. Same shape as src/events/drafts.ts: each mutation is
 * one transaction that re-reads, checks, writes and adds exactly one
 * event_log row; a refusal writes nothing (declineStandinOffer's late answer
 * records the expiry, as D1's answerOffer does). markPlaced and markEnded are
 * write helpers for src/events/entries.ts, called only inside its own logged
 * transactions (placeStandin, endStandin).
 *
 * A request is one missing starter of one draft team: 'match' for the team's
 * next unfinished match (stored in match_id), 'event' for the rest of the
 * event. The bench is offered one player at a time (Rulings 3 and 5).
 */

export type StandinScope = 'match' | 'event';
export const STANDIN_SCOPES: readonly StandinScope[] = ['match', 'event'];
export type StandinStatus = 'open' | 'filled' | 'unfilled' | 'cancelled' | 'ended';
export interface StandinRow {
  id: number; event_id: number; entry_id: number; out_steamid: string; scope: StandinScope; match_id: number | null;
  margin: number; margin_off: number; status: StandinStatus; requested_by: string; requested_at: string;
  filled_by: string | null; closed_at: string | null;
}
export interface StandinOfferRow {
  id: number; request_id: number; steamid: string; offered_at: string; expires_at: string;
  answer: 'accept' | 'decline' | 'expired' | 'stopped' | 'failed' | null; answered_at: string | null;
}
/** What offerNextStandin did: an offer made, the request closed unfilled (nobody left), or cancelled (it no longer stands, with why). */
export interface StandinStep { offerId: number | null; offered: string | null; unfilled: boolean; cancelled: V.EventError | null }

/** Event statuses stand-ins are open in, once the teams are made. */
const STANDIN_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin', 'live']);
const RESOLVED_SQL = "('done','forfeit','bye')";

// ---------- reads ----------

export function requestOf(db: DB, id: number): StandinRow | undefined {
  return db.prepare('SELECT * FROM draft_standins WHERE id = ?').get(id) as StandinRow | undefined;
}
export function offerOf(db: DB, id: number): StandinOfferRow | undefined {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE id = ?').get(id) as StandinOfferRow | undefined;
}
export function openOfferOf(db: DB, requestId: number): StandinOfferRow | undefined {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE request_id = ? AND answer IS NULL').get(requestId) as StandinOfferRow | undefined;
}
export function openRequestFor(db: DB, entryId: number, out: string): StandinRow | undefined {
  return db.prepare("SELECT * FROM draft_standins WHERE entry_id = ? AND out_steamid = ? AND status = 'open'").get(entryId, out) as StandinRow | undefined;
}
export function requestsOf(db: DB, eventId: number): StandinRow[] {
  return db.prepare('SELECT * FROM draft_standins WHERE event_id = ? ORDER BY id').all(eventId) as StandinRow[];
}
export function offersOf(db: DB, requestId: number): StandinOfferRow[] {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE request_id = ? ORDER BY id').all(requestId) as StandinOfferRow[];
}
/** Every open request, for the tick. */
export function openRequests(db: DB): StandinRow[] {
  return db.prepare("SELECT * FROM draft_standins WHERE status = 'open' ORDER BY id").all() as StandinRow[];
}
/** Filled match stand-ins whose match is over (done, forfeit, bye, or gone)
 *  or whose event ended: the tick ends them (Ruling 7). */
export function endableStandins(db: DB): StandinRow[] {
  return db.prepare(
    `SELECT r.* FROM draft_standins r JOIN events e ON e.id = r.event_id LEFT JOIN event_matches m ON m.id = r.match_id
      WHERE r.status = 'filled' AND r.scope = 'match'
        AND (m.id IS NULL OR m.status IN ${RESOLVED_SQL} OR e.status IN ('finished','cancelled')) ORDER BY r.id`,
  ).all() as StandinRow[];
}
/** The filled match stand-ins of this team for this match: who sits out, who plays. */
export function matchStandins(db: DB, matchId: number, entryId: number): { out: string; in: string }[] {
  return db.prepare(
    "SELECT out_steamid AS out, filled_by AS \"in\" FROM draft_standins WHERE match_id = ? AND entry_id = ? AND scope = 'match' AND status = 'filled' ORDER BY id",
  ).all(matchId, entryId) as { out: string; in: string }[];
}
/** Ruling 2: the team's next unfinished match (stage order, round, id), or null. */
export function nextMatchOf(db: DB, eventId: number, entryId: number): number | null {
  const row = db.prepare(
    `SELECT m.id FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
      WHERE m.event_id = ? AND (m.entry_a = ? OR m.entry_b = ?) AND m.status NOT IN ${RESOLVED_SQL}
      ORDER BY s.ordinal, m.round, m.id LIMIT 1`,
  ).get(eventId, entryId, entryId) as { id: number } | undefined;
  return row?.id ?? null;
}
/** How many times this request has gone unfilled (Ruling 10: the stranded note is written the first time only). */
export function unfilledCount(db: DB, requestId: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM event_log WHERE action = 'standin_unfilled' AND json_extract(detail, '$.requestId') = ?",
  ).get(requestId) as { n: number }).n;
}
/** Ruling 7: a four with each missing player swapped for their stand-in, never putting a player in twice. */
export function withStandins(four: readonly string[], swaps: readonly { out: string; in: string }[]): string[] {
  return four.map((s) => swaps.find((x) => x.out === s && !four.includes(x.in))?.in ?? s);
}

// ---------- mutations ----------

/** Why an open request no longer stands, or null. Inside the caller's transaction. */
function requestGone(db: DB, req: StandinRow): V.EventError | null {
  const ev = E.getEvent(db, req.event_id);
  if (!ev || ev.teams_made_at === null || !STANDIN_OPEN.has(ev.status)) return 'standins_closed';
  const entry = N.getEntry(db, req.entry_id);
  if (!entry || !N.isActive(entry)) return 'entry_out';
  if (!N.placesOf(db, entry.id).some((p) => p.steamid === req.out_steamid && p.role === 'starter')) return 'replace_not_starter';
  if (req.scope === 'match') {
    const m = db.prepare('SELECT status FROM event_matches WHERE id = ?').get(req.match_id) as { status: string } | undefined;
    if (!m || ['done', 'forfeit', 'bye'].includes(m.status)) return 'standin_match_over';
  }
  return null;
}

/** Ruling 3: the next bench player for this request, or null. */
function pickStandin(db: DB, req: StandinRow, now: Date): string | null {
  const ev = E.getEvent(db, req.event_id)!;
  const elig = E.fieldsOf(ev).eligibility;
  const busy = new Set((db.prepare(
    `SELECT o.steamid FROM draft_standin_offers o JOIN draft_standins r ON r.id = o.request_id
      WHERE r.event_id = ? AND o.answer IS NULL`,
  ).all(ev.id) as { steamid: string }[]).map((r) => r.steamid));
  const bench: BenchCandidate[] = D.activeSignups(db, ev.id).flatMap((s, order) => {
    if (s.role !== 'bench') return [];
    const facts = N.playerFacts(db, s.steamid, now);
    return [{
      steamid: s.steamid, sr: facts.sr, order,
      eligible: R.problemsOf(elig, facts, 'starter').length === 0,
      busy: busy.has(s.steamid) || N.entryOfPlayer(db, ev.id, s.steamid) !== undefined,
    }];
  });
  const offered = new Set(offersOf(db, req.id).map((x) => x.steamid));
  const outSr = N.playerFacts(db, req.out_steamid, now).sr;
  return standinOrder(bench, outSr, req.margin_off === 1 ? null : req.margin, offered)[0] ?? null;
}

/** Rulings 1 and 2: a captain (or staff) asks the bench for a stand-in for
 *  one starter of a draft team, any time from teams made until the event ends. */
export function requestStandin(db: DB, o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean; now: Date }): V.Checked<{ requestId: number }> {
  if (!STANDIN_SCOPES.includes(o.scope as StandinScope)) return V.fail('standin_scope');
  const scope = o.scope as StandinScope;
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ requestId: number }> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    const entry = N.getEntry(db, o.entryId);
    if (!entry || entry.event_id !== ev.id) return V.fail('entry_not_found');
    if (ev.entry_kind !== 'draft' || entry.captain_steamid === null) return V.fail('replace_not_draft');
    if (ev.teams_made_at === null || !STANDIN_OPEN.has(ev.status)) return V.fail('standins_closed');
    if (!N.isActive(entry)) return V.fail('entry_out');
    if (!o.staff && !N.entryManagers(db, entry).includes(o.by)) return V.fail('not_manager');
    if (!N.placesOf(db, entry.id).some((p) => p.steamid === o.out && p.role === 'starter')) return V.fail('replace_not_starter');
    if (scope === 'event' && o.out === entry.captain_steamid) return V.fail('standin_captain');
    const matchId = scope === 'match' ? nextMatchOf(db, ev.id, entry.id) : null;
    if (scope === 'match' && matchId === null) return V.fail('standin_no_match');
    if (openRequestFor(db, entry.id, o.out)) return V.fail('standin_open');
    const id = Number(db.prepare(
      `INSERT INTO draft_standins (event_id, entry_id, out_steamid, scope, match_id, margin, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(ev.id, entry.id, o.out, scope, matchId, standinMarginOf(ev.draft_json), o.by, at).lastInsertRowid);
    E.logEvent(db, ev.id, o.by, 'standin_requested', at, { requestId: id, entryId: entry.id, out: o.out, scope, matchId, staff: o.staff });
    return V.ok({ requestId: id });
  })();
}

/** The chain's step (Ruling 5): while the request is open and has no open
 *  offer, offer the next bench player for `minutes`; with nobody left, close
 *  it unfilled; when it no longer stands (the player left the team, the match
 *  or the event is over), close it cancelled. */
export function offerNextStandin(db: DB, o: { requestId: number; now: Date; minutes: number }): V.Checked<StandinStep> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<StandinStep> => {
    const req = requestOf(db, o.requestId);
    if (!req || req.status !== 'open') return V.fail('standin_closed');
    if (openOfferOf(db, req.id)) return V.fail('standin_offer_open');
    const gone = requestGone(db, req);
    if (gone) {
      db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
      E.logEvent(db, req.event_id, null, 'standin_cancelled', at, { requestId: req.id, why: gone });
      return V.ok({ offerId: null, offered: null, unfilled: false, cancelled: gone });
    }
    const next = pickStandin(db, req, o.now);
    if (next) {
      const offerId = Number(db.prepare('INSERT INTO draft_standin_offers (request_id, steamid, offered_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(req.id, next, at, new Date(o.now.getTime() + o.minutes * 60_000).toISOString()).lastInsertRowid);
      E.logEvent(db, req.event_id, null, 'standin_offered', at, { requestId: req.id, steamid: next });
      return V.ok({ offerId, offered: next, unfilled: false, cancelled: null });
    }
    db.prepare("UPDATE draft_standins SET status = 'unfilled', closed_at = ? WHERE id = ?").run(at, req.id);
    E.logEvent(db, req.event_id, null, 'standin_unfilled', at, { requestId: req.id, entryId: req.entry_id, out: req.out_steamid, scope: req.scope });
    return V.ok({ offerId: null, offered: null, unfilled: true, cancelled: null });
  })();
}

/** The tick: the request's open offer, once due, is expired. */
export function expireStandinOffer(db: DB, o: { requestId: number; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const open = openOfferOf(db, o.requestId);
    if (!open || Date.parse(open.expires_at) > o.now.getTime()) return V.fail('standin_offer_gone');
    const req = requestOf(db, open.request_id)!;
    db.prepare("UPDATE draft_standin_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, open.id);
    E.logEvent(db, req.event_id, null, 'standin_offer_expired', at, { requestId: req.id, steamid: open.steamid });
    return V.ok(null);
  })();
}

/** The offered player says no. An answer at or after the window that the
 *  tick has not expired yet is refused standin_offer_expired, and the expiry
 *  is recorded here, as the tick would have (D1's answerOffer does the same). */
export function declineStandinOffer(db: DB, o: { offerId: number; steamid: string; now: Date }): V.Checked<{ requestId: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ requestId: number }> => {
    const offer = offerOf(db, o.offerId);
    if (!offer || offer.steamid !== o.steamid || offer.answer !== null) return V.fail('standin_offer_gone');
    const req = requestOf(db, offer.request_id)!;
    if (o.now.getTime() >= Date.parse(offer.expires_at)) {
      db.prepare("UPDATE draft_standin_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, offer.id);
      E.logEvent(db, req.event_id, null, 'standin_offer_expired', at, { requestId: req.id, steamid: offer.steamid, answered: true });
      return V.fail('standin_offer_expired');
    }
    db.prepare("UPDATE draft_standin_offers SET answer = 'decline', answered_at = ? WHERE id = ?").run(at, offer.id);
    E.logEvent(db, req.event_id, o.steamid, 'standin_declined', at, { requestId: req.id, steamid: o.steamid });
    return V.ok({ requestId: req.id });
  })();
}

/** The captain (or staff) no longer needs it: the request closes and its open offer stops. */
export function cancelStandin(db: DB, o: { requestId: number; by: string; staff: boolean; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const req = requestOf(db, o.requestId);
    if (!req || req.status !== 'open') return V.fail('standin_closed');
    const entry = N.getEntry(db, req.entry_id);
    if (!o.staff && (!entry || !N.entryManagers(db, entry).includes(o.by))) return V.fail('not_manager');
    db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
    db.prepare("UPDATE draft_standin_offers SET answer = 'stopped', answered_at = ? WHERE request_id = ? AND answer IS NULL").run(at, req.id);
    E.logEvent(db, req.event_id, o.by, 'standin_cancelled', at, { requestId: req.id, why: 'asked', staff: o.staff });
    return V.ok(null);
  })();
}

/** Ruling 4: staff lift the SR limit on one request. An unfilled request
 *  reopens (the flow then offers at once). */
export function setStandinMarginOff(db: DB, o: { requestId: number; actor: string; now: Date }): V.Checked<{ reopened: boolean }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ reopened: boolean }> => {
    const req = requestOf(db, o.requestId);
    if (!req || (req.status !== 'open' && req.status !== 'unfilled')) return V.fail('standin_closed');
    if (req.margin_off === 1) return V.fail('standin_margin_off');
    const reopened = req.status === 'unfilled';
    if (reopened && openRequestFor(db, req.entry_id, req.out_steamid)) return V.fail('standin_open');
    db.prepare("UPDATE draft_standins SET margin_off = 1, status = 'open', closed_at = NULL WHERE id = ?").run(req.id);
    E.logEvent(db, req.event_id, o.actor, 'standin_margin_lifted', at, { requestId: req.id, reopened });
    return V.ok({ reopened });
  })();
}

/** Ruling 12: an accept the placement refused. The offer is failed; with
 *  cancel (the refusal was about the request) the request closes too. */
export function failStandinOffer(db: DB, o: { offerId: number; why: V.EventError; cancel: boolean; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const offer = offerOf(db, o.offerId);
    if (!offer || offer.answer !== null) return V.fail('standin_offer_gone');
    const req = requestOf(db, offer.request_id)!;
    db.prepare("UPDATE draft_standin_offers SET answer = 'failed', answered_at = ? WHERE id = ?").run(at, offer.id);
    if (o.cancel && req.status === 'open') db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
    E.logEvent(db, req.event_id, null, 'standin_offer_failed', at, { requestId: req.id, steamid: offer.steamid, why: o.why, cancelled: o.cancel });
    return V.ok(null);
  })();
}

// ---------- write helpers for entries.ts (never on their own) ----------

/** Inside placeStandin's transaction: the offer accepted and the request
 *  filled. An event stand-in is done with; a match stand-in stays filled
 *  until endStandin. */
export function markPlaced(db: DB, o: { requestId: number; offerId: number; steamid: string; at: string }): void {
  db.prepare("UPDATE draft_standin_offers SET answer = 'accept', answered_at = ? WHERE id = ?").run(o.at, o.offerId);
  db.prepare("UPDATE draft_standins SET status = 'filled', filled_by = ?, closed_at = CASE scope WHEN 'event' THEN ? ELSE NULL END WHERE id = ?")
    .run(o.steamid, o.at, o.requestId);
}

/** Inside endStandin's transaction: a match stand-in is over. */
export function markEnded(db: DB, o: { requestId: number; at: string }): void {
  db.prepare("UPDATE draft_standins SET status = 'ended', closed_at = ? WHERE id = ?").run(o.at, o.requestId);
}
```

Then add the guard block to `tests/eventLogGuard.test.ts`, after the draft room guard (import `* as S from '../src/events/standins.js'` and `{ standinFixture, type StandinFixture } from './standinFixture.js'` at the top):

```ts
  /** Drafts plan D3a: src/events/standins.ts is the only writer of the
   *  stand-in tables; each mutation adds one event_log row or, when that row
   *  cannot be written, nothing. markPlaced and markEnded are helpers that
   *  entries.ts calls inside its own logged transactions (Task 3 guards them
   *  there). */
  describe('stand-in guard (src/events/standins.ts)', () => {
    const STANDIN_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:draft_standins|draft_standin_offers)\b/gi;
    const STANDIN_READS = new Set(['requestOf', 'offerOf', 'openOfferOf', 'openRequestFor', 'requestsOf', 'offersOf', 'openRequests',
      'endableStandins', 'matchStandins', 'nextMatchOf', 'unfilledCount', 'withStandins']);
    const STANDIN_HELPERS = new Set(['markPlaced', 'markEnded']);
    const must = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const OUT = DP[11]!;
    const entryOfOut = (f: StandinFixture) => N.entryOfPlayer(f.db, f.eventId, OUT)!;
    const requested = (): Pick<Setup, 'f' | 'requestId'> => {
      const f = standinFixture();
      const e = entryOfOut(f);
      const { requestId } = must(S.requestStandin(f.db, { eventId: f.eventId, entryId: e.id, out: OUT, scope: 'event', by: e.captain_steamid!, staff: false, now: NOW }));
      return { f, requestId };
    };
    const offered = (): Setup => {
      const x = requested();
      const step = must(S.offerNextStandin(x.f.db, { requestId: x.requestId, now: NOW, minutes: 10 }));
      return { ...x, offerId: step.offerId!, steamid: step.offered! };
    };
    const LATE = new Date(NOW.getTime() + 11 * 60_000);
    type Setup = { f: StandinFixture; requestId: number; offerId: number; steamid: string };
    const STANDIN_MUTATIONS: Record<string, { action: string; setup: () => Pick<Setup, 'f'> & Partial<Setup>; run: (x: Setup) => V.Checked<unknown> }> = {
      requestStandin: {
        action: 'standin_requested', setup: () => ({ f: standinFixture() }),
        run: ({ f }) => { const e = entryOfOut(f); return S.requestStandin(f.db, { eventId: f.eventId, entryId: e.id, out: OUT, scope: 'event', by: e.captain_steamid!, staff: false, now: NOW }); },
      },
      offerNextStandin: { action: 'standin_offered', setup: requested, run: ({ f, requestId }) => S.offerNextStandin(f.db, { requestId, now: NOW, minutes: 10 }) },
      expireStandinOffer: { action: 'standin_offer_expired', setup: offered, run: ({ f, requestId }) => S.expireStandinOffer(f.db, { requestId, now: LATE }) },
      declineStandinOffer: { action: 'standin_declined', setup: offered, run: ({ f, offerId, steamid }) => S.declineStandinOffer(f.db, { offerId, steamid, now: NOW }) },
      cancelStandin: { action: 'standin_cancelled', setup: offered, run: ({ f, requestId }) => S.cancelStandin(f.db, { requestId, by: ADMIN, staff: true, now: NOW }) },
      setStandinMarginOff: { action: 'standin_margin_lifted', setup: requested, run: ({ f, requestId }) => S.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: NOW }) },
      failStandinOffer: { action: 'standin_offer_failed', setup: offered, run: ({ f, offerId }) => S.failStandinOffer(f.db, { offerId, why: 'player_entered', cancel: false, now: NOW }) },
    };
    const standinRows = (f: StandinFixture) => JSON.stringify([
      f.db.prepare('SELECT * FROM draft_standins ORDER BY id').all(),
      f.db.prepare('SELECT * FROM draft_standin_offers ORDER BY id').all(),
    ]);

    it('only src/events/standins.ts writes the stand-in tables', () => {
      const offenders = walk('src')
        .filter((f) => f !== 'src/events/standins.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(STANDIN_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
      expect('update draft_standin_offers set answer = ?'.match(STANDIN_WRITERS)).toHaveLength(1);
    });

    it('every exported function of standins.ts is a known read, a helper, or a guarded mutation', () => {
      const fns = Object.entries(S).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !STANDIN_READS.has(k) && !STANDIN_HELPERS.has(k)).sort()).toEqual(Object.keys(STANDIN_MUTATIONS).sort());
      expect(fns.filter((k) => STANDIN_HELPERS.has(k)).sort()).toEqual([...STANDIN_HELPERS].sort());
    });

    for (const [name, m] of Object.entries(STANDIN_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const x = m.setup();
        const before = logCount(x.f);
        const r = m.run(x as Setup);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(x.f)).toBe(before + 1);
        expect(x.f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const x = m.setup();
        const before = standinRows(x.f);
        const logs = logCount(x.f);
        x.f.db.exec("CREATE TRIGGER standin_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
        expect(() => m.run(x as Setup)).toThrow(/audit down/);
        expect(standinRows(x.f)).toBe(before);
        expect(logCount(x.f)).toBe(logs);
      });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standins.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/standins.ts tests/standinFixture.ts tests/standins.test.ts tests/eventLogGuard.test.ts
git commit -m "Captains and staff can ask the draft bench for a stand-in, and the site offers it one bench player at a time, closest SR first within the event's margin, through declines, expiries, a lifted SR limit, cancels and failed accepts, each with one log row (plan D3a)"
```

### Task 3: Placing a stand-in on the team, ending a match stand-in, and the timed-out lineup

**Files:**
- Modify: `src/events/entries.ts`, `src/events/roomClock.ts`, `tests/eventLogGuard.test.ts`
- Test: `tests/standinPlace.test.ts` (new); `tests/draftReplace.test.ts` must still pass unchanged (the refactor keeps D2c's behaviour)

**Interfaces:**
- Consumes: Task 2's `S.requestOf`, `S.offerOf`, `S.markPlaced`, `S.markEnded`, `S.endableStandins`, `S.matchStandins`, `S.withStandins`, `S.StandinScope`; existing private `lineupMatches`, `addPlace`, `Refused`, `ROSTER_OPEN`, `BoxGame` in `entries.ts`; `Room.subPlayer`, `Room.gamesOf`, `B.replacePlayer`, `addTournamentSub`.
- Produces (exported from `src/events/entries.ts`):
  ```ts
  export interface StandinPlaced {
    subbedInMatch: number | null; onBox?: BoxGame[]; requestId: number; entryId: number; out: string; in: string; scope: S.StandinScope; matchId: number | null;
  }
  export interface StandinPlaceInput {
    eventId: number; requestId: number; offerId: number; steamid: string;
    /** When the player pressed Accept: the window is judged at this time (Review Focus 1). */
    acceptedAt: Date; now: Date; check?: boolean; boxTook?: number[];
  }
  export function placeStandin(db: DB, o: StandinPlaceInput): V.Checked<StandinPlaced>;
  export function endStandin(db: DB, o: { requestId: number; now: Date }): V.Checked<{ entryId: number; steamid: string }>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/standinPlace.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as S from '../src/events/standins.js';
import { RoomClock } from '../src/events/roomClock.js';
import { draftBench } from '../src/events/views.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P as DP } from './draftFixture.js';
import { A, B as BATS, OUTSIDER } from './entryFixture.js';
import { TIMERS, driveToBooking, roomFixture } from './roomFixture.js';
import { BENCH, asDraft, benchOn, entryOf, offeredFor, standinFixture } from './standinFixture.js';

const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const rows = (db: Parameters<typeof N.getEntry>[0]) => JSON.stringify([
  db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
  db.prepare('SELECT * FROM event_lineups ORDER BY id').all(),
  db.prepare('SELECT * FROM draft_standins ORDER BY id').all(),
  db.prepare('SELECT * FROM draft_standin_offers ORDER BY id').all(),
  db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);

describe('placeStandin, rest of the event (Ruling 6)', () => {
  it('puts the stand-in on as a starter in place of the dropout, fills the request, and logs once', () => {
    const f = standinFixture();
    const out = DP[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'event');
    expect(o.steamid).toBe(BENCH[0]);
    const before = N.rosterOf(f.db, entry.id).starters;
    const r = must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1) }));
    expect(r).toEqual({ subbedInMatch: null, requestId: o.requestId, entryId: entry.id, out, in: BENCH[0], scope: 'event', matchId: null });
    expect(N.rosterOf(f.db, entry.id).starters).toEqual([...before.filter((s) => s !== out), BENCH[0]]);
    expect(N.entryOfPlayer(f.db, f.eventId, out)).toBeUndefined();
    expect(S.requestOf(f.db, o.requestId)).toMatchObject({ status: 'filled', filled_by: BENCH[0] });
    expect(S.offerOf(f.db, o.offerId)?.answer).toBe('accept');
    expect(draftBench(f.db, f.eventId).map((b) => b.steamid)).not.toContain(BENCH[0]);
    expect(f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'standin_placed'").all()).toEqual([
      { actor: BENCH[0], detail: JSON.stringify({ requestId: o.requestId, entryId: entry.id, out, in: BENCH[0], scope: 'event' }) },
    ]);
  });

  it('refuses a late accept, someone else pressing it, a stopped offer, and a stand-in placed elsewhere since, writing nothing', () => {
    const f = standinFixture();
    const out = DP[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'event');
    const go = (over: Partial<N.StandinPlaceInput> = {}) =>
      N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1), ...over });
    const before = rows(f.db);
    expect(err(go({ acceptedAt: at(10), now: at(10) }))).toBe('standin_offer_expired');
    expect(err(go({ steamid: BENCH[1]! }))).toBe('standin_offer_gone');
    expect(rows(f.db)).toBe(before);
    // BENCH[0] goes onto another team by a staff replace first.
    const other = f.entries.find((id) => id !== entry.id)!;
    const otherOut = N.rosterOf(f.db, other).starters.find((s) => s !== N.getEntry(f.db, other)!.captain_steamid)!;
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: other, out: otherOut, in: BENCH[0]!, reason: 'other', note: null, actor: ADMIN, now: at(1) }));
    const mid = rows(f.db);
    expect(err(go())).toBe('player_entered');
    expect(rows(f.db)).toBe(mid);
    must(S.cancelStandin(f.db, { requestId: o.requestId, by: ADMIN, staff: true, now: at(2) }));
    expect(err(go({ acceptedAt: at(2), now: at(2) }))).toBe('standin_offer_gone');
  });
});

describe('placeStandin, next match (Ruling 7)', () => {
  it('with the lineup locked: a sub of the team, swapped into the lineup without using a sub, and gone once the match is over', async () => {
    const f = await roomFixture();
    asDraft(f);
    driveToBooking(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match', at(5));
    expect(o.steamid).toBe(OUTSIDER);
    const r = must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: at(6), now: at(6) }));
    expect(r).toMatchObject({ subbedInMatch: f.matchId, scope: 'match', matchId: f.matchId, out: A[3], in: OUTSIDER });
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'a')).toBe(0);
    expect(N.rosterOf(f.db, f.entryA)).toMatchObject({ starters: A.slice(0, 4), subs: [OUTSIDER] });
    expect(N.endStandin(f.db, { requestId: o.requestId, now: at(7) })).toEqual({ ok: false, error: 'standin_running' });
    // Test setup only: the match is over.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    expect(S.endableStandins(f.db).map((x) => x.id)).toEqual([o.requestId]);
    expect(N.endStandin(f.db, { requestId: o.requestId, now: at(60) })).toEqual({ ok: true, value: { entryId: f.entryA, steamid: OUTSIDER } });
    expect(N.rosterOf(f.db, f.entryA).subs).toEqual([]);
    expect(S.requestOf(f.db, o.requestId)?.status).toBe('ended');
    expect(err(N.endStandin(f.db, { requestId: o.requestId, now: at(61) }))).toBe('standin_closed');
  });

  it('refuses once the target match is over', async () => {
    const f = await roomFixture();
    asDraft(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match');
    f.db.prepare("UPDATE event_matches SET status = 'forfeit' WHERE id = ?").run(f.matchId);
    expect(err(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: NOW, now: NOW }))).toBe('standin_match_over');
  });

  it('Review Focus 4: the timed-out lineup locks the stand-in in place of the missing starter', async () => {
    const f = await roomFixture();
    asDraft(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match');
    must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: NOW, now: NOW }));
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toBeNull();
    const t = { t: NOW.getTime() };
    const clock = new RoomClock({ db: f.db, notifier: { send: vi.fn(() => 1) } as unknown as Notifier, publicUrl: 'https://x', push: vi.fn(), now: () => t.t, seed: () => 5 });
    await clock.tick();
    for (const steamid of [A[0]!, BATS[0]!]) R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: at(1) });
    for (const min of [2, 3, 4]) { t.t = at(min).getTime(); await clock.tick(); }
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('lineup');
    t.t = at(20).getTime();
    await clock.tick();
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.lineupFour(f.db, f.matchId, f.entryB)).toEqual(BATS.slice(0, 4));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/standinPlace.test.ts`
Expected: FAIL (`placeStandin` and `endStandin` are not exported).

- [ ] **Step 3: Implement**

In `src/events/entries.ts`, add `import * as S from './standins.js';` and refactor the room half of `replaceDraftPlayer` into a shared helper, placed right after `lineupMatches`:

```ts
/** A sentence for a game on a box that was not asked to take the change. */
const BOX_NOT_ASKED = 'A game with this player is on a server, and the server was not asked to take the change.';
/** A game on a box that rosters the player and did not take the sub. */
const boxMissing = (onBox: BoxGame[], took: number[] | undefined): boolean => onBox.some((g) => !(took ?? []).includes(g.gameMatchId));

/** The room, booking and game halves of swapping `out` for `in` in these
 *  matches (plan D2c Ruling 5; plan D3a reuses it for a stand-in): the room's
 *  staff substitution (never counted against the side's subs), the open
 *  booking's people, and every game on a box. Inside the caller's
 *  transaction, after `in` holds a place on the entry; a refusal throws
 *  Refused so the whole transaction rolls back. */
function swapIntoLineups(db: DB, matches: ReturnType<typeof lineupMatches>, o: { out: string; in: string; actor: string; now: Date }): void {
  for (const m of matches) {
    const live = m.onBox[0];
    const gameId = live ? Room.gamesOf(db, m.matchId).find((g) => g.match_id === live.gameMatchId)?.id ?? null : null;
    const s = Room.subPlayer(db, { matchId: m.matchId, by: o.actor, outId: o.out, inId: o.in, limit: 0, gameId, staff: true, now: o.now });
    const inGame = (why: string) => new Refused(V.fail('replace_in_game', [{ steamid: o.out, problems: [why] }]));
    if (!s.ok) {
      const why = `The match room refused it: ${V.EVENT_ERRORS[s.error].text}`;
      // A room state refusal has nothing to do with the box; anything else keeps the in-game label.
      if (s.error === 'entry_out' || s.error === 'not_live' || s.error === 'not_live_phase') throw new Refused(V.fail('replace_not_possible', [{ steamid: o.out, problems: [why] }]));
      throw inGame(why);
    }
    if (m.bookingId !== null) {
      const b = B.getBooking(db, m.bookingId);
      if (b && B.isOpen(b)) {
        const swapped = B.replacePlayer(db, { bookingId: b.id, side: s.value.side, outId: o.out, inId: o.in, by: o.actor, now: o.now });
        if (!swapped.ok) throw inGame(`The booking refused it (${swapped.error}).`);
      }
    }
    for (const g of m.onBox) {
      if (!addTournamentSub(db, { matchId: g.gameMatchId, inId: o.in, team: g.team, now: o.now })) throw inGame(`Game ${g.gameMatchId} is not a tournament game.`);
    }
  }
}
```

and `replaceDraftPlayer`'s body from `if (o.check) return ...` to the `E.logEvent` becomes:

```ts
      if (o.check) return V.ok({ subbedInMatch, onBox });
      if (boxMissing(onBox, o.boxTook)) return V.fail('replace_in_game', [{ steamid: o.out, problems: [BOX_NOT_ASKED] }]);
      db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE id = ?').run(at, place.id);
      addPlace(db, entry.id, o.in, 'starter', at);
      swapIntoLineups(db, matches, { out: o.out, in: o.in, actor: o.actor, now: o.now });
      E.logEvent(db, ev.id, o.actor, 'entry_player_replaced', at, {
        entryId: entry.id, out: o.out, in: o.in, reason: o.reason, ...(subbedInMatch !== null ? { matchId: subbedInMatch } : {}),
      });
      return V.ok({ subbedInMatch });
```

Then add after `setDraftCaptain`:

```ts
export interface StandinPlaced {
  subbedInMatch: number | null; onBox?: BoxGame[]; requestId: number; entryId: number; out: string; in: string; scope: S.StandinScope; matchId: number | null;
}
export interface StandinPlaceInput {
  eventId: number; requestId: number; offerId: number; steamid: string;
  /** When the player pressed Accept: the window is judged at this time (plan D3a Review Focus 1). */
  acceptedAt: Date; now: Date; check?: boolean; boxTook?: number[];
}

/**
 * A bench player accepts a stand-in offer (drafts plan D3a Rulings 6 and 7),
 * in one transaction with one 'standin_placed' row. The offer must be theirs,
 * open, and pressed inside its window; the request open and still standing.
 * They must hold no place in the event and pass its starter eligibility now.
 * 'event': the missing starter's place closes and the stand-in becomes a
 * starter, carried into every locked lineup of an unfinished match of the
 * team that has the missing player (as replaceDraftPlayer). 'match': the
 * stand-in becomes a sub of the team, swapped into the target match's lineup
 * if it is locked with the missing player in it. The swap uses the room's
 * staff path, so it never counts against the side's subs. A game on a box
 * takes the sub first, exactly as replaceDraftPlayer: the series engine calls
 * this with `check`, asks the box, then calls it with `boxTook`.
 */
export function placeStandin(db: DB, o: StandinPlaceInput): V.Checked<StandinPlaced> {
  const at = o.now.toISOString();
  try {
    return db.transaction((): V.Checked<StandinPlaced> => {
      const req = S.requestOf(db, o.requestId);
      const offer = S.offerOf(db, o.offerId);
      if (!req || req.event_id !== o.eventId || !offer || offer.request_id !== req.id || offer.steamid !== o.steamid || offer.answer !== null) {
        return V.fail('standin_offer_gone');
      }
      if (o.acceptedAt.getTime() >= Date.parse(offer.expires_at)) return V.fail('standin_offer_expired');
      if (req.status !== 'open') return V.fail('standin_closed');
      const ev = E.getEvent(db, req.event_id)!;
      const entry = getEntry(db, req.entry_id)!;
      if (ev.teams_made_at === null || !ROSTER_OPEN.has(ev.status)) return V.fail('wrong_status');
      if (!isActive(entry)) return V.fail('entry_out');
      const place = placesOf(db, entry.id).find((p) => p.steamid === req.out_steamid && p.role === 'starter');
      if (!place) return V.fail('replace_not_starter');
      if (req.scope === 'match') {
        const m = db.prepare('SELECT status FROM event_matches WHERE id = ?').get(req.match_id) as { status: string } | undefined;
        if (!m || m.status === 'done' || m.status === 'forfeit' || m.status === 'bye') return V.fail('standin_match_over');
      }
      const other = entryOfPlayer(db, ev.id, o.steamid);
      if (other) return V.fail('player_entered', [{ steamid: o.steamid, problems: [`Already on ${other.name}'s roster`] }]);
      const elig = E.fieldsOf(ev).eligibility;
      const facts = playerFacts(db, o.steamid, o.now);
      const problems = R.problemsOf(elig, facts, 'starter');
      if (problems.length > 0) return V.fail('replace_ineligible', [{ steamid: o.steamid, problems: problems.map((k) => R.problemText(k, elig, facts)) }]);
      const matches = lineupMatches(db, ev.id, entry.id, req.out_steamid).filter((m) => req.scope === 'event' || m.matchId === req.match_id);
      const onBox = matches.flatMap((m) => m.onBox);
      const value: StandinPlaced = {
        subbedInMatch: matches[0]?.matchId ?? null, requestId: req.id, entryId: entry.id, out: req.out_steamid, in: o.steamid, scope: req.scope, matchId: req.match_id,
      };
      if (o.check) return V.ok({ ...value, onBox });
      if (boxMissing(onBox, o.boxTook)) return V.fail('replace_in_game', [{ steamid: req.out_steamid, problems: [BOX_NOT_ASKED] }]);
      if (req.scope === 'event') db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE id = ?').run(at, place.id);
      addPlace(db, entry.id, o.steamid, req.scope === 'event' ? 'starter' : 'sub', at);
      swapIntoLineups(db, matches, { out: req.out_steamid, in: o.steamid, actor: o.steamid, now: o.now });
      S.markPlaced(db, { requestId: req.id, offerId: offer.id, steamid: o.steamid, at });
      E.logEvent(db, ev.id, o.steamid, 'standin_placed', at, {
        requestId: req.id, entryId: entry.id, out: req.out_steamid, in: o.steamid, scope: req.scope,
        ...(value.subbedInMatch !== null ? { matchId: value.subbedInMatch } : {}),
      });
      return V.ok(value);
    })();
  } catch (err) {
    if (err instanceof Refused) return err.r;
    throw err;
  }
}

/** A match stand-in's match is done, forfeit or bye, or its event ended
 *  (plan D3a Ruling 7): their sub place closes and the request ends, in one
 *  transaction with one 'standin_ended' row. A starter place they hold since
 *  (a later replace) is left alone. */
export function endStandin(db: DB, o: { requestId: number; now: Date }): V.Checked<{ entryId: number; steamid: string }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ entryId: number; steamid: string }> => {
    const req = S.requestOf(db, o.requestId);
    if (!req || req.status !== 'filled' || req.scope !== 'match' || req.filled_by === null) return V.fail('standin_closed');
    if (!S.endableStandins(db).some((x) => x.id === req.id)) return V.fail('standin_running');
    db.prepare("UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ? AND role = 'sub' AND removed_at IS NULL")
      .run(at, req.entry_id, req.filled_by);
    S.markEnded(db, { requestId: req.id, at });
    E.logEvent(db, req.event_id, null, 'standin_ended', at, { requestId: req.id, entryId: req.entry_id, steamid: req.filled_by });
    return V.ok({ entryId: req.entry_id, steamid: req.filled_by });
  })();
}
```

In `src/events/roomClock.ts`, import `{ matchStandins, withStandins } from './standins.js'` and change the timed-out lineup:

```ts
      const auto = R.autoFour({ defaultFour: R.entryPrefs(db, entryId).defaultFour, lastFour: R.lastFour(db, entryId), playable: R.playableOf(db, entryId) });
      // Plan D3a Ruling 7: a match stand-in plays in place of the starter they stand in for.
      const four = withStandins(auto, matchStandins(db, m.id, entryId));
      const r = R.lockLineup(db, { matchId: m.id, steamid: null, side, steamids: four, timers, now });
```

In `tests/eventLogGuard.test.ts`, `DRAFT_ENTRY_MUTATIONS` gains (import `* as S` already added in Task 2):

```ts
      // Plan D3a Task 3: DP[8] (not signed up by balancedDraft) put on the bench and offered the first team's second starter's place.
      placeStandin: {
        action: 'standin_placed',
        setup: (f) => {
          balancedDraft(f);
          must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
          f.db.prepare("INSERT INTO draft_signups (event_id, steamid, captain_pref, created_at, role) VALUES (?, ?, 'no', ?, 'bench')").run(f.eventId, DP[8], NOW.toISOString());
          const entryId = (f.db.prepare('SELECT id FROM event_entries ORDER BY id LIMIT 1').get() as { id: number }).id;
          const { requestId } = must(S.requestStandin(f.db, { eventId: f.eventId, entryId, out: N.rosterOf(f.db, entryId).starters[1]!, scope: 'event', by: ADMIN, staff: true, now: NOW }));
          must(S.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: NOW }));
          must(S.offerNextStandin(f.db, { requestId, now: NOW, minutes: 10 }));
        },
        run: (f) => {
          const o = f.db.prepare('SELECT o.id, o.request_id FROM draft_standin_offers o WHERE o.answer IS NULL').get() as { id: number; request_id: number };
          return N.placeStandin(f.db, { eventId: f.eventId, requestId: o.request_id, offerId: o.id, steamid: DP[8]!, acceptedAt: NOW, now: NOW });
        },
      },
      // A filled match stand-in whose match is gone (test setup writes the rows directly).
      endStandin: {
        action: 'standin_ended',
        setup: (f) => {
          balancedDraft(f);
          must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
          const entryId = (f.db.prepare('SELECT id FROM event_entries ORDER BY id LIMIT 1').get() as { id: number }).id;
          f.db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'sub', ?)").run(entryId, DP[8], NOW.toISOString());
          f.db.prepare(
            `INSERT INTO draft_standins (event_id, entry_id, out_steamid, scope, match_id, margin, status, requested_by, requested_at, filled_by)
             VALUES (?, ?, ?, 'match', NULL, 100, 'filled', ?, ?, ?)`,
          ).run(f.eventId, entryId, N.rosterOf(f.db, entryId).starters[1], ADMIN, NOW.toISOString(), DP[8]);
        },
        run: (f) => N.endStandin(f.db, { requestId: (f.db.prepare('SELECT id FROM draft_standins').get() as { id: number }).id, now: NOW }),
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standinPlace.test.ts tests/draftReplace.test.ts tests/roomClock.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `tests/draftReplace.test.ts` passing unchanged proves the refactor kept D2c's replace exactly.

- [ ] **Step 5: Commit**

```bash
git add src/events/entries.ts src/events/roomClock.ts tests/standinPlace.test.ts tests/eventLogGuard.test.ts
git commit -m "A bench player who accepts a stand-in offer goes onto the team, as a starter for the rest of the event or as a sub for the next match, swapped into a locked lineup without using a sub, the timed-out lineup plays them in place of the missing starter, and a match stand-in leaves the roster once that match is over (plan D3a)"
```

### Task 4: The game server takes a stand-in first

**Files:**
- Modify: `src/events/series.ts`
- Test: `tests/standinSeries.test.ts` (new); `tests/draftReplace.test.ts` must still pass unchanged

**Interfaces:**
- Consumes: Task 3's `N.placeStandin`, `N.StandinPlaceInput`, `N.StandinPlaced`; Task 2's `S.requestOf`; the existing private `parseSubReply`, `this.deps.runner.send/announce/pushAllowList`, `this.alert`, `this.push`, `this.sideOfEntry`, `this.name`, `this.playerName`.
- Produces:
  ```ts
  // SeriesEngine (src/events/series.ts)
  async standinPlace(o: Omit<N.StandinPlaceInput, 'now' | 'check' | 'boxTook'>): Promise<V.Checked<N.StandinPlaced>>;
  // staffReplace keeps its signature; both now run through
  private async swapThroughBox<T extends { subbedInMatch: number | null; onBox?: N.BoxGame[] }>(
    o: { out: string; in: string; entryId: number; what: string; announce: (m: P.MatchRow, side: Side | null) => string },
    run: (x: { check?: boolean; boxTook?: number[] }) => V.Checked<T>,
  ): Promise<V.Checked<T>>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/standinSeries.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as N from '../src/events/entries.js';
import * as R from '../src/events/room.js';
import * as S from '../src/events/standins.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { A, OUTSIDER } from './entryFixture.js';
import { POOL7 } from './roomFixture.js';
import { driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';
import { asDraft, benchOn, offeredFor } from './standinFixture.js';

/** Plan D3a Task 4: a match stand-in accepted while game 1 is on the box. */
describe('a stand-in during a booked series', () => {
  let s: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); s?.close(); });
  const setup = async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    benchOn(s.db, s.eventId, OUTSIDER);
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    return offeredFor(s, s.entryA, A[3]!, 'match', new Date(s.t.t));
  };
  const accept = (o: { requestId: number; offerId: number }) =>
    s.series.standinPlace({ eventId: s.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: new Date(s.t.t) });
  const rows = () => JSON.stringify([
    s.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
    s.db.prepare('SELECT * FROM event_lineups ORDER BY id').all(),
    s.db.prepare('SELECT * FROM match_players ORDER BY rowid').all(),
    s.db.prepare('SELECT * FROM draft_standins ORDER BY id').all(),
    s.db.prepare('SELECT * FROM draft_standin_offers ORDER BY id').all(),
  ]);

  it('between chapters: the box takes the sub first, then the lineup, the game roster and the request follow, and no sub is used', async () => {
    const o = await setup();
    const token = s.liveGameToken();
    s.sent.length = 0;
    const r = await accept(o);
    expect(r.ok && r.value).toMatchObject({ subbedInMatch: s.matchId, scope: 'match', out: A[3], in: OUTSIDER });
    expect(s.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`);
    expect(R.lineupFour(s.db, s.matchId, s.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(s.db, s.match(), 'a')).toBe(0);
    expect(N.rosterOf(s.db, s.entryA)).toMatchObject({ starters: A.slice(0, 4), subs: [OUTSIDER] });
    expect(S.requestOf(s.db, o.requestId)?.status).toBe('filled');
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE player_id = ?').get(OUTSIDER)).toEqual({ n: 1 });
    expect(s.pushes).toContain(s.matchId);
  });

  it('Review Focus 3: mid-chapter the box refuses, nothing is written, and the offer stays open for another press', async () => {
    const o = await setup();
    s.box.subOk = false;
    s.box.subErr = 'not between chapters';
    const before = rows();
    const r = await accept(o);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('replace_in_game');
    expect(!r.ok && r.detail).toEqual([{ steamid: A[3], problems: ['The server said: not between chapters.'] }]);
    expect(rows()).toBe(before);
    expect(S.offerOf(s.db, o.offerId)?.answer).toBeNull();
    // Between chapters the same press goes through.
    s.box.subOk = true;
    expect((await accept(o)).ok).toBe(true);
  });

  it('a stand-in whose offer is gone is refused before the box is asked', async () => {
    const o = await setup();
    s.sent.length = 0;
    const r = await s.series.standinPlace({ eventId: s.eventId, requestId: o.requestId, offerId: o.offerId + 999, steamid: OUTSIDER, acceptedAt: new Date(s.t.t) });
    expect(!r.ok && r.error).toBe('standin_offer_gone');
    expect(s.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/standinSeries.test.ts`
Expected: FAIL (`s.series.standinPlace is not a function`).

- [ ] **Step 3: Implement**

In `src/events/series.ts`, import `* as S from './standins.js';`, replace `staffReplace` and `undoBoxSubs` with the following (same behaviour for a staff replace: the same box lines, alerts and announce; only the wording names "staff replace" or "stand-in"):

```ts
  /** One player swapped for another, the box first (drafts plan D2c Ruling 5;
   *  plan D3a reuses it for a stand-in). `run` is the entries.ts mutation:
   *  called with `check` (every rule, no write, the games on a box that
   *  roster `out`), then each such box is asked to take the sub
   *  (sm_pug_sub, as a captain's !sub), and a box that refuses (mid-chapter)
   *  or does not answer refuses the whole change as replace_in_game with
   *  what it said, with nothing written. Only then is `run` called with the
   *  games that took it. If it is refused at that point (the room moved on
   *  between the two), the box is asked to undo the sub and staff are told.
   *  `what` names the change in the box's log lines and the staff alerts. */
  private async swapThroughBox<T extends { subbedInMatch: number | null; onBox?: N.BoxGame[] }>(
    o: { out: string; in: string; entryId: number; what: string; announce: (m: P.MatchRow, side: Side | null) => string },
    run: (x: { check?: boolean; boxTook?: number[] }) => V.Checked<T>,
  ): Promise<V.Checked<T>> {
    const plan = run({ check: true });
    if (!plan.ok) return plan;
    const took: N.BoxGame[] = [];
    for (const g of plan.value.onBox ?? []) {
      const replies = await this.deps.runner.send(g.bookingId, [`sm_pug_sub ${g.token} ${o.out} ${o.in}`], `the ${o.what}`);
      const reply = parseSubReply(replies?.[0], o.out, o.in);
      if (!reply || !reply.ok) {
        // No answer is a possible take (the reply may be all that was lost), so that box is asked to undo it too.
        const kept = await this.undoBoxSubs(reply ? took : [...took, g], o.out, o.in, o.what);
        const km = kept[0] ? P.getMatch(this.db, kept[0].matchId) : reply ? undefined : P.getMatch(this.db, g.matchId);
        if (km) {
          const what = `a ${o.what} of ${this.playerName(o.out)} by ${this.playerName(o.in)} ${reply ? 'was taken by one server and refused by another' : 'got no answer from the server'}`;
          // The undo got no answer or was refused: the site cannot know which player the box has.
          this.alert(km, kept.length === 0
            ? `${what}; it was asked to undo it and the server undid it.`
            : `${what}; the site could not confirm the server's state: it may have ${this.playerName(o.in)} or ${this.playerName(o.out)}. Check the live roster or use !sub.`);
        }
        console.log(`[series] match ${g.matchId}: the box refused the ${o.what} of ${o.out} by ${o.in} (${reply ? reply.error : 'no answer'})`);
        return V.fail('replace_in_game', [{ steamid: o.out, problems: [reply ? `The server said: ${reply.error}.` : 'The server did not answer.'] }]);
      }
      took.push(g);
    }
    const r = run({ boxTook: took.map((g) => g.gameMatchId) });
    if (!r.ok) {
      const kept = await this.undoBoxSubs(took, o.out, o.in, o.what);
      const m = took[0] ? P.getMatch(this.db, took[0].matchId) : undefined;
      if (m) {
        const what = `a ${o.what} of ${this.playerName(o.out)} by ${this.playerName(o.in)} was taken by the server but then refused on the site (${r.error})`;
        // A refused undo leaves the box with the sub; an unanswered one leaves its state unknown.
        this.alert(m, kept.length === 0
          ? `${what}; the server undid it.`
          : kept.some((k) => k.undo === 'no_answer')
            ? `${what}; the site could not confirm the server's state: it may have ${this.playerName(o.in)} or ${this.playerName(o.out)}. Check the live roster or use !sub.`
            : `${what}, and it was NOT undone: the server has ${this.playerName(o.in)}, the site has ${this.playerName(o.out)}. Put ${this.playerName(o.out)} back in game (!sub) or replace again on the Events desk.`);
      }
      return r;
    }
    if (r.value.subbedInMatch !== null) {
      const m = P.getMatch(this.db, r.value.subbedInMatch);
      const b = m?.booking_id != null ? B.getBooking(this.db, m.booking_id) : undefined;
      if (m && b && B.isOpen(b) && b.server_id !== null) {
        // The player who left the lineup left the booking: the box's allow list now, not at the minute re-push.
        await this.deps.runner.pushAllowList(b.id);
        this.deps.runner.announce(b.id, o.announce(m, this.sideOfEntry(m, o.entryId)));
      }
      this.push(r.value.subbedInMatch);
    }
    return r;
  }

  /** Staff remove a draft player and put a replacement in from the desk
   *  (drafts plan D2c Ruling 5), the box first. */
  async staffReplace(o: {
    eventId: number; entryId: number; out: string; in: string; reason: N.ReplaceReason; note: string | null; actor: string; now?: Date;
  }): Promise<V.Checked<{ subbedInMatch: number | null }>> {
    const at = () => o.now ?? new Date(this.now());
    const r = await this.swapThroughBox(
      {
        out: o.out, in: o.in, entryId: o.entryId, what: 'staff replace',
        announce: (m, side) => `Staff replaced ${this.playerName(o.out)} with ${this.playerName(o.in)}${side ? ` (${this.name(m, side)})` : ''}.`,
      },
      (x) => N.replaceDraftPlayer(this.db, { ...o, now: at(), ...x }),
    );
    return r.ok ? { ok: true, value: { subbedInMatch: r.value.subbedInMatch } } : r;
  }

  /** A bench player accepted a stand-in offer (drafts plan D3a Rulings 6 and
   *  7), the box first, exactly as a staff replace. The window is judged at
   *  acceptedAt, so the seconds the box takes never cost the player it. */
  async standinPlace(o: Omit<N.StandinPlaceInput, 'now' | 'check' | 'boxTook'>): Promise<V.Checked<N.StandinPlaced>> {
    const req = S.requestOf(this.db, o.requestId);
    if (!req) return V.fail('standin_offer_gone');
    return this.swapThroughBox(
      {
        out: req.out_steamid, in: o.steamid, entryId: req.entry_id, what: 'stand-in',
        announce: (m, side) => `${this.playerName(o.steamid)} stands in for ${this.playerName(req.out_steamid)}${side ? ` (${this.name(m, side)})` : ''}.`,
      },
      (x) => N.placeStandin(this.db, { ...o, now: new Date(this.now()), ...x }),
    );
  }

  /** The reverse sub on each box that took a change the site then did not
   *  make; the games whose box did not confirm the undo (parseSubReply). */
  private async undoBoxSubs(games: N.BoxGame[], out: string, inn: string, what: string): Promise<(N.BoxGame & { undo: 'refused' | 'no_answer' })[]> {
    const kept: (N.BoxGame & { undo: 'refused' | 'no_answer' })[] = [];
    for (const g of games) {
      const replies = await this.deps.runner.send(g.bookingId, [`sm_pug_sub ${g.token} ${inn} ${out}`], `undoing the ${what}`);
      const reply = parseSubReply(replies?.[0], inn, out);
      if (!reply || !reply.ok) {
        kept.push({ ...g, undo: reply ? 'refused' : 'no_answer' });
        console.error(`[series] match ${g.matchId}: undoing the ${what} of ${out} by ${inn} on the box failed (${reply ? reply.error : 'no answer'})`);
      }
    }
    return kept;
  }
```

`plan.value.onBox` is typed by `T`'s optional `onBox`, so both callers' result types satisfy the constraint (`replaceDraftPlayer` returns `{ subbedInMatch; onBox? }`, `placeStandin` returns `StandinPlaced`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standinSeries.test.ts tests/draftReplace.test.ts tests/series.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/series.ts tests/standinSeries.test.ts
git commit -m "A stand-in accepted while a game is on a server goes to the server first, exactly as a staff replace does, so a mid-chapter refusal writes nothing and leaves the offer open (plan D3a)"
```

### Task 5: The stand-in flow: DMs, the tick, the stranded note, Discord buttons

**Files:**
- Create: `src/events/standinFlow.ts`, `src/discord/standinButtons.ts`
- Modify: `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts`, `src/server.ts`, `tests/notify.test.ts`, `tests/draftTeams.test.ts` (one expected sentence)
- Test: `tests/standinFlow.test.ts`, `tests/standinButtons.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2 to 4 (`S.*`, `N.placeStandin`, `N.endStandin`, `SeriesEngine.standinPlace`), `addNote(db, steamid, authorId, text)` from `src/admin/players.ts`, `publishAdminEvent`, `tell` (private in `notices.ts`), `STANDIN_OFFER_MINUTES`, `STANDIN_BUTTON_PREFIX`.
- Produces:
  ```ts
  // src/events/standinFlow.ts
  export const STANDIN_TICK_MS = 15_000;
  export type StandinAccept = Omit<N.StandinPlaceInput, 'now' | 'check' | 'boxTook'>;
  export interface StandinDeps extends NoticeDeps {
    series?: { standinPlace(o: StandinAccept): Promise<V.Checked<N.StandinPlaced>> };
    rooms?: { pushChange(matchId: number): void };
    now?: () => number;
  }
  export class Standins {
    constructor(deps: StandinDeps);
    request(o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean }): V.Checked<{ requestId: number }>;
    accept(o: { offerId: number; steamid: string }): Promise<V.Checked<N.StandinPlaced>>;
    decline(o: { offerId: number; steamid: string }): V.Checked<null>;
    cancel(o: { requestId: number; by: string; staff: boolean }): V.Checked<null>;
    marginOff(o: { requestId: number; by: string }): V.Checked<{ reopened: boolean }>;
    tick(): void;
  }
  // src/events/notices.ts
  export function tellStandinOffer(d: NoticeDeps, eventId: number, offerId: number): void;
  export function tellStandinFilled(d: NoticeDeps, eventId: number, requestId: number): void;
  export function tellStandinUnfilled(d: NoticeDeps, eventId: number, requestId: number): void;
  // src/discord/standinButtons.ts
  export function handleStandinButton(deps: { db: DB; publicUrl: string; standins: () => Standins | null }, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply>;
  ```
- New `NotifyType`s: `draft_standin_offer`, `draft_standin_placed`, `draft_standin_filled`, `draft_standin_none`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/standinFlow.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import * as N from '../src/events/entries.js';
import * as S from '../src/events/standins.js';
import { Standins, type StandinDeps } from '../src/events/standinFlow.js';
import type { Notifier } from '../src/notify/notify.js';
import type { MessagePayload } from '../src/discord/transport.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, liveStandins, standinFixture, type StandinFixture } from './standinFixture.js';

const MIN = 60_000;
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
let unsub: (() => void) | null = null;
afterEach(() => { unsub?.(); unsub = null; });

function harness(f: StandinFixture, o: { series?: StandinDeps['series']; t?: { t: number } } = {}) {
  const t = o.t ?? { t: NOW.getTime() };
  const dms: { to: string[]; type: string; payload: MessagePayload }[] = [];
  const send = vi.fn((to: Iterable<string>, type: string, payload: MessagePayload) => { dms.push({ to: [...to], type, payload }); return 1; });
  const alerts: AdminEvent[] = [];
  unsub = subscribeAdminEvents((e) => { alerts.push(e); });
  const pushes: number[] = [];
  const standins = new Standins({
    db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x', now: () => t.t,
    rooms: { pushChange: (id) => { pushes.push(id); } }, ...(o.series ? { series: o.series } : {}),
  });
  return { t, dms, alerts, pushes, standins, last: (type: string) => dms.filter((d) => d.type === type).at(-1) };
}
const askEvent = (h: ReturnType<typeof harness>, f: StandinFixture, out: string) => {
  const e = entryOf(f, out);
  return h.standins.request({ eventId: f.eventId, entryId: e.id, out, scope: 'event', by: e.captain_steamid!, staff: false });
};
const otherStarter = (f: StandinFixture, notOn: number) => {
  const other = f.entries.find((id) => id !== notOn)!;
  return { other, out: N.rosterOf(f.db, other).starters.find((s) => s !== N.getEntry(f.db, other)!.captain_steamid)! };
};

describe('Standins', () => {
  it('asks the bench one at a time by DM: a decline moves on at once, an expiry at the next tick, and an accept places the stand-in and tells everyone', async () => {
    const f = standinFixture();
    const h = harness(f);
    const out = P[11]!;
    const captain = entryOf(f, out).captain_steamid!;
    const { requestId } = must(askEvent(h, f, out));
    const first = h.last('draft_standin_offer')!;
    const offer1 = S.openOfferOf(f.db, requestId)!;
    expect(first.to).toEqual([BENCH[0]]);
    expect(first.payload.components[0]!.map((b) => ('customId' in b ? b.customId : b.url))).toEqual([`ds:a:${offer1.id}`, `ds:d:${offer1.id}`, `https://x/event/${f.slug}`]);
    expect(first.payload.content).toContain('for the rest of the event');
    must(h.standins.decline({ offerId: offer1.id, steamid: BENCH[0]! }));
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[1]]);
    h.t.t += 9 * MIN;
    h.standins.tick();
    expect(S.openOfferOf(f.db, requestId)!.steamid).toBe(BENCH[1]);
    h.t.t += MIN;
    h.standins.tick();
    const offer3 = S.openOfferOf(f.db, requestId)!;
    expect(offer3.steamid).toBe(BENCH[2]);
    expect((await h.standins.accept({ offerId: offer3.id, steamid: BENCH[2]! })).ok).toBe(true);
    expect(entryOf(f, BENCH[2]!).captain_steamid).toBe(captain);
    expect(h.last('draft_standin_placed')!.to).toEqual([BENCH[2]]);
    expect(h.last('draft_standin_placed')!.payload.content).toContain('for the rest of the event');
    expect(h.last('draft_standin_filled')!.to.sort()).toEqual([captain, out].sort());
  });

  it('no takers: staff are alerted with a desk link, the captain is told, and the dropout gets one staff note; lifting the limit asks again', () => {
    const f = standinFixture();
    const h = harness(f);
    const out = P[0]!;
    const captain = entryOf(f, out).captain_steamid!;
    const { requestId } = must(askEvent(h, f, out));
    expect(S.requestOf(f.db, requestId)?.status).toBe('unfilled');
    const alert = h.alerts.find((a): a is Extract<AdminEvent, { kind: 'problem' }> => a.kind === 'problem')!;
    expect(alert.text).toContain('nobody on the bench took the stand-in');
    expect(alert.link).toEqual({ label: 'Open the Events desk', path: `/admin/events/${f.eventId}` });
    expect(h.last('draft_standin_none')!.to).toEqual([captain]);
    const notes = () => f.db.prepare('SELECT author_id, text FROM player_notes WHERE player_id = ?').all(out) as { author_id: string; text: string }[];
    expect(notes()).toEqual([{ author_id: 'system', text: expect.stringContaining('no stand-in was found on the bench') }]);
    expect(must(h.standins.marginOff({ requestId, by: ADMIN }))).toEqual({ reopened: true });
    for (const s of BENCH) {
      const o = S.openOfferOf(f.db, requestId)!;
      expect(o.steamid).toBe(s);
      must(h.standins.decline({ offerId: o.id, steamid: s! }));
    }
    expect(S.requestOf(f.db, requestId)?.status).toBe('unfilled');
    expect(notes()).toHaveLength(1);
  });

  it('a match request that goes unfilled writes no note', async () => {
    const f = await liveStandins();
    const h = harness(f);
    const out = P[0]!;
    const e = entryOf(f, out);
    must(h.standins.request({ eventId: f.eventId, entryId: e.id, out, scope: 'match', by: e.captain_steamid!, staff: false }));
    expect(h.last('draft_standin_none')).toBeDefined();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_notes').get()).toEqual({ n: 0 });
  });

  it('Review Focus 1: a tick while an accept is with the game server never expires that offer, and the press time decides', async () => {
    const f = standinFixture();
    const t = { t: NOW.getTime() };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const series = { standinPlace: vi.fn(async (o: Parameters<NonNullable<StandinDeps['series']>['standinPlace']>[0]) => { await gate; return N.placeStandin(f.db, { ...o, now: new Date(t.t) }); }) };
    const h = harness(f, { series, t });
    const { requestId } = must(askEvent(h, f, P[11]!));
    const offer = S.openOfferOf(f.db, requestId)!;
    t.t += 10 * MIN - 1000;
    const pending = h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! });
    t.t += 5000;
    h.standins.tick();
    expect(S.offerOf(f.db, offer.id)?.answer).toBeNull();
    expect((await h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! })).ok).toBe(false);
    release();
    expect((await pending).ok).toBe(true);
    expect(S.requestOf(f.db, requestId)).toMatchObject({ status: 'filled', filled_by: BENCH[0] });
  });

  it('an accept by a player placed elsewhere since fails that offer and asks the next', async () => {
    const f = standinFixture();
    const h = harness(f);
    const { requestId } = must(askEvent(h, f, P[11]!));
    const o1 = S.openOfferOf(f.db, requestId)!;
    const x = otherStarter(f, entryOf(f, P[11]!).id);
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: x.other, out: x.out, in: BENCH[0]!, reason: 'other', note: null, actor: ADMIN, now: NOW }));
    const r = await h.standins.accept({ offerId: o1.id, steamid: BENCH[0]! });
    expect(!r.ok && r.error).toBe('player_entered');
    expect(S.offerOf(f.db, o1.id)?.answer).toBe('failed');
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[1]]);
  });

  it('Review Focus 5: a match stand-in leaves the roster once the match is over and is back on the bench for the next request', async () => {
    const f = await liveStandins();
    const h = harness(f);
    const out = P[11]!;
    const entry = entryOf(f, out);
    must(h.standins.request({ eventId: f.eventId, entryId: entry.id, out, scope: 'match', by: entry.captain_steamid!, staff: false }));
    const req = S.requestsOf(f.db, f.eventId)[0]!;
    const offer = S.openOfferOf(f.db, req.id)!;
    expect(h.last('draft_standin_offer')!.payload.content).toContain('for their next match, against');
    must(await h.standins.accept({ offerId: offer.id, steamid: BENCH[0]! }));
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([BENCH[0]]);
    h.standins.tick();
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([BENCH[0]]);
    // Test setup only: the match is over.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(req.match_id);
    h.standins.tick();
    expect(N.rosterOf(f.db, entry.id).subs).toEqual([]);
    expect(S.requestOf(f.db, req.id)?.status).toBe('ended');
    expect(h.pushes).toContain(req.match_id);
    must(askEvent(h, f, P[10]!));
    expect(h.last('draft_standin_offer')!.to).toEqual([BENCH[0]]);
  });
});
```

```ts
// tests/standinButtons.test.ts
import { describe, it, expect } from 'vitest';
import { handleStandinButton } from '../src/discord/standinButtons.js';
import * as N from '../src/events/entries.js';
import * as S from '../src/events/standins.js';
import { Standins } from '../src/events/standinFlow.js';
import { eventMessage } from '../src/events/messages.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { entryOf, liveStandins, standinFixture, type StandinFixture } from './standinFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
/** draftFixture links P[i] to Discord id dd<i>. */
const discordOf = (steamid: string) => `dd${P.indexOf(steamid)}`;
const flow = (f: StandinFixture) => new Standins({ db: f.db, now: () => NOW.getTime() });
const press = (f: StandinFixture, s: Standins | null, customId: string, userId: string) =>
  handleStandinButton({ db: f.db, publicUrl: 'https://x', standins: () => s }, { kind: 'button', customId, userId } as never);
const opened = (f: StandinFixture, s: Standins) => {
  const e = entryOf(f, P[11]!);
  const { requestId } = must(s.request({ eventId: f.eventId, entryId: e.id, out: P[11]!, scope: 'event', by: e.captain_steamid!, staff: false }));
  return S.openOfferOf(f.db, requestId)!;
};

describe('the captain\'s team DM', () => {
  it('carries a stand-in button for each of their three, then the event link', () => {
    const f = standinFixture();
    const entry = N.getEntry(f.db, f.entries[0]!)!;
    const p = eventMessage(f.db, 'https://x', f.eventId, 'draft_team_made', { entryId: entry.id, captain: true })!;
    const others = N.rosterOf(f.db, entry.id).starters.filter((s) => s !== entry.captain_steamid);
    expect(p.components[0]!.map((b) => ('customId' in b ? b.customId : null))).toEqual(others.map((s) => `ds:r:${entry.id}:${s}`));
    expect(p.components.at(-1)).toEqual([{ kind: 'link', url: `https://x/event/${f.slug}`, label: 'Open the event' }]);
    expect(eventMessage(f.db, 'https://x', f.eventId, 'draft_team_made', { entryId: entry.id })!.components).toHaveLength(1);
  });
});

describe('handleStandinButton', () => {
  it('Accept places the linked offeree; anyone else, or an unlinked account, is refused and the offer stays', async () => {
    const f = standinFixture();
    const s = flow(f);
    const offer = opened(f, s);
    expect((await press(f, s, `ds:a:${offer.id}`, discordOf(P[13]!))).payload.content).toBe(EVENT_ERRORS.standin_offer_gone.text);
    expect((await press(f, s, `ds:a:${offer.id}`, 'd-nobody')).payload.content).toMatch(/Link this Discord account/);
    expect(S.offerOf(f.db, offer.id)?.answer).toBeNull();
    const ok = await press(f, s, `ds:a:${offer.id}`, discordOf(offer.steamid));
    expect(ok.payload.content).toContain('for the rest of the event');
    expect(S.offerOf(f.db, offer.id)?.answer).toBe('accept');
  });

  it('Decline moves the offer on', async () => {
    const f = standinFixture();
    const s = flow(f);
    const offer = opened(f, s);
    expect((await press(f, s, `ds:d:${offer.id}`, discordOf(offer.steamid))).payload.content).toBe('You declined. The next bench player is asked.');
    expect(S.openOfferOf(f.db, offer.request_id)?.steamid).toBe(P[13]);
  });

  it('the captain\'s button asks the bench for the next match; anyone else is refused', async () => {
    const f = await liveStandins();
    const s = flow(f);
    const e = entryOf(f, P[11]!);
    expect((await press(f, s, `ds:r:${e.id}:${P[11]}`, discordOf(P[11]!))).payload.content).toBe(EVENT_ERRORS.not_manager.text);
    const r = await press(f, s, `ds:r:${e.id}:${P[11]}`, discordOf(e.captain_steamid!));
    expect(r.payload.content).toContain('The bench is being asked');
    expect(S.requestsOf(f.db, f.eventId)).toMatchObject([{ scope: 'match', out_steamid: P[11] }]);
  });

  it('says so when the switch is closed or the flow is not running', async () => {
    const f = standinFixture();
    expect((await press(f, null, 'ds:a:1', discordOf(P[12]!))).payload.content).toMatch(/starting up/);
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await press(f, flow(f), 'ds:a:1', discordOf(P[12]!))).payload.content).toBe('Events are not open yet.');
  });
});
```

In `tests/notify.test.ts`, next to the `draft_room_open` assertion:

```ts
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_standin_offer')).toEqual({ type: 'draft_standin_offer', label: 'Draft: a bench stand-in place is offered to me' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_standin_placed')).toEqual({ type: 'draft_standin_placed', label: 'Draft: I am placed on a team as a stand-in' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_standin_filled')).toEqual({ type: 'draft_standin_filled', label: 'Draft: a stand-in was found for a player on my team' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_standin_none')).toEqual({ type: 'draft_standin_none', label: 'Draft: nobody on the bench took a stand-in my team asked for' });
```

In `tests/draftTeams.test.ts` line 442, the captain's expected content gains one sentence at the end:
`` `Your team in Draft Night is set: ${others[0]}, ${others[1]} and ${others[2]}. Name your team and upload a logo before the event starts: ${link} If one of them cannot make a match, press their stand-in button below and the bench is asked.` ``

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/standinFlow.test.ts tests/standinButtons.test.ts tests/notify.test.ts`
Expected: FAIL (`src/events/standinFlow.ts` and `src/discord/standinButtons.ts` do not exist; the labels are missing).

- [ ] **Step 3: Implement**

`src/notify/notify.ts`: append the four types to the `NotifyType` union and to `NOTIFY_TYPES` with the labels the test reads. `src/events/messages.ts`: append the same four to `EventNotifyType`.

`src/events/messages.ts` additions (imports first):

```ts
import type { ActionRow } from '../discord/transport.js';
import { STANDIN_BUTTON_PREFIX } from './draftRules.js';
import { offerOf, requestOf, type StandinRow } from './standins.js';

const nameIn = (db: DB, steamid: string): string => escapeName(getPlayer(db, steamid)?.name ?? steamid);
/** A Discord button label: plain text, at most 80 characters. */
const buttonLabel = (s: string): string => Array.from(s).slice(0, 80).join('');

/** Plan D3a: what the stand-in is for, with the opponent when the match has one. */
function standinScopeText(db: DB, req: StandinRow): string {
  if (req.scope === 'event') return 'for the rest of the event';
  const m = req.match_id !== null ? P.getMatch(db, req.match_id) : undefined;
  const otherId = m ? (m.entry_a === req.entry_id ? m.entry_b : m.entry_a) : null;
  const other = otherId !== null && otherId !== undefined ? getEntry(db, otherId)?.name : undefined;
  return other ? `for their next match, against ${escapeName(other)}` : 'for their next match';
}
```

`eventMessage`'s `extra` gains `offerId?: number; requestId?: number`. Before the `switch`, declare `let rows: ActionRow[] = [];`, and the final `return` becomes `components: [...rows, [{ kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' }]]`. In `case 'draft_team_made'`, the captain branch becomes:

```ts
      if (extra.captain) {
        const ids = rosterOf(db, entry.id).starters.filter((s) => s !== entry.captain_steamid);
        const others = ids.map(nameOf);
        const names = others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others.at(-1)}` : others.join('');
        content = `Your team in ${event} is set: ${names}. Name your team and upload a logo before the event starts: ${link} If one of them cannot make a match, press their stand-in button below and the bench is asked.`;
        // Plan D3a Ruling 2: one button per player, a stand-in for the team's next match.
        rows = [ids.map((s) => ({ kind: 'button' as const, customId: `${STANDIN_BUTTON_PREFIX}r:${entry.id}:${s}`, label: buttonLabel(`Stand-in for ${getPlayer(db, s)?.name ?? s}`), style: 'secondary' as const }))];
      }
```

and the four new cases:

```ts
    case 'draft_standin_offer': {
      // Plan D3a Ruling 5: Accept and Decline on the DM itself.
      const offer = extra.offerId !== undefined ? offerOf(db, extra.offerId) : undefined;
      const req = offer ? requestOf(db, offer.request_id) : undefined;
      const e = req ? getEntry(db, req.entry_id) : undefined;
      if (!offer || !req || !e) return null;
      return {
        content: `${escapeName(e.name)} in ${event} needs a stand-in for ${nameIn(db, req.out_steamid)} ${standinScopeText(db, req)}. You are on the bench and the closest in SR who is free. Accept by ${discordTime(offer.expires_at)}, or it goes to the next player.`,
        embeds: [],
        components: [[
          { kind: 'button', customId: `${STANDIN_BUTTON_PREFIX}a:${offer.id}`, label: 'Accept', style: 'success' },
          { kind: 'button', customId: `${STANDIN_BUTTON_PREFIX}d:${offer.id}`, label: 'Decline', style: 'secondary' },
          { kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' },
        ]],
        mentionUserIds: [],
      };
    }
    case 'draft_standin_placed': {
      const req = extra.requestId !== undefined ? requestOf(db, extra.requestId) : undefined;
      if (!req || !entry || entry.captain_steamid === null) return null;
      const captain = nameIn(db, entry.captain_steamid);
      content = req.scope === 'match'
        ? `You are standing in for ${nameIn(db, req.out_steamid)} on ${team} in ${event} ${standinScopeText(db, req)}. Your captain is ${captain}; the match room DMs you when it opens: ${publicUrl}/event/${ev.slug}`
        : `You are now on ${team} in ${event} for the rest of the event, in place of ${nameIn(db, req.out_steamid)}. Your captain is ${captain}: ${publicUrl}/event/${ev.slug}`;
      break;
    }
    case 'draft_standin_filled': {
      const req = extra.requestId !== undefined ? requestOf(db, extra.requestId) : undefined;
      if (!req || req.filled_by === null) return null;
      content = `${nameIn(db, req.filled_by)} is standing in for ${nameIn(db, req.out_steamid)} on ${team} in ${event} ${standinScopeText(db, req)}.`;
      break;
    }
    case 'draft_standin_none': {
      const req = extra.requestId !== undefined ? requestOf(db, extra.requestId) : undefined;
      if (!req) return null;
      content = `Nobody on the bench took the stand-in for ${nameIn(db, req.out_steamid)} on ${team} in ${event} (${req.scope === 'match' ? 'next match' : 'rest of the event'}). Staff were told and will help: a delay, a wider search, or a forfeit if it comes to that.`;
      break;
    }
```

`src/events/notices.ts` additions (import `{ offerOf, requestOf } from './standins.js'`):

```ts
/** A stand-in offer went out (plan D3a Ruling 5): the bench player, with Accept and Decline. */
export function tellStandinOffer(d: NoticeDeps, eventId: number, offerId: number): void {
  const o = offerOf(d.db, offerId);
  if (o) tell(d, [o.steamid], eventId, 'draft_standin_offer', { offerId });
}
/** A stand-in was placed: the stand-in (where and for how long), and the captain and the missing player (who). */
export function tellStandinFilled(d: NoticeDeps, eventId: number, requestId: number): void {
  const r = requestOf(d.db, requestId);
  const entry = r ? N.getEntry(d.db, r.entry_id) : undefined;
  if (!r || !entry || entry.captain_steamid === null || r.filled_by === null) return;
  tell(d, [r.filled_by], eventId, 'draft_standin_placed', { requestId, entryId: entry.id });
  tell(d, [entry.captain_steamid, r.out_steamid], eventId, 'draft_standin_filled', { requestId, entryId: entry.id });
}
/** Nobody took it (Ruling 11): the captain. Staff hear it on the admin feed. */
export function tellStandinUnfilled(d: NoticeDeps, eventId: number, requestId: number): void {
  const r = requestOf(d.db, requestId);
  const entry = r ? N.getEntry(d.db, r.entry_id) : undefined;
  if (!r || !entry || entry.captain_steamid === null) return;
  tell(d, [entry.captain_steamid], eventId, 'draft_standin_none', { requestId, entryId: entry.id });
}
```

`src/events/standinFlow.ts`:

```ts
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { addNote } from '../admin/players.js';
import { getPlayer } from '../players.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as S from './standins.js';
import * as V from './validate.js';
import { STANDIN_OFFER_MINUTES } from './draftRules.js';
import { tellStandinFilled, tellStandinOffer, tellStandinUnfilled, type NoticeDeps } from './notices.js';

/** How often the tick runs: expiries move on within this long of the window's end. */
export const STANDIN_TICK_MS = 15_000;
export type StandinAccept = Omit<N.StandinPlaceInput, 'now' | 'check' | 'boxTook'>;
export interface StandinDeps extends NoticeDeps {
  /** The series engine: a placement that touches a game on a box asks the box first (Task 4). */
  series?: { standinPlace(o: StandinAccept): Promise<V.Checked<N.StandinPlaced>> };
  /** The room clock: match rooms refresh after a change made without the series engine. */
  rooms?: { pushChange(matchId: number): void };
  now?: () => number;
}

/** Refusals about the request itself: it is closed (Ruling 12). */
const REQUEST_GONE: ReadonlySet<V.EventError> = new Set<V.EventError>(['replace_not_starter', 'standin_match_over', 'wrong_status', 'entry_out', 'replace_not_possible', 'standin_closed']);
/** Refusals about the player who accepted: the next one is asked. */
const PLAYER_OUT: ReadonlySet<V.EventError> = new Set<V.EventError>(['player_entered', 'replace_ineligible']);

/**
 * Bench stand-ins, end to end (drafts plan D3a): the routes, the Discord
 * buttons and the tick all go through here, so a request made on the desk,
 * the event page or Discord moves the same way. Every database change is a
 * standins.ts or entries.ts mutation; this class only sequences them and
 * tells people after each commit. The offers in flight (an accept waiting on
 * the game server) are held in memory so the tick never expires one under
 * its placement (Review Focus 1); a restart loses nothing but that guard.
 */
export class Standins {
  private readonly inFlight = new Set<number>();
  private ticking = false;

  constructor(private readonly deps: StandinDeps) {}

  private get db(): DB { return this.deps.db; }
  private date(): Date { return new Date((this.deps.now ?? Date.now)()); }

  /** A captain or staff ask (Rulings 1 and 2); the first offer goes out at once. */
  request(o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean }): V.Checked<{ requestId: number }> {
    const r = S.requestStandin(this.db, { ...o, now: this.date() });
    if (r.ok) this.advance(r.value.requestId);
    return r;
  }

  /** The offered player presses Accept. The window is judged at this press. */
  async accept(o: { offerId: number; steamid: string }): Promise<V.Checked<N.StandinPlaced>> {
    const acceptedAt = this.date();
    const offer = S.offerOf(this.db, o.offerId);
    const req = offer ? S.requestOf(this.db, offer.request_id) : undefined;
    if (!offer || !req || offer.steamid !== o.steamid || offer.answer !== null || this.inFlight.has(offer.id)) return V.fail('standin_offer_gone');
    this.inFlight.add(offer.id);
    try {
      const input: StandinAccept = { eventId: req.event_id, requestId: req.id, offerId: offer.id, steamid: o.steamid, acceptedAt };
      const r = this.deps.series ? await this.deps.series.standinPlace(input) : N.placeStandin(this.db, { ...input, now: acceptedAt });
      if (!r.ok) {
        this.refused(req.id, offer.id, r.error);
        return r;
      }
      tellStandinFilled(this.deps, req.event_id, req.id);
      // The series engine pushes the room itself.
      if (!this.deps.series && r.value.subbedInMatch !== null) this.deps.rooms?.pushChange(r.value.subbedInMatch);
      return r;
    } finally {
      this.inFlight.delete(offer.id);
    }
  }

  decline(o: { offerId: number; steamid: string }): V.Checked<null> {
    const r = S.declineStandinOffer(this.db, { ...o, now: this.date() });
    const offer = S.offerOf(this.db, o.offerId);
    if (offer && (r.ok || r.error === 'standin_offer_expired')) this.advance(offer.request_id);
    return r.ok ? V.ok(null) : r;
  }

  cancel(o: { requestId: number; by: string; staff: boolean }): V.Checked<null> {
    return S.cancelStandin(this.db, { ...o, now: this.date() });
  }

  /** Ruling 4: staff lift the SR limit; the next offer goes out at once. */
  marginOff(o: { requestId: number; by: string }): V.Checked<{ reopened: boolean }> {
    const r = S.setStandinMarginOff(this.db, { requestId: o.requestId, actor: o.by, now: this.date() });
    if (r.ok) this.advance(o.requestId);
    return r;
  }

  /** Every STANDIN_TICK_MS: due offers expire and the next player is asked;
   *  match stand-ins whose match is over leave their team. Each request is
   *  caught on its own. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.date();
      for (const req of S.openRequests(this.db)) {
        try {
          const open = S.openOfferOf(this.db, req.id);
          if (open && (this.inFlight.has(open.id) || Date.parse(open.expires_at) > now.getTime())) continue;
          if (open) S.expireStandinOffer(this.db, { requestId: req.id, now });
          this.advance(req.id);
        } catch (err) {
          console.error(`[standins] request ${req.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
      for (const req of S.endableStandins(this.db)) {
        try {
          const r = N.endStandin(this.db, { requestId: req.id, now });
          if (r.ok && req.match_id !== null) this.deps.rooms?.pushChange(req.match_id);
        } catch (err) {
          console.error(`[standins] ending stand-in ${req.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Ruling 12: what a refused accept does to the chain. */
  private refused(requestId: number, offerId: number, error: V.EventError): void {
    const now = this.date();
    if (error === 'standin_offer_expired') {
      S.expireStandinOffer(this.db, { requestId, now });
      this.advance(requestId);
      return;
    }
    if (!PLAYER_OUT.has(error) && !REQUEST_GONE.has(error)) return;
    const f = S.failStandinOffer(this.db, { offerId, why: error, cancel: REQUEST_GONE.has(error), now });
    if (f.ok && PLAYER_OUT.has(error)) this.advance(requestId);
  }

  /** Offer the next bench player, or close the request and tell people. */
  private advance(requestId: number): void {
    const step = S.offerNextStandin(this.db, { requestId, now: this.date(), minutes: STANDIN_OFFER_MINUTES });
    if (!step.ok) return;
    const req = S.requestOf(this.db, requestId)!;
    if (step.value.offerId !== null) tellStandinOffer(this.deps, req.event_id, step.value.offerId);
    else if (step.value.unfilled) this.unfilled(req);
  }

  /** Rulings 10 and 11: no takers. */
  private unfilled(req: S.StandinRow): void {
    const ev = E.getEvent(this.db, req.event_id);
    const entry = N.getEntry(this.db, req.entry_id);
    if (!ev || !entry) return;
    const out = getPlayer(this.db, req.out_steamid)?.name ?? req.out_steamid;
    tellStandinUnfilled(this.deps, ev.id, req.id);
    publishAdminEvent({
      kind: 'problem',
      text: `Draft ${ev.name}: nobody on the bench took the stand-in for ${out} on ${entry.name} (${req.scope === 'match' ? 'next match' : 'rest of the event'}). Hold or forfeit the match, or offer without the SR limit.`,
      link: { label: 'Open the Events desk', path: `/admin/events/${ev.id}` },
    });
    if (req.scope !== 'event' || S.unfilledCount(this.db, req.id) !== 1) return;
    try {
      addNote(this.db, req.out_steamid, 'system', `Left ${entry.name} in ${ev.name} after the draft; no stand-in was found on the bench (stand-in request ${req.id}).`);
    } catch (err) {
      console.error(`[standins] the stranded note for request ${req.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
```

`src/discord/standinButtons.ts`:

```ts
import type { DB } from '../db.js';
import type { BotInteraction, InteractionReply } from './transport.js';
import { escapeName } from '../identity.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as V from '../events/validate.js';
import type { Standins } from '../events/standinFlow.js';

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });
const refusal = (r: { error: V.EventError; detail?: V.EntryProblem[] }): string =>
  [V.EVENT_ERRORS[r.error].text, ...(r.detail ?? []).flatMap((p) => p.problems)].join(' ');

/**
 * The stand-in buttons (drafts plan D3a). Custom ids: ds:a:<offerId> and
 * ds:d:<offerId> on a bench player's offer DM; ds:r:<entryId>:<steamid> on a
 * captain's team DM (a stand-in for that player's next match). The Discord id
 * authorises nothing by itself: it resolves to the linked player, and the
 * flow checks that player exactly as the site's routes do, so a forwarded DM
 * does nothing.
 */
export async function handleStandinButton(
  deps: { db: DB; publicUrl: string; standins: () => Standins | null }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, kind, a, b] = i.customId.split(':');
  const standins = deps.standins();
  if (!standins) return say('Stand-ins are starting up. Try again in a minute.');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  if (!competitiveAccess(deps.db, player.steamid)) return say('Events are not open yet.');
  if (kind === 'a' || kind === 'd') {
    const offerId = Number(a);
    if (!Number.isInteger(offerId)) return say('That button no longer does anything.');
    if (kind === 'd') {
      const r = standins.decline({ offerId, steamid: player.steamid });
      return say(r.ok ? 'You declined. The next bench player is asked.' : refusal(r));
    }
    const r = await standins.accept({ offerId, steamid: player.steamid });
    if (!r.ok) return say(refusal(r));
    const entry = N.getEntry(deps.db, r.value.entryId);
    const ev = entry ? E.getEvent(deps.db, entry.event_id) : undefined;
    const what = r.value.scope === 'match' ? 'for their next match' : 'for the rest of the event';
    return say(`You are in: standing in on ${escapeName(entry?.name ?? 'the team')} ${what}.${ev ? ` ${deps.publicUrl}/event/${ev.slug}` : ''}`);
  }
  if (kind === 'r') {
    const entry = N.getEntry(deps.db, Number(a));
    if (!entry || typeof b !== 'string' || b === '') return say('That button no longer does anything.');
    const r = standins.request({ eventId: entry.event_id, entryId: entry.id, out: b, scope: 'match', by: player.steamid, staff: false });
    if (!r.ok) return say(refusal(r));
    return say('The bench is being asked, closest SR first. You get a DM when someone accepts, or if nobody does. Cancel on the event page if you pressed this by mistake.');
  }
  return say('That button no longer does anything.');
}
```

The button test's "starting up" case passes `null` before the link check on purpose: with no flow there is nothing to check against.

`src/server.ts`:
- imports: `import { STANDIN_TICK_MS, Standins } from './events/standinFlow.js';`, `import { handleStandinButton } from './discord/standinButtons.js';`, `import { STANDIN_BUTTON_PREFIX } from './events/draftRules.js';`
- next to `let reporterChats: ReporterChats | null = null;`: `let standinsRef: Standins | null = null;`
- in `extraButtons`, after the team button: `[STANDIN_BUTTON_PREFIX]: (i) => handleStandinButton({ db: deps.db, publicUrl: deps.config.publicUrl, standins: () => standinsRef }, i),`
- right after `await app.register(adminEventRoutes, ...)`:

```ts
  // Drafts plan D3a: bench stand-ins. Offers go out by DM one at a time; the
  // tick expires due ones, asks the next player, and ends match stand-ins
  // whose match is over. Accepts go through the series engine, which asks a
  // game server first when the change touches a game on it.
  const standins = new Standins({ db: deps.db, notifier, publicUrl: deps.config.publicUrl, series, rooms: roomClock });
  standinsRef = standins;
  const standinTick = setInterval(() => standins.tick(), STANDIN_TICK_MS);
  standinTick.unref();
  app.addHook('onClose', async () => { clearInterval(standinTick); });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standinFlow.test.ts tests/standinButtons.test.ts tests/notify.test.ts tests/draftTeams.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/standinFlow.ts src/discord/standinButtons.ts src/notify/notify.ts src/events/messages.ts src/events/notices.ts src/server.ts tests/standinFlow.test.ts tests/standinButtons.test.ts tests/notify.test.ts tests/draftTeams.test.ts
git commit -m "Stand-in offers reach bench players by Discord DM with Accept and Decline, captains can ask from their team DM, the tick moves expired offers on and sends match stand-ins back to the bench, and a request nobody takes alerts staff, tells the captain and notes a stranded dropout on their profile (plan D3a)"
```

### Task 6: Routes and views for captains, bench players and the desk

**Files:**
- Create: `src/events/standinViews.ts`, `src/routes/standins.ts`
- Modify: `src/server.ts`
- Test: `tests/standinRoutes.test.ts` (new)

**Interfaces:**
- Consumes: Task 5's `Standins`; Task 2's reads; `D.setStandinMargin`; `N.entriesOf`, `N.rosterOf`, `N.getEntry`, `N.isActive`, `N.playerFacts`; guards `makeOptionalViewer`, `makeRequireActive`, `makeRequireAdmin`, `makeRequireMod`; `logAdmin(db, adminId, action, target, detail)`.
- Produces:
  ```ts
  // src/events/standinViews.ts
  export interface StandinRequestView {
    id: number; out: { steamid: string; name: string }; scope: S.StandinScope; status: S.StandinStatus;
    /** How many bench players were asked so far; never who (Ruling 14). */
    asked: number; standin: string | null; requestedAt: string; marginOff: boolean;
  }
  export interface MyStandinView {
    offer: { offerId: number; team: string; out: string; scope: S.StandinScope; expiresAt: string } | null;
    captain: { entryId: number; team: string; starters: { steamid: string; name: string; captain: boolean }[];
      requests: StandinRequestView[]; open: boolean; canMatch: boolean } | null;
  }
  export interface AdminStandinOfferView { steamid: string; name: string; sr: number; answer: string | null; offeredAt: string; expiresAt: string }
  export interface AdminStandinView extends StandinRequestView { entryId: number; team: string; margin: number; offers: AdminStandinOfferView[] }
  export function myStandinView(db: DB, ev: E.EventRow, viewer: string): MyStandinView;
  export interface AdminStandinTeamView { entryId: number; name: string; starters: { steamid: string; name: string }[] }
  export function adminStandinViews(db: DB, ev: E.EventRow): { margin: number; open: boolean; teams: AdminStandinTeamView[]; requests: AdminStandinView[] };
  // src/routes/standins.ts
  export async function standinRoutes(app: FastifyInstance, opts: { db: DB; standins: Standins }): Promise<void>;
  ```
- Routes:
  - `GET /api/events/:slug/standins` (signed in) → `MyStandinView`
  - `POST /api/events/:slug/standins` `{ entryId, out, scope }` → `{ requestId }`
  - `POST /api/events/:slug/standins/:id/cancel` → `{ ok: true }`
  - `POST /api/events/:slug/standin-offers/:id` `{ accept }` → `{ ok: true }`
  - `GET /api/admin/events/:id/standins` (mods) → `{ margin, open, teams, requests }`
  - `POST /api/admin/events/:id/standins` `{ entryId, out, scope }`, `POST .../standins/:rid/cancel`, `POST .../standins/:rid/margin-off`, `POST /api/admin/events/:id/standin-margin` `{ margin }` (admins, `logAdmin` after commit)

- [ ] **Step 1: Write the failing test**

```ts
// tests/standinRoutes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { standinRoutes } from '../src/routes/standins.js';
import { Standins } from '../src/events/standinFlow.js';
import * as S from '../src/events/standins.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import { getPlayer } from '../src/players.js';
import { authedCookie } from './helpers.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, standinFixture, type StandinFixture } from './standinFixture.js';

const MOD = '76561199000000777';
let f: StandinFixture;
let app: FastifyInstance;

async function build(fx: StandinFixture): Promise<void> {
  f = fx;
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(standinRoutes, { db: f.db, standins: new Standins({ db: f.db, now: () => NOW.getTime() }) });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who: string) => app.inject({ method: 'GET', url, cookies: as(who) });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const pub = (p = '') => `/api/events/${f.slug}${p}`;
const desk = (p: string) => `/api/admin/events/${f.eventId}${p}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });

describe('the event page routes', () => {
  it('a captain sees their four, asks for a stand-in, and sees its status but never who was asked or any SR', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const captain = e.captain_steamid!;
    const v0 = (await get(pub('/standins'), captain)).json();
    expect(v0.offer).toBeNull();
    expect(v0.captain).toMatchObject({ entryId: e.id, open: true, canMatch: false, requests: [] });
    expect(v0.captain.starters).toHaveLength(4);
    const res = await post(pub('/standins'), captain, { entryId: e.id, out, scope: 'event' });
    expect(res.statusCode).toBe(200);
    const { requestId } = res.json();
    const v1 = (await get(pub('/standins'), captain)).json();
    expect(v1.captain.requests).toEqual([{
      id: requestId, out: { steamid: out, name: getPlayer(f.db, out)!.name }, scope: 'event', status: 'open', asked: 1, standin: null,
      requestedAt: NOW.toISOString(), marginOff: false,
    }]);
    const body = JSON.stringify(v1);
    expect(body).not.toContain(BENCH[0]!);
    expect(body).not.toContain('"sr"');
  });

  it('the bench player sees their offer, declines it, and the next player accepts; the captain then sees the stand-in', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const { requestId } = (await post(pub('/standins'), e.captain_steamid!, { entryId: e.id, out, scope: 'event' })).json();
    const mine = (await get(pub('/standins'), BENCH[0]!)).json();
    expect(mine.captain).toBeNull();
    expect(mine.offer).toMatchObject({ team: e.name, out: getPlayer(f.db, out)!.name, scope: 'event', expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    expect((await post(pub(`/standin-offers/${mine.offer.offerId}`), BENCH[0]!, { accept: false })).statusCode).toBe(200);
    const next = (await get(pub('/standins'), BENCH[1]!)).json();
    expect((await post(pub(`/standin-offers/${next.offer.offerId}`), BENCH[0]!, { accept: true })).json()).toEqual(text('standin_offer_gone'));
    expect((await post(pub(`/standin-offers/${next.offer.offerId}`), BENCH[1]!, { accept: true })).statusCode).toBe(200);
    const v = (await get(pub('/standins'), e.captain_steamid!)).json();
    expect(v.captain.requests[0]).toMatchObject({ id: requestId, status: 'filled', standin: getPlayer(f.db, BENCH[1]!)!.name });
  });

  it('refuses a player who is not the captain, a bad body, a team event, and a closed switch', async () => {
    await build(standinFixture());
    const out = P[11]!;
    const e = entryOf(f, out);
    const notCaptain = e.captain_steamid === P[0] ? P[1]! : P[0]!;
    const r = await post(pub('/standins'), notCaptain, { entryId: e.id, out, scope: 'event' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual(text('not_manager'));
    expect((await post(pub('/standins'), e.captain_steamid!, { out })).json()).toEqual(text('bad_request'));
    expect((await post(pub(`/standins/999/cancel`), e.captain_steamid!)).json()).toEqual(text('standin_closed'));
    // Test setup only: the same event read as a team event.
    f.db.prepare("UPDATE events SET entry_kind = 'team' WHERE id = ?").run(f.eventId);
    expect((await get(pub('/standins'), e.captain_steamid!)).json()).toEqual(text('not_draft'));
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await get(pub('/standins'), e.captain_steamid!)).statusCode).toBe(404);
  });

  it('a captain cancels their open request', async () => {
    await build(standinFixture());
    const e = entryOf(f, P[11]!);
    const { requestId } = (await post(pub('/standins'), e.captain_steamid!, { entryId: e.id, out: P[11], scope: 'event' })).json();
    expect((await post(pub(`/standins/${requestId}/cancel`), e.captain_steamid!)).statusCode).toBe(200);
    expect(S.requestOf(f.db, requestId)?.status).toBe('cancelled');
  });
});

describe('the desk routes', () => {
  it('mods read every request with each offer, SR and answer; admins ask, lift the limit, cancel and set the margin, each audited', async () => {
    await build(standinFixture());
    const e = entryOf(f, P[0]!);
    expect((await post(desk('/standins'), MOD, { entryId: e.id, out: P[0], scope: 'event' })).statusCode).toBe(403);
    const { requestId } = (await post(desk('/standins'), ADMIN, { entryId: e.id, out: P[0], scope: 'event' })).json();
    let v = (await get(desk('/standins'), MOD)).json();
    expect(v).toMatchObject({ margin: 100, open: true });
    expect(v.teams).toHaveLength(4);
    expect(v.teams.find((t: { entryId: number }) => t.entryId === e.id).starters).toHaveLength(4);
    expect(v.requests[0]).toMatchObject({ id: requestId, entryId: e.id, team: e.name, status: 'unfilled', margin: 100, offers: [] });
    expect((await post(desk(`/standins/${requestId}/margin-off`), ADMIN)).json()).toEqual({ reopened: true });
    v = (await get(desk('/standins'), MOD)).json();
    expect(v.requests[0].offers).toEqual([expect.objectContaining({ steamid: BENCH[0], sr: 1300, answer: null })]);
    expect((await post(desk(`/standins/${requestId}/cancel`), ADMIN)).statusCode).toBe(200);
    expect((await post(desk('/standin-margin'), ADMIN, { margin: 150 })).json()).toEqual({ margin: 150 });
    expect((await post(desk('/standin-margin'), ADMIN, { margin: -1 })).json()).toEqual(text('bad_standin_margin'));
    const audit = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_standin%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(audit).toEqual(['event_standin_request', 'event_standin_margin_off', 'event_standin_cancel', 'event_standin_margin']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/standinRoutes.test.ts`
Expected: FAIL (`src/routes/standins.ts` does not exist).

- [ ] **Step 3: Implement**

`src/events/standinViews.ts`:

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import type * as E from './events.js';
import * as N from './entries.js';
import * as S from './standins.js';
import { standinMarginOf } from './draftRules.js';
import type * as V from './validate.js';

/** What a captain, a bench player and the desk see of stand-ins (plan D3a
 *  Ruling 14). A captain never learns who was asked or declined, and only
 *  staff see SR. */
export interface StandinRequestView {
  id: number; out: { steamid: string; name: string }; scope: S.StandinScope; status: S.StandinStatus;
  /** How many bench players were asked so far; never who. */
  asked: number; standin: string | null; requestedAt: string; marginOff: boolean;
}
export interface MyStandinView {
  /** The viewer's own open stand-in offer. */
  offer: { offerId: number; team: string; out: string; scope: S.StandinScope; expiresAt: string } | null;
  /** The viewer captains a draft team of this event. canMatch: the team has a match left. */
  captain: { entryId: number; team: string; starters: { steamid: string; name: string; captain: boolean }[];
    requests: StandinRequestView[]; open: boolean; canMatch: boolean } | null;
}
export interface AdminStandinOfferView { steamid: string; name: string; sr: number; answer: string | null; offeredAt: string; expiresAt: string }
export interface AdminStandinView extends StandinRequestView { entryId: number; team: string; margin: number; offers: AdminStandinOfferView[] }

const OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin', 'live']);
const nameOf = (db: DB, s: string): string => getPlayer(db, s)?.name ?? s;
const standinsOpen = (ev: E.EventRow): boolean => ev.entry_kind === 'draft' && ev.teams_made_at !== null && OPEN.has(ev.status);

function requestView(db: DB, r: S.StandinRow): StandinRequestView {
  return {
    id: r.id, out: { steamid: r.out_steamid, name: nameOf(db, r.out_steamid) }, scope: r.scope, status: r.status,
    asked: S.offersOf(db, r.id).length, standin: r.filled_by ? nameOf(db, r.filled_by) : null, requestedAt: r.requested_at, marginOff: r.margin_off === 1,
  };
}

export function myStandinView(db: DB, ev: E.EventRow, viewer: string): MyStandinView {
  const open = standinsOpen(ev);
  const requests = S.requestsOf(db, ev.id);
  let offer: MyStandinView['offer'] = null;
  for (const r of requests) {
    const o = r.status === 'open' ? S.openOfferOf(db, r.id) : undefined;
    if (o && o.steamid === viewer) {
      offer = { offerId: o.id, team: N.getEntry(db, r.entry_id)?.name ?? '', out: nameOf(db, r.out_steamid), scope: r.scope, expiresAt: o.expires_at };
      break;
    }
  }
  const cap = ev.entry_kind === 'draft' && ev.teams_made_at !== null
    ? N.entriesOf(db, ev.id).find((e) => N.isActive(e) && e.captain_steamid === viewer)
    : undefined;
  const captain = cap ? {
    entryId: cap.id, team: cap.name,
    starters: N.rosterOf(db, cap.id).starters.map((s) => ({ steamid: s, name: nameOf(db, s), captain: s === cap.captain_steamid })),
    requests: requests.filter((r) => r.entry_id === cap.id).map((r) => requestView(db, r)),
    open, canMatch: open && S.nextMatchOf(db, ev.id, cap.id) !== null,
  } : null;
  return { offer, captain };
}

/** The desk's "Ask the bench for a team" form: each active draft team and its starters. */
export interface AdminStandinTeamView { entryId: number; name: string; starters: { steamid: string; name: string }[] }

export function adminStandinViews(db: DB, ev: E.EventRow): { margin: number; open: boolean; teams: AdminStandinTeamView[]; requests: AdminStandinView[] } {
  return {
    margin: standinMarginOf(ev.draft_json), open: standinsOpen(ev),
    teams: N.entriesOf(db, ev.id).filter((e) => N.isActive(e) && e.captain_steamid !== null).map((e) => ({
      entryId: e.id, name: e.name, starters: N.rosterOf(db, e.id).starters.map((x) => ({ steamid: x, name: nameOf(db, x) })),
    })),
    requests: S.requestsOf(db, ev.id).map((r) => ({
      ...requestView(db, r), entryId: r.entry_id, team: N.getEntry(db, r.entry_id)?.name ?? '', margin: r.margin,
      offers: S.offersOf(db, r.id).map((o) => ({
        steamid: o.steamid, name: nameOf(db, o.steamid), sr: N.playerFacts(db, o.steamid).sr, answer: o.answer, offeredAt: o.offered_at, expiresAt: o.expires_at,
      })),
    })),
  };
}
```

`src/routes/standins.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { makeOptionalViewer, makeRequireActive, makeRequireAdmin, makeRequireMod } from './guards.js';
import { competitiveAccess } from '../teams/access.js';
import { logAdmin } from '../admin/audit.js';
import * as E from '../events/events.js';
import * as D from '../events/drafts.js';
import * as S from '../events/standins.js';
import * as V from '../events/validate.js';
import type { Standins } from '../events/standinFlow.js';
import { adminStandinViews, myStandinView } from '../events/standinViews.js';

const NOT_FOUND = { error: 'not found' };

/**
 * Bench stand-ins (drafts plan D3a). The player routes sit behind
 * competitive_enabled exactly as src/routes/events.ts does, and an
 * unpublished event answers 404. The desk routes follow the Events desk:
 * mods read, admins write, logAdmin after the commit. Everything goes through
 * the one Standins flow, so the DMs and the chain move the same way from
 * every surface.
 */
export async function standinRoutes(app: FastifyInstance, opts: { db: DB; standins: Standins }): Promise<void> {
  const { db, standins } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, { error: 'not_draft' }); return null; }
    return ev;
  };
  const draftById = (reply: FastifyReply, raw: string): E.EventRow | null => {
    const id = Number(raw);
    const ev = Number.isInteger(id) ? E.getEvent(db, id) : undefined;
    if (!ev) { refuse(reply, { error: 'not_found' }); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, { error: 'not_draft' }); return null; }
    return ev;
  };
  const requestIn = (ev: E.EventRow, raw: string): S.StandinRow | undefined => {
    const id = Number(raw);
    const r = Number.isInteger(id) ? S.requestOf(db, id) : undefined;
    return r && r.event_id === ev.id ? r : undefined;
  };
  const askBody = (body: unknown): { entryId: number; out: string; scope: unknown } | null => {
    const b = (body ?? {}) as { entryId?: unknown; out?: unknown; scope?: unknown };
    return typeof b.entryId === 'number' && Number.isInteger(b.entryId) && typeof b.out === 'string' ? { entryId: b.entryId, out: b.out, scope: b.scope } : null;
  };
  type Slug = { slug: string };
  type SlugId = { slug: string; id: string };
  type DeskId = { id: string; rid: string };

  app.get('/api/events/:slug/standins', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return myStandinView(db, ev, me);
  });

  app.post('/api/events/:slug/standins', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const b = askBody(req.body);
    if (!b) return refuse(reply, { error: 'bad_request' });
    const r = standins.request({ eventId: ev.id, ...b, by: me, staff: false });
    if (!r.ok) return refuse(reply, r);
    return r.value;
  });

  app.post('/api/events/:slug/standins/:id/cancel', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = draftBySlug(reply, p.slug);
    if (!ev) return;
    const r0 = requestIn(ev, p.id);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.cancel({ requestId: r0.id, by: me, staff: false });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  app.post('/api/events/:slug/standin-offers/:id', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = draftBySlug(reply, p.slug);
    if (!ev) return;
    const accept = ((req.body ?? {}) as { accept?: unknown }).accept;
    if (typeof accept !== 'boolean') return refuse(reply, { error: 'bad_request' });
    const offer = Number.isInteger(Number(p.id)) ? S.offerOf(db, Number(p.id)) : undefined;
    const owner = offer ? S.requestOf(db, offer.request_id) : undefined;
    if (!offer || !owner || owner.event_id !== ev.id) return refuse(reply, { error: 'standin_offer_gone' });
    const r = accept ? await standins.accept({ offerId: offer.id, steamid: me }) : standins.decline({ offerId: offer.id, steamid: me });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  app.get('/api/admin/events/:id/standins', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    return adminStandinViews(db, ev);
  });

  app.post('/api/admin/events/:id/standins', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    const b = askBody(req.body);
    if (!b) return refuse(reply, { error: 'bad_request' });
    const r = standins.request({ eventId: ev.id, ...b, by: me, staff: true });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_request', ev.id, { entryId: b.entryId, out: b.out, scope: b.scope, requestId: r.value.requestId });
    return r.value;
  });

  app.post('/api/admin/events/:id/standins/:rid/cancel', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as DeskId;
    const ev = draftById(reply, p.id);
    if (!ev) return;
    const r0 = requestIn(ev, p.rid);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.cancel({ requestId: r0.id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_cancel', ev.id, { requestId: r0.id });
    return { ok: true };
  });

  app.post('/api/admin/events/:id/standins/:rid/margin-off', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as DeskId;
    const ev = draftById(reply, p.id);
    if (!ev) return;
    const r0 = requestIn(ev, p.rid);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.marginOff({ requestId: r0.id, by: me });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_margin_off', ev.id, { requestId: r0.id, reopened: r.value.reopened });
    return r.value;
  });

  app.post('/api/admin/events/:id/standin-margin', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    const r = D.setStandinMargin(db, { eventId: ev.id, margin: ((req.body ?? {}) as { margin?: unknown }).margin, actor: me, now: new Date() });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_margin', ev.id, { margin: r.value.margin });
    return r.value;
  });
}
```

In `src/server.ts`, import `{ standinRoutes } from './routes/standins.js'` and register it right after the `standinTick` lines from Task 5:
`await app.register(standinRoutes, { db: deps.db, standins });`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/standinRoutes.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/standinViews.ts src/routes/standins.ts src/server.ts tests/standinRoutes.test.ts
git commit -m "Captains ask for and cancel stand-ins on the event page, bench players accept or decline their offer there, and the desk reads every request with its offers and SR, asks for a team, lifts the SR limit, cancels and sets the event's margin (plan D3a)"
```

### Task 7: The event page panel and the desk panel

**Files:**
- Create: `web/src/routes/event/StandinPanel.tsx`, `web/src/routes/admin/events/StandinsPanel.tsx`
- Modify: `web/src/api.ts`, `web/src/routes/Event.tsx`, `web/src/routes/admin/events/EventEditor.tsx`, `web/src/styles/app.css`, `web/src/routes/Event.test.tsx` (one mock)
- Test: `web/src/routes/event/StandinPanel.test.tsx`, `web/src/routes/admin/events/StandinsPanel.test.tsx` (new)

**Interfaces:**
- Consumes: Task 6's routes and view shapes.
- Produces (in `web/src/api.ts`):
  ```ts
  export type StandinScope = 'match' | 'event';
  export type StandinStatus = 'open' | 'filled' | 'unfilled' | 'cancelled' | 'ended';
  export interface StandinRequestView { id: number; out: { steamid: string; name: string }; scope: StandinScope; status: StandinStatus; asked: number; standin: string | null; requestedAt: string; marginOff: boolean }
  export interface MyStandinView {
    offer: { offerId: number; team: string; out: string; scope: StandinScope; expiresAt: string } | null;
    captain: { entryId: number; team: string; starters: { steamid: string; name: string; captain: boolean }[]; requests: StandinRequestView[]; open: boolean; canMatch: boolean } | null;
  }
  export interface AdminStandinOfferView { steamid: string; name: string; sr: number; answer: string | null; offeredAt: string; expiresAt: string }
  export interface AdminStandinView extends StandinRequestView { entryId: number; team: string; margin: number; offers: AdminStandinOfferView[] }
  export interface AdminStandinsView { margin: number; open: boolean; teams: { entryId: number; name: string; starters: { steamid: string; name: string }[] }[]; requests: AdminStandinView[] }
  // eventsApi
  standins(slug: string, signal?: AbortSignal): Promise<MyStandinView>;
  requestStandin(slug: string, body: { entryId: number; out: string; scope: StandinScope }): Promise<{ requestId: number }>;
  cancelStandin(slug: string, id: number): Promise<unknown>;
  answerStandin(slug: string, offerId: number, accept: boolean): Promise<unknown>;
  // adminApi
  eventStandins(id: number, signal?: AbortSignal): Promise<AdminStandinsView>;
  requestStandinFor(id: number, body: { entryId: number; out: string; scope: StandinScope }): Promise<{ requestId: number }>;
  cancelStandinFor(id: number, rid: number): Promise<unknown>;
  standinMarginOff(id: number, rid: number): Promise<{ reopened: boolean }>;
  setStandinMargin(id: number, margin: number): Promise<{ margin: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/routes/event/StandinPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyStandinView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { standins: vi.fn(), requestStandin: vi.fn(), cancelStandin: vi.fn(), answerStandin: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { confirm } = await import('../../components/Confirm');
const { StandinPanel } = await import('./StandinPanel');

const captain = (over: Partial<NonNullable<MyStandinView['captain']>> = {}): MyStandinView['captain'] => ({
  entryId: 7, team: 'Night Owls', open: true, canMatch: true, requests: [],
  starters: [{ steamid: 'c', name: 'cap', captain: true }, { steamid: 'a', name: 'ann', captain: false }, { steamid: 'b', name: 'bob', captain: false }, { steamid: 'd', name: 'dee', captain: false }],
  ...over,
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StandinPanel', () => {
  it('shows nothing to a player with no offer who captains nothing', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: null });
    const { container } = render(<StandinPanel slug="cup" />);
    await waitFor(() => expect(mockEvents.standins).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('a bench player accepts or declines their offer', async () => {
    mockEvents.standins.mockResolvedValue({ offer: { offerId: 5, team: 'Night Owls', out: 'ann', scope: 'match', expiresAt: '2026-10-10T20:10:00.000Z' }, captain: null });
    mockEvents.answerStandin.mockResolvedValue({ ok: true });
    render(<StandinPanel slug="cup" />);
    expect(await screen.findByText(/Night Owls needs a stand-in for ann \(next match\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerStandin).toHaveBeenCalledWith('cup', 5, true));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mockEvents.answerStandin).toHaveBeenCalledWith('cup', 5, false));
  });

  it('a captain asks for the next match without a confirm, and for the rest of the event behind one', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain() });
    mockEvents.requestStandin.mockResolvedValue({ requestId: 1 });
    render(<StandinPanel slug="cup" />);
    await screen.findByRole('heading', { name: 'Stand-ins' });
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockEvents.requestStandin).toHaveBeenCalledWith('cup', { entryId: 7, out: 'a', scope: 'match' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Rest of the event (they left)'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockEvents.requestStandin).toHaveBeenCalledWith('cup', { entryId: 7, out: 'a', scope: 'event' }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'ann has left the team?' }));
  });

  it('with no match left only the rest of the event is offered', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain({ canMatch: false }) });
    render(<StandinPanel slug="cup" />);
    await screen.findByRole('heading', { name: 'Stand-ins' });
    expect((screen.getByLabelText('Next match') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Rest of the event (they left)') as HTMLInputElement).checked).toBe(true);
  });

  it('lists requests with their status, how many were asked, the stand-in once found, and Cancel on an open one', async () => {
    mockEvents.standins.mockResolvedValue({ offer: null, captain: captain({ requests: [
      { id: 1, out: { steamid: 'a', name: 'ann' }, scope: 'match', status: 'open', asked: 2, standin: null, requestedAt: 'x', marginOff: false },
      { id: 2, out: { steamid: 'b', name: 'bob' }, scope: 'event', status: 'filled', asked: 1, standin: 'zed', requestedAt: 'x', marginOff: false },
    ] }) });
    mockEvents.cancelStandin.mockResolvedValue({ ok: true });
    render(<StandinPanel slug="cup" />);
    expect(await screen.findByText(/ann · next match · Asking the bench \(2 asked\)/)).toBeTruthy();
    expect(screen.getByText(/bob · rest of the event · zed stands in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the stand-in for ann' }));
    await waitFor(() => expect(mockEvents.cancelStandin).toHaveBeenCalledWith('cup', 1));
  });
});
```

```tsx
// web/src/routes/admin/events/StandinsPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminStandinsView } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { eventStandins: vi.fn(), requestStandinFor: vi.fn(), cancelStandinFor: vi.fn(), standinMarginOff: vi.fn(), setStandinMargin: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { StandinsPanel } = await import('./StandinsPanel');

const view = (): AdminStandinsView => ({
  margin: 100, open: true,
  teams: [{ entryId: 7, name: 'Night Owls', starters: [{ steamid: 'c', name: 'cap' }, { steamid: 'a', name: 'ann' }] }],
  requests: [{
    id: 1, entryId: 7, team: 'Night Owls', out: { steamid: 'a', name: 'ann' }, scope: 'event', status: 'unfilled', asked: 2, standin: null,
    requestedAt: '2026-10-10T20:00:00.000Z', marginOff: false, margin: 100,
    offers: [{ steamid: 'z', name: 'zed', sr: 1300, answer: 'decline', offeredAt: '2026-10-10T20:00:00.000Z', expiresAt: '2026-10-10T20:10:00.000Z' }],
  }],
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StandinsPanel', () => {
  it('shows every request with its offers and SR, and no controls for a mod', async () => {
    mockAdmin.eventStandins.mockResolvedValue(view());
    render(<StandinsPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText(/Night Owls · ann · rest of the event · Nobody took it/)).toBeTruthy();
    expect(screen.getByText(/zed · SR 1300 · Declined/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an admin sets the margin, lifts the limit, cancels and asks for a team', async () => {
    mockAdmin.eventStandins.mockResolvedValue(view());
    for (const f of [mockAdmin.setStandinMargin, mockAdmin.standinMarginOff, mockAdmin.requestStandinFor, mockAdmin.cancelStandinFor]) f.mockResolvedValue({});
    render(<StandinsPanel eventId={9} canEdit />);
    await screen.findByText(/Night Owls · ann/);
    fireEvent.input(screen.getByLabelText('SR margin'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save margin' }));
    await waitFor(() => expect(mockAdmin.setStandinMargin).toHaveBeenCalledWith(9, 150));
    fireEvent.click(screen.getByRole('button', { name: 'Offer without the SR limit' }));
    await waitFor(() => expect(mockAdmin.standinMarginOff).toHaveBeenCalledWith(9, 1));
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Player'), { target: { value: 'a' } });
    fireEvent.click(screen.getByLabelText('Rest of the event'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the bench' }));
    await waitFor(() => expect(mockAdmin.requestStandinFor).toHaveBeenCalledWith(9, { entryId: 7, out: 'a', scope: 'event' }));
  });
});
```

In `web/src/routes/Event.test.tsx`, the hoisted `mockEvents` gains `standins: vi.fn(async () => ({ offer: null, captain: null }))` (the page now mounts the panel for signed-in viewers of a draft event).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web web/src/routes/event/StandinPanel.test.tsx web/src/routes/admin/events/StandinsPanel.test.tsx`
Expected: FAIL (the two components do not exist).

- [ ] **Step 3: Implement**

`web/src/api.ts`: add the types above next to `MyEventView`, and in `eventsApi`:

```ts
  /** Bench stand-ins (drafts plan D3a). */
  standins: (slug: string, signal?: AbortSignal) => get<MyStandinView>(`/api/events/${enc(slug)}/standins`, signal),
  requestStandin: (slug: string, body: { entryId: number; out: string; scope: StandinScope }) => post<{ requestId: number }>(`/api/events/${enc(slug)}/standins`, body),
  cancelStandin: (slug: string, id: number) => post(`/api/events/${enc(slug)}/standins/${id}/cancel`),
  answerStandin: (slug: string, offerId: number, accept: boolean) => post(`/api/events/${enc(slug)}/standin-offers/${offerId}`, { accept }),
```

and in `adminApi`, after `setEntryCaptain`:

```ts
  /** Plan D3a: bench stand-ins on the desk. */
  eventStandins: (id: number, signal?: AbortSignal) => get<AdminStandinsView>(`/api/admin/events/${id}/standins`, signal),
  requestStandinFor: (id: number, body: { entryId: number; out: string; scope: StandinScope }) => post<{ requestId: number }>(`/api/admin/events/${id}/standins`, body),
  cancelStandinFor: (id: number, rid: number) => post(`/api/admin/events/${id}/standins/${rid}/cancel`),
  standinMarginOff: (id: number, rid: number) => post<{ reopened: boolean }>(`/api/admin/events/${id}/standins/${rid}/margin-off`),
  setStandinMargin: (id: number, margin: number) => post<{ margin: number }>(`/api/admin/events/${id}/standin-margin`, { margin }),
```

`web/src/routes/event/StandinPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { ApiError, eventsApi, type StandinScope, type StandinStatus } from '../../api';
import { Panel } from '../../components/bits';
import { confirm } from '../../components/Confirm';
import { whenText } from '../../eventFormat';
import { useFetch } from '../../hooks/useFetch';

const SCOPE: Record<StandinScope, string> = { match: 'next match', event: 'rest of the event' };
const STATUS: Record<StandinStatus, string> = {
  open: 'Asking the bench', filled: 'Found', unfilled: 'Nobody took it; staff were told', cancelled: 'Cancelled', ended: 'Done',
};

/** Bench stand-ins on a draft event page (plan D3a): a bench player's open
 *  offer with Accept and Decline, and for a captain, asking the bench for a
 *  stand-in and the team's requests. Renders nothing for anyone else. */
export function StandinPanel({ slug }: { slug: string }) {
  const { data, reload } = useFetch((s) => eventsApi.standins(slug, s), [slug]);
  const [out, setOut] = useState('');
  const [scope, setScope] = useState<StandinScope>('match');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      reload();
    }
  };
  if (!data || (!data.offer && !data.captain)) return null;
  const { offer, captain } = data;
  const chosen = captain?.starters.find((s) => s.steamid === out) ?? null;
  const wanted: StandinScope = captain && !captain.canMatch ? 'event' : scope;
  const ask = async () => {
    if (!captain || !chosen) return;
    if (wanted === 'event' && !(await confirm({
      title: `${chosen.name} has left the team?`,
      body: `The bench is asked for a stand-in for the rest of the event. Whoever accepts takes ${chosen.name}'s place on ${captain.team}.`,
      confirmLabel: 'Ask the bench',
    }))) return;
    void run(() => eventsApi.requestStandin(slug, { entryId: captain.entryId, out: chosen.steamid, scope: wanted }));
  };
  return (
    <Panel class="entrypanel standinpanel">
      {offer && (
        <div class="draftoffer" role="group" aria-label="Stand-in offer">
          <p><strong>{offer.team} needs a stand-in for {offer.out} ({SCOPE[offer.scope]}). Accept by {whenText(offer.expiresAt)}?</strong></p>
          <div class="inlinerow">
            <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.answerStandin(slug, offer.offerId, true))}>Accept</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => eventsApi.answerStandin(slug, offer.offerId, false))}>Decline</button>
          </div>
        </div>
      )}
      {captain && (
        <>
          <h3>Stand-ins</h3>
          {captain.open ? (
            <div class="standinpanel__ask">
              {/* for/id, not a wrapping label: a wrapping label's text would include every option. */}
              <label for="standin-player">Player</label>
              <select id="standin-player" value={out} onChange={(e) => setOut((e.target as HTMLSelectElement).value)}>
                <option value="">Choose a player</option>
                {captain.starters.map((s) => <option key={s.steamid} value={s.steamid}>{s.name}{s.captain ? ' (you)' : ''}</option>)}
              </select>
              <fieldset>
                <legend class="sr-only">For how long</legend>
                <label><input type="radio" name="standin-scope" checked={wanted === 'match'} disabled={!captain.canMatch} onChange={() => setScope('match')} /> Next match</label>
                <label><input type="radio" name="standin-scope" checked={wanted === 'event'} onChange={() => setScope('event')} /> Rest of the event (they left)</label>
              </fieldset>
              <button class="btn" disabled={busy || !chosen} onClick={() => void ask()}>Ask the bench</button>
            </div>
          ) : <p class="muted">Stand-ins open once the teams are made and close when the event ends.</p>}
          {captain.requests.length > 0 && (
            <ul class="admin-list">
              {captain.requests.map((r) => (
                <li key={r.id}>
                  {r.out.name} · {SCOPE[r.scope]} · {r.status === 'filled' && r.standin ? `${r.standin} stands in` : STATUS[r.status]}{r.status === 'open' ? ` (${r.asked} asked)` : ''}
                  {r.status === 'open' && (
                    <button class="btn btn--ghost btn--sm" aria-label={`Cancel the stand-in for ${r.out.name}`} disabled={busy}
                      onClick={() => run(() => eventsApi.cancelStandin(slug, r.id))}>Cancel</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
```

`web/src/routes/admin/events/StandinsPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type StandinScope, type StandinStatus } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, useAction } from '../useAction';

const SCOPE: Record<StandinScope, string> = { match: 'next match', event: 'rest of the event' };
const STATUS: Record<StandinStatus, string> = { open: 'Asking', filled: 'Found', unfilled: 'Nobody took it', cancelled: 'Cancelled', ended: 'Done' };
const ANSWER: Record<string, string> = { accept: 'Accepted', decline: 'Declined', expired: 'Ran out', stopped: 'Stopped', failed: 'Could not be placed' };

/** Bench stand-ins on the Events desk (plan D3a): the event's SR margin,
 *  every request with each offer (SR and answer, staff only), and for admins:
 *  ask the bench for any team, lift the SR limit on a request, cancel one. */
export function StandinsPanel({ eventId, canEdit, gen = 0 }: { eventId: number; canEdit: boolean; gen?: number }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventStandins(eventId, s), [eventId, gen]);
  const { busy, error, run } = useAction(reload);
  const [margin, setMargin] = useState<string | null>(null);
  const [team, setTeam] = useState('');
  const [out, setOut] = useState('');
  const [scope, setScope] = useState<StandinScope>('match');
  if (loadError) return <Panel><h3>Stand-ins</h3><p class="error">Could not load the stand-ins.</p></Panel>;
  if (!data) return <Panel><h3>Stand-ins</h3></Panel>;
  const starters = data.teams.find((t) => String(t.entryId) === team)?.starters ?? [];
  return (
    <Panel>
      <h3>Stand-ins</h3>
      {error && <p class="error" role="alert">{error}</p>}
      {canEdit ? (
        <div class="inlinerow">
          <label>SR margin <input type="number" min={0} max={2000} step={1} value={margin ?? String(data.margin)} onInput={(e) => setMargin((e.target as HTMLInputElement).value)} /></label>
          <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.setStandinMargin(eventId, Number(margin ?? data.margin)))}>Save margin</button>
        </div>
      ) : <p class="muted">SR margin: {data.margin} above the missing player.</p>}
      {canEdit && data.open && (
        <div class="standinpanel__ask">
          <label for="desk-standin-team">Team</label>
          <select id="desk-standin-team" value={team} onChange={(e) => { setTeam((e.target as HTMLSelectElement).value); setOut(''); }}>
            <option value="">Choose a team</option>
            {data.teams.map((t) => <option key={t.entryId} value={String(t.entryId)}>{t.name}</option>)}
          </select>
          <label for="desk-standin-player">Player</label>
          <select id="desk-standin-player" value={out} onChange={(e) => setOut((e.target as HTMLSelectElement).value)}>
            <option value="">Choose a player</option>
            {starters.map((s) => <option key={s.steamid} value={s.steamid}>{s.name}</option>)}
          </select>
          <fieldset>
            <label><input type="radio" name="desk-standin-scope" checked={scope === 'match'} onChange={() => setScope('match')} /> Next match</label>
            <label><input type="radio" name="desk-standin-scope" checked={scope === 'event'} onChange={() => setScope('event')} /> Rest of the event</label>
          </fieldset>
          <button class="btn" disabled={busy || team === '' || out === ''} onClick={() => run(() => adminApi.requestStandinFor(eventId, { entryId: Number(team), out, scope }))}>Ask the bench</button>
        </div>
      )}
      {data.requests.length === 0 ? <Empty>No stand-in requests yet.</Empty> : (
        <ul class="admin-list">
          {data.requests.map((r) => (
            <li key={r.id}>
              <span>{r.team} · {r.out.name} · {SCOPE[r.scope]} · {r.status === 'filled' && r.standin ? `${r.standin} stands in` : STATUS[r.status]} · {r.marginOff ? 'no SR limit' : `up to ${r.margin} SR above`}</span>
              {r.offers.length > 0 && (
                <ul class="standinoffers">
                  {r.offers.map((o) => <li key={`${o.steamid}-${o.offeredAt}`}>{o.name} · SR {o.sr} · {o.answer ? ANSWER[o.answer] ?? o.answer : `open until ${fmtTime(o.expiresAt)}`}</li>)}
                </ul>
              )}
              {canEdit && (r.status === 'open' || r.status === 'unfilled') && !r.marginOff && (
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => run(() => adminApi.standinMarginOff(eventId, r.id))}>Offer without the SR limit</button>
              )}
              {canEdit && r.status === 'open' && (
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => run(() => adminApi.cancelStandinFor(eventId, r.id), `Cancel the stand-in for ${r.out.name}?`)}>Cancel</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```

`web/src/routes/Event.tsx`: import `StandinPanel` and mount it right after the `DraftIdentityPanel` line:
`{mine && ev.entryKind === 'draft' && <StandinPanel slug={ev.slug} />}`

`web/src/routes/admin/events/EventEditor.tsx`: import `StandinsPanel` and mount it right after the `EntriesPanel` block:

```tsx
      {ev.fields.entryKind === 'draft' && ev.teamsMadeAt !== null && (
        <StandinsPanel eventId={ev.id} canEdit={canEdit} gen={panelGen} />
      )}
```

`web/src/styles/app.css`, next to the draft panel rules (layout only, no new colours):

```css
/* Drafts plan D3a: stand-ins on the event page and the desk. */
.standinpanel__ask { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 0.75rem; }
.standinpanel__ask fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.75rem; }
.standinpanel__ask select { max-width: 100%; }
.standinoffers { margin: 0.25rem 0 0 1rem; padding: 0; font-size: 0.9em; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project web web/src/routes/event/StandinPanel.test.tsx web/src/routes/admin/events/StandinsPanel.test.tsx web/src/routes/Event.test.tsx web/src/routes/admin/events/EventEditor.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean. Then the whole suite once: `npx vitest run` (only the 7 known `skeetStreakPoster` failures).

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/event/StandinPanel.tsx web/src/routes/event/StandinPanel.test.tsx web/src/routes/admin/events/StandinsPanel.tsx web/src/routes/admin/events/StandinsPanel.test.tsx web/src/routes/Event.tsx web/src/routes/Event.test.tsx web/src/routes/admin/events/EventEditor.tsx web/src/styles/app.css
git commit -m "The draft event page lets captains ask the bench for a stand-in and bench players accept or decline their offer, and the Events desk shows every request with its offers and SR, with the margin, Ask the bench, Offer without the SR limit and Cancel (plan D3a)"
```

