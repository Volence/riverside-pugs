# Compete nav and team chips on profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the four competitive nav items (Teams, Bookings, Scrims, Events) into one "Compete" item whose list pages share a tab strip, add a "Your team" link beside the player's name in the nav, and show a player's current teams as chips in their profile header.

**Architecture:**
- **Server, one helper per fact.** `teamChipsOf(db, steamid)` in `src/teams/teams.ts` (live teams, one per team, highest role) and `tournamentOpen(db, now)` in `src/events/events.ts` (a tournament is open or about to start). `/api/me` (`src/routes/auth.ts`) gains `competeHome` and `myTeams`; the profile (`src/playerQueries.ts` `profileData`) gains `teams`, gated exactly as the team pages the chips link to.
- **Web, the HUD section pattern.** `web/src/components/CompeteTabs.tsx` mirrors `HudTabs.tsx`: a `competeTabFor(path)` that maps every competitive URL (detail pages included) to its tab, and a `CompeteTabs` strip. `Nav.tsx` uses `competeTabFor` for the Compete item's highlight and `me.competeHome` for where it lands. The four list pages render the strip at their top.
- **Profile.** `TeamBadge` moves from `routes/Teams.tsx` to `components/TeamBadge.tsx` (re-exported from Teams.tsx so `Scrims.tsx`'s import keeps working untouched), a new `components/TeamChips.tsx` renders the chips, and `Headliner` gains a `badges` slot under the identity line.

**Tech Stack:** TypeScript, Fastify, better-sqlite3 (server); Preact, preact-iso (web); vitest with two projects, `server` (node) and `web` (happy-dom). No new dependencies.

**Spec:** Owner decisions 13 and 17 (2026-10-11), quoted here because they live in no spec file:

> 13. **Team on the profile.** The profile header shows the person's current team(s) as a chip: logo or tag, team name linking to /team/<slug>, and the role for captain / co-captain (plain members show just the team). One chip per team. Visible to anyone who can see the profile AND passes the competitive switch the same way the Teams nav item does (when competitive is admins-only, non-admins must not see team chips). Scrim history and reviews stay members+staff only as today.
>
> 17. **One "Compete" nav item.** Replace the four separate competitive nav items (Teams, Bookings, Scrims, Events) with one "Compete" item, gated exactly as the four are now. Its pages share a tab strip: Scrims · Bookings · Teams · Events, following the HUD section pattern. The Compete item is highlighted on every competitive page including detail pages (/team/<slug>, /team/join, /booking/<id>, /event/<id> and any others you find). Clicking Compete lands on Events while a tournament is open or about to start (define it from the events data: e.g. signups open or an event starting within N days; pick and justify, avoid an extra fetch on every page if a cheap existing signal exists), otherwise Scrims. Every existing URL keeps working (bookmarks and Discord links). Also add a "Your team" link in the signed-in name menu area of the nav for someone on a team (if there is no menu, put it where the player's own name link is; check mobile width).

Foundation: `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md` (teams, roles captain / cocaptain / member, the `competitive_enabled` switch).

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/compete-nav`, branch `compete-nav`. Never touch `/home/volence/l4d/pug` (other sessions use master). Never `git commit -a`; `git add` only the files the task names.
- Never use em dashes anywhere: code, comments, docs, UI copy, commit messages. Replace by meaning (a colon, a comma, "to", parentheses, or a new sentence).
- Match surrounding code: comment density, naming, idioms. Commit messages are plain sentences.
- Layout must work at phone width (390 px) without horizontal scroll.
- Another branch (scrim-board) edits `Scrims.tsx`'s post form, board rows and panels. The change to `web/src/routes/Scrims.tsx` and `web/src/routes/Bookings.tsx` is only the import line and the tab strip at the page top, so merging is easy. Do not move or reword anything else in those two files, and do not change Scrims.tsx's `import { TeamBadge } from './Teams'`.
- Every existing URL keeps working: no route in `web/src/AppRoutes.tsx` is added, removed or renamed.
- Do not ssh anywhere, touch production or deploy. Tests: `npx vitest run <path>` and `npm run typecheck`, from the worktree root.

## Rulings

Decided for this plan, awaiting owner review.

1. **What "a tournament is open or about to start" means.** A published event (never a draft, which is staff only) whose status is `registration`, `checkin` or `live`, or an `announced` event starting within **3 days** (`COMPETE_SOON_DAYS`). Registration open already covers the sign-up window however early it opens; 3 days catches an event announced for this weekend without making Events the landing page for a whole week of an event nobody can act on yet. Finished and cancelled events never count.
2. **No extra fetch for the landing choice.** `/api/me` carries `competeHome: 'events' | 'scrims' | null`. The site already re-reads `/api/me` on every websocket nudge (`web/src/hooks/useLiveState.ts` `refresh`), so the signal stays fresh at the cost of one `LIMIT 1` query on a small table, and no page fetches `/api/events` just to draw the nav. Null when the switch keeps the viewer out.
3. **Team chips use the team pages' own gate, not literally the nav's.** Chips show when `viewer ? competitiveAccess(db, viewer) : competitivePublic(db)`, the `allowedViewer` rule in `src/routes/teams.ts`. Under `admins` this is exactly the owner's rule (only admins see chips). The one difference from the nav: under `everyone` a signed-out visitor sees chips, as they can already open the team page the chip links to. A chip therefore never links to a 404, and never shows where the team page would not.
4. **The tab strip is on the four list pages only** (`/scrims`, `/bookings`, `/teams`, `/events`), and only in each page's open state (not the "not open yet" or "Sign in" message). Detail pages (`/team/:slug`, `/team/join/:token`, `/booking/:id`, `/event/:slug`, `/event/:slug/draft`, `/event/:slug/match/:id`) keep their own headers (team crest, event banner, room header) and are marked by the Compete nav highlight. Reasons: the draft and match rooms are working screens; the team and event heads already lead those pages; it keeps `Booking.tsx` (which scrim-board may also touch) out of this branch; and `Team.test.tsx:253` (`queryByText('Scrims')`) and `Event.test.tsx:169` show the detail pages use those words for their own sections. Adding the strip to a detail page later is one line.
5. **"Your team" with more than one team.** One team: "Your team", linking to `/team/<slug>`, with the team name as its tooltip. Two or more: "Your teams", linking to `/teams`, whose "Your teams" section lists them with roles. It sits in `.nav__me` between the name link and Sign out (there is no menu). Shown only while `me.teams` is true.
6. **Chip order and dedupe.** Oldest membership first (the order `myTeams` already returns). One chip per team; if a player ever holds two active rows on one team, the higher role wins (captain over co-captain over member).
7. **Chip placement.** Inside the profile's Headliner, under the identity line (flag, pronouns) and above the bio, through a new optional `badges` slot. The leaderboard's side card does not pass it, so it is unchanged.
8. **Tab labels and landmark.** Tabs read Scrims, Bookings, Teams, Events (owner's order), in a `<nav aria-label="Compete">`. No feedback link (the HUD strip's Discord line is specific to the HUD tools being new).
9. **The Compete item's slot.** Where the four were: after Matches, before Patch notes.

## Review Focus

1. **A competitive detail page reached straight from a Discord link** (`/team/join/<token>`, `/event/<slug>/match/<id>`, `/event/<slug>/draft`, `/booking/<id>`): Compete is highlighted and nothing else. Task 4 pins every path in `competeTabFor`; Task 5 pins the nav highlight on each.
2. **A non-admin viewing an admin's profile while the switch is at admins only**: no chip, and the response itself carries no team data (not just hidden in the page). Task 3 pins it at the API.
3. **A long Steam name plus "Your team" plus Sign out at 390 px**: the name area wraps instead of pushing the page sideways. Task 5 adds the wrap rule and Task 7 checks it in a browser.
4. **A player who left or whose team was disbanded**: no chip and no "Your team". Task 1 pins it in `teamChipsOf`, which both surfaces use.
5. **Past and draft events**: a finished, cancelled or still-draft event never makes Compete land on Events, and neither does an announced event 9 days out. Task 2 pins each.

---

### Task 1: teamChipsOf, a player's live teams one per team

**Files:**
- Modify: `src/teams/teams.ts` (after `myTeams`, around line 176)
- Test: `tests/teams.test.ts`

**Interfaces:**
- Consumes: `myTeams(db, steamid)` (same file).
- Produces: `export interface TeamChip { slug: string; name: string; tag: string; logoKey: string | null; role: TeamRole }` and `export function teamChipsOf(db: DB, steamid: string): TeamChip[]`, used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing test**

Add `teamChipsOf` to the existing import from `'../src/teams/teams.js'` at the top of `tests/teams.test.ts`, then append:

```ts
describe('teamChipsOf', () => {
  it('lists live teams oldest membership first, with the role on each', () => {
    const rats = make(P[0], 'Rats', 'RR');
    const owls = make(P[1], 'Owls', 'OWL', at(5));
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)").run(owls.id, P[0], at(10).toISOString());
    expect(teamChipsOf(db, P[0])).toEqual([
      { slug: rats.slug, name: 'Rats', tag: 'RR', logoKey: null, role: 'captain' },
      { slug: owls.slug, name: 'Owls', tag: 'OWL', logoKey: null, role: 'member' },
    ]);
  });

  it('leaves out a team they left and a team that was disbanded', () => {
    const rats = make(P[0], 'Rats', 'RR');
    const owls = make(P[1], 'Owls', 'OWL');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at, left_at) VALUES (?, ?, 'member', ?, ?)")
      .run(owls.id, P[0], at(1).toISOString(), at(2).toISOString());
    expect(teamChipsOf(db, P[0]).map((t) => t.slug)).toEqual([rats.slug]);
    db.prepare('UPDATE teams SET disbanded_at = ? WHERE id = ?').run(at(3).toISOString(), rats.id);
    expect(teamChipsOf(db, P[0])).toEqual([]);
  });

  it('shows a team once, under the higher role, if two active rows ever exist', () => {
    // The partial unique index stops this today; the chip must not double if
    // a row ever slips past it.
    const owls = make(P[1], 'Owls', 'OWL');
    db.exec('DROP INDEX team_members_active');
    const ins = db.prepare('INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, ?, ?)');
    ins.run(owls.id, P[0], 'member', at(1).toISOString());
    ins.run(owls.id, P[0], 'cocaptain', at(2).toISOString());
    expect(teamChipsOf(db, P[0])).toEqual([{ slug: owls.slug, name: 'Owls', tag: 'OWL', logoKey: null, role: 'cocaptain' }]);
  });

  it('is empty for someone on no team', () => {
    expect(teamChipsOf(db, P[5])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teams.test.ts -t teamChipsOf`
Expected: FAIL, `teamChipsOf is not a function` (or a TypeScript import error).

- [ ] **Step 3: Write minimal implementation**

In `src/teams/teams.ts`, directly after `myTeams`:

```ts
/** A team as a chip: the profile header and the nav's Your team link. */
export interface TeamChip { slug: string; name: string; tag: string; logoKey: string | null; role: TeamRole }
const ROLE_RANK: Record<TeamRole, number> = { captain: 0, cocaptain: 1, member: 2 };

/** A player's live teams, one per team, oldest membership first. Two active
 *  rows on one team should be impossible (team_members_active), but if one
 *  ever slips through the team still shows once, under the higher role. */
export function teamChipsOf(db: DB, steamid: string): TeamChip[] {
  const byTeam = new Map<number, TeamChip>();
  for (const t of myTeams(db, steamid)) {
    const seen = byTeam.get(t.id);
    if (seen && ROLE_RANK[seen.role] <= ROLE_RANK[t.role]) continue;
    byTeam.set(t.id, { slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, role: t.role });
  }
  return [...byTeam.values()];
}
```

(`Map.set` on an existing key keeps its original position, so the order stays oldest first.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teams.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/teams/teams.ts tests/teams.test.ts
git commit -m "Add teamChipsOf: a player's live teams, one per team under the higher role."
```

---

### Task 2: /api/me says where Compete lands and which teams the viewer is on

**Files:**
- Modify: `src/events/events.ts` (add after `createEvent`, around line 230)
- Modify: `src/routes/auth.ts:108-145` (the `GET /api/me` handler) and its imports
- Create: `tests/competeHome.test.ts`
- Test: `tests/teamRoutes.test.ts` (the `describe('the switch')` block)

**Interfaces:**
- Consumes: `teamChipsOf(db, steamid): TeamChip[]` (Task 1); `competitiveAccess` (`src/teams/access.ts`).
- Produces: `export const COMPETE_SOON_DAYS = 3` and `export function tournamentOpen(db: DB, now?: Date): boolean` in `src/events/events.ts`. `/api/me` gains `competeHome: 'events' | 'scrims' | null` and `myTeams: { slug: string; name: string }[]`. Task 5's web `Me` type mirrors these.

- [ ] **Step 1: Write the failing unit test**

Create `tests/competeHome.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { tournamentOpen } from '../src/events/events.js';
import { eventFixture, NOW } from './eventFixture.js';

// eventFixture's event starts 2026-10-10T20:00Z, nine days after NOW.
const DAYS_BEFORE_START = (d: number) => new Date(Date.parse('2026-10-10T20:00:00.000Z') - d * 86_400_000);

describe('tournamentOpen', () => {
  it('is false with no events at all', () => {
    expect(tournamentOpen(openDb(':memory:'), NOW)).toBe(false);
  });

  it('never counts a draft, which only staff can see', () => {
    const { db } = eventFixture('draft');
    expect(tournamentOpen(db, DAYS_BEFORE_START(1))).toBe(false);
  });

  it('counts an announced event only within three days of its start', () => {
    const { db } = eventFixture('announced');
    expect(tournamentOpen(db, NOW)).toBe(false);
    expect(tournamentOpen(db, DAYS_BEFORE_START(3.5))).toBe(false);
    expect(tournamentOpen(db, DAYS_BEFORE_START(2.9))).toBe(true);
  });

  it('counts registration, check-in and a live event however far the start is', () => {
    const { db, eventId } = eventFixture('registration');
    expect(tournamentOpen(db, NOW)).toBe(true);
    for (const status of ['checkin', 'live']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
      expect(tournamentOpen(db, NOW)).toBe(true);
    }
  });

  it('never counts a finished or cancelled event', () => {
    const { db, eventId } = eventFixture('registration');
    for (const status of ['finished', 'cancelled']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
      expect(tournamentOpen(db, DAYS_BEFORE_START(1))).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/competeHome.test.ts`
Expected: FAIL, `tournamentOpen is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/events/events.ts`, after `createEvent`:

```ts
/** How near an announced event's start must be before the nav's Compete item
 *  lands on Events rather than Scrims. Registration open needs no window. */
export const COMPETE_SOON_DAYS = 3;

/** Whether a tournament is open or about to start, for the nav's Compete item
 *  (/api/me competeHome): a published event taking sign-ups, checking in or
 *  being played, or one announced to start within COMPETE_SOON_DAYS. A draft
 *  never counts; only staff can see it. starts_at is ISO UTC, so the string
 *  comparison is a time comparison. */
export function tournamentOpen(db: DB, now?: Date): boolean {
  const soon = new Date((now ?? new Date()).getTime() + COMPETE_SOON_DAYS * 86_400_000).toISOString();
  return db.prepare(
    `SELECT 1 FROM events
      WHERE status IN ('registration', 'checkin', 'live') OR (status = 'announced' AND starts_at <= ?)
      LIMIT 1`,
  ).get(soon) !== undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/competeHome.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

In `tests/teamRoutes.test.ts`, add to the imports:

```ts
import * as E from '../src/events/events.js';
import { cupId, must } from './eventFixture.js';
```

and inside `describe('the switch', ...)`, after the existing `/api/me says whether to show teams` test:

```ts
  it('/api/me says where Compete lands: Scrims, or Events once a tournament is near', async () => {
    expect((await call('GET', '/api/me', P[0])).json().competeHome).toBe('scrims');
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const ev = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Open Cup', startsAt, entryKind: 'team' } }));
    must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: { type: 'single_elim', rulesetId: cupId(db) } }));
    must(E.publishEvent(db, { eventId: ev.id, by: ADMIN }));
    expect((await call('GET', '/api/me', P[0])).json().competeHome).toBe('events');
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/me', P[0])).json().competeHome).toBeNull();
    expect((await call('GET', '/api/me', ADMIN)).json().competeHome).toBe('events');
  });

  it('/api/me lists the teams the viewer is on, and none while the switch keeps them out', async () => {
    expect((await call('GET', '/api/me', P[0])).json().myTeams).toEqual([]);
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('GET', '/api/me', P[0])).json().myTeams).toEqual([{ slug, name: 'Rats' }]);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    const me = (await call('GET', '/api/me', P[0])).json();
    expect(me.teams).toBe(false);
    expect(me.myTeams).toEqual([]);
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/teamRoutes.test.ts -t "the switch"`
Expected: FAIL, `competeHome` and `myTeams` are `undefined`.

- [ ] **Step 7: Implement the route change**

In `src/routes/auth.ts`, add imports:

```ts
import { teamChipsOf } from '../teams/teams.js';
import { tournamentOpen } from '../events/events.js';
```

In the `GET /api/me` handler, just before `return {`:

```ts
    // The competitive switch, read per request: whether the nav shows Compete.
    const competitive = competitiveAccess(db, inGoodStanding(db, player.steamid) ? player.steamid : null);
```

and in the returned object replace the `teams:` line and its comment with:

```ts
      // Whether to show Compete in the nav: the competitive switch, read per request.
      teams: competitive,
      // Where Compete lands: Events while a tournament is open or about to
      // start, Scrims otherwise. Read with every /api/me, which the site
      // re-reads on each websocket nudge, so no page fetches events for it.
      competeHome: competitive ? (tournamentOpen(db) ? 'events' : 'scrims') : null,
      // The nav's Your team link: the teams they are on, one per team.
      myTeams: competitive ? teamChipsOf(db, player.steamid).map((t) => ({ slug: t.slug, name: t.name })) : [],
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/teamRoutes.test.ts tests/auth.test.ts tests/competeHome.test.ts tests/session.test.ts tests/cast.test.ts tests/twitchAuth.test.ts`
Expected: PASS. If an existing test compares the whole `/api/me` body with `toEqual`, add `competeHome: null, myTeams: []` (switch off by default) to its expected object.

- [ ] **Step 9: Commit**

```bash
git add src/events/events.ts src/routes/auth.ts tests/competeHome.test.ts tests/teamRoutes.test.ts
git commit -m "Have /api/me say where Compete lands and which teams the viewer is on."
```

---

### Task 3: The profile API carries the player's team chips, behind the switch

**Files:**
- Modify: `src/playerQueries.ts` (imports, and the object `profileData` returns, near `alsoKnownAs`)
- Test: `tests/teamRoutes.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `teamChipsOf` (Task 1); `competitiveAccess`, `competitivePublic` (`src/teams/access.ts`).
- Produces: `GET /api/players/:steamid` gains `teams: TeamChip[]` (`{ slug, name, tag, logoKey, role }`), always present, empty when the viewer may not see teams. Task 6 consumes it as `Profile['teams']`.

- [ ] **Step 1: Write the failing test**

Append to `tests/teamRoutes.test.ts`:

```ts
describe('team chips on a profile', () => {
  const chips = async (of: string, as?: string) => (await call('GET', `/api/players/${of}`, as)).json().teams;

  it('lists the player\'s teams with their role, to anyone the team pages are open to', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const want = [{ slug, name: 'Rats', tag: 'RR', logoKey: null, role: 'captain' }];
    expect(await chips(P[0], P[1])).toEqual(want);
    // Under everyone the team page is public, so a signed-out visitor sees the chip it links to.
    expect(await chips(P[0])).toEqual(want);
  });

  it('shows no chip, and sends no team, to anyone the switch keeps out', async () => {
    await create(P[0], 'Rats', 'RR');
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect(await chips(P[0], P[1])).toEqual([]);
    expect(await chips(P[0])).toEqual([]);
    expect(await chips(P[0], ADMIN)).toHaveLength(1);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect(await chips(P[0], ADMIN)).toEqual([]);
  });

  it('is empty for a player on no team', async () => {
    expect(await chips(P[2], P[1])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamRoutes.test.ts -t "team chips"`
Expected: FAIL, `teams` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/playerQueries.ts`, add imports:

```ts
import { competitiveAccess, competitivePublic } from './teams/access.js';
import { teamChipsOf } from './teams/teams.js';
```

In the object `profileData` returns, after the `alsoKnownAs:` line:

```ts
    // The teams they are on, as header chips. Gated exactly as the team pages
    // the chips link to (src/routes/teams.ts allowedViewer): while the switch
    // is at admins only nobody else gets a team here, and a chip never links
    // to a page that would answer 404.
    teams: (viewer ? competitiveAccess(db, viewer) : competitivePublic(db)) ? teamChipsOf(db, steamid) : [],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/teamRoutes.test.ts tests/profileApi.test.ts tests/stats.test.ts tests/endorseApi.test.ts tests/weeklyRoutes.test.ts tests/adminSteamAccount.test.ts`
Expected: PASS. If one of these compares a whole profile body with `toEqual`, add `teams: []` to its expected object.

- [ ] **Step 5: Commit**

```bash
git add src/playerQueries.ts tests/teamRoutes.test.ts
git commit -m "Send a player's team chips with their profile, gated like the team pages."
```

---

### Task 4: CompeteTabs, the competitive section's tab strip

**Files:**
- Create: `web/src/components/CompeteTabs.tsx`
- Create: `web/src/components/CompeteTabs.test.tsx`
- Modify: `web/src/styles/app.css` (beside the `.hudtabs + .page-head` rule, around line 1561)

**Interfaces:**
- Produces: `export type CompeteTab = 'scrims' | 'bookings' | 'teams' | 'events'`, `export function competeTabFor(path: string): CompeteTab | null`, `export function CompeteTabs({ active }: { active: CompeteTab })`. Task 5 uses `competeTabFor`; Task 7 uses `CompeteTabs`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/CompeteTabs.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { CompeteTabs, competeTabFor } from './CompeteTabs';

afterEach(cleanup);

describe('CompeteTabs', () => {
  it('links each list page at its own route, in the owner\'s order', () => {
    render(<CompeteTabs active="scrims" />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Scrims', '/scrims'],
      ['Bookings', '/bookings'],
      ['Teams', '/teams'],
      ['Events', '/events'],
    ]);
  });

  it('marks only the active tab as the current page', () => {
    render(<CompeteTabs active="teams" />);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Teams']);
    expect(current[0].classList.contains('is-active')).toBe(true);
  });

  it('is a named navigation landmark, not a tablist of buttons', () => {
    render(<CompeteTabs active="events" />);
    expect(screen.getByRole('navigation', { name: 'Compete' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('competeTabFor', () => {
  it.each([
    ['/scrims', 'scrims'],
    ['/bookings', 'bookings'],
    ['/booking/7', 'bookings'],
    ['/teams', 'teams'],
    ['/team/rats', 'teams'],
    ['/team/join/abc123', 'teams'],
    ['/events', 'events'],
    ['/event/riverside-cup', 'events'],
    ['/event/riverside-cup/draft', 'events'],
    ['/event/riverside-cup/match/12', 'events'],
  ])('maps %s to %s', (path, tab) => {
    expect(competeTabFor(path)).toBe(tab);
  });

  it.each(['/', '/matches', '/teamspeak', '/eventsx', '/scrimsx', '/admin/events', '/player/1'])('knows nothing of %s', (path) => {
    expect(competeTabFor(path)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/components/CompeteTabs.test.tsx`
Expected: FAIL, cannot resolve `./CompeteTabs`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/CompeteTabs.tsx`:

```tsx
/** The competitive section's list pages, in tab order. The nav shows the
 *  section as one Compete item; this strip, at the top of each list page,
 *  moves between them. Each tab is a real link to its route, so deep links,
 *  Discord links and the back button all keep working. */
export type CompeteTab = 'scrims' | 'bookings' | 'teams' | 'events';

/** [tab, list page, label, prefix of its detail pages]. */
const TABS: readonly (readonly [CompeteTab, string, string, string])[] = [
  ['scrims', '/scrims', 'Scrims', '/scrim/'],
  ['bookings', '/bookings', 'Bookings', '/booking/'],
  ['teams', '/teams', 'Teams', '/team/'],
  ['events', '/events', 'Events', '/event/'],
];

/** Which tab a path belongs to, or null outside the section. Detail pages
 *  count as their list's tab: /team/rats and /team/join/:token are Teams,
 *  /booking/7 is Bookings, and an event's page, draft room and match rooms
 *  are Events. */
export function competeTabFor(path: string): CompeteTab | null {
  for (const [key, href, , detail] of TABS) {
    if (path === href || path.startsWith(detail)) return key;
  }
  return null;
}

export function CompeteTabs({ active }: { active: CompeteTab }) {
  return (
    <nav class="tabs competetabs" aria-label="Compete">
      {TABS.map(([key, href, label]) => (
        <a
          key={key}
          href={href}
          class={`tabs__tab${key === active ? ' is-active' : ''}`}
          aria-current={key === active ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
```

(`/scrim/` has no route today; listing it means a scrim detail page added later is already part of the section.)

In `web/src/styles/app.css`, directly after the line `.hudtabs + .page-head, .hudtabs + .sr-only + .page-head { margin-top: var(--sp-5); }`:

```css
/* The Compete strip (Scrims, Bookings, Teams, Events) heads the four list
 * pages, with the same air under it as the HUD strip. Four short labels fit at
 * 390 px; .tabs scrolls the strip, never the page, if a font runs wide. */
.competetabs + .page-head { margin-top: var(--sp-5); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/components/CompeteTabs.test.tsx web/src/styles/app.css.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/CompeteTabs.tsx web/src/components/CompeteTabs.test.tsx web/src/styles/app.css
git commit -m "Add the Compete tab strip and the map from competitive paths to its tabs."
```

---

### Task 5: One Compete nav item and a Your team link

**Files:**
- Modify: `web/src/api.ts:15-37` (`interface Me`)
- Modify: `web/src/components/Nav.tsx`
- Modify: `web/src/components/Nav.test.tsx`
- Modify: `web/src/styles/app.css` (the `.nav__me` rules near line 109 and the `@media (max-width: 640px)` block near line 1050)

**Interfaces:**
- Consumes: `competeTabFor(path)` (Task 4); `/api/me` `competeHome` and `myTeams` (Task 2).
- Produces: `Me.competeHome?: 'events' | 'scrims' | null` and `Me.myTeams?: { slug: string; name: string }[]`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/Nav.test.tsx`, delete the two tests `offers Teams, Bookings, Scrims and Events only to a viewer the competitive switch lets in` and `keeps Events current on an event page`, and add in their place (inside `describe('Nav', ...)`):

```tsx
  it('offers one Compete item, only to a viewer the competitive switch lets in', () => {
    const inCompetitive = { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams: true };
    const { unmount } = render(
      <LocationProvider><Nav session={{ kind: 'active', me: inCompetitive }} state={null} /></LocationProvider>,
    );
    expect(screen.getByRole('link', { name: 'Compete' })).toBeTruthy();
    for (const gone of ['Teams', 'Bookings', 'Scrims', 'Events']) expect(screen.queryByRole('link', { name: gone })).toBeNull();
    // Where the four were: right after Matches.
    const labels = screen.getAllByRole('link').map((a) => a.textContent);
    expect(labels[labels.indexOf('Matches') + 1]).toBe('Compete');
    unmount();
    const outside = { steamid: '2', name: 'bob', avatar: null, status: 'active', isAdmin: false };
    render(<LocationProvider><Nav session={{ kind: 'active', me: outside }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('link', { name: 'Compete' })).toBeNull();
  });

  it('lands Compete on Events while a tournament is near, and on Scrims otherwise', () => {
    const me = (competeHome?: 'events' | 'scrims') =>
      ({ steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams: true, competeHome });
    const { unmount } = render(<LocationProvider><Nav session={{ kind: 'active', me: me('events') }} state={null} /></LocationProvider>);
    expect(screen.getByRole('link', { name: 'Compete' }).getAttribute('href')).toBe('/events');
    unmount();
    const second = render(<LocationProvider><Nav session={{ kind: 'active', me: me('scrims') }} state={null} /></LocationProvider>);
    expect(screen.getByRole('link', { name: 'Compete' }).getAttribute('href')).toBe('/scrims');
    second.unmount();
    // A server from before the field: Scrims.
    render(<LocationProvider><Nav session={{ kind: 'active', me: me() }} state={null} /></LocationProvider>);
    expect(screen.getByRole('link', { name: 'Compete' }).getAttribute('href')).toBe('/scrims');
  });

  it('links Your team for one team, Your teams for several, and nothing for none', () => {
    const me = (myTeams: { slug: string; name: string }[], teams = true) =>
      ({ steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams, myTeams });
    const { unmount } = render(
      <LocationProvider><Nav session={{ kind: 'active', me: me([{ slug: 'rats', name: 'Rats' }]) }} state={null} /></LocationProvider>,
    );
    const one = screen.getByRole('link', { name: 'Your team' });
    expect(one.getAttribute('href')).toBe('/team/rats');
    expect(one.getAttribute('title')).toBe('Rats');
    unmount();
    const two = render(<LocationProvider><Nav session={{ kind: 'active', me: me([{ slug: 'rats', name: 'Rats' }, { slug: 'owls', name: 'Owls' }]) }} state={null} /></LocationProvider>);
    expect(screen.getByRole('link', { name: 'Your teams' }).getAttribute('href')).toBe('/teams');
    two.unmount();
    const none = render(<LocationProvider><Nav session={{ kind: 'active', me: me([]) }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('link', { name: /Your team/ })).toBeNull();
    none.unmount();
    // The switch closed: no link, whatever the list says.
    render(<LocationProvider><Nav session={{ kind: 'active', me: me([{ slug: 'rats', name: 'Rats' }], false) }} state={null} /></LocationProvider>);
    expect(screen.queryByRole('link', { name: /Your team/ })).toBeNull();
  });
```

and append a new block at the end of the file:

```tsx
describe('Nav current page in the competitive section', () => {
  const at = (path: string) => {
    history.replaceState(null, '', path);
    const me = { steamid: '1', name: 'alice', avatar: null, status: 'active', isAdmin: false, teams: true, competeHome: 'events' as const };
    render(<LocationProvider><Nav session={{ kind: 'active', me }} state={null} /></LocationProvider>);
    return screen.getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => a.textContent);
  };
  afterEach(() => history.replaceState(null, '', '/'));

  it.each([
    '/scrims', '/bookings', '/booking/7', '/teams', '/team/rats', '/team/join/abc123',
    '/events', '/event/riverside-cup', '/event/riverside-cup/draft', '/event/riverside-cup/match/12',
  ])('marks Compete current on %s', (path) => {
    expect(at(path)).toEqual(['Compete']);
  });

  it('leaves Compete alone elsewhere', () => {
    expect(at('/matches')).toEqual(['Matches']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/components/Nav.test.tsx`
Expected: FAIL: no `Compete` link, no `Your team` link.

- [ ] **Step 3: Write the implementation**

In `web/src/api.ts`, `interface Me`, replace the `teams` member and its comment with:

```ts
  /** Show Compete: the competitive switch lets this viewer in. */
  teams?: boolean;
  /** Where Compete lands: Events while a tournament is open or about to
   *  start, Scrims otherwise. Null or absent reads as Scrims. */
  competeHome?: 'events' | 'scrims' | null;
  /** The teams this viewer is on, for the nav's Your team link. Empty while
   *  the switch keeps them out. */
  myTeams?: { slug: string; name: string }[];
```

In `web/src/components/Nav.tsx`:

1. Add the import: `import { competeTabFor } from './CompeteTabs';`
2. In the `NAV_LINKS` doc comment, after the HUD paragraph, add:

```ts
 *
 *  Compete is a section the same way: Scrims, Bookings, Teams and Events
 *  share one item (only for viewers the competitive switch lets in, so it is
 *  added in Nav rather than listed here) and a tab strip on each list page.
```

3. Replace `isCurrent` with:

```ts
/** Whether a nav item is the page being shown. The HUD item stands for its
 *  whole section, so it is current on the crosshair and community pages too,
 *  and Patch notes for the balance pages under it (Game values). Compete is
 *  the only item that points at /events or /scrims (it lands on one or the
 *  other) and stands for every competitive page, detail pages included. */
function isCurrent(href: string, path: string): boolean {
  if (href === '/hud') return hudTabFor(path) !== null;
  if (href === '/balance') return path === href || path.startsWith('/balance/');
  if (href === '/events' || href === '/scrims') return competeTabFor(path) !== null;
  return path === href;
}
```

4. Replace the `links` block (the comment line starting `// Teams, Bookings, Scrims and Events only` and the `const links = ...;` expression) with:

```ts
  // Compete only for viewers the competitive switch lets in (/api/me teams).
  // It lands on Events while a tournament is open or about to start.
  const links = me?.teams
    ? [...NAV_LINKS.slice(0, 5), [me.competeHome === 'events' ? '/events' : '/scrims', 'Compete'] as const, ...NAV_LINKS.slice(5)]
    : NAV_LINKS;
  const myTeams = me?.teams ? me.myTeams ?? [] : [];
```

5. In the `.nav__me` block, between the name link and the Sign out button:

```tsx
          {/* One team: straight to it. Several: the Teams page, whose Your
              teams section lists them with roles. */}
          {myTeams.length > 0 && (
            <a class="nav__team" href={myTeams.length === 1 ? `/team/${myTeams[0].slug}` : '/teams'}
               title={myTeams.length === 1 ? myTeams[0].name : undefined}>
              {myTeams.length === 1 ? 'Your team' : 'Your teams'}
            </a>
          )}
```

In `web/src/styles/app.css`, after `.nav__me img { ... }` (line 111):

```css
.nav__me .nav__team { color: var(--text-muted); }
.nav__me .nav__team:hover { color: var(--text); }
```

and inside the existing `@media (max-width: 640px)` block that styles `.nav`, after the `.nav__links` line:

```css
  /* A long Steam name, Your team and Sign out wrap rather than push the page sideways. */
  .nav__me { flex-wrap: wrap; min-width: 0; }
  .nav__me a { overflow-wrap: anywhere; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/components/Nav.test.tsx web/src/styles/app.css.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/Nav.tsx web/src/components/Nav.test.tsx web/src/styles/app.css
git commit -m "Replace the four competitive nav items with one Compete item and add a Your team link."
```

---

### Task 6: Team chips in the profile header

**Files:**
- Create: `web/src/components/TeamBadge.tsx`
- Modify: `web/src/routes/Teams.tsx:13-17` (move `TeamBadge` out, re-export it)
- Create: `web/src/components/TeamChips.tsx`
- Create: `web/src/components/TeamChips.test.tsx`
- Modify: `web/src/components/Headliner.tsx` (new `badges` slot)
- Modify: `web/src/components/Headliner.test.tsx`
- Modify: `web/src/api.ts` (`interface Profile`, around line 648)
- Modify: `web/src/routes/Profile.tsx` (pass the chips to Headliner)
- Create: `web/src/routes/Profile.teams.test.tsx`
- Modify: `web/src/styles/app.css` (after the `.teambadge--tag` rule, around line 3232)

**Interfaces:**
- Consumes: `GET /api/players/:steamid` `teams` (Task 3).
- Produces: `export interface ProfileTeam { slug: string; name: string; tag: string; logoKey: string | null; role: 'captain' | 'cocaptain' | 'member' }` and `Profile.teams?: ProfileTeam[]` in `web/src/api.ts`; `TeamBadge` from `components/TeamBadge.tsx` (same props as today); `TeamChips({ teams })`; `Headliner`'s optional `badges?: ComponentChildren`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/TeamChips.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { TeamChips } from './TeamChips';

afterEach(cleanup);

describe('TeamChips', () => {
  it('links each team to its page, with the logo or the tag, and names captains and co-captains only', () => {
    const { container } = render(<TeamChips teams={[
      { slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: 'a'.repeat(64), role: 'captain' },
      { slug: 'owls', name: 'Night Owls', tag: 'OWL', logoKey: null, role: 'cocaptain' },
      { slug: 'cats', name: 'Alley Cats', tag: 'CAT', logoKey: null, role: 'member' },
    ]} />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/team/rats', '/team/owls', '/team/cats']);
    expect(links[0].textContent).toBe('Riverside RatsCaptain');
    expect(links[1].textContent).toBe('OWLNight OwlsCo-captain');
    expect(links[2].textContent).toBe('CATAlley Cats');
    expect(container.querySelector('img.teambadge')?.getAttribute('src')).toBe(`/api/teams/logos/${'a'.repeat(64)}.png`);
  });

  it('renders nothing for a player on no team', () => {
    const { container } = render(<TeamChips teams={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
```

In `web/src/components/Headliner.test.tsx`, add inside `describe('Headliner', ...)`:

```tsx
  it('shows the badges slot under the name, and nothing without it', () => {
    const { container, rerender } = render(
      <Headliner eyebrow="Rating" name="v" rating={1000} stats={[]} badges={<span class="probe">team</span>} />,
    );
    expect(container.querySelector('.headliner__badges .probe')?.textContent).toBe('team');
    rerender(<Headliner eyebrow="Rating" name="v" rating={1000} stats={[]} />);
    expect(container.querySelector('.headliner__badges')).toBeNull();
  });
```

Create `web/src/routes/Profile.teams.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';

const { mockApi, mockCommunity } = vi.hoisted(() => ({
  mockApi: { profile: vi.fn(), endorseState: vi.fn() },
  mockCommunity: { list: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { Profile } = await import('./Profile');

const profile = (teams?: unknown[]) => ({
  player: {
    steamid: '1', name: 'alice', avatar: null, createdAt: '2026-01-01T00:00:00',
    bio: null, pronouns: null, country: null, twitchName: null,
  },
  social: [],
  rating: { sr: 1200, mu: 25, sigma: 8, wins: 3, losses: 1 },
  totals: { games: 4, siDamage: 10, siKills: 1, commonKills: 2, ffDealt: 3, revives: 4 },
  matches: [],
  history: [],
  ...(teams ? { teams } : {}),
});

beforeEach(() => {
  for (const fn of [...Object.values(mockApi), ...Object.values(mockCommunity)]) fn.mockReset();
  mockApi.endorseState.mockResolvedValue(null);
  mockCommunity.list.mockResolvedValue({ entries: [], page: 0, pageSize: 24, total: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('team chips on a profile', () => {
  it('shows a chip per team in the header, linking to the team page', async () => {
    mockApi.profile.mockResolvedValue(profile([{ slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, role: 'captain' }]));
    render(<Profile steamid="1" />);
    const chip = (await screen.findByText('Riverside Rats')).closest('a') as HTMLAnchorElement;
    expect(chip.getAttribute('href')).toBe('/team/rats');
    expect(chip.closest('.headliner')).toBeTruthy();
    expect(chip.textContent).toContain('Captain');
  });

  it('shows no chips when the server sends none, or a server from before the field', async () => {
    mockApi.profile.mockResolvedValue(profile([]));
    const { container, unmount } = render(<Profile steamid="1" />);
    await screen.findByText('alice');
    expect(container.querySelector('.teamchips')).toBeNull();
    unmount();
    mockApi.profile.mockResolvedValue(profile());
    const second = render(<Profile steamid="1" />);
    await screen.findByText('alice');
    expect(second.container.querySelector('.teamchips')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/components/TeamChips.test.tsx web/src/components/Headliner.test.tsx web/src/routes/Profile.teams.test.tsx`
Expected: FAIL: `./TeamChips` does not resolve, no `.headliner__badges`, no chip on the profile.

- [ ] **Step 3: Move TeamBadge**

Create `web/src/components/TeamBadge.tsx`:

```tsx
import { logoUrl } from '../api';

/** A team's logo, or its tag in a box when it has none. */
export function TeamBadge({ tag, logoKey, size = 40 }: { tag: string; logoKey: string | null; size?: number }) {
  return logoKey
    ? <img class="teambadge" src={logoUrl(logoKey)} alt="" width={size} height={size} />
    : <span class="teambadge teambadge--tag" aria-hidden="true">{tag}</span>;
}
```

In `web/src/routes/Teams.tsx`, delete the `export function TeamBadge(...) { ... }` block (lines 13-17) and add, after the imports:

```tsx
import { TeamBadge } from '../components/TeamBadge';
// Scrims.tsx imports TeamBadge from here; kept so that file need not change.
export { TeamBadge };
```

Remove `logoUrl` from Teams.tsx's `../api` import only if nothing else in the file uses it (check with `grep -n logoUrl web/src/routes/Teams.tsx`).

- [ ] **Step 4: Add TeamChips, the Headliner slot, the type and the wiring**

Create `web/src/components/TeamChips.tsx`:

```tsx
import type { ProfileTeam } from '../api';
import { TeamBadge } from './TeamBadge';

/** Captains and co-captains are named on their chip; a plain member shows just the team. */
const ROLE_SHOWN = { captain: 'Captain', cocaptain: 'Co-captain' } as const;

/** The teams a player is on, one chip each, linking to the team page. The
 *  server sends none to a viewer the competitive switch keeps out. */
export function TeamChips({ teams }: { teams: readonly ProfileTeam[] }) {
  if (teams.length === 0) return null;
  return (
    <ul class="teamchips" aria-label="Teams">
      {teams.map((t) => (
        <li key={t.slug}>
          <a class="teamchips__chip" href={`/team/${t.slug}`}>
            <TeamBadge tag={t.tag} logoKey={t.logoKey} size={28} />
            <span class="teamchips__name">{t.name}</span>
            {t.role !== 'member' && <span class="teamchips__role">{ROLE_SHOWN[t.role]}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}
```

In `web/src/api.ts`, just above `export interface Profile {`:

```ts
/** A team the player is on, as a chip in their profile header (src/teams/teams.ts TeamChip). */
export interface ProfileTeam { slug: string; name: string; tag: string; logoKey: string | null; role: 'captain' | 'cocaptain' | 'member' }
```

and inside `interface Profile`, after `alsoKnownAs?`:

```ts
  /** The teams they are on, one per team. Empty for a viewer the competitive
   *  switch keeps out. Optional only for a server older than the feature. */
  teams?: ProfileTeam[];
```

In `web/src/components/Headliner.tsx`:
- add `import type { ComponentChildren } from 'preact';`
- add `badges` to the destructured props, and to the props type after `aka`:

```ts
    /** Under the identity line: the profile passes the player's team chips.
     *  The leaderboard's side card has none. */
    badges?: ComponentChildren;
```

- render it right after the `{hasIdentity && (...)}` block and before `{bio && ...}`:

```tsx
      {badges && <div class="headliner__badges">{badges}</div>}
```

In `web/src/routes/Profile.tsx`, import `import { TeamChips } from '../components/TeamChips';` and pass to the `<Headliner ... />` (after `aka={data.alsoKnownAs}`):

```tsx
          badges={data.teams && data.teams.length > 0 ? <TeamChips teams={data.teams} /> : undefined}
```

In `web/src/styles/app.css`, after the `.teambadge--tag { ... }` rule:

```css
/* A player's teams in their profile header (components/TeamChips.tsx). The
 * name truncates and the row wraps, so a 24 character team name fits 390 px. */
.headliner__badges { margin-top: var(--sp-2); }
.teamchips { list-style: none; display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; }
.teamchips > li { min-width: 0; max-width: 100%; }
.teamchips__chip {
  display: inline-flex; align-items: center; gap: var(--sp-2); max-width: 100%;
  padding: 2px var(--sp-2) 2px 2px; border: 1px solid var(--border); color: var(--text); font-size: var(--fs-dense);
}
a.teamchips__chip:hover { border-color: var(--border-strong); text-decoration: none; }
.teamchips__chip .teambadge { width: 28px; height: 28px; }
.teamchips__chip .teambadge--tag { font-size: 0.625rem; letter-spacing: 0; }
.teamchips__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-bright); }
.teamchips__role { font-family: var(--font-label); font-size: var(--fs-label); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); white-space: nowrap; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run web/src/components/TeamChips.test.tsx web/src/components/Headliner.test.tsx web/src/routes/Profile.teams.test.tsx web/src/routes/Profile.community.test.tsx web/src/routes/Teams.test.tsx web/src/routes/Scrims.test.tsx web/src/routes/Leaderboard.test.tsx web/src/styles/app.css.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TeamBadge.tsx web/src/routes/Teams.tsx web/src/components/TeamChips.tsx web/src/components/TeamChips.test.tsx web/src/components/Headliner.tsx web/src/components/Headliner.test.tsx web/src/api.ts web/src/routes/Profile.tsx web/src/routes/Profile.teams.test.tsx web/src/styles/app.css
git commit -m "Show a player's teams as chips in their profile header."
```

---

### Task 7: The tab strip on the four list pages, and the phone check

**Files:**
- Modify: `web/src/routes/Scrims.tsx` (import line, and one line at the top of the main return near line 486)
- Modify: `web/src/routes/Bookings.tsx` (import line, and one line at the top of the main return near line 177)
- Modify: `web/src/routes/Teams.tsx` (import line, and one line at the top of the main return near line 92)
- Modify: `web/src/routes/Events.tsx` (import line, and the `head` constant near line 45)
- Test: `web/src/routes/Scrims.test.tsx`, `Bookings.test.tsx`, `Teams.test.tsx`, `Events.test.tsx`

**Interfaces:**
- Consumes: `CompeteTabs({ active })` (Task 4).

- [ ] **Step 1: Write the failing tests**

Append one test to each file's top-level `describe`, using that file's existing fixtures. `Scrims.test.tsx`, inside `describe` (it already has `renderScrims` and a `beforeEach` that resolves the board):

```tsx
  it('heads the board with the Compete tabs, Scrims current', async () => {
    renderScrims();
    const strip = await screen.findByRole('navigation', { name: 'Compete' });
    const current = [...strip.querySelectorAll('a')].filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Scrims']);
  });
```

`Bookings.test.tsx`:

```tsx
  it('heads the page with the Compete tabs, Bookings current', async () => {
    render(<Bookings session={session} />);
    const strip = await screen.findByRole('navigation', { name: 'Compete' });
    const current = [...strip.querySelectorAll('a')].filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Bookings']);
  });
```

`Teams.test.tsx` (copy the mocks the first test in that file sets up for `list` and `mine` before rendering; the strip must not depend on them, so resolving both with the same values as `lists every team...` is enough):

```tsx
  it('heads the page with the Compete tabs, Teams current, and none while closed', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: true });
    const { unmount } = render(<Teams session={signedIn} />);
    const strip = await screen.findByRole('navigation', { name: 'Compete' });
    const current = [...strip.querySelectorAll('a')].filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Teams']);
    unmount();
    mockTeams.list.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Teams session={signedIn} />);
    await screen.findByText('Teams are not open yet.');
    expect(screen.queryByRole('navigation', { name: 'Compete' })).toBeNull();
  });
```

(If `mockTeams` uses different method names or `ApiError`'s constructor takes other arguments, match the existing `shows nothing but a not-found line when the switch is closed` test in that file.)

`Events.test.tsx`:

```tsx
  it('heads the page with the Compete tabs, Events current, and none while closed', async () => {
    mockEvents.list.mockResolvedValue({ events: [] });
    const { unmount } = render(<Events session={session} />);
    const strip = await screen.findByRole('navigation', { name: 'Compete' });
    const current = [...strip.querySelectorAll('a')].filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Events']);
    unmount();
    mockEvents.list.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Events session={session} />);
    await screen.findByText('Events are not open yet.');
    expect(screen.queryByRole('navigation', { name: 'Compete' })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/routes/Scrims.test.tsx web/src/routes/Bookings.test.tsx web/src/routes/Teams.test.tsx web/src/routes/Events.test.tsx`
Expected: the four new tests FAIL (no `Compete` navigation); every other test passes.

- [ ] **Step 3: Add the strip**

Each page gets `import { CompeteTabs } from '../components/CompeteTabs';` with its other component imports, and one line directly above its `PageHeader` in the open state:

`web/src/routes/Scrims.tsx`, main return:

```tsx
    <main class="page page--profile bookingpage">
      <CompeteTabs active="scrims" />
      <PageHeader eyebrow="Competitive" title="Scrims" />
```

`web/src/routes/Bookings.tsx`, main return:

```tsx
    <main class="page page--profile bookingpage">
      <CompeteTabs active="bookings" />
      <PageHeader eyebrow="Competitive" title="Bookings" />
```

`web/src/routes/Teams.tsx`, main return:

```tsx
    <main class="page page--profile teampage">
      <CompeteTabs active="teams" />
      <PageHeader eyebrow="Competitive" title="Teams" aside={...unchanged...} />
```

`web/src/routes/Events.tsx`: the closed state keeps a bare header; loading, failed and the list get the strip:

```tsx
  const header = <PageHeader eyebrow="Competitive" title="Events" />;
  if (closed) return <main class="page page--list">{header}<Empty>Events are not open yet.</Empty></main>;
  const head = <><CompeteTabs active="events" />{header}</>;
```

(The existing `failed`, loading and main returns already use `{head}` and stay as they are.)

Leave the "not open yet" and "Sign in" early returns in Scrims, Bookings and Teams untouched (Ruling 4).

- [ ] **Step 4: Run the web suite and typecheck**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS. If a test elsewhere now finds two elements for `getByText('Teams')` or similar, scope that query to its section (`within(...)`) rather than renaming a tab.

- [ ] **Step 5: Run the server suite**

Run: `npx vitest run --project server`
Expected: PASS.

- [ ] **Step 6: Check there are no em or en dashes in this branch's changes**

Run: `git diff master -- src web/src tests docs | grep -nP '^\+.*[\x{2013}\x{2014}]'`
Expected: prints nothing. (The plan file itself uses the middle dot only in the owner's quoted "Scrims · Bookings · Teams · Events".)

- [ ] **Step 7: Check the layout at 390 px**

Run the site against a scratch database (never the default `data/pug.db`, and pick ports other sessions are not using):

```bash
SCRATCH=/tmp/claude-1000/compete-nav && mkdir -p $SCRATCH
DB_PATH=$SCRATCH/pug.db PORT=3101 LOG_LISTEN_PORT=27591 npm run dev:api &
API_PORT=3101 npx vite --port 5181 &
```

(`vite.config.ts` proxies `/api`, `/auth` and `/ws` to `API_PORT`, default 8080, so a second checkout runs beside another session's.) Once the API has created the database, `sqlite3 $SCRATCH/pug.db "UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'"`. Open `http://localhost:5181`, sign in through the dev panel (`POST /api/dev/login` with a 17 digit steamid), start a team on `/teams`, then in the browser's device toolbar at 390 px wide check: the nav (Compete present, Your team beside the name, the row wraps with no sideways scroll), `/scrims`, `/bookings`, `/teams`, `/events` (strip on top, no sideways scroll), and your own profile (team chip under the name, Captain on it). Rename your Steam name in the database to 32 characters to try the long case: `sqlite3 $SCRATCH/pug.db "UPDATE players SET name = 'abcdefghijklmnopqrstuvwxyz012345'"`. Stop both servers afterwards (`kill %1 %2`), killing only those two job ids.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/Scrims.tsx web/src/routes/Bookings.tsx web/src/routes/Teams.tsx web/src/routes/Events.tsx web/src/routes/Scrims.test.tsx web/src/routes/Bookings.test.tsx web/src/routes/Teams.test.tsx web/src/routes/Events.test.tsx
git commit -m "Head the four competitive list pages with the Compete tab strip."
```

---

## Self-review notes

- Spec coverage. Decision 13: chip with logo or tag, name linking to the team page, role for captain and co-captain only (Task 6); one per team, deduped (Task 1); gated by the switch (Task 3, Ruling 3); scrim history and reviews untouched (no task changes `src/routes/teams.ts` or the Team page). Decision 17: one Compete item gated as before (Task 5); tab strip in the owner's order (Tasks 4 and 7); highlight on every competitive page including `/team/join/:token`, `/event/:slug/draft` and `/event/:slug/match/:id`, which the decision did not list (Tasks 4 and 5); landing rule (Task 2, Rulings 1 and 2); no URL changes (Global Constraints); Your team link with the mobile check (Tasks 5 and 7).
- The event detail URL is `/event/:slug`, not `/event/:id` as the decision wrote; the plan uses the router's real paths.
- Types used across tasks: `TeamChip` (server) and `ProfileTeam` (web) have the same five fields; `competeHome` is `'events' | 'scrims' | null` on both sides; `myTeams` is `{ slug, name }[]` on both sides; `competeTabFor` and `CompeteTabs` are named the same in Tasks 4, 5 and 7.
