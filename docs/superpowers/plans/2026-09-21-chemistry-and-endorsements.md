# Chemistry and endorsements: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish phases 4 and 5 of the social profiles spec: three chemistry lines on a profile, and anonymous post-match endorsements (Caller, Clutch, Good vibes) given from the Discord result card or the match page, which earn a title shown beside a name.

**Architecture:** Chemistry is one read-only query module (`src/chemistry.ts`) folded into the existing profile read model. Endorsements are one module (`src/endorsements.ts`) that owns every rule (roster, window, budget, no self, one per recipient) inside a transaction, and both surfaces call it: the HTTP route with the session steamid, the Discord controller with the linked player's steamid. The Discord flow reuses the existing button and ephemeral machinery; the only transport change is that a button pressed on one of the bot's own ephemeral replies edits that reply in place instead of stacking a new one.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, Preact + preact-iso, Vitest (server project on node, web project on happy-dom with @testing-library/preact).

**Spec:** `docs/superpowers/specs/2026-09-20-social-profiles-and-streams-design.md` (sections "Chemistry", "Endorsements", the `endorsements` table, "Settings", "Security", "Testing").

## Global Constraints

- **Scope is the web app only.** No plugin change, no game server change, no cfg change, no deploy. Work happens on the worktree branch `worktree-chemistry-endorse`.
- **Nothing is deployed** until the owner says so. `deploy-web.sh` is not run by this plan. Nothing is merged to master or pushed by this plan.
- **No em dashes** anywhere: code, comments, commit messages, UI copy, test names.
- **Endorsements are anonymous.** No API payload, page, or Discord message may reveal who endorsed whom. The only place a giver sees a `from`-side fact is their own list of what they themselves gave on one match.
- **No negative option exists.** The kinds are exactly `caller`, `clutch`, `vibes`, displayed as `Caller`, `Clutch`, `Good vibes`.
- **No new message reaches anybody.** No DM, nothing added to a channel. Every endorse reply on Discord is ephemeral.
- **The acting player always comes from the session (site) or from the linked player row (Discord), never from a request body or a custom id.**
- Stat and roster queries filter `m.state = 'completed'`. A voided match is `aborted` and is excluded, including its endorsements from counts and titles.
- The five settings `chemistry_min_games` (5), `endorse_budget` (2), `endorse_window_hours` (24), `endorse_title_min` (5), `endorse_title_min_games` (10) already exist in `DEFAULT_SETTINGS` in `src/db.ts`. Do not re-add them there.
- `matches.ended_at` is written with SQLite `datetime('now')`: UTC, format `YYYY-MM-DD HH:MM:SS`.
- Test command is `npx vitest run <file>`; typecheck is `npm run typecheck` (it checks both tsconfigs). Run both before every commit.
- Commit after every task. Commit messages follow house style: a sentence-case summary line, blank line, prose explaining why, no trailing attribution footer.
- Match the surrounding code: comment density, naming, and the habit of explaining why rather than what.

---

### Task 1: Chemistry query and profile payload

**Files:**
- Create: `src/chemistry.ts`
- Modify: `src/playerQueries.ts` (`profileData` return value)
- Test: `tests/chemistry.test.ts`

**Interfaces:**
- Consumes: `resolveAlias(db, steamid)` from `src/aliases.ts`; `getSetting(db, key): string | undefined` from `src/settings.ts`; tables `matches`, `match_players`, `player_aliases`, `players`.
- Produces: `chemistryFor(db: DB, steamid: string): Chemistry` and the types `ChemistryLine`, `Chemistry`. `profileData(...)` gains a `chemistry: Chemistry` field.

- [ ] **Step 1: Write the failing test**

Create `tests/chemistry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { setSetting } from '../src/settings.js';
import { chemistryFor } from '../src/chemistry.js';
import { profileData } from '../src/playerQueries.js';

const ME = '76561198000000001';
const ANN = '76561198000000002';
const BOB = '76561198000000003';
const CAT = '76561198000000004';
const DAN = '76561198000000005';
const ALT = '76561198000000009';

let db: DB;
let nextId = 1;

/** One match: `a` and `b` are the two rosters, `winner` who took it. */
function seed(winner: 'a' | 'b' | 'draw', a: string[], b: string[], state = 'completed'): number {
  const id = nextId++;
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, winner, ended_at) VALUES (?, 1, ?, 'no_mercy', ?, datetime('now'))",
  ).run(id, state, winner);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const p of a) ins.run(id, p, 'a');
  for (const p of b) ins.run(id, p, 'b');
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  nextId = 1;
  for (const [id, name] of [[ME, 'me'], [ANN, 'ann'], [BOB, 'bob'], [CAT, 'cat'], [DAN, 'dan'], [ALT, 'ann-alt']] as const) {
    upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  }
});

describe('chemistryFor', () => {
  it('most played with is a plain count of shared same-team matches, with no threshold', () => {
    seed('a', [ME, ANN], [CAT]);
    seed('b', [ME, ANN], [CAT]);
    seed('a', [ME, ANN], [DAN]);
    seed('a', [ME, BOB], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.mostPlayedWith).toEqual({ steamid: ANN, name: 'ann', games: 3, wins: 2, winRate: 2 / 3 });
    // Default chemistry_min_games is 5 and nobody has 5 shared games.
    expect(c.bestWith).toBeNull();
    expect(c.worstAgainst).toBeNull();
  });

  it('best with is the highest same-team win rate among pairs that clear the threshold', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('a', [ME, ANN], [CAT]);
    seed('b', [ME, ANN], [CAT]);
    seed('a', [ME, BOB], [DAN]);
    seed('a', [ME, BOB], [DAN]);
    // One game with cat at 100% must not beat bob: it is under the threshold.
    seed('a', [ME, CAT], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.bestWith).toEqual({ steamid: BOB, name: 'bob', games: 2, wins: 2, winRate: 1 });
  });

  it('worst against is the lowest win rate against an opponent, from my side of the result', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('b', [ME], [CAT, DAN]);
    seed('b', [ME], [CAT]);
    seed('a', [ME], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.worstAgainst).toEqual({ steamid: CAT, name: 'cat', games: 2, wins: 0, winRate: 0 });
  });

  it('a draw is a game that is not a win', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('draw', [ME, ANN], [CAT]);
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ME).bestWith).toMatchObject({ steamid: ANN, games: 2, wins: 1, winRate: 0.5 });
  });

  it('ignores aborted matches, which is also what excludes a voided one', () => {
    seed('a', [ME, ANN], [CAT]);
    seed('a', [ME, BOB], [CAT], 'aborted');
    seed('a', [ME, BOB], [CAT], 'aborted');
    expect(chemistryFor(db, ME).mostPlayedWith?.steamid).toBe(ANN);
  });

  it('folds an alias into its canonical account, so an alt is not a separate teammate', () => {
    addAlias(db, { steamid: ALT, canonical: ANN, by: 'test' });
    seed('a', [ME, ANN], [CAT]);
    seed('a', [ME, ALT], [CAT]);
    seed('a', [ME, BOB], [CAT]);
    const c = chemistryFor(db, ME);
    expect(c.mostPlayedWith).toMatchObject({ steamid: ANN, name: 'ann', games: 2 });
  });

  it('resolves the subject through the alias table too', () => {
    addAlias(db, { steamid: ALT, canonical: ANN, by: 'test' });
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ALT).mostPlayedWith?.steamid).toBe(ME);
  });

  it('is all nulls for somebody who has played nothing', () => {
    expect(chemistryFor(db, ME)).toEqual({ mostPlayedWith: null, bestWith: null, worstAgainst: null });
  });

  it('breaks ties by more games, then by name, so the line does not flicker', () => {
    seed('a', [ME, BOB], [CAT]);
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ME).mostPlayedWith?.steamid).toBe(ANN);
  });
});

describe('profileData chemistry', () => {
  it('carries the three lines on the profile payload', () => {
    seed('a', [ME, ANN], [CAT]);
    const got = profileData(db, ME, null)!;
    expect(got.chemistry.mostPlayedWith?.steamid).toBe(ANN);
    expect(got.chemistry.bestWith).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chemistry.test.ts`
Expected: FAIL, cannot resolve `../src/chemistry.js`.

- [ ] **Step 3: Write the implementation**

Create `src/chemistry.ts`:

```ts
import type { DB } from './db.js';
import { resolveAlias } from './aliases.js';
import { getSetting } from './settings.js';

/**
 * Who a player wins with and loses to. Three lines on the profile and no
 * more: the profile already carries a lot of numbers.
 *
 * No schema. It is a self join on match_players over completed matches,
 * which is also what excludes a voided match, since voiding sets 'aborted'.
 */

export interface ChemistryLine {
  steamid: string;
  name: string;
  games: number;
  wins: number;
  /** wins / games, 0 to 1. A draw is a game that is not a win. */
  winRate: number;
}

export interface Chemistry {
  /** A count, so it has no threshold: a count of three is honestly three. */
  mostPlayedWith: ChemistryLine | null;
  /** Averages, so both are gated by chemistry_min_games. An average over
   *  three games is noise (the precedent in 5d2ae85). Null, never an empty
   *  line, when nobody clears it. */
  bestWith: ChemistryLine | null;
  worstAgainst: ChemistryLine | null;
}

interface PairRow { steamid: string; name: string; same: number; games: number; wins: number }

export function chemistryFor(db: DB, steamid: string): Chemistry {
  const me = resolveAlias(db, steamid);
  const minGames = Math.max(1, Math.trunc(Number(getSetting(db, 'chemistry_min_games'))) || 5);

  // Ids resolve through player_aliases on BOTH sides of the join, so a merged
  // alt is not counted as a separate teammate. DISTINCT because an alt and its
  // owner can both sit on one old roster, and that is one shared match.
  const rows = db.prepare(
    `WITH roster AS (
       SELECT DISTINCT mp.match_id, COALESCE(pa.canonical_id, mp.player_id) AS pid, mp.team
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
       LEFT JOIN player_aliases pa ON pa.steamid = mp.player_id
     )
     SELECT o.pid AS steamid, p.name AS name,
            CASE WHEN o.team = me.team THEN 1 ELSE 0 END AS same,
            COUNT(*) AS games,
            SUM(CASE WHEN m.winner = me.team THEN 1 ELSE 0 END) AS wins
     FROM roster me
     JOIN roster o ON o.match_id = me.match_id AND o.pid != me.pid
     JOIN matches m ON m.id = me.match_id
     JOIN players p ON p.steamid = o.pid
     WHERE me.pid = ?
     GROUP BY o.pid, same`,
  ).all(me) as PairRow[];

  const line = (r: PairRow | undefined): ChemistryLine | null =>
    r ? { steamid: r.steamid, name: r.name, games: r.games, wins: r.wins, winRate: r.wins / r.games } : null;
  // Every ordering ends on name then id, so two equal pairs never swap places
  // between page loads.
  const stable = (a: PairRow, b: PairRow) => a.name.localeCompare(b.name) || a.steamid.localeCompare(b.steamid);
  const rate = (r: PairRow) => r.wins / r.games;

  const withRows = rows.filter((r) => r.same === 1);
  const againstRows = rows.filter((r) => r.same === 0);

  return {
    mostPlayedWith: line([...withRows].sort((a, b) => b.games - a.games || stable(a, b))[0]),
    bestWith: line(withRows.filter((r) => r.games >= minGames)
      .sort((a, b) => rate(b) - rate(a) || b.games - a.games || stable(a, b))[0]),
    worstAgainst: line(againstRows.filter((r) => r.games >= minGames)
      .sort((a, b) => rate(a) - rate(b) || b.games - a.games || stable(a, b))[0]),
  };
}
```

In `src/playerQueries.ts`, add the import beside the others:

```ts
import { chemistryFor } from './chemistry.js';
```

and in the object `profileData` returns, add this line directly after the `standings:` entry:

```ts
    // Who they win with and lose to. Three lines, computed per request: it is
    // one grouped query over an indexed primary key.
    chemistry: chemistryFor(db, steamid),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/chemistry.test.ts tests/playerQueries.test.ts tests/profileApi.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/chemistry.ts src/playerQueries.ts tests/chemistry.test.ts
git commit -m "Add the chemistry query to the profile read model" -m "Most played with, best with and worst against, from a self join on completed rosters with both sides resolved through player_aliases. The two win rates are gated by chemistry_min_games because an average over three games is noise; the count is not gated because a count is honest at any size."
```

---

### Task 2: Chemistry panel on the profile page

**Files:**
- Create: `web/src/components/Chemistry.tsx`
- Modify: `web/src/api.ts` (types), `web/src/routes/Profile.tsx` (mount)
- Test: `web/src/components/Chemistry.test.tsx`

**Interfaces:**
- Consumes: the `chemistry` field Task 1 added to `GET /api/players/:steamid`, shape `{ mostPlayedWith, bestWith, worstAgainst }`, each `null` or `{ steamid: string; name: string; games: number; wins: number; winRate: number }` with `winRate` from 0 to 1.
- Produces: `ChemistryPanel` component; `Chemistry` and `ChemistryLine` types exported from `web/src/api.ts`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/Chemistry.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { ChemistryPanel } from './Chemistry';

afterEach(cleanup);

const line = (name: string, games: number, wins: number) =>
  ({ steamid: `7656119800000000${name.length}`, name, games, wins, winRate: wins / games });

describe('ChemistryPanel', () => {
  it('renders nothing at all when there is no line to show', () => {
    const { container } = render(
      <ChemistryPanel chemistry={{ mostPlayedWith: null, bestWith: null, worstAgainst: null }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for an older payload with no chemistry field', () => {
    const { container } = render(<ChemistryPanel chemistry={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count for most played with and a percentage for the two rates', () => {
    render(
      <ChemistryPanel
        chemistry={{ mostPlayedWith: line('ann', 12, 7), bestWith: line('bobby', 7, 5), worstAgainst: line('cat', 6, 1) }}
      />,
    );
    expect(screen.getByText('Most played with')).toBeTruthy();
    expect(screen.getByText('12 games')).toBeTruthy();
    expect(screen.getByText('71% over 7')).toBeTruthy();
    expect(screen.getByText('17% over 6')).toBeTruthy();
    expect((screen.getByText('ann') as HTMLAnchorElement).getAttribute('href')).toContain('/player/');
  });

  it('leaves out a gated line that nobody cleared, rather than showing it empty', () => {
    render(<ChemistryPanel chemistry={{ mostPlayedWith: line('ann', 1, 1), bestWith: null, worstAgainst: null }} />);
    expect(screen.getByText('1 game')).toBeTruthy();
    expect(screen.queryByText('Best with')).toBeNull();
    expect(screen.queryByText('Worst against')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/components/Chemistry.test.tsx`
Expected: FAIL, cannot resolve `./Chemistry`.

- [ ] **Step 3: Write the implementation**

In `web/src/api.ts`, add directly above `export interface Profile {`:

```ts
/** One line of the profile's chemistry panel. `winRate` is 0 to 1. */
export interface ChemistryLine { steamid: string; name: string; games: number; wins: number; winRate: number }

/** Null lines are absent lines: the two rates are gated by a minimum number
 *  of shared games and are simply not shown until somebody clears it. */
export interface Chemistry {
  mostPlayedWith: ChemistryLine | null;
  bestWith: ChemistryLine | null;
  worstAgainst: ChemistryLine | null;
}
```

and inside `export interface Profile {`, add as a top-level field (a sibling of `player`, not inside it):

```ts
  /** Optional only for a server older than the feature. */
  chemistry?: Chemistry;
```

Create `web/src/components/Chemistry.tsx`:

```tsx
import type { Chemistry, ChemistryLine } from '../api';
import { Panel, PlayerLink } from './bits';

const games = (n: number) => `${n} game${n === 1 ? '' : 's'}`;
const rate = (l: ChemistryLine) => `${Math.round(l.winRate * 100)}% over ${l.games}`;

/**
 * Who this player wins with and loses to. Three lines and no more.
 *
 * The whole panel is absent when there is nothing to say, and so is each
 * gated line: a heading over an empty row reads as a bug, and "Best with:
 * nobody yet" is a worse thing to show a new player than nothing.
 */
export function ChemistryPanel({ chemistry }: { chemistry?: Chemistry | null }) {
  if (!chemistry) return null;
  const { mostPlayedWith, bestWith, worstAgainst } = chemistry;
  if (!mostPlayedWith && !bestWith && !worstAgainst) return null;
  return (
    <Panel>
      <h3>Chemistry</h3>
      <dl class="totals chemistry">
        {mostPlayedWith && (
          <div>
            <dt>Most played with</dt>
            <dd><PlayerLink steamid={mostPlayedWith.steamid} name={mostPlayedWith.name} /> <span class="muted num">{games(mostPlayedWith.games)}</span></dd>
          </div>
        )}
        {bestWith && (
          <div>
            <dt>Best with</dt>
            <dd><PlayerLink steamid={bestWith.steamid} name={bestWith.name} /> <span class="muted num">{rate(bestWith)}</span></dd>
          </div>
        )}
        {worstAgainst && (
          <div>
            <dt>Worst against</dt>
            <dd><PlayerLink steamid={worstAgainst.steamid} name={worstAgainst.name} /> <span class="muted num">{rate(worstAgainst)}</span></dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}
```

In `web/src/routes/Profile.tsx`, add the import beside the other component imports:

```tsx
import { ChemistryPanel } from '../components/Chemistry';
```

and mount it directly after the `<ProfileFigures ... />` element and before `<div class="profile-grid">`:

```tsx
        <ChemistryPanel chemistry={data.chemistry} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/components/Chemistry.test.tsx web/src/routes/routes.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/Chemistry.tsx web/src/components/Chemistry.test.tsx web/src/routes/Profile.tsx
git commit -m "Show chemistry on the profile" -m "Three lines under the figures: most played with as a count, best with and worst against as a win rate over the shared games. The panel and each gated line are absent rather than empty when there is nothing to say."
```

---

### Task 3: Endorsements schema, settings and rules

**Files:**
- Create: `src/endorsements.ts`
- Modify: `src/db.ts` (`SCHEMA` string only), `src/settingsSchema.ts` (`SETTINGS_SCHEMA`)
- Test: `tests/endorsements.test.ts`

**Interfaces:**
- Consumes: `getSetting(db, key): string | undefined`; settings `endorse_budget`, `endorse_window_hours`, `endorse_title_min`, `endorse_title_min_games` (already seeded); tables `matches`, `match_players`, `players`.
- Produces, all exported from `src/endorsements.ts`:
  - `ENDORSE_KINDS: readonly ['caller', 'clutch', 'vibes']`, `type EndorseKind`, `ENDORSE_LABEL: Record<EndorseKind, string>`
  - `type EndorseError = 'bad_kind' | 'self' | 'no_match' | 'not_completed' | 'not_rostered' | 'target_not_rostered' | 'closed' | 'duplicate' | 'budget'`, `ENDORSE_ERROR_TEXT: Record<EndorseError, string>`
  - `giveEndorsement(db, { matchId, from, to, kind }): { ok: true; remaining: number } | { ok: false; error: EndorseError }`
  - `endorseState(db, matchId, steamid): EndorseState`
  - `endorsementSummary(db, steamid): EndorsementSummary`
  - `titleFromCounts(counts, games, minCount, minGames): EndorseKind | null`
  - `allTitles(db): Map<string, EndorseKind>`
  - `pendingEndorsements(db, steamid): { matchId: number; remaining: number }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/endorsements.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  ENDORSE_ERROR_TEXT, ENDORSE_KINDS, ENDORSE_LABEL,
  allTitles, endorseState, endorsementSummary, giveEndorsement, pendingEndorsements, titleFromCounts,
} from '../src/endorsements.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const OUTSIDER = '76561198000000099';
let db: DB;

/** A match with all eight IDS on it, four a side, ended `hoursAgo` hours ago. */
function seedMatch(id: number, opts: { state?: string; hoursAgo?: number } = {}): void {
  db.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
     VALUES (?, 1, ?, 'no_mercy', 'a', datetime('now', ?))`,
  ).run(id, opts.state ?? 'completed', `-${opts.hoursAgo ?? 0} hours`);
  IDS.forEach((p, i) => {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
  });
}

const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM endorsements').get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  [...IDS, OUTSIDER].forEach((id, i) => upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []));
});

describe('schema', () => {
  it('has no negative kind and refuses an unknown one at the table', () => {
    seedMatch(1);
    expect([...ENDORSE_KINDS]).toEqual(['caller', 'clutch', 'vibes']);
    expect(ENDORSE_LABEL).toEqual({ caller: 'Caller', clutch: 'Clutch', vibes: 'Good vibes' });
    expect(() => db.prepare(
      "INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (1, ?, ?, 'toxic', datetime('now'))",
    ).run(IDS[0], IDS[1])).toThrow();
  });

  it('has a sentence for every refusal', () => {
    for (const text of Object.values(ENDORSE_ERROR_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe('giveEndorsement', () => {
  it('records one and reports what is left of the budget', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'caller' })).toEqual({ ok: true, remaining: 1 });
    expect(rowCount()).toBe(1);
  });

  it('lets a player endorse across teams', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[7], kind: 'vibes' }).ok).toBe(true);
  });

  it('refuses self endorsement', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[0], kind: 'clutch' })).toEqual({ ok: false, error: 'self' });
  });

  it('refuses a kind that does not exist', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'toxic' })).toEqual({ ok: false, error: 'bad_kind' });
  });

  it('refuses a giver who was not on the roster', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: OUTSIDER, to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'not_rostered' });
  });

  it('refuses a recipient who was not on the roster', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: OUTSIDER, kind: 'caller' })).toEqual({ ok: false, error: 'target_not_rostered' });
  });

  it('refuses a match that does not exist or did not complete', () => {
    seedMatch(2, { state: 'aborted' });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'no_match' });
    expect(giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'not_completed' });
  });

  it('closes after endorse_window_hours, and the window is the setting', () => {
    seedMatch(1, { hoursAgo: 25 });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: false, error: 'closed' });
    setSetting(db, 'endorse_window_hours', '48');
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' }).ok).toBe(true);
  });

  it('allows one endorsement per recipient per match, whatever the kind', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'clutch' })).toEqual({ ok: false, error: 'duplicate' });
    expect(rowCount()).toBe(1);
  });

  it('never spends more than the budget, however many times it is asked', () => {
    seedMatch(1);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' })).toEqual({ ok: true, remaining: 1 });
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' })).toEqual({ ok: true, remaining: 0 });
    for (let i = 3; i < 8; i += 1) {
      expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[i], kind: 'caller' })).toEqual({ ok: false, error: 'budget' });
    }
    expect(rowCount()).toBe(2);
  });

  it('keeps each match and each giver on its own budget', () => {
    seedMatch(1);
    seedMatch(2);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' });
    expect(giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' }).ok).toBe(true);
    expect(giveEndorsement(db, { matchId: 1, from: IDS[3], to: IDS[1], kind: 'caller' }).ok).toBe(true);
  });
});

describe('endorseState', () => {
  it('lists the seven other players and what this giver already gave', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'clutch' });
    const st = endorseState(db, 1, IDS[0]);
    expect(st.eligible).toBe(true);
    expect(st.reason).toBeNull();
    expect(st.budget).toBe(2);
    expect(st.remaining).toBe(1);
    expect(st.given).toEqual([{ to: IDS[5], kind: 'clutch' }]);
    expect(st.candidates.map((c) => c.steamid).sort()).toEqual(IDS.slice(1).sort());
    expect(st.closesAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('never shows one giver what another gave', () => {
    seedMatch(1);
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'clutch' });
    expect(endorseState(db, 1, IDS[5]).given).toEqual([]);
  });

  it('says why somebody may not endorse, with nothing else attached', () => {
    seedMatch(1, { hoursAgo: 30 });
    expect(endorseState(db, 1, OUTSIDER)).toMatchObject({ eligible: false, reason: 'not_rostered', candidates: [], given: [], remaining: 0 });
    expect(endorseState(db, 1, IDS[0])).toMatchObject({ eligible: false, reason: 'closed' });
    expect(endorseState(db, 9, IDS[0])).toMatchObject({ eligible: false, reason: 'no_match' });
  });
});

describe('titleFromCounts', () => {
  const c = (caller: number, clutch: number, vibes: number) => ({ caller, clutch, vibes });
  it('needs enough games', () => expect(titleFromCounts(c(9, 0, 0), 9, 5, 10)).toBeNull());
  it('needs enough of the kind', () => expect(titleFromCounts(c(4, 0, 0), 20, 5, 10)).toBeNull());
  it('gives the strict plurality', () => expect(titleFromCounts(c(6, 5, 1), 20, 5, 10)).toBe('caller'));
  it('gives nothing on a tie, so a title cannot flicker', () => expect(titleFromCounts(c(6, 6, 1), 20, 5, 10)).toBeNull());
});

describe('endorsementSummary and allTitles', () => {
  /** `n` endorsements of `kind` for IDS[1], one per match, from IDS[0]. */
  function farm(kind: string, n: number, firstMatch: number): void {
    for (let i = 0; i < n; i += 1) {
      seedMatch(firstMatch + i);
      expect(giveEndorsement(db, { matchId: firstMatch + i, from: IDS[0], to: IDS[1], kind }).ok).toBe(true);
    }
  }

  it('counts per kind, a per match rate, and nothing about who gave them', () => {
    farm('caller', 3, 1);
    farm('vibes', 1, 4);
    const s = endorsementSummary(db, IDS[1]);
    expect(s).toEqual({ counts: { caller: 3, clutch: 0, vibes: 1 }, total: 4, perMatch: 1, title: null });
    expect(Object.keys(s).sort()).toEqual(['counts', 'perMatch', 'title', 'total']);
  });

  it('awards the title once both thresholds are met', () => {
    setSetting(db, 'endorse_title_min', '3');
    setSetting(db, 'endorse_title_min_games', '4');
    farm('caller', 3, 1);
    expect(endorsementSummary(db, IDS[1]).title).toBeNull();
    farm('vibes', 1, 4);
    expect(endorsementSummary(db, IDS[1]).title).toBe('caller');
    expect(allTitles(db).get(IDS[1])).toBe('caller');
    expect(allTitles(db).has(IDS[0])).toBe(false);
  });

  it('drops the endorsements of a match that was voided afterwards', () => {
    farm('caller', 2, 1);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 1").run();
    expect(endorsementSummary(db, IDS[1])).toMatchObject({ counts: { caller: 1, clutch: 0, vibes: 0 }, total: 1, perMatch: 1 });
  });

  it('is zeros for somebody nobody has endorsed', () => {
    expect(endorsementSummary(db, OUTSIDER)).toEqual({ counts: { caller: 0, clutch: 0, vibes: 0 }, total: 0, perMatch: 0, title: null });
  });
});

describe('pendingEndorsements', () => {
  it('lists open matches where this player still has budget, newest first', () => {
    seedMatch(1);
    seedMatch(2);
    seedMatch(3, { hoursAgo: 30 });
    seedMatch(4, { state: 'aborted' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[1], kind: 'caller' });
    giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[2], kind: 'caller' });
    giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[1], kind: 'caller' });
    expect(pendingEndorsements(db, IDS[0])).toEqual([{ matchId: 2, remaining: 1 }]);
    expect(pendingEndorsements(db, OUTSIDER)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/endorsements.test.ts`
Expected: FAIL, cannot resolve `../src/endorsements.js`.

- [ ] **Step 3: Add the table**

In `src/db.ts`, inside the `SCHEMA` template string, directly after the closing `);` of `CREATE TABLE IF NOT EXISTS match_players (...)`, add:

```sql
-- Post-match endorsements. The primary key is an anti abuse rule expressed
-- structurally: one endorsement per giver per recipient per match, so nobody
-- stacks all three kinds on one friend. Everything a CHECK cannot see (both
-- rostered, match completed, inside the window, within the budget, not self)
-- is enforced by src/endorsements.ts. from_id is never shown to anybody; it is
-- kept so farming can be audited if it ever happens.
CREATE TABLE IF NOT EXISTS endorsements (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  from_id    TEXT NOT NULL REFERENCES players(steamid),
  to_id      TEXT NOT NULL REFERENCES players(steamid),
  kind       TEXT NOT NULL CHECK (kind IN ('caller','clutch','vibes')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_endorsements_to ON endorsements (to_id, kind);
```

- [ ] **Step 4: Make the five settings editable**

In `src/settingsSchema.ts`, add these entries to `SETTINGS_SCHEMA` directly after the `standing_min_games` entry:

```ts
  { key: 'chemistry_min_games', group: 'Stats', label: 'Chemistry minimum games', help: 'Shared matches before a Best with or Worst against win rate is shown on a profile. Most played with is a count and has no minimum.', type: { kind: 'int', min: 1, max: 200 } },
  { key: 'endorse_budget', group: 'Stats', label: 'Endorsements per match', help: 'How many of the other seven players each player may endorse after a match.', type: { kind: 'int', min: 1, max: 7 } },
  { key: 'endorse_window_hours', group: 'Stats', label: 'Endorsement window (hours)', help: 'How long after a match ends endorsing stays open.', type: { kind: 'int', min: 1, max: 168 } },
  { key: 'endorse_title_min', group: 'Stats', label: 'Title minimum endorsements', help: 'Endorsements of one kind before that kind can become the title shown beside a name.', type: { kind: 'int', min: 1, max: 1000 } },
  { key: 'endorse_title_min_games', group: 'Stats', label: 'Title minimum games', help: 'Completed matches before any title is shown.', type: { kind: 'int', min: 1, max: 1000 } },
```

- [ ] **Step 5: Write the module**

Create `src/endorsements.ts`:

```ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * Post-match endorsements: every rule lives here, and both surfaces (the HTTP
 * route and the Discord button) call these functions, so the site and the bot
 * cannot disagree about who may endorse whom.
 *
 * Aggregate and anonymous. Nothing exported from this module returns a
 * from_id, except endorseState handing a giver their OWN list for one match.
 * The moment a profile shows who endorsed whom it becomes a public record of
 * who likes whom, which is the opposite of the intent.
 *
 * There is no negative kind, so there is nothing to aim at whoever out
 * fragged you.
 */

export const ENDORSE_KINDS = ['caller', 'clutch', 'vibes'] as const;
export type EndorseKind = typeof ENDORSE_KINDS[number];

export const ENDORSE_LABEL: Record<EndorseKind, string> = {
  caller: 'Caller',
  clutch: 'Clutch',
  vibes: 'Good vibes',
};

export type EndorseError =
  | 'bad_kind' | 'self' | 'no_match' | 'not_completed' | 'not_rostered'
  | 'target_not_rostered' | 'closed' | 'duplicate' | 'budget';

/** One sentence per refusal, shared by the site and the bot. */
export const ENDORSE_ERROR_TEXT: Record<EndorseError, string> = {
  bad_kind: 'That is not a kind of endorsement.',
  self: 'You cannot endorse yourself.',
  no_match: 'There is no such match.',
  not_completed: 'Only a completed match can be endorsed.',
  not_rostered: 'You were not in this match.',
  target_not_rostered: 'That player was not in this match.',
  closed: 'Endorsing for this match has closed.',
  duplicate: 'You already endorsed that player for this match.',
  budget: 'You have no endorsements left for this match.',
};

export type EndorseCounts = Record<EndorseKind, number>;

export interface EndorseState {
  /** May this player endorse on this match at all. Budget aside: a player who
   *  has spent everything is still eligible, with `remaining` 0. */
  eligible: boolean;
  reason: EndorseError | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. Null when there is no such match. */
  closesAt: string | null;
  budget: number;
  remaining: number;
  /** What THIS player gave on this match. Their own choices, nobody else's. */
  given: { to: string; kind: EndorseKind }[];
  candidates: { steamid: string; name: string; team: 'a' | 'b' }[];
}

export interface EndorsementSummary {
  counts: EndorseCounts;
  total: number;
  /** Received per completed match played, to two places. */
  perMatch: number;
  title: EndorseKind | null;
}

/** A positive integer setting. A blank or mangled value falls back rather
 *  than reading as 0, which would close every window or zero every budget. */
function intSetting(db: DB, key: string, fallback: number): number {
  const n = Math.trunc(Number(getSetting(db, key)));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isKind = (k: string): k is EndorseKind => (ENDORSE_KINDS as readonly string[]).includes(k);

const rostered = (db: DB, matchId: number, steamid: string): boolean =>
  db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, steamid) !== undefined;

const usedBy = (db: DB, matchId: number, steamid: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM endorsements WHERE match_id = ? AND from_id = ?')
    .get(matchId, steamid) as { n: number }).n;

/** Everything that must hold before `steamid` may endorse on this match,
 *  checked in the order a person would want to be told about it. */
function gate(db: DB, matchId: number, steamid: string):
  { ok: true; closesAt: string } | { ok: false; error: EndorseError; closesAt: string | null } {
  const hours = intSetting(db, 'endorse_window_hours', 24);
  // The window is compared inside SQLite so ended_at and "now" are the same
  // kind of value. A NULL ended_at yields NULL, which is not open.
  const m = db.prepare(
    `SELECT state,
            datetime(ended_at, '+' || ? || ' hours') AS closesAt,
            datetime(ended_at, '+' || ? || ' hours') > datetime('now') AS open
     FROM matches WHERE id = ?`,
  ).get(hours, hours, matchId) as { state: string; closesAt: string | null; open: number | null } | undefined;
  if (!m) return { ok: false, error: 'no_match', closesAt: null };
  if (m.state !== 'completed') return { ok: false, error: 'not_completed', closesAt: m.closesAt };
  if (!rostered(db, matchId, steamid)) return { ok: false, error: 'not_rostered', closesAt: m.closesAt };
  if (!m.open || !m.closesAt) return { ok: false, error: 'closed', closesAt: m.closesAt };
  return { ok: true, closesAt: m.closesAt };
}

/**
 * Give one endorsement. `from` must already be the authenticated player: the
 * session steamid on the site, the linked player on Discord, never a value
 * the client supplied.
 *
 * The checks and the insert share one immediate transaction, so a double
 * submitted click cannot spend three from a budget of two.
 */
export function giveEndorsement(
  db: DB, o: { matchId: number; from: string; to: string; kind: string },
): { ok: true; remaining: number } | { ok: false; error: EndorseError } {
  const { matchId, from, to, kind } = o;
  if (!isKind(kind)) return { ok: false, error: 'bad_kind' };
  if (from === to) return { ok: false, error: 'self' };
  const run = db.transaction((): { ok: true; remaining: number } | { ok: false; error: EndorseError } => {
    const g = gate(db, matchId, from);
    if (!g.ok) return { ok: false, error: g.error };
    if (!rostered(db, matchId, to)) return { ok: false, error: 'target_not_rostered' };
    const dup = db.prepare('SELECT 1 FROM endorsements WHERE match_id = ? AND from_id = ? AND to_id = ?').get(matchId, from, to);
    if (dup) return { ok: false, error: 'duplicate' };
    const budget = intSetting(db, 'endorse_budget', 2);
    const used = usedBy(db, matchId, from);
    if (used >= budget) return { ok: false, error: 'budget' };
    db.prepare(
      "INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    ).run(matchId, from, to, kind);
    return { ok: true, remaining: budget - used - 1 };
  });
  return run.immediate();
}

/** What the endorse panel needs for one player on one match. */
export function endorseState(db: DB, matchId: number, steamid: string): EndorseState {
  const budget = intSetting(db, 'endorse_budget', 2);
  const g = Number.isInteger(matchId) ? gate(db, matchId, steamid) : { ok: false as const, error: 'no_match' as const, closesAt: null };
  if (!g.ok) {
    return { eligible: false, reason: g.error, closesAt: g.closesAt, budget, remaining: 0, given: [], candidates: [] };
  }
  const given = db.prepare('SELECT to_id AS "to", kind FROM endorsements WHERE match_id = ? AND from_id = ? ORDER BY created_at, to_id')
    .all(matchId, steamid) as { to: string; kind: EndorseKind }[];
  const candidates = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, mp.team
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? AND mp.player_id != ?
     ORDER BY mp.team, p.name, mp.player_id`,
  ).all(matchId, steamid) as { steamid: string; name: string; team: 'a' | 'b' }[];
  return {
    eligible: true, reason: null, closesAt: g.closesAt, budget,
    remaining: Math.max(0, budget - given.length), given, candidates,
  };
}

/**
 * The title a set of counts earns, or null.
 *
 * All three must hold: enough games, enough of the kind, and that kind the
 * STRICT plurality. A tie shows nothing, which is also what stops a title
 * flickering between two kinds from one match to the next.
 */
export function titleFromCounts(
  counts: EndorseCounts, games: number, minCount: number, minGames: number,
): EndorseKind | null {
  if (games < minGames) return null;
  const ranked = ENDORSE_KINDS.map((k) => [k, counts[k]] as const).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] < minCount || top[1] === second[1]) return null;
  return top[0];
}

const emptyCounts = (): EndorseCounts => ({ caller: 0, clutch: 0, vibes: 0 });

/** Counts and the title for one profile. Only endorsements whose match is
 *  still completed count, so voiding a match takes its endorsements with it. */
export function endorsementSummary(db: DB, steamid: string): EndorsementSummary {
  const counts = emptyCounts();
  const rows = db.prepare(
    `SELECT e.kind, COUNT(*) AS n
     FROM endorsements e JOIN matches m ON m.id = e.match_id AND m.state = 'completed'
     WHERE e.to_id = ? GROUP BY e.kind`,
  ).all(steamid) as { kind: EndorseKind; n: number }[];
  for (const r of rows) counts[r.kind] = r.n;
  const { games } = db.prepare(
    `SELECT COUNT(*) AS games FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
     WHERE mp.player_id = ?`,
  ).get(steamid) as { games: number };
  const total = counts.caller + counts.clutch + counts.vibes;
  return {
    counts, total,
    perMatch: games > 0 ? Math.round((total / games) * 100) / 100 : 0,
    title: titleFromCounts(
      counts, games, intSetting(db, 'endorse_title_min', 5), intSetting(db, 'endorse_title_min_games', 10),
    ),
  };
}

/** Every player who currently holds a title, for rosters and the leaderboard.
 *  Two grouped queries for the whole table rather than one lookup per row. */
export function allTitles(db: DB): Map<string, EndorseKind> {
  const minCount = intSetting(db, 'endorse_title_min', 5);
  const minGames = intSetting(db, 'endorse_title_min_games', 10);
  const byPlayer = new Map<string, EndorseCounts>();
  const rows = db.prepare(
    `SELECT e.to_id AS steamid, e.kind, COUNT(*) AS n
     FROM endorsements e JOIN matches m ON m.id = e.match_id AND m.state = 'completed'
     GROUP BY e.to_id, e.kind`,
  ).all() as { steamid: string; kind: EndorseKind; n: number }[];
  for (const r of rows) {
    const c = byPlayer.get(r.steamid) ?? emptyCounts();
    c[r.kind] = r.n;
    byPlayer.set(r.steamid, c);
  }
  const out = new Map<string, EndorseKind>();
  if (byPlayer.size === 0) return out;
  const games = new Map((db.prepare(
    `SELECT mp.player_id AS steamid, COUNT(*) AS games FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
     GROUP BY mp.player_id`,
  ).all() as { steamid: string; games: number }[]).map((r) => [r.steamid, r.games]));
  for (const [steamid, counts] of byPlayer) {
    const title = titleFromCounts(counts, games.get(steamid) ?? 0, minCount, minGames);
    if (title) out.set(steamid, title);
  }
  return out;
}

/** Open matches where this player still has endorsements to give, newest
 *  first. Drives the quiet bar at the top of the site. */
export function pendingEndorsements(db: DB, steamid: string): { matchId: number; remaining: number }[] {
  const budget = intSetting(db, 'endorse_budget', 2);
  const hours = intSetting(db, 'endorse_window_hours', 24);
  const rows = db.prepare(
    `SELECT m.id AS matchId,
            (SELECT COUNT(*) FROM endorsements e WHERE e.match_id = m.id AND e.from_id = mp.player_id) AS used
     FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = ?
     WHERE m.state = 'completed' AND datetime(m.ended_at, '+' || ? || ' hours') > datetime('now')
     ORDER BY m.id DESC`,
  ).all(steamid, hours) as { matchId: number; used: number }[];
  return rows.filter((r) => r.used < budget).map((r) => ({ matchId: r.matchId, remaining: budget - r.used }));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/endorsements.test.ts tests/db.test.ts tests/adminSettings.test.ts`
Expected: PASS. If `tests/adminSettings.test.ts` pins the number or the list of schema keys, extend that expectation with the five new keys; do not weaken it.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/endorsements.ts tests/endorsements.test.ts tests/adminSettings.test.ts
git commit -m "Add the endorsements table and the rules around it" -m "One module owns every rule: rostered, completed, inside the window, within the budget, no self, one per recipient per match. The checks and the insert share an immediate transaction so a double click cannot overspend. Counts and titles only see endorsements whose match is still completed, so a void takes them with it. The five thresholds become editable under Stats in the admin panel."
```

(Leave `tests/adminSettings.test.ts` out of `git add` if it did not change.)

---

### Task 4: HTTP endpoints and titles in the read models

**Files:**
- Modify: `src/routes/stats.ts`, `src/playerQueries.ts`
- Test: `tests/endorseApi.test.ts`

**Interfaces:**
- Consumes from `src/endorsements.ts` (Task 3): `giveEndorsement`, `endorseState`, `endorsementSummary`, `allTitles`, `pendingEndorsements`, `ENDORSE_ERROR_TEXT`. From `src/routes/guards.ts`: `makeRequireActive(db)` which returns `(req, reply) => string | null` and has already sent the 401/403 when it returns null.
- Produces:
  - `GET /api/matches/:id/endorse` (active session) returns `EndorseState`.
  - `POST /api/matches/:id/endorse` (active session), body `{ to: string; kind: string }`. 200 `{ ok: true, remaining: number, state: EndorseState }`; 400 `{ error: string, code: EndorseError }`.
  - `GET /api/endorse/pending` (active session) returns `{ pending: { matchId: number; remaining: number }[] }`.
  - `profileData(...)` gains `endorsements: { counts, total, perMatch, title }`.
  - `leaderboardData(...)` rows gain `title: EndorseKind | null`.
  - `GET /api/matches/:id` players gain `title: EndorseKind | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/endorseApi.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const OUTSIDER = '76561198000000099';
let db: DB;
let app: FastifyInstance;

function seedMatch(id: number, hoursAgo = 0): void {
  db.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
     VALUES (?, 1, 'completed', 'no_mercy', 'a', datetime('now', ?))`,
  ).run(id, `-${hoursAgo} hours`);
  IDS.forEach((p, i) => {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
  });
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => IDS[0],
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
  [...IDS, OUTSIDER].forEach((id, i) => upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []));
  seedMatch(1);
});
afterEach(async () => { await app.close(); });

describe('POST /api/matches/:id/endorse', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', payload: { to: IDS[1], kind: 'caller' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signed-in player who is not active', async () => {
    const cookies = authedCookie(app, db, IDS[0], { active: false });
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[1], kind: 'caller' } });
    expect(res.statusCode).toBe(403);
  });

  it('records one and hands back the fresh state', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'clutch' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(1);
    expect(body.state.given).toEqual([{ to: IDS[5], kind: 'clutch' }]);
  });

  it('takes the giver from the session and ignores one in the body', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    await app.inject({
      method: 'POST', url: '/api/matches/1/endorse', cookies,
      payload: { from: IDS[3], to: IDS[5], kind: 'clutch' },
    });
    const row = db.prepare('SELECT from_id FROM endorsements').get() as { from_id: string };
    expect(row.from_id).toBe(IDS[0]);
  });

  it('answers a refusal with the sentence and the code', async () => {
    const cookies = authedCookie(app, db, OUTSIDER);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'clutch' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'You were not in this match.', code: 'not_rostered' });
  });

  it('refuses a body that is not two strings', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: 5 } });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM endorsements').get()).toEqual({ n: 0 });
  });
});

describe('GET /api/matches/:id/endorse and /api/endorse/pending', () => {
  it('both need a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/matches/1/endorse' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/endorse/pending' })).statusCode).toBe(401);
  });

  it('gives a rostered player their panel and an outsider the reason', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/matches/1/endorse', cookies: authedCookie(app, db, IDS[0]) });
    expect(mine.json()).toMatchObject({ eligible: true, remaining: 2, budget: 2 });
    expect(mine.json().candidates).toHaveLength(7);
    const theirs = await app.inject({ method: 'GET', url: '/api/matches/1/endorse', cookies: authedCookie(app, db, OUTSIDER) });
    expect(theirs.json()).toMatchObject({ eligible: false, reason: 'not_rostered', candidates: [] });
  });

  it('lists what is still unspent', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'GET', url: '/api/endorse/pending', cookies });
    expect(res.json()).toEqual({ pending: [{ matchId: 1, remaining: 2 }] });
  });
});

describe('titles and counts on the public read models', () => {
  beforeEach(async () => {
    setSetting(db, 'endorse_title_min', '1');
    setSetting(db, 'endorse_title_min_games', '1');
    const cookies = authedCookie(app, db, IDS[0]);
    await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'caller' } });
  });

  it('the profile carries counts, a rate and the title, and never a giver', async () => {
    const body = (await app.inject({ method: 'GET', url: `/api/players/${IDS[5]}` })).json();
    expect(body.endorsements).toEqual({ counts: { caller: 1, clutch: 0, vibes: 0 }, total: 1, perMatch: 1, title: 'caller' });
  });

  it('the match page carries each player their title', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/matches/1' })).json();
    const byId = Object.fromEntries(body.players.map((p: { steamid: string; title: string | null }) => [p.steamid, p.title]));
    expect(byId[IDS[5]]).toBe('caller');
    expect(byId[IDS[1]]).toBeNull();
    // Anonymous: nothing on the public match payload says who gave it.
    expect(JSON.stringify(body)).not.toContain('from_id');
    expect(body.endorsements).toBeUndefined();
  });

  it('the leaderboard carries the title too', async () => {
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, 1, 25, 8)').run(IDS[5]);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, 1, 25, 8)').run(IDS[1]);
    const body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    const byId = Object.fromEntries(body.rows.map((r: { steamid: string; title: string | null }) => [r.steamid, r.title]));
    expect(byId[IDS[5]]).toBe('caller');
    expect(byId[IDS[1]]).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/endorseApi.test.ts`
Expected: FAIL, the endorse routes 404 and the payloads have no `title` or `endorsements`.

- [ ] **Step 3: Extend the read models**

In `src/playerQueries.ts`, add the import:

```ts
import { allTitles, endorsementSummary } from './endorsements.js';
```

In `leaderboardData`, directly before the final `return {`, add:

```ts
  // The title is the part of an endorsement that travels. One pass over the
  // whole table, not a lookup per row.
  const titles = allTitles(db);
```

and in the `.map((r) => ({ ... }))` that builds `rows`, add after `ranked: ...,`:

```ts
        title: titles.get(r.steamid) ?? null,
```

In `profileData`, add to the returned object directly after the `chemistry:` entry from Task 1:

```ts
    // Aggregate and anonymous: counts per kind, a per match rate and the
    // title. Never who gave them.
    endorsements: endorsementSummary(db, steamid),
```

- [ ] **Step 4: Add the routes**

In `src/routes/stats.ts`, change the guards import and add the endorsements import:

```ts
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import {
  ENDORSE_ERROR_TEXT, allTitles, endorseState, giveEndorsement, pendingEndorsements,
} from '../endorsements.js';
```

Directly after `const viewerOf = makeOptionalViewer(db);` add:

```ts
  // The endorse routes are the exception to "public read routes" above: they
  // write, and what they read is one player's own choices.
  const requireActive = makeRequireActive(db);
```

In the `GET /api/matches/:id` handler, directly before `const players = (db.prepare(`, add:

```ts
    const titles = allTitles(db);
```

and in that `.map((p) => ({ ... }))`, add after `steamid: p.steamid, name: p.name, team: p.team,`:

```ts
      title: titles.get(p.steamid) ?? null,
```

Directly after the whole `GET /api/matches/:id` handler (before the demo download route), add:

```ts
  /** One player's endorse panel for one match: who they may endorse, what
   *  they already gave, what is left. Their own choices only. */
  app.get('/api/matches/:id/endorse', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return endorseState(db, Number((req.params as { id: string }).id), steamid);
  });

  /** Give one endorsement. The giver is the session and never the body, so a
   *  body naming somebody else as `from` is ignored. A test pins that. Every
   *  rule is enforced in src/endorsements.ts, which the Discord button calls
   *  as well. Not rate limited: nothing on this site is yet (September audit),
   *  and this belongs in that work when it lands. */
  app.post('/api/matches/:id/endorse', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const matchId = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { to?: unknown; kind?: unknown };
    if (typeof body.to !== 'string' || typeof body.kind !== 'string') {
      return reply.code(400).send({ error: 'to and kind are required', code: 'bad_kind' });
    }
    const r = Number.isInteger(matchId)
      ? giveEndorsement(db, { matchId, from: steamid, to: body.to, kind: body.kind })
      : { ok: false as const, error: 'no_match' as const };
    if (!r.ok) return reply.code(400).send({ error: ENDORSE_ERROR_TEXT[r.error], code: r.error });
    return { ok: true, remaining: r.remaining, state: endorseState(db, matchId, steamid) };
  });

  /** Recent matches this player can still endorse on, for the quiet bar. */
  app.get('/api/endorse/pending', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return { pending: pendingEndorsements(db, steamid) };
  });
```

The bare `return;` after a failed guard is the convention in `src/routes/api.ts`: the guard has already sent the 401 or 403.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/endorseApi.test.ts tests/playerQueries.test.ts tests/profileApi.test.ts tests/http-e2e.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/stats.ts src/playerQueries.ts tests/endorseApi.test.ts
git commit -m "Serve endorsements over HTTP and put titles on the read models" -m "Three authenticated routes: the panel state, giving one, and what is still unspent. The giver is always the session. Profiles gain anonymous counts and the title; the match page and the leaderboard gain the title alone, because the title is the part that travels."
```

---

### Task 5: The Endorse button and ephemeral flow on Discord

**Files:**
- Modify: `src/discord/presenter.ts`, `src/discord/controller.ts`, `src/discord/djsTransport.ts`
- Test: `tests/discordPresenter.test.ts`, `tests/discordController.test.ts` (append to both)

**Interfaces:**
- Consumes from `src/endorsements.ts` (Task 3): `ENDORSE_KINDS`, `ENDORSE_LABEL`, `ENDORSE_ERROR_TEXT`, `type EndorseKind`, `endorseState(db, matchId, steamid)`, `giveEndorsement(db, { matchId, from, to, kind })`.
- Produces:
  - `renderResult` posts a second button, custom id `m:<matchId>:endorse`, label `Endorse`.
  - `renderEndorsePicker(v: EndorsePickerView): MessagePayload` and `renderEndorseKinds(v: { matchId: number; steamid: string; name: string }): MessagePayload`.
  - Custom id scheme additions: `m:<matchId>:endorse` opens (or returns to) the picker, `e:<matchId>:p:<steamid>` picks a player, `e:<matchId>:k:<steamid>:<kind>` gives the endorsement.
  - A button pressed on an ephemeral message edits that message in place.

- [ ] **Step 1: Write the failing presenter tests**

Append to `tests/discordPresenter.test.ts` (add `renderEndorsePicker, renderEndorseKinds` to the existing import from `../src/discord/presenter.js`; `renderResult` is already imported there, add it if it is not):

```ts
describe('endorse flow payloads', () => {
  const cands = (n: number) => Array.from({ length: n }, (_, i) => ({
    steamid: `7656119800000000${i + 2}`, name: `p${i}`, given: null,
  }));

  it('the result card carries an Endorse button beside the match page link', () => {
    const p = renderResult({
      matchId: 7, campaignName: 'No Mercy', publicUrl: 'https://pug.test',
      scoreA: 10, scoreB: 5, winner: 'a', teamA: [], teamB: [],
    });
    const row = p.components[0];
    expect(row).toHaveLength(2);
    expect(row[0]).toMatchObject({ kind: 'link', label: 'Match page' });
    expect(row[1]).toEqual({ kind: 'button', customId: 'm:7:endorse', label: 'Endorse', style: 'secondary' });
  });

  it('the picker fits seven players into two rows of at most five', () => {
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 2, candidates: cands(7) });
    expect(p.components.map((r) => r.length)).toEqual([5, 2]);
    expect(p.components.flat().every((b) => b.kind === 'button' && b.customId.startsWith('e:7:p:'))).toBe(true);
    expect(p.content).toContain('2 of 2');
    expect(p.embeds).toEqual([]);
    expect(p.mentionUserIds).toEqual([]);
  });

  it('shows what was already given and locks that player', () => {
    const list = cands(7);
    list[0] = { ...list[0], given: 'caller' };
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 1, candidates: list, notice: 'Endorsed p0 as Caller.' });
    const first = p.components[0][0];
    expect(first).toMatchObject({ kind: 'button', label: 'p0: Caller', disabled: true, style: 'success' });
    expect(p.components[0][1]).toMatchObject({ disabled: false });
    expect(p.content?.startsWith('Endorsed p0 as Caller.')).toBe(true);
  });

  it('locks everything once the budget is spent', () => {
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 0, candidates: cands(7) });
    expect(p.components.flat().every((b) => b.kind === 'button' && b.disabled === true)).toBe(true);
    expect(p.content).toMatch(/given all/i);
  });

  it('never lets a long name break the 80 character label limit', () => {
    const p = renderEndorsePicker({
      matchId: 7, budget: 2, remaining: 2,
      candidates: [{ steamid: '76561198000000002', name: 'x'.repeat(200), given: null }],
    });
    const b = p.components[0][0];
    expect(b.kind === 'button' && b.label.length).toBe(80);
  });

  it('the kind step offers exactly the three kinds and a way back, and no negative one', () => {
    const p = renderEndorseKinds({ matchId: 7, steamid: '76561198000000002', name: 'b*ob' });
    expect(p.components).toHaveLength(1);
    expect(p.components[0].map((b) => (b.kind === 'button' ? b.customId : ''))).toEqual([
      'e:7:k:76561198000000002:caller', 'e:7:k:76561198000000002:clutch', 'e:7:k:76561198000000002:vibes', 'm:7:endorse',
    ]);
    expect(p.components[0].map((b) => b.label)).toEqual(['Caller', 'Clutch', 'Good vibes', 'Back']);
    // Names are user text and the content is markdown.
    expect(p.content).toContain('b\\*ob');
  });
});
```

- [ ] **Step 2: Write the failing controller tests**

Append to `tests/discordController.test.ts`:

```ts
describe('endorse buttons', () => {
  const STRANGER_SID = '76561198000000099';

  function seedCompleted(id: number, hoursAgo = 0): void {
    db.prepare(
      `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
       VALUES (?, 1, 'completed', 'no_mercy', 'a', datetime('now', ?))`,
    ).run(id, `-${hoursAgo} hours`);
    IDS.forEach((p, i) => {
      db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
    });
  }
  const given = () => db.prepare('SELECT match_id, from_id, to_id, kind FROM endorsements ORDER BY to_id').all();
  const ids = (r: InteractionReply) => r.payload.components.flat().map((b) => (b.kind === 'button' ? b.customId : ''));

  it('opens a private picker of the seven other players', async () => {
    seedCompleted(5);
    const r = await press(0, 'm:5:endorse');
    expect(r.ephemeral).toBe(true);
    expect(ids(r)).toHaveLength(7);
    expect(ids(r)).not.toContain(`e:5:p:${IDS[0]}`);
  });

  it('pick a player, pick a kind, and it is recorded against the LINKED player', async () => {
    seedCompleted(5);
    const kinds = await press(0, `e:5:p:${IDS[5]}`);
    expect(ids(kinds)).toContain(`e:5:k:${IDS[5]}:clutch`);
    const after = await press(0, `e:5:k:${IDS[5]}:clutch`);
    expect(given()).toEqual([{ match_id: 5, from_id: IDS[0], to_id: IDS[5], kind: 'clutch' }]);
    // Back on the picker, in place, showing what remains.
    expect(body(after)).toContain('1 of 2');
    expect(body(after)).toContain('Clutch');
  });

  it('tells somebody who was not on the roster so, and changes nothing', async () => {
    seedCompleted(5);
    upsertPlayer(db, { steamid: STRANGER_SID, name: 'stranger', avatar: null }, []);
    activatePlayer(db, STRANGER_SID);
    linkDiscord(db, STRANGER_SID, 'd-stranger', 'stranger');
    const hit = (customId: string) => handleButton(
      { db, matchmaker: mm, publicUrl: URL_ }, { kind: 'button', customId, userId: 'd-stranger', userName: 'stranger' },
    );
    expect(body(await hit('m:5:endorse'))).toMatch(/not in this match/i);
    expect(body(await hit(`e:5:k:${IDS[5]}:clutch`))).toMatch(/not in this match/i);
    expect(given()).toEqual([]);
  });

  it('an unlinked Discord user is asked to link, and nothing is written', async () => {
    seedCompleted(5);
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_ },
      { kind: 'button', customId: `e:5:k:${IDS[5]}:clutch`, userId: 'nobody', userName: 'Nobody' },
    );
    expect(r.payload.components.flat().some((b) => b.kind === 'link' && b.url.includes('/link/discord'))).toBe(true);
    expect(given()).toEqual([]);
  });

  it('a third click cannot overspend the budget', async () => {
    seedCompleted(5);
    await press(0, `e:5:k:${IDS[1]}:caller`);
    await press(0, `e:5:k:${IDS[2]}:caller`);
    const third = await press(0, `e:5:k:${IDS[3]}:caller`);
    expect(given()).toHaveLength(2);
    expect(body(third)).toMatch(/no endorsements left/i);
  });

  it('says so when the window has closed', async () => {
    seedCompleted(5, 30);
    expect(body(await press(0, 'm:5:endorse'))).toMatch(/closed/i);
  });

  it('cannot be aimed at oneself through a crafted custom id', async () => {
    seedCompleted(5);
    await press(0, `e:5:k:${IDS[0]}:caller`);
    expect(given()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/discordPresenter.test.ts tests/discordController.test.ts`
Expected: FAIL on the new cases only (the renderers do not exist; `m:5:endorse` is treated as unknown).

- [ ] **Step 4: Presenter**

In `src/discord/presenter.ts`, add below the existing import:

```ts
import { ENDORSE_KINDS, ENDORSE_LABEL, type EndorseKind } from '../endorsements.js';
```

(That module exports constants and functions with no import-time side effects, so the presenter stays pure: nothing here calls into it for data.)

In `renderResult`, replace the `components:` line with:

```ts
    // Endorse rides the card the bot already posts, and everything after the
    // click is ephemeral. No DM, nothing added to the channel: a player who
    // never clicks it is never contacted about it.
    components: [[
      link(`${v.publicUrl}/match/${v.matchId}`, 'Match page'),
      { kind: 'button', customId: `m:${v.matchId}:endorse`, label: 'Endorse', style: 'secondary' },
    ]],
```

At the end of the file, add:

```ts
// ---------- endorsements (ephemeral) ----------

export interface EndorsePickerView {
  matchId: number;
  budget: number;
  remaining: number;
  /** What just happened, shown above the prompt. Already safe to print. */
  notice?: string;
  candidates: { steamid: string; name: string; given: EndorseKind | null }[];
}

/** Discord refuses a button label over 80 characters. */
const LABEL_MAX = 80;

/**
 * The seven other players as buttons. Seven is two rows, well inside
 * Discord's five by five, so this needs no new component type.
 *
 * Button labels are plain text, not markdown, so names are not escaped here.
 */
export function renderEndorsePicker(v: EndorsePickerView): MessagePayload {
  const head = v.remaining > 0
    ? `**Endorse players from PUG #${v.matchId}.** ${v.remaining} of ${v.budget} left. It is anonymous: nobody is told who endorsed them.`
    : `You have given all your endorsements for PUG #${v.matchId}. Thanks.`;
  const rows: ActionRow[] = [];
  for (let i = 0; i < v.candidates.length && rows.length < 5; i += 5) {
    rows.push(v.candidates.slice(i, i + 5).map((c) => ({
      kind: 'button' as const,
      customId: `e:${v.matchId}:p:${c.steamid}`,
      label: (c.given ? `${c.name || c.steamid}: ${ENDORSE_LABEL[c.given]}` : (c.name || c.steamid)).slice(0, LABEL_MAX),
      style: c.given ? 'success' as const : 'secondary' as const,
      disabled: c.given !== null || v.remaining <= 0,
    })));
  }
  return {
    content: v.notice ? `${v.notice}\n${head}` : head,
    embeds: [],
    components: rows,
    mentionUserIds: [],
  };
}

/** Step two: which kind. There is no negative option, by design. */
export function renderEndorseKinds(v: { matchId: number; steamid: string; name: string }): MessagePayload {
  return {
    content: `Endorse **${escapeName(v.name)}** for:`,
    embeds: [],
    components: [[
      ...ENDORSE_KINDS.map((k) => ({
        kind: 'button' as const, customId: `e:${v.matchId}:k:${v.steamid}:${k}`, label: ENDORSE_LABEL[k], style: 'primary' as const,
      })),
      { kind: 'button' as const, customId: `m:${v.matchId}:endorse`, label: 'Back', style: 'secondary' as const },
    ]],
    mentionUserIds: [],
  };
}
```

- [ ] **Step 5: Controller**

In `src/discord/controller.ts`, add imports:

```ts
import { ENDORSE_ERROR_TEXT, ENDORSE_LABEL, endorseState, giveEndorsement } from '../endorsements.js';
import { escapeName, renderEndorseKinds, renderEndorsePicker } from './presenter.js';
```

Extend the custom id comment above `handleButton` so the scheme line reads:

```ts
 * custom_id scheme: q:join, q:leave, l:<lobbyId>:ready,
 * l:<lobbyId>:vote:<campaign>, m:<matchId>:connect, m:<matchId>:endorse,
 * e:<matchId>:p:<steamid>, e:<matchId>:k:<steamid>:<kind>.
```

Replace the `known` expression with:

```ts
  const known = (parts[0] === 'q' && (parts[1] === 'join' || parts[1] === 'leave' || parts[1] === 'notify'))
    || (parts[0] === 'l' && parts.length >= 3)
    || (parts[0] === 'm' && (parts[2] === 'connect' || parts[2] === 'spectate' || parts[2] === 'endorse'))
    || (parts[0] === 'e' && parts.length >= 4 && (parts[2] === 'p' || parts[2] === 'k'));
```

Directly after the closing brace of the `if (parts[0] === 'l') { ... }` block, add:

```ts
  // Endorsements. `steamid` is the LINKED player resolve() found, which is the
  // only identity these calls ever see: the Discord id alone authorises
  // nothing, and the steamid inside the custom id is only ever the RECIPIENT,
  // which giveEndorsement checks against the roster like any other input.
  if (parts[0] === 'm' && parts[2] === 'endorse') return endorsePicker(deps, Number(parts[1]), steamid);
  if (parts[0] === 'e') {
    const endorseMatch = Number(parts[1]);
    const target = parts[3];
    if (parts[2] === 'p') {
      const st = endorseState(deps.db, endorseMatch, steamid);
      if (!st.eligible) return say(ENDORSE_ERROR_TEXT[st.reason ?? 'no_match']);
      const c = st.candidates.find((x) => x.steamid === target);
      if (!c) return say(ENDORSE_ERROR_TEXT.target_not_rostered);
      const already = st.given.some((g) => g.to === target);
      if (st.remaining <= 0 || already) return endorsePicker(deps, endorseMatch, steamid);
      return { ephemeral: true, payload: renderEndorseKinds({ matchId: endorseMatch, steamid: target, name: c.name }) };
    }
    const r = giveEndorsement(deps.db, { matchId: endorseMatch, from: steamid, to: target, kind: parts[4] ?? '' });
    if (!r.ok) return endorsePicker(deps, endorseMatch, steamid, ENDORSE_ERROR_TEXT[r.error]);
    const st = endorseState(deps.db, endorseMatch, steamid);
    const name = st.candidates.find((x) => x.steamid === target)?.name ?? 'them';
    const kind = st.given.find((g) => g.to === target)?.kind;
    return endorsePicker(
      deps, endorseMatch, steamid,
      `Endorsed ${escapeName(name)}${kind ? ` as ${ENDORSE_LABEL[kind]}` : ''}.`,
    );
  }
```

At the end of the file, add:

```ts
/** The picker, or the sentence explaining why this player gets none. */
function endorsePicker(deps: ControllerDeps, matchId: number, steamid: string, notice?: string): InteractionReply {
  const st = endorseState(deps.db, matchId, steamid);
  if (!st.eligible) return say(ENDORSE_ERROR_TEXT[st.reason ?? 'no_match']);
  const given = new Map(st.given.map((g) => [g.to, g.kind]));
  return {
    ephemeral: true,
    payload: renderEndorsePicker({
      matchId, budget: st.budget, remaining: st.remaining, notice,
      candidates: st.candidates.map((c) => ({ steamid: c.steamid, name: c.name, given: given.get(c.steamid) ?? null })),
    }),
  };
}
```

- [ ] **Step 6: Transport, edit an ephemeral in place**

In `src/discord/djsTransport.ts`, in the `if (i.isButton()) {` branch, replace the comment and the `await i.deferReply(...)` line, and the `await i.editReply(...)` line, so the branch reads:

```ts
      if (i.isButton()) {
        // Every button reply is private; defer first so a slow handler never
        // blows Discord's three second window.
        //
        // A button that sits on one of our OWN ephemeral replies (the endorse
        // picker) updates that reply in place rather than stacking a new one
        // under it: pick a player, pick a kind, and the same message shows what
        // remains. Buttons on public cards keep getting a fresh private reply.
        const inPlace = i.message.flags.has(MessageFlags.Ephemeral);
        if (inPlace) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await handler({
          kind: 'button', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
        });
        const m = toMessage(reply.payload);
        // In place, an absent content must CLEAR the old text, and undefined
        // means "leave it as it was" to Discord.
        await i.editReply({ content: inPlace ? (m.content ?? '') : (m.content || undefined), embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
      } else if (i.isChatInputCommand()) {
```

Leave everything else in that handler as it is. This file is the only one that imports discord.js and has no unit test; `npm run typecheck` is its check here, and it is exercised for real the first time somebody presses Endorse.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/discordPresenter.test.ts tests/discordController.test.ts tests/discordSync.test.ts tests/discordBot.test.ts`
Expected: PASS. If an existing assertion in `tests/discordSync.test.ts` or `tests/discordPresenter.test.ts` pinned the result card to exactly one button, update it to expect the link and the Endorse button; do not loosen it to "at least one".

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/discord/presenter.ts src/discord/controller.ts src/discord/djsTransport.ts tests/discordPresenter.test.ts tests/discordController.test.ts tests/discordSync.test.ts
git commit -m "Let players endorse from the Discord result card" -m "The result card gains an Endorse button. Everything after the click is one ephemeral reply edited in place: pick one of the seven other players, pick a kind, see what remains. No DM and nothing added to the channel. The controller only ever acts as the linked player, and the steamid in a custom id is only ever a recipient, checked against the roster like any other input."
```

(Leave out any test file that did not change.)

---

### Task 6: Endorse panel on the match page and the quiet bar

**Files:**
- Create: `web/src/endorse.ts`, `web/src/components/EndorsePanel.tsx`, `web/src/components/EndorseBar.tsx`
- Modify: `web/src/api.ts`, `web/src/routes/MatchDetail.tsx`, `web/src/main.tsx`, `web/src/styles/app.css`
- Test: `web/src/components/EndorsePanel.test.tsx`, `web/src/components/EndorseBar.test.tsx`

**Interfaces:**
- Consumes the Task 4 routes: `GET /api/matches/:id/endorse` returns `EndorseState`; `POST /api/matches/:id/endorse` body `{ to, kind }` returns `{ ok: true; remaining: number; state: EndorseState }` or throws `ApiError` whose `message` is the server's sentence; `GET /api/endorse/pending` returns `{ pending: { matchId: number; remaining: number }[] }`.
- Produces: `EndorseKind`, `EndorseState`, `PendingEndorsement` types and `api.endorseState`, `api.endorse`, `api.endorsePending` in `web/src/api.ts`; `ENDORSE_KINDS`, `ENDORSE_LABEL`, `hoursLeft` in `web/src/endorse.ts`; components `EndorsePanel({ matchId })` and `EndorseBar({ me, path })`.

- [ ] **Step 1: Types, api calls and the shared constants**

In `web/src/api.ts`, add directly above `export interface ChemistryLine` (from Task 2):

```ts
export type EndorseKind = 'caller' | 'clutch' | 'vibes';

/** One player's endorse panel for one match. `given` is the viewer's OWN
 *  choices; nothing anywhere says who endorsed whom. */
export interface EndorseState {
  eligible: boolean;
  reason: string | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  closesAt: string | null;
  budget: number;
  remaining: number;
  given: { to: string; kind: EndorseKind }[];
  candidates: { steamid: string; name: string; team: Team }[];
}

export interface PendingEndorsement { matchId: number; remaining: number }
```

In the `export const api = {` object, add after the `match:` entry:

```ts
  endorseState: (matchId: number, signal?: AbortSignal) =>
    get<EndorseState>(`/api/matches/${matchId}/endorse`, signal),
  endorse: (matchId: number, to: string, kind: EndorseKind) =>
    post<{ ok: true; remaining: number; state: EndorseState }>(`/api/matches/${matchId}/endorse`, { to, kind }),
  endorsePending: (signal?: AbortSignal) =>
    get<{ pending: PendingEndorsement[] }>('/api/endorse/pending', signal),
```

Create `web/src/endorse.ts`:

```ts
import type { EndorseKind } from './api';

/** Mirrors src/endorsements.ts. There is no negative kind, by design. */
export const ENDORSE_KINDS: EndorseKind[] = ['caller', 'clutch', 'vibes'];

export const ENDORSE_LABEL: Record<EndorseKind, string> = {
  caller: 'Caller',
  clutch: 'Clutch',
  vibes: 'Good vibes',
};

/** Whole hours until a server timestamp (UTC, `YYYY-MM-DD HH:MM:SS`), never
 *  below zero. Null when the timestamp is missing or unreadable. */
export function hoursLeft(closesAt: string | null, nowMs: number = Date.now()): number | null {
  if (!closesAt) return null;
  const t = Date.parse(`${closesAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 3_600_000));
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/components/EndorsePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { EndorseState } from '../api';
import { hoursLeft } from '../endorse';

const { mockApi } = vi.hoisted(() => ({ mockApi: { endorseState: vi.fn(), endorse: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { EndorsePanel } = await import('./EndorsePanel');

const state = (over: Partial<EndorseState> = {}): EndorseState => ({
  eligible: true, reason: null, closesAt: '2099-01-01 00:00:00', budget: 2, remaining: 2, given: [],
  candidates: [
    { steamid: '76561198000000002', name: 'ann', team: 'a' },
    { steamid: '76561198000000003', name: 'bob', team: 'b' },
  ],
  ...over,
});

beforeEach(() => { mockApi.endorseState.mockResolvedValue(state()); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EndorsePanel', () => {
  it('offers the three kinds for each other player, and no negative one', async () => {
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Caller' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Clutch' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Good vibes' })).toHaveLength(2);
    expect(screen.getByText(/2 of 2 left/)).toBeTruthy();
    expect(screen.getByText(/anonymous/i)).toBeTruthy();
  });

  it('renders nothing for a viewer who may not endorse here', async () => {
    mockApi.endorseState.mockResolvedValue(state({ eligible: false, reason: 'not_rostered', candidates: [] }));
    const { container } = render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(mockApi.endorseState).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the request fails, such as for a signed-out viewer', async () => {
    mockApi.endorseState.mockRejectedValue(new Error('401'));
    const { container } = render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(mockApi.endorseState).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('gives one on a click and redraws from the state the server sends back', async () => {
    mockApi.endorse.mockResolvedValue({
      ok: true, remaining: 1,
      state: state({ remaining: 1, given: [{ to: '76561198000000002', kind: 'clutch' }] }),
    });
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Clutch' })[0]);
    await waitFor(() => expect(screen.getByText(/1 of 2 left/)).toBeTruthy());
    expect(mockApi.endorse).toHaveBeenCalledWith(7, '76561198000000002', 'clutch');
    // ann is settled: her row shows the kind and offers no more buttons.
    expect(screen.getAllByRole('button', { name: 'Clutch' })).toHaveLength(1);
  });

  it('locks the remaining players once the budget is spent', async () => {
    mockApi.endorseState.mockResolvedValue(state({ remaining: 0, given: [{ to: '76561198000000002', kind: 'caller' }] }));
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Clutch' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/given all/i)).toBeTruthy();
  });

  it('shows the server sentence when a click is refused', async () => {
    mockApi.endorse.mockRejectedValue(new Error('Endorsing for this match has closed.'));
    render(<EndorsePanel matchId={7} />);
    await waitFor(() => expect(screen.getByText('ann')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Caller' })[0]);
    await waitFor(() => expect(screen.getByText('Endorsing for this match has closed.')).toBeTruthy());
  });
});

describe('hoursLeft', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it('reads the server timestamp as UTC and rounds up', () => {
    expect(hoursLeft('2026-09-21 14:30:00', now)).toBe(3);
  });
  it('never goes below zero, and is null for nothing', () => {
    expect(hoursLeft('2026-09-20 00:00:00', now)).toBe(0);
    expect(hoursLeft(null, now)).toBeNull();
    expect(hoursLeft('garbage', now)).toBeNull();
  });
});
```

Create `web/src/components/EndorseBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { endorsePending: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));

const { EndorseBar } = await import('./EndorseBar');

beforeEach(() => {
  localStorage.clear();
  mockApi.endorsePending.mockResolvedValue({ pending: [{ matchId: 12, remaining: 2 }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EndorseBar', () => {
  it('asks nothing and shows nothing for a signed-out viewer', () => {
    const { container } = render(<EndorseBar me={null} path="/" />);
    expect(mockApi.endorsePending).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('links to the match you can still endorse on', async () => {
    render(<EndorseBar me="76561198000000001" path="/leaderboard" />);
    const a = await waitFor(() => screen.getByRole('link'));
    expect(a.getAttribute('href')).toBe('/match/12#endorse');
    expect(a.textContent).toMatch(/2 endorsements to give from PUG #12/);
  });

  it('says "1 endorsement", not "1 endorsements"', async () => {
    mockApi.endorsePending.mockResolvedValue({ pending: [{ matchId: 12, remaining: 1 }] });
    render(<EndorseBar me="76561198000000001" path="/" />);
    const a = await waitFor(() => screen.getByRole('link'));
    expect(a.textContent).toMatch(/1 endorsement to give/);
  });

  it('stays out of the way on the match page it points at', async () => {
    const { container } = render(<EndorseBar me="76561198000000001" path="/match/12" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalled());
    expect(container.querySelector('.endorsebar')).toBeNull();
  });

  it('can be dismissed for that match, and stays dismissed', async () => {
    const first = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => screen.getByRole('link'));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(first.container.querySelector('.endorsebar')).toBeNull();
    cleanup();
    const second = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalledTimes(2));
    expect(second.container.querySelector('.endorsebar')).toBeNull();
  });

  it('shows nothing when the request fails', async () => {
    mockApi.endorsePending.mockRejectedValue(new Error('403'));
    const { container } = render(<EndorseBar me="76561198000000001" path="/" />);
    await waitFor(() => expect(mockApi.endorsePending).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/EndorsePanel.test.tsx web/src/components/EndorseBar.test.tsx`
Expected: FAIL, cannot resolve `./EndorsePanel` and `./EndorseBar`.

- [ ] **Step 4: The panel**

Create `web/src/components/EndorsePanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type EndorseKind, type EndorseState } from '../api';
import { ENDORSE_KINDS, ENDORSE_LABEL, hoursLeft } from '../endorse';
import { Panel } from './bits';

/**
 * The same endorse panel the Discord result card opens, on the match page.
 *
 * It is a panel on a page somebody chose to open, not a notification. A
 * viewer who may not endorse here (signed out, not on the roster, window
 * closed) gets no panel at all rather than an explanation of a feature they
 * cannot use.
 *
 * Anonymous by construction: `given` is the viewer's own choices, and that is
 * the only giver-side fact the server ever sends anybody.
 */
export function EndorsePanel({ matchId }: { matchId: number }) {
  const [state, setState] = useState<EndorseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setState(null);
    api.endorseState(matchId, ac.signal).then(setState).catch(() => setState(null));
    return () => ac.abort();
  }, [matchId]);

  // The quiet bar links here as /match/N#endorse. The panel arrives after the
  // page, so the browser's own jump to the fragment has already missed it.
  const eligible = state?.eligible === true;
  useEffect(() => {
    if (eligible && window.location.hash === '#endorse') root.current?.scrollIntoView?.({ block: 'center' });
  }, [eligible]);

  if (!state || !state.eligible) return null;

  const givenTo = new Map(state.given.map((g) => [g.to, g.kind]));
  const left = hoursLeft(state.closesAt);

  const give = async (to: string, kind: EndorseKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.endorse(matchId, to, kind);
      setState(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that endorsement.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="endorse" ref={root}>
      <Panel>
        <h3>Endorse your lobby</h3>
        <p class="muted">
          {state.remaining > 0
            ? `${state.remaining} of ${state.budget} left.`
            : 'You have given all your endorsements for this match.'}
          {' '}It is anonymous: nobody sees who endorsed them.
          {left !== null && state.remaining > 0 ? ` Closes in about ${left} hour${left === 1 ? '' : 's'}.` : ''}
        </p>
        {error && <p class="endorse__error" role="alert">{error}</p>}
        <ul class="endorse">
          {state.candidates.map((c) => {
            const kind = givenTo.get(c.steamid);
            return (
              <li class="endorse__row" key={c.steamid}>
                <span class="endorse__name">{c.name}</span>
                {kind
                  ? <span class={`titletag titletag--${kind}`}>{ENDORSE_LABEL[kind]}</span>
                  : (
                    <span class="endorse__kinds">
                      {ENDORSE_KINDS.map((k) => (
                        <button
                          type="button" class="chip" key={k}
                          disabled={busy || state.remaining <= 0}
                          onClick={() => give(c.steamid, k)}
                        >
                          {ENDORSE_LABEL[k]}
                        </button>
                      ))}
                    </span>
                  )}
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
```

- [ ] **Step 5: The bar**

Create `web/src/components/EndorseBar.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { api, type PendingEndorsement } from '../api';

const KEY = 'endorse-dismissed';

/** Match ids the viewer waved away. localStorage can throw (private window,
 *  blocked site data), and a bar that cannot remember is still a bar. */
function readDismissed(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * One quiet line when you have unspent endorsements from a recent match.
 *
 * Not a notification: it only exists on a page you already opened, it goes
 * away for good when dismissed, and it never appears for anybody who has
 * nothing to give. Asked again on each navigation because that is when a
 * match you just finished becomes endorsable; the query is one indexed read.
 */
export function EndorseBar({ me, path }: { me: string | null; path: string }) {
  const [pending, setPending] = useState<PendingEndorsement[]>([]);
  const [dismissed, setDismissed] = useState<number[]>(readDismissed);

  useEffect(() => {
    if (!me) { setPending([]); return undefined; }
    const ac = new AbortController();
    api.endorsePending(ac.signal).then((r) => setPending(r.pending)).catch(() => setPending([]));
    return () => ac.abort();
  }, [me, path]);

  if (!me) return null;
  const next = pending.find((p) => !dismissed.includes(p.matchId) && path !== `/match/${p.matchId}`);
  if (!next) return null;

  const dismiss = () => {
    // Capped so the list cannot grow for ever; old ids are long past their
    // window and would never be offered again anyway.
    const ids = [...dismissed, next.matchId].slice(-50);
    setDismissed(ids);
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* remembered for this visit only */ }
  };

  return (
    <div class="endorsebar">
      <a href={`/match/${next.matchId}#endorse`}>
        You have {next.remaining} endorsement{next.remaining === 1 ? '' : 's'} to give from PUG #{next.matchId}
      </a>
      <button type="button" class="endorsebar__dismiss" aria-label="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
```

- [ ] **Step 6: Mount both**

In `web/src/routes/MatchDetail.tsx`, add the import beside the other component imports:

```tsx
import { EndorsePanel } from '../components/EndorsePanel';
```

and directly after the closing `/>` of the `<VersusHeader ... />` element, add:

```tsx
      {/* Completed matches only, and only for a signed-in viewer: the panel
          asks the server whether THIS viewer may endorse here, and renders
          nothing when they may not. */}
      {match.state === 'completed' && me && <EndorsePanel matchId={match.id} />}
```

(`me` is already a prop of `MatchDetail`, passed from `main.tsx`. If the component destructures its props without `me`, add it to the destructuring.)

In `web/src/main.tsx`, add the import:

```tsx
import { EndorseBar } from './components/EndorseBar';
```

and directly after `<QueueBar state={state} path={path} />` add:

```tsx
      <EndorseBar me={me} path={path} />
```

- [ ] **Step 7: Styles**

Append to `web/src/styles/app.css`:

```css
/* ---------- endorsements ---------- */

.endorse { list-style: none; margin: var(--sp-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.endorse__row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.endorse__name { font-weight: 600; }
.endorse__kinds { display: inline-flex; gap: var(--sp-2); flex-wrap: wrap; }
.endorse__error { color: var(--loss, #c0392b); margin: var(--sp-2) 0 0; }

.endorsebar { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); padding: var(--sp-1) var(--sp-4); font-size: var(--fs-dense); border-bottom: 1px solid var(--border); }
.endorsebar__dismiss { background: none; border: 0; color: var(--text-muted); cursor: pointer; font-size: inherit; padding: 0 var(--sp-1); }
.endorsebar__dismiss:hover { color: var(--text-bright); }

/* The earned word beside a name. Also used inside the endorse panel for a
   choice already made. One neutral treatment for all three kinds: the word is
   the payoff, and three colours would turn rosters into confetti. */
.titletag { display: inline-block; font-family: var(--font-label); font-size: var(--fs-label); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: 2px; padding: 0 var(--sp-1); margin-left: var(--sp-2); vertical-align: middle; white-space: nowrap; }
```

Before committing, open `web/src/styles/app.css` and confirm each custom property used above (`--sp-1`, `--sp-2`, `--sp-3`, `--sp-4`, `--fs-dense`, `--fs-label`, `--font-label`, `--border`, `--border-strong`, `--text-muted`, `--text-bright`) is defined in its `:root`. `--loss` has a literal fallback because its name was not verified; if the stylesheet defines a loss or danger colour token under another name, use that token instead of the fallback.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run web/src/components/EndorsePanel.test.tsx web/src/components/EndorseBar.test.tsx web/src/routes/routes.test.tsx`
Expected: PASS.

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/endorse.ts web/src/components/EndorsePanel.tsx web/src/components/EndorsePanel.test.tsx web/src/components/EndorseBar.tsx web/src/components/EndorseBar.test.tsx web/src/routes/MatchDetail.tsx web/src/main.tsx web/src/styles/app.css
git commit -m "Add the endorse panel to the match page and a quiet reminder bar" -m "The match page carries the same panel the Discord card opens, one click per endorsement, redrawn from the state the server sends back. A one line bar appears when you have unspent endorsements from a recent match; it can be dismissed per match and never shows for anybody with nothing to give. Viewers who may not endorse see neither."
```

---

### Task 7: Titles beside names, and endorsement counts on the profile

**Files:**
- Create: `web/src/components/TitleTag.tsx`
- Modify: `web/src/api.ts`, `web/src/components/Headliner.tsx`, `web/src/components/StatTable.tsx`, `web/src/routes/Profile.tsx`, `web/src/routes/MatchDetail.tsx`, `web/src/routes/Leaderboard.tsx`
- Test: `web/src/components/TitleTag.test.tsx`, `web/src/components/Headliner.test.tsx` (append)

**Interfaces:**
- Consumes from Task 4: `Profile.endorsements = { counts: Record<EndorseKind, number>; total: number; perMatch: number; title: EndorseKind | null }`; `title: EndorseKind | null` on each leaderboard row and each match player. From Task 6: `EndorseKind` in `web/src/api.ts`, `ENDORSE_LABEL` and `ENDORSE_KINDS` in `web/src/endorse.ts`, the `.titletag` class in `app.css`.
- Produces: `TitleTag({ kind })`, `EndorsementCounts({ endorsements })`; `Headliner` accepts `title`; `StatRow` accepts `title`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/TitleTag.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { TitleTag, EndorsementCounts } from './TitleTag';

afterEach(cleanup);

describe('TitleTag', () => {
  it('is a word, not a number', () => {
    render(<TitleTag kind="vibes" />);
    expect(screen.getByText('Good vibes').classList.contains('titletag')).toBe(true);
  });

  it('renders nothing without a title', () => {
    expect(render(<TitleTag kind={null} />).container.innerHTML).toBe('');
    expect(render(<TitleTag />).container.innerHTML).toBe('');
  });
});

describe('EndorsementCounts', () => {
  it('shows a count per kind and the per match rate', () => {
    render(<EndorsementCounts endorsements={{ counts: { caller: 17, clutch: 4, vibes: 9 }, total: 30, perMatch: 0.42, title: 'caller' }} />);
    expect(screen.getByText('Caller')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('Good vibes')).toBeTruthy();
    expect(screen.getByText('0.42')).toBeTruthy();
  });

  it('renders nothing until somebody has been endorsed', () => {
    const none = { counts: { caller: 0, clutch: 0, vibes: 0 }, total: 0, perMatch: 0, title: null };
    expect(render(<EndorsementCounts endorsements={none} />).container.innerHTML).toBe('');
    expect(render(<EndorsementCounts endorsements={undefined} />).container.innerHTML).toBe('');
  });
});
```

Append to `web/src/components/Headliner.test.tsx`, inside the existing `describe('Headliner', ...)`:

```tsx
  it('shows an earned title beside the name, and nothing when there is none', () => {
    const { rerender } = render(<Headliner eyebrow="Rating" name="bob" rating={1000} stats={[]} title="caller" />);
    expect(screen.getByText('Caller').classList.contains('titletag')).toBe(true);
    rerender(<Headliner eyebrow="Rating" name="bob" rating={1000} stats={[]} />);
    expect(screen.queryByText('Caller')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/components/TitleTag.test.tsx web/src/components/Headliner.test.tsx`
Expected: FAIL, cannot resolve `./TitleTag`, and `Headliner` has no `title` prop.

- [ ] **Step 3: Types**

In `web/src/api.ts`:

Inside `export interface LeaderboardRow {`, add:

```ts
  /** The endorsement title they have earned, if any. */
  title?: EndorseKind | null;
```

Inside `export interface MatchPlayerStats {`, add:

```ts
  /** The endorsement title they have earned, if any. */
  title?: EndorseKind | null;
```

Directly above `export interface Profile {`, add:

```ts
/** Aggregate and anonymous: what was received, never from whom. */
export interface EndorsementSummary {
  counts: Record<EndorseKind, number>;
  total: number;
  perMatch: number;
  title: EndorseKind | null;
}
```

and inside `export interface Profile {`, as a sibling of `chemistry`:

```ts
  /** Optional only for a server older than the feature. */
  endorsements?: EndorsementSummary;
```

- [ ] **Step 4: The components**

Create `web/src/components/TitleTag.tsx`:

```tsx
import type { EndorseKind, EndorsementSummary } from '../api';
import { ENDORSE_KINDS, ENDORSE_LABEL } from '../endorse';
import { Panel } from './bits';

/**
 * The word a player has earned from endorsements, beside their name.
 *
 * The payoff is a word, not a number: "Caller" under somebody's name is worth
 * more to them than a count, and it lets a newer player read a roster. The
 * counts stay on the profile; this is the part that travels.
 */
export function TitleTag({ kind }: { kind?: EndorseKind | null }) {
  if (!kind) return null;
  return <span class={`titletag titletag--${kind}`}>{ENDORSE_LABEL[kind]}</span>;
}

/** Received endorsements on a profile. Counts and a rate, never who gave
 *  them. Absent until there is something to count. */
export function EndorsementCounts({ endorsements }: { endorsements?: EndorsementSummary | null }) {
  if (!endorsements || endorsements.total === 0) return null;
  return (
    <Panel>
      <h3>Endorsements</h3>
      <dl class="totals">
        {ENDORSE_KINDS.map((k) => (
          <div key={k}><dt>{ENDORSE_LABEL[k]}</dt><dd class="num">{endorsements.counts[k]}</dd></div>
        ))}
        <div><dt>Per match</dt><dd class="num">{endorsements.perMatch.toFixed(2)}</dd></div>
      </dl>
    </Panel>
  );
}
```

In `web/src/components/Headliner.tsx`:

Add the imports at the top:

```tsx
import type { EndorseKind } from '../api';
import { TitleTag } from './TitleTag';
```

Add `title` to the destructured props (after `bio`) and to the props type:

```tsx
    /** The endorsement title, shown beside the name. */
    title?: EndorseKind | null;
```

Replace the name heading line with:

```tsx
      <h2 class="headliner__name">{name}<TitleTag kind={title} /></h2>
```

Update the doc comment's last paragraph to say the identity line, the bio and the title are optional.

In `web/src/components/StatTable.tsx`:

Add the imports:

```tsx
import type { EndorseKind } from '../api';
import { TitleTag } from './TitleTag';
```

(If the file already imports types from `'../api'`, add `EndorseKind` to that import instead of adding a second one.)

Add to `export interface StatRow {`:

```ts
  /** The endorsement title they have earned, if any. The match page passes
   *  it; the live scoreboard does not. */
  title?: EndorseKind | null;
```

and change the name cell (the `<td class="live__pcol pname">` line) to:

```tsx
          <td class="live__pcol pname"><PlayerLink steamid={p.steamid} name={p.name} /><TitleTag kind={p.title} /></td>
```

- [ ] **Step 5: Wire the pages**

In `web/src/routes/Profile.tsx`:

Add the import:

```tsx
import { EndorsementCounts } from '../components/TitleTag';
```

Pass the title to the `<Headliner` element, after `bio={player.bio}`:

```tsx
          title={data.endorsements?.title}
```

and mount the counts directly after `<ChemistryPanel chemistry={data.chemistry} />` (from Task 2):

```tsx
        <EndorsementCounts endorsements={data.endorsements} />
```

In `web/src/routes/MatchDetail.tsx`, in `rowFor`, add after `name: p.name,`:

```ts
    title: p.title,
```

and in `mapRows`, add after `name: p.name,`:

```ts
      title: p.title,
```

In `web/src/routes/Leaderboard.tsx`, add the import:

```tsx
import { TitleTag } from '../components/TitleTag';
```

and change the player name cell to:

```tsx
                          <td class="lb__pcol pname" title={r.name}><PlayerLink steamid={r.steamid} name={r.name} /><TitleTag kind={r.title} /></td>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run web`
Expected: PASS for the whole web project. If a snapshot-like assertion elsewhere pinned the exact text content of a name heading or name cell, it should still pass because a missing title renders nothing; if one fails, read it before changing it.

Run: `npm run typecheck && npm run build && npm test`
Expected: no errors, and the full suite (server and web) passes.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/components/TitleTag.tsx web/src/components/TitleTag.test.tsx web/src/components/Headliner.tsx web/src/components/Headliner.test.tsx web/src/components/StatTable.tsx web/src/routes/Profile.tsx web/src/routes/MatchDetail.tsx web/src/routes/Leaderboard.tsx
git commit -m "Show endorsement titles beside names and counts on the profile" -m "The title appears on the profile, on the match page rosters and on the leaderboard: the word is the part that travels. The profile also shows a count per kind and a per match rate, and nothing at all until somebody has been endorsed. Nowhere shows who endorsed whom."
```
