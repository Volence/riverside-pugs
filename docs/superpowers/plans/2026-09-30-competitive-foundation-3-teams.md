# Competitive foundation plan 3: teams and team pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can create a team, invite people on the site or by Discord DM, hand out a join link, run the roster (co-captains, kicks, captaincy hand-over, logo, rename) and leave; staff can rename or disband any team; every team has a public page at `/team/:slug`. All of it is invisible until an admin opens it with the `competitive_enabled` switch.

**Architecture:** Three tables (`teams`, `team_members`, `team_invites`) whose rows are never deleted. Every rule lives in one domain module, `src/teams/teams.ts`, as synchronous better-sqlite3 transactions returning `{ ok, value } | { ok: false, error }`; the HTTP routes (`src/routes/teams.ts`) and the Discord Accept/Decline buttons (`src/discord/teamButtons.ts`) both call it, so the two surfaces cannot disagree. Logos are 256 x 256 PNGs in the existing content-addressed community store under a new `logo` kind. The web gets three pages (`/teams`, `/team/:slug`, `/team/join/:token`) and a nav link shown only to viewers the switch lets in.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck`; Preact + preact-iso + @testing-library/preact for the web.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 2 (Teams). Section 4 for `region`. Rollout section for the `competitive_enabled` switch.

## Global Constraints

- Tables `teams` (id, name, tag 2-5 chars, slug, logo_key, region, captain_steamid, origin `site` | `draft` | `pickup`, origin_ref, created_at, disbanded_at, join_link_token), `team_members` (team_id, steamid, role `captain` | `cocaptain` | `member`, joined_at, left_at), `team_invites` (team_id, steamid, invited_by, created_at, responded_at, response). Rows are never deleted; leaving sets `left_at`.
- Roster up to 8 (4 starters plus subs); 4 needed to enter an event (`ENTRY_MIN`, used by spec 2, defined here).
- A player may hold at most 3 active memberships (setting `team_membership_cap`, default 3), and may have created at most 3 teams that are not disbanded.
- Names and tags pass the existing conduct slur filter (`findSlurs`); unique case-insensitively; staff can rename or disband any team (audited via `admin_actions`).
- Joining: site invite, Discord DM with Accept/Decline buttons, or a join link the captain can turn off.
- Captaincy can be handed over. If the captain leaves: co-captain, else longest-serving member. A team with no members is disbanded automatically.
- `teams.region` text, default `na`. Nothing region-related is shown while only one region exists.
- Everything sits behind setting `competitive_enabled` (off). It is a three-way switch like `practice_leasing`: `off` | `admins` | `everyone`, default `off`. Closed means every `/api/teams*` route answers 404 and no nav link shows.
- Staff = `is_admin = 1` or `is_mod = 1`, as `src/routes/community.ts` defines it.
- Never write em dashes in code, comments, commits or docs.
- Commit messages follow the repo style (plain sentence); do not push, do not deploy.
- Several Claude sessions may use `/home/volence/l4d/pug`: work in a worktree branch; check `git reflog -10` and `git status` before any write on master.

## Not in this plan (and why)

- Match cards and per-match voice channels using team names: no match belongs to a team until bookings (plan 4) create `booking_sides.team_id`.
- The team page's Scrims tab, trophies and event history: scrims are plan 4, events are spec 2. The page leaves room for them; it does not show empty tabs.
- "Keep this team" from a draft and "Make this a team" from a pickup: specs 3 and 4 own the flows; the `origin` / `origin_ref` columns land here.
- `src/notify/` and notification preferences: plan 4. The invite DM here is sent directly, the way `SignonDropNotifier` sends its DM.

## Review Focus

- Names that differ only by case or spacing ("Riverside Rats", "riverside  rats ", "RIVERSIDE RATS") must collide; a disbanded team's name and tag become free again. Task 2 tests.
- Accepting an invite when the accepting player has reached the membership cap or the roster has reached 8 since the invite was sent: refused at accept time, not only at invite time. Task 3 tests.
- The last member leaving disbands the team and cancels its open invites and join link; a captain leaving hands captaincy to the earliest co-captain, else the earliest-joined member, never to someone who already left. Task 4 tests.
- A Discord Accept pressed by a Discord user who is not linked to the invited player (a forwarded DM, a shared screen): refused, and the invite stays open. Task 6 test.
- A merged alt account that is on the same team as its survivor: the merge must not trip the one-active-membership index, and the survivor keeps the captaincy if either account held it. Task 1 test.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | SCHEMA: three tables and their partial unique indexes; DEFAULT_SETTINGS gains two keys. |
| `src/settingsSchema.ts` | Two settings in a new `Competitive` group. |
| `src/mergePlayers.ts` | Team columns follow a merged account. |
| `src/teams/access.ts` | `competitiveAccess(db, viewer)`. |
| `src/teams/teams.ts` | Every team rule: validation, create, invites, join link, leave, kick, roles, captaincy, rename, disband, logo key, views. |
| `src/community/store.ts`, `src/community/validate.ts`, `src/community/sweep.ts` | `logo` file kind, `checkLogo`, sweep keeps logos a team uses. |
| `src/routes/teams.ts` | HTTP surface. |
| `src/discord/teamButtons.ts` | Invite DM payload and the `tm:` button handler. |
| `src/server.ts` | Registers the routes and the button prefix. |
| `src/routes/auth.ts` | `/api/me` gains `teams: boolean`. |
| `web/src/api.ts` | Types and `teamsApi`. |
| `web/src/routes/Teams.tsx`, `Team.tsx`, `TeamJoin.tsx`, `web/src/teamLogo.ts` | Pages and the logo resize helper. |
| `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx` | Routes and the nav link. |

---

### Task 1: Schema, settings, access switch, account merge

**Files:**
- Modify: `src/db.ts` (SCHEMA string: after the `rulesets` table, about line 128; `DEFAULT_SETTINGS`, about line 842, next to `practice_leasing`)
- Modify: `src/settingsSchema.ts` (group union on `SettingDef.group`; two entries at the end of `SETTINGS_SCHEMA`)
- Modify: `src/mergePlayers.ts` (`PLAIN` list; the transaction body just before `for (const [table, column] of PLAIN)`, about line 310)
- Create: `src/teams/access.ts`
- Test: `tests/teamsSchema.test.ts` (new), `tests/mergePlayers.test.ts` (one new case)

**Interfaces:**
- Produces: tables `teams`, `team_members`, `team_invites` exactly as in Step 3.
- Produces: `competitiveAccess(db: DB, viewer: string | null): boolean` in `src/teams/access.ts`.
- Produces: settings `competitive_enabled` (default `'off'`), `team_membership_cap` (default `'3'`).

- [ ] **Step 1: Write the failing tests**

Create `tests/teamsSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { competitiveAccess } from '../src/teams/access.js';
import { getSetting } from '../src/settings.js';

const A = '76561199000000001';
const ADMIN = '76561199000000002';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active'), (?, 'admin', 'active')").run(A, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const team = (name: string, extra: { disbanded?: boolean } = {}) => Number(db.prepare(
  `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, disbanded_at)
   VALUES (?, ?, 'RR', 'RR', ?, ?, ?, ?)`,
).run(name, name.toLowerCase(), `${name.toLowerCase()}-${Math.random()}`, A, A, extra.disbanded ? '2026-09-30T00:00:00.000Z' : null).lastInsertRowid);

describe('team tables', () => {
  it('two live teams cannot share a name key, a disbanded one does not count', () => {
    team('Rats', { disbanded: true });
    team('Rats');
    expect(() => team('Rats')).toThrow(/UNIQUE/);
  });

  it('one active membership per player per team, history rows allowed', () => {
    const t = team('Rats');
    const ins = db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at, left_at) VALUES (?, ?, 'member', '2026-09-30', ?)");
    ins.run(t, A, '2026-09-30T01:00:00.000Z');
    ins.run(t, A, null);
    expect(() => ins.run(t, A, null)).toThrow(/UNIQUE/);
  });

  it('one open invite per player per team', () => {
    const t = team('Rats');
    const ins = db.prepare("INSERT INTO team_invites (team_id, steamid, invited_by, created_at) VALUES (?, ?, ?, '2026-09-30')");
    ins.run(t, ADMIN, A);
    expect(() => ins.run(t, ADMIN, A)).toThrow(/UNIQUE/);
  });

  it('region defaults to na and origin to site', () => {
    const t = team('Rats');
    expect(db.prepare('SELECT region, origin FROM teams WHERE id = ?').get(t)).toEqual({ region: 'na', origin: 'site' });
  });
});

describe('competitive switch', () => {
  it('defaults to off for everyone', () => {
    expect(getSetting(db, 'competitive_enabled')).toBe('off');
    expect(getSetting(db, 'team_membership_cap')).toBe('3');
    expect(competitiveAccess(db, ADMIN)).toBe(false);
  });

  it('admins only lets admins in, everyone lets active players in, nobody signed out', () => {
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect(competitiveAccess(db, ADMIN)).toBe(true);
    expect(competitiveAccess(db, A)).toBe(false);
    db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
    expect(competitiveAccess(db, A)).toBe(true);
    expect(competitiveAccess(db, null)).toBe(false);
  });
});
```

In `tests/mergePlayers.test.ts`, read the top of the file for its `ALT`, `MAIN`, `OTHER` constants and `beforeEach` (players seeded there), then add inside the top-level `describe`:

```ts
  it('moves team rows, closing the alt membership where both are on one team, and keeps the captaincy', () => {
    const t = Number(db.prepare(
      `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by)
       VALUES ('Rats', 'rats', 'RR', 'RR', 'rats', ?, ?)`,
    ).run(ALT, ALT).lastInsertRowid);
    const t2 = Number(db.prepare(
      `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by)
       VALUES ('Mice', 'mice', 'MM', 'MM', 'mice', ?, ?)`,
    ).run(OTHER, OTHER).lastInsertRowid);
    const mem = db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, ?, '2026-09-30')");
    mem.run(t, ALT, 'captain');
    mem.run(t, MAIN, 'member');
    mem.run(t2, OTHER, 'captain');
    db.prepare("INSERT INTO team_invites (team_id, steamid, invited_by, created_at) VALUES (?, ?, ?, '2026-09-30'), (?, ?, ?, '2026-09-30')")
      .run(t2, ALT, OTHER, t2, MAIN, OTHER);

    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT captain_steamid, created_by FROM teams WHERE id = ?').get(t)).toEqual({ captain_steamid: MAIN, created_by: MAIN });
    expect(db.prepare('SELECT steamid, role FROM team_members WHERE team_id = ? AND left_at IS NULL').all(t))
      .toEqual([{ steamid: MAIN, role: 'captain' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_invites WHERE team_id = ? AND responded_at IS NULL').get(t2)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_members WHERE steamid = ?").get(ALT)).toEqual({ n: 0 });
  });
```

If the file's `OTHER` is not seeded as a player, seed it with the same insert the file uses for `ALT`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/teamsSchema.test.ts tests/mergePlayers.test.ts`
Expected: FAIL, `no such table: teams` and `Cannot find module '../src/teams/access.js'`. The existing "handles every foreign key that points at players" case still passes (the tables do not exist yet).

- [ ] **Step 3: Add the tables**

In `src/db.ts`, in the SCHEMA string directly after the `rulesets` table, add:

```sql
-- Teams (competitive platform, spec part 1 section 2). Rows are never
-- deleted: a disbanded team keeps its page and slug, and a member who left
-- keeps their row with left_at set. name_key / tag_key are the
-- case-insensitive forms the uniqueness rule compares; only live teams hold
-- a name or tag. origin_ref is the draft event or scrim booking a team came
-- from (specs 3 and 4).
CREATE TABLE IF NOT EXISTS teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL,
  tag             TEXT NOT NULL,
  tag_key         TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  logo_key        TEXT,
  region          TEXT NOT NULL DEFAULT 'na',
  captain_steamid TEXT NOT NULL REFERENCES players(steamid),
  created_by      TEXT NOT NULL REFERENCES players(steamid),
  origin          TEXT NOT NULL DEFAULT 'site' CHECK (origin IN ('site','draft','pickup')),
  origin_ref      TEXT,
  join_link_token TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  disbanded_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_live ON teams (name_key) WHERE disbanded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_tag_live ON teams (tag_key) WHERE disbanded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_join_token ON teams (join_link_token) WHERE join_link_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS team_members (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id   INTEGER NOT NULL REFERENCES teams(id),
  steamid   TEXT NOT NULL REFERENCES players(steamid),
  role      TEXT NOT NULL CHECK (role IN ('captain','cocaptain','member')),
  joined_at TEXT NOT NULL,
  left_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_active ON team_members (team_id, steamid) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS team_members_player ON team_members (steamid) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS team_invites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  steamid      TEXT NOT NULL REFERENCES players(steamid),
  invited_by   TEXT NOT NULL REFERENCES players(steamid),
  created_at   TEXT NOT NULL,
  responded_at TEXT,
  response     TEXT CHECK (response IN ('accepted','declined','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS team_invites_open ON team_invites (team_id, steamid) WHERE responded_at IS NULL;
```

The SCHEMA string is a template literal; if it is a plain string with different quoting, keep its style.

- [ ] **Step 4: Add the settings and the switch**

In `src/db.ts` `DEFAULT_SETTINGS`, next to `practice_leasing: 'admins',`:

```ts
  // Competitive platform (teams, later bookings and events): off | admins |
  // everyone. Off hides every team page and route.
  competitive_enabled: 'off',
  team_membership_cap: '3',
```

In `src/settingsSchema.ts`, add `'Competitive'` to the `group` union of `SettingDef`, and append to `SETTINGS_SCHEMA`:

```ts
  { key: 'competitive_enabled', group: 'Competitive', label: 'Teams and competitive for', help: 'Who can see and use teams (and, later, scrims and tournaments). Admins only is for trying it out; nobody else sees any of it, not even the team pages. Off hides it all again; nothing is deleted.', type: { kind: 'choice', options: [{ value: 'off', label: 'Nobody (off)' }, { value: 'admins', label: 'Admins only' }, { value: 'everyone', label: 'Every player' }] } },
  { key: 'team_membership_cap', group: 'Competitive', label: 'Teams per player', help: 'How many teams one player may be on at once, and how many teams one player may have created that are not disbanded. Lowering it removes nobody; it only stops new joins.', type: { kind: 'int', min: 1, max: 10 } },
```

Create `src/teams/access.ts`:

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { getPlayer } from '../players.js';

/**
 * Whether this viewer may see and use teams, by the staged rollout switch
 * `competitive_enabled` (off | admins | everyone, default off). `viewer` is an
 * active player's SteamID or null. Anything the switch does not recognise
 * reads as off: unlike practice, nothing here is half-built for admins.
 */
export function competitiveAccess(db: DB, viewer: string | null): boolean {
  if (!viewer) return false;
  const mode = getSetting(db, 'competitive_enabled') ?? 'off';
  if (mode === 'everyone') return true;
  if (mode === 'admins') return getPlayer(db, viewer)?.is_admin === 1;
  return false;
}
```

Check the import path of `getSetting`: `grep -n "export function getSetting" src/settings.ts`.

- [ ] **Step 5: Teach the merge about teams**

In `src/mergePlayers.ts`, add to `PLAIN` (before its closing `];`):

```ts
  // Teams (src/teams/teams.ts) follow the person. Where both accounts were
  // active on one team, or both invited to one, the alt's row is closed first
  // (in the transaction below), so one person never holds two places on a
  // roster. The captaincy, if either held it, ends up on the survivor.
  ['teams', 'captain_steamid'],
  ['teams', 'created_by'],
  ['team_members', 'steamid'],
  ['team_invites', 'steamid'],
  ['team_invites', 'invited_by'],
```

In the transaction, directly before `for (const [table, column] of PLAIN) {`, add:

```ts
    const teamsNow = new Date().toISOString();
    db.prepare(`UPDATE team_members SET left_at = ? WHERE steamid = ? AND left_at IS NULL
      AND team_id IN (SELECT team_id FROM team_members WHERE steamid = ? AND left_at IS NULL)`).run(teamsNow, from, into);
    db.prepare(`UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE steamid = ? AND responded_at IS NULL
      AND team_id IN (SELECT team_id FROM team_invites WHERE steamid = ? AND responded_at IS NULL)`).run(teamsNow, from, into);
```

and directly after that `PLAIN` loop's closing brace:

```ts
    // A captain alt whose membership was closed above: teams.captain_steamid
    // has just moved to the survivor, whose own row still says member.
    db.prepare(`UPDATE team_members SET role = 'captain' WHERE steamid = ? AND left_at IS NULL
      AND team_id IN (SELECT id FROM teams WHERE captain_steamid = ? AND disbanded_at IS NULL)`).run(into, into);
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/teamsSchema.test.ts tests/mergePlayers.test.ts tests/adminSettings.test.ts tests/db.test.ts`
Expected: PASS. `tests/db.test.ts` may hold a list of every table name (it listed `practice_leases`, `rulesets`, `side_games` in plan 2); add `'team_invites', 'team_members', 'teams'` to it in sorted position if it fails on that list, and nothing else.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/db.ts src/settingsSchema.ts src/mergePlayers.ts src/teams/access.ts tests/teamsSchema.test.ts tests/mergePlayers.test.ts tests/db.test.ts
git commit -m "Teams: tables, competitive switch, team membership cap, merged accounts carry their teams"
```

---

### Task 2: Team rules, part 1: validation, create, read helpers

**Files:**
- Create: `src/teams/teams.ts`
- Test: `tests/teams.test.ts` (new; Tasks 3 and 4 add to it)

**Interfaces:**
- Consumes: tables and `team_membership_cap` (Task 1).
- Produces (all in `src/teams/teams.ts`):
  - `type TeamRole = 'captain' | 'cocaptain' | 'member'`
  - `const ROSTER_MAX = 8`, `const ENTRY_MIN = 4`, `NAME_MIN = 3`, `NAME_MAX = 24`
  - `interface TeamRow` (every `teams` column), `interface MemberRow` (every `team_members` column, `role: TeamRole`)
  - `type TeamError` and `const TEAM_ERRORS: Record<TeamError, { status: number; text: string }>`
  - `type Result<T> = { ok: true; value: T } | { ok: false; error: TeamError }`
  - `normalizeName(raw: unknown)`, `normalizeTag(raw: unknown)`, `membershipCap(db)`
  - `createTeam(db, o: { creator: string; name: unknown; tag: unknown; now?: Date }): Result<{ id: number; slug: string }>`
  - `getTeam(db, id): TeamRow | undefined`, `getTeamBySlug(db, slug): TeamRow | undefined`
  - `activeMembers(db, teamId): MemberRow[]` (captain, then co-captains, then members; each by joined_at, id)
  - `formerMembers(db, teamId): { steamid: string; left_at: string }[]`
  - `roleOf(db, teamId, steamid): TeamRole | null`
  - `liveTeams(db): TeamRow[]`, `myTeams(db, steamid): (TeamRow & { role: TeamRole })[]`, `canCreate(db, steamid): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/teams.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  activeMembers, canCreate, createTeam, getTeamBySlug, myTeams, normalizeName, normalizeTag, roleOf,
} from '../src/teams/teams.js';

export const P = Array.from({ length: 12 }, (_, i) => `765611990000001${String(i).padStart(2, '0')}`);

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
});
const t0 = new Date('2026-10-01T12:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const make = (creator: string, name: string, tag: string, now = t0) => {
  const r = createTeam(db, { creator, name, tag, now });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('names and tags', () => {
  it('trims and collapses spaces, keys case-insensitively', () => {
    expect(normalizeName('  Riverside   Rats ')).toEqual({ ok: true, name: 'Riverside Rats', key: 'riverside rats' });
    expect(normalizeName('ab')).toEqual({ ok: false, error: 'bad_name' });
    expect(normalizeName('x'.repeat(25))).toEqual({ ok: false, error: 'bad_name' });
    expect(normalizeName(42)).toEqual({ ok: false, error: 'bad_name' });
  });

  it('refuses a slur in a name or a tag', () => {
    expect(normalizeName('team faggot')).toEqual({ ok: false, error: 'name_not_allowed' });
    expect(normalizeTag('NIGGA'.slice(0, 5))).toEqual({ ok: false, error: 'tag_not_allowed' });
  });

  it('a tag is 2 to 5 letters or digits, keyed upper case', () => {
    expect(normalizeTag(' rR1 ')).toEqual({ ok: true, tag: 'rR1', key: 'RR1' });
    expect(normalizeTag('R')).toEqual({ ok: false, error: 'bad_tag' });
    expect(normalizeTag('RRRRRR')).toEqual({ ok: false, error: 'bad_tag' });
    expect(normalizeTag('R R')).toEqual({ ok: false, error: 'bad_tag' });
  });
});

describe('createTeam', () => {
  it('creates the team with its creator as captain and a slug from the name', () => {
    const { slug } = make(P[0], 'Riverside Rats', 'RR');
    expect(slug).toBe('riverside-rats');
    const team = getTeamBySlug(db, slug)!;
    expect(team).toMatchObject({ name: 'Riverside Rats', tag: 'RR', captain_steamid: P[0], created_by: P[0], region: 'na', origin: 'site' });
    expect(activeMembers(db, team.id).map((m) => [m.steamid, m.role])).toEqual([[P[0], 'captain']]);
    expect(roleOf(db, team.id, P[0])).toBe('captain');
  });

  it('refuses a name or tag another live team holds, in any case or spacing', () => {
    make(P[0], 'Riverside Rats', 'RR');
    expect(createTeam(db, { creator: P[1], name: 'riverside  RATS', tag: 'XX' })).toEqual({ ok: false, error: 'name_taken' });
    expect(createTeam(db, { creator: P[1], name: 'Other', tag: 'rr' })).toEqual({ ok: false, error: 'tag_taken' });
  });

  it('a disbanded team frees its name and tag, but never its slug', () => {
    const { slug } = make(P[0], 'Riverside Rats', 'RR');
    db.prepare("UPDATE teams SET disbanded_at = '2026-10-01T13:00:00.000Z' WHERE slug = ?").run(slug);
    expect(make(P[1], 'Riverside Rats', 'RR').slug).toBe('riverside-rats-2');
  });

  it('a name that slugs to nothing or to a reserved word gets a usable slug', () => {
    expect(make(P[0], '!!!', 'AA').slug).toBe('team');
    expect(make(P[1], 'Mine', 'BB').slug).toBe('mine-2');
  });

  it('stops at the membership cap and the created-teams cap', () => {
    make(P[0], 'One', 'O1'); make(P[0], 'Two', 'O2'); make(P[0], 'Three', 'O3');
    expect(canCreate(db, P[0])).toBe(false);
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' })).toEqual({ ok: false, error: 'your_cap' });
    // Leaving all three frees the membership cap but not the created cap.
    db.prepare("UPDATE team_members SET left_at = '2026-10-01T13:00:00.000Z' WHERE steamid = ?").run(P[0]);
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' })).toEqual({ ok: false, error: 'created_cap' });
    db.prepare("UPDATE settings SET value = '4' WHERE key = 'team_membership_cap'").run();
    expect(createTeam(db, { creator: P[0], name: 'Four', tag: 'O4' }).ok).toBe(true);
  });

  it('myTeams lists live teams the player is on, with their role', () => {
    make(P[0], 'Alpha', 'AA');
    const b = make(P[1], 'Bravo', 'BB');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES ((SELECT id FROM teams WHERE slug = ?), ?, 'member', ?)")
      .run(b.slug, P[0], at(1).toISOString());
    expect(myTeams(db, P[0]).map((t) => [t.slug, t.role])).toEqual([['alpha', 'captain'], ['bravo', 'member']]);
  });
});
```

The slur strings are the ones `tests/slurs.test.ts` already uses; `findSlurs` must return non-empty for them. If `normalizeTag('NIGGA')` does not trip `findSlurs` (a five-letter token), replace that one assertion with any 2-5 letter token `tests/slurs.test.ts` shows `findSlurs` catching, and keep the expectation `tag_not_allowed`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/teams.test.ts`
Expected: FAIL, `Cannot find module '../src/teams/teams.js'`.

- [ ] **Step 3: Implement**

Create `src/teams/teams.ts`:

```ts
import type { DB } from '../db.js';
import { findSlurs } from '../slurs.js';
import { hasUnsafeChars } from '../profileFields.js';
import { settingNumber } from '../settings.js';

/**
 * Every rule about teams (spec part 1, section 2). The routes and the Discord
 * buttons call these and nothing else writes the three team tables, so the
 * two surfaces cannot disagree about who may do what.
 *
 * Each write is one transaction that re-checks its rules inside, so two
 * requests racing (two invites accepted at once, a kick during an accept)
 * cannot get past a cap: better-sqlite3 runs a transaction to the end before
 * the next statement from anywhere.
 */

export type TeamRole = 'captain' | 'cocaptain' | 'member';
export const ROSTER_MAX = 8;
/** Players a team needs to enter an event (spec 2 reads this). */
export const ENTRY_MIN = 4;
export const NAME_MIN = 3;
export const NAME_MAX = 24;
/** Slugs the routes use as words of their own. */
const RESERVED_SLUGS = new Set(['mine', 'join', 'logos', 'invites', 'player-search']);

export interface TeamRow {
  id: number; name: string; name_key: string; tag: string; tag_key: string; slug: string;
  logo_key: string | null; region: string; captain_steamid: string; created_by: string;
  origin: 'site' | 'draft' | 'pickup'; origin_ref: string | null; join_link_token: string | null;
  created_at: string; disbanded_at: string | null;
}
export interface MemberRow {
  id: number; team_id: number; steamid: string; role: TeamRole; joined_at: string; left_at: string | null;
}

export const TEAM_ERRORS = {
  bad_name: { status: 400, text: `A team name is ${NAME_MIN} to ${NAME_MAX} characters of plain text.` },
  bad_tag: { status: 400, text: 'A tag is 2 to 5 letters or digits.' },
  name_not_allowed: { status: 400, text: 'That name is not allowed here.' },
  tag_not_allowed: { status: 400, text: 'That tag is not allowed here.' },
  name_taken: { status: 409, text: 'Another team already has that name.' },
  tag_taken: { status: 409, text: 'Another team already has that tag.' },
  your_cap: { status: 409, text: 'You are already on as many teams as allowed. Leave one first.' },
  their_cap: { status: 409, text: 'That player is already on as many teams as allowed.' },
  created_cap: { status: 409, text: 'You have created as many teams as allowed. Disband one first.' },
  roster_full: { status: 409, text: `The roster is full (${ROSTER_MAX} players).` },
  not_found: { status: 404, text: 'No such team.' },
  not_allowed: { status: 403, text: 'Only the captain can do that.' },
  not_manager: { status: 403, text: 'Only the captain or a co-captain can do that.' },
  not_player: { status: 400, text: 'That is not an active player.' },
  not_member: { status: 400, text: 'That player is not on this team.' },
  already_member: { status: 409, text: 'Already on this team.' },
  already_invited: { status: 409, text: 'Already invited.' },
  invite_closed: { status: 410, text: 'That invite is no longer open.' },
  link_off: { status: 404, text: 'That join link is turned off or was replaced.' },
  is_captain: { status: 400, text: 'Hand the captaincy over first.' },
  bad_role: { status: 400, text: 'A role is cocaptain or member.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type TeamError = keyof typeof TEAM_ERRORS;

export type Result<T> = { ok: true; value: T } | { ok: false; error: TeamError };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: TeamError): { ok: false; error: TeamError } => ({ ok: false, error });

export function membershipCap(db: DB): number {
  return settingNumber(db, 'team_membership_cap', 3, { integer: true, min: 1, max: 10 });
}

export function normalizeName(raw: unknown): { ok: true; name: string; key: string } | { ok: false; error: TeamError } {
  if (typeof raw !== 'string') return fail('bad_name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name)) return fail('bad_name');
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  return { ok: true, name, key: name.toLowerCase() };
}

export function normalizeTag(raw: unknown): { ok: true; tag: string; key: string } | { ok: false; error: TeamError } {
  if (typeof raw !== 'string') return fail('bad_tag');
  const tag = raw.trim();
  if (!/^[A-Za-z0-9]{2,5}$/.test(tag)) return fail('bad_tag');
  if (findSlurs(tag).length > 0) return fail('tag_not_allowed');
  return { ok: true, tag, key: tag.toUpperCase() };
}

/** A URL slug from the name, unique over every team ever made, so a
 *  disbanded team's page keeps its address. Fixed at creation: a rename
 *  never breaks a link. */
function slugFor(db: DB, name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/, '') || 'team';
  const taken = db.prepare('SELECT 1 FROM teams WHERE slug = ?');
  if (!RESERVED_SLUGS.has(base) && !taken.get(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`;
    if (!taken.get(s)) return s;
  }
}

export function getTeam(db: DB, id: number): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
}

export function getTeamBySlug(db: DB, slug: string): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE slug = ?').get(slug) as TeamRow | undefined;
}

export function liveTeams(db: DB): TeamRow[] {
  return db.prepare('SELECT * FROM teams WHERE disbanded_at IS NULL ORDER BY name_key').all() as TeamRow[];
}

/** Captain, then co-captains, then members; each oldest first. The first
 *  row after the captain is who takes over if the captain leaves. */
export function activeMembers(db: DB, teamId: number): MemberRow[] {
  return db.prepare(
    `SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL
     ORDER BY CASE role WHEN 'captain' THEN 0 WHEN 'cocaptain' THEN 1 ELSE 2 END, joined_at, id`,
  ).all(teamId) as MemberRow[];
}

/** Everyone who was on the team and is not now, with when they last left. */
export function formerMembers(db: DB, teamId: number): { steamid: string; left_at: string }[] {
  return db.prepare(
    `SELECT steamid, MAX(left_at) AS left_at FROM team_members
      WHERE team_id = ? AND left_at IS NOT NULL
        AND steamid NOT IN (SELECT steamid FROM team_members WHERE team_id = ? AND left_at IS NULL)
      GROUP BY steamid ORDER BY MAX(left_at) DESC`,
  ).all(teamId, teamId) as { steamid: string; left_at: string }[];
}

export function roleOf(db: DB, teamId: number, steamid: string): TeamRole | null {
  const r = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND steamid = ? AND left_at IS NULL')
    .get(teamId, steamid) as { role: TeamRole } | undefined;
  return r?.role ?? null;
}

export function activeMembershipCount(db: DB, steamid: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.steamid = ? AND m.left_at IS NULL AND t.disbanded_at IS NULL`,
  ).get(steamid) as { n: number }).n;
}

export function rosterSize(db: DB, teamId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL').get(teamId) as { n: number }).n;
}

function createdCount(db: DB, steamid: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM teams WHERE created_by = ? AND disbanded_at IS NULL').get(steamid) as { n: number }).n;
}

export function canCreate(db: DB, steamid: string): boolean {
  const cap = membershipCap(db);
  return activeMembershipCount(db, steamid) < cap && createdCount(db, steamid) < cap;
}

export function myTeams(db: DB, steamid: string): (TeamRow & { role: TeamRole })[] {
  return db.prepare(
    `SELECT t.*, m.role FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.steamid = ? AND m.left_at IS NULL AND t.disbanded_at IS NULL ORDER BY m.joined_at, m.id`,
  ).all(steamid) as (TeamRow & { role: TeamRole })[];
}

/** A live name or tag held by a team other than `except`. */
export function nameTaken(db: DB, key: string, except = 0): boolean {
  return db.prepare('SELECT 1 FROM teams WHERE name_key = ? AND disbanded_at IS NULL AND id != ?').get(key, except) !== undefined;
}
export function tagTaken(db: DB, key: string, except = 0): boolean {
  return db.prepare('SELECT 1 FROM teams WHERE tag_key = ? AND disbanded_at IS NULL AND id != ?').get(key, except) !== undefined;
}

export function createTeam(
  db: DB, o: { creator: string; name: unknown; tag: unknown; now?: Date },
): Result<{ id: number; slug: string }> {
  const n = normalizeName(o.name);
  if (!n.ok) return n;
  const t = normalizeTag(o.tag);
  if (!t.ok) return t;
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ id: number; slug: string }> => {
    const cap = membershipCap(db);
    if (activeMembershipCount(db, o.creator) >= cap) return fail('your_cap');
    if (createdCount(db, o.creator) >= cap) return fail('created_cap');
    if (nameTaken(db, n.key)) return fail('name_taken');
    if (tagTaken(db, t.key)) return fail('tag_taken');
    const slug = slugFor(db, n.name);
    const id = Number(db.prepare(
      `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(n.name, n.key, t.tag, t.key, slug, o.creator, o.creator, now).lastInsertRowid);
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'captain', ?)").run(id, o.creator, now);
    return ok({ id, slug });
  })();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/teams.test.ts`
Expected: PASS (7 cases). `npm run typecheck`: clean.

- [ ] **Step 5: Commit**

```bash
git add src/teams/teams.ts tests/teams.test.ts
git commit -m "Teams: name and tag rules, create with caps, roster read helpers"
```

---

### Task 3: Team rules, part 2: invites and the join link

**Files:**
- Modify: `src/teams/teams.ts` (append)
- Test: `tests/teams.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:
  - `interface InviteRow` (every `team_invites` column)
  - `invitePlayer(db, o: { teamId: number; by: string; target: string; now?: Date }): Result<{ inviteId: number }>`
  - `respondInvite(db, o: { inviteId: number; steamid: string; accept: boolean; now?: Date }): Result<{ teamId: number; slug: string }>`
  - `cancelInvite(db, o: { inviteId: number; by: string; now?: Date }): Result<null>`
  - `openInvitesOf(db, teamId): InviteRow[]`, `pendingInvitesFor(db, steamid): (InviteRow & { slug: string; name: string; tag: string })[]`, `getInvite(db, id): InviteRow | undefined`
  - `setJoinLink(db, o: { teamId: number; by: string; on: boolean }): Result<{ token: string | null }>`
  - `teamByJoinToken(db, token: string): TeamRow | undefined`
  - `joinByLink(db, o: { token: string; steamid: string; now?: Date }): Result<{ slug: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/teams.test.ts` (and add the new names to its import from `../src/teams/teams.js`: `cancelInvite, invitePlayer, joinByLink, openInvitesOf, pendingInvitesFor, respondInvite, setJoinLink, teamByJoinToken`):

```ts
describe('invites', () => {
  const invite = (teamId: number, by: string, target: string) => {
    const r = invitePlayer(db, { teamId, by, target, now: at(1) });
    if (!r.ok) throw new Error(r.error);
    return r.value.inviteId;
  };

  it('captain and co-captains invite; the player accepts and joins as a member', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(pendingInvitesFor(db, P[1]).map((i) => [i.id, i.slug])).toEqual([[inv, 'rats']]);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true, now: at(2) })).toEqual({ ok: true, value: { teamId: id, slug: 'rats' } });
    expect(roleOf(db, id, P[1])).toBe('member');
    expect(pendingInvitesFor(db, P[1])).toEqual([]);
    expect(invitePlayer(db, { teamId: id, by: P[1], target: P[2] })).toEqual({ ok: false, error: 'not_manager' });
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE steamid = ?").run(P[1]);
    expect(invitePlayer(db, { teamId: id, by: P[1], target: P[2] }).ok).toBe(true);
  });

  it('refuses a duplicate invite, a member, and a player who is not active', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    invite(id, P[0], P[1]);
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[1] })).toEqual({ ok: false, error: 'already_invited' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[0] })).toEqual({ ok: false, error: 'already_member' });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[2]);
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[2] })).toEqual({ ok: false, error: 'not_player' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: '76561199999999999' })).toEqual({ ok: false, error: 'not_player' });
  });

  it('only the invited player can answer, and only once', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(respondInvite(db, { inviteId: inv, steamid: P[2], accept: true })).toEqual({ ok: false, error: 'not_found' });
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: false }).ok).toBe(true);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
    expect(roleOf(db, id, P[1])).toBeNull();
  });

  it('re-checks the cap and the roster at accept time', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    // P[1] fills their cap after the invite was sent.
    make(P[1], 'Alpha One', 'A1'); make(P[1], 'Alpha Two', 'A2'); make(P[1], 'Alpha Three', 'A3');
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'your_cap' });
    // The invite stays open, so freeing a slot lets them accept later.
    expect(openInvitesOf(db, id).map((i) => i.id)).toEqual([inv]);

    const inv2 = invite(id, P[0], P[2]);
    // P[3]..P[9] join: with the captain that is 8, a full roster.
    for (let i = 3; i <= 9; i++) respondInvite(db, { inviteId: invite(id, P[0], P[i]), steamid: P[i], accept: true });
    expect(rosterCount(id)).toBe(8);
    expect(respondInvite(db, { inviteId: inv2, steamid: P[2], accept: true })).toEqual({ ok: false, error: 'roster_full' });
    expect(invitePlayer(db, { teamId: id, by: P[0], target: P[10] })).toEqual({ ok: false, error: 'roster_full' });
  });

  it('an invite to a disbanded team is closed', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    db.prepare("UPDATE teams SET disbanded_at = '2026-10-01T13:00:00.000Z' WHERE id = ?").run(id);
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
  });

  it('managers cancel invites', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const inv = invite(id, P[0], P[1]);
    expect(cancelInvite(db, { inviteId: inv, by: P[1] })).toEqual({ ok: false, error: 'not_manager' });
    expect(cancelInvite(db, { inviteId: inv, by: P[0] })).toEqual({ ok: true, value: null });
    expect(respondInvite(db, { inviteId: inv, steamid: P[1], accept: true })).toEqual({ ok: false, error: 'invite_closed' });
  });
});

const rosterCount = (teamId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL').get(teamId) as { n: number }).n;

describe('join link', () => {
  it('only the captain turns it on; a new token replaces the old one; off kills it', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'cocaptain', ?)").run(id, P[1], at(1).toISOString());
    expect(setJoinLink(db, { teamId: id, by: P[1], on: true })).toEqual({ ok: false, error: 'not_allowed' });
    const first = setJoinLink(db, { teamId: id, by: P[0], on: true });
    const second = setJoinLink(db, { teamId: id, by: P[0], on: true });
    if (!first.ok || !second.ok) throw new Error('link');
    expect(first.value.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.value.token).not.toBe(first.value.token);
    expect(joinByLink(db, { token: first.value.token!, steamid: P[2] })).toEqual({ ok: false, error: 'link_off' });
    expect(teamByJoinToken(db, second.value.token!)?.id).toBe(id);
    expect(joinByLink(db, { token: second.value.token!, steamid: P[2] })).toEqual({ ok: true, value: { slug: 'rats' } });
    expect(roleOf(db, id, P[2])).toBe('member');
    expect(joinByLink(db, { token: second.value.token!, steamid: P[2] })).toEqual({ ok: false, error: 'already_member' });
    setJoinLink(db, { teamId: id, by: P[0], on: false });
    expect(joinByLink(db, { token: second.value.token!, steamid: P[3] })).toEqual({ ok: false, error: 'link_off' });
  });

  it('joining by link closes an open invite to the same team', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    invitePlayer(db, { teamId: id, by: P[0], target: P[1] });
    const link = setJoinLink(db, { teamId: id, by: P[0], on: true });
    if (!link.ok) throw new Error('link');
    joinByLink(db, { token: link.value.token!, steamid: P[1] });
    expect(openInvitesOf(db, id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/teams.test.ts`
Expected: FAIL on the new imports (`invitePlayer is not a function` or a type error from vitest's esbuild: missing export).

- [ ] **Step 3: Implement**

Append to `src/teams/teams.ts` (add `import { randomBytes } from 'node:crypto';` and `import { inGoodStanding } from '../standing.js';` and `import { getPlayer } from '../players.js';` at the top):

```ts
export interface InviteRow {
  id: number; team_id: number; steamid: string; invited_by: string; created_at: string;
  responded_at: string | null; response: 'accepted' | 'declined' | 'cancelled' | null;
}

const isManager = (role: TeamRole | null): boolean => role === 'captain' || role === 'cocaptain';

function liveTeam(db: DB, teamId: number): TeamRow | null {
  const t = getTeam(db, teamId);
  return t && !t.disbanded_at ? t : null;
}

export function getInvite(db: DB, id: number): InviteRow | undefined {
  return db.prepare('SELECT * FROM team_invites WHERE id = ?').get(id) as InviteRow | undefined;
}

export function openInvitesOf(db: DB, teamId: number): InviteRow[] {
  return db.prepare('SELECT * FROM team_invites WHERE team_id = ? AND responded_at IS NULL ORDER BY id').all(teamId) as InviteRow[];
}

export function pendingInvitesFor(db: DB, steamid: string): (InviteRow & { slug: string; name: string; tag: string })[] {
  return db.prepare(
    `SELECT i.*, t.slug, t.name, t.tag FROM team_invites i JOIN teams t ON t.id = i.team_id
      WHERE i.steamid = ? AND i.responded_at IS NULL AND t.disbanded_at IS NULL ORDER BY i.id`,
  ).all(steamid) as (InviteRow & { slug: string; name: string; tag: string })[];
}

/** Add a player to a live team as a member, with every joining rule. Also
 *  closes any open invite they had to this team. Call inside a transaction. */
function addMember(db: DB, team: TeamRow, steamid: string, now: string): Result<null> {
  if (roleOf(db, team.id, steamid)) return fail('already_member');
  if (!getPlayer(db, steamid) || !inGoodStanding(db, steamid)) return fail('not_player');
  if (rosterSize(db, team.id) >= ROSTER_MAX) return fail('roster_full');
  if (activeMembershipCount(db, steamid) >= membershipCap(db)) return fail('your_cap');
  db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)").run(team.id, steamid, now);
  db.prepare("UPDATE team_invites SET responded_at = ?, response = 'accepted' WHERE team_id = ? AND steamid = ? AND responded_at IS NULL")
    .run(now, team.id, steamid);
  return ok(null);
}

export function invitePlayer(
  db: DB, o: { teamId: number; by: string; target: string; now?: Date },
): Result<{ inviteId: number }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ inviteId: number }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!isManager(roleOf(db, team.id, o.by))) return fail('not_manager');
    if (!getPlayer(db, o.target) || !inGoodStanding(db, o.target)) return fail('not_player');
    if (roleOf(db, team.id, o.target)) return fail('already_member');
    if (db.prepare('SELECT 1 FROM team_invites WHERE team_id = ? AND steamid = ? AND responded_at IS NULL').get(team.id, o.target)) {
      return fail('already_invited');
    }
    if (rosterSize(db, team.id) >= ROSTER_MAX) return fail('roster_full');
    if (activeMembershipCount(db, o.target) >= membershipCap(db)) return fail('their_cap');
    const inviteId = Number(db.prepare('INSERT INTO team_invites (team_id, steamid, invited_by, created_at) VALUES (?, ?, ?, ?)')
      .run(team.id, o.target, o.by, now).lastInsertRowid);
    return ok({ inviteId });
  })();
}

/** Accept or decline. A refusal at accept time (cap, roster) leaves the
 *  invite open, so the player can make room and accept later. */
export function respondInvite(
  db: DB, o: { inviteId: number; steamid: string; accept: boolean; now?: Date },
): Result<{ teamId: number; slug: string }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ teamId: number; slug: string }> => {
    const inv = getInvite(db, o.inviteId);
    if (!inv || inv.steamid !== o.steamid) return fail('not_found');
    if (inv.responded_at) return fail('invite_closed');
    const team = liveTeam(db, inv.team_id);
    if (!team) {
      db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE id = ?").run(now, inv.id);
      return fail('invite_closed');
    }
    if (!o.accept) {
      db.prepare("UPDATE team_invites SET responded_at = ?, response = 'declined' WHERE id = ?").run(now, inv.id);
      return ok({ teamId: team.id, slug: team.slug });
    }
    const added = addMember(db, team, o.steamid, now);
    if (!added.ok) return added;
    return ok({ teamId: team.id, slug: team.slug });
  })();
}

export function cancelInvite(db: DB, o: { inviteId: number; by: string; now?: Date }): Result<null> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<null> => {
    const inv = getInvite(db, o.inviteId);
    if (!inv || inv.responded_at) return fail('invite_closed');
    if (!isManager(roleOf(db, inv.team_id, o.by))) return fail('not_manager');
    db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE id = ?").run(now, inv.id);
    return ok(null);
  })();
}

/** On: a fresh random token (replacing any old one). Off: none. Captain only. */
export function setJoinLink(db: DB, o: { teamId: number; by: string; on: boolean }): Result<{ token: string | null }> {
  return db.transaction((): Result<{ token: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const token = o.on ? randomBytes(16).toString('base64url') : null;
    db.prepare('UPDATE teams SET join_link_token = ? WHERE id = ?').run(token, team.id);
    return ok({ token });
  })();
}

export function teamByJoinToken(db: DB, token: string): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE join_link_token = ? AND disbanded_at IS NULL').get(token) as TeamRow | undefined;
}

export function joinByLink(db: DB, o: { token: string; steamid: string; now?: Date }): Result<{ slug: string }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ slug: string }> => {
    const team = teamByJoinToken(db, o.token);
    if (!team) return fail('link_off');
    const added = addMember(db, team, o.steamid, now);
    if (!added.ok) return added;
    return ok({ slug: team.slug });
  })();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/teams.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/teams/teams.ts tests/teams.test.ts
git commit -m "Teams: invites (re-checked at accept), cancel, join link that rotates and turns off"
```

---

### Task 4: Team rules, part 3: leave, succession, kick, roles, captaincy, rename, disband, logo key

**Files:**
- Modify: `src/teams/teams.ts` (append)
- Test: `tests/teams.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 2-3.
- Produces:
  - `leaveTeam(db, o: { teamId: number; steamid: string; now?: Date }): Result<{ disbanded: boolean; captain: string | null }>`
  - `kickMember(db, o: { teamId: number; by: string; target: string; now?: Date }): Result<{ disbanded: boolean; captain: string | null }>`
  - `setRole(db, o: { teamId: number; by: string; target: string; role: unknown }): Result<null>`
  - `transferCaptain(db, o: { teamId: number; by: string; target: string; staff?: boolean }): Result<null>`
  - `renameTeam(db, o: { teamId: number; by: string; staff?: boolean; name?: unknown; tag?: unknown }): Result<{ name: string; tag: string }>`
  - `disbandTeam(db, o: { teamId: number; by: string; staff?: boolean; now?: Date }): Result<null>`
  - `setLogoKey(db, o: { teamId: number; by: string; staff?: boolean; logoKey: string | null }): Result<null>`

`staff: true` lets a member of staff act on a team they are not captain of; the route decides who is staff and writes the audit row.

- [ ] **Step 1: Write the failing tests**

Append to `tests/teams.test.ts` (import the seven new names):

```ts
describe('leaving and succession', () => {
  const roster = (id: number, ...rest: [string, 'cocaptain' | 'member', number][]) => {
    const ins = db.prepare('INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, ?, ?)');
    for (const [s, role, min] of rest) ins.run(id, s, role, at(min).toISOString());
  };

  it('a captain leaving hands over to the earliest co-captain', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    roster(id, [P[1], 'member', 1], [P[2], 'cocaptain', 3], [P[3], 'cocaptain', 2]);
    expect(leaveTeam(db, { teamId: id, steamid: P[0], now: at(10) })).toEqual({ ok: true, value: { disbanded: false, captain: P[3] } });
    expect(roleOf(db, id, P[3])).toBe('captain');
    expect(getTeamBySlug(db, 'rats')!.captain_steamid).toBe(P[3]);
  });

  it('with no co-captain, the longest-serving member, never someone who left', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    roster(id, [P[1], 'member', 1], [P[2], 'member', 2]);
    leaveTeam(db, { teamId: id, steamid: P[1], now: at(5) });
    expect(leaveTeam(db, { teamId: id, steamid: P[0], now: at(6) })).toEqual({ ok: true, value: { disbanded: false, captain: P[2] } });
  });

  it('the last member leaving disbands the team, its invites and its link', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    invitePlayer(db, { teamId: id, by: P[0], target: P[1] });
    setJoinLink(db, { teamId: id, by: P[0], on: true });
    expect(leaveTeam(db, { teamId: id, steamid: P[0], now: at(5) })).toEqual({ ok: true, value: { disbanded: true, captain: null } });
    const t = getTeamBySlug(db, 'rats')!;
    expect(t.disbanded_at).toBe(at(5).toISOString());
    expect(t.join_link_token).toBeNull();
    expect(openInvitesOf(db, id)).toEqual([]);
    expect(make(P[1], 'Rats', 'RR').slug).toBe('rats-2');
  });

  it('a non-member cannot leave', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    expect(leaveTeam(db, { teamId: id, steamid: P[1] })).toEqual({ ok: false, error: 'not_member' });
  });

  it('former members are listed once, newest leave first', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    roster(id, [P[1], 'member', 1], [P[2], 'member', 2]);
    leaveTeam(db, { teamId: id, steamid: P[1], now: at(3) });
    leaveTeam(db, { teamId: id, steamid: P[2], now: at(4) });
    expect(formerMembers(db, id)).toEqual([{ steamid: P[2], left_at: at(4).toISOString() }, { steamid: P[1], left_at: at(3).toISOString() }]);
  });
});

describe('kicks, roles, captaincy', () => {
  const setup = () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const ins = db.prepare('INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, ?, ?)');
    ins.run(id, P[1], 'cocaptain', at(1).toISOString());
    ins.run(id, P[2], 'member', at(2).toISOString());
    ins.run(id, P[3], 'member', at(3).toISOString());
    return id;
  };

  it('captain kicks anyone but themselves; a co-captain kicks members only', () => {
    const id = setup();
    expect(kickMember(db, { teamId: id, by: P[1], target: P[0] })).toEqual({ ok: false, error: 'not_allowed' });
    expect(kickMember(db, { teamId: id, by: P[1], target: P[2] }).ok).toBe(true);
    expect(kickMember(db, { teamId: id, by: P[2], target: P[3] })).toEqual({ ok: false, error: 'not_manager' });
    expect(kickMember(db, { teamId: id, by: P[0], target: P[0] })).toEqual({ ok: false, error: 'is_captain' });
    expect(kickMember(db, { teamId: id, by: P[0], target: P[1] }).ok).toBe(true);
    expect(activeMembers(db, id).map((m) => m.steamid)).toEqual([P[0], P[3]]);
  });

  it('only the captain sets roles, and never on themselves', () => {
    const id = setup();
    expect(setRole(db, { teamId: id, by: P[1], target: P[2], role: 'cocaptain' })).toEqual({ ok: false, error: 'not_allowed' });
    expect(setRole(db, { teamId: id, by: P[0], target: P[2], role: 'cocaptain' })).toEqual({ ok: true, value: null });
    expect(setRole(db, { teamId: id, by: P[0], target: P[0], role: 'member' })).toEqual({ ok: false, error: 'is_captain' });
    expect(setRole(db, { teamId: id, by: P[0], target: P[2], role: 'captain' })).toEqual({ ok: false, error: 'bad_role' });
    expect(roleOf(db, id, P[2])).toBe('cocaptain');
  });

  it('captaincy moves to a member; the old captain becomes a co-captain; staff can move it too', () => {
    const id = setup();
    expect(transferCaptain(db, { teamId: id, by: P[1], target: P[2] })).toEqual({ ok: false, error: 'not_allowed' });
    expect(transferCaptain(db, { teamId: id, by: P[0], target: P[9] })).toEqual({ ok: false, error: 'not_member' });
    expect(transferCaptain(db, { teamId: id, by: P[0], target: P[2] })).toEqual({ ok: true, value: null });
    expect([roleOf(db, id, P[0]), roleOf(db, id, P[2])]).toEqual(['cocaptain', 'captain']);
    expect(getTeamBySlug(db, 'rats')!.captain_steamid).toBe(P[2]);
    expect(transferCaptain(db, { teamId: id, by: P[11], staff: true, target: P[3] }).ok).toBe(true);
    expect(roleOf(db, id, P[3])).toBe('captain');
  });
});

describe('rename, disband, logo', () => {
  it('captain or staff renames; the rules and uniqueness still apply; the slug stays', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    make(P[1], 'Mice', 'MM');
    expect(renameTeam(db, { teamId: id, by: P[2], name: 'New' })).toEqual({ ok: false, error: 'not_allowed' });
    expect(renameTeam(db, { teamId: id, by: P[0], name: 'mice' })).toEqual({ ok: false, error: 'name_taken' });
    expect(renameTeam(db, { teamId: id, by: P[0], tag: 'mm' })).toEqual({ ok: false, error: 'tag_taken' });
    expect(renameTeam(db, { teamId: id, by: P[0], name: 'rats' })).toEqual({ ok: true, value: { name: 'rats', tag: 'RR' } });
    expect(renameTeam(db, { teamId: id, by: P[11], staff: true, name: 'Big Rats', tag: 'BR' })).toEqual({ ok: true, value: { name: 'Big Rats', tag: 'BR' } });
    expect(getTeamBySlug(db, 'rats')!.name).toBe('Big Rats');
  });

  it('captain or staff disbands; everyone leaves; nobody else can', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'cocaptain', ?)").run(id, P[1], at(1).toISOString());
    expect(disbandTeam(db, { teamId: id, by: P[1] })).toEqual({ ok: false, error: 'not_allowed' });
    expect(disbandTeam(db, { teamId: id, by: P[0], now: at(9) })).toEqual({ ok: true, value: null });
    expect(activeMembers(db, id)).toEqual([]);
    expect(disbandTeam(db, { teamId: id, by: P[0] })).toEqual({ ok: false, error: 'not_found' });
    expect(myTeams(db, P[1])).toEqual([]);
  });

  it('captain, co-captain or staff sets the logo key', () => {
    const { id } = make(P[0], 'Rats', 'RR');
    const key = 'a'.repeat(64);
    expect(setLogoKey(db, { teamId: id, by: P[2], logoKey: key })).toEqual({ ok: false, error: 'not_manager' });
    expect(setLogoKey(db, { teamId: id, by: P[0], logoKey: key })).toEqual({ ok: true, value: null });
    expect(getTeamBySlug(db, 'rats')!.logo_key).toBe(key);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/teams.test.ts`
Expected: FAIL on the new imports.

- [ ] **Step 3: Implement**

Append to `src/teams/teams.ts`:

```ts
/** Close a team: every membership, open invite and the join link. Call
 *  inside a transaction. */
function closeTeam(db: DB, teamId: number, now: string): void {
  db.prepare('UPDATE teams SET disbanded_at = ?, join_link_token = NULL WHERE id = ?').run(now, teamId);
  db.prepare('UPDATE team_members SET left_at = ? WHERE team_id = ? AND left_at IS NULL').run(now, teamId);
  db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE team_id = ? AND responded_at IS NULL").run(now, teamId);
}

/** After someone left: disband an empty team, or give a captainless one to
 *  the first in activeMembers order (earliest co-captain, else earliest
 *  member). Call inside a transaction. */
function settleCaptaincy(db: DB, teamId: number, now: string): { disbanded: boolean; captain: string | null } {
  const members = activeMembers(db, teamId);
  if (members.length === 0) {
    closeTeam(db, teamId, now);
    return { disbanded: true, captain: null };
  }
  const current = members.find((m) => m.role === 'captain');
  if (current) return { disbanded: false, captain: current.steamid };
  const next = members[0];
  db.prepare("UPDATE team_members SET role = 'captain' WHERE id = ?").run(next.id);
  db.prepare('UPDATE teams SET captain_steamid = ? WHERE id = ?').run(next.steamid, teamId);
  return { disbanded: false, captain: next.steamid };
}

export function leaveTeam(
  db: DB, o: { teamId: number; steamid: string; now?: Date },
): Result<{ disbanded: boolean; captain: string | null }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ disbanded: boolean; captain: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!roleOf(db, team.id, o.steamid)) return fail('not_member');
    db.prepare('UPDATE team_members SET left_at = ? WHERE team_id = ? AND steamid = ? AND left_at IS NULL').run(now, team.id, o.steamid);
    return ok(settleCaptaincy(db, team.id, now));
  })();
}

export function kickMember(
  db: DB, o: { teamId: number; by: string; target: string; now?: Date },
): Result<{ disbanded: boolean; captain: string | null }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ disbanded: boolean; captain: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    const mine = roleOf(db, team.id, o.by);
    if (!isManager(mine)) return fail('not_manager');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return fail(o.target === o.by ? 'is_captain' : 'not_allowed');
    if (mine === 'cocaptain' && theirs !== 'member') return fail('not_allowed');
    db.prepare('UPDATE team_members SET left_at = ? WHERE team_id = ? AND steamid = ? AND left_at IS NULL').run(now, team.id, o.target);
    return ok(settleCaptaincy(db, team.id, now));
  })();
}

export function setRole(db: DB, o: { teamId: number; by: string; target: string; role: unknown }): Result<null> {
  if (o.role !== 'cocaptain' && o.role !== 'member') return fail('bad_role');
  const role = o.role;
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return fail('is_captain');
    db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND steamid = ? AND left_at IS NULL').run(role, team.id, o.target);
    return ok(null);
  })();
}

export function transferCaptain(db: DB, o: { teamId: number; by: string; target: string; staff?: boolean }): Result<null> {
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return ok(null);
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE team_id = ? AND role = 'captain' AND left_at IS NULL").run(team.id);
    db.prepare("UPDATE team_members SET role = 'captain' WHERE team_id = ? AND steamid = ? AND left_at IS NULL").run(team.id, o.target);
    db.prepare('UPDATE teams SET captain_steamid = ? WHERE id = ?').run(o.target, team.id);
    return ok(null);
  })();
}

export function renameTeam(
  db: DB, o: { teamId: number; by: string; staff?: boolean; name?: unknown; tag?: unknown },
): Result<{ name: string; tag: string }> {
  return db.transaction((): Result<{ name: string; tag: string }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    let name = team.name, nameKey = team.name_key, tag = team.tag, tagKey = team.tag_key;
    if (o.name !== undefined) {
      const n = normalizeName(o.name);
      if (!n.ok) return n;
      if (nameTaken(db, n.key, team.id)) return fail('name_taken');
      name = n.name; nameKey = n.key;
    }
    if (o.tag !== undefined) {
      const t = normalizeTag(o.tag);
      if (!t.ok) return t;
      if (tagTaken(db, t.key, team.id)) return fail('tag_taken');
      tag = t.tag; tagKey = t.key;
    }
    db.prepare('UPDATE teams SET name = ?, name_key = ?, tag = ?, tag_key = ? WHERE id = ?').run(name, nameKey, tag, tagKey, team.id);
    return ok({ name, tag });
  })();
}

export function disbandTeam(db: DB, o: { teamId: number; by: string; staff?: boolean; now?: Date }): Result<null> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    closeTeam(db, team.id, now);
    return ok(null);
  })();
}

export function setLogoKey(db: DB, o: { teamId: number; by: string; staff?: boolean; logoKey: string | null }): Result<null> {
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && !isManager(roleOf(db, team.id, o.by))) return fail('not_manager');
    db.prepare('UPDATE teams SET logo_key = ? WHERE id = ?').run(o.logoKey, team.id);
    return ok(null);
  })();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/teams.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/teams/teams.ts tests/teams.test.ts
git commit -m "Teams: leave with captain succession and auto-disband, kicks, roles, captaincy, rename, disband, logo key"
```

---

### Task 5: Team logos in the community store

**Files:**
- Modify: `src/community/store.ts` (`FileKind`, `FOLDER`, `EXT`; `putLogo`, `readLogo`)
- Modify: `src/community/validate.ts` (`LOGO_SIDE`, `LOGO_MAX_BYTES`, `checkLogo`)
- Modify: `src/community/sweep.ts` (refs and the loop include logos)
- Test: `tests/teamLogos.test.ts` (new), `tests/pngFixture.ts` (new; shared with Task 6)

**Interfaces:**
- Produces: `FileKind` gains `'logo'`; `CommunityStore.putLogo(bytes: Uint8Array): { name: string; wrote: boolean }`, `readLogo(sha: string): Buffer | null`; `checkLogo(bytes: Uint8Array): Checked<{ w: number; h: number }>`; `LOGO_SIDE = 256`, `LOGO_MAX_BYTES = 300 * 1024`.

- [ ] **Step 1: Write the failing tests**

Create `tests/pngFixture.ts` (a helper module, not a test file, so importing it runs no tests):

```ts
import { deflateSync } from 'node:zlib';

/** A real, minimal PNG of the given size (one grey row repeated). */
export function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 128)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
```

Create `tests/teamLogos.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { CommunityStore } from '../src/community/store.js';
import { checkLogo, LOGO_MAX_BYTES } from '../src/community/validate.js';
import { sweepCommunity, ORPHAN_GRACE_MS } from '../src/community/sweep.js';
import { png } from './pngFixture.js';

describe('checkLogo', () => {
  it('takes a 256 x 256 PNG and nothing else', () => {
    expect(checkLogo(png(256, 256))).toEqual({ ok: true, value: { w: 256, h: 256 } });
    expect(checkLogo(png(128, 128)).ok).toBe(false);
    expect(checkLogo(Buffer.from('GIF89a not a png')).ok).toBe(false);
    expect(checkLogo(Buffer.alloc(LOGO_MAX_BYTES + 1)).ok).toBe(false);
  });
});

describe('logo files', () => {
  it('are content addressed, read back, and survive the sweep only while a team uses them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logos-'));
    const store = new CommunityStore({ dir, maxBytes: () => 1e9, freeBytes: async () => 1e12 });
    const used = store.putLogo(png(256, 256));
    const spare = store.putLogo(png(256, 255).subarray(0)); // a different file, unreferenced
    expect(store.readLogo(used.name)?.length).toBeGreaterThan(0);

    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'a')").run();
    db.prepare(`INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, logo_key)
      VALUES ('Rats', 'rats', 'RR', 'RR', 'rats', '76561199000000001', '76561199000000001', ?)`).run(used.name);

    // Age both files past the grace period.
    const old = (Date.now() - ORPHAN_GRACE_MS - 60_000) / 1000;
    for (const f of store.list('logo')) utimesSync(f.file, old, old);
    sweepCommunity(db, store, new Date());
    expect(store.readLogo(used.name)).not.toBeNull();
    expect(store.readLogo(spare.name)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/teamLogos.test.ts`
Expected: FAIL, `checkLogo` / `putLogo` not defined.

- [ ] **Step 3: Implement**

`src/community/store.ts`:

```ts
export type FileKind = 'preview' | 'import' | 'logo';

const FOLDER: Record<FileKind, string> = { preview: 'previews', import: 'imports', logo: 'logos' };
const EXT: Record<FileKind, string> = { preview: '.png', import: '.vpk', logo: '.png' };
```

and next to `putPreview` / `readPreview`:

```ts
  /** A team logo (src/teams), content addressed like a preview. */
  putLogo(bytes: Uint8Array): { name: string; wrote: boolean } {
    const name = createHash('sha256').update(bytes).digest('hex');
    return { name, wrote: this.write('logo', name, bytes) };
  }

  readLogo(sha: string): Buffer | null { return this.read('logo', sha); }
```

Update the class doc comment's file list to name `logos/<sha256>.png`.

`src/community/validate.ts`, after `checkPreview`:

```ts
// ---- Team logo -------------------------------------------------------------

/** Team logos are square PNGs the page draws at up to 128 px; the browser
 *  resizes whatever the captain picks to exactly this before upload. */
export const LOGO_SIDE = 256;
export const LOGO_MAX_BYTES = 300 * 1024;

export function checkLogo(bytes: Uint8Array): Checked<{ w: number; h: number }> {
  if (bytes.length > LOGO_MAX_BYTES) return tooBig('The logo is over 300 KB.');
  const size = pngSize(bytes);
  if (!size) return bad('The logo is not a PNG.');
  if (size.w !== LOGO_SIDE || size.h !== LOGO_SIDE) return bad(`The logo must be ${LOGO_SIDE} x ${LOGO_SIDE}.`);
  return pass(size);
}
```

(`tooBig`, `bad`, `pass` are the file's existing helpers; check their names with `grep -n "^const \(bad\|pass\|tooBig\)\|function \(bad\|pass\|tooBig\)" src/community/validate.ts` and use those.)

`src/community/sweep.ts`: in `refs` add

```ts
    // A logo stays while any team, live or disbanded, points at it: a
    // disbanded team's page still shows its logo.
    logo: new Set((db.prepare('SELECT DISTINCT logo_key AS v FROM teams WHERE logo_key IS NOT NULL').all() as { v: string }[]).map((r) => r.v)),
```

in `justPurged` add `logo: new Set()`, and change the loop to `for (const kind of ['preview', 'import', 'logo'] as FileKind[])`. Update the function's doc comment: "then delete every file no unpurged row (or team) references".

- [ ] **Step 4: Run the tests and the community suites**

Run: `npx vitest run tests/teamLogos.test.ts tests/community*.test.ts`
Expected: PASS. (`ls tests | grep -i community` lists the community suites; run all of them.)

- [ ] **Step 5: Commit**

```bash
git add src/community tests/teamLogos.test.ts tests/pngFixture.ts
git commit -m "Team logos: a logo kind in the community store, 256 px PNG check, sweep keeps logos teams use"
```

---

### Task 6: HTTP routes, the invite DM and its Discord buttons

**Files:**
- Create: `src/routes/teams.ts`
- Create: `src/discord/teamButtons.ts`
- Modify: `src/server.ts` (register routes after `communityRoutes`, about line 1870; add the button prefix to `extraButtons`, about line 1714)
- Modify: `src/routes/auth.ts:128` (`/api/me` gains `teams`)
- Test: `tests/teamRoutes.test.ts` (new), `tests/teamButtons.test.ts` (new)

**Interfaces:**
- Consumes: everything in `src/teams/teams.ts` (Tasks 2-4), `competitiveAccess` (Task 1), `CommunityStore.putLogo/readLogo`, `checkLogo` (Task 5).
- Produces (HTTP, all JSON; every route answers 404 `{ error: 'not found' }` when `competitiveAccess(db, viewer)` is false):

| Method, path | Who | Body | Answer |
|---|---|---|---|
| GET `/api/teams` | anyone allowed | | `{ teams: TeamListItem[] }` |
| GET `/api/teams/mine` | active | | `{ teams: MyTeamItem[]; invites: InviteItem[]; canCreate: boolean }` |
| GET `/api/teams/player-search?q=` | active | | `{ players: { steamid, name, avatar }[] }` (q at least 2 chars, max 10, active players, name prefix, case-insensitive) |
| POST `/api/teams` | active | `{ name, tag }` | 201 `{ slug }` |
| GET `/api/teams/:slug` | anyone allowed | | `TeamView` |
| POST `/api/teams/:slug/invites` | manager | `{ steamid }` | 201 `{ inviteId }` |
| POST `/api/teams/invites/:id/accept` and `/decline` | the invitee | | `{ slug }` |
| POST `/api/teams/invites/:id/cancel` | manager | | `{}` |
| POST `/api/teams/:slug/join-link` | captain | `{ on: boolean }` | `{ token: string \| null }` |
| GET `/api/teams/join/:token` | active | | `{ slug, name, tag, logoKey }` |
| POST `/api/teams/join/:token` | active | | `{ slug }` |
| POST `/api/teams/:slug/leave` | member | | `{ disbanded, captain }` |
| POST `/api/teams/:slug/members/:steamid/kick` | manager | | `{ disbanded, captain }` |
| POST `/api/teams/:slug/members/:steamid/role` | captain | `{ role }` | `{}` |
| POST `/api/teams/:slug/captain` | captain or staff | `{ steamid }` | `{}` |
| POST `/api/teams/:slug/rename` | captain or staff | `{ name?, tag? }` | `{ name, tag }` |
| POST `/api/teams/:slug/disband` | captain or staff | | `{}` |
| POST `/api/teams/:slug/logo` | manager or staff | `{ png: base64 }` | `{ logoKey }` |
| GET `/api/teams/logos/:sha.png` | anyone allowed | | the PNG |

- Types (exported from `src/routes/teams.ts`, mirrored in `web/src/api.ts` in Task 7):

```ts
export interface TeamListItem { slug: string; name: string; tag: string; logoKey: string | null; members: number }
export interface MyTeamItem { slug: string; name: string; tag: string; logoKey: string | null; role: TeamRole }
export interface InviteItem { id: number; slug: string; name: string; tag: string; invitedByName: string | null; createdAt: string }
export interface TeamMemberView { steamid: string; name: string; avatar: string | null; role: TeamRole; joinedAt: string }
export interface TeamView {
  slug: string; name: string; tag: string; logoKey: string | null; createdAt: string; disbandedAt: string | null;
  captain: string; members: TeamMemberView[]; former: { steamid: string; name: string; leftAt: string }[];
  /** The viewer's place: their role, or null; staff is admin or mod. */
  viewer: { role: TeamRole | null; staff: boolean };
  /** Only for the captain, co-captains and staff. joinLinkToken only for the captain and staff. */
  manage: { invites: { id: number; steamid: string; name: string; createdAt: string }[]; joinLinkToken: string | null } | null;
}
```

- Discord: `TEAM_BUTTON_PREFIX = 'tm:'`; custom ids `tm:<inviteId>:a` (accept) and `tm:<inviteId>:d` (decline); `teamInviteDm(o: { inviteId: number; teamName: string; tag: string; invitedByName: string; url: string }): MessagePayload`; `handleTeamButton(deps: { db: DB; publicUrl: string }, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply>`.

- [ ] **Step 1: Write the failing route tests**

Create `tests/teamRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { png } from './pngFixture.js';

const P = Array.from({ length: 6 }, (_, i) => `7656119900000020${i}`);
const ADMIN = '76561199000000290';
const MOD = '76561199000000291';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'teamroutes-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [...P, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  P.forEach((id, i) => db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run(`player${i}`, id));
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: unknown) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, ...(payload === undefined ? {} : { payload }) });
const create = async (as: string, name: string, tag: string) => {
  const r = await call('POST', '/api/teams', as, { name, tag });
  expect(r.statusCode).toBe(201);
  return r.json().slug as string;
};

describe('the switch', () => {
  it('off hides every route, admins-only lets admins through', async () => {
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/teams', ADMIN)).statusCode).toBe(404);
    expect((await call('POST', '/api/teams', ADMIN, { name: 'Rats', tag: 'RR' })).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/teams', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/teams', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/teams')).statusCode).toBe(404);
  });

  it('/api/me says whether to show teams', async () => {
    expect((await call('GET', '/api/me', P[0])).json().teams).toBe(true);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/me', P[0])).json().teams).toBe(false);
  });
});

describe('create, invite, accept, page', () => {
  it('runs the whole flow and the page shows what each viewer may see', async () => {
    const slug = await create(P[0], 'Riverside Rats', 'RR');
    expect((await call('POST', '/api/teams', P[1], { name: 'riverside rats', tag: 'XX' })).statusCode).toBe(409);

    const inv = await call('POST', `/api/teams/${slug}/invites`, P[0], { steamid: P[1] });
    expect(inv.statusCode).toBe(201);
    const mine = (await call('GET', '/api/teams/mine', P[1])).json();
    expect(mine.invites).toMatchObject([{ slug, name: 'Riverside Rats', invitedByName: 'player0' }]);
    expect((await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[2])).statusCode).toBe(404);
    expect((await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[1])).json()).toEqual({ slug });

    const asCaptain = (await call('GET', `/api/teams/${slug}`, P[0])).json();
    expect(asCaptain.members.map((m: { steamid: string; role: string }) => [m.steamid, m.role])).toEqual([[P[0], 'captain'], [P[1], 'member']]);
    expect(asCaptain.viewer).toEqual({ role: 'captain', staff: false });
    expect(asCaptain.manage).toEqual({ invites: [], joinLinkToken: null });

    const asMember = (await call('GET', `/api/teams/${slug}`, P[1])).json();
    expect(asMember.manage).toBeNull();
    const asStranger = (await call('GET', `/api/teams/${slug}`, P[3])).json();
    expect(asStranger.viewer).toEqual({ role: null, staff: false });
    expect(asStranger.manage).toBeNull();
    expect((await call('GET', '/api/teams/no-such-team', P[3])).statusCode).toBe(404);

    expect((await call('GET', '/api/teams', P[3])).json().teams).toEqual([{ slug, name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 2 }]);
  });

  it('player search finds active players by name prefix, at least two characters', async () => {
    expect((await call('GET', '/api/teams/player-search?q=p', P[0])).json().players).toEqual([]);
    const found = (await call('GET', '/api/teams/player-search?q=PLAYER1', P[0])).json().players;
    expect(found.map((p: { steamid: string }) => p.steamid)).toEqual([P[1]]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    expect((await call('GET', '/api/teams/player-search?q=player1', P[0])).json().players).toEqual([]);
  });
});

describe('join link', () => {
  it('the captain sees the token, a co-captain does not, a player joins with it', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const tok = (await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: true })).json().token as string;
    expect((await call('GET', `/api/teams/join/${tok}`, P[2])).json()).toEqual({ slug, name: 'Rats', tag: 'RR', logoKey: null });
    expect((await call('POST', `/api/teams/join/${tok}`, P[2])).json()).toEqual({ slug });
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE steamid = ?").run(P[2]);
    expect((await call('GET', `/api/teams/${slug}`, P[2])).json().manage.joinLinkToken).toBeNull();
    expect((await call('GET', `/api/teams/${slug}`, P[0])).json().manage.joinLinkToken).toBe(tok);
    await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: false });
    expect((await call('GET', `/api/teams/join/${tok}`, P[3])).statusCode).toBe(404);
  });
});

describe('staff', () => {
  it('a mod renames and disbands a team they are not on, and both land in the audit log', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('POST', `/api/teams/${slug}/rename`, P[1], { name: 'Nope' })).statusCode).toBe(403);
    expect((await call('POST', `/api/teams/${slug}/rename`, MOD, { name: 'Clean Name' })).json()).toEqual({ name: 'Clean Name', tag: 'RR' });
    expect((await call('POST', `/api/teams/${slug}/disband`, MOD)).statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'team_%' ORDER BY id").all())
      .toEqual([{ admin_id: MOD, action: 'team_rename' }, { admin_id: MOD, action: 'team_disband' }]);
    expect((await call('GET', `/api/teams/${slug}`, P[3])).json().disbandedAt).not.toBeNull();
  });

  it('a captain renaming their own team is not audited', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    await call('POST', `/api/teams/${slug}/rename`, P[0], { tag: 'RT' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'team_%'").get()).toEqual({ n: 0 });
  });
});

describe('logo', () => {
  it('a captain uploads a 256 px PNG; it is served; anything else is refused', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const bad = await call('POST', `/api/teams/${slug}/logo`, P[0], { png: png(64, 64).toString('base64') });
    expect(bad.statusCode).toBe(400);
    const good = await call('POST', `/api/teams/${slug}/logo`, P[0], { png: png(256, 256).toString('base64') });
    expect(good.statusCode).toBe(200);
    const key = good.json().logoKey as string;
    expect((await call('GET', `/api/teams/${slug}`, P[3])).json().logoKey).toBe(key);
    const file = await call('GET', `/api/teams/logos/${key}.png`, P[3]);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await call('GET', `/api/teams/logos/${'b'.repeat(64)}.png`, P[3])).statusCode).toBe(404);
    expect((await call('POST', `/api/teams/${slug}/logo`, P[3], { png: png(256, 256).toString('base64') })).statusCode).toBe(403);
  });
});

describe('leave and kick over HTTP', () => {
  it('the captain leaving hands over; the last one out disbands', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const tok = (await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: true })).json().token as string;
    await call('POST', `/api/teams/join/${tok}`, P[1]);
    expect((await call('POST', `/api/teams/${slug}/leave`, P[0])).json()).toEqual({ disbanded: false, captain: P[1] });
    expect((await call('POST', `/api/teams/${slug}/members/${P[1]}/kick`, P[1])).statusCode).toBe(400);
    expect((await call('POST', `/api/teams/${slug}/leave`, P[1])).json()).toEqual({ disbanded: true, captain: null });
  });
});
```

If `loadConfig({})` has no `communityDir` field, find the config key the community routes use (`grep -n communityDir src/config.ts`) and set it the same way; if `GET /api/me` needs a field the test does not seed, look at `tests/auth*.test.ts` for how it is called.

- [ ] **Step 2: Write the failing button tests**

Create `tests/teamButtons.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { createTeam, invitePlayer, roleOf } from '../src/teams/teams.js';
import { handleTeamButton, teamInviteDm, TEAM_BUTTON_PREFIX } from '../src/discord/teamButtons.js';

const CAP = '76561199000000301';
const INV = '76561199000000302';
let db: DB;
let teamId: number;
let inviteId: number;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, 'cap', 'active', 'd-cap'), (?, 'inv', 'active', 'd-inv')").run(CAP, INV);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  const t = createTeam(db, { creator: CAP, name: 'Rats', tag: 'RR' });
  if (!t.ok) throw new Error(t.error);
  teamId = t.value.id;
  const i = invitePlayer(db, { teamId, by: CAP, target: INV });
  if (!i.ok) throw new Error(i.error);
  inviteId = i.value.inviteId;
});

const press = (userId: string, choice: 'a' | 'd') =>
  handleTeamButton({ db, publicUrl: 'https://example.test' }, { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${inviteId}:${choice}`, userId } as never);

describe('team invite DM', () => {
  it('carries Accept and Decline buttons for this invite and a link to the team', () => {
    const p = teamInviteDm({ inviteId, teamName: 'Rats', tag: 'RR', invitedByName: 'cap', url: 'https://example.test/team/rats' });
    const ids = p.components.flat().map((b) => ('customId' in b ? b.customId : b.url));
    expect(ids).toEqual([`tm:${inviteId}:a`, `tm:${inviteId}:d`, 'https://example.test/team/rats']);
  });
});

describe('handleTeamButton', () => {
  it('accepts for the linked invitee', async () => {
    const r = await press('d-inv', 'a');
    expect(r.payload.content).toMatch(/joined Rats/);
    expect(roleOf(db, teamId, INV)).toBe('member');
  });

  it('refuses a Discord user who is not the invitee, and leaves the invite open', async () => {
    const r = await press('d-cap', 'a');
    expect(r.payload.content).toMatch(/not for you|no longer open/i);
    expect(roleOf(db, teamId, INV)).toBeNull();
    expect((await press('d-inv', 'a')).payload.content).toMatch(/joined/);
  });

  it('refuses an unlinked Discord user and a closed switch', async () => {
    expect((await press('d-nobody', 'a')).payload.content).toMatch(/link/i);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await press('d-inv', 'a')).payload.content).toMatch(/not open/i);
  });

  it('declines', async () => {
    expect((await press('d-inv', 'd')).payload.content).toMatch(/declined/i);
    expect((await press('d-inv', 'a')).payload.content).toMatch(/no longer open/i);
  });
});
```

Check the `BotInteraction` button shape (`grep -n "kind: 'button'" -A8 src/discord/transport.ts`); if it has more required fields than `customId` and `userId`, fill them in the `press` helper instead of `as never`.

- [ ] **Step 3: Run both to see them fail**

Run: `npx vitest run tests/teamRoutes.test.ts tests/teamButtons.test.ts`
Expected: FAIL, modules not found / routes 404.

- [ ] **Step 4: Implement the Discord side**

Create `src/discord/teamButtons.ts`:

```ts
import type { DB } from '../db.js';
import type { BotInteraction, InteractionReply, MessagePayload } from './transport.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import { getInvite, getTeam, respondInvite, TEAM_ERRORS } from '../teams/teams.js';

/** Custom ids: tm:<inviteId>:a (accept), tm:<inviteId>:d (decline). */
export const TEAM_BUTTON_PREFIX = 'tm:';

export function teamInviteDm(o: { inviteId: number; teamName: string; tag: string; invitedByName: string; url: string }): MessagePayload {
  return {
    content: `${o.invitedByName} invited you to join **[${o.tag}] ${o.teamName}**.`,
    embeds: [],
    components: [[
      { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${o.inviteId}:a`, label: 'Accept', style: 'success' },
      { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${o.inviteId}:d`, label: 'Decline', style: 'secondary' },
      { kind: 'link', url: o.url, label: 'Team page' },
    ]],
  };
}

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });

/**
 * The invite DM's buttons. The Discord id alone authorises nothing: it is
 * resolved to the LINKED player, and respondInvite checks that player against
 * the invite like the website's route does, so a forwarded DM does nothing.
 */
export async function handleTeamButton(
  deps: { db: DB; publicUrl: string }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, rawId, choice] = i.customId.split(':');
  const inviteId = Number(rawId);
  if (!Number.isInteger(inviteId) || (choice !== 'a' && choice !== 'd')) return say('That button no longer does anything.');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) {
    return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  }
  if (!competitiveAccess(deps.db, player.steamid)) return say('Teams are not open yet.');
  const inv = getInvite(deps.db, inviteId);
  if (inv && inv.steamid !== player.steamid) return say('That invite is not for you.');
  const r = respondInvite(deps.db, { inviteId, steamid: player.steamid, accept: choice === 'a' });
  if (!r.ok) return say(TEAM_ERRORS[r.error].text);
  const team = getTeam(deps.db, r.value.teamId);
  return choice === 'a'
    ? say(`You joined ${team?.name ?? 'the team'}: ${deps.publicUrl}/team/${r.value.slug}`)
    : say(`You declined the invite to ${team?.name ?? 'the team'}.`);
}
```

- [ ] **Step 5: Implement the routes**

Create `src/routes/teams.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { logAdmin } from '../admin/audit.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { competitiveAccess } from '../teams/access.js';
import * as T from '../teams/teams.js';
import { checkLogo, LOGO_MAX_BYTES } from '../community/validate.js';
import type { CommunityStore } from '../community/store.js';
import type { DmFn } from '../signonDropNotify.js';
import { teamInviteDm } from '../discord/teamButtons.js';

export interface TeamListItem { slug: string; name: string; tag: string; logoKey: string | null; members: number }
export interface MyTeamItem { slug: string; name: string; tag: string; logoKey: string | null; role: T.TeamRole }
export interface InviteItem { id: number; slug: string; name: string; tag: string; invitedByName: string | null; createdAt: string }
export interface TeamMemberView { steamid: string; name: string; avatar: string | null; role: T.TeamRole; joinedAt: string }
export interface TeamView {
  slug: string; name: string; tag: string; logoKey: string | null; createdAt: string; disbandedAt: string | null;
  captain: string; members: TeamMemberView[]; former: { steamid: string; name: string; leftAt: string }[];
  viewer: { role: T.TeamRole | null; staff: boolean };
  manage: { invites: { id: number; steamid: string; name: string; createdAt: string }[]; joinLinkToken: string | null } | null;
}

export interface TeamRoutesOpts {
  db: DB;
  store: () => CommunityStore;
  publicUrl: string;
  /** Null while the bot is not connected: invites are then site-only. */
  dm?: () => DmFn | null;
}

const NOT_FOUND = { error: 'not found' };
const SHA_PNG = /^([0-9a-f]{64})\.png$/;

export async function teamRoutes(app: FastifyInstance, opts: TeamRoutesOpts): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const isStaff = (steamid: string | null): boolean => {
    if (!steamid) return false;
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const nameOf = (steamid: string): string => getPlayer(db, steamid)?.name ?? steamid;

  /** The switch, for routes anyone may read: 404 to whoever it keeps out. */
  const allowedViewer = (req: FastifyRequest, reply: FastifyReply): { viewer: string | null } | null => {
    const viewer = optionalViewer(req);
    if (!competitiveAccess(db, viewer)) { reply.code(404).send(NOT_FOUND); return null; }
    return { viewer };
  };
  /** An active player the switch lets in, or the reply sent. A closed switch
   *  answers 404 before the login check, so nothing says the routes exist. */
  const allowedActive = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const refuse = (reply: FastifyReply, error: T.TeamError) =>
    reply.code(T.TEAM_ERRORS[error].status).send({ error: T.TEAM_ERRORS[error].text });
  const teamOf = (req: FastifyRequest): T.TeamRow | undefined =>
    T.getTeamBySlug(db, (req.params as { slug: string }).slug);
  /** Staff acting on a team where they are not the captain: audited. */
  const audit = (by: string, team: T.TeamRow, action: string, detail: object) => {
    if (T.roleOf(db, team.id, by) !== 'captain') logAdmin(db, by, action, team.id, { slug: team.slug, ...detail });
  };

  app.get('/api/teams', async (req, reply) => {
    if (!allowedViewer(req, reply)) return;
    const teams: TeamListItem[] = T.liveTeams(db).map((t) => ({
      slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, members: T.rosterSize(db, t.id),
    }));
    return { teams };
  });

  app.get('/api/teams/mine', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const teams: MyTeamItem[] = T.myTeams(db, me).map((t) => ({ slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, role: t.role }));
    const invites: InviteItem[] = T.pendingInvitesFor(db, me).map((i) => ({
      id: i.id, slug: i.slug, name: i.name, tag: i.tag, invitedByName: getPlayer(db, i.invited_by)?.name ?? null, createdAt: i.created_at,
    }));
    return { teams, invites, canCreate: T.canCreate(db, me) };
  });

  app.get('/api/teams/player-search', async (req, reply) => {
    if (!allowedActive(req, reply)) return;
    const q = String((req.query as { q?: unknown }).q ?? '').trim();
    if (q.length < 2) return { players: [] };
    const rows = db.prepare(
      `SELECT steamid, name, avatar FROM players WHERE status = 'active' AND lower(name) LIKE ? ESCAPE '\\' ORDER BY lower(name) LIMIT 10`,
    ).all(`${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { steamid: string; name: string; avatar: string | null }[];
    return { players: rows };
  });

  app.post('/api/teams', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const { name, tag } = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = T.createTeam(db, { creator: me, name, tag });
    if (!r.ok) return refuse(reply, r.error);
    return reply.code(201).send({ slug: r.value.slug });
  });

  app.get('/api/teams/join/:token', async (req, reply) => {
    if (!allowedActive(req, reply)) return;
    const t = T.teamByJoinToken(db, (req.params as { token: string }).token);
    if (!t) return refuse(reply, 'link_off');
    return { slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key };
  });

  app.post('/api/teams/join/:token', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const r = T.joinByLink(db, { token: (req.params as { token: string }).token, steamid: me });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.get('/api/teams/logos/:file', async (req, reply) => {
    if (!allowedViewer(req, reply)) return;
    const m = SHA_PNG.exec((req.params as { file: string }).file);
    if (!m || !db.prepare('SELECT 1 FROM teams WHERE logo_key = ?').get(m[1])) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readLogo(m[1]!);
    if (!bytes) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type('image/png').send(bytes);
  });

  for (const action of ['accept', 'decline', 'cancel'] as const) {
    app.post(`/api/teams/invites/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const inviteId = Number((req.params as { id: string }).id);
      if (!Number.isInteger(inviteId)) return refuse(reply, 'not_found');
      if (action === 'cancel') {
        const r = T.cancelInvite(db, { inviteId, by: me });
        if (!r.ok) return refuse(reply, r.error);
        return {};
      }
      const r = T.respondInvite(db, { inviteId, steamid: me, accept: action === 'accept' });
      if (!r.ok) return refuse(reply, r.error);
      return { slug: r.value.slug };
    });
  }

  app.get('/api/teams/:slug', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const role = v.viewer ? T.roleOf(db, t.id, v.viewer) : null;
    const staff = isStaff(v.viewer);
    const manager = staff || role === 'captain' || role === 'cocaptain';
    const view: TeamView = {
      slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, createdAt: t.created_at, disbandedAt: t.disbanded_at,
      captain: t.captain_steamid,
      members: T.activeMembers(db, t.id).map((m) => {
        const p = getPlayer(db, m.steamid);
        return { steamid: m.steamid, name: p?.name ?? m.steamid, avatar: p?.avatar ?? null, role: m.role, joinedAt: m.joined_at };
      }),
      former: T.formerMembers(db, t.id).map((f) => ({ steamid: f.steamid, name: nameOf(f.steamid), leftAt: f.left_at })),
      viewer: { role, staff },
      manage: manager && !t.disbanded_at
        ? {
            invites: T.openInvitesOf(db, t.id).map((i) => ({ id: i.id, steamid: i.steamid, name: nameOf(i.steamid), createdAt: i.created_at })),
            joinLinkToken: staff || role === 'captain' ? t.join_link_token : null,
          }
        : null,
    };
    return view;
  });

  app.post('/api/teams/:slug/invites', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const target = String(((req.body ?? {}) as { steamid?: unknown }).steamid ?? '');
    const r = T.invitePlayer(db, { teamId: t.id, by: me, target });
    if (!r.ok) return refuse(reply, r.error);
    const discordId = getPlayer(db, target)?.discord_id;
    const dm = opts.dm?.();
    if (discordId && dm) {
      void dm(discordId, teamInviteDm({
        inviteId: r.value.inviteId, teamName: t.name, tag: t.tag, invitedByName: nameOf(me), url: `${opts.publicUrl}/team/${t.slug}`,
      })).catch((err) => console.warn(`[teams] could not DM ${target} about invite ${r.value.inviteId}:`, err instanceof Error ? err.message : err));
    }
    return reply.code(201).send({ inviteId: r.value.inviteId });
  });

  app.post('/api/teams/:slug/join-link', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.setJoinLink(db, { teamId: t.id, by: me, on: ((req.body ?? {}) as { on?: unknown }).on === true });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/leave', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.leaveTeam(db, { teamId: t.id, steamid: me });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/members/:steamid/kick', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.kickMember(db, { teamId: t.id, by: me, target: (req.params as { steamid: string }).steamid });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/members/:steamid/role', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.setRole(db, { teamId: t.id, by: me, target: (req.params as { steamid: string }).steamid, role: ((req.body ?? {}) as { role?: unknown }).role });
    if (!r.ok) return refuse(reply, r.error);
    return {};
  });

  app.post('/api/teams/:slug/captain', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const target = String(((req.body ?? {}) as { steamid?: unknown }).steamid ?? '');
    const r = T.transferCaptain(db, { teamId: t.id, by: me, target, staff: isStaff(me) });
    if (!r.ok) return refuse(reply, r.error);
    audit(me, t, 'team_captain', { to: target });
    return {};
  });

  app.post('/api/teams/:slug/rename', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const { name, tag } = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = T.renameTeam(db, { teamId: t.id, by: me, staff: isStaff(me), name, tag });
    if (!r.ok) return refuse(reply, r.error);
    audit(me, t, 'team_rename', { from: { name: t.name, tag: t.tag }, to: r.value });
    return r.value;
  });

  app.post('/api/teams/:slug/disband', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    // Audit before the write: after it nobody is captain, so audit() would
    // log a captain disbanding their own team as a staff action.
    const ownTeam = T.roleOf(db, t.id, me) === 'captain';
    const r = T.disbandTeam(db, { teamId: t.id, by: me, staff: isStaff(me) });
    if (!r.ok) return refuse(reply, r.error);
    if (!ownTeam) logAdmin(db, me, 'team_disband', t.id, { slug: t.slug, name: t.name });
    return {};
  });

  app.post('/api/teams/:slug/logo', { bodyLimit: Math.ceil(LOGO_MAX_BYTES * 1.4) + 1024 }, async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const staff = isStaff(me);
    const role = T.roleOf(db, t.id, me);
    if (!staff && role !== 'captain' && role !== 'cocaptain') return refuse(reply, 'not_manager');
    const raw = ((req.body ?? {}) as { png?: unknown }).png;
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'The logo is missing.' });
    const bytes = Buffer.from(raw, 'base64');
    const checked = checkLogo(bytes);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const store = opts.store();
    if (!(await store.canTake(bytes.length))) return reply.code(507).send({ error: 'The community shelf is full right now.' });
    const { name } = store.putLogo(bytes);
    const r = T.setLogoKey(db, { teamId: t.id, by: me, staff, logoKey: name });
    if (!r.ok) return refuse(reply, r.error);
    audit(me, t, 'team_logo', { logoKey: name });
    return { logoKey: name };
  });
}
```

Check `store.canTake`'s signature at `src/community/store.ts:142` and use it as written there.

- [ ] **Step 6: Wire into the server and `/api/me`**

In `src/server.ts`: import `teamRoutes` from `./routes/teams.js` and `handleTeamButton, TEAM_BUTTON_PREFIX` from `./discord/teamButtons.js`. Add to the `extraButtons` object (about line 1714):

```ts
        [TEAM_BUTTON_PREFIX]: (i) => handleTeamButton({ db: deps.db, publicUrl: deps.config.publicUrl }, i),
```

Directly after `await app.register(communityRoutes, ...)` (about line 1870):

```ts
  await app.register(teamRoutes, {
    db: deps.db, store: getCommunityStore, publicUrl: deps.config.publicUrl,
    // Read per invite: the bot logs in some seconds after this runs.
    dm: () => { const transport = bot?.transport; return transport ? (userId, payload) => transport.dm(userId, payload) : null; },
  });
```

`bot` is the variable the `SignonDropNotifier` wiring reads (`grep -n "let bot\b\|let bot:" src/server.ts`); if it is declared after line 1870, move this registration below the declaration, or read it through the same closure pattern that file already uses.

In `src/routes/auth.ts`, in the `/api/me` reply object next to `isCaster: player.is_caster === 1,` add:

```ts
      // Whether to show Teams in the nav: the competitive switch, read per request.
      teams: competitiveAccess(db, inGoodStanding(db, player.steamid) ? player.steamid : null),
```

with `import { competitiveAccess } from '../teams/access.js';` (and `inGoodStanding` from `../standing.js` if the file does not import it already; use whatever name the file's `db` handle has).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/teamRoutes.test.ts tests/teamButtons.test.ts tests/teams.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 8: Commit**

```bash
git add src/routes/teams.ts src/discord/teamButtons.ts src/server.ts src/routes/auth.ts tests/teamRoutes.test.ts tests/teamButtons.test.ts
git commit -m "Teams over HTTP: create, invite (with a Discord DM), join link, roster actions, staff rename and disband audited, logo upload"
```

---

### Task 7: Web: API client, Teams page, join page, nav link

**Files:**
- Modify: `web/src/api.ts` (types + `teamsApi`; `Me` gains `teams?: boolean`)
- Create: `web/src/routes/Teams.tsx`, `web/src/routes/TeamJoin.tsx`
- Modify: `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx`
- Test: `web/src/routes/Teams.test.tsx` (new)

**Interfaces:**
- Consumes: the HTTP table and types in Task 6.
- Produces: `teamsApi` (below), `logoUrl(key: string): string`; routes `/teams`, `/team/join/:token`.

- [ ] **Step 1: Write the failing test**

Create `web/src/routes/Teams.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockTeams } = vi.hoisted(() => ({
  mockTeams: { list: vi.fn(), mine: vi.fn(), create: vi.fn(), accept: vi.fn(), decline: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});

const { ApiError } = await import('../api');
const { Teams } = await import('./Teams');

afterEach(() => { cleanup(); for (const f of Object.values(mockTeams)) f.mockReset(); });

const signedIn = { kind: 'active', me: { steamid: '1', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

describe('Teams', () => {
  it('lists every team and the viewer\'s own teams and invites', async () => {
    mockTeams.list.mockResolvedValue({ teams: [{ slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 5 }] });
    mockTeams.mine.mockResolvedValue({
      teams: [{ slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null, role: 'captain' }],
      invites: [{ id: 7, slug: 'rats', name: 'Riverside Rats', tag: 'RR', invitedByName: 'cap', createdAt: '2026-10-01T00:00:00.000Z' }],
      canCreate: true,
    });
    render(<Teams session={signedIn} />);
    expect(await screen.findByText('Riverside Rats', { selector: '.teamcard__name' })).toBeTruthy();
    expect(screen.getByText(/5 players/)).toBeTruthy();
    expect(screen.getByText(/cap invited you/)).toBeTruthy();
    expect(screen.getByText('Mice', { selector: '.teamcard__name' })).toBeTruthy();
  });

  it('accepting an invite reloads the lists', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [{ id: 7, slug: 'rats', name: 'Rats', tag: 'RR', invitedByName: 'cap', createdAt: '' }], canCreate: true });
    mockTeams.accept.mockResolvedValue({ slug: 'rats' });
    render(<Teams session={signedIn} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(mockTeams.accept).toHaveBeenCalledWith(7));
    await waitFor(() => expect(mockTeams.mine).toHaveBeenCalledTimes(2));
  });

  it('creating a team shows the server\'s refusal, and goes to the page on success', async () => {
    mockTeams.list.mockResolvedValue({ teams: [] });
    mockTeams.mine.mockResolvedValue({ teams: [], invites: [], canCreate: true });
    mockTeams.create.mockRejectedValueOnce(new ApiError(409, 'Another team already has that name.'));
    render(<Teams session={signedIn} />);
    fireEvent.input(await screen.findByLabelText('Team name'), { target: { value: 'Rats' } });
    fireEvent.input(screen.getByLabelText('Tag'), { target: { value: 'RR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByText('Another team already has that name.')).toBeTruthy();
  });

  it('shows nothing but a not-found line when the switch is closed', async () => {
    mockTeams.list.mockRejectedValue(new ApiError(404, 'not found'));
    mockTeams.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Teams session={signedIn} />);
    expect(await screen.findByText(/not open yet/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run web/src/routes/Teams.test.tsx`
Expected: FAIL, `./Teams` not found.

- [ ] **Step 3: API client**

In `web/src/api.ts`, add `teams?: boolean;` to `Me` (with a doc comment: "Show Teams: the competitive switch lets this viewer in."), and near `castApi`:

```ts
// ---------- teams ----------

export type TeamRole = 'captain' | 'cocaptain' | 'member';
export interface TeamListItem { slug: string; name: string; tag: string; logoKey: string | null; members: number }
export interface MyTeamItem { slug: string; name: string; tag: string; logoKey: string | null; role: TeamRole }
export interface TeamInviteItem { id: number; slug: string; name: string; tag: string; invitedByName: string | null; createdAt: string }
export interface TeamMemberView { steamid: string; name: string; avatar: string | null; role: TeamRole; joinedAt: string }
export interface TeamView {
  slug: string; name: string; tag: string; logoKey: string | null; createdAt: string; disbandedAt: string | null;
  captain: string; members: TeamMemberView[]; former: { steamid: string; name: string; leftAt: string }[];
  viewer: { role: TeamRole | null; staff: boolean };
  manage: { invites: { id: number; steamid: string; name: string; createdAt: string }[]; joinLinkToken: string | null } | null;
}

export const logoUrl = (key: string): string => `/api/teams/logos/${key}.png`;

const enc = encodeURIComponent;
export const teamsApi = {
  list: (signal?: AbortSignal) => get<{ teams: TeamListItem[] }>('/api/teams', signal),
  mine: (signal?: AbortSignal) => get<{ teams: MyTeamItem[]; invites: TeamInviteItem[]; canCreate: boolean }>('/api/teams/mine', signal),
  get: (slug: string, signal?: AbortSignal) => get<TeamView>(`/api/teams/${enc(slug)}`, signal),
  search: (q: string, signal?: AbortSignal) =>
    get<{ players: { steamid: string; name: string; avatar: string | null }[] }>(`/api/teams/player-search?q=${enc(q)}`, signal),
  create: (name: string, tag: string) => post<{ slug: string }>('/api/teams', { name, tag }),
  invite: (slug: string, steamid: string) => post<{ inviteId: number }>(`/api/teams/${enc(slug)}/invites`, { steamid }),
  accept: (id: number) => post<{ slug: string }>(`/api/teams/invites/${id}/accept`),
  decline: (id: number) => post<{ slug: string }>(`/api/teams/invites/${id}/decline`),
  cancelInvite: (id: number) => post(`/api/teams/invites/${id}/cancel`),
  joinLink: (slug: string, on: boolean) => post<{ token: string | null }>(`/api/teams/${enc(slug)}/join-link`, { on }),
  joinInfo: (token: string, signal?: AbortSignal) =>
    get<{ slug: string; name: string; tag: string; logoKey: string | null }>(`/api/teams/join/${enc(token)}`, signal),
  join: (token: string) => post<{ slug: string }>(`/api/teams/join/${enc(token)}`),
  leave: (slug: string) => post<{ disbanded: boolean; captain: string | null }>(`/api/teams/${enc(slug)}/leave`),
  kick: (slug: string, steamid: string) => post(`/api/teams/${enc(slug)}/members/${enc(steamid)}/kick`),
  setRole: (slug: string, steamid: string, role: 'cocaptain' | 'member') => post(`/api/teams/${enc(slug)}/members/${enc(steamid)}/role`, { role }),
  makeCaptain: (slug: string, steamid: string) => post(`/api/teams/${enc(slug)}/captain`, { steamid }),
  rename: (slug: string, body: { name?: string; tag?: string }) => post<{ name: string; tag: string }>(`/api/teams/${enc(slug)}/rename`, body),
  disband: (slug: string) => post(`/api/teams/${enc(slug)}/disband`),
  logo: (slug: string, png: string) => post<{ logoKey: string }>(`/api/teams/${enc(slug)}/logo`, { png }),
};
```

- [ ] **Step 4: Teams page**

Create `web/src/routes/Teams.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type MyTeamItem, type TeamInviteItem, type TeamListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';

export function TeamBadge({ tag, logoKey }: { tag: string; logoKey: string | null }) {
  return logoKey
    ? <img class="teambadge" src={logoUrl(logoKey)} alt="" width={40} height={40} />
    : <span class="teambadge teambadge--tag" aria-hidden="true">{tag}</span>;
}

function TeamCard({ slug, name, tag, logoKey, line }: { slug: string; name: string; tag: string; logoKey: string | null; line: string }) {
  return (
    <a class="teamcard" href={`/team/${slug}`}>
      <TeamBadge tag={tag} logoKey={logoKey} />
      <span class="teamcard__name">{name}</span>
      <span class="teamcard__line">[{tag}] · {line}</span>
    </a>
  );
}

const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;

export function Teams({ session }: { session: Session }) {
  const { route } = useLocation();
  const signedIn = session.kind === 'active';
  const [all, setAll] = useState<TeamListItem[] | null>(null);
  const [mine, setMine] = useState<{ teams: MyTeamItem[]; invites: TeamInviteItem[]; canCreate: boolean } | null>(null);
  const [closed, setClosed] = useState(false);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    teamsApi.list().then((r) => setAll(r.teams), (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
    if (signedIn) teamsApi.mine().then(setMine, () => {});
  };
  useEffect(load, [signedIn]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const create = async (ev: Event) => {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { slug } = await teamsApi.create(name, tag);
      route(`/team/${slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (closed) return <main class="page"><PageHeader title="Teams" /><Empty>Teams are not open yet.</Empty></main>;

  return (
    <main class="page">
      <PageHeader title="Teams" />
      {error && <p class="form-error" role="alert">{error}</p>}
      {mine && mine.invites.length > 0 && (
        <Panel title="Invites">
          <ul class="teaminvites">
            {mine.invites.map((i) => (
              <li key={i.id}>
                <span>{i.invitedByName ?? 'Someone'} invited you to <a href={`/team/${i.slug}`}>[{i.tag}] {i.name}</a></span>
                <button class="btn btn--primary" disabled={busy} onClick={() => act(() => teamsApi.accept(i.id))}>Accept</button>
                <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.decline(i.id))}>Decline</button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {mine && mine.teams.length > 0 && (
        <Panel title="Your teams">
          <div class="teamgrid">
            {mine.teams.map((t) => <TeamCard key={t.slug} {...t} line={ROLE_LABEL[t.role]} />)}
          </div>
        </Panel>
      )}
      {mine?.canCreate && (
        <Panel title="Start a team">
          <form class="teamform" onSubmit={create}>
            <label>Team name<input value={name} maxLength={24} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>Tag<input value={tag} maxLength={5} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
            <button class="btn btn--primary" type="submit" disabled={busy}>Create team</button>
          </form>
        </Panel>
      )}
      <Panel title="All teams">
        {all === null ? null : all.length === 0
          ? <Empty>No teams yet.</Empty>
          : <div class="teamgrid">{all.map((t) => <TeamCard key={t.slug} {...t} line={`${t.members} players`} />)}</div>}
      </Panel>
    </main>
  );
}
```

Check `Panel`'s props (`grep -n "export function Panel" -A6 web/src/components/bits.tsx`) and `PageHeader`'s; if `Panel` takes its heading differently (a child `<h2>`, a `heading` prop), use that. The `<label>` text must stay "Team name" and "Tag" because the test finds the inputs by label.

- [ ] **Step 5: Join page, routes, nav**

Create `web/src/routes/TeamJoin.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { teamsApi } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { TeamBadge } from './Teams';

export function TeamJoin({ token }: { token: string }) {
  const { route } = useLocation();
  const [team, setTeam] = useState<{ slug: string; name: string; tag: string; logoKey: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    teamsApi.joinInfo(token).then(setTeam, () => setError('That join link is turned off or was replaced.'));
  }, [token]);
  const join = async () => {
    setError(null);
    try { route(`/team/${(await teamsApi.join(token)).slug}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <main class="page">
      <PageHeader title="Join a team" />
      {error && <p class="form-error" role="alert">{error}</p>}
      {team
        ? <Panel><div class="teamjoin"><TeamBadge tag={team.tag} logoKey={team.logoKey} /><span>[{team.tag}] {team.name}</span><button class="btn btn--primary" onClick={join}>Join {team.name}</button></div></Panel>
        : !error && <Empty>Loading...</Empty>}
    </main>
  );
}
```

In `web/src/AppRoutes.tsx`, lazy-load the pages like `Community` (`const Teams = lazy(() => import('./routes/Teams').then((m) => ({ default: m.Teams })))`; copy the exact lazy form the file uses for a named export) and add, before the `default` route:

```tsx
      <Route path="/teams" component={Teams} session={session} />
      <Route path="/team/join/:token" component={TeamJoin} />
      <Route path="/team/:slug" component={Team} session={session} refresh={refresh} />
```

(`Team` comes from Task 8; until then point `/team/:slug` at nothing by leaving that line out, and add it in Task 8.)

In `web/src/components/Nav.tsx`, where `NAV_LINKS` is mapped to links, map `links` instead:

```ts
  // Teams only for viewers the competitive switch lets in (/api/me teams).
  const links = me?.teams ? [...NAV_LINKS.slice(0, 5), ['/teams', 'Teams'] as const, ...NAV_LINKS.slice(5)] : NAV_LINKS;
```

and in `isCurrent` add `if (href === '/teams') return path === '/teams' || path.startsWith('/team/');`.

Add styles to `web/src/styles/app.css` for `.teamgrid` (auto-fill grid of 220 px cards), `.teamcard` (badge, name, line), `.teambadge` (40 px square, rounded, the tag in a bordered box when there is no logo), `.teaminvites li` (row with the two buttons at the end), `.teamform` (inline name, tag, button; wraps on a phone), `.teamjoin` (centered row). Reuse the colour tokens the file already defines for panels and buttons; no new colours.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run web/src/routes/Teams.test.tsx web/src/appRoutes.test.tsx web/src/routes/routes.test.tsx`
Expected: PASS. If a route-list test enumerates every route path, add the three new ones to it.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "Teams on the site: teams list with invites and create form, join-link page, nav link behind the switch"
```

---

### Task 8: Web: the team page

**Files:**
- Create: `web/src/routes/Team.tsx`, `web/src/teamLogo.ts`
- Modify: `web/src/AppRoutes.tsx` (the `/team/:slug` route)
- Test: `web/src/routes/Team.test.tsx` (new)

**Interfaces:**
- Consumes: `teamsApi`, `TeamView`, `logoUrl`, `TeamBadge` (Task 7).
- Produces: `toLogoPng(file: File): Promise<string>` (base64 PNG, 256 x 256, centre-cropped) in `web/src/teamLogo.ts`.

- [ ] **Step 1: Write the failing test**

Create `web/src/routes/Team.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { TeamView } from '../api';

const { mockTeams } = vi.hoisted(() => ({
  mockTeams: {
    get: vi.fn(), search: vi.fn(), invite: vi.fn(), cancelInvite: vi.fn(), joinLink: vi.fn(), leave: vi.fn(),
    kick: vi.fn(), setRole: vi.fn(), makeCaptain: vi.fn(), rename: vi.fn(), disband: vi.fn(), logo: vi.fn(),
  },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, teamsApi: mockTeams };
});
vi.mock('../teamLogo', () => ({ toLogoPng: vi.fn(async () => 'BASE64') }));

const { Team } = await import('./Team');
afterEach(() => { cleanup(); for (const f of Object.values(mockTeams)) f.mockReset(); });

const view = (over: Partial<TeamView> = {}): TeamView => ({
  slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: null, createdAt: '2026-10-01T00:00:00.000Z', disbandedAt: null,
  captain: '1',
  members: [
    { steamid: '1', name: 'cap', avatar: null, role: 'captain', joinedAt: '2026-10-01T00:00:00.000Z' },
    { steamid: '2', name: 'bob', avatar: null, role: 'member', joinedAt: '2026-10-02T00:00:00.000Z' },
  ],
  former: [{ steamid: '3', name: 'old', leftAt: '2026-10-03T00:00:00.000Z' }],
  viewer: { role: null, staff: false },
  manage: null,
  ...over,
});
const session = (steamid: string) => ({ kind: 'active', me: { steamid, name: 'x', avatar: null, status: 'active', isAdmin: false, teams: true } }) as never;

describe('Team', () => {
  it('shows the roster and former players to anyone, with no controls', async () => {
    mockTeams.get.mockResolvedValue(view());
    render(<Team slug="rats" session={session('9')} />);
    expect(await screen.findByText('Riverside Rats')).toBeTruthy();
    expect(screen.getByText('cap')).toBeTruthy();
    expect(screen.getByText('Captain')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave team' })).toBeNull();
  });

  it('gives the captain invite, roles, kick, captaincy, join link, logo, rename, disband', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    render(<Team slug="rats" session={session('1')} />);
    await screen.findByText('Riverside Rats');
    for (const name of ['Invite', 'Make co-captain', 'Kick', 'Make captain', 'Turn on join link', 'Rename', 'Disband team']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByLabelText('Logo')).toBeTruthy();
  });

  it('searches players and invites one', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.search.mockResolvedValue({ players: [{ steamid: '5', name: 'newguy', avatar: null }] });
    mockTeams.invite.mockResolvedValue({ inviteId: 1 });
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.input(await screen.findByLabelText('Find a player'), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite newguy' }));
    await waitFor(() => expect(mockTeams.invite).toHaveBeenCalledWith('rats', '5'));
  });

  it('disband needs a second press', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'captain', staff: false }, manage: { invites: [], joinLinkToken: null } }));
    mockTeams.disband.mockResolvedValue({});
    render(<Team slug="rats" session={session('1')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disband team' }));
    expect(mockTeams.disband).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disband Riverside Rats' }));
    await waitFor(() => expect(mockTeams.disband).toHaveBeenCalledWith('rats'));
  });

  it('a member can leave; a disbanded team says so and offers nothing', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByRole('button', { name: 'Leave team' })).toBeTruthy();
    cleanup();
    mockTeams.get.mockResolvedValue(view({ disbandedAt: '2026-10-04T00:00:00.000Z', members: [], viewer: { role: null, staff: true } }));
    render(<Team slug="rats" session={session('9')} />);
    expect(await screen.findByText(/Disbanded/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run web/src/routes/Team.test.tsx`
Expected: FAIL, `./Team` not found.

- [ ] **Step 3: Logo helper**

Create `web/src/teamLogo.ts`:

```ts
/** The server takes exactly 256 x 256 PNG logos (src/community/validate.ts),
 *  so whatever the captain picks is centre-cropped to a square and scaled
 *  here first. Returns the PNG as base64, without the data: prefix. */
export async function toLogoPng(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  bmp.close();
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
```

- [ ] **Step 4: Team page**

Create `web/src/routes/Team.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type TeamView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { toLogoPng } from '../teamLogo';

const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : '');

export function Team({ slug, session }: { slug: string; session: Session; refresh?: () => void }) {
  const { route } = useLocation();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [confirmDisband, setConfirmDisband] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const me = session.kind === 'active' ? session.me.steamid : null;

  const load = () => teamsApi.get(slug).then(setTeam, (e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); });
  useEffect(() => { void load(); }, [slug]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try { await fn(); after?.(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (missing) return <main class="page"><PageHeader title="Team" /><Empty>No such team, or teams are not open yet.</Empty></main>;
  if (!team) return <main class="page"><PageHeader title="Team" /></main>;

  const live = team.disbandedAt === null;
  const role = team.viewer.role;
  const captain = live && (role === 'captain' || team.viewer.staff);
  const manager = live && team.manage !== null;
  const joinUrl = team.manage?.joinLinkToken ? `${location.origin}/team/join/${team.manage.joinLinkToken}` : null;

  return (
    <main class="page">
      <div class="teamhead">
        {team.logoKey ? <img class="teamhead__logo" src={logoUrl(team.logoKey)} alt="" width={96} height={96} />
          : <span class="teamhead__logo teambadge--tag">{team.tag}</span>}
        <div>
          <h1 class="teamhead__name">{team.name}</h1>
          <p class="teamhead__line">[{team.tag}] · since {day(team.createdAt)}{!live && ` · Disbanded ${day(team.disbandedAt!)}`}</p>
        </div>
      </div>
      {error && <p class="form-error" role="alert">{error}</p>}

      <Panel title="Roster">
        {team.members.length === 0 ? <Empty>Nobody is on this team.</Empty> : (
          <table class="teamroster">
            <tbody>
              {team.members.map((m) => (
                <tr key={m.steamid}>
                  <td><a href={`/player/${m.steamid}`}>{m.name}</a></td>
                  <td>{ROLE_LABEL[m.role]}</td>
                  <td>joined {day(m.joinedAt)}</td>
                  <td class="teamroster__actions">
                    {captain && m.role !== 'captain' && (
                      <>
                        {role === 'captain' && (m.role === 'member'
                          ? <button class="btn btn--small" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'cocaptain'))}>Make co-captain</button>
                          : <button class="btn btn--small" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'member'))}>Make member</button>)}
                        <button class="btn btn--small" disabled={busy} onClick={() => act(() => teamsApi.makeCaptain(slug, m.steamid))}>Make captain</button>
                      </>
                    )}
                    {manager && m.steamid !== me && m.role !== 'captain' && (role === 'captain' || team.viewer.staff || m.role === 'member') && (
                      <button class="btn btn--small btn--danger" disabled={busy} onClick={() => act(() => teamsApi.kick(slug, m.steamid))}>Kick</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {manager && (
        <Panel title="Invite">
          <label class="teamsearch">Find a player<input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
          <ul class="teamsearch__results">
            {found.map((p) => (
              <li key={p.steamid}>
                <button class="btn btn--small" disabled={busy} aria-label={`Invite ${p.name}`} onClick={() => act(() => teamsApi.invite(slug, p.steamid), () => setQ(''))}>Invite</button> {p.name}
              </li>
            ))}
          </ul>
          {team.manage!.invites.length > 0 && (
            <ul class="teaminvites">
              {team.manage!.invites.map((i) => (
                <li key={i.id}>{i.name} (invited {day(i.createdAt)})
                  <button class="btn btn--small" disabled={busy} onClick={() => act(() => teamsApi.cancelInvite(i.id))}>Cancel invite</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {captain && (
        <Panel title="Team settings">
          <div class="teamsettings">
            {joinUrl
              ? <p>Join link: <code>{joinUrl}</code> <button class="btn btn--small" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, false))}>Turn off join link</button></p>
              : <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, true))}>Turn on join link</button>}
            <label>Logo<input type="file" accept="image/*" disabled={busy} onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void act(async () => teamsApi.logo(slug, await toLogoPng(f)));
            }} /></label>
            <form class="teamform" onSubmit={(e) => { e.preventDefault(); void act(() => teamsApi.rename(slug, { ...(newName ? { name: newName } : {}), ...(newTag ? { tag: newTag } : {}) }), () => { setNewName(''); setNewTag(''); }); }}>
              <label>New name<input value={newName} maxLength={24} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} /></label>
              <label>New tag<input value={newTag} maxLength={5} onInput={(e) => setNewTag((e.target as HTMLInputElement).value)} /></label>
              <button class="btn" type="submit" disabled={busy}>Rename</button>
            </form>
            {confirmDisband
              ? <button class="btn btn--danger" disabled={busy} onClick={() => act(() => teamsApi.disband(slug))}>Yes, disband {team.name}</button>
              : <button class="btn btn--danger" onClick={() => setConfirmDisband(true)}>Disband team</button>}
          </div>
        </Panel>
      )}

      {live && role && (
        <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.leave(slug), () => route('/teams'))}>Leave team</button>
      )}

      {team.former.length > 0 && (
        <Panel title="Former players">
          <ul class="teamformer">{team.former.map((f) => <li key={f.steamid}><a href={`/player/${f.steamid}`}>{f.name}</a> · left {day(f.leftAt)}</li>)}</ul>
        </Panel>
      )}
    </main>
  );
}
```

Note the captain test above expects one "Make co-captain", one "Kick" and one "Make captain" button: with the two-member fixture only `bob` gets row buttons. The "Logo" label is found by `getByLabelText('Logo')`.

In `web/src/AppRoutes.tsx`, add the lazy `Team` import and the route `<Route path="/team/:slug" component={Team} session={session} refresh={refresh} />` after `/team/join/:token`.

Add styles for `.teamhead` (logo 96 px left, name and line right; stacks on a phone), `.teamroster` (full-width table; the actions cell wraps), `.teamsearch`, `.teamsettings` (stacked rows with gaps), `.teamformer`, `.btn--small` and `.btn--danger` only if `web/src/styles/app.css` lacks them (`grep -n "btn--danger\|btn--small" web/src/styles/app.css`).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run web/src/routes/Team.test.tsx web/src/routes/Teams.test.tsx web/src/appRoutes.test.tsx`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 6: Look at it**

Run the dev server (`npm run dev`), set `competitive_enabled` to `everyone` in the local dev database through the admin Settings page (Competitive group), create a team, open its page at desktop width and at 390 px wide. Check: no horizontal scroll at 390 px, the roster actions wrap, the logo upload replaces the tag box. `npm run shoot` captures pages if a screenshot is wanted (`scripts/shoot-pages.mjs`).

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "Team page: roster, former players, invite search, roles, kick, captaincy, join link, logo, rename, disband, leave"
```

---

## Rollout

- One web deploy after the owner's go-ahead (`deploy-web.sh`; web deploys may go out during live matches). The switch ships `off`, so players see nothing. Verify on Dallas: the three tables exist, `SELECT value FROM settings WHERE key IN ('competitive_enabled','team_membership_cap')` gives `off` and `3`, `/api/teams` answers 404.
- The owner then sets the switch to `admins` in the Settings desk (Competitive group) to try it, and later to `everyone`.
- No plugin change, no game server restart.

## Notes for later plans

- Plan 4 (bookings) reads `teams`, `team_members` for side rosters and `ENTRY_MIN`; booking sides with no team are pickup groups and never count toward the cap.
- Spec 2 snapshots a roster per event and checks "one team per event per player" at registration and check-in; it reads `activeMembers`.
- Spec 3's "Keep this team" and spec 4's "Make this a team" create teams with `origin` `draft` / `pickup` and `origin_ref`; they should go through a variant of `createTeam` that skips `created_cap` for the draft captain if the owner wants that (open question for spec 3).
