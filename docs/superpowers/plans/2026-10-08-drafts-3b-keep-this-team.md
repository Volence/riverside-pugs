# Drafts plan D3b: Keep this team

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a draft event finishes, each draft team's captain gets a "Keep this team" offer (a Discord DM button and a panel on the event page). Pressing it, with a team name and tag, asks the other three drafted players to Accept or Decline. As soon as 3 of the 4 (the captain counts) can join, a real site team is created: origin `draft`, origin_ref the event, the draft name, tag and logo, the accepters as members, and the event (with the team's placement) shown on its team page as where it was formed. The 3-team membership cap applies: an accept at the cap is refused with "leave a team first", and an accepter who reached the cap since accepting is left out and told.

**Architecture:**
- **Rules** (`src/events/draftRules.ts`, extended): the windows (`KEEP_OFFER_DAYS`, `KEEP_VOTE_HOURS`), the majority (`KEEP_MAJORITY`) and the `dk:` button prefix.
- **Team creation** stays in `src/teams/teams.ts`, the only writer of the team tables: `createDraftTeam` (name and tag collision rules, the cap filter, origin) and `addDraftMember` (a late accepter).
- **One writer of the keep tables** (`src/events/keepTeam.ts`, new): `draft_keeps` (one per draft entry) and `draft_keep_answers`. Offer, start, answer, settle (create the team), close. One transaction and one `event_log` row each, calling `teams.ts` inside its transaction.
- **Flow:** the events minute tick (`EventRunner.step`) offers keeps for finished draft events, settles, and closes due ones; `src/events/keepFlow.ts` sequences start and answer with their DMs for the routes and the Discord buttons (`src/discord/keepButtons.ts`).
- **Surfaces:** `src/routes/keepTeam.ts`, `web/src/routes/event/KeepTeamPanel.tsx` on a finished draft event's page, and a "Formed at" line on the team page.

**Tech Stack:** As D3a. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` section 7 (Keep this team) and Testing ("keep-team majority"). Foundation teams: `src/teams/teams.ts` (spec part 1 section 2: origin `site | draft | pickup`, origin_ref, the membership cap `team_membership_cap`, default 3).

## Global Constraints

- Runs on **branch `drafts-3`** after D3a (same branch, or a branch cut from it, as the controller says). The D3a Global Constraints apply unchanged; commit messages end with "(plan D3b)".
- Writers: `draft_keeps` and `draft_keep_answers` only in `src/events/keepTeam.ts` (guarded in `tests/eventLogGuard.test.ts`); `teams` and `team_members` only in `src/teams/teams.ts` (its header rule; no new writer elsewhere).
- (owner) Tournaments never touch scrim records or SR: making a team writes nothing to bookings, ratings or scrim tables.
- Privacy: a keep's answers are shown to the four players and staff only; the public sees the finished team page as any team.

## Review Focus

1. **The fourth player answers after the team is made.** They join as a member if under the cap, and cannot answer twice. Task 2 pins it.
2. **An accepter who reached the cap after accepting.** At creation they are left out (not a member, told by DM), and if that leaves fewer than three, nothing is made until another accept. Task 2 pins it.
3. **A name taken between Keep and creation.** The team is made as "Name 2" (cut to 24 characters), and a taken tag gets a digit. Task 1 pins the rule; Task 2 pins it through settle.
4. **Two settles of the same keep** (the tick and an accept, or a double press). Exactly one team is made; the second settle is refused. Task 2 pins it.
5. **Old events and lapsed keeps.** A draft event finished more than 7 days ago never gets an offer, and a keep past its window is closed by the tick and never makes a team. Task 3 pins it.

## Rulings

Decided for this plan, awaiting owner review (marked **(spec)** where the spec decides).

1. **Who.** Every active draft entry (not dropped, not disqualified) of a draft event that finished. The "drafted players" are the entry's **starters when the offer is made**, captain first: a D2c replacement and a rest-of-event stand-in count; a match stand-in (a sub) never does. A team with fewer than three starters is never offered.
2. **Windows.** The tick offers within 7 days of the event finishing (`KEEP_OFFER_DAYS`); the captain may press Keep until then. Voting runs 48 hours from Keep (`KEEP_VOTE_HOURS`). Past either, the tick closes the keep (`lapsed`); a made team stops taking late accepts at the 48 hour mark.
3. **(spec) Majority.** 3 of the 4, the captain counting as an accept by pressing Keep. The team is created at the first moment three of them can join (on an accept, or on the tick after someone left a team), not at the end of the window.
4. **Name and tag.** The captain chooses them when pressing Keep, prefilled from the draft entry's name and tag; both pass the team rules (slur filter included) and must be free then (`keep_name_taken`, `keep_tag_taken`). If one is taken by creation time, the name becomes "Name 2", "Name 3" (cut so it fits 24 characters) and the tag gets a digit ("OWL2"; cut to 4 then a digit). The Discord Keep button uses the entry's name and tag as they are; with no tag set it points the captain to the event page.
5. **(spec) Logo.** The entry's logo key is reused as the team's logo key: the same stored file (the community store is content-addressed and never pruned), no copy.
6. **(spec) The cap.** An accept from a player at the membership cap is refused `keep_cap` with nothing recorded ("Leave a team first, then try again"). An accepter who reached the cap after accepting is left out at creation and gets the DM `draft_keep_left_out`. The captain must be under the membership cap and the created-teams cap when pressing Keep and at creation; if not at creation, creation waits.
7. **(spec) Origin.** `origin = 'draft'`, `origin_ref` = the event id as text, `created_by` = the captain, region the default. The captain is the team's captain; the rest are members.
8. **(spec) Trophies.** No trophy system exists yet. The team page shows "Formed at <event>" with the placement when the event recorded one (1st, 2nd, ...). A trophy table later hangs off `draft_keeps` (one row per kept team).
9. **No staff desk for keeps.** Every step is in the event log; staff use the existing team tools afterwards.
10. **Cancelled events** never get keeps (only `finished`).
11. **Event log actions.** `keep_offered`, `keep_started`, `keep_answered`, `keep_team_made`, `keep_closed`.
12. *Plan deviation:* the steamid columns carry no players foreign key (as D3a Ruling 16).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/events/draftRules.ts` | modify | Keep windows, majority, `dk:` prefix |
| `src/db.ts` | modify | `draft_keeps`, `draft_keep_answers` |
| `src/events/validate.ts` | modify | `keep_*` refusals |
| `src/teams/teams.ts` | modify | `createDraftTeam`, `addDraftMember`, `keep_short` |
| `src/events/keepTeam.ts` | create | Every keep write; reads incl. `keptFrom`, `myKeepView` |
| `src/events/keepFlow.ts` | create | Start and answer with their DMs |
| `src/events/runner.ts` | modify | Offer, settle and close keeps each minute |
| `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts` | modify | Four DM types |
| `src/discord/keepButtons.ts` | create | `dk:` buttons |
| `src/routes/keepTeam.ts` | create | Event page routes |
| `src/routes/teams.ts` | modify | `TeamView.origin` |
| `src/server.ts` | modify | Button and routes |
| `web/src/api.ts`, `web/src/routes/event/KeepTeamPanel.tsx`, `web/src/routes/Event.tsx`, `web/src/routes/Team.tsx` | modify/create | The panel and the team page line |
| `tests/standinFixture.ts` | modify | `finishedDraft`, `FINISHED` |

---

### Task 1: Rules, schema, refusals, and making a team from a draft

**Files:**
- Modify: `src/events/draftRules.ts`, `src/db.ts`, `src/events/validate.ts`, `src/teams/teams.ts`
- Test: `tests/draftTeamCreate.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // src/events/draftRules.ts
  export const KEEP_OFFER_DAYS = 7;
  export const KEEP_VOTE_HOURS = 48;
  export const KEEP_MAJORITY = 3;
  export const KEEP_BUTTON_PREFIX = 'dk:';
  // src/teams/teams.ts
  export function createDraftTeam(db: DB, o: {
    captain: string; members: string[]; name: string; tag: string; logoKey: string | null; eventId: number; min: number; now: Date;
  }): Result<{ id: number; slug: string; name: string; tag: string; joined: string[]; left: string[] }>;
  export function addDraftMember(db: DB, o: { teamId: number; steamid: string; now: Date }): Result<null>;
  // TEAM_ERRORS gains keep_short
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/draftTeamCreate.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import * as T from '../src/teams/teams.js';

const CAP = '76561199000000401';
const M = ['76561199000000402', '76561199000000403', '76561199000000404'] as const;
const OTHER = '76561199000000405';
const NOW = new Date('2026-10-12T12:00:00.000Z');

function fresh(): DB {
  const db = openDb(':memory:');
  for (const [i, s] of [CAP, ...M, OTHER].entries()) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(s, `p${i}`);
  return db;
}
const base = (over: Partial<Parameters<typeof T.createDraftTeam>[1]> = {}): Parameters<typeof T.createDraftTeam>[1] =>
  ({ captain: CAP, members: [CAP, M[0], M[1]], name: 'Night Owls', tag: 'OWL', logoKey: 'a'.repeat(64), eventId: 5, min: 3, now: NOW, ...over });
const must = <X>(r: T.Result<X>): X => { if (!r.ok) throw new Error(r.error); return r.value; };
/** Three site teams created by this player: the membership cap. */
const capped = (db: DB, steamid: string, prefix: string) => {
  for (let i = 1; i <= 3; i++) must(T.createTeam(db, { creator: steamid, name: `${prefix} Squad ${i}`, tag: `${prefix}${i}`, now: NOW }));
};

describe('createDraftTeam (plan D3b Rulings 4 to 7)', () => {
  it('makes a draft-origin team: the captain as captain, the accepters as members, the entry logo, origin_ref the event', () => {
    const db = fresh();
    const r = must(T.createDraftTeam(db, base()));
    expect(r).toMatchObject({ name: 'Night Owls', tag: 'OWL', joined: [CAP, M[0], M[1]], left: [] });
    expect(T.getTeam(db, r.id)).toMatchObject({ origin: 'draft', origin_ref: '5', logo_key: 'a'.repeat(64), captain_steamid: CAP, created_by: CAP, slug: 'night-owls' });
    expect(T.activeMembers(db, r.id).map((m) => [m.steamid, m.role])).toEqual([[CAP, 'captain'], [M[0], 'member'], [M[1], 'member']]);
  });

  it('Review Focus 3: a taken name gets " 2" (cut to fit 24 characters) and a taken tag a digit', () => {
    const db = fresh();
    must(T.createTeam(db, { creator: OTHER, name: 'Night Owls', tag: 'OWL', now: NOW }));
    expect(must(T.createDraftTeam(db, base()))).toMatchObject({ name: 'Night Owls 2', tag: 'OWL2' });
    const long = 'Abcdefghijklmnopqrstuvwx';
    must(T.createTeam(db, { creator: OTHER, name: long, tag: 'LONG5', now: NOW }));
    expect(must(T.createDraftTeam(db, base({ captain: M[2], members: [M[2], CAP, M[0]], name: long, tag: 'LONG5' })))).toMatchObject({ name: 'Abcdefghijklmnopqrstuv 2', tag: 'LONG2' });
  });

  it('leaves out an accepter at the membership cap, and refuses when fewer than min can join', () => {
    const db = fresh();
    capped(db, M[0], 'AA');
    const r = must(T.createDraftTeam(db, base({ members: [CAP, M[0], M[1], M[2]] })));
    expect(r).toMatchObject({ joined: [CAP, M[1], M[2]], left: [M[0]] });
    expect(T.roleOf(db, r.id, M[0])).toBeNull();
    const db2 = fresh();
    capped(db2, M[0], 'AA');
    expect(T.createDraftTeam(db2, base())).toEqual({ ok: false, error: 'keep_short' });
    expect(db2.prepare("SELECT COUNT(*) AS n FROM teams WHERE origin = 'draft'").get()).toEqual({ n: 0 });
  });

  it('refuses a captain at the membership cap', () => {
    const db = fresh();
    capped(db, CAP, 'CC');
    expect(T.createDraftTeam(db, base())).toEqual({ ok: false, error: 'your_cap' });
  });
});

describe('addDraftMember', () => {
  it('adds a late accepter once, never past the cap, and only to a draft team', () => {
    const db = fresh();
    const team = must(T.createDraftTeam(db, base()));
    expect(T.addDraftMember(db, { teamId: team.id, steamid: M[2], now: NOW })).toEqual({ ok: true, value: null });
    expect(T.roleOf(db, team.id, M[2])).toBe('member');
    expect(T.addDraftMember(db, { teamId: team.id, steamid: M[2], now: NOW })).toEqual({ ok: false, error: 'already_member' });
    capped(db, OTHER, 'OO');
    expect(T.addDraftMember(db, { teamId: team.id, steamid: OTHER, now: NOW })).toEqual({ ok: false, error: 'their_cap' });
    const site = must(T.createTeam(db, { creator: M[2], name: 'Site Team', tag: 'SITE', now: NOW }));
    expect(T.addDraftMember(db, { teamId: site.id, steamid: CAP, now: NOW })).toEqual({ ok: false, error: 'not_found' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/draftTeamCreate.test.ts`
Expected: FAIL (`T.createDraftTeam is not a function`).

- [ ] **Step 3: Implement**

`src/events/draftRules.ts`, appended:

```ts
// ---------- Keep this team (plan D3b) ----------

/** Ruling 2: offers are made within this many days of the event finishing. */
export const KEEP_OFFER_DAYS = 7;
/** Ruling 2: voting runs this long from the captain's Keep. */
export const KEEP_VOTE_HOURS = 48;
/** Ruling 3 (spec): 3 of the 4. */
export const KEEP_MAJORITY = 3;
/** Discord custom id prefix of the keep buttons (src/discord/keepButtons.ts). */
export const KEEP_BUTTON_PREFIX = 'dk:';
```

`src/db.ts`, after the stand-in tables:

```sql
-- Drafts plan D3b: Keep this team. src/events/keepTeam.ts owns every write.
-- One row per draft entry of a finished draft event; players_json is the four
-- at the offer, captain first. team_id is the site team once made.
CREATE TABLE IF NOT EXISTS draft_keeps (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entry_id        INTEGER NOT NULL UNIQUE,
  captain_steamid TEXT NOT NULL,
  players_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('offered','voting','made','lapsed')),
  name            TEXT,
  tag             TEXT,
  offered_at      TEXT NOT NULL,
  started_at      TEXT,
  expires_at      TEXT NOT NULL,
  team_id         INTEGER REFERENCES teams(id),
  closed_at       TEXT
);
CREATE TABLE IF NOT EXISTS draft_keep_answers (
  keep_id     INTEGER NOT NULL REFERENCES draft_keeps(id) ON DELETE CASCADE,
  steamid     TEXT NOT NULL,
  answer      TEXT NOT NULL CHECK (answer IN ('accept','decline')),
  answered_at TEXT NOT NULL,
  joined      INTEGER NOT NULL DEFAULT 0 CHECK (joined IN (0,1)),
  PRIMARY KEY (keep_id, steamid)
);
```

`src/events/validate.ts`, after the D3a stand-in keys:

```ts
  // Drafts plan D3b: Keep this team.
  keep_not_open: { status: 409, text: 'Keep this team is not open for this team.' },
  keep_started: { status: 409, text: 'Keep this team has already been started for this team.' },
  keep_closed: { status: 409, text: 'Keep this team has closed for this team.' },
  keep_open: { status: 409, text: 'Keep this team is still open for this team.' },
  keep_not_player: { status: 403, text: 'Only the drafted players of this team can answer.' },
  keep_answered: { status: 409, text: 'You already answered.' },
  keep_cap: { status: 409, text: 'You are on as many teams as allowed. Leave a team first, then try again.' },
  keep_created_cap: { status: 409, text: 'You have created as many teams as allowed. Disband one first, then try again.' },
  keep_name_taken: { status: 409, text: 'Another team already has that name. Choose another.' },
  keep_tag_taken: { status: 409, text: 'Another team already has that tag. Choose another.' },
  keep_waiting: { status: 409, text: 'Fewer than three of the drafted players can join yet.' },
```

`src/teams/teams.ts`: add to `TEAM_ERRORS`:

```ts
  keep_short: { status: 409, text: 'Fewer than three of the drafted players can join a team right now.' },
```

and after `createTeam`:

```ts
/** A free name: the name, then "name 2", "name 3" with the base cut so the
 *  suffix fits NAME_MAX (drafts plan D3b Ruling 4). Null when none of the
 *  first 99 is free. */
function freeName(db: DB, name: string): { name: string; key: string } | null {
  for (let k = 1; k <= 99; k++) {
    const suffix = k === 1 ? '' : ` ${k}`;
    const base = Array.from(name).slice(0, NAME_MAX - suffix.length).join('').trimEnd();
    const n = normalizeName(`${base}${suffix}`);
    if (n.ok && !nameTaken(db, n.key)) return { name: n.name, key: n.key };
  }
  return null;
}

/** A free tag: the tag, then its first 4 characters and a digit 2 to 9. */
function freeTag(db: DB, tag: string): { tag: string; key: string } | null {
  for (let k = 1; k <= 9; k++) {
    const t = normalizeTag(k === 1 ? tag : `${tag.slice(0, 4)}${k}`);
    if (t.ok && !tagTaken(db, t.key)) return { tag: t.tag, key: t.key };
  }
  return null;
}

/**
 * A draft team kept after its event (drafts plan D3b, spec part 3 section 7),
 * in one transaction: origin 'draft', origin_ref the event id, the captain as
 * captain and creator, every other accepter under the membership cap as a
 * member (one at the cap is left out), the entry's logo key. The captain must
 * be under both caps. At least `min` players in all, or keep_short. A taken
 * name or tag takes the next free one (freeName, freeTag).
 */
export function createDraftTeam(
  db: DB, o: { captain: string; members: string[]; name: string; tag: string; logoKey: string | null; eventId: number; min: number; now: Date },
): Result<{ id: number; slug: string; name: string; tag: string; joined: string[]; left: string[] }> {
  const at = o.now.toISOString();
  return db.transaction((): Result<{ id: number; slug: string; name: string; tag: string; joined: string[]; left: string[] }> => {
    const cap = membershipCap(db);
    if (activeMembershipCount(db, o.captain) >= cap) return fail('your_cap');
    if (createdCount(db, o.captain) >= cap) return fail('created_cap');
    const others = [...new Set(o.members)].filter((s) => s !== o.captain);
    const joined = others.filter((s) => activeMembershipCount(db, s) < cap);
    const left = others.filter((s) => !joined.includes(s));
    if (1 + joined.length < o.min) return fail('keep_short');
    const name = freeName(db, o.name);
    if (!name) return fail('name_taken');
    const tag = freeTag(db, o.tag);
    if (!tag) return fail('tag_taken');
    const slug = slugFor(db, name.name);
    const id = Number(db.prepare(
      `INSERT INTO teams (name, name_key, tag, tag_key, slug, logo_key, captain_steamid, created_by, origin, origin_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(name.name, name.key, tag.tag, tag.key, slug, o.logoKey, o.captain, o.captain, String(o.eventId), at).lastInsertRowid);
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'captain', ?)").run(id, o.captain, at);
    const member = db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)");
    for (const s of joined) member.run(id, s, at);
    return ok({ id, slug, name: name.name, tag: tag.tag, joined: [o.captain, ...joined], left });
  })();
}

/** A drafted player who accepts after their kept team was made (plan D3b Ruling 2). */
export function addDraftMember(db: DB, o: { teamId: number; steamid: string; now: Date }): Result<null> {
  return db.transaction((): Result<null> => {
    const team = getTeam(db, o.teamId);
    if (!team || team.disbanded_at !== null || team.origin !== 'draft') return fail('not_found');
    if (roleOf(db, team.id, o.steamid) !== null) return fail('already_member');
    if (activeMembershipCount(db, o.steamid) >= membershipCap(db)) return fail('their_cap');
    if (rosterSize(db, team.id) >= ROSTER_MAX) return fail('roster_full');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)").run(team.id, o.steamid, o.now.toISOString());
    return ok(null);
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/draftTeamCreate.test.ts tests/teams.test.ts tests/teamsSchema.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/draftRules.ts src/db.ts src/events/validate.ts src/teams/teams.ts tests/draftTeamCreate.test.ts
git commit -m "A site team can be made from a draft team, origin draft with the event as its reference, the entry's logo and the accepters under the team cap as members, taking the next free name or tag if its own is taken (plan D3b)"
```

### Task 2: The keep writer: offer, Keep, answers and making the team

**Files:**
- Create: `src/events/keepTeam.ts`
- Modify: `tests/standinFixture.ts`, `tests/eventLogGuard.test.ts`
- Test: `tests/keepTeam.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `T.createDraftTeam`, `T.addDraftMember`, `KEEP_*`; `T.normalizeName`, `T.normalizeTag`, `T.nameTaken`, `T.tagTaken`, `T.activeMembershipCount`, `T.membershipCap`, `T.canCreate`, `T.getTeam`; `N.getEntry`, `N.rosterOf`, `N.isActive`; `E.getEvent`, `E.logEvent`.
- Produces (all from `src/events/keepTeam.ts`):
  ```ts
  export type KeepStatus = 'offered' | 'voting' | 'made' | 'lapsed';
  export interface KeepRow { id: number; event_id: number; entry_id: number; captain_steamid: string; players_json: string; status: KeepStatus;
    name: string | null; tag: string | null; offered_at: string; started_at: string | null; expires_at: string; team_id: number | null; closed_at: string | null }
  export interface KeepAnswerRow { keep_id: number; steamid: string; answer: 'accept' | 'decline'; answered_at: string; joined: number }
  export interface MyKeepView {
    keepId: number; status: KeepStatus; captain: boolean; team: string; name: string | null; tag: string | null;
    defaults: { name: string; tag: string }; expiresAt: string; closed: boolean;
    players: { name: string; captain: boolean; answer: 'accept' | 'decline' | null }[];
    myAnswer: 'accept' | 'decline' | null; teamSlug: string | null;
  }
  // reads
  export function keepOf(db: DB, id: number): KeepRow | undefined;
  export function keepOfEntry(db: DB, entryId: number): KeepRow | undefined;
  export function keepsOf(db: DB, eventId: number): KeepRow[];
  export function openKeeps(db: DB): KeepRow[];
  export function answersOf(db: DB, keepId: number): KeepAnswerRow[];
  export function playersOf(k: KeepRow): string[];
  export function keptFrom(db: DB, teamId: number): { eventSlug: string; eventName: string; placement: number | null } | null;
  export function myKeepView(db: DB, eventId: number, viewer: string, now: Date): MyKeepView | null;
  // mutations (one event_log row each)
  export function offerKeep(db: DB, o: { entryId: number; now: Date }): V.Checked<{ keepId: number }>;
  export function startKeep(db: DB, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }>;
  export function answerKeep(db: DB, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean }>;
  export function settleKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<{ teamId: number; slug: string; joined: string[]; left: string[] }>;
  export function closeKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<{ status: KeepStatus }>;
  // tests/standinFixture.ts
  export const FINISHED: Date;
  export function finishedDraft(): StandinFixture;
  ```

- [ ] **Step 1: Write the fixture addition and the failing test**

Append to `tests/standinFixture.ts`:

```ts
/** Plan D3b: when finishedDraft's event finished. */
export const FINISHED = new Date('2026-10-12T22:00:00.000Z');
/** standinFixture with its event finished at FINISHED (test setup only: the
 *  last stage's settle leaves an event exactly so, status and finished_at). */
export function finishedDraft(): StandinFixture {
  const f = standinFixture();
  f.db.prepare("UPDATE events SET status = 'finished', finished_at = ? WHERE id = ?").run(FINISHED.toISOString(), f.eventId);
  return f;
}
```

```ts
// tests/keepTeam.test.ts
import { describe, it, expect } from 'vitest';
import * as K from '../src/events/keepTeam.js';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { BENCH, FINISHED, finishedDraft, standinFixture, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
const at = (h: number) => new Date(FINISHED.getTime() + h * H);
const must = <X>(r: { ok: true; value: X } | { ok: false; error: string }): X => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
/** The first team's keep offered at FINISHED + 1 h, with its four, captain first. */
function offered(f: StandinFixture) {
  const entry = N.getEntry(f.db, f.entries[0]!)!;
  const { keepId } = must(K.offerKeep(f.db, { entryId: entry.id, now: at(1) }));
  const four = K.playersOf(K.keepOf(f.db, keepId)!);
  return { entry, keepId, captain: four[0]!, p: four.slice(1) as [string, string, string] };
}
type X = ReturnType<typeof offered>;
const start = (f: StandinFixture, x: X, over: Partial<Parameters<typeof K.startKeep>[1]> = {}) =>
  K.startKeep(f.db, { entryId: x.entry.id, steamid: x.captain, name: 'Night Owls', tag: 'OWL', now: at(2), ...over });
const answer = (f: StandinFixture, x: X, steamid: string, accept: boolean, h = 3) => K.answerKeep(f.db, { keepId: x.keepId, steamid, accept, now: at(h) });
const settle = (f: StandinFixture, x: X, h = 3) => K.settleKeep(f.db, { keepId: x.keepId, now: at(h) });
/** Three site teams created by this player: the membership cap. */
const capped = (f: StandinFixture, steamid: string, prefix: string) => {
  for (let i = 1; i <= 3; i++) must(T.createTeam(f.db, { creator: steamid, name: `${prefix} Squad ${i}`, tag: `${prefix}${i}`, now: at(0) }));
};

describe('offerKeep (Rulings 1 and 2)', () => {
  it('offers a finished draft team\'s captain, once, with its four, until 7 days after the finish', () => {
    const f = finishedDraft();
    const x = offered(f);
    expect(x.captain).toBe(x.entry.captain_steamid);
    expect([x.captain, ...x.p].sort()).toEqual([...N.rosterOf(f.db, x.entry.id).starters].sort());
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'offered', expires_at: at(7 * 24).toISOString(), name: null, team_id: null });
    expect(err(K.offerKeep(f.db, { entryId: x.entry.id, now: at(1) }))).toBe('keep_started');
    expect(err(K.offerKeep(f.db, { entryId: f.entries[1]!, now: at(7 * 24) }))).toBe('keep_closed');
    const g = standinFixture();
    expect(err(K.offerKeep(g.db, { entryId: g.entries[0]!, now: at(1) }))).toBe('keep_not_open');
  });
});

describe('startKeep (Ruling 4)', () => {
  it('only the captain, with a valid name and tag that are free, under the cap', () => {
    const f = finishedDraft();
    const x = offered(f);
    expect(err(start(f, x, { steamid: x.p[0] }))).toBe('not_captain');
    expect(err(start(f, x, { tag: '' }))).toBe('bad_tag');
    expect(err(start(f, x, { name: 'x' }))).toBe('bad_entry_name');
    must(T.createTeam(f.db, { creator: BENCH[0]!, name: 'Night Owls', tag: 'NOWL', now: at(0) }));
    expect(err(start(f, x))).toBe('keep_name_taken');
    expect(err(start(f, x, { name: 'Day Owls', tag: 'NOWL' }))).toBe('keep_tag_taken');
    capped(f, x.captain, 'CP');
    expect(err(start(f, x, { name: 'Day Owls' }))).toBe('keep_cap');
    expect(K.keepOf(f.db, x.keepId)?.status).toBe('offered');
  });

  it('opens 48 hours of voting with the captain counted as an accept', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'voting', name: 'Night Owls', tag: 'OWL', expires_at: at(50).toISOString() });
    expect(K.answersOf(f.db, x.keepId).map((a) => [a.steamid, a.answer])).toEqual([[x.captain, 'accept']]);
    expect(err(start(f, x))).toBe('keep_started');
  });
});

describe('answers and the team (Rulings 3, 5 to 8)', () => {
  it('makes the team at the third accept: the captain and two accepters, the draft name, tag and logo, origin draft', () => {
    const f = finishedDraft();
    f.db.prepare('UPDATE event_entries SET logo_key = ? WHERE id = ?').run('b'.repeat(64), f.entries[0]);
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    expect(err(settle(f, x))).toBe('keep_waiting');
    must(answer(f, x, x.p[1], false));
    expect(err(answer(f, x, x.p[1], true))).toBe('keep_answered');
    must(answer(f, x, x.p[2], true, 4));
    const made = must(settle(f, x, 4));
    expect(made).toMatchObject({ joined: [x.captain, x.p[0], x.p[2]], left: [] });
    expect(T.getTeam(f.db, made.teamId)).toMatchObject({ name: 'Night Owls', tag: 'OWL', origin: 'draft', origin_ref: String(f.eventId), logo_key: 'b'.repeat(64), captain_steamid: x.captain });
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'made', team_id: made.teamId });
    expect(K.answersOf(f.db, x.keepId).filter((a) => a.joined === 1).map((a) => a.steamid).sort()).toEqual([x.captain, x.p[0], x.p[2]].sort());
    expect(K.keptFrom(f.db, made.teamId)).toEqual({ eventSlug: f.slug, eventName: 'Draft Night', placement: null });
    // Review Focus 4: a second settle makes nothing.
    expect(err(settle(f, x))).toBe('keep_closed');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM teams WHERE origin = 'draft'").get()).toEqual({ n: 1 });
  });

  it('Review Focus 1: the fourth player accepts after the team is made and joins it', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    const made = must(settle(f, x));
    expect(must(answer(f, x, x.p[2], true, 10))).toEqual({ joined: true });
    expect(T.roleOf(f.db, made.teamId, x.p[2])).toBe('member');
    expect(err(answer(f, x, x.p[2], true, 11))).toBe('keep_answered');
  });

  it('an accept at the cap is refused with nothing recorded; a decline is fine', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    capped(f, x.p[0], 'AA');
    expect(err(answer(f, x, x.p[0], true))).toBe('keep_cap');
    expect(K.answersOf(f.db, x.keepId)).toHaveLength(1);
    must(answer(f, x, x.p[0], false));
  });

  it('Review Focus 2: an accepter who reached the cap since is left out, and the team waits for a third who can join', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    capped(f, x.p[0], 'AA');
    must(answer(f, x, x.p[1], true));
    expect(err(settle(f, x))).toBe('keep_waiting');
    must(answer(f, x, x.p[2], true, 4));
    const made = must(settle(f, x, 4));
    expect(made).toMatchObject({ joined: [x.captain, x.p[1], x.p[2]], left: [x.p[0]] });
    expect(T.roleOf(f.db, made.teamId, x.p[0])).toBeNull();
  });

  it('Review Focus 3: a name taken after Keep makes the team as "Name 2"', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(T.createTeam(f.db, { creator: BENCH[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    expect(T.getTeam(f.db, must(settle(f, x)).teamId)).toMatchObject({ name: 'Night Owls 2', tag: 'OWL2' });
  });
});

describe('closeKeep (Ruling 2)', () => {
  it('lapses an offer or a vote past its window, closes a made team to late accepts, and refuses one still open', () => {
    const f = finishedDraft();
    const a = offered(f);
    expect(err(K.closeKeep(f.db, { keepId: a.keepId, now: at(5) }))).toBe('keep_open');
    expect(must(K.closeKeep(f.db, { keepId: a.keepId, now: at(7 * 24) }))).toEqual({ status: 'lapsed' });
    expect(err(start(f, a, { now: at(7 * 24 + 1) }))).toBe('keep_closed');
    const entry = N.getEntry(f.db, f.entries[1]!)!;
    const { keepId } = must(K.offerKeep(f.db, { entryId: entry.id, now: at(1) }));
    const four = K.playersOf(K.keepOf(f.db, keepId)!);
    must(K.startKeep(f.db, { entryId: entry.id, steamid: four[0]!, name: 'Late Owls', tag: 'LATE', now: at(2) }));
    must(K.answerKeep(f.db, { keepId, steamid: four[1]!, accept: true, now: at(3) }));
    must(K.answerKeep(f.db, { keepId, steamid: four[2]!, accept: true, now: at(3) }));
    must(K.settleKeep(f.db, { keepId, now: at(3) }));
    expect(must(K.closeKeep(f.db, { keepId, now: at(50) }))).toEqual({ status: 'made' });
    expect(err(K.answerKeep(f.db, { keepId, steamid: four[3]!, accept: true, now: at(51) }))).toBe('keep_closed');
  });
});

describe('myKeepView', () => {
  it('shows the four their keep and its answers, and nobody else anything', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[1], false));
    const v = K.myKeepView(f.db, f.eventId, x.p[0], at(3))!;
    expect(v).toMatchObject({ keepId: x.keepId, status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null, closed: false, teamSlug: null });
    expect(v.players.map((p) => p.answer)).toEqual(['accept', null, 'decline', null]);
    expect(K.myKeepView(f.db, f.eventId, x.captain, at(3))).toMatchObject({ captain: true, myAnswer: 'accept', defaults: { name: x.entry.name, tag: x.entry.tag } });
    expect(K.myKeepView(f.db, f.eventId, BENCH[0]!, at(3))).toBeNull();
  });
});
```

Add the guard block to `tests/eventLogGuard.test.ts` (import `* as K from '../src/events/keepTeam.js'` and `{ finishedDraft } from './standinFixture.js'`):

```ts
  /** Drafts plan D3b: src/events/keepTeam.ts is the only writer of the keep
   *  tables; each mutation adds one event_log row or, when that row cannot be
   *  written, nothing (a team it would have made included). */
  describe('keep guard (src/events/keepTeam.ts)', () => {
    const KEEP_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:draft_keeps|draft_keep_answers)\b/gi;
    const KEEP_READS = new Set(['keepOf', 'keepOfEntry', 'keepsOf', 'openKeeps', 'answersOf', 'playersOf', 'keptFrom', 'myKeepView']);
    const must = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const LATER = new Date('2026-10-12T23:00:00.000Z');
    type Keep = { f: ReturnType<typeof finishedDraft>; keepId: number; four: string[] };
    const offered = (): Keep => {
      const f = finishedDraft();
      const { keepId } = must(K.offerKeep(f.db, { entryId: f.entries[0]!, now: LATER }));
      return { f, keepId, four: K.playersOf(K.keepOf(f.db, keepId)!) };
    };
    const voting = (): Keep => {
      const x = offered();
      must(K.startKeep(x.f.db, { entryId: x.f.entries[0]!, steamid: x.four[0]!, name: 'Night Owls', tag: 'OWL', now: LATER }));
      return x;
    };
    const ready = (): Keep => {
      const x = voting();
      for (const s of x.four.slice(1, 3)) must(K.answerKeep(x.f.db, { keepId: x.keepId, steamid: s, accept: true, now: LATER }));
      return x;
    };
    const KEEP_MUTATIONS: Record<string, { action: string; setup: () => Keep | { f: ReturnType<typeof finishedDraft> }; run: (x: Keep) => V.Checked<unknown> }> = {
      offerKeep: { action: 'keep_offered', setup: () => ({ f: finishedDraft() }), run: ({ f }) => K.offerKeep(f.db, { entryId: f.entries[0]!, now: LATER }) },
      startKeep: { action: 'keep_started', setup: offered, run: (x) => K.startKeep(x.f.db, { entryId: x.f.entries[0]!, steamid: x.four[0]!, name: 'Night Owls', tag: 'OWL', now: LATER }) },
      answerKeep: { action: 'keep_answered', setup: voting, run: (x) => K.answerKeep(x.f.db, { keepId: x.keepId, steamid: x.four[1]!, accept: true, now: LATER }) },
      settleKeep: { action: 'keep_team_made', setup: ready, run: (x) => K.settleKeep(x.f.db, { keepId: x.keepId, now: LATER }) },
      closeKeep: { action: 'keep_closed', setup: offered, run: (x) => K.closeKeep(x.f.db, { keepId: x.keepId, now: new Date('2026-10-30T00:00:00.000Z') }) },
    };
    const keepRows = (x: { f: ReturnType<typeof finishedDraft> }) => JSON.stringify([
      x.f.db.prepare('SELECT * FROM draft_keeps ORDER BY id').all(),
      x.f.db.prepare('SELECT * FROM draft_keep_answers ORDER BY keep_id, steamid').all(),
      x.f.db.prepare('SELECT * FROM teams ORDER BY id').all(),
      x.f.db.prepare('SELECT * FROM team_members ORDER BY id').all(),
    ]);

    it('only src/events/keepTeam.ts writes the keep tables', () => {
      const offenders = walk('src')
        .filter((f) => f !== 'src/events/keepTeam.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(KEEP_WRITERS) ?? []).length > 0);
      expect(offenders).toEqual([]);
    });

    it('every exported function of keepTeam.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(K).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !KEEP_READS.has(k)).sort()).toEqual(Object.keys(KEEP_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(KEEP_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, () => {
        const x = m.setup() as Keep;
        const before = logCount(x.f);
        const r = m.run(x);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(x.f)).toBe(before + 1);
        expect(x.f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, () => {
        const x = m.setup() as Keep;
        const before = keepRows(x);
        const logs = logCount(x.f);
        x.f.db.exec("CREATE TRIGGER keep_log_down BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
        expect(() => m.run(x)).toThrow(/audit down/);
        expect(keepRows(x)).toBe(before);
        expect(logCount(x.f)).toBe(logs);
      });
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/keepTeam.test.ts`
Expected: FAIL (`src/events/keepTeam.ts` does not exist).

- [ ] **Step 3: Implement `src/events/keepTeam.ts`**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import * as T from '../teams/teams.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as V from './validate.js';
import { KEEP_MAJORITY, KEEP_OFFER_DAYS, KEEP_VOTE_HOURS } from './draftRules.js';

/**
 * Keep this team (drafts plan D3b, spec part 3 section 7): every write to
 * draft_keeps and draft_keep_answers. Each mutation is one transaction that
 * re-reads, checks, writes and adds exactly one event_log row; a refusal
 * writes nothing. The team itself is made by src/teams/teams.ts
 * (createDraftTeam, addDraftMember) inside settleKeep's and answerKeep's
 * transactions, so a failed audit row leaves no team behind.
 */

export type KeepStatus = 'offered' | 'voting' | 'made' | 'lapsed';
export interface KeepRow {
  id: number; event_id: number; entry_id: number; captain_steamid: string; players_json: string; status: KeepStatus;
  name: string | null; tag: string | null; offered_at: string; started_at: string | null; expires_at: string; team_id: number | null; closed_at: string | null;
}
export interface KeepAnswerRow { keep_id: number; steamid: string; answer: 'accept' | 'decline'; answered_at: string; joined: number }
export interface MyKeepView {
  keepId: number; status: KeepStatus; captain: boolean; team: string; name: string | null; tag: string | null;
  /** What the captain's form starts from: the draft entry's name and tag. */
  defaults: { name: string; tag: string }; expiresAt: string; closed: boolean;
  players: { name: string; captain: boolean; answer: 'accept' | 'decline' | null }[];
  myAnswer: 'accept' | 'decline' | null; teamSlug: string | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const due = (k: KeepRow, now: Date): boolean => now.getTime() >= Date.parse(k.expires_at);

// ---------- reads ----------

export function keepOf(db: DB, id: number): KeepRow | undefined {
  return db.prepare('SELECT * FROM draft_keeps WHERE id = ?').get(id) as KeepRow | undefined;
}
export function keepOfEntry(db: DB, entryId: number): KeepRow | undefined {
  return db.prepare('SELECT * FROM draft_keeps WHERE entry_id = ?').get(entryId) as KeepRow | undefined;
}
export function keepsOf(db: DB, eventId: number): KeepRow[] {
  return db.prepare('SELECT * FROM draft_keeps WHERE event_id = ? ORDER BY id').all(eventId) as KeepRow[];
}
/** Keeps the tick still looks at. */
export function openKeeps(db: DB): KeepRow[] {
  return db.prepare('SELECT * FROM draft_keeps WHERE closed_at IS NULL ORDER BY id').all() as KeepRow[];
}
export function answersOf(db: DB, keepId: number): KeepAnswerRow[] {
  return db.prepare('SELECT * FROM draft_keep_answers WHERE keep_id = ? ORDER BY answered_at, steamid').all(keepId) as KeepAnswerRow[];
}
/** The four at the offer, captain first. */
export function playersOf(k: KeepRow): string[] {
  return JSON.parse(k.players_json) as string[];
}
/** Ruling 8: the event a kept team was formed at, with the entry's placement. */
export function keptFrom(db: DB, teamId: number): { eventSlug: string; eventName: string; placement: number | null } | null {
  const row = db.prepare(
    `SELECT e.slug, e.name, x.placement FROM draft_keeps k JOIN events e ON e.id = k.event_id JOIN event_entries x ON x.id = k.entry_id
      WHERE k.team_id = ?`,
  ).get(teamId) as { slug: string; name: string; placement: number | null } | undefined;
  return row ? { eventSlug: row.slug, eventName: row.name, placement: row.placement } : null;
}
/** The viewer's keep in this event: only for one of its four. */
export function myKeepView(db: DB, eventId: number, viewer: string, now: Date): MyKeepView | null {
  const k = keepsOf(db, eventId).find((x) => playersOf(x).includes(viewer));
  if (!k) return null;
  const entry = N.getEntry(db, k.entry_id);
  const answers = new Map(answersOf(db, k.id).map((a) => [a.steamid, a.answer]));
  const team = k.team_id !== null ? T.getTeam(db, k.team_id) : undefined;
  return {
    keepId: k.id, status: k.status, captain: k.captain_steamid === viewer, team: entry?.name ?? '', name: k.name, tag: k.tag,
    defaults: { name: entry?.name ?? '', tag: entry?.tag ?? '' }, expiresAt: k.expires_at, closed: k.closed_at !== null || due(k, now),
    players: playersOf(k).map((s) => ({ name: getPlayer(db, s)?.name ?? s, captain: s === k.captain_steamid, answer: answers.get(s) ?? null })),
    myAnswer: answers.get(viewer) ?? null, teamSlug: team?.slug ?? null,
  };
}

// ---------- mutations ----------

/** Rulings 1 and 2: the tick offers a finished draft team's captain, within KEEP_OFFER_DAYS of the finish. */
export function offerKeep(db: DB, o: { entryId: number; now: Date }): V.Checked<{ keepId: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ keepId: number }> => {
    const entry = N.getEntry(db, o.entryId);
    if (!entry || entry.captain_steamid === null || !N.isActive(entry)) return V.fail('keep_not_open');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.entry_kind !== 'draft' || ev.status !== 'finished' || ev.finished_at === null) return V.fail('keep_not_open');
    if (keepOfEntry(db, entry.id)) return V.fail('keep_started');
    const ends = Date.parse(ev.finished_at) + KEEP_OFFER_DAYS * DAY;
    if (o.now.getTime() >= ends) return V.fail('keep_closed');
    const captain = entry.captain_steamid;
    const players = [captain, ...N.rosterOf(db, entry.id).starters.filter((s) => s !== captain)];
    if (players.length < KEEP_MAJORITY) return V.fail('keep_not_open');
    const id = Number(db.prepare(
      `INSERT INTO draft_keeps (event_id, entry_id, captain_steamid, players_json, status, offered_at, expires_at)
       VALUES (?, ?, ?, ?, 'offered', ?, ?)`,
    ).run(ev.id, entry.id, captain, JSON.stringify(players), at, new Date(ends).toISOString()).lastInsertRowid);
    E.logEvent(db, ev.id, null, 'keep_offered', at, { keepId: id, entryId: entry.id });
    return V.ok({ keepId: id });
  })();
}

/** Ruling 4: the captain presses Keep with the team's name and tag. They
 *  count as the first accept; voting runs KEEP_VOTE_HOURS. */
export function startKeep(db: DB, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }> {
  const at = o.now.toISOString();
  const n = T.normalizeName(o.name);
  if (!n.ok) return V.fail(n.error === 'name_not_allowed' ? 'name_not_allowed' : 'bad_entry_name');
  const t = T.normalizeTag(o.tag);
  if (!t.ok) return V.fail(t.error === 'tag_not_allowed' ? 'tag_not_allowed' : 'bad_tag');
  return db.transaction((): V.Checked<{ keepId: number }> => {
    const k = keepOfEntry(db, o.entryId);
    if (!k) return V.fail('keep_not_open');
    if (k.captain_steamid !== o.steamid) return V.fail('not_captain');
    if (k.status === 'lapsed' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    if (k.status !== 'offered') return V.fail('keep_started');
    if (T.nameTaken(db, n.key)) return V.fail('keep_name_taken');
    if (T.tagTaken(db, t.key)) return V.fail('keep_tag_taken');
    if (T.activeMembershipCount(db, o.steamid) >= T.membershipCap(db)) return V.fail('keep_cap');
    if (!T.canCreate(db, o.steamid)) return V.fail('keep_created_cap');
    const expires = new Date(o.now.getTime() + KEEP_VOTE_HOURS * HOUR).toISOString();
    db.prepare("UPDATE draft_keeps SET status = 'voting', name = ?, tag = ?, started_at = ?, expires_at = ? WHERE id = ?").run(n.name, t.tag, at, expires, k.id);
    db.prepare("INSERT INTO draft_keep_answers (keep_id, steamid, answer, answered_at) VALUES (?, ?, 'accept', ?)").run(k.id, o.steamid, at);
    E.logEvent(db, k.event_id, o.steamid, 'keep_started', at, { keepId: k.id, name: n.name, tag: t.tag });
    return V.ok({ keepId: k.id });
  })();
}

/** One of the other three answers (Rulings 3 and 6). An accept at the cap is
 *  refused with nothing written. After the team is made, an accept joins it
 *  at once (Review Focus 1). */
export function answerKeep(db: DB, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ joined: boolean }> => {
    const k = keepOf(db, o.keepId);
    if (!k) return V.fail('keep_not_open');
    if (!playersOf(k).includes(o.steamid) || o.steamid === k.captain_steamid) return V.fail('keep_not_player');
    if (k.status === 'offered') return V.fail('keep_not_open');
    if (k.status === 'lapsed' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    if (answersOf(db, k.id).some((a) => a.steamid === o.steamid)) return V.fail('keep_answered');
    if (o.accept && T.activeMembershipCount(db, o.steamid) >= T.membershipCap(db)) return V.fail('keep_cap');
    let joined = false;
    if (o.accept && k.status === 'made' && k.team_id !== null) {
      const add = T.addDraftMember(db, { teamId: k.team_id, steamid: o.steamid, now: o.now });
      if (!add.ok) return V.fail(add.error === 'their_cap' ? 'keep_cap' : add.error === 'already_member' ? 'keep_answered' : 'keep_closed');
      joined = true;
    }
    db.prepare('INSERT INTO draft_keep_answers (keep_id, steamid, answer, answered_at, joined) VALUES (?, ?, ?, ?, ?)')
      .run(k.id, o.steamid, o.accept ? 'accept' : 'decline', at, joined ? 1 : 0);
    E.logEvent(db, k.event_id, o.steamid, 'keep_answered', at, { keepId: k.id, accept: o.accept, joined });
    return V.ok({ joined });
  })();
}

/** Ruling 3: once three accepters can join, the team is made (an accepter at
 *  the cap is left out). keep_waiting while fewer can. A made or closed keep
 *  is keep_closed, so two settles never make two teams (Review Focus 4). */
export function settleKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<{ teamId: number; slug: string; joined: string[]; left: string[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ teamId: number; slug: string; joined: string[]; left: string[] }> => {
    const k = keepOf(db, o.keepId);
    if (!k || k.status !== 'voting' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    const accepted = answersOf(db, k.id).filter((a) => a.answer === 'accept').map((a) => a.steamid);
    if (accepted.length < KEEP_MAJORITY) return V.fail('keep_waiting');
    const entry = N.getEntry(db, k.entry_id)!;
    const made = T.createDraftTeam(db, {
      captain: k.captain_steamid, members: accepted, name: k.name!, tag: k.tag!, logoKey: entry.logo_key, eventId: k.event_id, min: KEEP_MAJORITY, now: o.now,
    });
    if (!made.ok) return V.fail('keep_waiting');
    db.prepare("UPDATE draft_keeps SET status = 'made', team_id = ? WHERE id = ?").run(made.value.id, k.id);
    const join = db.prepare('UPDATE draft_keep_answers SET joined = 1 WHERE keep_id = ? AND steamid = ?');
    for (const s of made.value.joined) join.run(k.id, s);
    E.logEvent(db, k.event_id, null, 'keep_team_made', at, {
      keepId: k.id, teamId: made.value.id, name: made.value.name, tag: made.value.tag, joined: made.value.joined, left: made.value.left,
    });
    return V.ok({ teamId: made.value.id, slug: made.value.slug, joined: made.value.joined, left: made.value.left });
  })();
}

/** Ruling 2: the tick closes a keep past its window. An offer or a vote
 *  lapses; a made team keeps its status and stops taking late accepts. */
export function closeKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<{ status: KeepStatus }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ status: KeepStatus }> => {
    const k = keepOf(db, o.keepId);
    if (!k || k.closed_at !== null) return V.fail('keep_closed');
    if (!due(k, o.now)) return V.fail('keep_open');
    const status: KeepStatus = k.status === 'made' ? 'made' : 'lapsed';
    db.prepare('UPDATE draft_keeps SET status = ?, closed_at = ? WHERE id = ?').run(status, at, k.id);
    E.logEvent(db, k.event_id, null, 'keep_closed', at, { keepId: k.id, status });
    return V.ok({ status });
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/keepTeam.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/events/keepTeam.ts tests/standinFixture.ts tests/keepTeam.test.ts tests/eventLogGuard.test.ts
git commit -m "A finished draft team can be kept: the captain presses Keep with a name and tag, the other three accept or decline, and once three of the four can join a site team is made from it, with late accepters joining, capped players left out and every step logged once (plan D3b)"
```

### Task 3: The tick, the DMs and the Discord buttons

**Files:**
- Create: `src/events/keepFlow.ts`, `src/discord/keepButtons.ts`
- Modify: `src/events/runner.ts`, `src/notify/notify.ts`, `src/events/messages.ts`, `src/events/notices.ts`, `src/server.ts`, `tests/notify.test.ts`
- Test: `tests/keepFlow.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `K.*`; `tell` (private in `notices.ts`); `KEEP_OFFER_DAYS`, `KEEP_BUTTON_PREFIX`.
- Produces:
  ```ts
  // src/events/keepFlow.ts
  export function startKeepFlow(d: NoticeDeps, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }>;
  export function answerKeepFlow(d: NoticeDeps, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean; teamSlug: string | null }>;
  // src/events/notices.ts
  export function tellKeepOffer(d: NoticeDeps, eventId: number, keepId: number): void;
  export function tellKeepAsk(d: NoticeDeps, eventId: number, keepId: number): void;
  export function tellKeepMade(d: NoticeDeps, eventId: number, keepId: number): void;
  export function tellKeepJoined(d: NoticeDeps, eventId: number, keepId: number, steamid: string): void;
  // src/discord/keepButtons.ts
  export function handleKeepButton(deps: { db: DB; publicUrl: string; notifier?: Notifier; now?: () => number }, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply>;
  ```
- New `NotifyType`s: `draft_keep_offer`, `draft_keep_ask`, `draft_keep_made`, `draft_keep_left_out`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/keepFlow.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventRunner } from '../src/events/runner.js';
import * as K from '../src/events/keepTeam.js';
import { answerKeepFlow, startKeepFlow } from '../src/events/keepFlow.js';
import { handleKeepButton } from '../src/discord/keepButtons.js';
import * as T from '../src/teams/teams.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import type { Notifier } from '../src/notify/notify.js';
import type { MessagePayload } from '../src/discord/transport.js';
import { P } from './draftFixture.js';
import { BENCH, FINISHED, finishedDraft, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
const at = (h: number) => new Date(FINISHED.getTime() + h * H);
const must = <X>(r: { ok: true; value: X } | { ok: false; error: string }): X => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
function harness(f: StandinFixture) {
  const dms: { to: string[]; type: string; payload: MessagePayload }[] = [];
  const send = vi.fn((to: Iterable<string>, type: string, payload: MessagePayload) => { dms.push({ to: [...to], type, payload }); return 1; });
  const notifier = { send } as unknown as Notifier;
  return {
    dms, deps: { db: f.db, notifier, publicUrl: 'https://x' },
    runner: new EventRunner({ db: f.db, notifier, publicUrl: 'https://x' }),
    of: (type: string) => dms.filter((d) => d.type === type),
  };
}
const ids = (p: MessagePayload) => p.components.flat().map((b) => ('customId' in b ? b.customId : b.url));
const capped = (f: StandinFixture, steamid: string, prefix: string) => {
  for (let i = 1; i <= 3; i++) must(T.createTeam(f.db, { creator: steamid, name: `${prefix} Squad ${i}`, tag: `${prefix}${i}`, now: at(0) }));
};
/** draftFixture links P[i] to Discord id dd<i>. */
const discordOf = (steamid: string) => `dd${P.indexOf(steamid)}`;

describe('the minute tick (Rulings 1 and 2)', () => {
  it('offers every finished draft team\'s captain a Keep button, once', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    expect(h.of('draft_keep_offer')).toHaveLength(4);
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const dm = h.of('draft_keep_offer').find((d) => d.to[0] === k.captain_steamid)!;
    expect(ids(dm.payload)).toEqual([`dk:k:${k.id}`, `https://x/event/${f.slug}`]);
    h.runner.step(at(2));
    expect(h.of('draft_keep_offer')).toHaveLength(4);
  });

  it('Review Focus 5: no offer for an event finished 7 days ago or more, and an untouched keep lapses at its window', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(7 * 24));
    expect(K.keepsOf(f.db, f.eventId)).toEqual([]);
    const g = finishedDraft();
    const hg = harness(g);
    hg.runner.step(at(1));
    hg.runner.step(at(7 * 24));
    expect(K.keepsOf(g.db, g.eventId).map((k) => [k.status, k.closed_at])).toEqual(Array(4).fill(['lapsed', at(7 * 24).toISOString()]));
  });
});

describe('Keep, the answers and the DMs', () => {
  it('Keep asks the other three with Accept and Decline; the team is made once three can join, telling who joined and who was left out', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    must(startKeepFlow(h.deps, { entryId: k.entry_id, steamid: four[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    const asks = h.of('draft_keep_ask');
    expect(asks.flatMap((d) => d.to).sort()).toEqual(four.slice(1).sort());
    expect(ids(asks[0]!.payload)).toEqual([`dk:a:${k.id}`, `dk:d:${k.id}`, `https://x/event/${f.slug}`]);
    expect(must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[1]!, accept: true, now: at(3) }))).toEqual({ joined: false, teamSlug: null });
    capped(f, four[1]!, 'AA');
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[2]!, accept: true, now: at(3) }));
    expect(h.of('draft_keep_made')).toEqual([]);
    expect(must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[3]!, accept: true, now: at(4) }))).toEqual({ joined: true, teamSlug: 'night-owls' });
    expect(h.of('draft_keep_made').flatMap((d) => d.to).sort()).toEqual([four[0], four[2], four[3]].sort());
    expect(h.of('draft_keep_left_out').flatMap((d) => d.to)).toEqual([four[1]]);
    expect(h.of('draft_keep_made')[0]!.payload.content).toContain('https://x/team/night-owls');
  });

  it('the tick makes the team when a capped accepter has since left a team', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    must(startKeepFlow(h.deps, { entryId: k.entry_id, steamid: four[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[1]!, accept: true, now: at(3) }));
    capped(f, four[1]!, 'AA');
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[2]!, accept: true, now: at(3) }));
    expect(K.keepOf(f.db, k.id)?.status).toBe('voting');
    const squad = T.myTeams(f.db, four[1]!)[0]!;
    must(T.disbandTeam(f.db, { teamId: squad.id, by: four[1]!, staff: false }));
    h.runner.step(at(5));
    expect(K.keepOf(f.db, k.id)?.status).toBe('made');
    expect(h.of('draft_keep_made').flatMap((d) => d.to).sort()).toEqual([four[0], four[1], four[2]].sort());
  });
});

describe('handleKeepButton', () => {
  it('the captain keeps the team from Discord when the entry has a tag, and the others answer there', async () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    const press = (customId: string, userId: string) =>
      handleKeepButton({ db: f.db, publicUrl: 'https://x', notifier: h.deps.notifier, now: () => at(2).getTime() }, { kind: 'button', customId, userId } as never);
    expect((await press(`dk:k:${k.id}`, discordOf(four[0]!))).payload.content).toContain('Choose a team name and a tag on the event page first');
    // Test setup only: the captain had set a tag on the event page.
    f.db.prepare("UPDATE event_entries SET tag = 'OWL' WHERE id = ?").run(k.entry_id);
    expect((await press(`dk:k:${k.id}`, discordOf(four[1]!))).payload.content).toBe(EVENT_ERRORS.not_captain.text);
    expect((await press(`dk:k:${k.id}`, discordOf(four[0]!))).payload.content).toContain('Your three were asked');
    expect((await press(`dk:d:${k.id}`, discordOf(four[1]!))).payload.content).toBe('You declined.');
    expect((await press(`dk:a:${k.id}`, discordOf(four[2]!))).payload.content).toBe('You accepted. The team is made when 3 of the 4 of you accept.');
    expect((await press(`dk:a:${k.id}`, discordOf(four[3]!))).payload.content).toMatch(/^You are on the team: https:\/\/x\/team\//);
    expect((await press(`dk:a:${k.id}`, discordOf(BENCH[0]!))).payload.content).toBe(EVENT_ERRORS.keep_not_player.text);
  });
});
```

In `tests/notify.test.ts`, next to the D3a lines:

```ts
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_keep_offer')).toEqual({ type: 'draft_keep_offer', label: 'Draft: keep my draft team together after the event' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_keep_ask')).toEqual({ type: 'draft_keep_ask', label: 'Draft: my captain wants to keep our draft team' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_keep_made')).toEqual({ type: 'draft_keep_made', label: 'Draft: our kept draft team is made' });
    expect(NOTIFY_TYPES.find((t) => t.type === 'draft_keep_left_out')).toEqual({ type: 'draft_keep_left_out', label: 'Draft: I was left out of our kept team (team cap)' });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/keepFlow.test.ts tests/notify.test.ts`
Expected: FAIL (`src/events/keepFlow.ts` and `src/discord/keepButtons.ts` do not exist; the labels are missing).

- [ ] **Step 3: Implement**

`src/notify/notify.ts` and `src/events/messages.ts`: append the four types (labels as the test reads).

`src/events/messages.ts` (imports `{ keepOf } from './keepTeam.js'`, `{ getTeam } from '../teams/teams.js'`, `KEEP_BUTTON_PREFIX` next to `STANDIN_BUTTON_PREFIX`; `extra` gains `keepId?: number`), new cases:

```ts
    case 'draft_keep_offer': {
      // Plan D3b Ruling 2: the captain, with the Keep button.
      const k = extra.keepId !== undefined ? keepOf(db, extra.keepId) : undefined;
      if (!k || !entry) return null;
      return {
        content: `${event} is over. Keep ${team} together as a real team? Press Keep this team to ask your three; the team is made when 3 of the 4 of you accept. Open until ${discordTime(k.expires_at)}. To choose another name or tag first, use the event page.`,
        embeds: [],
        components: [[
          { kind: 'button', customId: `${KEEP_BUTTON_PREFIX}k:${k.id}`, label: 'Keep this team', style: 'success' },
          { kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' },
        ]],
        mentionUserIds: [],
      };
    }
    case 'draft_keep_ask': {
      const k = extra.keepId !== undefined ? keepOf(db, extra.keepId) : undefined;
      if (!k || k.name === null || k.tag === null) return null;
      return {
        content: `${nameIn(db, k.captain_steamid)} wants to keep ${team} from ${event} together as a real team, ${escapeName(k.name)} [${k.tag}]. It is made when 3 of the 4 of you accept, by ${discordTime(k.expires_at)}.`,
        embeds: [],
        components: [[
          { kind: 'button', customId: `${KEEP_BUTTON_PREFIX}a:${k.id}`, label: 'Accept', style: 'success' },
          { kind: 'button', customId: `${KEEP_BUTTON_PREFIX}d:${k.id}`, label: 'Decline', style: 'secondary' },
          { kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' },
        ]],
        mentionUserIds: [],
      };
    }
    case 'draft_keep_made':
    case 'draft_keep_left_out': {
      const k = extra.keepId !== undefined ? keepOf(db, extra.keepId) : undefined;
      const t = k && k.team_id !== null ? getTeam(db, k.team_id) : undefined;
      if (!k || !t) return null;
      const url = `${publicUrl}/team/${t.slug}`;
      return {
        content: type === 'draft_keep_made'
          ? `${escapeName(t.name)} [${t.tag}] is a team now, formed at ${event}: ${url}`
          : `${escapeName(t.name)} [${t.tag}] was made from ${team} in ${event}, but you are on as many teams as allowed, so you were left out. Leave a team, then ask its captain for an invite: ${url}`,
        embeds: [],
        components: [[{ kind: 'link', url, label: 'Team page' }]],
        mentionUserIds: [],
      };
    }
```

`src/events/notices.ts` (import `{ answersOf, keepOf, playersOf } from './keepTeam.js'`):

```ts
/** Plan D3b: a finished draft team's captain, with the Keep button. */
export function tellKeepOffer(d: NoticeDeps, eventId: number, keepId: number): void {
  const k = keepOf(d.db, keepId);
  if (k) tell(d, [k.captain_steamid], eventId, 'draft_keep_offer', { keepId, entryId: k.entry_id });
}
/** The captain pressed Keep: the other three, with Accept and Decline. */
export function tellKeepAsk(d: NoticeDeps, eventId: number, keepId: number): void {
  const k = keepOf(d.db, keepId);
  if (k) tell(d, playersOf(k).filter((s) => s !== k.captain_steamid), eventId, 'draft_keep_ask', { keepId, entryId: k.entry_id });
}
/** The team was made: who joined, and each accepter left out at the cap (Ruling 6). */
export function tellKeepMade(d: NoticeDeps, eventId: number, keepId: number): void {
  const k = keepOf(d.db, keepId);
  if (!k) return;
  const answers = answersOf(d.db, keepId);
  tell(d, answers.filter((a) => a.joined === 1).map((a) => a.steamid), eventId, 'draft_keep_made', { keepId, entryId: k.entry_id });
  tell(d, answers.filter((a) => a.answer === 'accept' && a.joined === 0).map((a) => a.steamid), eventId, 'draft_keep_left_out', { keepId, entryId: k.entry_id });
}
/** A late accept joined the made team: that player. */
export function tellKeepJoined(d: NoticeDeps, eventId: number, keepId: number, steamid: string): void {
  const k = keepOf(d.db, keepId);
  if (k) tell(d, [steamid], eventId, 'draft_keep_made', { keepId, entryId: k.entry_id });
}
```

`src/events/keepFlow.ts`:

```ts
import * as T from '../teams/teams.js';
import * as K from './keepTeam.js';
import * as V from './validate.js';
import { tellKeepAsk, tellKeepJoined, tellKeepMade, type NoticeDeps } from './notices.js';

/**
 * Keep this team, sequenced for the routes and the Discord buttons (drafts
 * plan D3b): each keepTeam.ts mutation, then its DMs after the commit. An
 * accept tries to make the team at once (Ruling 3); the minute tick tries
 * again for keeps still waiting.
 */
export function startKeepFlow(d: NoticeDeps, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }> {
  const r = K.startKeep(d.db, o);
  if (r.ok) tellKeepAsk(d, K.keepOf(d.db, r.value.keepId)!.event_id, r.value.keepId);
  return r;
}

export function answerKeepFlow(d: NoticeDeps, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean; teamSlug: string | null }> {
  const r = K.answerKeep(d.db, o);
  if (!r.ok) return r;
  const k = K.keepOf(d.db, o.keepId)!;
  let joined = r.value.joined;
  if (joined) tellKeepJoined(d, k.event_id, k.id, o.steamid);
  if (o.accept && k.status === 'voting') {
    const s = K.settleKeep(d.db, { keepId: k.id, now: o.now });
    if (s.ok) {
      tellKeepMade(d, k.event_id, k.id);
      joined = s.value.joined.includes(o.steamid);
    }
  }
  const after = K.keepOf(d.db, k.id)!;
  const team = after.team_id !== null ? T.getTeam(d.db, after.team_id) : undefined;
  return V.ok({ joined, teamSlug: joined ? team?.slug ?? null : null });
}
```

`src/events/runner.ts`: import `* as K from './keepTeam.js'`, `KEEP_OFFER_DAYS` from `./draftRules.js`, `tellKeepMade, tellKeepOffer` from `./notices.js`; at the end of `step(now)` add `this.stepKeeps(now);` and the method:

```ts
  /** Drafts plan D3b: offer Keep this team to each finished draft team's
   *  captain within KEEP_OFFER_DAYS of the finish, close keeps past their
   *  window, and make the team for a vote that can now be made (an accepter
   *  left a team since). Each keep is caught on its own. */
  private stepKeeps(now: Date): void {
    const { db } = this.deps;
    const since = new Date(now.getTime() - KEEP_OFFER_DAYS * 86_400_000).toISOString();
    const finished = db.prepare(
      "SELECT id FROM events WHERE entry_kind = 'draft' AND status = 'finished' AND finished_at > ? ORDER BY id",
    ).all(since) as { id: number }[];
    for (const { id } of finished) {
      for (const e of N.entriesOf(db, id)) {
        if (!N.isActive(e) || e.captain_steamid === null || K.keepOfEntry(db, e.id)) continue;
        try {
          const r = K.offerKeep(db, { entryId: e.id, now });
          if (r.ok) tellKeepOffer(this.deps, id, r.value.keepId);
        } catch (err) {
          console.error(`[events] keep offer for entry ${e.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
    for (const k of K.openKeeps(db)) {
      try {
        if (Date.parse(k.expires_at) <= now.getTime()) {
          K.closeKeep(db, { keepId: k.id, now });
          continue;
        }
        if (k.status !== 'voting') continue;
        const s = K.settleKeep(db, { keepId: k.id, now });
        if (s.ok) tellKeepMade(this.deps, k.event_id, k.id);
      } catch (err) {
        console.error(`[events] keep ${k.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
```

`src/discord/keepButtons.ts`:

```ts
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import type { BotInteraction, InteractionReply } from './transport.js';
import { escapeName } from '../identity.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as K from '../events/keepTeam.js';
import * as V from '../events/validate.js';
import { answerKeepFlow, startKeepFlow } from '../events/keepFlow.js';

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });

/**
 * The keep buttons (drafts plan D3b). Custom ids: dk:k:<keepId> on the
 * captain's offer DM (Keep with the entry's name and tag as they are; with no
 * tag the captain is sent to the event page), dk:a:<keepId> and
 * dk:d:<keepId> on the others' ask DM. The Discord id resolves to the linked
 * player, and keepTeam.ts checks that player as the site's routes do.
 */
export async function handleKeepButton(
  deps: { db: DB; publicUrl: string; notifier?: Notifier; now?: () => number }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, kind, raw] = i.customId.split(':');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  if (!competitiveAccess(deps.db, player.steamid)) return say('Teams are not open yet.');
  const k = Number.isInteger(Number(raw)) ? K.keepOf(deps.db, Number(raw)) : undefined;
  const ev = k ? E.getEvent(deps.db, k.event_id) : undefined;
  if (!k || !ev) return say('That button no longer does anything.');
  const link = `${deps.publicUrl}/event/${ev.slug}`;
  const d = { db: deps.db, notifier: deps.notifier, publicUrl: deps.publicUrl };
  const now = new Date((deps.now ?? Date.now)());
  if (kind === 'k') {
    const entry = N.getEntry(deps.db, k.entry_id)!;
    if (k.captain_steamid !== player.steamid) return say(V.EVENT_ERRORS.not_captain.text);
    if (entry.tag === '') return say(`Choose a team name and a tag on the event page first: ${link}`);
    const r = startKeepFlow(d, { entryId: entry.id, steamid: player.steamid, name: entry.name, tag: entry.tag, now });
    return say(r.ok ? `Your three were asked. ${escapeName(entry.name)} becomes a team when 3 of the 4 of you accept.` : `${V.EVENT_ERRORS[r.error].text} ${link}`);
  }
  if (kind === 'a' || kind === 'd') {
    const r = answerKeepFlow(d, { keepId: k.id, steamid: player.steamid, accept: kind === 'a', now });
    if (!r.ok) return say(V.EVENT_ERRORS[r.error].text);
    if (kind === 'd') return say('You declined.');
    return say(r.value.joined && r.value.teamSlug ? `You are on the team: ${deps.publicUrl}/team/${r.value.teamSlug}` : 'You accepted. The team is made when 3 of the 4 of you accept.');
  }
  return say('That button no longer does anything.');
}
```

`src/server.ts`: import `handleKeepButton` and `KEEP_BUTTON_PREFIX`; in `extraButtons` add
`[KEEP_BUTTON_PREFIX]: (i) => handleKeepButton({ db: deps.db, publicUrl: deps.config.publicUrl, notifier }, i),`
(`notifier` is declared further down the same function; the closure reads it at press time, which TypeScript allows inside a deferred function).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/keepFlow.test.ts tests/notify.test.ts tests/draftOffers.test.ts && npm run typecheck`
Expected: PASS, typecheck clean (`tests/draftOffers.test.ts` covers the runner's other step paths).

- [ ] **Step 5: Commit**

```bash
git add src/events/keepFlow.ts src/discord/keepButtons.ts src/events/runner.ts src/notify/notify.ts src/events/messages.ts src/events/notices.ts src/server.ts tests/keepFlow.test.ts tests/notify.test.ts
git commit -m "The events tick offers each finished draft team's captain Keep this team by Discord DM, the others accept or decline from their DM, the team is made and announced to who joined and who was left out, and keeps past their window close (plan D3b)"
```

### Task 4: The event page panel, its routes, and "Formed at" on the team page

**Files:**
- Create: `src/routes/keepTeam.ts`, `web/src/routes/event/KeepTeamPanel.tsx`
- Modify: `src/routes/teams.ts`, `src/server.ts`, `web/src/api.ts`, `web/src/routes/Event.tsx`, `web/src/routes/Event.test.tsx` (one mock), `web/src/routes/Team.tsx`, `web/src/routes/Team.test.tsx`
- Test: `tests/keepRoutes.test.ts`, `web/src/routes/event/KeepTeamPanel.test.tsx` (new)

**Interfaces:**
- Consumes: Task 3's `startKeepFlow`, `answerKeepFlow`; Task 2's `K.myKeepView`, `K.keepsOf`, `K.playersOf`, `K.keptFrom`.
- Produces:
  ```ts
  // src/routes/keepTeam.ts
  export async function keepRoutes(app: FastifyInstance, opts: { db: DB; notifier?: Notifier; publicUrl?: string; now?: () => number }): Promise<void>;
  //   GET  /api/events/:slug/keep          -> { keep: MyKeepView | null }
  //   POST /api/events/:slug/keep/start    { name, tag } -> { keepId }
  //   POST /api/events/:slug/keep/answer   { accept }    -> { joined, teamSlug }
  // src/routes/teams.ts: TeamView gains
  origin: { eventSlug: string; eventName: string; placement: number | null } | null;
  // web/src/api.ts
  export interface MyKeepView { /* as src/events/keepTeam.ts */ }
  eventsApi.keep(slug: string, signal?: AbortSignal): Promise<{ keep: MyKeepView | null }>;
  eventsApi.startKeep(slug: string, body: { name: string; tag: string }): Promise<{ keepId: number }>;
  eventsApi.answerKeep(slug: string, accept: boolean): Promise<{ joined: boolean; teamSlug: string | null }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/keepRoutes.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { keepRoutes } from '../src/routes/keepTeam.js';
import { teamRoutes } from '../src/routes/teams.js';
import * as K from '../src/events/keepTeam.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import type { CommunityStore } from '../src/community/store.js';
import { authedCookie } from './helpers.js';
import { BENCH, FINISHED, finishedDraft, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
let f: StandinFixture;
let app: FastifyInstance;
let t = FINISHED.getTime() + H;

async function build(): Promise<{ keepId: number; four: string[] }> {
  f = finishedDraft();
  t = FINISHED.getTime() + H;
  const { keepId } = K.offerKeep(f.db, { entryId: f.entries[0]!, now: new Date(t) }) as { ok: true; value: { keepId: number } };
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(keepRoutes, { db: f.db, publicUrl: 'https://x', now: () => t });
  await app.register(teamRoutes, { db: f.db, store: () => ({}) as CommunityStore, publicUrl: 'https://x' });
  await app.ready();
  return { keepId, four: K.playersOf(K.keepOf(f.db, keepId)!) };
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who: string) => app.inject({ method: 'GET', url, cookies: as(who) });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const keep = (p = '') => `/api/events/${f.slug}/keep${p}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });

describe('Keep this team on the event page', () => {
  it('the captain keeps the team, two accept, and the new team page says where it was formed', async () => {
    const { four } = await build();
    expect((await get(keep(), four[0]!)).json().keep).toMatchObject({ status: 'offered', captain: true, myAnswer: null });
    expect((await post(keep('/start'), four[1]!, { name: 'Night Owls', tag: 'OWL' })).json()).toEqual(text('not_captain'));
    expect((await post(keep('/start'), four[0]!, { name: 'Night Owls', tag: 'OWL' })).statusCode).toBe(200);
    expect((await get(keep(), four[1]!)).json().keep).toMatchObject({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null });
    expect((await post(keep('/answer'), four[1]!, { accept: true })).json()).toEqual({ joined: false, teamSlug: null });
    expect((await post(keep('/answer'), four[2]!, { accept: true })).json()).toEqual({ joined: true, teamSlug: 'night-owls' });
    const team = (await get('/api/teams/night-owls', four[3]!)).json();
    expect(team.origin).toEqual({ eventSlug: f.slug, eventName: 'Draft Night', placement: null });
    expect(team.members).toHaveLength(3);
  });

  it('a player outside the four sees nothing and cannot answer; a bad tag is refused', async () => {
    const { four } = await build();
    expect((await get(keep(), BENCH[0]!)).json()).toEqual({ keep: null });
    expect((await post(keep('/answer'), BENCH[0]!, { accept: true })).json()).toEqual(text('keep_not_player'));
    expect((await post(keep('/start'), BENCH[0]!, { name: 'X Team', tag: 'XT' })).json()).toEqual(text('keep_not_open'));
    expect((await post(keep('/start'), four[0]!, { name: 'Night Owls', tag: '' })).json()).toEqual(text('bad_tag'));
    expect((await post(keep('/answer'), four[1]!, { accept: 'yes' })).json()).toEqual(text('bad_request'));
  });

  it('a site team that was not kept from a draft has no origin', async () => {
    const { four } = await build();
    await post('/api/teams', four[3]!, { name: 'Site Rats', tag: 'SRAT' });
    expect((await get('/api/teams/site-rats', four[3]!)).json().origin).toBeNull();
  });
});
```

```tsx
// web/src/routes/event/KeepTeamPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyKeepView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({ mockEvents: { keep: vi.fn(), startKeep: vi.fn(), answerKeep: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
const { KeepTeamPanel } = await import('./KeepTeamPanel');

const keep = (over: Partial<MyKeepView> = {}): MyKeepView => ({
  keepId: 3, status: 'offered', captain: true, team: 'Team cap', name: null, tag: null, defaults: { name: 'Team cap', tag: 'CAP' },
  expiresAt: '2026-10-19T22:00:00.000Z', closed: false, myAnswer: null, teamSlug: null,
  players: [{ name: 'cap', captain: true, answer: null }, { name: 'ann', captain: false, answer: null }, { name: 'bob', captain: false, answer: null }, { name: 'dee', captain: false, answer: null }],
  ...over,
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('KeepTeamPanel', () => {
  it('renders nothing without a keep', async () => {
    mockEvents.keep.mockResolvedValue({ keep: null });
    const { container } = render(<KeepTeamPanel slug="cup" />);
    await waitFor(() => expect(mockEvents.keep).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('the captain keeps the team with the name and tag prefilled from the draft team', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep() });
    mockEvents.startKeep.mockResolvedValue({ keepId: 3 });
    render(<KeepTeamPanel slug="cup" />);
    expect((await screen.findByLabelText('Team name') as HTMLInputElement).value).toBe('Team cap');
    fireEvent.input(screen.getByLabelText('Team name'), { target: { value: 'Night Owls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep this team' }));
    await waitFor(() => expect(mockEvents.startKeep).toHaveBeenCalledWith('cup', { name: 'Night Owls', tag: 'CAP' }));
  });

  it('a drafted player sees the answers so far and accepts', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', players: [
      { name: 'cap', captain: true, answer: 'accept' }, { name: 'ann', captain: false, answer: null }, { name: 'bob', captain: false, answer: 'decline' }, { name: 'dee', captain: false, answer: null },
    ] }) });
    mockEvents.answerKeep.mockResolvedValue({ joined: false, teamSlug: null });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText(/Night Owls \[OWL\]: made when 3 of the 4 of you accept/)).toBeTruthy();
    expect(screen.getByText(/bob · Declined/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockEvents.answerKeep).toHaveBeenCalledWith('cup', true));
  });

  it('links the team once it is made, and says when the window closed', async () => {
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'made', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: 'accept', teamSlug: 'night-owls' }) });
    render(<KeepTeamPanel slug="cup" />);
    expect((await screen.findByRole('link', { name: 'Open the team page' })).getAttribute('href')).toBe('/team/night-owls');
    cleanup();
    mockEvents.keep.mockResolvedValue({ keep: keep({ status: 'lapsed', closed: true }) });
    render(<KeepTeamPanel slug="cup" />);
    expect(await screen.findByText('Keep this team has closed.')).toBeTruthy();
  });
});
```

In `web/src/routes/Team.test.tsx`, add:

```tsx
  it('says where a kept draft team was formed', async () => {
    mockTeams.get.mockResolvedValue(view({ origin: { eventSlug: 'draft-night', eventName: 'Draft Night', placement: 2 } }));
    render(<Team slug="rats" session={session('9')} />);
    expect((await screen.findByRole('link', { name: 'Draft Night' })).getAttribute('href')).toBe('/event/draft-night');
    expect(screen.getByText(/Formed at/)).toBeTruthy();
    expect(screen.getByText(/\(2nd\)/)).toBeTruthy();
  });
```

and the `view()` helper gains `origin: null,` so the other tests keep their shape. In `web/src/routes/Event.test.tsx`, the hoisted `mockEvents` gains `keep: vi.fn(async () => ({ keep: null }))`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/keepRoutes.test.ts && npx vitest run --project web web/src/routes/event/KeepTeamPanel.test.tsx web/src/routes/Team.test.tsx`
Expected: FAIL (the routes module and the panel do not exist; the team page has no "Formed at").

- [ ] **Step 3: Implement**

`src/routes/keepTeam.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as K from '../events/keepTeam.js';
import * as V from '../events/validate.js';
import { answerKeepFlow, startKeepFlow } from '../events/keepFlow.js';

const NOT_FOUND = { error: 'not found' };

/** Keep this team on a finished draft event's page (drafts plan D3b), behind
 *  competitive_enabled as every event route is. Only the team's four see
 *  their keep; the DMs go out through keepFlow after each commit. */
export async function keepRoutes(app: FastifyInstance, opts: { db: DB; notifier?: Notifier; publicUrl?: string; now?: () => number }): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const now = () => new Date((opts.now ?? Date.now)());
  const refuse = (reply: FastifyReply, error: V.EventError) => reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, 'not_draft'); return null; }
    return ev;
  };
  const deps = { db, notifier: opts.notifier, publicUrl: opts.publicUrl };
  type Slug = { slug: string };

  app.get('/api/events/:slug/keep', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return { keep: K.myKeepView(db, ev.id, me, now()) };
  });

  app.post('/api/events/:slug/keep/start', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const entry = N.entriesOf(db, ev.id).find((e) => N.isActive(e) && e.captain_steamid === me);
    if (!entry) return refuse(reply, K.keepsOf(db, ev.id).some((k) => K.playersOf(k).includes(me)) ? 'not_captain' : 'keep_not_open');
    const b = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = startKeepFlow(deps, { entryId: entry.id, steamid: me, name: b.name, tag: b.tag, now: now() });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/events/:slug/keep/answer', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const accept = ((req.body ?? {}) as { accept?: unknown }).accept;
    if (typeof accept !== 'boolean') return refuse(reply, 'bad_request');
    const k = K.keepsOf(db, ev.id).find((x) => K.playersOf(x).includes(me));
    if (!k) return refuse(reply, 'keep_not_player');
    const r = answerKeepFlow(deps, { keepId: k.id, steamid: me, accept, now: now() });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });
}
```

`src/routes/teams.ts`: import `{ keptFrom } from '../events/keepTeam.js'`; `TeamView` gains
`/** Drafts plan D3b: the draft event a kept team was formed at, with its placement; null for any other team. */ origin: { eventSlug: string; eventName: string; placement: number | null } | null;`
and the `GET /api/teams/:slug` view sets `origin: keptFrom(db, t.id),` next to `captain`.

`src/server.ts`: import `{ keepRoutes } from './routes/keepTeam.js'` and register it next to `eventRoutes`:
`await app.register(keepRoutes, { db: deps.db, notifier, publicUrl: deps.config.publicUrl });`

`web/src/api.ts`: `TeamView` gains `origin?: { eventSlug: string; eventName: string; placement: number | null } | null;`, add

```ts
export type KeepStatus = 'offered' | 'voting' | 'made' | 'lapsed';
export interface MyKeepView {
  keepId: number; status: KeepStatus; captain: boolean; team: string; name: string | null; tag: string | null;
  defaults: { name: string; tag: string }; expiresAt: string; closed: boolean;
  players: { name: string; captain: boolean; answer: 'accept' | 'decline' | null }[];
  myAnswer: 'accept' | 'decline' | null; teamSlug: string | null;
}
```

and in `eventsApi`:

```ts
  /** Keep this team (drafts plan D3b). */
  keep: (slug: string, signal?: AbortSignal) => get<{ keep: MyKeepView | null }>(`/api/events/${enc(slug)}/keep`, signal),
  startKeep: (slug: string, body: { name: string; tag: string }) => post<{ keepId: number }>(`/api/events/${enc(slug)}/keep/start`, body),
  answerKeep: (slug: string, accept: boolean) => post<{ joined: boolean; teamSlug: string | null }>(`/api/events/${enc(slug)}/keep/answer`, { accept }),
```

`web/src/routes/event/KeepTeamPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { ApiError, eventsApi } from '../../api';
import { Panel } from '../../components/bits';
import { whenText } from '../../eventFormat';
import { useFetch } from '../../hooks/useFetch';

const ANSWER = { accept: 'Accepted', decline: 'Declined' } as const;

/** Keep this team on a finished draft event (plan D3b), for the team's four
 *  only: the captain's Keep form, everyone's answers, Accept and Decline, and
 *  the team page once it is made. */
export function KeepTeamPanel({ slug }: { slug: string }) {
  const { data, reload } = useFetch((s) => eventsApi.keep(slug, s), [slug]);
  const [name, setName] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
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
  const k = data?.keep ?? null;
  if (!k) return null;
  const voting = k.status === 'voting' || k.status === 'made';
  return (
    <Panel class="entrypanel keeppanel">
      <h3>Keep this team</h3>
      {k.status === 'offered' && !k.closed && (k.captain ? (
        <>
          <p>Keep {k.team} together as a real team. Your three are asked; it is made when 3 of the 4 of you accept.</p>
          <div class="inlinerow">
            <label>Team name <input value={name ?? k.defaults.name} maxLength={24} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>Tag <input value={tag ?? k.defaults.tag} maxLength={5} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
            <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.startKeep(slug, { name: (name ?? k.defaults.name).trim(), tag: (tag ?? k.defaults.tag).trim() }))}>Keep this team</button>
          </div>
        </>
      ) : <p class="muted">Your captain can keep {k.team} together as a real team until {whenText(k.expiresAt)}.</p>)}
      {voting && (
        <>
          <p>{k.name} [{k.tag}]: made when 3 of the 4 of you accept{k.closed ? '' : `, by ${whenText(k.expiresAt)}`}.</p>
          <ul class="admin-list">
            {k.players.map((p) => <li key={p.name}>{p.name}{p.captain ? ' (captain)' : ''} · {p.answer ? ANSWER[p.answer] : 'No answer yet'}</li>)}
          </ul>
          {!k.captain && k.myAnswer === null && !k.closed && (
            <div class="inlinerow">
              <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.answerKeep(slug, true))}>Accept</button>
              <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => eventsApi.answerKeep(slug, false))}>Decline</button>
            </div>
          )}
        </>
      )}
      {k.teamSlug && <p><a href={`/team/${k.teamSlug}`}>Open the team page</a></p>}
      {(k.status === 'lapsed' || (k.status === 'offered' && k.closed)) && <p class="muted">Keep this team has closed.</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
```

`web/src/routes/Event.tsx`: import `KeepTeamPanel` and mount it after the `StandinPanel` line:
`{mine && ev.entryKind === 'draft' && ev.status === 'finished' && <KeepTeamPanel slug={ev.slug} />}`

`web/src/routes/Team.tsx`: import `placementText` from `'../eventFormat'` and, inside `teamhead__line` right after the Founded/Disbanded text:

```tsx
            {team.origin && (
              <> · Formed at <a href={`/event/${team.origin.eventSlug}`}>{team.origin.eventName}</a>{team.origin.placement !== null ? ` (${placementText(team.origin.placement)})` : ''}</>
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/keepRoutes.test.ts tests/teamRoutes.test.ts && npx vitest run --project web web/src/routes/event/KeepTeamPanel.test.tsx web/src/routes/Team.test.tsx web/src/routes/Event.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean. Then the whole suite once: `npx vitest run` (only the 7 known `skeetStreakPoster` failures).

- [ ] **Step 5: Commit**

```bash
git add src/routes/keepTeam.ts src/routes/teams.ts src/server.ts web/src/api.ts web/src/routes/event/KeepTeamPanel.tsx web/src/routes/event/KeepTeamPanel.test.tsx web/src/routes/Event.tsx web/src/routes/Event.test.tsx web/src/routes/Team.tsx web/src/routes/Team.test.tsx tests/keepRoutes.test.ts
git commit -m "A finished draft event's page lets the captain keep the team with a name and tag and the others accept or decline, and a kept team's page says which event it was formed at and where it placed (plan D3b)"
```
