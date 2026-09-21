# Admin Desks 1: People Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put everything known about a player in one file at one URL, reachable by admins and moderators, with a merged evidence timeline, a "needs a look" queue, the ban list and tickets all living under a People desk.

**Architecture:** A timeline module (`src/admin/timeline/`) turns each evidence or record source into a small adapter returning `TimelineItem[]`; `src/admin/playerTimeline.ts` resolves aliases, runs every adapter behind a try/catch and sorts. On top of that sit `src/admin/playerFile.ts` (the whole file), `src/admin/playerFileSummary.ts` (the compact form the ticket page shares), `src/admin/needsALook.ts` and `src/admin/peopleBans.ts`, with `src/admin/fileAccess.ts` as the one place that decides who may open and do what. `src/routes/people.ts` serves all of it behind `makeRequireMod`; the existing admin-only mutations stay where they are. The web side becomes URL driven: `web/src/routes/admin/adminRoutes.ts` parses `/admin/<desk>/...` and `Admin.tsx` is a shell over three desks, of which only People is built here.

**Tech Stack:** Fastify 5, better-sqlite3, Preact 10 + preact-iso, vitest 4 (`server` and `web` projects), happy-dom with @testing-library/preact.

**Spec:** `docs/superpowers/specs/2026-09-21-admin-desks-design.md`. This plan covers build order item 1, People, only. Live parts one and two and Setup get their own plans.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/admin-desks` on branch `worktree-admin-desks`. Never write to master, never deploy, no rcon, no ssh.
- Never use em dashes in code, comments, commit messages, docs or UI copy.
- Match the surrounding code style and comment density: comments say why, not what.
- Commit messages are one plain imperative sentence with no prefix (see `git log --oneline -15`).
- Every mutation ends with `logAdmin`.
- The API enforces access and the UI only hides: a file the viewer may not open is a 404, never a 403.
- Evidence wording stays "context, not a verdict". Severities and sources are never coloured as accusations.
- Never touch ticket tables, the Discord mirror, attachments or removal. The only shared ticket surface is the case-file section of the ticket page.
- New tables are `CREATE TABLE IF NOT EXISTS` with no `CHECK` on status-like columns; new columns go through `ensureColumn` in `src/db.ts`.
- Mods see every section admins see, shared-network rows included. Only the actions differ.
- Every task ends with a full `npx vitest run` and `npm run typecheck`, both green.

## File Structure

Created, server:
- `src/admin/timeline/types.ts`: the `TimelineItem` contract, `TimelineCtx`, `TimelineAdapter`, `toIso`, `marks`, `ROW_LIMIT`, `isEvidence`.
- `src/admin/timeline/input.ts`: input-timing detections.
- `src/admin/timeline/lilac.ts`: Little Anti-Cheat flags.
- `src/admin/timeline/analyzer.ts`: replay analyzer clips, current analyzer version only.
- `src/admin/timeline/drops.ts`: connect drops, and `repeatDropIds`.
- `src/admin/timeline/steam.ts`: Steam signal alerts.
- `src/admin/timeline/tickets.ts`: tickets about the player, through `ticketsAbout`.
- `src/admin/timeline/penalties.ts`: no-shows and missed ready checks.
- `src/admin/timeline/bans.ts`: bans, redacted, and `fmtBanLength`.
- `src/admin/timeline/notes.ts`: admin notes, and reviews as `kind: 'review'`.
- `src/admin/timeline/discordLinks.ts`: Discord link history.
- `src/admin/playerTimeline.ts`: `ADAPTERS`, `TIMELINE_LIMIT`, `playerTimeline`.
- `src/admin/banRedaction.ts`: one ban-redaction rule for the timeline, the file, the ban list and the ticket page.
- `src/admin/fileAccess.ts`: who may open a file and what they may do on it.
- `src/admin/reviews.ts`: `player_reviews` reads and writes.
- `src/admin/analyzerRanks.ts`: the integrity board as a per-player rank lookup.
- `src/admin/needsALook.ts`: files with evidence newer than their newest review.
- `src/admin/peopleBans.ts`: the ban list inside the panel.
- `src/admin/playerFileSummary.ts`: the compact summary shared with the ticket page.
- `src/admin/playerFile.ts`: the whole Player File.
- `src/routes/people.ts`: `/api/admin/people*`, all behind `makeRequireMod`.

Created, web:
- `web/src/routes/admin/adminRoutes.ts`: pure path parser and URL tables.
- `web/src/routes/admin/PeopleSearch.tsx`, `NeedsALook.tsx`, `PeopleBans.tsx`, `AnalysisPanel.tsx`.
- `web/src/routes/admin/file/PlayerFile.tsx`, `FileHeader.tsx`, `GlanceRow.tsx`, `Timeline.tsx`, `IdentitySection.tsx`, `StandingSection.tsx`, `EvidenceDetail.tsx`, `NotesSection.tsx`, `FileSummary.tsx`.
- `web/src/components/Redirect.tsx`: route away and render nothing.

Created, tests:
- `tests/playerTimeline.test.ts`, `tests/timelineEvidence.test.ts`, `tests/timelineRecords.test.ts`, `tests/fileAccess.test.ts`, `tests/playerReviews.test.ts`, `tests/needsALook.test.ts`, `tests/playerFile.test.ts`, `tests/peopleRoutes.test.ts`, `tests/ticketSummary.test.ts`.
- `web/src/routes/admin/adminRoutes.test.ts`, `web/src/routes/people.test.tsx`, `web/src/routes/playerFile.test.tsx`.

Modified:
- `src/db.ts`: the `player_reviews` table, created before `ensureTicketSchema`.
- `src/mergePlayers.ts`: two `PLAIN` entries for `player_reviews`.
- `src/tickets/caseFile.ts`: uses the shared redaction (deleted in Task 15).
- `src/routes/tickets.ts`: the ticket detail carries the shared summary.
- `src/server.ts`: registers `peopleRoutes` right after `adminRoutes`.
- `src/discord/adminFeedPoster.ts`: posts that name a player link to the Player File; ticket links move.
- `tests/discordAdminFeed.test.ts`: the three link assertions follow.
- `web/src/api.ts`: People types and `peopleApi`.
- `web/src/main.tsx`: `/admin/*` and the `/bans` redirect.
- `web/src/components/Nav.tsx`: the Bans link points into the panel.
- `web/src/routes/Admin.tsx`: becomes the URL-driven shell.
- `web/src/routes/admin/AdminTickets.tsx`, `AdminTicket.tsx`: selection comes from the URL; the case-file section becomes the shared summary.
- `web/src/routes/tickets.test.tsx`: the new ticket URLs.
- `web/src/styles/app.css`: timeline rows and source badges.

Also modified: `tests/ticketRoutes.test.ts` (the case-file assertions become summary assertions, Task 15).

Deleted at the end (Task 15):
- `web/src/routes/admin/AdminPlayers.tsx`, `web/src/routes/admin/AdminIntegrity.tsx`, `web/src/routes/admin/SteamAccountPanel.tsx` (its only caller was AdminPlayers), `web/src/routes/Bans.tsx`, `web/src/routes/Bans.test.tsx`, `src/tickets/caseFile.ts`.
- The player-detail and Integrity describes in `web/src/routes/admin.test.tsx` (Task 14, when the shell stops rendering those screens).

Kept on purpose: `GET /api/admin/players`, `GET /api/admin/players/:steamid`, `GET /api/admin/integrity*` and `GET /api/bans` stay on the server with their tests, which are the regression net for everything the new screens now call.

---

### Task 1: The timeline contract, and the first two adapters

**Files:**
- Create: `src/admin/timeline/types.ts`, `src/admin/timeline/input.ts`, `src/admin/timeline/lilac.ts`, `src/admin/playerTimeline.ts`
- Test: `tests/playerTimeline.test.ts`

**Interfaces:**
- Consumes: `openDb(path: string): DB` from `src/db.ts`; `upsertPlayer(db, player, adminSteamIds): void` from `src/players.ts`; `resolveAlias(db: DB, steamid: string): string` and `aliasesOf(db: DB, canonical: string): Alias[]` from `src/aliases.ts`; `addAlias(db, { steamid, canonical, by }): void`.
- Produces:
  - `type TimelineSource = 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban' | 'note' | 'steam' | 'discord_link'`
  - `type EvidenceSource = 'input' | 'lilac' | 'analyzer' | 'drop' | 'steam'`
  - `interface TimelineItem { at: string; source: TimelineSource; kind: string; summary: string; matchId: number | null; replay: { ordinal: number; half: number; tMs: number } | null; ref: { type: string; id: number | string } | null }`
  - `interface TimelineCtx { db: DB; steamid: string; ids: string[]; viewer: string }`
  - `interface TimelineAdapter { source: TimelineSource; items(ctx: TimelineCtx): TimelineItem[]; evidence?(db: DB): { steamid: string; at: string }[] }`
  - `const ROW_LIMIT = 200`, `toIso(raw: string): string`, `marks(ids: string[]): string`, `isEvidence(item: TimelineItem): boolean`
  - `const inputAdapter: TimelineAdapter`, `const lilacAdapter: TimelineAdapter`
  - `const ADAPTERS: TimelineAdapter[]`, `const TIMELINE_LIMIT = 500`, `playerTimeline(db: DB, steamid: string, viewer: string, adapters?: TimelineAdapter[]): TimelineItem[]`

- [ ] **Step 1: Write the failing test**

`tests/playerTimeline.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { ADAPTERS, playerTimeline } from '../src/admin/playerTimeline.js';
import { isEvidence, toIso, type TimelineAdapter, type TimelineItem } from '../src/admin/timeline/types.js';

const MAIN = '76561199000000001';
const ALT = '76561199000000002';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, STAFF]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
});

const detection = (steamid: string, at: string, burstId: number, signature = 'pistol_rate') =>
  db.prepare(
    `INSERT INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at, hits, evidence, note)
     VALUES (?, 7, ?, 'attack', ?, 'low', ?, 3, '[]', 'wheel-like')`,
  ).run(burstId, steamid, signature, at);

const lilac = (steamid: string, at: string, kind = 'aimbot', severity = 'suspected') =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (7, 1, ?, 'lilac', ?, ?, '', ?)`,
  ).run(steamid, kind, severity, at);

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: '2026-09-21T10:00:00.000Z', source: 'input', kind: 'x', summary: 'x',
  matchId: null, replay: null, ref: null, ...over,
});

describe('the timeline', () => {
  it('merges its sources newest first and follows a merged account', () => {
    detection(ALT, '2026-09-20T10:00:00.000Z', 1);
    lilac(MAIN, '2026-09-21T10:00:00.000Z');
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'test' });

    const items = playerTimeline(db, MAIN, STAFF);
    expect(items.map((i) => i.source)).toEqual(['lilac', 'input']);
    expect(items[0].summary).toMatch(/Little Anti-Cheat/);
    expect(items[1].summary).toMatch(/pistol_rate/);
    expect(items[1].matchId).toBe(7);
    expect(items[1].ref).toEqual({ type: 'input_detection', id: 1 });
    // Asking under the alt's own id answers about the person, not the id.
    expect(playerTimeline(db, ALT, STAFF)).toHaveLength(2);
  });

  it('a banned flag reads differently from a suspicion, and neither is a verdict', () => {
    lilac(MAIN, '2026-09-21T10:00:00.000Z', 'bhop', 'banned');
    const [one] = playerTimeline(db, MAIN, STAFF);
    expect(one.kind).toBe('bhop');
    expect(one.summary).toMatch(/banned/i);
    lilac(MAIN, '2026-09-21T11:00:00.000Z', 'macro');
    expect(playerTimeline(db, MAIN, STAFF)[0].summary).toMatch(/false positives/);
  });

  it('an adapter that throws yields nothing and the file still renders', () => {
    detection(MAIN, '2026-09-20T10:00:00.000Z', 1);
    const broken: TimelineAdapter = { source: 'note', items: () => { throw new Error('boom'); } };
    expect(playerTimeline(db, MAIN, STAFF, [broken, ...ADAPTERS])).toHaveLength(1);
  });

  it('knows which items are evidence, and that one connect drop is not', () => {
    expect(isEvidence(item({ source: 'input' }))).toBe(true);
    expect(isEvidence(item({ source: 'lilac' }))).toBe(true);
    expect(isEvidence(item({ source: 'analyzer' }))).toBe(true);
    expect(isEvidence(item({ source: 'steam' }))).toBe(true);
    expect(isEvidence(item({ source: 'drop', kind: 'drop' }))).toBe(false);
    expect(isEvidence(item({ source: 'drop', kind: 'repeat' }))).toBe(true);
    expect(isEvidence(item({ source: 'ban' }))).toBe(false);
  });

  it('reads both time formats this database writes', () => {
    expect(toIso('2026-09-21 10:00:00')).toBe('2026-09-21T10:00:00.000Z');
    expect(toIso('2026-09-21T10:00:00.000Z')).toBe('2026-09-21T10:00:00.000Z');
  });

  it('each adapter that offers evidence answers with one row per steamid', () => {
    detection(MAIN, '2026-09-20T10:00:00.000Z', 1);
    detection(MAIN, '2026-09-21T10:00:00.000Z', 2, 'wheel');
    const input = ADAPTERS.find((a) => a.source === 'input')!;
    expect(input.evidence!(db)).toEqual([{ steamid: MAIN, at: '2026-09-21T10:00:00.000Z' }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/playerTimeline.test.ts`
Expected: FAIL, cannot resolve `../src/admin/playerTimeline.js`.

- [ ] **Step 3: The contract**

`src/admin/timeline/types.ts`:

```ts
import type { DB } from '../../db.js';

/**
 * One merged list of everything known about a player, in time order.
 *
 * Each source is a small adapter rather than a branch in one query, so a
 * future source (per-tick aim metrics, say) is one file and no screen work.
 * Adapters never throw at the caller: playerTimeline catches, logs and
 * carries on, because a file that renders nine sources is worth far more
 * than one that renders none.
 */
export type TimelineSource =
  | 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
  | 'note' | 'steam' | 'discord_link';

/** The sources that mean somebody should take a look. Needs a look is built
 *  from these and nothing else: a ban or a note is a record of a decision
 *  already taken, not something waiting for one. */
export type EvidenceSource = 'input' | 'lilac' | 'analyzer' | 'drop' | 'steam';

export interface TimelineItem {
  at: string;
  source: TimelineSource;
  /** Source-specific, e.g. 'pistol_rate', 'aimbot', 'clip'. */
  kind: string;
  /** One line, written server-side so every surface says the same thing. */
  summary: string;
  matchId: number | null;
  replay: { ordinal: number; half: number; tMs: number } | null;
  /** What to open, when there is something. */
  ref: { type: string; id: number | string } | null;
}

export interface TimelineCtx {
  db: DB;
  /** The canonical id, after alias resolution. */
  steamid: string;
  /** The canonical id plus every alias folded into it. The evidence tables
   *  carry no foreign key on players, so a merged alt's rows can still sit
   *  under its own id: every adapter queries the whole list, never one id. */
  ids: string[];
  /** Who is looking. Ticket rows obey the tickets rules for this person. */
  viewer: string;
}

export interface TimelineAdapter {
  source: TimelineSource;
  items(ctx: TimelineCtx): TimelineItem[];
  /** One row per steamid: the newest evidence this source holds for it.
   *  Only evidence sources have one, and needsALook folds them together.
   *  Deliberately one row per player rather than all of them: the question
   *  is "is there anything newer than the last review", not "how much". */
  evidence?(db: DB): { steamid: string; at: string }[];
}

/** Rows per adapter. A file shows a history, not an archive. */
export const ROW_LIMIT = 200;

/** SQLite writes some columns with datetime('now') ("2026-09-21 10:00:00")
 *  and the app writes others as ISO. One reader for both, so sorting a
 *  merged list never compares a space against a T. */
export function toIso(raw: string): string {
  const t = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? raw : new Date(t).toISOString();
}

/** Placeholders for an id list: the ids are bound, never interpolated. */
export function marks(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

/** Whether an item counts towards "needs a look". A single connect drop is
 *  retry noise and a cancelled loading screen looks identical, so only the
 *  repeat rule counts; drops.ts marks those with kind 'repeat'. */
export function isEvidence(item: TimelineItem): boolean {
  if (item.source === 'drop') return item.kind === 'repeat';
  return item.source === 'input' || item.source === 'lilac'
    || item.source === 'analyzer' || item.source === 'steam';
}
```

- [ ] **Step 4: The input adapter**

`src/admin/timeline/input.ts`:

```ts
import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; match_id: number | null; kind: string; signature: string;
  severity: string; at: string; hits: number; note: string;
}

/** Input-timing detections. A row exists only once a signature has repeated
 *  across separate bursts in one match, so each one is already a pattern and
 *  not a single fast burst. It is still evidence to read beside the replay,
 *  and the summary says so rather than leaving the reader to supply it. */
export const inputAdapter: TimelineAdapter = {
  source: 'input',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, signature, severity, at, hits, note
       FROM input_detections WHERE steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'input' as const,
      kind: r.signature,
      summary: `Input check ${r.signature} on ${r.hits} ${r.kind} burst${r.hits === 1 ? '' : 's'}`
        + `${r.note ? `, holds look ${r.note}` : ''}. Button timing, to be read beside the replay.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'input_detection', id: r.id },
    }));
  },
  evidence(db: DB) {
    return db.prepare('SELECT steamid, MAX(at) AS at FROM input_detections GROUP BY steamid')
      .all() as { steamid: string; at: string }[];
  },
};
```

- [ ] **Step 5: The LilAC adapter**

`src/admin/timeline/lilac.ts`:

```ts
import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; severity: string; at: string }

/** Flags Little Anti-Cheat raised during play. No replay behind them, so
 *  there is nothing to watch: the value is the pattern, not the single hit.
 *  "suspected" is LilAC's own word and its own documentation says few and
 *  rare suspicions are usually false positives, which is why the line says
 *  that here too. The source column is filtered rather than assumed: the
 *  table takes flags from any plugin that wants to report one. */
export const lilacAdapter: TimelineAdapter = {
  source: 'lilac',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, severity, at FROM integrity_flags
       WHERE source = 'lilac' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'lilac' as const,
      kind: r.kind,
      summary: r.severity === 'banned'
        ? `Little Anti-Cheat banned this account on the game server for ${r.kind}.`
        : `Little Anti-Cheat suspected ${r.kind}. Few and rare suspicions are usually false positives; a run of them is what matters.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'lilac' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
```

- [ ] **Step 6: The assembler**

`src/admin/playerTimeline.ts`:

```ts
import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { inputAdapter } from './timeline/input.js';
import { lilacAdapter } from './timeline/lilac.js';
import type { TimelineAdapter, TimelineItem } from './timeline/types.js';

/** Every source, in no particular order: the result is sorted by time. A new
 *  source is one adapter file and one entry here. */
export const ADAPTERS: TimelineAdapter[] = [
  inputAdapter,
  lilacAdapter,
];

/** Items on one file. Well above what a page shows, and a bound all the same. */
export const TIMELINE_LIMIT = 500;

/**
 * One chronological list of everything about a player, newest first.
 *
 * The alias is resolved first, so a merged alt's history is the main's, and
 * every adapter is handed the canonical id together with every alias: the
 * evidence tables have no foreign key on players and keep rows under the id
 * that produced them.
 *
 * An adapter that throws yields nothing and is logged. The spec asks for
 * that explicitly: one broken source must not take the file with it.
 */
export function playerTimeline(
  db: DB, steamid: string, viewer: string, adapters: TimelineAdapter[] = ADAPTERS,
): TimelineItem[] {
  const canonical = resolveAlias(db, steamid);
  const ids = [canonical, ...aliasesOf(db, canonical).map((a) => a.steamid)];
  const ctx = { db, steamid: canonical, ids, viewer };
  const out: TimelineItem[] = [];
  for (const adapter of adapters) {
    try {
      out.push(...adapter.items(ctx));
    } catch (err) {
      console.error(`[timeline] the ${adapter.source} source failed for ${canonical}:`, err);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, TIMELINE_LIMIT);
}
```

- [ ] **Step 7: Run and watch it pass**

Run: `npx vitest run tests/playerTimeline.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/admin/timeline src/admin/playerTimeline.ts tests/playerTimeline.test.ts
git commit -m "Build a merged player timeline from per-source adapters"
```

---

### Task 2: The remaining evidence adapters

**Files:**
- Create: `src/admin/timeline/analyzer.ts`, `src/admin/timeline/drops.ts`, `src/admin/timeline/steam.ts`
- Modify: `src/admin/playerTimeline.ts` (the `ADAPTERS` array)
- Test: `tests/timelineEvidence.test.ts`

**Interfaces:**
- Consumes: `ANALYZER_VERSION` (`= 4`) from `src/integrity/store.ts`; `STREAK_WINDOW_MS` (`= 10 * 60_000`) from `src/signonDrops.ts`; the helpers from Task 1.
- Produces:
  - `const analyzerAdapter: TimelineAdapter`
  - `interface DropRow { id: number; steamid: string; name: string; secs_connected: number; forced_count: number; at: string; entered_after_at: string | null }`
  - `repeatDropIds(rows: DropRow[]): Set<number>`
  - `const dropsAdapter: TimelineAdapter`
  - `const steamAdapter: TimelineAdapter`

- [ ] **Step 1: Write the failing test**

`tests/timelineEvidence.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { analyzerAdapter } from '../src/admin/timeline/analyzer.js';
import { dropsAdapter, repeatDropIds } from '../src/admin/timeline/drops.js';
import { steamAdapter } from '../src/admin/timeline/steam.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const P = '76561199000000001';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, STAFF]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (7, 1, 'completed', 'dead_air', '2026-09-20 18:00:00')").run();
});

const clip = (version: number, startMs = 61500) =>
  db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (7, 2, 1, 3, ?, ?, ?, 'track', 0.82, '{}', ?)`,
  ).run(P, startMs, startMs + 6000, version);

const replayRow = (pruned: string | null) =>
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, pruned_at)
     VALUES (7, 2, 1, 'r.bin', 10, 10, 10, ?)`,
  ).run(pruned);

const drop = (at: string, enteredAfter: string | null = null) =>
  db.prepare(
    `INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at, entered_after_at)
     VALUES (?, 'ingame', 12, 651, ?, ?)`,
  ).run(P, at, enteredAfter);

const alert = (kind: string, marker: string, at: string) =>
  db.prepare('INSERT INTO steam_signal_alerts (player_id, kind, marker, match_id, at) VALUES (?, ?, ?, 7, ?)')
    .run(P, kind, marker, at);

describe('the analyzer source', () => {
  it('shows current-version clips only, dated by their match, with a replay link when the file is there', () => {
    clip(ANALYZER_VERSION);
    clip(ANALYZER_VERSION - 1, 1000);
    replayRow(null);
    const items = analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items).toHaveLength(1);
    expect(items[0].at).toBe('2026-09-20T18:00:00.000Z');
    expect(items[0].matchId).toBe(7);
    expect(items[0].replay).toEqual({ ordinal: 2, half: 1, tMs: 61500 });
    expect(items[0].summary).toMatch(/Watch it/);
  });

  it('offers no replay link when the replay was pruned or never indexed', () => {
    clip(ANALYZER_VERSION);
    expect(analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF })[0].replay).toBeNull();
    replayRow('2026-09-21 00:00:00');
    expect(analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF })[0].replay).toBeNull();
  });
});

describe('the connect-drop source', () => {
  it('marks a second drop inside ten minutes with no entry between as a repeat', () => {
    drop('2026-09-20T10:00:00.000Z');
    drop('2026-09-20T10:05:00.000Z');
    drop('2026-09-20T12:00:00.000Z');
    const items = dropsAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items.map((i) => i.kind)).toEqual(['drop', 'repeat', 'drop']);
    expect(items[1].summary).toMatch(/ten minutes/);
    expect(items[2].summary).toMatch(/cancelled loading screen/);
  });

  it('a clean entry between two drops ends the run', () => {
    const rows = [
      { id: 1, steamid: P, name: 'n', secs_connected: 1, forced_count: 1, at: '2026-09-20T10:00:00.000Z', entered_after_at: '2026-09-20T10:01:00.000Z' },
      { id: 2, steamid: P, name: 'n', secs_connected: 1, forced_count: 1, at: '2026-09-20T10:05:00.000Z', entered_after_at: null },
    ];
    expect([...repeatDropIds(rows)]).toEqual([]);
    rows[0].entered_after_at = null;
    expect([...repeatDropIds(rows)]).toEqual([2]);
  });

  it('reports only repeats as evidence', () => {
    drop('2026-09-20T10:00:00.000Z');
    expect(dropsAdapter.evidence!(db)).toEqual([]);
    drop('2026-09-20T10:05:00.000Z');
    expect(dropsAdapter.evidence!(db)).toEqual([{ steamid: P, at: '2026-09-20T10:05:00.000Z' }]);
  });
});

describe('the Steam source', () => {
  it('words both alerts as context and lands them on the timeline', () => {
    alert('recent_ban', '2', '2026-09-20T10:00:00.000Z');
    alert('banned_lender', '76561198000000077', '2026-09-20T11:00:00.000Z');
    const items = steamAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items[0].summary).toMatch(/Households share libraries/);
    expect(items[1].summary).toMatch(/Steam does not say which game/);
    expect(playerTimeline(db, P, STAFF).map((i) => i.source)).toEqual(['steam', 'steam']);
    expect(steamAdapter.evidence!(db)).toEqual([{ steamid: P, at: '2026-09-20T11:00:00.000Z' }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/timelineEvidence.test.ts`
Expected: FAIL, cannot resolve `../src/admin/timeline/analyzer.js`.

- [ ] **Step 3: The analyzer adapter**

`src/admin/timeline/analyzer.ts`:

```ts
import type { DB } from '../../db.js';
import { ANALYZER_VERSION } from '../../integrity/store.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; match_id: number; ordinal: number; half: number;
  start_ms: number; end_ms: number; kind: string; score: number;
  at: string; has_replay: number;
}

/**
 * Clips the replay analyzer flagged.
 *
 * CURRENT ANALYZER VERSION ONLY, as on the board: an old clip is a claim the
 * current analyzer does not make, and a round whose replay was pruned can
 * never be measured again, so its old rows stay in the table and are simply
 * not shown.
 *
 * A clip carries no timestamp of its own, so it is dated by the match it was
 * measured from. The deep link is offered only when a match_replays row
 * exists and has not been pruned: with no file there is nothing to seek to,
 * and a dead link in an evidence list is worse than no link.
 */
export const analyzerAdapter: TimelineAdapter = {
  source: 'analyzer',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT c.id, c.match_id, c.ordinal, c.half, c.start_ms, c.end_ms, c.kind, c.score,
              COALESCE(m.ended_at, m.created_at) AS at,
              (SELECT COUNT(*) FROM match_replays r
                WHERE r.match_id = c.match_id AND r.ordinal = c.ordinal
                  AND r.half = c.half AND r.pruned_at IS NULL) AS has_replay
       FROM integrity_clips c JOIN matches m ON m.id = c.match_id
       WHERE c.steamid IN (${marks(ids)}) AND c.analyzer_version = ?
       ORDER BY at DESC, c.score DESC LIMIT ?`,
    ).all(...ids, ANALYZER_VERSION, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'analyzer' as const,
      kind: r.kind,
      summary: `Analyzer clip: ${r.kind}, fidelity ${r.score.toFixed(2)} over `
        + `${((r.end_ms - r.start_ms) / 1000).toFixed(1)} s. Watch it before deciding anything.`,
      matchId: r.match_id,
      replay: r.has_replay > 0 ? { ordinal: r.ordinal, half: r.half, tMs: r.start_ms } : null,
      ref: { type: 'integrity_clip', id: r.id },
    }));
  },
  evidence(db: DB) {
    return (db.prepare(
      `SELECT c.steamid, MAX(COALESCE(m.ended_at, m.created_at)) AS at
       FROM integrity_clips c JOIN matches m ON m.id = c.match_id
       WHERE c.analyzer_version = ? GROUP BY c.steamid`,
    ).all(ANALYZER_VERSION) as { steamid: string; at: string }[])
      .map((r) => ({ steamid: r.steamid, at: toIso(r.at) }));
  },
};
```

- [ ] **Step 4: The connect-drop adapter**

`src/admin/timeline/drops.ts`:

```ts
import type { DB } from '../../db.js';
import { STREAK_WINDOW_MS } from '../../signonDrops.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

export interface DropRow {
  id: number; steamid: string; name: string; secs_connected: number;
  forced_count: number; at: string; entered_after_at: string | null;
}

/** Rows of signon_drops, newest last per player, as both callers want them. */
const SELECT = `SELECT id, steamid, name, secs_connected, forced_count, at, entered_after_at FROM signon_drops`;

/**
 * Which of these drops are repeats.
 *
 * One connect drop is retry noise: a cancelled loading screen looks exactly
 * like a rejected file, and listing everybody who ever cancelled one would
 * bury the thing this is for. A repeat is what the admin feed already calls
 * one: a second drop inside ten minutes with no clean entry between them.
 *
 * entered_after_at is stamped on every pending drop the moment the steamid
 * is seen in game, so an earlier drop whose stamp falls before this one had
 * an entry in between and the run is broken.
 */
export function repeatDropIds(rows: DropRow[]): Set<number> {
  const out = new Set<number>();
  const byPlayer = new Map<string, DropRow[]>();
  for (const r of rows) byPlayer.set(r.steamid, [...(byPlayer.get(r.steamid) ?? []), r]);
  for (const list of byPlayer.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(toIso(a.at)) - Date.parse(toIso(b.at)));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const at = Date.parse(toIso(sorted[i].at));
      const entryBetween = prev.entered_after_at !== null
        && Date.parse(toIso(prev.entered_after_at)) < at;
      if (at - Date.parse(toIso(prev.at)) <= STREAK_WINDOW_MS && !entryBetween) out.add(sorted[i].id);
    }
  }
  return out;
}

/** Connects that ended before the player was in game on a map that forced
 *  files. A hint at a rejected modified file, never proof of one, and the
 *  summary carries the other reading rather than leaving it to be known. */
export const dropsAdapter: TimelineAdapter = {
  source: 'drop',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `${SELECT} WHERE steamid IN (${marks(ids)}) ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as DropRow[];
    const repeats = repeatDropIds(rows);
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'drop' as const,
      kind: repeats.has(r.id) ? 'repeat' : 'drop',
      summary: `Dropped while connecting as ${r.name}`
        + `${r.secs_connected < 0 ? '' : ` after ${r.secs_connected} s`}`
        + `, ${r.forced_count} files enforced.`
        + (repeats.has(r.id)
          ? ' Second drop inside ten minutes with no clean entry between: likely a rejected game file.'
          : ' A cancelled loading screen looks the same, so one of these says nothing.')
        + (r.entered_after_at === null ? ' They have not got in since.' : ''),
      matchId: null,
      replay: null,
      ref: { type: 'signon_drop', id: r.id },
    }));
  },
  evidence(db: DB) {
    // Bounded rather than the whole table: only the newest repeat per player
    // can be newer than a review, and this runs on every Needs a look.
    const rows = db.prepare(`${SELECT} ORDER BY id DESC LIMIT 5000`).all() as DropRow[];
    const repeats = repeatDropIds(rows);
    const newest = new Map<string, string>();
    for (const r of rows.filter((x) => repeats.has(x.id))) {
      const at = toIso(r.at);
      if (!newest.has(r.steamid) || newest.get(r.steamid)! < at) newest.set(r.steamid, at);
    }
    return [...newest].map(([steamid, at]) => ({ steamid, at }));
  },
};
```

- [ ] **Step 5: The Steam adapter**

`src/admin/timeline/steam.ts`:

```ts
import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { kind: string; marker: string; match_id: number | null; at: string }

/** Alerts raised from what Steam says about the account. Hedged here as they
 *  are hedged everywhere else: a ban in another game is not a ban in this
 *  one, and a borrowed library is how a household shares a PC. The marker is
 *  the ban count for recent_ban and the lender's id for banned_lender, which
 *  is what makes a second ban news while the same ban is not. */
export const steamAdapter: TimelineAdapter = {
  source: 'steam',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT kind, marker, match_id, at FROM steam_signal_alerts
       WHERE player_id IN (${marks(ids)}) ORDER BY at DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'steam' as const,
      kind: r.kind,
      summary: r.kind === 'recent_ban'
        ? `Steam shows ${r.marker} ban${r.marker === '1' ? '' : 's'} on this account, the newest of them recent. Steam does not say which game, so this is context and not a finding about the PUG.`
        : `Playing on a copy of the game shared from ${r.marker}, an account banned here. Households share libraries, so this is a reason to look and nothing more.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'steam_alert', id: `${r.kind}:${r.marker}` },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      'SELECT player_id AS steamid, MAX(at) AS at FROM steam_signal_alerts GROUP BY player_id',
    ).all() as { steamid: string; at: string }[];
  },
};
```

- [ ] **Step 6: Register them**

In `src/admin/playerTimeline.ts`, add the imports beside the existing two and extend `ADAPTERS`:

```ts
import { analyzerAdapter } from './timeline/analyzer.js';
import { dropsAdapter } from './timeline/drops.js';
import { steamAdapter } from './timeline/steam.js';
```

```ts
export const ADAPTERS: TimelineAdapter[] = [
  inputAdapter,
  lilacAdapter,
  analyzerAdapter,
  dropsAdapter,
  steamAdapter,
];
```

- [ ] **Step 7: Run and watch it pass**

Run: `npx vitest run tests/timelineEvidence.test.ts tests/playerTimeline.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/admin/timeline src/admin/playerTimeline.ts tests/timelineEvidence.test.ts
git commit -m "Add analyzer clips, connect drops and Steam alerts to the timeline"
```

---

### Task 3: Ban redaction, and the record adapters

**Files:**
- Create: `src/admin/banRedaction.ts`, `src/admin/timeline/tickets.ts`, `src/admin/timeline/penalties.ts`, `src/admin/timeline/bans.ts`, `src/admin/timeline/notes.ts`, `src/admin/timeline/discordLinks.ts`
- Modify: `src/admin/playerTimeline.ts` (`ADAPTERS`), `src/tickets/caseFile.ts:1-40` (drop the local copy of the redaction rule and import the shared one)
- Test: `tests/timelineRecords.test.ts`

**Interfaces:**
- Consumes: `ticketsAbout(db, targetId, viewer): TicketSummary[]` from `src/tickets/views.ts`; `canSeeTicket(db, t: TicketRow, viewer): boolean` and `getTicketRow(db, id): TicketRow | undefined` from `src/tickets/store.ts`; `penaltyHistory(db, steamid, limit?): PenaltyRow[]` from `src/penalties.ts`; `BanRow` from `src/admin/players.ts`.
- Produces:
  - `const WITHHELD_REASON = 'Withheld (restricted ticket)'`
  - `banIsWithheld(db: DB, ticketId: number | null, viewer: string): boolean`
  - `redactBan(ban: BanRow): BanRow`
  - `banRedactor(db: DB, steamid: string, viewer: string): (ban: BanRow) => BanRow`
  - `fmtBanLength(createdAt: string, expiresAt: string | null): string`
  - `const ticketsAdapter`, `penaltiesAdapter`, `bansAdapter`, `notesAdapter`, `discordLinksAdapter`: `TimelineAdapter`

- [ ] **Step 1: Write the failing test**

`tests/timelineRecords.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { recordPenalty } from '../src/penalties.js';
import { banPlayer } from '../src/admin/players.js';
import { addNote } from '../src/admin/players.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { WITHHELD_REASON, banRedactor } from '../src/admin/banRedaction.js';
import { fmtBanLength } from '../src/admin/timeline/bans.js';
import { openStaffTicket } from '../src/tickets/filing.js';
import { banFromTicket, setRestricted } from '../src/tickets/actions.js';

const P = '76561199000000001';
const OWNER = '76561199000000009';
const MOD = '76561199000000008';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, OWNER, MOD]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});

const sources = (viewer: string) => playerTimeline(db, P, viewer).map((i) => i.source);

describe('the record sources', () => {
  it('puts a ticket, a penalty, a ban, a note and a Discord link on one list', () => {
    openStaffTicket(db, OWNER, { targetId: P, note: 'keep an eye' }, { adminSteamIds: [OWNER] });
    recordPenalty(db, P, 'no_show', 7);
    banPlayer(db, P, OWNER, 'throwing', 1440);
    addNote(db, P, OWNER, 'spoke to them');
    linkDiscord(db, P, '900', 'name');
    unlinkDiscord(db, P, OWNER);

    const items = playerTimeline(db, P, OWNER);
    expect(new Set(items.map((i) => i.source)))
      .toEqual(new Set(['ticket', 'penalty', 'ban', 'note', 'discord_link']));
    const ban = items.find((i) => i.source === 'ban')!;
    expect(ban.summary).toContain('throwing');
    expect(ban.summary).toContain('1 day');
    const penalty = items.find((i) => i.source === 'penalty')!;
    expect(penalty.matchId).toBe(7);
    expect(penalty.summary).toMatch(/did not connect/i);
    expect(items.filter((i) => i.source === 'discord_link')).toHaveLength(2);
  });

  it('says how long a ban ran in the words the panel already uses', () => {
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', null)).toBe('permanent');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z')).toBe('1 day');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-21T01:00:00.000Z')).toBe('1 h');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-21T00:05:00.000Z')).toBe('5 min');
  });

  it('withholds a ban issued from a ticket the viewer cannot see, and says a ban exists all the same', () => {
    const t = openStaffTicket(db, OWNER, { targetId: P, restricted: true }, { adminSteamIds: [OWNER] }) as { ticketId: number };
    setRestricted(db, t.ticketId, OWNER, true, [OWNER]);
    banFromTicket(db, t.ticketId, OWNER, 'cheating, see the case', 1440);

    const asMod = playerTimeline(db, P, MOD).filter((i) => i.source === 'ban');
    expect(asMod).toHaveLength(1);
    expect(asMod[0].summary).toContain(WITHHELD_REASON);
    expect(asMod[0].summary).not.toContain('see the case');
    expect(playerTimeline(db, P, OWNER).find((i) => i.source === 'ban')!.summary).toContain('see the case');

    const redact = banRedactor(db, P, MOD);
    const raw = { id: 1, reason: 'cheating, see the case', createdBy: OWNER, createdAt: 'x', expiresAt: null, liftedBy: null, liftedAt: null };
    expect(redact(raw).reason).toBe(WITHHELD_REASON);
    expect(redact(raw).createdBy).toBe('');
  });

  it('never shows a moderator a ticket about themselves, or a restricted one they are off', () => {
    openStaffTicket(db, OWNER, { targetId: MOD, restricted: true }, { adminSteamIds: [OWNER] });
    expect(playerTimeline(db, MOD, MOD).filter((i) => i.source === 'ticket')).toHaveLength(0);
    expect(playerTimeline(db, MOD, OWNER).filter((i) => i.source === 'ticket')).toHaveLength(1);
    expect(sources(MOD)).not.toContain('ticket');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/timelineRecords.test.ts`
Expected: FAIL, cannot resolve `../src/admin/banRedaction.js`.

- [ ] **Step 3: The shared redaction rule**

`src/admin/banRedaction.ts`:

```ts
import type { DB } from '../db.js';
import type { BanRow } from './players.js';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';

export const WITHHELD_REASON = 'Withheld (restricted ticket)';

/**
 * A ban issued from a restricted ticket carries that ticket's free text and
 * its issuer. Once an ordinary ticket exists about the same player, any
 * moderator opening it sees this player's record too, so a ban tied to a
 * ticket they cannot see is redacted rather than dropped: they still learn
 * the player is or was banned and for how long, never why or by whom.
 *
 * One copy, used by the timeline, the file, the ban list and the ticket
 * page. Two copies of a rule like this is how the two drift apart.
 */
export function banIsWithheld(db: DB, ticketId: number | null, viewer: string): boolean {
  if (ticketId === null) return false;
  const t = getTicketRow(db, ticketId);
  return !!t && !canSeeTicket(db, t, viewer);
}

export function redactBan(ban: BanRow): BanRow {
  return {
    ...ban,
    reason: WITHHELD_REASON,
    // BanRow.createdBy is typed string, not string | null, so '' stands in
    // for withheld rather than widening a type the whole panel shares.
    createdBy: '',
    createdByName: null,
    liftedBy: null,
    liftedByName: null,
  };
}

/** The rule for one player's bans, with the ban-to-ticket lookup done once. */
export function banRedactor(db: DB, steamid: string, viewer: string): (ban: BanRow) => BanRow {
  const ticketIdByBan = new Map(
    (db.prepare('SELECT id, ticket_id FROM bans WHERE player_id = ?').all(steamid) as
      { id: number; ticket_id: number | null }[]).map((r) => [r.id, r.ticket_id]),
  );
  return (ban) => (banIsWithheld(db, ticketIdByBan.get(ban.id) ?? null, viewer) ? redactBan(ban) : ban);
}
```

- [ ] **Step 4: The five record adapters**

`src/admin/timeline/tickets.ts`:

```ts
import { ticketsAbout } from '../../tickets/views.js';
import { toIso, type TimelineAdapter, type TimelineItem } from './types.js';

/** Tickets about this player, one row each: opened, closed, outcome. The
 *  discussion stays on the ticket page.
 *
 *  Everything goes through ticketsAbout, so the tickets rules are obeyed by
 *  construction: nobody sees a ticket about themselves, and a restricted one
 *  is simply absent for anyone off its access list. */
export const ticketsAdapter: TimelineAdapter = {
  source: 'ticket',
  items({ db, ids, viewer }): TimelineItem[] {
    const out: TimelineItem[] = [];
    for (const id of ids) {
      for (const t of ticketsAbout(db, id, viewer)) {
        out.push({
          at: toIso(t.createdAt),
          source: 'ticket',
          kind: t.status,
          summary: `Ticket #${t.id}: ${t.categories.join(', ') || 'opened by staff'}, `
            + `${t.reports} report${t.reports === 1 ? '' : 's'}, `
            + `${t.status === 'open' ? 'open' : `closed ${(t.outcome ?? 'with no outcome').replace(/_/g, ' ')}`}.`,
          matchId: null,
          replay: null,
          ref: { type: 'ticket', id: t.id },
        });
      }
    }
    return out;
  },
};
```

`src/admin/timeline/penalties.ts`:

```ts
import { penaltyHistory } from '../../penalties.js';
import { ROW_LIMIT, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

/** No-shows and missed ready checks. These are what the queue timeout ladder
 *  counts, so they belong on the file even though each one is ordinary. */
export const penaltiesAdapter: TimelineAdapter = {
  source: 'penalty',
  items({ db, ids }): TimelineItem[] {
    const out: TimelineItem[] = [];
    for (const id of ids) {
      for (const p of penaltyHistory(db, id, ROW_LIMIT)) {
        out.push({
          at: toIso(p.createdAt),
          source: 'penalty',
          kind: p.kind,
          summary: `${p.kind === 'no_show' ? 'Did not connect to the match' : 'Missed a ready check'}`
            + `${p.clearedAt ? `, cleared since by ${p.clearedBy ?? 'an admin'}` : ''}.`,
          matchId: p.matchId,
          replay: null,
          ref: { type: 'penalty', id: p.id },
        });
      }
    }
    return out;
  },
};
```

`src/admin/timeline/bans.ts`:

```ts
import { WITHHELD_REASON, banIsWithheld } from '../banRedaction.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; reason: string; created_by: string; created_by_name: string | null;
  created_at: string; expires_at: string | null; lifted_at: string | null;
  lifted_by_name: string | null; ticket_id: number | null;
}

/** How long a ban ran, in the words the panel's own ban form offers. Derived
 *  from the two timestamps because the minutes an admin picked are not
 *  stored: only the expiry they produced is. */
export function fmtBanLength(createdAt: string, expiresAt: string | null): string {
  if (!expiresAt) return 'permanent';
  const m = Math.round((Date.parse(toIso(expiresAt)) - Date.parse(toIso(createdAt))) / 60_000);
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

/** Bans, with the reason of one issued from a ticket this viewer cannot see
 *  withheld rather than dropped. */
export const bansAdapter: TimelineAdapter = {
  source: 'ban',
  items({ db, ids, viewer }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT b.id, b.reason, b.created_by, pc.name AS created_by_name, b.created_at,
              b.expires_at, b.lifted_at, pl.name AS lifted_by_name, b.ticket_id
       FROM bans b
       LEFT JOIN players pc ON pc.steamid = b.created_by
       LEFT JOIN players pl ON pl.steamid = b.lifted_by
       WHERE b.player_id IN (${marks(ids)}) ORDER BY b.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => {
      const withheld = banIsWithheld(db, r.ticket_id, viewer);
      const by = withheld ? 'a moderator' : (r.created_by_name ?? r.created_by);
      return {
        at: toIso(r.created_at),
        source: 'ban' as const,
        kind: r.lifted_at ? 'lifted' : 'ban',
        summary: `Banned by ${by}, ${fmtBanLength(r.created_at, r.expires_at)}: `
          + `${withheld ? WITHHELD_REASON : r.reason}.`
          + (r.lifted_at ? ` Lifted ${withheld ? '' : `by ${r.lifted_by_name ?? 'the system'} `}since.` : ''),
        matchId: null,
        replay: null,
        ref: { type: 'ban', id: r.id },
      };
    });
  },
};
```

`src/admin/timeline/notes.ts`:

```ts
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; author_id: string; author_name: string | null; text: string; created_at: string }

/** What staff have written about this player by hand. Reviews land here too
 *  once Task 5 adds them, because "somebody looked at this and thought it was
 *  fine" is exactly the kind of note the next person needs. */
export const notesAdapter: TimelineAdapter = {
  source: 'note',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at
       FROM player_notes n LEFT JOIN players a ON a.steamid = n.author_id
       WHERE n.player_id IN (${marks(ids)}) ORDER BY n.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.created_at),
      source: 'note' as const,
      kind: 'note',
      summary: `${r.author_name ?? r.author_id}: ${r.text}`,
      matchId: null,
      replay: null,
      ref: { type: 'note', id: r.id },
    }));
  },
};
```

`src/admin/timeline/discordLinks.ts`:

```ts
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; discord_id: string; discord_name: string; linked_at: string; linked_by: string;
  unlinked_at: string | null; unlinked_by: string | null;
}

/** Every Discord account this Steam account has held, linked and unlinked.
 *  One Discord passing between Steam accounts is the plainest sign of an alt
 *  this site has, which is why both ends of each link are listed. */
export const discordLinksAdapter: TimelineAdapter = {
  source: 'discord_link',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, discord_id, discord_name, linked_at, linked_by, unlinked_at, unlinked_by
       FROM discord_link_history WHERE steamid IN (${marks(ids)}) ORDER BY id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    const out: TimelineItem[] = [];
    for (const r of rows) {
      const who = `${r.discord_name || 'unknown'} (${r.discord_id})`;
      out.push({
        at: toIso(r.linked_at),
        source: 'discord_link',
        kind: 'linked',
        summary: r.linked_by === 'backfill'
          ? `Discord ${who} was already linked when the history began.`
          : `Linked Discord ${who}.`,
        matchId: null,
        replay: null,
        ref: { type: 'discord_link', id: r.id },
      });
      if (r.unlinked_at) {
        out.push({
          at: toIso(r.unlinked_at),
          source: 'discord_link',
          kind: 'unlinked',
          summary: `Unlinked Discord ${who}${r.unlinked_by === 'merge' ? ', by a merge' : ''}.`,
          matchId: null,
          replay: null,
          ref: { type: 'discord_link', id: r.id },
        });
      }
    }
    return out;
  },
};
```

- [ ] **Step 5: Register them and share the redaction with the ticket page**

In `src/admin/playerTimeline.ts` add the five imports and extend `ADAPTERS` so it reads:

```ts
export const ADAPTERS: TimelineAdapter[] = [
  inputAdapter,
  lilacAdapter,
  analyzerAdapter,
  dropsAdapter,
  steamAdapter,
  ticketsAdapter,
  penaltiesAdapter,
  bansAdapter,
  notesAdapter,
  discordLinksAdapter,
];
```

In `src/tickets/caseFile.ts`, delete the local `WITHHELD_REASON` constant and the local `redactBan` function together with the `canSeeTicket, getTicketRow` import, and use the shared rule instead. The imports at the top become:

```ts
import type { DB } from '../db.js';
import { playerDetail, type BanRow } from '../admin/players.js';
import { getPlayer } from '../players.js';
import { banRedactor } from '../admin/banRedaction.js';
import { ticketsAbout } from './views.js';
```

and inside `caseFile` the lookup block and `redact` become one line:

```ts
  const redact = banRedactor(db, steamid, viewer);
```

The `BanRow` import stays: `bans: d.bans.map(redact)` still needs the type at the call site.

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run tests/timelineRecords.test.ts tests/ticketRoutes.test.ts`
Expected: PASS, including the existing case-file redaction assertions.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin/timeline src/admin/banRedaction.ts src/admin/playerTimeline.ts src/tickets/caseFile.ts tests/timelineRecords.test.ts
git commit -m "Put tickets, penalties, bans, notes and Discord links on the timeline behind one redaction rule"
```

---

### Task 4: Who may open a file, and do what on it

**Files:**
- Create: `src/admin/fileAccess.ts`
- Test: `tests/fileAccess.test.ts`

**Interfaces:**
- Consumes: `getPlayer(db, steamid): PlayerRow | undefined` from `src/players.ts`; `resolveAlias(db, steamid): string` from `src/aliases.ts`; `hasStaffFlag(db, steamid): boolean` from `src/tickets/store.ts`.
- Produces:
  - `interface FileViewer { steamid: string; isAdmin: boolean; isMod: boolean }`
  - `fileViewer(db: DB, steamid: string): FileViewer`
  - `canOpenFile(db: DB, viewer: FileViewer, targetSteamid: string): boolean`
  - `type FileAction = 'note' | 'looked_at' | 'open_ticket' | 'ban' | 'timeout' | 'merge' | 'sign_out' | 'waive' | 'staff_flags'`
  - `fileActions(db: DB, viewer: FileViewer, target: string): FileAction[]`
  - `canDo(db: DB, viewer: FileViewer, target: string, action: FileAction): boolean`

- [ ] **Step 1: Write the failing test**

`tests/fileAccess.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { canDo, canOpenFile, fileActions, fileViewer } from '../src/admin/fileAccess.js';

const PLAYER = '76561199000000001';
const ALT = '76561199000000002';
const MOD = '76561199000000003';
const MOD2 = '76561199000000004';
const ADMIN = '76561199000000005';
const NOBODY = '76561199000000006';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [PLAYER, ALT, MOD, MOD2, ADMIN, NOBODY]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

describe('who may open a file', () => {
  it('admins open anything, including their own and another admin\'s', () => {
    const v = fileViewer(db, ADMIN);
    expect(v).toEqual({ steamid: ADMIN, isAdmin: true, isMod: false });
    for (const target of [PLAYER, MOD, ADMIN]) expect(canOpenFile(db, v, target)).toBe(true);
  });

  it('a moderator opens players but never themselves or other staff', () => {
    const v = fileViewer(db, MOD);
    expect(canOpenFile(db, v, PLAYER)).toBe(true);
    expect(canOpenFile(db, v, MOD)).toBe(false);
    expect(canOpenFile(db, v, MOD2)).toBe(false);
    expect(canOpenFile(db, v, ADMIN)).toBe(false);
  });

  it('a moderator cannot reach their own file through a merged second account', () => {
    addAlias(db, { steamid: ALT, canonical: MOD, by: 'test' });
    expect(canOpenFile(db, fileViewer(db, MOD), ALT)).toBe(false);
    // And a merged alt of a plain player is still that player's file.
    expect(canOpenFile(db, fileViewer(db, ADMIN), ALT)).toBe(true);
  });

  it('anybody else opens nothing', () => {
    expect(canOpenFile(db, fileViewer(db, NOBODY), PLAYER)).toBe(false);
    expect(fileActions(db, fileViewer(db, NOBODY), PLAYER)).toEqual([]);
  });
});

describe('what a viewer may do on a file', () => {
  it('a moderator writes notes, marks it looked at and opens a ticket, and nothing else', () => {
    const v = fileViewer(db, MOD);
    expect(fileActions(db, v, PLAYER)).toEqual(['note', 'looked_at', 'open_ticket']);
    for (const action of ['note', 'looked_at', 'open_ticket'] as const) {
      expect(canDo(db, v, PLAYER, action)).toBe(true);
    }
    for (const action of ['ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags'] as const) {
      expect(canDo(db, v, PLAYER, action)).toBe(false);
    }
  });

  it('an admin may do all of it, and nobody may act on a file they cannot open', () => {
    const admin = fileViewer(db, ADMIN);
    expect(canDo(db, admin, PLAYER, 'ban')).toBe(true);
    expect(canDo(db, admin, PLAYER, 'merge')).toBe(true);
    expect(canDo(db, fileViewer(db, MOD), ADMIN, 'note')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/fileAccess.test.ts`
Expected: FAIL, cannot resolve `../src/admin/fileAccess.js`.

- [ ] **Step 3: Write it**

`src/admin/fileAccess.ts`:

```ts
import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { hasStaffFlag } from '../tickets/store.js';

/**
 * One place that decides what a viewer may open and do on a Player File.
 *
 * The API asks this and the UI only hides what it would refuse, so a control
 * that should not be there is a cosmetic bug rather than a hole. A file the
 * viewer may not open is a 404 at the route, never a 403: who is staff and
 * who has a file open about them is not something to leak by status code.
 */
export interface FileViewer {
  steamid: string;
  isAdmin: boolean;
  isMod: boolean;
}

export function fileViewer(db: DB, steamid: string): FileViewer {
  const p = getPlayer(db, steamid);
  return { steamid, isAdmin: p?.is_admin === 1, isMod: p?.is_mod === 1 };
}

/**
 * Admins open any file. Moderators open any file except their own and the
 * files of other staff: a moderator reading the evidence gathered about a
 * colleague, or about themselves, is the case the tickets work already keeps
 * apart, and the file is the same information in one place.
 *
 * Aliases are resolved on both sides, so neither a merged second account of
 * the viewer nor of the target is a way round the rule.
 */
export function canOpenFile(db: DB, viewer: FileViewer, targetSteamid: string): boolean {
  if (!viewer.isAdmin && !viewer.isMod) return false;
  if (viewer.isAdmin) return true;
  const target = resolveAlias(db, targetSteamid);
  if (target === resolveAlias(db, viewer.steamid)) return false;
  // hasStaffFlag ignores status on purpose: a banned moderator is still a
  // colleague for the purpose of keeping the others out of their file.
  return !hasStaffFlag(db, target);
}

/** Everything a file offers. `waive` has no route yet: it belongs to the
 *  Live work, which adds waiving an automatic penalty or abandon ban, and it
 *  is listed here so the Standing section has one name to ask about. */
export type FileAction =
  | 'note' | 'looked_at' | 'open_ticket'
  | 'ban' | 'timeout' | 'merge' | 'sign_out' | 'waive' | 'staff_flags';

/** A moderator writes a note, marks a file looked at, and opens a ticket. A
 *  moderator bans only from a ticket and only up to the configured cap,
 *  which is the tickets route and is not reachable from here. */
const MOD_ACTIONS: FileAction[] = ['note', 'looked_at', 'open_ticket'];
const ADMIN_ACTIONS: FileAction[] = [
  ...MOD_ACTIONS, 'ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags',
];

export function fileActions(db: DB, viewer: FileViewer, target: string): FileAction[] {
  if (!canOpenFile(db, viewer, target)) return [];
  return viewer.isAdmin ? ADMIN_ACTIONS : MOD_ACTIONS;
}

export function canDo(db: DB, viewer: FileViewer, target: string, action: FileAction): boolean {
  return fileActions(db, viewer, target).includes(action);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/fileAccess.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/fileAccess.ts tests/fileAccess.test.ts
git commit -m "Decide file access and file actions in one place"
```

---

### Task 5: Reviews: marking a file looked at

**Files:**
- Create: `src/admin/reviews.ts`
- Modify: `src/db.ts` (the `player_reviews` table, immediately before the `ensureTicketSchema(db);` call near line 1017), `src/mergePlayers.ts:23-50` (two `PLAIN` entries), `src/admin/timeline/notes.ts` (reviews as `kind: 'review'`)
- Test: `tests/playerReviews.test.ts`

**Interfaces:**
- Consumes: `resolveAlias`, `ensureColumn` conventions in `src/db.ts`, `mergePlayers(db, { from, into, by })` from `src/mergePlayers.ts`.
- Produces:
  - `interface FileReview { id: number; steamid: string; reviewedBy: string; reviewedByName: string | null; reviewedAt: string; note: string }`
  - `markLookedAt(db: DB, steamid: string, by: string, note?: string, now?: Date): FileReview`
  - `lastReviewOf(db: DB, steamid: string): FileReview | null`
  - `reviewsOf(db: DB, ids: string[], limit?: number): FileReview[]`
  - table `player_reviews (id, steamid, reviewed_by, reviewed_at, note)`

- [ ] **Step 1: Write the failing test**

`tests/playerReviews.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { mergePlayers, MERGE_HANDLED_PLAYER_COLUMNS } from '../src/mergePlayers.js';
import { lastReviewOf, markLookedAt, reviewsOf } from '../src/admin/reviews.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';

const MAIN = '76561199000000001';
const ALT = '76561199000000002';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, STAFF]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
});

describe('reviews', () => {
  it('records who looked, when, and with what note', () => {
    const r = markLookedAt(db, MAIN, STAFF, 'watched the clip, nothing there', new Date('2026-09-21T10:00:00.000Z'));
    expect(r).toMatchObject({ steamid: MAIN, reviewedBy: STAFF, reviewedAt: '2026-09-21T10:00:00.000Z' });
    expect(r.reviewedByName).toBe('p009');
    expect(lastReviewOf(db, MAIN)).toMatchObject({ id: r.id, note: 'watched the clip, nothing there' });
    expect(lastReviewOf(db, ALT)).toBeNull();
  });

  it('keeps only the newest as the last review, and follows a merged account', () => {
    markLookedAt(db, MAIN, STAFF, 'first', new Date('2026-09-20T10:00:00.000Z'));
    markLookedAt(db, MAIN, STAFF, 'second', new Date('2026-09-21T10:00:00.000Z'));
    expect(lastReviewOf(db, MAIN)!.note).toBe('second');
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'test' });
    expect(lastReviewOf(db, ALT)!.note).toBe('second');
    expect(reviewsOf(db, [MAIN])).toHaveLength(2);
  });

  it('shows on the timeline as a note of its own kind', () => {
    markLookedAt(db, MAIN, STAFF, 'nothing to see', new Date('2026-09-21T10:00:00.000Z'));
    const [item] = playerTimeline(db, MAIN, STAFF);
    expect(item.source).toBe('note');
    expect(item.kind).toBe('review');
    expect(item.summary).toContain('looked at this file');
    expect(item.summary).toContain('nothing to see');
  });

  it('a merge carries reviews onto the surviving account', () => {
    markLookedAt(db, ALT, STAFF, 'on the alt');
    mergePlayers(db, { from: ALT, into: MAIN, by: STAFF });
    expect(lastReviewOf(db, MAIN)!.note).toBe('on the alt');
    expect(MERGE_HANDLED_PLAYER_COLUMNS).toContainEqual(['player_reviews', 'steamid']);
    expect(MERGE_HANDLED_PLAYER_COLUMNS).toContainEqual(['player_reviews', 'reviewed_by']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/playerReviews.test.ts`
Expected: FAIL, cannot resolve `../src/admin/reviews.js`.

- [ ] **Step 3: The table**

In `src/db.ts`, immediately before the `ensureTicketSchema(db);` line near the end of `openDb`:

```ts
  // "Somebody has looked at this file." What takes a player off the Needs a
  // look list, and what puts them back when something newer arrives.
  //
  // No foreign key on steamid, like the evidence tables: the evidence that
  // raises a file can sit under a merged alt's id, and a review of that file
  // must not be blocked by whether that id still has a player row. No CHECK
  // anywhere: this is a log, and a log has nothing to constrain.
  db.exec(`CREATE TABLE IF NOT EXISTS player_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid     TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT ''
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS player_reviews_steamid ON player_reviews (steamid, reviewed_at)');
```

- [ ] **Step 4: The module**

`src/admin/reviews.ts`:

```ts
import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { marks, toIso } from './timeline/types.js';

export interface FileReview {
  id: number;
  steamid: string;
  reviewedBy: string;
  reviewedByName: string | null;
  reviewedAt: string;
  note: string;
}

interface Row { id: number; steamid: string; reviewed_by: string; name: string | null; reviewed_at: string; note: string }

const SELECT = `SELECT r.id, r.steamid, r.reviewed_by, p.name, r.reviewed_at, r.note
  FROM player_reviews r LEFT JOIN players p ON p.steamid = r.reviewed_by`;

const toReview = (r: Row): FileReview => ({
  id: r.id, steamid: r.steamid, reviewedBy: r.reviewed_by, reviewedByName: r.name,
  reviewedAt: toIso(r.reviewed_at), note: r.note,
});

/** Somebody looked. Written against the canonical account, so a review of a
 *  file reached through a merged alt still settles the person. */
export function markLookedAt(
  db: DB, steamid: string, by: string, note = '', now = new Date(),
): FileReview {
  const canonical = resolveAlias(db, steamid);
  const at = now.toISOString();
  const id = Number(db.prepare(
    'INSERT INTO player_reviews (steamid, reviewed_by, reviewed_at, note) VALUES (?, ?, ?, ?)',
  ).run(canonical, by, at, note.slice(0, 1000)).lastInsertRowid);
  return toReview(db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row);
}

/** The newest review of this file, or null. */
export function lastReviewOf(db: DB, steamid: string): FileReview | null {
  const canonical = resolveAlias(db, steamid);
  const row = db.prepare(
    `${SELECT} WHERE r.steamid = ? ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1`,
  ).get(canonical) as Row | undefined;
  return row ? toReview(row) : null;
}

/** Every review held under any of these ids, newest first. For the timeline,
 *  which already knows the canonical id and each alias. */
export function reviewsOf(db: DB, ids: string[], limit = 200): FileReview[] {
  return (db.prepare(
    `${SELECT} WHERE r.steamid IN (${marks(ids)}) ORDER BY r.id DESC LIMIT ?`,
  ).all(...ids, limit) as Row[]).map(toReview);
}
```

- [ ] **Step 5: Reviews on the timeline**

In `src/admin/timeline/notes.ts`, import the reviews and append them. The file becomes:

```ts
import { reviewsOf } from '../reviews.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; author_id: string; author_name: string | null; text: string; created_at: string }

/** What staff have written about this player by hand, and every time one of
 *  them marked the file looked at. A review belongs beside the notes because
 *  "somebody read this and thought it was fine" is exactly what the next
 *  person needs to know before reading the same evidence again. */
export const notesAdapter: TimelineAdapter = {
  source: 'note',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at
       FROM player_notes n LEFT JOIN players a ON a.steamid = n.author_id
       WHERE n.player_id IN (${marks(ids)}) ORDER BY n.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    const notes: TimelineItem[] = rows.map((r) => ({
      at: toIso(r.created_at),
      source: 'note' as const,
      kind: 'note',
      summary: `${r.author_name ?? r.author_id}: ${r.text}`,
      matchId: null,
      replay: null,
      ref: { type: 'note', id: r.id },
    }));
    const reviews: TimelineItem[] = reviewsOf(db, ids, ROW_LIMIT).map((r) => ({
      at: r.reviewedAt,
      source: 'note' as const,
      kind: 'review',
      summary: `${r.reviewedByName ?? r.reviewedBy} looked at this file`
        + `${r.note ? `: ${r.note}` : '.'}`,
      matchId: null,
      replay: null,
      ref: { type: 'review', id: r.id },
    }));
    return [...notes, ...reviews];
  },
};
```

- [ ] **Step 6: Teach the merge about them**

In `src/mergePlayers.ts`, add to `PLAIN`, next to the other evidence tables that carry no foreign key:

```ts
  // Reviews of the file. The steamid moves; so does the reviewer, for the
  // case where a member of staff was themselves merged.
  ['player_reviews', 'steamid'],
  ['player_reviews', 'reviewed_by'],
```

- [ ] **Step 7: Run and watch it pass**

Run: `npx vitest run tests/playerReviews.test.ts tests/mergePlayers.test.ts tests/db.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/admin/reviews.ts src/admin/timeline/notes.ts src/db.ts src/mergePlayers.ts tests/playerReviews.test.ts
git commit -m "Record that a file was looked at and show reviews on its timeline"
```

---

### Task 6: Analyzer ranks, and the Needs a look list

**Files:**
- Create: `src/admin/analyzerRanks.ts`, `src/admin/needsALook.ts`
- Test: `tests/needsALook.test.ts`

**Interfaces:**
- Consumes: `integrityBoard(db, seasonId: number | null): IntegrityBoardRow[]` from `src/admin/integrity.ts` (which keeps the `MIN_BOARD_ROUNDS` gate and the current analyzer version); `ADAPTERS` from `src/admin/playerTimeline.ts`; `lastReviewOf` from `src/admin/reviews.ts`; `canOpenFile`, `FileViewer` from `src/admin/fileAccess.ts`; `ticketsAbout` from `src/tickets/views.ts`; `getPlayer` from `src/players.ts`.
- Produces:
  - `interface AnalyzerRank { steamid: string; ranked: boolean; rank: number | null; of: number; rounds: number; eligibleRounds: number; clips: number; trackShare: number | null; occZ: number | null; teamGap: number | null; pFid: number | null; pOcc: number | null; pGap: number | null; composite: number | null }`
  - `analyzerRanks(db: DB, seasonId?: number | null): Map<string, AnalyzerRank>`
  - `analyzerRankOf(db: DB, steamid: string, seasonId?: number | null): AnalyzerRank | null`
  - `interface NeedsALookRow { steamid: string; name: string; avatar: string | null; status: string; newestEvidenceAt: string; sources: EvidenceSource[]; lastReviewAt: string | null; lastReviewBy: string | null; openTickets: number; analyzer: AnalyzerRank | null }`
  - `needsALook(db: DB, viewer: FileViewer, adapters?: TimelineAdapter[]): NeedsALookRow[]`

- [ ] **Step 1: Write the failing test**

`tests/needsALook.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { markLookedAt } from '../src/admin/reviews.js';
import { needsALook } from '../src/admin/needsALook.js';

const P = '76561199000000001';
const ALT = '76561199000000002';
const MOD = '76561199000000003';
const ADMIN = '76561199000000005';
const STRANGER = '76561198005192651';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, ALT, MOD, ADMIN]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

const drop = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at, entered_after_at)
     VALUES (?, 'n', 5, 651, ?, NULL)`,
  ).run(steamid, at);

describe('Needs a look', () => {
  it('lists a player with new evidence, drops them once reviewed, and brings them back when something newer arrives', () => {
    const admin = fileViewer(db, ADMIN);
    flag(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, admin).map((r) => r.steamid)).toEqual([P]);
    expect(needsALook(db, admin)[0].sources).toEqual(['lilac']);

    markLookedAt(db, P, ADMIN, '', new Date('2026-09-20T11:00:00.000Z'));
    expect(needsALook(db, admin)).toEqual([]);

    flag(P, '2026-09-21T10:00:00.000Z');
    const back = needsALook(db, admin);
    expect(back).toHaveLength(1);
    expect(back[0].newestEvidenceAt).toBe('2026-09-21T10:00:00.000Z');
    expect(back[0].lastReviewAt).toBe('2026-09-20T11:00:00.000Z');
    expect(back[0].lastReviewBy).toBe('p005');
  });

  it('one connect drop lists nobody, a repeat lists them', () => {
    const admin = fileViewer(db, ADMIN);
    drop(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, admin)).toEqual([]);
    drop(P, '2026-09-20T10:04:00.000Z');
    expect(needsALook(db, admin).map((r) => r.sources)).toEqual([['drop']]);
  });

  it('counts evidence held under a merged second account as the main account\'s', () => {
    flag(ALT, '2026-09-20T10:00:00.000Z');
    addAlias(db, { steamid: ALT, canonical: P, by: 'test' });
    expect(needsALook(db, fileViewer(db, ADMIN)).map((r) => r.steamid)).toEqual([P]);
  });

  it('never lists a moderator their own file or another member of staff', () => {
    flag(MOD, '2026-09-20T10:00:00.000Z');
    flag(ADMIN, '2026-09-20T10:00:00.000Z');
    flag(P, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, fileViewer(db, MOD)).map((r) => r.steamid)).toEqual([P]);
    expect(needsALook(db, fileViewer(db, ADMIN)).map((r) => r.steamid).sort())
      .toEqual([MOD, ADMIN, P].sort());
  });

  it('leaves off an id that has never signed in here, because it has no file to open', () => {
    flag(STRANGER, '2026-09-20T10:00:00.000Z');
    expect(needsALook(db, fileViewer(db, ADMIN))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/needsALook.test.ts`
Expected: FAIL, cannot resolve `../src/admin/needsALook.js`.

- [ ] **Step 3: The analyzer rank lookup**

`src/admin/analyzerRanks.ts`:

```ts
import type { DB } from '../db.js';
import { integrityBoard } from './integrity.js';

/**
 * The integrity board as a per-player lookup.
 *
 * Same numbers, same gate: integrityBoard scores at read time, keeps the
 * current analyzer version only, and leaves anybody under MIN_BOARD_ROUNDS
 * unranked and listed last. The board's own screen is going away, so what
 * the columns meant moves onto the file and onto the Needs a look list, and
 * the rank comes from here rather than being recomputed alongside it.
 *
 * Rank is the place among RANKED players, which is what "1 of 82" has always
 * meant on that board: a sort key over a named population, not a claim.
 */
export interface AnalyzerRank {
  steamid: string;
  ranked: boolean;
  rank: number | null;
  /** How many players are ranked at all, the denominator of `rank`. */
  of: number;
  rounds: number;
  eligibleRounds: number;
  clips: number;
  trackShare: number | null;
  occZ: number | null;
  teamGap: number | null;
  pFid: number | null;
  pOcc: number | null;
  pGap: number | null;
  composite: number | null;
}

export function analyzerRanks(db: DB, seasonId: number | null = null): Map<string, AnalyzerRank> {
  const board = integrityBoard(db, seasonId);
  const of = board.filter((p) => p.ranked).length;
  return new Map(board.map((p, i) => [p.steamid, {
    steamid: p.steamid,
    ranked: p.ranked,
    // Unranked rows come after every ranked one, so the index is the rank
    // for exactly the rows that have one.
    rank: p.ranked ? i + 1 : null,
    of,
    rounds: p.rounds,
    eligibleRounds: p.eligibleRounds,
    clips: p.clips,
    trackShare: p.trackShare,
    occZ: p.occZ,
    teamGap: p.teamGap,
    pFid: p.pFid,
    pOcc: p.pOcc,
    pGap: p.pGap,
    composite: p.composite,
  }]));
}

export function analyzerRankOf(
  db: DB, steamid: string, seasonId: number | null = null,
): AnalyzerRank | null {
  return analyzerRanks(db, seasonId).get(steamid) ?? null;
}
```

- [ ] **Step 4: The list**

`src/admin/needsALook.ts`:

```ts
import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { ticketsAbout } from '../tickets/views.js';
import { analyzerRanks, type AnalyzerRank } from './analyzerRanks.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { ADAPTERS } from './playerTimeline.js';
import { lastReviewOf } from './reviews.js';
import { toIso, type EvidenceSource, type TimelineAdapter } from './timeline/types.js';

export interface NeedsALookRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  newestEvidenceAt: string;
  sources: EvidenceSource[];
  lastReviewAt: string | null;
  /** The reviewer as a person reads them: their name, or their id when the
   *  site has never seen one. */
  lastReviewBy: string | null;
  openTickets: number;
  analyzer: AnalyzerRank | null;
}

/**
 * Players whose newest evidence is newer than their newest review.
 *
 * The only question asked of each source is "what is the newest thing you
 * hold about this id", which is why an adapter contributes one row per
 * player rather than all of them. A single connect drop is not evidence and
 * drops.ts already answers accordingly.
 *
 * An id with no player row is left off: it has no file to open, and a row
 * that 404s when clicked is worse than an absent one. The evidence is still
 * on the file of whoever that id was merged into, because ids are resolved
 * here before anything is compared.
 */
export function needsALook(
  db: DB, viewer: FileViewer, adapters: TimelineAdapter[] = ADAPTERS,
): NeedsALookRow[] {
  const newest = new Map<string, { at: string; sources: Set<EvidenceSource> }>();
  for (const adapter of adapters) {
    if (!adapter.evidence) continue;
    let rows: { steamid: string; at: string }[];
    try {
      rows = adapter.evidence(db);
    } catch (err) {
      console.error(`[needs a look] the ${adapter.source} source failed:`, err);
      continue;
    }
    for (const row of rows) {
      const id = resolveAlias(db, row.steamid);
      const at = toIso(row.at);
      const seen = newest.get(id) ?? { at: '', sources: new Set<EvidenceSource>() };
      // Only an adapter that offers evidence() gets here, and those are
      // exactly the evidence sources.
      seen.sources.add(adapter.source as EvidenceSource);
      if (at > seen.at) seen.at = at;
      newest.set(id, seen);
    }
  }

  const ranks = analyzerRanks(db);
  const out: NeedsALookRow[] = [];
  for (const [steamid, { at, sources }] of newest) {
    const player = getPlayer(db, steamid);
    if (!player) continue;
    if (!canOpenFile(db, viewer, steamid)) continue;
    const review = lastReviewOf(db, steamid);
    if (review && review.reviewedAt >= at) continue;
    out.push({
      steamid,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      newestEvidenceAt: at,
      sources: [...sources].sort(),
      lastReviewAt: review?.reviewedAt ?? null,
      lastReviewBy: review === null ? null : (review.reviewedByName ?? review.reviewedBy),
      openTickets: ticketsAbout(db, steamid, viewer.steamid).filter((t) => t.status === 'open').length,
      analyzer: ranks.get(steamid) ?? null,
    });
  }
  return out.sort((a, b) => (a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1));
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run tests/needsALook.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin/analyzerRanks.ts src/admin/needsALook.ts tests/needsALook.test.ts
git commit -m "List the files with evidence nobody has reviewed"
```

---

### Task 7: The Player File, its summary, and the ban list

**Files:**
- Create: `src/admin/playerFileSummary.ts`, `src/admin/playerFile.ts`, `src/admin/peopleBans.ts`
- Test: `tests/playerFile.test.ts`

**Interfaces:**
- Consumes: `searchPlayers(db, q, limit?): AdminPlayerRow[]`, `activeBan(db, steamid, now?): BanRow | null`, `BanRow` from `src/admin/players.ts`; `activeTimeout(db, steamid, now?)` and `penaltyHistory(db, steamid, limit?)` from `src/penalties.ts`; `steamAccountView(db, steamid, now?)` from `src/admin/steamAccount.ts`; `integrityPlayer(db, steamid)` from `src/admin/integrity.ts`; `detectionsForPlayer(db, steamid, limit?)` and `capsForPlayer(db, steamid, limit?)` from `src/inputBursts.ts`; `signonDropSummary(db, steamid, limit?)` from `src/signonDrops.ts`; `networksOf`, `sharesAddressWith` from `src/playerNetworks.ts`; `discordHistoryOf`, `getPlayer` from `src/players.ts`; `aliasesOf`, `resolveAlias` from `src/aliases.ts`; `ticketsAbout` from `src/tickets/views.ts`; Tasks 1 to 6.
- Produces:
  - `const EVIDENCE_WINDOW_DAYS = 30`
  - `interface EvidenceCount { source: EvidenceSource; count: number }`
  - `interface PlayerFileSummary { ... fileUrl: string | null }`
  - `playerFileSummary(db: DB, steamid: string, viewer: FileViewer, opts?: { now?: Date; timeline?: TimelineItem[] }): PlayerFileSummary | null`
  - `interface PlayerFile { steamid; header; glance; timeline; sections; actions; lastReview }`
  - `playerFile(db: DB, steamid: string, viewer: FileViewer, now?: Date): PlayerFile | null`
  - `interface PeopleBanRow { ... canOpen: boolean; withheld: boolean }`
  - `peopleBans(db: DB, viewer: FileViewer, opts?: { filter?: 'active' | 'expired' | 'all'; q?: string; now?: Date }): PeopleBanRow[]`

- [ ] **Step 1: Write the failing test**

`tests/playerFile.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { banPlayer, addNote } from '../src/admin/players.js';
import { recordPenalty } from '../src/penalties.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { playerFile } from '../src/admin/playerFile.js';
import { playerFileSummary } from '../src/admin/playerFileSummary.js';
import { peopleBans } from '../src/admin/peopleBans.js';
import { markLookedAt } from '../src/admin/reviews.js';
import { WITHHELD_REASON } from '../src/admin/banRedaction.js';
import { openStaffTicket } from '../src/tickets/filing.js';
import { banFromTicket, setRestricted } from '../src/tickets/actions.js';

const P = '76561199000000001';
const MOD = '76561199000000003';
const ADMIN = '76561199000000005';
const OTHER = '76561199000000006';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, MOD, ADMIN, OTHER]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

describe('the Player File', () => {
  it('is null for an unknown player and for a file the viewer may not open', () => {
    expect(playerFile(db, '76561199000000999', fileViewer(db, ADMIN))).toBeNull();
    expect(playerFile(db, MOD, fileViewer(db, MOD))).toBeNull();
    expect(playerFile(db, ADMIN, fileViewer(db, MOD))).toBeNull();
    expect(playerFile(db, P, fileViewer(db, OTHER))).toBeNull();
  });

  it('carries a header, a glance, a timeline and every section', () => {
    recordPenalty(db, P, 'no_show', null);
    addNote(db, P, ADMIN, 'spoke to them');
    flag(P, new Date().toISOString());
    const file = playerFile(db, P, fileViewer(db, ADMIN))!;

    expect(file.header).toMatchObject({ steamid: P, name: 'p001', status: 'active', isAdmin: false });
    expect(file.glance.evidence).toContainEqual({ source: 'lilac', count: 1 });
    expect(file.glance.fileUrl).toBe(`/admin/people/${P}`);
    expect(file.timeline.length).toBeGreaterThan(0);
    expect(Object.keys(file.sections).sort())
      .toEqual(['evidence', 'identity', 'matches', 'notes', 'standing', 'tickets']);
    expect(file.sections.notes[0].text).toBe('spoke to them');
    expect(file.sections.standing.penalties).toHaveLength(1);
    expect(file.lastReview).toBeNull();
    markLookedAt(db, P, ADMIN, 'fine');
    expect(playerFile(db, P, fileViewer(db, ADMIN))!.lastReview!.note).toBe('fine');
  });

  it('counts evidence only inside the window, so an old flag stops shouting', () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    flag(P, old);
    const summary = playerFileSummary(db, P, fileViewer(db, ADMIN))!;
    expect(summary.evidence).toEqual([]);
  });

  it('gives a moderator every section and only the moderator actions', () => {
    const asMod = playerFile(db, P, fileViewer(db, MOD))!;
    expect(asMod.actions).toEqual(['note', 'looked_at', 'open_ticket']);
    // The owner reversed the first ruling: mods see network rows too.
    expect(asMod.sections.identity).toHaveProperty('sharesAddressWith');
    expect(asMod.sections.identity).toHaveProperty('networks');
    expect(playerFile(db, P, fileViewer(db, ADMIN))!.actions).toContain('ban');
  });

  it('withholds a restricted ticket\'s ban reason in the standing section and on the ban list', () => {
    const t = openStaffTicket(db, ADMIN, { targetId: P, restricted: true }, { adminSteamIds: [ADMIN] }) as { ticketId: number };
    setRestricted(db, t.ticketId, ADMIN, true, [ADMIN]);
    banFromTicket(db, t.ticketId, ADMIN, 'cheating, see the case', 1440);

    const asMod = playerFile(db, P, fileViewer(db, MOD))!;
    expect(asMod.sections.standing.bans[0].reason).toBe(WITHHELD_REASON);
    expect(asMod.sections.standing.activeBan!.createdBy).toBe('');

    const [row] = peopleBans(db, fileViewer(db, MOD));
    expect(row.reason).toBe(WITHHELD_REASON);
    expect(row.withheld).toBe(true);
    expect(row.ticketId).toBeNull();
    expect(peopleBans(db, fileViewer(db, ADMIN))[0].reason).toBe('cheating, see the case');
  });
});

describe('the ban list inside the panel', () => {
  it('filters, searches, says how long each ran, and says which rows open a file', () => {
    banPlayer(db, P, ADMIN, 'throwing', 1440);
    banPlayer(db, MOD, ADMIN, 'left a match', null);
    const admin = fileViewer(db, ADMIN);

    expect(peopleBans(db, admin).map((b) => b.steamid).sort()).toEqual([MOD, P].sort());
    expect(peopleBans(db, admin, { filter: 'active' })).toHaveLength(2);
    expect(peopleBans(db, admin, { filter: 'expired' })).toHaveLength(0);
    expect(peopleBans(db, admin, { q: 'p001' }).map((b) => b.steamid)).toEqual([P]);
    expect(peopleBans(db, admin).find((b) => b.steamid === P)!.length).toBe('1 day');
    expect(peopleBans(db, admin).find((b) => b.steamid === MOD)!.length).toBe('permanent');

    // A moderator sees the staff row and is told they cannot open that file.
    const asMod = peopleBans(db, fileViewer(db, MOD));
    expect(asMod.find((b) => b.steamid === MOD)!.canOpen).toBe(false);
    expect(asMod.find((b) => b.steamid === P)!.canOpen).toBe(true);
  });

  it('counts an expired ban as expired without hiding it', () => {
    banPlayer(db, P, ADMIN, 'short', 1, new Date(Date.now() - 3 * 60_000));
    const rows = peopleBans(db, fileViewer(db, ADMIN), { filter: 'expired' });
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
    expect(peopleBans(db, fileViewer(db, ADMIN), { filter: 'active' })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/playerFile.test.ts`
Expected: FAIL, cannot resolve `../src/admin/playerFile.js`.

- [ ] **Step 3: The shared summary**

`src/admin/playerFileSummary.ts`:

```ts
import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { activeTimeout, penaltyHistory } from '../penalties.js';
import { sharesAddressWith } from '../playerNetworks.js';
import { ticketsAbout } from '../tickets/views.js';
import { activeBan, searchPlayers, type BanRow } from './players.js';
import { steamAccountView } from './steamAccount.js';
import { analyzerRankOf, type AnalyzerRank } from './analyzerRanks.js';
import { banRedactor } from './banRedaction.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { lastReviewOf, type FileReview } from './reviews.js';
import { playerTimeline } from './playerTimeline.js';
import { isEvidence, type EvidenceSource, type TimelineItem } from './timeline/types.js';

/** How far back "is there anything here" looks. Older evidence is still on
 *  the timeline; it is simply not news. */
export const EVIDENCE_WINDOW_DAYS = 30;

export interface EvidenceCount { source: EvidenceSource; count: number }

/**
 * The compact answer to "is there anything here", shared by the file's own
 * At a glance row and the accused's section of a ticket page.
 *
 * One builder on purpose: a new evidence source then appears in both places
 * the day its adapter lands, rather than in whichever of them somebody
 * remembered.
 */
export interface PlayerFileSummary {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
  isMod: boolean;
  sr: number | null;
  games: number;
  createdAt: string | null;
  activeBan: BanRow | null;
  bans: number;
  penalties: number;
  timeout: { until: string; offenses: number } | null;
  openTickets: number;
  aliases: number;
  sharesAddressWith: { steamid: string; name: string }[];
  /** Steam's plain-worded flags: new account, banned elsewhere, borrowed
   *  game, private profile, low hours. Already hedged by steamAccountView. */
  steamFlags: { kind: string; text: string }[];
  evidence: EvidenceCount[];
  analyzer: AnalyzerRank | null;
  lastReview: FileReview | null;
  /** Where the full file is, or null when this viewer may not open it. */
  fileUrl: string | null;
}

export function playerFileSummary(
  db: DB, steamid: string, viewer: FileViewer,
  opts: { now?: Date; timeline?: TimelineItem[] } = {},
): PlayerFileSummary | null {
  const canonical = resolveAlias(db, steamid);
  const player = getPlayer(db, canonical);
  if (!player) return null;
  const now = opts.now ?? new Date();
  const row = searchPlayers(db, canonical, 1).find((p) => p.steamid === canonical);
  // Reused when the caller has already built one: the file asks for the
  // timeline anyway and building it twice is the whole cost of this page.
  const timeline = opts.timeline ?? playerTimeline(db, canonical, viewer.steamid);
  const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * 86_400_000).toISOString();

  const counts = new Map<EvidenceSource, number>();
  for (const item of timeline) {
    if (!isEvidence(item) || item.at < since) continue;
    const source = item.source as EvidenceSource;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const redact = banRedactor(db, canonical, viewer.steamid);
  const ban = activeBan(db, canonical, now);
  const timeout = activeTimeout(db, canonical, now);
  const steam = steamAccountView(db, canonical, now);
  return {
    steamid: canonical,
    name: player.name,
    avatar: player.avatar,
    status: player.status,
    isAdmin: player.is_admin === 1,
    isMod: player.is_mod === 1,
    sr: row?.sr ?? null,
    games: row?.games ?? 0,
    createdAt: player.created_at,
    activeBan: ban ? redact(ban) : null,
    bans: (db.prepare('SELECT COUNT(*) AS n FROM bans WHERE player_id = ?').get(canonical) as { n: number }).n,
    penalties: penaltyHistory(db, canonical).length,
    timeout: timeout ? { until: timeout.until.toISOString(), offenses: timeout.offenses } : null,
    openTickets: ticketsAbout(db, canonical, viewer.steamid).filter((t) => t.status === 'open').length,
    aliases: aliasesOf(db, canonical).length,
    sharesAddressWith: sharesAddressWith(db, canonical).map((s) => ({ steamid: s.steamid, name: s.name })),
    steamFlags: steam?.flags ?? [],
    evidence: [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => a.source.localeCompare(b.source)),
    analyzer: analyzerRankOf(db, canonical),
    lastReview: lastReviewOf(db, canonical),
    fileUrl: canOpenFile(db, viewer, canonical) ? `/admin/people/${canonical}` : null,
  };
}
```

- [ ] **Step 4: The file**

`src/admin/playerFile.ts`:

```ts
import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { discordHistoryOf, getPlayer } from '../players.js';
import { penaltyHistory, activeTimeout } from '../penalties.js';
import { networksOf, sharesAddressWith } from '../playerNetworks.js';
import { capsForPlayer, detectionsForPlayer } from '../inputBursts.js';
import { signonDropSummary } from '../signonDrops.js';
import { ticketsAbout } from '../tickets/views.js';
import { activeBan, searchPlayers, type BanRow } from './players.js';
import { steamAccountView } from './steamAccount.js';
import { integrityPlayer } from './integrity.js';
import { analyzerRankOf } from './analyzerRanks.js';
import { banRedactor } from './banRedaction.js';
import { canOpenFile, fileActions, type FileAction, type FileViewer } from './fileAccess.js';
import { lastReviewOf, type FileReview } from './reviews.js';
import { playerFileSummary, type PlayerFileSummary } from './playerFileSummary.js';
import { playerTimeline } from './playerTimeline.js';
import type { TimelineItem } from './timeline/types.js';

export interface PlayerFile {
  steamid: string;
  header: {
    steamid: string;
    name: string;
    avatar: string | null;
    status: string;
    isAdmin: boolean;
    isMod: boolean;
    discordName: string | null;
    sr: number | null;
    games: number;
    createdAt: string;
  };
  glance: PlayerFileSummary;
  timeline: TimelineItem[];
  sections: {
    identity: ReturnType<typeof identity>;
    standing: {
      activeBan: BanRow | null;
      bans: BanRow[];
      penalties: ReturnType<typeof penaltyHistory>;
      timeout: { until: string; offenses: number } | null;
    };
    matches: unknown[];
    tickets: ReturnType<typeof ticketsAbout>;
    notes: { id: number; authorId: string; authorName: string | null; text: string; createdAt: string }[];
    evidence: ReturnType<typeof evidence>;
  };
  actions: FileAction[];
  lastReview: FileReview | null;
}

/** Aliases, Discord history, the Steam account and the shared connections.
 *  Moderators get all of it: the owner reversed the first ruling the same
 *  day, because "is this a second account" is exactly a moderator's job. */
function identity(db: DB, steamid: string) {
  return {
    aliases: aliasesOf(db, steamid),
    discordHistory: discordHistoryOf(db, steamid),
    steamAccount: steamAccountView(db, steamid),
    networks: networksOf(db, steamid),
    sharesAddressWith: sharesAddressWith(db, steamid),
  };
}

/** The evidence behind the timeline rows, for the reader who wants the
 *  numbers: bursts under an input flag, clips and rounds under an analyzer
 *  row, the drop rows, the live anti-cheat flags. */
function evidence(db: DB, steamid: string) {
  const integrity = integrityPlayer(db, steamid);
  return {
    analyzer: analyzerRankOf(db, steamid),
    rounds: integrity.rounds,
    clips: integrity.clips,
    flags: integrity.flags,
    inputFlags: detectionsForPlayer(db, steamid),
    inputCaps: capsForPlayer(db, steamid),
    signonDrops: signonDropSummary(db, steamid),
  };
}

/**
 * Everything known about one player, in one answer.
 *
 * Null both for a player who does not exist and for a file this viewer may
 * not open, so the route can turn either into the same 404: which members of
 * staff exist is not something to publish through a status code.
 */
export function playerFile(
  db: DB, steamid: string, viewer: FileViewer, now = new Date(),
): PlayerFile | null {
  const canonical = resolveAlias(db, steamid);
  const player = getPlayer(db, canonical);
  if (!player) return null;
  if (!canOpenFile(db, viewer, canonical)) return null;

  const row = searchPlayers(db, canonical, 1).find((p) => p.steamid === canonical);
  const timeline = playerTimeline(db, canonical, viewer.steamid);
  const redact = banRedactor(db, canonical, viewer.steamid);
  const ban = activeBan(db, canonical, now);
  const bans = (db.prepare(
    `SELECT b.*, pc.name AS created_by_name, pl.name AS lifted_by_name FROM bans b
     LEFT JOIN players pc ON pc.steamid = b.created_by
     LEFT JOIN players pl ON pl.steamid = b.lifted_by
     WHERE b.player_id = ? ORDER BY b.id DESC`,
  ).all(canonical) as {
    id: number; reason: string; created_by: string; created_at: string; expires_at: string | null;
    lifted_by: string | null; lifted_at: string | null; created_by_name: string | null; lifted_by_name: string | null;
  }[]).map((b) => redact({
    id: b.id, reason: b.reason, createdBy: b.created_by, createdAt: b.created_at,
    expiresAt: b.expires_at, liftedBy: b.lifted_by, liftedAt: b.lifted_at,
    createdByName: b.created_by_name, liftedByName: b.lifted_by_name,
  }));
  const notes = (db.prepare(
    `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at FROM player_notes n
     LEFT JOIN players a ON a.steamid = n.author_id WHERE n.player_id = ? ORDER BY n.id DESC`,
  ).all(canonical) as { id: number; author_id: string; author_name: string | null; text: string; created_at: string }[])
    .map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, text: n.text, createdAt: n.created_at }));
  const matches = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.ended_at AS endedAt, m.winner, mp.team, mp.connected_at AS connectedAt
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? ORDER BY m.id DESC LIMIT 20`,
  ).all(canonical);
  const timeout = activeTimeout(db, canonical, now);

  return {
    steamid: canonical,
    header: {
      steamid: canonical,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      isAdmin: player.is_admin === 1,
      isMod: player.is_mod === 1,
      discordName: player.discord_name,
      sr: row?.sr ?? null,
      games: row?.games ?? 0,
      createdAt: player.created_at,
    },
    glance: playerFileSummary(db, canonical, viewer, { now, timeline })!,
    timeline,
    sections: {
      identity: identity(db, canonical),
      standing: {
        activeBan: ban ? redact(ban) : null,
        bans,
        penalties: penaltyHistory(db, canonical),
        timeout: timeout ? { until: timeout.until.toISOString(), offenses: timeout.offenses } : null,
      },
      matches,
      tickets: ticketsAbout(db, canonical, viewer.steamid),
      notes,
      evidence: evidence(db, canonical),
    },
    actions: fileActions(db, viewer, canonical),
    lastReview: lastReviewOf(db, canonical),
  };
}
```

- [ ] **Step 5: The ban list**

`src/admin/peopleBans.ts`:

```ts
import type { DB } from '../db.js';
import { banIsWithheld, WITHHELD_REASON } from './banRedaction.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { fmtBanLength } from './timeline/bans.js';
import { toIso } from './timeline/types.js';

export interface PeopleBanRow {
  id: number;
  steamid: string;
  name: string;
  reason: string;
  /** How long it was for, in the words the ban form offers. */
  length: string;
  createdAt: string;
  expiresAt: string | null;
  createdByName: string | null;
  liftedAt: string | null;
  liftedByName: string | null;
  active: boolean;
  /** The ticket it came from, null when there is none or when naming it
   *  would tell the reader a restricted ticket exists. */
  ticketId: number | null;
  withheld: boolean;
  /** Whether this viewer may open the banned player's file. A moderator sees
   *  a ban on a colleague and is simply not offered the link. */
  canOpen: boolean;
}

interface Row {
  id: number; player_id: string; name: string | null; reason: string; created_at: string;
  expires_at: string | null; created_by_name: string | null; lifted_at: string | null;
  lifted_by_name: string | null; ticket_id: number | null;
}

/**
 * The ban list, inside the panel.
 *
 * Lifted and expired bans stay listed, as on the public page it replaces: a
 * record that quietly deletes its mistakes is not a record, and "lifted by,
 * and when" is the part that shows the process works.
 */
export function peopleBans(
  db: DB, viewer: FileViewer,
  opts: { filter?: 'active' | 'expired' | 'all'; q?: string; now?: Date } = {},
): PeopleBanRow[] {
  const now = opts.now ?? new Date();
  const q = (opts.q ?? '').trim();
  const like = `%${q.toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT b.id, b.player_id, p.name, b.reason, b.created_at, b.expires_at,
            pc.name AS created_by_name, b.lifted_at, pl.name AS lifted_by_name, b.ticket_id
     FROM bans b
     LEFT JOIN players p  ON p.steamid  = b.player_id
     LEFT JOIN players pc ON pc.steamid = b.created_by
     LEFT JOIN players pl ON pl.steamid = b.lifted_by
     WHERE (? = '' OR b.player_id = ? OR LOWER(COALESCE(p.name, '')) LIKE ?)
     ORDER BY b.id DESC LIMIT 500`,
  ).all(q, q, like) as Row[];

  const filter = opts.filter ?? 'all';
  return rows.map((r) => {
    const active = r.lifted_at === null
      && (r.expires_at === null || Date.parse(toIso(r.expires_at)) > now.getTime());
    const withheld = banIsWithheld(db, r.ticket_id, viewer.steamid);
    return {
      id: r.id,
      steamid: r.player_id,
      name: r.name ?? r.player_id,
      reason: withheld ? WITHHELD_REASON : r.reason,
      length: fmtBanLength(r.created_at, r.expires_at),
      createdAt: toIso(r.created_at),
      expiresAt: r.expires_at === null ? null : toIso(r.expires_at),
      createdByName: withheld ? null : r.created_by_name,
      liftedAt: r.lifted_at === null ? null : toIso(r.lifted_at),
      liftedByName: withheld ? null : r.lifted_by_name,
      active,
      // Naming the ticket would say a restricted case exists, which is the
      // one thing its access list is for.
      ticketId: withheld ? null : r.ticket_id,
      withheld,
      canOpen: canOpenFile(db, viewer, r.player_id),
    };
  }).filter((b) => (filter === 'all' ? true : filter === 'active' ? b.active : !b.active));
}
```

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run tests/playerFile.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin/playerFile.ts src/admin/playerFileSummary.ts src/admin/peopleBans.ts tests/playerFile.test.ts
git commit -m "Build the Player File, its shared summary and the panel ban list"
```

---

### Task 8: The People routes

**Files:**
- Create: `src/routes/people.ts`
- Modify: `src/server.ts` (register `peopleRoutes` immediately after the `adminRoutes` registration, around line 1094)
- Test: `tests/peopleRoutes.test.ts`

**Interfaces:**
- Consumes: `makeRequireMod(db)` from `src/routes/guards.ts`; `logAdmin(db, adminId, action, target, detail?, opts?)` from `src/admin/audit.ts`; `searchPlayers`, `addNote` from `src/admin/players.ts`; `captureHealth(db)` from `src/integrityFlags.ts`; Tasks 4 to 7.
- Produces:
  - `interface PeopleRouteOpts { db: DB }`
  - `peopleRoutes(app: FastifyInstance, opts: PeopleRouteOpts): Promise<void>`
  - `GET /api/admin/people?q=` returns `{ players: AdminPlayerRow[] }`, only files the viewer could open.
  - `GET /api/admin/people/review` returns `{ players: NeedsALookRow[]; health: CaptureHealth }`.
  - `GET /api/admin/people/bans?filter=&q=` returns `{ bans: PeopleBanRow[] }`.
  - `GET /api/admin/people/:steamid` returns a `PlayerFile`, or 404 `{ error: 'no such player' }`.
  - `POST /api/admin/people/:steamid/notes` with `{ text }`, `POST /api/admin/people/:steamid/looked-at` with `{ note }`.

- [ ] **Step 1: Write the failing test**

`tests/peopleRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [PLAYER, OTHER, MOD, MOD2, ADMIN, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});
afterEach(async () => { await app.close(); });

const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const post = (as: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, cookies: cookie[as], payload });

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

describe('the People routes', () => {
  it('are staff only, and a plain player gets nothing', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/people' })).statusCode).toBe(401);
    expect((await get(PLAYER, '/api/admin/people')).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/admin/people/${OTHER}`)).statusCode).toBe(403);
  });

  it('lists only the files the viewer could open', async () => {
    const asAdmin = (await get(ADMIN, '/api/admin/people')).json();
    expect(asAdmin.players.map((p: { steamid: string }) => p.steamid)).toContain(MOD);
    const asMod = (await get(MOD, '/api/admin/people')).json();
    const ids = asMod.players.map((p: { steamid: string }) => p.steamid);
    expect(ids).toContain(PLAYER);
    expect(ids).not.toContain(MOD);
    expect(ids).not.toContain(MOD2);
    expect(ids).not.toContain(ADMIN);
    expect((await get(MOD, `/api/admin/people?q=${PLAYER}`)).json().players).toHaveLength(1);
  });

  it('serves a file, and answers 404 rather than 403 for one the viewer may not open', async () => {
    const file = (await get(MOD, `/api/admin/people/${PLAYER}`)).json();
    expect(file.header.steamid).toBe(PLAYER);
    expect(file.actions).toEqual(['note', 'looked_at', 'open_ticket']);
    expect(file.sections.identity).toBeTruthy();

    for (const target of [MOD, MOD2, ADMIN]) {
      const res = await get(MOD, `/api/admin/people/${target}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'no such player' });
    }
    expect((await get(ADMIN, `/api/admin/people/${MOD}`)).statusCode).toBe(200);
    expect((await get(ADMIN, '/api/admin/people/76561199000000999')).statusCode).toBe(404);
  });

  it('a moderator writes a note and marks a file looked at, both audited', async () => {
    flag(PLAYER, new Date().toISOString());
    expect((await get(MOD, '/api/admin/people/review')).json().players.map((p: { steamid: string }) => p.steamid))
      .toEqual([PLAYER]);

    expect((await post(MOD, `/api/admin/people/${PLAYER}/notes`, { text: '' })).statusCode).toBe(400);
    expect((await post(MOD, `/api/admin/people/${PLAYER}/notes`, { text: 'had a word' })).statusCode).toBe(200);
    expect((await post(MOD, `/api/admin/people/${PLAYER}/looked-at`, { note: 'nothing there' })).statusCode).toBe(200);

    expect((await get(MOD, '/api/admin/people/review')).json().players).toEqual([]);
    const file = (await get(MOD, `/api/admin/people/${PLAYER}`)).json();
    expect(file.lastReview.note).toBe('nothing there');
    expect(file.sections.notes[0].text).toBe('had a word');

    const audit = (await get(OWNER, '/api/admin/audit')).json();
    expect(audit.actions.map((a: { action: string }) => a.action)).toEqual(['looked_at', 'note']);
    expect(audit.actions[0]).toMatchObject({ adminId: MOD, target: PLAYER });
  });

  it('refuses a note or a review on a file the viewer may not open, as a 404', async () => {
    expect((await post(MOD, `/api/admin/people/${ADMIN}/notes`, { text: 'x' })).statusCode).toBe(404);
    expect((await post(MOD, `/api/admin/people/${MOD}/looked-at`, {})).statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) AS n FROM player_notes').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM player_reviews').get() as { n: number }).n).toBe(0);
  });

  it('serves the review list with capture health, and the ban list with its filters', async () => {
    const review = (await get(ADMIN, '/api/admin/people/review')).json();
    expect(review.health).toMatchObject({ bursts: 0, detections: 0, lilacFlags: 0 });

    await post(ADMIN, `/api/admin/players/${PLAYER}/ban`, { reason: 'throwing', minutes: 1440 });
    const bans = (await get(MOD, '/api/admin/people/bans?filter=active')).json().bans;
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({ steamid: PLAYER, reason: 'throwing', length: '1 day', canOpen: true });
    expect((await get(MOD, '/api/admin/people/bans?filter=expired')).json().bans).toEqual([]);
    expect((await get(MOD, '/api/admin/people/bans?q=nobody')).json().bans).toEqual([]);
  });
});

describe('the admin-only routes the file calls', () => {
  it('still refuse a moderator, every one of them, and still answer an admin', async () => {
    const refusedGets = [
      '/api/admin/players',
      `/api/admin/players/${PLAYER}`,
      '/api/admin/integrity',
      `/api/admin/integrity/${PLAYER}`,
      '/api/bans',
    ];
    for (const url of refusedGets) {
      expect((await get(MOD, url)).statusCode, url).toBe(403);
      expect((await get(ADMIN, url)).statusCode, url).toBe(200);
    }
    const refusedPosts: [string, object][] = [
      [`/api/admin/players/${PLAYER}/ban`, { reason: 'x', minutes: 60 }],
      [`/api/admin/players/${PLAYER}/unban`, {}],
      [`/api/admin/players/${PLAYER}/activate`, {}],
      [`/api/admin/players/${PLAYER}/admin`, { isAdmin: true }],
      [`/api/admin/players/${PLAYER}/mod`, { isMod: true }],
      [`/api/admin/players/${PLAYER}/sign-out`, {}],
      [`/api/admin/players/${PLAYER}/unlink-discord`, {}],
      [`/api/admin/players/${PLAYER}/merge`, { into: OTHER, dryRun: true }],
      [`/api/admin/players/${PLAYER}/unalias`, {}],
      [`/api/admin/players/${PLAYER}/clear-penalties`, {}],
      [`/api/admin/players/${PLAYER}/steam-refresh`, {}],
      [`/api/admin/players/${PLAYER}/notes`, { text: 'x' }],
    ];
    for (const [url, payload] of refusedPosts) {
      expect((await post(MOD, url, payload)).statusCode, url).toBe(403);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM bans').get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/peopleRoutes.test.ts`
Expected: FAIL, `/api/admin/people` answers 404 because the routes do not exist.

- [ ] **Step 3: Write the routes**

`src/routes/people.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { addNote, searchPlayers } from '../admin/players.js';
import { captureHealth } from '../integrityFlags.js';
import { canDo, canOpenFile, fileViewer, type FileAction } from '../admin/fileAccess.js';
import { needsALook } from '../admin/needsALook.js';
import { peopleBans } from '../admin/peopleBans.js';
import { playerFile } from '../admin/playerFile.js';
import { markLookedAt } from '../admin/reviews.js';
import { getPlayer } from '../players.js';

export interface PeopleRouteOpts {
  db: DB;
}

/**
 * The People desk: search, the Player File, Needs a look and the ban list.
 *
 * Every route is behind makeRequireMod, and every one then asks fileAccess
 * whether this particular file is open to this particular viewer. A refusal
 * is a 404 with the same body as a genuinely missing player: telling a
 * moderator that a file exists but is not theirs to read is telling them who
 * is staff and who has a case open.
 *
 * The admin-only mutations are NOT here. Ban, timeout, merge, sign out and
 * the staff flags stay on /api/admin/players behind requireAdmin, and the
 * Player File page calls them there, so this file cannot become a second,
 * looser door onto them.
 */
export async function peopleRoutes(app: FastifyInstance, opts: PeopleRouteOpts): Promise<void> {
  const { db } = opts;
  const requireMod = makeRequireMod(db);

  /** Staff, then a target whose file this viewer may act on with `action`. */
  const onFile = (req: FastifyRequest, reply: FastifyReply, action: FileAction) => {
    const me = requireMod(req, reply);
    if (!me) return null;
    const viewer = fileViewer(db, me);
    const { steamid } = req.params as { steamid: string };
    if (!getPlayer(db, steamid) || !canDo(db, viewer, steamid, action)) {
      reply.code(404).send({ error: 'no such player' });
      return null;
    }
    return { me, viewer, steamid };
  };

  app.get('/api/admin/people', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const viewer = fileViewer(db, me);
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    return { players: searchPlayers(db, q).filter((p) => canOpenFile(db, viewer, p.steamid)) };
  });

  app.get('/api/admin/people/review', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    // Capture health rides along for the same reason it rides along with the
    // board today: an empty list cannot otherwise tell "nobody flagged"
    // apart from "the pipeline is silently broken".
    return { players: needsALook(db, fileViewer(db, me)), health: captureHealth(db) };
  });

  app.get('/api/admin/people/bans', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { filter, q } = req.query as { filter?: string; q?: string };
    const chosen = filter === 'active' || filter === 'expired' ? filter : 'all';
    return { bans: peopleBans(db, fileViewer(db, me), { filter: chosen, q: String(q ?? '').slice(0, 64) }) };
  });

  app.get('/api/admin/people/:steamid', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { steamid } = req.params as { steamid: string };
    const file = playerFile(db, steamid, fileViewer(db, me));
    if (!file) return reply.code(404).send({ error: 'no such player' });
    return file;
  });

  app.post('/api/admin/people/:steamid/notes', async (req, reply) => {
    const t = onFile(req, reply, 'note');
    if (!t) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      return reply.code(400).send({ error: 'a note needs text (up to 2000 characters)' });
    }
    addNote(db, t.steamid, t.me, text.trim());
    logAdmin(db, t.me, 'note', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/people/:steamid/looked-at', async (req, reply) => {
    const t = onFile(req, reply, 'looked_at');
    if (!t) return reply;
    const { note } = (req.body ?? {}) as { note?: unknown };
    if (note !== undefined && typeof note !== 'string') {
      return reply.code(400).send({ error: 'a note must be text' });
    }
    const review = markLookedAt(db, t.steamid, t.me, (note ?? '').toString().trim());
    logAdmin(db, t.me, 'looked_at', t.steamid, { note: review.note });
    return { ok: true, review };
  });
}
```

- [ ] **Step 4: Register it**

In `src/server.ts`, add the import beside the other route imports:

```ts
import { peopleRoutes } from './routes/people.js';
```

and register it immediately after the `adminRoutes` registration:

```ts
  await app.register(peopleRoutes, { db: deps.db });
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run tests/peopleRoutes.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/people.ts src/server.ts tests/peopleRoutes.test.ts
git commit -m "Serve the People desk behind the staff guard"
```

---

### Task 9: One summary on the ticket page, and feed posts that link to the file

**Files:**
- Modify: `src/routes/tickets.ts:325-331` (the ticket detail), `src/discord/adminFeedPoster.ts:61-204` (link building), `tests/discordAdminFeed.test.ts:46,74,119,125` (the link assertions)
- Test: `tests/ticketSummary.test.ts`

**Interfaces:**
- Consumes: `playerFileSummary(db, steamid, viewer, opts?)` and `fileViewer(db, steamid)`.
- Produces:
  - `GET /api/mod/tickets/:id` gains `summary: PlayerFileSummary | null` beside the existing `caseFile`, which stays until Task 15 removes it.
  - `AdminFeedPoster` links a named player to `${publicUrl}/admin/people/<steamid>` and a ticket to `${publicUrl}/admin/people/tickets/<id>`.

- [ ] **Step 1: Write the failing test**

`tests/ticketSummary.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { logAdmin } from '../src/admin/audit.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 5 }, (_, i) => `7656119900000000${i}`);
const [ACCUSED, REPORTER, MOD, MOD2, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});
afterEach(async () => { await app.close(); });

describe('the ticket page and the Player File share one summary', () => {
  it('serves the summary beside the ticket, with a link to the full file', async () => {
    await app.inject({ method: 'POST', url: '/api/reports', cookies: cookie[REPORTER], payload: { targetId: ACCUSED, category: 'cheating', text: 'walls' } });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    const detail = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[MOD] })).json();
    expect(detail.summary).toMatchObject({ steamid: ACCUSED, openTickets: 1, fileUrl: `/admin/people/${ACCUSED}` });
    expect(detail.summary.evidence).toEqual([]);
  });

  it('gives no file link to a viewer who may not open the file', async () => {
    // A ticket about a member of staff is restricted by the tickets rules.
    // A second moderator let onto the access list may work that ticket and
    // still may not open the colleague's whole file, which is the one case
    // where the summary renders without a way through to it.
    await app.inject({ method: 'POST', url: '/api/mod/tickets', cookies: cookie[OWNER], payload: { targetId: MOD } });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    await app.inject({ method: 'POST', url: `/api/mod/tickets/${id}/access`, cookies: cookie[OWNER], payload: { steamid: MOD2 } });
    const detail = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[MOD2] })).json();
    expect(detail.summary.steamid).toBe(MOD);
    expect(detail.summary.fileUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[OWNER] })).json().summary.fileUrl)
      .toBe(`/admin/people/${MOD}`);
  });
});

describe('the admin feed', () => {
  let t: FakeTransport;
  let feed: AdminFeedPoster;

  beforeEach(() => {
    setSetting(db, 'discord_admin_channel_id', 'admins');
    t = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  const text = (i: number) => JSON.stringify(t.live()[i]?.payload);

  it('links a named player to their file and a ticket to the People desk', async () => {
    logAdmin(db, OWNER, 'ticket_close', 12, { outcome: 'warned' });
    publishAdminEvent({ kind: 'signon_drop', steamid: ACCUSED, name: 'in game', count: 2, total: 2 });
    publishAdminEvent({
      kind: 'steam_signal', steamid: ACCUSED, matchId: null,
      signal: { what: 'recent_ban', vacBans: 1, gameBans: 0, daysSinceLastBan: 3 },
    });
    await feed.idle();
    expect(text(0)).toContain('https://pug.test/admin/people/tickets/12');
    expect(text(1)).toContain(`https://pug.test/admin/people/${ACCUSED}`);
    expect(text(2)).toContain(`https://pug.test/admin/people/${ACCUSED}`);
    expect(text(0) + text(1) + text(2)).not.toContain('/admin?ticket=');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketSummary.test.ts`
Expected: FAIL, `detail.summary` is undefined.

- [ ] **Step 3: The ticket detail carries the summary**

In `src/routes/tickets.ts`, add the imports:

```ts
import { fileViewer } from '../admin/fileAccess.js';
import { playerFileSummary } from '../admin/playerFileSummary.js';
```

and change the detail route so the same builder feeds both places:

```ts
  app.get('/api/mod/tickets/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = ticketDetail(db, Number((req.params as { id: string }).id), me);
    if (!d) return reply.code(404).send({ error: 'no such ticket' });
    // One builder for the accused's record, shared with the Player File, so
    // a new evidence source appears in both places the day it lands.
    // caseFile stays alongside until the web side has moved over.
    return {
      ...d,
      caseFile: caseFile(db, d.ticket.targetId, me),
      summary: playerFileSummary(db, d.ticket.targetId, fileViewer(db, me)),
    };
  });
```

- [ ] **Step 4: The feed links to the file**

In `src/discord/adminFeedPoster.ts`, add one helper beside `name`:

```ts
  /** Where a named player's record lives. Every post that names somebody
   *  links here, so reading the feed and opening the file is one click
   *  rather than a search through the panel. */
  private file(steamid: string): string {
    return `${this.deps.publicUrl}/admin/people/${steamid}`;
  }

  private ticket(id: string | number): string {
    return `${this.deps.publicUrl}/admin/people/tickets/${id}`;
  }
```

Then replace the four link sites:

- in `case 'report'`: `const link = \`[#${e.ticketId}](${this.ticket(e.ticketId)})\`;`
- in `case 'steam_signal'`, the `recent_ban` branch: `...this is context for their [file](${this.file(e.steamid)}), not a finding about this one.`
- in `case 'signon_drop'`: `const id = known ? \`[${e.steamid}](${this.file(e.steamid)})\` : \`\\\`${e.steamid}\\\`\`;`
- in `actionText`, the ticket block: `const ticket = \`ticket [#${e.target}](${this.ticket(e.target)})\`;`
- in `handleButton`: `content: \`Reports are tickets now. Open ${this.deps.publicUrl}/admin/people/tickets.\``

- [ ] **Step 5: Follow the existing feed assertions**

In `tests/discordAdminFeed.test.ts`, update the four link expectations to the new URLs:

```ts
    expect(text(0)).toContain(`https://pug.test/admin/people/tickets/${a.ticketId}`);
```

```ts
    expect(text(0)).toContain('closed ticket [#12](https://pug.test/admin/people/tickets/12)');
```

```ts
    expect(line).not.toContain('/admin/people/');
```

```ts
    expect(t.live()[0].payload.embeds[0].description).toContain(`[${IDS[4]}](https://pug.test/admin/people/${IDS[4]})`);
```

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run tests/ticketSummary.test.ts tests/discordAdminFeed.test.ts tests/ticketRoutes.test.ts`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/tickets.ts src/discord/adminFeedPoster.ts tests/ticketSummary.test.ts tests/discordAdminFeed.test.ts
git commit -m "Share one player summary with the ticket page and point the feed at the file"
```

---

### Task 10: The panel's URL tables, and People search

**Files:**
- Create: `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/admin/PeopleSearch.tsx`
- Modify: `web/src/api.ts` (a People section after the tickets one, near line 1002)
- Test: `web/src/routes/admin/adminRoutes.test.ts`, `web/src/routes/people.test.tsx`

**Interfaces:**
- Consumes: `get`, `post`, `AdminPlayerRow`, `AdminBan`, `AdminPlayerDetail`, `SteamAccount`, `TicketSummary`, `CaptureHealth`, `IntegrityRound`, `IntegrityClip`, `IntegrityFlag` in `web/src/api.ts`; `useFetch`, `Panel`, `Empty`.
- Produces:
  - `type Desk = 'live' | 'people' | 'setup'`, `interface AdminRoute { desk: Desk; section: string; param: string | null }`
  - `DESKS`, `PEOPLE_TABS`, `SETUP_TABS`: `{ key: string; label: string; path: string }[]`
  - `landingFor(isAdmin: boolean): string`, `fileUrl(steamid: string): string`, `ticketUrl(id: number): string`
  - `parseAdminPath(path: string, opts: { isAdmin: boolean }): AdminRoute`
  - `legacyRedirect(path: string, search: string, isAdmin: boolean): string | null`
  - web types `TimelineItem`, `TimelineSource`, `FileAction`, `AnalyzerRank`, `FileReview`, `FileSummaryData`, `PlayerFileData`, `NeedsALookRow`, `PeopleBan`, and `peopleApi`
  - `PeopleSearch()`

- [ ] **Step 1: Write the failing tests**

`web/src/routes/admin/adminRoutes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileUrl, landingFor, legacyRedirect, parseAdminPath, ticketUrl } from './adminRoutes';

const asAdmin = { isAdmin: true };
const asMod = { isAdmin: false };

describe('the panel URL parser', () => {
  it('reads every People screen', () => {
    expect(parseAdminPath('/admin/people', asAdmin)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/people/review', asAdmin)).toEqual({ desk: 'people', section: 'review', param: null });
    expect(parseAdminPath('/admin/people/bans', asAdmin)).toEqual({ desk: 'people', section: 'bans', param: null });
    expect(parseAdminPath('/admin/people/tickets', asAdmin)).toEqual({ desk: 'people', section: 'tickets', param: null });
    expect(parseAdminPath('/admin/people/tickets/12', asAdmin)).toEqual({ desk: 'people', section: 'ticket', param: '12' });
    expect(parseAdminPath('/admin/people/76561199000000001', asAdmin))
      .toEqual({ desk: 'people', section: 'file', param: '76561199000000001' });
    expect(parseAdminPath('/admin/people/nonsense', asAdmin)).toEqual({ desk: 'people', section: 'unknown', param: null });
  });

  it('leaves room for the other two desks', () => {
    expect(parseAdminPath('/admin/live', asAdmin)).toEqual({ desk: 'live', section: 'board', param: null });
    expect(parseAdminPath('/admin/setup', asAdmin)).toEqual({ desk: 'setup', section: 'settings', param: null });
    expect(parseAdminPath('/admin/setup/audit', asAdmin)).toEqual({ desk: 'setup', section: 'audit', param: null });
    expect(parseAdminPath('/admin/setup/campaigns', asAdmin)).toEqual({ desk: 'setup', section: 'campaigns', param: null });
  });

  it('gives a moderator the People desk whatever the URL says', () => {
    expect(parseAdminPath('/admin/live', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/setup/settings', asMod)).toEqual({ desk: 'people', section: 'search', param: null });
    expect(parseAdminPath('/admin/people/review', asMod)).toEqual({ desk: 'people', section: 'review', param: null });
  });

  it('sends the old links and the bare /admin somewhere real', () => {
    expect(legacyRedirect('/admin', '?ticket=12', true)).toBe('/admin/people/tickets/12');
    expect(legacyRedirect('/admin', '', true)).toBe('/admin/live');
    expect(legacyRedirect('/admin', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/live', '', false)).toBe('/admin/people');
    expect(legacyRedirect('/admin/people/review', '', false)).toBeNull();
    expect(legacyRedirect('/admin/live', '', true)).toBeNull();
  });

  it('builds the links everything else points at', () => {
    expect(landingFor(true)).toBe('/admin/live');
    expect(landingFor(false)).toBe('/admin/people');
    expect(fileUrl('76561199000000001')).toBe('/admin/people/76561199000000001');
    expect(ticketUrl(12)).toBe('/admin/people/tickets/12');
  });
});
```

`web/src/routes/people.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminPlayerRow } from '../api';

const { mockPeople } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, peopleApi: mockPeople };
});

const { PeopleSearch } = await import('./admin/PeopleSearch');

const row: AdminPlayerRow = {
  steamid: '76561199000000001', name: 'griefer', avatar: null, status: 'active', isAdmin: false,
  isMod: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 2,
};

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(mockPeople)) fn.mockReset();
  mockPeople.people.mockResolvedValue({ players: [row] });
});

describe('People search', () => {
  it('lists players and links each one to their file', async () => {
    render(<PeopleSearch />);
    const link = await screen.findByRole('link', { name: 'griefer' });
    expect(link.getAttribute('href')).toBe('/admin/people/76561199000000001');
    expect(screen.getByText('2')).toBeTruthy();
    expect(mockPeople.people).toHaveBeenCalledWith('', expect.anything());
  });

  it('searches on submit', async () => {
    render(<PeopleSearch />);
    await screen.findByRole('link', { name: 'griefer' });
    fireEvent.input(screen.getByLabelText('Search players'), { target: { value: ' walls ' } });
    fireEvent.submit(screen.getByLabelText('Search players').closest('form')!);
    await waitFor(() => expect(mockPeople.people).toHaveBeenCalledWith('walls', expect.anything()));
  });

  it('says so when nobody matches', async () => {
    mockPeople.people.mockResolvedValue({ players: [] });
    render(<PeopleSearch />);
    expect(await screen.findByText('No players match.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/routes/admin/adminRoutes.test.ts web/src/routes/people.test.tsx`
Expected: FAIL, cannot resolve `./adminRoutes` and `./admin/PeopleSearch`.

- [ ] **Step 3: The URL tables**

`web/src/routes/admin/adminRoutes.ts`:

```ts
/**
 * Where the panel is, as a URL rather than as component state.
 *
 * The tabs used to live in useState, so an admin could not link anybody to
 * what they were looking at and the back button left the panel. Everything
 * here is a pure function of the path, which is what makes it testable
 * without rendering anything and what keeps the shell free of parsing.
 *
 * Live and Setup are named here and built by their own plans. Their entries
 * exist so the shell has three desks from the start and so nothing has to be
 * renamed when they arrive.
 */
export type Desk = 'live' | 'people' | 'setup';

export interface AdminRoute {
  desk: Desk;
  section: string;
  /** A SteamID on a file, the id on a ticket, otherwise null. */
  param: string | null;
}

export const DESKS: { key: Desk; label: string; path: string }[] = [
  { key: 'live', label: 'Live', path: '/admin/live' },
  { key: 'people', label: 'People', path: '/admin/people' },
  { key: 'setup', label: 'Setup', path: '/admin/setup' },
];

export const PEOPLE_TABS: { key: string; label: string; path: string }[] = [
  { key: 'search', label: 'Players', path: '/admin/people' },
  { key: 'review', label: 'Needs a look', path: '/admin/people/review' },
  { key: 'bans', label: 'Bans', path: '/admin/people/bans' },
  { key: 'tickets', label: 'Tickets', path: '/admin/people/tickets' },
];

/** Setup holds what the old flat tabs held, until the Setup plan regroups it
 *  and adds Servers and Staff. */
export const SETUP_TABS: { key: string; label: string; path: string }[] = [
  { key: 'campaigns', label: 'Campaigns', path: '/admin/setup/campaigns' },
  { key: 'seasons', label: 'Seasons', path: '/admin/setup/seasons' },
  { key: 'settings', label: 'Settings', path: '/admin/setup/settings' },
  { key: 'audit', label: 'Audit', path: '/admin/setup/audit' },
];

export const landingFor = (isAdmin: boolean): string => (isAdmin ? '/admin/live' : '/admin/people');
export const fileUrl = (steamid: string): string => `/admin/people/${encodeURIComponent(steamid)}`;
export const ticketUrl = (id: number | string): string => `/admin/people/tickets/${id}`;

const STEAMID = /^\d{17}$/;

export function parseAdminPath(path: string, opts: { isAdmin: boolean }): AdminRoute {
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const desk = parts[1] ?? '';
  const a = parts[2] ?? '';
  const b = parts[3] ?? '';

  const people = (): AdminRoute => {
    if (a === '') return { desk: 'people', section: 'search', param: null };
    if (a === 'review') return { desk: 'people', section: 'review', param: null };
    if (a === 'bans') return { desk: 'people', section: 'bans', param: null };
    if (a === 'tickets') {
      return b === ''
        ? { desk: 'people', section: 'tickets', param: null }
        : { desk: 'people', section: 'ticket', param: b };
    }
    if (STEAMID.test(a)) return { desk: 'people', section: 'file', param: a };
    return { desk: 'people', section: 'unknown', param: null };
  };

  // A moderator has one desk. Anything else lands on it rather than on a
  // screen every call inside would be refused on anyway.
  if (!opts.isAdmin) return desk === 'people' ? people() : { desk: 'people', section: 'search', param: null };
  if (desk === 'people') return people();
  if (desk === 'setup') return { desk: 'setup', section: a === '' ? 'settings' : a, param: null };
  return { desk: 'live', section: 'board', param: null };
}

/**
 * Where a URL should be sent instead of rendered.
 *
 * `/admin?ticket=12` is what every admin feed post from before this change
 * links to, and those messages are permanent, so the redirect is too.
 */
export function legacyRedirect(path: string, search: string, isAdmin: boolean): string | null {
  const bare = path === '/admin' || path === '/admin/';
  if (bare) {
    const ticket = new URLSearchParams(search).get('ticket');
    if (ticket !== null && /^\d+$/.test(ticket)) return ticketUrl(ticket);
    return landingFor(isAdmin);
  }
  if (!isAdmin && !path.startsWith('/admin/people')) return '/admin/people';
  return null;
}
```

- [ ] **Step 4: The web types and the People client**

In `web/src/api.ts`, after the tickets block and before `export const modApi`, add:

```ts
// ---------- people ----------

export type TimelineSource =
  | 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
  | 'note' | 'steam' | 'discord_link';

/** One row of a player's merged history. The summary is written on the
 *  server so every surface says the same sentence about the same evidence. */
export interface TimelineItem {
  at: string;
  source: TimelineSource;
  kind: string;
  summary: string;
  matchId: number | null;
  replay: { ordinal: number; half: number; tMs: number } | null;
  ref: { type: string; id: number | string } | null;
}

export type FileAction =
  | 'note' | 'looked_at' | 'open_ticket'
  | 'ban' | 'timeout' | 'merge' | 'sign_out' | 'waive' | 'staff_flags';

/** The analyzer board's columns for one player. A sort key, never a claim. */
export interface AnalyzerRank {
  steamid: string; ranked: boolean; rank: number | null; of: number;
  rounds: number; eligibleRounds: number; clips: number;
  trackShare: number | null; occZ: number | null; teamGap: number | null;
  pFid: number | null; pOcc: number | null; pGap: number | null; composite: number | null;
}

export interface FileReview {
  id: number; steamid: string; reviewedBy: string; reviewedByName: string | null;
  reviewedAt: string; note: string;
}

/** "Is there anything here": the file's own glance row, and the accused's
 *  section of a ticket page. fileUrl is null when the viewer may not open
 *  the whole file. */
export interface FileSummaryData {
  steamid: string; name: string; avatar: string | null; status: string;
  isAdmin: boolean; isMod: boolean; sr: number | null; games: number; createdAt: string | null;
  activeBan: AdminBan | null; bans: number; penalties: number;
  timeout: { until: string; offenses: number } | null;
  openTickets: number; aliases: number;
  sharesAddressWith: { steamid: string; name: string }[];
  steamFlags: { kind: string; text: string }[];
  evidence: { source: TimelineSource; count: number }[];
  analyzer: AnalyzerRank | null;
  lastReview: FileReview | null;
  fileUrl: string | null;
}

export interface PlayerFileData {
  steamid: string;
  header: {
    steamid: string; name: string; avatar: string | null; status: string;
    isAdmin: boolean; isMod: boolean; discordName: string | null;
    sr: number | null; games: number; createdAt: string;
  };
  glance: FileSummaryData;
  timeline: TimelineItem[];
  sections: {
    identity: {
      aliases: AdminPlayerDetail['aliases'];
      discordHistory: NonNullable<AdminPlayerDetail['discordHistory']>;
      steamAccount: SteamAccount | null;
      networks: AdminPlayerDetail['networks'];
      sharesAddressWith: AdminPlayerDetail['sharesAddressWith'];
    };
    standing: {
      activeBan: AdminBan | null;
      bans: AdminBan[];
      penalties: AdminPlayerDetail['penalties'];
      timeout: AdminPlayerDetail['timeout'];
    };
    matches: AdminPlayerDetail['matches'];
    tickets: TicketSummary[];
    notes: AdminPlayerDetail['notes'];
    evidence: {
      analyzer: AnalyzerRank | null;
      rounds: IntegrityRound[];
      clips: IntegrityClip[];
      flags: IntegrityFlag[];
      inputFlags: AdminPlayerDetail['inputFlags'];
      inputCaps: AdminPlayerDetail['inputCaps'];
      signonDrops: AdminPlayerDetail['signonDrops'];
    };
  };
  actions: FileAction[];
  lastReview: FileReview | null;
}

export interface NeedsALookRow {
  steamid: string; name: string; avatar: string | null; status: string;
  newestEvidenceAt: string; sources: TimelineSource[];
  lastReviewAt: string | null; lastReviewBy: string | null;
  openTickets: number; analyzer: AnalyzerRank | null;
}

export interface PeopleBan {
  id: number; steamid: string; name: string; reason: string; length: string;
  createdAt: string; expiresAt: string | null; createdByName: string | null;
  liftedAt: string | null; liftedByName: string | null; active: boolean;
  ticketId: number | null; withheld: boolean; canOpen: boolean;
}

/** The People desk. Moderators may call all of it; the admin-only actions a
 *  file offers stay on adminApi, which is where the server enforces them. */
export const peopleApi = {
  people: (q: string, signal?: AbortSignal) =>
    get<{ players: AdminPlayerRow[] }>(`/api/admin/people?q=${encodeURIComponent(q)}`, signal),
  file: (steamid: string, signal?: AbortSignal) =>
    get<PlayerFileData>(`/api/admin/people/${encodeURIComponent(steamid)}`, signal),
  review: (signal?: AbortSignal) =>
    get<{ players: NeedsALookRow[]; health: CaptureHealth }>('/api/admin/people/review', signal),
  bans: (filter: 'active' | 'expired' | 'all', q: string, signal?: AbortSignal) =>
    get<{ bans: PeopleBan[] }>(`/api/admin/people/bans?filter=${filter}&q=${encodeURIComponent(q)}`, signal),
  note: (steamid: string, text: string) =>
    post<{ ok: true }>(`/api/admin/people/${steamid}/notes`, { text }),
  lookedAt: (steamid: string, note: string) =>
    post<{ ok: true; review: FileReview }>(`/api/admin/people/${steamid}/looked-at`, { note }),
};
```

- [ ] **Step 5: The search screen**

`web/src/routes/admin/PeopleSearch.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fileUrl } from './adminRoutes';

/** Find a person and open their file. The list holds only files this viewer
 *  could open: the server decides that, and a moderator simply never sees a
 *  colleague's row rather than seeing one that refuses to open. */
export function PeopleSearch() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useFetch((s) => peopleApi.people(query, s), [query]);
  const players = data?.players ?? [];

  return (
    <Panel class="panel--table">
      <form class="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input
          value={q} placeholder="Name, SteamID or Discord" aria-label="Search players"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <button class="btn" type="submit">Search</button>
      </form>
      {error && <Empty>Could not load the player list.</Empty>}
      {data && players.length === 0 && <Empty>No players match.</Empty>}
      {players.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Player</th><th>Status</th><th class="num">SR</th>
                <th class="num">Games</th><th>Discord</th><th class="num">Offenses</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.steamid}>
                  <td>
                    <a href={fileUrl(p.steamid)}>{p.name}</a>
                    {p.isAdmin && <span class="admin-tag">admin</span>}
                    {p.isMod && <span class="admin-tag">mod</span>}
                    <div class="mono muted">{p.steamid}</div>
                  </td>
                  <td><span class={`admin-status admin-status--${p.status}`}>{p.status}</span></td>
                  <td class="num">{p.sr ?? <span class="muted">n/a</span>}</td>
                  <td class="num">{p.games}</td>
                  <td>{p.discordName ?? <span class="muted">not linked</span>}</td>
                  <td class={`num${p.offenses ? ' admin-warn' : ' muted'}`}>{p.offenses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run web/src/routes/admin/adminRoutes.test.ts web/src/routes/people.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/admin/PeopleSearch.tsx web/src/routes/people.test.tsx web/src/api.ts
git commit -m "Give the panel real URLs and a People search that opens files"
```

---

### Task 11: The Player File page

**Files:**
- Create: `web/src/routes/admin/file/PlayerFile.tsx`, `web/src/routes/admin/file/FileHeader.tsx`, `web/src/routes/admin/file/GlanceRow.tsx`, `web/src/routes/admin/file/IdentitySection.tsx`, `web/src/routes/admin/file/StandingSection.tsx`, `web/src/routes/admin/file/NotesSection.tsx`
- Test: `web/src/routes/playerFile.test.tsx`

**Interfaces:**
- Consumes: `peopleApi`, `adminApi`, `modApi`, `PlayerFileData`, `FileAction`, `MergePlan`, `TimelineSource` from `web/src/api.ts`; `useFetch`; `useAction`, `fmtTime`, `Run` from `web/src/routes/admin/useAction.ts`; `fileUrl`, `ticketUrl` from `adminRoutes.ts`; `campaignName` from `web/src/format.ts`; `Empty`, `Panel` from `web/src/components/bits.tsx`.
- Produces:
  - `PlayerFile({ steamid, me }: { steamid: string; me: string })`
  - `FileHeader({ d, me, busy, run, can })`
  - `GlanceRow({ d })`, and the shared `SOURCE_LABEL: Record<TimelineSource, string>` and `SourceBadge({ source })`
  - `IdentitySection({ d, busy, run, can })`, `StandingSection({ d, busy, run, can })`, `NotesSection({ d, busy, run, can })`

- [ ] **Step 1: Write the failing test**

`web/src/routes/playerFile.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { PlayerFileData } from '../api';
import { ConfirmHost } from '../components/Confirm';

const { mockPeople, mockAdmin, mockMod } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
  mockAdmin: {
    ban: vi.fn(), unban: vi.fn(), activate: vi.fn(), setAdmin: vi.fn(), setMod: vi.fn(),
    signOutPlayer: vi.fn(), clearPenalties: vi.fn(), unlinkDiscord: vi.fn(),
    mergePlayer: vi.fn(), unaliasPlayer: vi.fn(), steamRefresh: vi.fn(), integrityReview: vi.fn(),
  },
  mockMod: { open: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    peopleApi: mockPeople,
    adminApi: { ...actual.adminApi, ...mockAdmin },
    modApi: { ...actual.modApi, ...mockMod },
  };
});

const { PlayerFile } = await import('./admin/file/PlayerFile');

const P = '76561199000000001';
const ADMIN_ACTIONS = ['note', 'looked_at', 'open_ticket', 'ban', 'timeout', 'merge', 'sign_out', 'waive', 'staff_flags'] as const;

const file = (over: Partial<PlayerFileData> = {}): PlayerFileData => ({
  steamid: P,
  header: {
    steamid: P, name: 'griefer', avatar: null, status: 'active', isAdmin: false, isMod: false,
    discordName: 'grief#1', sr: 900, games: 12, createdAt: '2026-08-01T00:00:00.000Z',
  },
  glance: {
    steamid: P, name: 'griefer', avatar: null, status: 'active', isAdmin: false, isMod: false,
    sr: 900, games: 12, createdAt: '2026-08-01T00:00:00.000Z',
    activeBan: null, bans: 1, penalties: 2, timeout: null, openTickets: 1, aliases: 1,
    sharesAddressWith: [{ steamid: '76561199000000002', name: 'sibling' }],
    steamFlags: [{ kind: 'new_account', text: 'New account: created 3 days before their first match here.' }],
    evidence: [{ source: 'lilac', count: 2 }],
    analyzer: null, lastReview: null, fileUrl: `/admin/people/${P}`,
  },
  timeline: [],
  sections: {
    identity: {
      aliases: [{ steamid: '76561199000000002', canonical: P, created_at: '2026-09-01', created_by: 'boss' }],
      discordHistory: [],
      steamAccount: null,
      networks: [],
      sharesAddressWith: [{ steamid: '76561199000000002', name: 'sibling', country: 'US', seenCount: 4, lastSeen: '2026-09-20' }],
    },
    standing: {
      activeBan: null,
      bans: [{ id: 1, reason: 'throwing', createdBy: '9', createdByName: 'boss', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: null, liftedBy: null, liftedByName: null, liftedAt: '2026-09-02T00:00:00.000Z' }],
      penalties: [{ id: 1, kind: 'no_show', matchId: 7, createdAt: '2026-09-10T00:00:00.000Z', clearedBy: null, clearedAt: null }],
      timeout: null,
    },
    matches: [{ id: 7, campaign: 'dead_air', state: 'completed', endedAt: '2026-09-10T00:00:00.000Z', winner: 'a', team: 'b', connectedAt: null }],
    tickets: [{
      id: 12, targetId: P, targetName: 'griefer', status: 'open', outcome: null, restricted: false,
      claimedBy: null, claimedByName: null, reports: 2, reporters: 2, categories: ['cheating'],
      createdAt: '2026-09-20T00:00:00.000Z', lastReportAt: null, closedAt: null,
    }],
    notes: [{ id: 1, authorId: '9', authorName: 'boss', text: 'had a word', createdAt: '2026-09-11T00:00:00.000Z' }],
    evidence: {
      analyzer: null, rounds: [], clips: [], flags: [], inputFlags: [], inputCaps: [],
      signonDrops: { count: 0, lastAt: null, rows: [] },
    },
  },
  actions: [...ADMIN_ACTIONS],
  lastReview: null,
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  for (const fn of [...Object.values(mockPeople), ...Object.values(mockAdmin), ...Object.values(mockMod)]) fn.mockReset();
  mockPeople.file.mockResolvedValue(file());
  mockPeople.note.mockResolvedValue({ ok: true });
  mockPeople.lookedAt.mockResolvedValue({ ok: true, review: { id: 1, steamid: P, reviewedBy: '9', reviewedByName: 'boss', reviewedAt: '2026-09-21T00:00:00.000Z', note: '' } });
  for (const fn of Object.values(mockAdmin)) fn.mockResolvedValue({ ok: true });
  mockMod.open.mockResolvedValue({ ok: true, ticketId: 12 });
});

describe('the Player File', () => {
  it('says whose file it is, what is on it, and what is at a glance', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByRole('heading', { name: /griefer/ })).toBeTruthy();
    expect(screen.getByText(P)).toBeTruthy();
    expect(screen.getByText(/12 games/)).toBeTruthy();
    expect(screen.getByText(/1 open ticket/)).toBeTruthy();
    expect(screen.getByText(/2 Little Anti-Cheat/)).toBeTruthy();
    expect(screen.getByText(/New account/)).toBeTruthy();
    expect(screen.getByText('Nobody has marked this file looked at.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('/admin/people/tickets/12');
    expect(screen.getByRole('link', { name: '#7' }).getAttribute('href')).toBe('/match/7');
  });

  it('tells a viewer plainly when there is no such file', async () => {
    mockPeople.file.mockRejectedValue(new Error('404'));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText('No such player, or not a file you can open.')).toBeTruthy();
  });

  it('bans, unbans and clears penalties from the standing section', async () => {
    render(<><PlayerFile steamid={P} me="76561199000000009" /><ConfirmHost /></>);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByLabelText('Ban reason'), { target: { value: 'throwing' } });
    fireEvent.change(screen.getByLabelText('Ban length'), { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('throwing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockAdmin.ban).toHaveBeenCalledWith(P, 'throwing', 1440));
  });

  it('writes a note and marks the file looked at', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'spoke to them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(mockPeople.note).toHaveBeenCalledWith(P, 'spoke to them'));

    fireEvent.input(screen.getByLabelText('Review note'), { target: { value: 'nothing there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Looked at this' }));
    await waitFor(() => expect(mockPeople.lookedAt).toHaveBeenCalledWith(P, 'nothing there'));
  });

  it('opens a ticket about the player', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Open a ticket' }));
    await waitFor(() => expect(mockMod.open).toHaveBeenCalledWith(P, '', false));
  });

  it('gives a moderator every section and none of the admin controls', async () => {
    mockPeople.file.mockResolvedValue(file({ actions: ['note', 'looked_at', 'open_ticket'] }));
    render(<PlayerFile steamid={P} me="76561199000000008" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByLabelText('Note')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Looked at this' })).toBeTruthy();
    expect(screen.queryByLabelText('Ban reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    expect(screen.queryByPlaceholderText('SteamID64 to keep')).toBeNull();
    // The sections themselves are not hidden from a moderator: only actions.
    expect(screen.getByText(/Seen on the same connection as/)).toBeTruthy();
    expect(screen.getByText('throwing')).toBeTruthy();
  });

  it('previews a merge before offering to run one', async () => {
    mockAdmin.mergePlayer.mockResolvedValue({ plan: { from: P, into: '76561199000000002', matchesMoved: 3, matchesCollapsed: 1, rowsByTable: { bans: 1 }, seasons: [1] } });
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    fireEvent.input(screen.getByPlaceholderText('SteamID64 to keep'), { target: { value: '76561199000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(mockAdmin.mergePlayer).toHaveBeenCalledWith(P, '76561199000000002', true));
    expect(await screen.findByText(/3/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge and recompute' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/routes/playerFile.test.tsx`
Expected: FAIL, cannot resolve `./admin/file/PlayerFile`.

- [ ] **Step 3: The glance row and the shared badge**

`web/src/routes/admin/file/GlanceRow.tsx`:

```tsx
import type { PlayerFileData, TimelineSource } from '../../../api';
import { fmtTime } from '../useAction';

/** One word per source, in the panel's own vocabulary. The badge is the same
 *  neutral shape for every source on purpose: colouring "LilAC" differently
 *  from "note" would read as a severity, and none of these is a verdict. */
export const SOURCE_LABEL: Record<TimelineSource, string> = {
  input: 'Input timing',
  lilac: 'Little Anti-Cheat',
  analyzer: 'Replay analyzer',
  drop: 'Connect drop',
  ticket: 'Ticket',
  penalty: 'Penalty',
  ban: 'Ban',
  note: 'Note',
  steam: 'Steam',
  discord_link: 'Discord',
};

export function SourceBadge({ source }: { source: TimelineSource }) {
  return <span class="source-badge">{SOURCE_LABEL[source]}</span>;
}

/** Is there anything here. One row, read before anything else on the page. */
export function GlanceRow({ d }: { d: PlayerFileData }) {
  const g = d.glance;
  return (
    <section class="file-glance">
      <p>
        <strong>{g.openTickets}</strong> open ticket{g.openTickets === 1 ? '' : 's'}
        {' · '}<strong>{g.bans}</strong> ban{g.bans === 1 ? '' : 's'} on record
        {' · '}<strong>{g.penalties}</strong> penalt{g.penalties === 1 ? 'y' : 'ies'}
        {g.aliases > 0 && <> · <strong>{g.aliases}</strong> merged second account{g.aliases === 1 ? '' : 's'}</>}
        {g.sharesAddressWith.length > 0 && <> · shares a connection with {g.sharesAddressWith.map((s) => s.name).join(', ')}</>}
      </p>
      <p>
        {g.evidence.length === 0
          ? <span class="muted">Nothing recorded in the last 30 days.</span>
          : (
            <>
              Last 30 days:{' '}
              {g.evidence.map((e, i) => (
                <span key={e.source}>
                  {i > 0 ? ', ' : ''}{e.count} {SOURCE_LABEL[e.source]}{e.count === 1 ? '' : 's'}
                </span>
              ))}
              . Context to weigh, not a verdict.
            </>
          )}
      </p>
      {g.activeBan && (
        <p class="admin-warn">
          Banned: {g.activeBan.reason}
          {g.activeBan.expiresAt ? `, until ${fmtTime(g.activeBan.expiresAt)}` : ', permanently'}.
        </p>
      )}
      {g.timeout && <p class="admin-warn">Queue timeout until {fmtTime(g.timeout.until)}, {g.timeout.offenses} offenses this week.</p>}
      {g.steamFlags.map((f) => <p key={f.kind} class="muted">{f.text}</p>)}
      <p class="muted">
        {d.lastReview
          ? `Looked at by ${d.lastReview.reviewedByName ?? d.lastReview.reviewedBy} ${fmtTime(d.lastReview.reviewedAt)}${d.lastReview.note ? `: ${d.lastReview.note}` : ''}`
          : 'Nobody has marked this file looked at.'}
      </p>
    </section>
  );
}
```

- [ ] **Step 4: The header**

`web/src/routes/admin/file/FileHeader.tsx`:

```tsx
import { adminApi, modApi, type FileAction, type PlayerFileData } from '../../../api';
import { fmtTime, type Run } from '../useAction';
import { ticketUrl } from '../adminRoutes';

/**
 * Who this is, and the actions that are a single call.
 *
 * Ban and merge are not here: both need a form and both live in the section
 * that already explains them, so the header links down to them instead of
 * carrying a second copy of either.
 */
export function FileHeader(
  { d, me, busy, run, can }: {
    d: PlayerFileData;
    me: string;
    busy: boolean;
    run: Run;
    can: (action: FileAction) => boolean;
  },
) {
  const h = d.header;
  const self = h.steamid === me;
  return (
    <header class="file-head">
      {h.avatar && <img class="file-head__avatar" src={h.avatar} alt="" />}
      <div>
        <h2>
          {h.name}
          {h.isAdmin && <span class="admin-tag">admin</span>}
          {h.isMod && <span class="admin-tag">mod</span>}
          <span class={`admin-status admin-status--${h.status}`}>{h.status}</span>
        </h2>
        <p class="muted mono">{h.steamid}</p>
        <p class="muted">
          SR {h.sr ?? 'n/a'} · {h.games} games · joined {fmtTime(h.createdAt)} ·
          {' '}Discord: {h.discordName ?? 'not linked'} ·
          {' '}<a href={`/player/${h.steamid}`}>public profile</a>
        </p>
      </div>
      <div class="admin-actions">
        {can('open_ticket') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(async () => {
              const r = await modApi.open(h.steamid, '', false);
              if (r.ticketId !== null) location.href = ticketUrl(r.ticketId);
            })}>
            Open a ticket
          </button>
        )}
        {can('ban') && <a class="chip" href="#standing">Ban</a>}
        {can('merge') && <a class="chip" href="#identity">Merge</a>}
        {can('staff_flags') && h.status === 'invited' && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.activate(h.steamid))}>Activate</button>
        )}
        {can('staff_flags') && !self && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.setAdmin(h.steamid, !h.isAdmin), h.isAdmin ? {
              title: `Remove admin from ${h.name}?`,
              body: 'They lose the admin panel and their admin on every game server.',
              confirmLabel: 'Remove admin',
              danger: true,
            } : {
              title: `Make ${h.name} an admin?`,
              body: 'They get the admin panel here and the same admin rights on every game server.',
              confirmLabel: 'Make admin',
            })}>
            {h.isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        )}
        {can('staff_flags') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.setMod(h.steamid, !h.isMod), h.isMod ? undefined : {
              title: `Make ${h.name} a moderator?`,
              body: 'They can see and work tickets and open any player file but their own and other staff. They get no settings and nothing on the game servers.',
              confirmLabel: 'Make moderator',
            })}>
            {h.isMod ? 'Remove moderator' : 'Make moderator'}
          </button>
        )}
        {can('staff_flags') && h.discordName && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.unlinkDiscord(h.steamid), {
              title: `Unlink ${h.name}'s Discord?`,
              body: 'They will have to link it again before they can queue, if Discord is required to queue.',
              confirmLabel: 'Unlink',
              danger: true,
            })}>
            Unlink Discord
          </button>
        )}
        {can('sign_out') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.signOutPlayer(h.steamid), {
              title: `Sign ${h.name} out everywhere?`,
              body: 'Every browser they are signed in on stops working at once and has to sign in through Steam again. Use it when an account may be in somebody else\'s hands.',
              confirmLabel: 'Sign out',
            })}>
            Sign out everywhere
          </button>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Identity, standing and notes**

`web/src/routes/admin/file/IdentitySection.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type MergePlan, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { fileUrl } from '../adminRoutes';

/** Aliases, Discord history, the Steam account and shared connections, then
 *  the merge tool that all of it is evidence for. Moderators see every row
 *  here, network sightings included: the owner ruled on that the same day.
 *  Only the merge form is admin-only. */
export function IdentitySection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const id = d.sections.identity;
  const [into, setInto] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const countries = [...new Set(id.networks.map((n) => n.country).filter(Boolean))];

  const preview = async () => {
    setPlan(null);
    setPlanError('');
    try {
      const res = await adminApi.mergePlayer(d.steamid, into.trim(), true);
      setPlan(res.plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not read that account.');
    }
  };

  return (
    <Panel class="file-section">
      <h3 id="identity">Identity</h3>

      {id.discordHistory.length > 0 && (
        <ul class="admin-list">
          {id.discordHistory.map((h) => (
            <li key={`${h.discordId}-${h.linkedAt}`}>
              {h.discordName || 'unknown'} <code>{h.discordId}</code>{' '}
              <span class="muted">
                {h.linkedBy === 'backfill' ? 'linked before history was kept' : `linked ${fmtTime(h.linkedAt)}`}
                {h.unlinkedAt ? `, unlinked ${fmtTime(h.unlinkedAt)}${h.unlinkedBy === 'merge' ? ' by a merge' : ''}` : ', current'}
              </span>
              {h.others.map((o) => (
                <div key={`${o.steamid}-${o.linkedAt}`} class="muted">
                  This Discord was {o.unlinkedAt ? 'previously' : 'also'} linked to{' '}
                  <a href={fileUrl(o.steamid)}>{o.name ?? o.steamid}</a>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {countries.length > 0 && (
        <p class="muted">Connects from {countries.join(', ')} · {id.networks.length} connection{id.networks.length === 1 ? '' : 's'} seen</p>
      )}
      {id.sharesAddressWith.length > 0 && (
        <>
          <p><strong>Seen on the same connection as:</strong></p>
          <ul class="admin-list">
            {id.sharesAddressWith.map((o) => (
              <li key={o.steamid}>
                <a href={fileUrl(o.steamid)}>{o.name}</a> <code>{o.steamid}</code>{' '}
                <span class="muted">
                  {o.seenCount} {o.seenCount === 1 ? 'connect' : 'connects'}
                  {o.country ? `, ${o.country}` : ''}, last {fmtTime(o.lastSeen)}
                </span>
              </li>
            ))}
          </ul>
          <p class="muted">
            A shared connection is not proof. A VPN, a household, a LAN cafe and two siblings all
            look like this. Check it against how they play before merging.
          </p>
        </>
      )}

      {id.steamAccount ? (
        <>
          <p class="muted">
            Steam says: {id.steamAccount.ageDays === null ? 'account age unknown' : `${id.steamAccount.ageDays} days old`}
            {id.steamAccount.l4d1?.state === 'visible' ? `, ${id.steamAccount.l4d1.hours} h of L4D1` : ''}
            {id.steamAccount.level === null ? '' : `, level ${id.steamAccount.level}`}
            {' · '}checked {fmtTime(id.steamAccount.checkedAt)} ·{' '}
            <a href={`https://steamcommunity.com/profiles/${d.steamid}`} target="_blank" rel="noreferrer">Steam profile</a>
          </p>
          {id.steamAccount.flags.map((f) => <p key={f.kind} class="muted">{f.text}</p>)}
        </>
      ) : <p class="muted">Steam has not been asked about this account yet.</p>}
      {can('merge') && (
        <p class="muted">
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.steamRefresh(d.steamid))}>Check Steam now</button>
        </p>
      )}

      {id.aliases.length > 0 && (
        <ul class="admin-list">
          {id.aliases.map((a) => (
            <li key={a.steamid}>
              Merged in: <code>{a.steamid}</code> <span class="muted">since {fmtTime(a.created_at)}</span>{' '}
              {can('merge') && (
                <button class="chip" type="button" disabled={busy}
                  onClick={() => run(
                    () => adminApi.unaliasPlayer(a.steamid),
                    `Stop treating ${a.steamid} as ${d.header.name}? Their past matches stay merged; the account is just free to be its own identity again.`,
                  )}>Separate</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {can('merge') && (
        <>
          <p class="muted">
            Merge this account into another, for one person playing on two Steam accounts.
            <strong> {d.header.name} disappears</strong> and everything they did moves to the account you name.
          </p>
          <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
            <input value={into} placeholder="SteamID64 to keep" aria-label="Merge into"
              onInput={(e) => { setInto((e.target as HTMLInputElement).value); setPlan(null); }} />
            <button class="btn" type="submit" disabled={busy || !/^\d{17}$/.test(into.trim())}>Preview</button>
          </form>
          {planError && <p class="error">{planError}</p>}
          {plan && (
            <div class="admin-merge__plan">
              <p><strong>{plan.matchesMoved}</strong> matches move, <strong>{plan.matchesCollapsed}</strong> of them had both accounts rostered.</p>
              <p class="muted">
                Season {plan.seasons.join(', ')} will be recomputed, which changes the rating of
                everyone who played in those matches, not only these two accounts. There is no undo.
              </p>
              <button class="btn" type="button" disabled={busy}
                onClick={() => run(
                  () => adminApi.mergePlayer(d.steamid, into.trim()),
                  `Merge ${d.header.name} into ${into.trim()} and recompute season ${plan.seasons.join(', ')}? This cannot be undone.`,
                )}>Merge and recompute</button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
```

`web/src/routes/admin/file/StandingSection.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';

const LENGTHS: [value: string, label: string][] = [
  ['', 'Permanent'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '1 week'], ['43200', '30 days'],
];

/** Bans, penalties and the queue timeout, each with what can be done about
 *  it. A ban whose reason reads "Withheld" came from a restricted ticket the
 *  viewer is not on: the server decides that, not this page. */
export function StandingSection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const s = d.sections.standing;
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');

  return (
    <Panel class="file-section">
      <h3 id="standing">Standing</h3>
      {s.activeBan ? (
        <div class="admin-ban">
          <p>
            Banned {fmtTime(s.activeBan.createdAt)}
            {s.activeBan.createdByName ? ` by ${s.activeBan.createdByName}` : ''}: <strong>{s.activeBan.reason}</strong>
            {s.activeBan.expiresAt ? `, until ${fmtTime(s.activeBan.expiresAt)}` : ', permanently'}.
          </p>
          {can('ban') && (
            <button class="btn btn--ghost" type="button" disabled={busy}
              onClick={() => run(() => adminApi.unban(d.steamid), {
                title: `Unban ${d.header.name}?`,
                body: 'The ban is lifted here and on every game server.',
                confirmLabel: 'Unban',
              })}>Unban</button>
          )}
        </div>
      ) : can('ban') ? (
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => adminApi.ban(d.steamid, reason.trim(), minutes ? Number(minutes) : null), {
            title: `Ban ${d.header.name}?`,
            body: reason.trim()
              ? `They are banned here and kicked from every game server. They will be shown: "${reason.trim()}"`
              : 'They are banned here and kicked from every game server.',
            confirmLabel: 'Ban',
            danger: true,
          }).then(() => { setReason(''); setMinutes(''); });
        }}>
          <input value={reason} placeholder="Reason (shown to them)" aria-label="Ban reason"
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          <select value={minutes} aria-label="Ban length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
            {LENGTHS.map(([value, label]) => <option key={label} value={value}>{label}</option>)}
          </select>
          <button class="btn" type="submit" disabled={busy || !reason.trim()}>Ban</button>
        </form>
      ) : <p class="muted">Not banned.</p>}

      {s.bans.length > 0 && (
        <ul class="admin-list">
          {s.bans.map((b) => (
            <li key={b.id}>
              {fmtTime(b.createdAt)}: {b.reason} ({b.expiresAt ? `until ${fmtTime(b.expiresAt)}` : 'permanent'})
              {b.liftedAt && <span class="muted">, lifted {fmtTime(b.liftedAt)}{b.liftedByName ? ` by ${b.liftedByName}` : ''}</span>}
            </li>
          ))}
        </ul>
      )}

      <h4>
        Penalties
        {s.timeout && <span class="admin-warn"> on timeout until {fmtTime(s.timeout.until)}</span>}
      </h4>
      {s.penalties.length === 0 ? <p class="muted">None.</p> : (
        <ul class="admin-list">
          {s.penalties.map((p) => (
            <li key={p.id} class={p.clearedAt ? 'muted' : ''}>
              {fmtTime(p.createdAt)}: {p.kind === 'no_show' ? 'No-show' : 'Missed ready check'}
              {p.matchId && <> on <a href={`/match/${p.matchId}`}>#{p.matchId}</a></>}
              {p.clearedAt && `, cleared by ${p.clearedBy}`}
            </li>
          ))}
        </ul>
      )}
      {can('timeout') && s.penalties.some((p) => !p.clearedAt) && (
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => adminApi.clearPenalties(d.steamid))}>Clear penalties</button>
      )}
    </Panel>
  );
}
```

`web/src/routes/admin/file/NotesSection.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { peopleApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';

/** Notes, and the "looked at" that takes this file off Needs a look. Both
 *  are open to moderators: they are the two things a moderator does here. */
export function NotesSection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const [note, setNote] = useState('');
  const [review, setReview] = useState('');

  return (
    <Panel class="file-section">
      <h3 id="notes">Notes</h3>
      {can('note') && (
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => peopleApi.note(d.steamid, note.trim())).then(() => setNote(''));
        }}>
          <input value={note} placeholder="Private staff note" aria-label="Note"
            onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !note.trim()}>Add note</button>
        </form>
      )}
      {can('looked_at') && (
        <div class="admin-form">
          <input value={review} placeholder="What you found (optional)" aria-label="Review note"
            onInput={(e) => setReview((e.target as HTMLInputElement).value)} />
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => peopleApi.lookedAt(d.steamid, review.trim())).then(() => setReview(''))}>
            Looked at this
          </button>
          <span class="muted">
            Takes this file off Needs a look until something new arrives.
          </span>
        </div>
      )}
      {d.sections.notes.length === 0 ? <p class="muted">No notes.</p> : (
        <ul class="admin-list">
          {d.sections.notes.map((n) => (
            <li key={n.id}>
              <span class="muted">{n.authorName ?? n.authorId}, {fmtTime(n.createdAt)}:</span> {n.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```

- [ ] **Step 6: The page**

`web/src/routes/admin/file/PlayerFile.tsx`:

```tsx
import { peopleApi, type FileAction, type PlayerFileData } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { campaignName } from '../../../format';
import { fmtTime, useAction } from '../useAction';
import { ticketUrl } from '../adminRoutes';
import { FileHeader } from './FileHeader';
import { GlanceRow } from './GlanceRow';
import { IdentitySection } from './IdentitySection';
import { StandingSection } from './StandingSection';
import { NotesSection } from './NotesSection';

/**
 * Everything known about one player, at one URL.
 *
 * What a viewer may do arrives with the data as `actions`, decided by the
 * server, and every control asks that list rather than the session: the UI
 * only hides what the API would refuse anyway.
 */
export function PlayerFile({ steamid, me }: { steamid: string; me: string }) {
  const { data, error, reload } = useFetch((s) => peopleApi.file(steamid, s), [steamid]);
  const { busy, error: actionError, run } = useAction(reload);

  if (error) return <Panel><Empty>No such player, or not a file you can open.</Empty></Panel>;
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const d: PlayerFileData = data;
  const can = (action: FileAction) => d.actions.includes(action);

  return (
    <div class="file">
      <Panel class="file-section">
        <FileHeader d={d} me={me} busy={busy} run={run} can={can} />
        {actionError && <p class="error">{actionError}</p>}
        <GlanceRow d={d} />
      </Panel>

      <IdentitySection d={d} busy={busy} run={run} can={can} />
      <StandingSection d={d} busy={busy} run={run} can={can} />

      <Panel class="file-section">
        <h3>Tickets</h3>
        {d.sections.tickets.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.sections.tickets.map((t) => (
              <li key={t.id}>
                <a href={ticketUrl(t.id)}>#{t.id}</a> · {t.categories.join(', ') || 'opened by staff'}
                {' · '}{t.status === 'open' ? 'open' : (t.outcome ?? 'closed').replace(/_/g, ' ')}
                {' · '}{fmtTime(t.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <NotesSection d={d} busy={busy} run={run} can={can} />

      <Panel class="file-section">
        <h3>Recent matches</h3>
        {d.sections.matches.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.sections.matches.map((m) => (
              <li key={m.id}>
                <a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)} · {m.state} · team {m.team.toUpperCase()}
                {m.state === 'aborted' && !m.connectedAt && <span class="admin-warn"> · never connected</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 7: Run and watch it pass**

Run: `npx vitest run web/src/routes/playerFile.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/admin/file web/src/routes/playerFile.test.tsx
git commit -m "Render the Player File with its header, glance row and sections"
```

---

### Task 12: The evidence timeline and the evidence behind it

**Files:**
- Create: `web/src/routes/admin/file/Timeline.tsx`, `web/src/routes/admin/file/EvidenceDetail.tsx`
- Modify: `web/src/routes/admin/file/PlayerFile.tsx` (render both), `web/src/styles/app.css` (append a People desk block), `web/src/routes/playerFile.test.tsx` (three more cases)
- Test: `web/src/routes/playerFile.test.tsx`

**Interfaces:**
- Consumes: `TimelineItem`, `TimelineSource`, `PlayerFileData`, `adminApi.integrityReview(matchId, ordinal, half, slot, state, note)`; `SOURCE_LABEL`, `SourceBadge` from `./GlanceRow`.
- Produces:
  - `Timeline({ items }: { items: TimelineItem[] })`
  - `EvidenceDetail({ d, busy, run, canReview }: { d: PlayerFileData; busy: boolean; run: Run; canReview: boolean })`

- [ ] **Step 1: Add the failing cases**

Append to `web/src/routes/playerFile.test.tsx`, inside the existing file (after the last `describe`):

```tsx
describe('the evidence timeline', () => {
  const withTimeline = () => file({
    timeline: [
      {
        at: '2026-09-21T10:00:00.000Z', source: 'analyzer', kind: 'track',
        summary: 'Analyzer clip: track, fidelity 0.82 over 6.0 s. Watch it before deciding anything.',
        matchId: 7, replay: { ordinal: 2, half: 1, tMs: 61500 }, ref: { type: 'integrity_clip', id: 4 },
      },
      {
        at: '2026-09-20T10:00:00.000Z', source: 'lilac', kind: 'aimbot',
        summary: 'Little Anti-Cheat suspected aimbot. Few and rare suspicions are usually false positives; a run of them is what matters.',
        matchId: 7, replay: null, ref: { type: 'integrity_flag', id: 2 },
      },
      {
        at: '2026-09-19T10:00:00.000Z', source: 'note', kind: 'note',
        summary: 'boss: had a word', matchId: null, replay: null, ref: { type: 'note', id: 1 },
      },
    ],
  });

  it('lists every row newest first, with its source and its links', async () => {
    mockPeople.file.mockResolvedValue(withTimeline());
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    const rows = await screen.findAllByRole('listitem');
    const timeline = rows.filter((r) => r.className.includes('timeline__row'));
    expect(timeline).toHaveLength(3);
    expect(timeline[0].textContent).toContain('Replay analyzer');
    expect(within(timeline[0]).getByRole('link', { name: 'replay moment' }).getAttribute('href'))
      .toBe('/match/7?ordinal=2&half=1&t=61500');
    expect(within(timeline[1]).queryByRole('link', { name: 'replay moment' })).toBeNull();
    expect(within(timeline[1]).getByRole('link', { name: '#7' })).toBeTruthy();
  });

  it('filters by source and back again', async () => {
    mockPeople.file.mockResolvedValue(withTimeline());
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    fireEvent.click(await screen.findByRole('button', { name: /Note/ }));
    await waitFor(() => {
      const shown = screen.getAllByRole('listitem').filter((r) => r.className.includes('timeline__row'));
      expect(shown).toHaveLength(1);
      expect(shown[0].textContent).toContain('had a word');
    });
    fireEvent.click(screen.getByRole('button', { name: /Everything/ }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem').filter((r) => r.className.includes('timeline__row'))).toHaveLength(3);
    });
  });

  it('says when there is nothing rather than showing an empty list', async () => {
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText('Nothing has been recorded about this player.')).toBeTruthy();
  });
});

describe('the evidence detail', () => {
  it('shows the input bursts, the drops and the clips, and lets an admin review a round', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: {
            steamid: P, ranked: true, rank: 3, of: 40, rounds: 20, eligibleRounds: 18, clips: 1,
            trackShare: 0.21, occZ: 1.1, teamGap: 0.4, pFid: 0.9, pOcc: 0.8, pGap: 0.7, composite: 0.8,
          },
          rounds: [],
          clips: [{ id: 4, matchId: 7, ordinal: 2, half: 1, slot: 3, startMs: 61500, endMs: 67500, kind: 'track', score: 0.82, detail: {} }],
          flags: [{ id: 2, matchId: 7, steamid: P, source: 'lilac', kind: 'aimbot', severity: 'suspected', detail: '', at: '2026-09-20T10:00:00.000Z' }],
          inputFlags: [{
            id: 1, burstId: 1, matchId: 7, steamid: P, kind: 'attack', signature: 'pistol_rate',
            severity: 'low', at: '2026-09-20T10:00:00.000Z', hits: 3, note: 'wheel-like', bursts: [],
          }],
          inputCaps: [],
          signonDrops: { count: 1, lastAt: '2026-09-18T10:00:00.000Z', rows: [{ id: 1, name: 'ingame', secsConnected: 12, forcedCount: 651, at: '2026-09-18T10:00:00.000Z', enteredAfterAt: null }] },
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.getByText(/pistol_rate/)).toBeTruthy();
    expect(screen.getByText(/3 of 40/)).toBeTruthy();
    expect(screen.getByText(/651 files enforced/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Mark this round reviewed/ }));
    await waitFor(() => expect(mockAdmin.integrityReview).toHaveBeenCalledWith(7, 2, 1, 3, 'reviewed', ''));
  });

  it('offers a moderator the same evidence with no review buttons', async () => {
    mockPeople.file.mockResolvedValue(file({ actions: ['note', 'looked_at', 'open_ticket'] }));
    render(<PlayerFile steamid={P} me="76561199000000008" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(screen.queryByRole('button', { name: /Mark this round reviewed/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/routes/playerFile.test.tsx`
Expected: FAIL, no `timeline__row` rows exist.

- [ ] **Step 3: The timeline**

`web/src/routes/admin/file/Timeline.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { TimelineItem, TimelineSource } from '../../../api';
import { Empty } from '../../../components/bits';
import { fmtTime } from '../useAction';
import { SOURCE_LABEL, SourceBadge } from './GlanceRow';

/** The replay viewer at the moment a row is about. The same query shape the
 *  integrity board and the ticket page already use, which MatchDetail reads
 *  to pick the round and seek once its frames arrive. */
const replayHref = (item: TimelineItem): string | null =>
  item.matchId === null || item.replay === null
    ? null
    : `/match/${item.matchId}?ordinal=${item.replay.ordinal}&half=${item.replay.half}&t=${item.replay.tMs}`;

/**
 * One chronological list of everything, rather than a box per source.
 *
 * A person reading a file wants the order things happened in: a flag the
 * week after a ticket about the same thing reads differently from a flag on
 * its own. The chips narrow it without reordering it, and every badge has
 * the same weight, because the list is context and not an accusation.
 */
export function Timeline({ items }: { items: TimelineItem[] }) {
  const [only, setOnly] = useState<TimelineSource | null>(null);
  const counts = new Map<TimelineSource, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  const shown = only === null ? items : items.filter((i) => i.source === only);

  if (items.length === 0) return <Empty>Nothing has been recorded about this player.</Empty>;

  return (
    <>
      <div class="timeline__chips">
        <button type="button" class={`chip${only === null ? ' is-active' : ''}`} onClick={() => setOnly(null)}>
          Everything ({items.length})
        </button>
        {[...counts].map(([source, count]) => (
          <button key={source} type="button" class={`chip${only === source ? ' is-active' : ''}`}
            onClick={() => setOnly(source)}>
            {SOURCE_LABEL[source]} ({count})
          </button>
        ))}
      </div>
      <ul class="timeline">
        {shown.map((item, i) => (
          <li key={`${item.source}-${item.ref?.id ?? i}-${item.at}`} class="timeline__row">
            <span class="muted timeline__when">{fmtTime(item.at)}</span>
            <SourceBadge source={item.source} />
            <span class="timeline__text">{item.summary}</span>
            {item.matchId !== null && <a href={`/match/${item.matchId}`}>#{item.matchId}</a>}
            {replayHref(item) !== null && <a href={replayHref(item)!}>replay moment</a>}
          </li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 4: The evidence behind it**

`web/src/routes/admin/file/EvidenceDetail.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type IntegrityClip, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';

/** Clips sharing one player-round. Review state is keyed by the round, so
 *  the review control belongs to the round too: a control per clip marked up
 *  to five of them at once and typed into all their note boxes. */
function groupByRound(clips: IntegrityClip[]): { key: string; clips: IntegrityClip[] }[] {
  const out: { key: string; clips: IntegrityClip[] }[] = [];
  const at = new Map<string, { key: string; clips: IntegrityClip[] }>();
  for (const c of clips) {
    const key = `${c.matchId}/${c.ordinal}/${c.half}/${c.slot}`;
    let g = at.get(key);
    if (!g) { g = { key, clips: [] }; at.set(key, g); out.push(g); }
    g.clips.push(c);
  }
  return out;
}

const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));
const num3 = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(3));
const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

/**
 * The numbers under the timeline rows, for the reader who wants them.
 *
 * The timeline says what happened; this says what it was measured from. The
 * analyzer wording is the board's own, kept as it was written for version 4,
 * including the rounds gate: a player with too few measured rounds is not
 * ranked at all, and says so rather than reading as a zero.
 */
export function EvidenceDetail(
  { d, busy, run, canReview }: { d: PlayerFileData; busy: boolean; run: Run; canReview: boolean },
) {
  const e = d.sections.evidence;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const a = e.analyzer;

  return (
    <Panel class="file-section">
      <h3 id="evidence">The evidence behind these rows</h3>
      <p class="muted">
        Numbers and raw rows. Everything here is context to weigh against the replay and against
        each other; none of it decides anything on its own.
      </p>

      <h4>Replay analyzer</h4>
      {a === null ? <p class="muted">No analysed rounds for this player.</p> : (
        <p class="muted">
          {a.ranked ? `Rank ${a.rank} of ${a.of} ranked players` : 'Too few measured rounds to rank'}
          {' · '}{a.rounds} rounds, {a.eligibleRounds} with something to measure, {a.clips} clip{a.clips === 1 ? '' : 's'}
          {' · '}tracking {num3(a.trackShare)} ({pct(a.pFid)})
          {' · '}occupancy {num(a.occZ)} ({pct(a.pOcc)})
          {' · '}team gap {num(a.teamGap)} ({pct(a.pGap)})
        </p>
      )}
      <details class="colkey">
        <summary>What these columns mean</summary>
        <dl class="colkey__list">
          <dt>Tracking</dt>
          <dd>
            Did the crosshair move with an invisible infected. Each two second window in which they
            stayed aimed near a ghost that was itself moving scores from 1, exactly the motion needed
            to follow it, down to 0. Sitting still aimed at a known spawn scores zero however good
            the spot was. It is a rate over the windows that could be scored, so it does not grow
            with playtime, and it reads n/a with too few windows to make a ratio of.
          </dd>
          <dt>Occupancy</dt>
          <dd>
            How much more often they were aimed at a ghost than this map's own looking habits
            predict, in standard deviations, averaged over their rounds. Knowing where infected
            spawn is already in the baseline, so only the excess counts. One round at 2 is nothing.
            An average that stays there is something.
          </dd>
          <dt>Team gap</dt>
          <dd>
            Their occupancy minus their own teammates' average in the same rounds, which cancels out
            a round where everyone was staring at the same doorway.
          </dd>
          <dt>Rank and n/a</dt>
          <dd>
            Rank is a place by the composite of those three percentiles, a sort key and not a claim,
            and only within the players with enough measured rounds to rank. Occupancy and team gap
            need a baseline for the map, so a map with too little history reads n/a rather than 0.
          </dd>
        </dl>
      </details>
      <ul class="admin-list">
        {groupByRound(e.clips).map((g) => {
          const first = g.clips[0];
          const n = g.clips.length;
          return (
            <li key={g.key}>
              <ul class="integrity-clips">
                {g.clips.map((c) => (
                  <li key={c.id}>
                    <a href={`/match/${c.matchId}?ordinal=${c.ordinal}&half=${c.half}&t=${c.startMs}`}>
                      Match #{c.matchId}
                    </a>
                    <span class="muted"> · fidelity {c.score.toFixed(2)} · {((c.endMs - c.startMs) / 1000).toFixed(1)}s</span>
                  </li>
                ))}
              </ul>
              {canReview && (
                <div class="admin-form">
                  <input value={notes[g.key] ?? ''} placeholder="Review note" aria-label="Review note for this round"
                    onInput={(e2) => setNotes({ ...notes, [g.key]: (e2.target as HTMLInputElement).value })} />
                  {/* Labelled with the count because the state is per ROUND:
                      one click settles every clip listed above it. */}
                  <button class="btn" type="button" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'reviewed', notes[g.key] ?? ''))}>
                    Mark this round reviewed ({n} {n === 1 ? 'clip' : 'clips'})
                  </button>
                  <button class="chip" type="button" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'dismissed', notes[g.key] ?? ''))}>
                    Dismiss this round
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <h4>Live anti-cheat</h4>
      {e.flags.length === 0 ? <p class="muted">Nothing flagged by the live anti-cheat.</p> : (
        <ul class="admin-list">
          {e.flags.map((f) => (
            <li key={f.id}>
              {fmtTime(f.at)}: <code>{f.kind}</code>
              {f.severity === 'banned' ? <strong class="admin-warn"> · banned by LilAC</strong> : <span class="muted"> · suspected</span>}
              {f.matchId ? <> · <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
            </li>
          ))}
        </ul>
      )}

      <h4>Input timing</h4>
      {e.inputCaps.length > 0 && (
        <p class="admin-warn">
          Capture was cut short by the game server's per-round budget {e.inputCaps.length}
          {' '}time{e.inputCaps.length === 1 ? '' : 's'}, so bursts after that point in the round were
          never sent. No flag below does not mean a clean round there.
        </p>
      )}
      {e.inputFlags.length === 0 ? <p class="muted">Nothing flagged by input timing.</p> : (
        <ul class="admin-list">
          {e.inputFlags.map((f) => (
            <li key={f.id}>
              {fmtTime(f.at)}: <code>{f.signature}</code> on {f.hits} {f.kind} burst{f.hits === 1 ? '' : 's'}
              {f.matchId ? <> in <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
              <span class="muted"> · {f.severity}{f.note ? ` · holds: ${f.note}` : ''}</span>
              {f.bursts.length > 0 && (
                <details>
                  <summary class="muted">The bursts that counted</summary>
                  <ul class="admin-list">
                    {f.bursts.map((b) => (
                      <li key={b.id}>
                        {b.ratePerSec.toFixed(1)}/s over {b.presses} presses
                        {b.weapon ? <> on <code>{b.weapon}</code></> : null}
                        {b.hold
                          ? <> · held {b.hold.medianTicks} ticks median, {Math.round(b.hold.oneTickFrac * 100)}% one-tick · <strong>{b.annotation}</strong></>
                          : <span class="muted"> · no hold data</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>Connect drops</h4>
      {e.signonDrops.count === 0 ? <p class="muted">None.</p> : (
        <>
          <p class="muted">
            Left while still loading in, on a map that was enforcing file consistency. Usually a
            rejected modified file, sometimes just a cancelled loading screen.
            {' '}<a href="/help/consistency">What players are told</a>.
          </p>
          <ul class="admin-list">
            {e.signonDrops.rows.map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)}: as {r.name}, {r.secsConnected < 0 ? 'time unknown' : `after ${r.secsConnected} s`},
                {' '}{r.forcedCount} files enforced
                {r.enteredAfterAt
                  ? <span class="muted"> · got in {fmtTime(r.enteredAfterAt)}</span>
                  : <span class="admin-warn"> · has not got in since</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
```

- [ ] **Step 5: Put both on the page**

In `web/src/routes/admin/file/PlayerFile.tsx`, import the two components and render them: the timeline in its own panel straight after the header panel, the detail after the standing section.

```tsx
import { Timeline } from './Timeline';
import { EvidenceDetail } from './EvidenceDetail';
```

```tsx
  const can = (action: FileAction) => d.actions.includes(action);
  // Every admin-only action arrives together, so one of them answers "is
  // this viewer an admin" without the page asking the session separately.
  const canReview = can('ban');
```

```tsx
      <Panel class="file-section">
        <h3>Evidence timeline</h3>
        <Timeline items={d.timeline} />
      </Panel>

      <IdentitySection d={d} busy={busy} run={run} can={can} />
      <StandingSection d={d} busy={busy} run={run} can={can} />
      <EvidenceDetail d={d} busy={busy} run={run} canReview={canReview} />
```

- [ ] **Step 6: The styles**

Append to `web/src/styles/app.css`:

```css
/* ---------- the People desk ---------- */

.file { display: flex; flex-direction: column; gap: var(--sp-3); }
.file-head { display: flex; gap: var(--sp-3); align-items: flex-start; flex-wrap: wrap; }
.file-head__avatar { width: 56px; height: 56px; border-radius: 2px; }
.file-head h2 { margin: 0; display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.file-head .admin-actions { margin-left: auto; }
.file-glance { margin-top: var(--sp-3); font-size: var(--fs-dense); }
.file-glance p { margin: var(--sp-1) 0; }
.file-section h3 { margin-top: 0; }

/* One neutral badge for every source. Colouring them by source would read as
   a severity, and none of these rows is a verdict. */
.source-badge {
  font-family: var(--font-label); font-size: var(--fs-label); letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--text-muted);
  border: 1px solid var(--border-strong); border-radius: 2px;
  padding: 0 var(--sp-1); white-space: nowrap;
}

.timeline__chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-bottom: var(--sp-2); }
.timeline { list-style: none; margin: 0; padding: 0; font-size: var(--fs-dense); }
.timeline__row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem;
  padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere;
}
.timeline__when { white-space: nowrap; }
.timeline__text { flex: 1 1 18rem; }

@media (max-width: 640px) {
  .file-head .admin-actions { margin-left: 0; }
}
```

- [ ] **Step 7: Run and watch it pass**

Run: `npx vitest run web/src/routes/playerFile.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/admin/file web/src/routes/playerFile.test.tsx web/src/styles/app.css
git commit -m "Show one evidence timeline on the file, with the numbers behind it"
```

---

### Task 13: Needs a look, the analysis panel and the ban list

**Files:**
- Create: `web/src/routes/admin/NeedsALook.tsx`, `web/src/routes/admin/AnalysisPanel.tsx`, `web/src/routes/admin/PeopleBans.tsx`
- Modify: `web/src/routes/people.test.tsx` (mock `adminApi` too, and two more describes)
- Test: `web/src/routes/people.test.tsx`

**Interfaces:**
- Consumes: `peopleApi.review`, `peopleApi.bans`, `peopleApi.lookedAt`, `adminApi.integrityJob`, `adminApi.integrityRun`; `NeedsALookRow`, `PeopleBan`, `CaptureHealth`; `SOURCE_LABEL` from `./file/GlanceRow`; `fileUrl`, `ticketUrl` from `./adminRoutes`; `Tabs`, `Panel`, `Empty`.
- Produces: `NeedsALook()`, `AnalysisPanel()`, `PeopleBans()`

- [ ] **Step 1: Add the failing cases**

In `web/src/routes/people.test.tsx`, replace the hoisted mock block and the imports at the top with:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminPlayerRow, NeedsALookRow, PeopleBan } from '../api';

const { mockPeople, mockAdmin } = vi.hoisted(() => ({
  mockPeople: { people: vi.fn(), file: vi.fn(), review: vi.fn(), bans: vi.fn(), note: vi.fn(), lookedAt: vi.fn() },
  mockAdmin: { integrityJob: vi.fn(), integrityRun: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, peopleApi: mockPeople, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { PeopleSearch } = await import('./admin/PeopleSearch');
const { NeedsALook } = await import('./admin/NeedsALook');
const { AnalysisPanel } = await import('./admin/AnalysisPanel');
const { PeopleBans } = await import('./admin/PeopleBans');
```

and extend the `beforeEach` so every screen has an answer:

```tsx
beforeEach(() => {
  for (const fn of [...Object.values(mockPeople), ...Object.values(mockAdmin)]) fn.mockReset();
  mockPeople.people.mockResolvedValue({ players: [row] });
  mockPeople.review.mockResolvedValue({ players: [], health: health() });
  mockPeople.bans.mockResolvedValue({ bans: [] });
  mockPeople.lookedAt.mockResolvedValue({ ok: true, review: { id: 1, steamid: row.steamid, reviewedBy: '9', reviewedByName: 'boss', reviewedAt: '2026-09-21T00:00:00.000Z', note: '' } });
  mockAdmin.integrityJob.mockResolvedValue({
    available: true,
    job: { status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [] },
    pending: 0,
    matchInFlight: false,
  });
  mockAdmin.integrityRun.mockResolvedValue({ ok: true });
});
```

Then append these fixtures and describes:

```tsx
const health = () => ({
  bursts: 12, detections: 1, lilacFlags: 2, lastBurstAt: '2026-09-20T10:00:00.000Z',
  lastFlagAt: '2026-09-20T10:00:00.000Z', matchesWithBursts: 3, caps: 0,
});

const lookRow: NeedsALookRow = {
  steamid: '76561199000000001', name: 'griefer', avatar: null, status: 'active',
  newestEvidenceAt: '2026-09-21T10:00:00.000Z', sources: ['lilac', 'analyzer'],
  lastReviewAt: null, lastReviewBy: null, openTickets: 1,
  analyzer: {
    steamid: '76561199000000001', ranked: true, rank: 3, of: 40, rounds: 20, eligibleRounds: 18,
    clips: 2, trackShare: 0.21, occZ: 1.1, teamGap: 0.4, pFid: 0.9, pOcc: 0.8, pGap: 0.7, composite: 0.8,
  },
};

const ban: PeopleBan = {
  id: 1, steamid: '76561199000000001', name: 'griefer', reason: 'throwing', length: '1 day',
  createdAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-21T10:00:00.000Z', createdByName: 'boss',
  liftedAt: null, liftedByName: null, active: true, ticketId: 12, withheld: false, canOpen: true,
};

describe('Needs a look', () => {
  it('lists a player with their sources, rank and a way into the file', async () => {
    mockPeople.review.mockResolvedValue({ players: [lookRow], health: health() });
    render(<NeedsALook />);
    const link = await screen.findByRole('link', { name: 'griefer' });
    expect(link.getAttribute('href')).toBe('/admin/people/76561199000000001');
    expect(screen.getByText(/Little Anti-Cheat/)).toBeTruthy();
    expect(screen.getByText(/Replay analyzer/)).toBeTruthy();
    expect(screen.getByText(/3 of 40/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '1 open ticket' }).getAttribute('href'))
      .toBe('/admin/people/tickets');
  });

  it('marks a file looked at from the list', async () => {
    mockPeople.review.mockResolvedValue({ players: [lookRow], health: health() });
    render(<NeedsALook />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looked at' }));
    await waitFor(() => expect(mockPeople.lookedAt).toHaveBeenCalledWith('76561199000000001', ''));
  });

  it('says whether anything is being captured at all when the list is empty', async () => {
    render(<NeedsALook />);
    expect(await screen.findByText('Nothing is waiting to be looked at.')).toBeTruthy();
    expect(screen.getByText(/12 input bursts/)).toBeTruthy();
  });
});

describe('the analysis panel', () => {
  it('runs an analysis and says where this panel is going', async () => {
    render(<AnalysisPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-analyse all replays' }));
    await waitFor(() => expect(mockAdmin.integrityRun).toHaveBeenCalledWith('full', false));
    expect(screen.getByText(/moves to Setup/)).toBeTruthy();
  });

  it('says so plainly when there is no replay directory', async () => {
    mockAdmin.integrityJob.mockResolvedValue({ available: false });
    render(<AnalysisPanel />);
    expect(await screen.findByText(/nothing to analyse/)).toBeTruthy();
  });
});

describe('the ban list', () => {
  it('lists bans, filters them, and opens the file behind each one', async () => {
    mockPeople.bans.mockResolvedValue({ bans: [ban] });
    render(<PeopleBans />);
    expect((await screen.findByRole('link', { name: 'griefer' })).getAttribute('href'))
      .toBe('/admin/people/76561199000000001');
    expect(screen.getByText('throwing')).toBeTruthy();
    expect(screen.getByText('1 day')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('/admin/people/tickets/12');
    expect(mockPeople.bans).toHaveBeenCalledWith('active', '', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: 'Expired' }));
    await waitFor(() => expect(mockPeople.bans).toHaveBeenCalledWith('expired', '', expect.anything()));
  });

  it('shows a withheld reason as text and offers no file link a moderator cannot use', async () => {
    mockPeople.bans.mockResolvedValue({
      bans: [{ ...ban, reason: 'Withheld (restricted ticket)', createdByName: null, ticketId: null, withheld: true, canOpen: false }],
    });
    render(<PeopleBans />);
    expect(await screen.findByText('Withheld (restricted ticket)')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'griefer' })).toBeNull();
    expect(screen.getByText('griefer')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/routes/people.test.tsx`
Expected: FAIL, cannot resolve `./admin/NeedsALook`.

- [ ] **Step 3: Needs a look**

`web/src/routes/admin/NeedsALook.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl } from './adminRoutes';
import { SOURCE_LABEL } from './file/GlanceRow';
import { AnalysisPanel } from './AnalysisPanel';

type SortKey = 'newest' | 'rank' | 'tracking';

const num3 = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(3));

/**
 * Everyone with evidence nobody has read yet, newest first.
 *
 * This replaces the integrity board, and deliberately is not one: the board
 * ranked every player who had ever been measured, which is a list of your
 * best players by another name. This lists only files where something has
 * arrived since the last time a person looked, and it empties as they are
 * worked through, which is the whole point.
 */
export function NeedsALook() {
  const { data, reload } = useFetch((s) => peopleApi.review(s), []);
  const { busy, error, run } = useAction(reload);
  const [sort, setSort] = useState<SortKey>('newest');

  const players = [...(data?.players ?? [])].sort((a, b) => {
    if (sort === 'rank') {
      // Unranked players have nothing to rank on and go last, whichever way
      // the column is read.
      const ra = a.analyzer?.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.analyzer?.rank ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    }
    if (sort === 'tracking') return (b.analyzer?.trackShare ?? -1) - (a.analyzer?.trackShare ?? -1);
    return a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1;
  });

  return (
    <>
      <Panel class="panel--table">
        <p class="muted">
          Files with something on them that nobody has read yet. Marking one looked at takes it off
          this list until something new arrives. The columns are a way of deciding what to read
          first, never a finding.
        </p>
        {error && <p class="error">{error}</p>}
        {data && players.length === 0 && <Empty>Nothing is waiting to be looked at.</Empty>}
        {players.length > 0 && (
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th><button class="linklike" type="button" onClick={() => setSort('newest')}>Newest</button></th>
                  <th>What arrived</th>
                  <th><button class="linklike" type="button" onClick={() => setSort('rank')}>Analyzer rank</button></th>
                  <th><button class="linklike" type="button" onClick={() => setSort('tracking')}>Tracking</button></th>
                  <th>Open tickets</th>
                  <th>Last looked at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.steamid}>
                    <td>
                      <a href={fileUrl(p.steamid)}>{p.name}</a>
                      <div class="mono muted">{p.steamid}</div>
                    </td>
                    <td class="muted">{fmtTime(p.newestEvidenceAt)}</td>
                    <td>{p.sources.map((s) => SOURCE_LABEL[s]).join(', ')}</td>
                    <td>
                      {p.analyzer === null ? <span class="muted">not analysed</span>
                        : p.analyzer.ranked ? `${p.analyzer.rank} of ${p.analyzer.of}`
                          : <span class="muted">too few rounds</span>}
                    </td>
                    <td>{num3(p.analyzer?.trackShare ?? null)}</td>
                    <td>
                      {p.openTickets === 0 ? <span class="muted">none</span>
                        : <a href="/admin/people/tickets">{p.openTickets} open ticket{p.openTickets === 1 ? '' : 's'}</a>}
                    </td>
                    <td class="muted">
                      {p.lastReviewAt ? `${fmtTime(p.lastReviewAt)} by ${p.lastReviewBy}` : 'never'}
                    </td>
                    <td>
                      <button class="chip" type="button" disabled={busy}
                        onClick={() => run(() => peopleApi.lookedAt(p.steamid, ''))}>Looked at</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.health && (
          // Rendered even when everything is zero: an empty list cannot
          // otherwise tell "nobody flagged" apart from "silently broken".
          <p class="muted">
            {data.health.bursts === 0
              ? 'No input bursts captured yet. Bursts are only recorded during a live match, so this stays empty until a PUG runs.'
              : `${data.health.bursts.toLocaleString()} input bursts across ${data.health.matchesWithBursts} match${data.health.matchesWithBursts === 1 ? '' : 'es'}, most recent ${fmtTime(data.health.lastBurstAt)}.`}
            {' '}
            {data.health.detections === 0 && data.health.lilacFlags === 0
              ? 'Nothing flagged.'
              : `${data.health.detections} input detection${data.health.detections === 1 ? '' : 's'}, ${data.health.lilacFlags} Little Anti-Cheat flag${data.health.lilacFlags === 1 ? '' : 's'}.`}
            {data.health.caps > 0 && ` Capture was truncated ${data.health.caps} time${data.health.caps === 1 ? '' : 's'} by the per-round budget; each file says where.`}
          </p>
        )}
      </Panel>
      <AnalysisPanel />
    </>
  );
}
```

- [ ] **Step 4: The analysis panel, in a marked temporary home**

`web/src/routes/admin/AnalysisPanel.tsx`:

```tsx
import { useEffect } from 'preact/hooks';
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

/**
 * Run the replay analysis, and say what pressing the button would achieve.
 *
 * TEMPORARY HOME. The spec puts this on Setup, Servers, next to analyzer
 * coverage; that section does not exist until the Setup plan lands, and
 * leaving the only way to start an analysis on a screen that is being
 * deleted would lose it. It sits under Needs a look, which is the screen its
 * output feeds, until Setup takes it.
 */
export function AnalysisPanel() {
  const { data, reload } = useFetch((s) => adminApi.integrityJob(s), []);
  const { busy, error, run } = useAction(reload);
  const running = data?.available === true && data.job.status === 'running';

  // Only while a run is going: an idle panel has nothing to poll for.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [running]);

  if (!data) return null;
  if (!data.available) {
    return (
      <Panel>
        <h3>Analysis</h3>
        <p class="muted">No replay directory is configured on this server, so there is nothing to analyse.</p>
      </Panel>
    );
  }

  const { job, pending, matchInFlight } = data;
  const lost = data.unanalysable ?? { missing: 0, unreadable: 0 };
  const lostTotal = lost.missing + lost.unreadable;
  return (
    <Panel>
      <h3>Analysis</h3>
      <p class="muted">
        Rounds are measured automatically once a match finishes.
        {pending > 0
          ? ` ${pending} round${pending === 1 ? '' : 's'} waiting to be measured; the next pass picks ${pending === 1 ? 'it' : 'them'} up within a minute.`
          : ' Everything on disk has been measured.'}
        {' '}Re-analysing everything is for after a threshold change. This panel moves to Setup,
        Servers when that desk is built.
      </p>
      {lostTotal > 0 && (
        <p class="muted">
          {lostTotal} round{lostTotal === 1 ? '' : 's'} could not be analysed and {lostTotal === 1 ? 'is' : 'are'} not
          counted as waiting: {lost.missing} with no replay on disk, {lost.unreadable} that would not
          decode. Re-analysing everything tries any whose file is there again.
        </p>
      )}
      <div class="admin-row">
        <button class="btn" disabled={busy || running || matchInFlight}
          onClick={() => run(() => adminApi.integrityRun('full', false))}>
          {running ? 'Analysing...' : 'Re-analyse all replays'}
        </button>
        {matchInFlight && !running && (
          <button class="chip" disabled={busy}
            onClick={() => run(
              () => adminApi.integrityRun('full', true),
              'A match is in flight. This decodes every replay on disk and competes with the game server for CPU. Run it anyway?',
            )}>
            Force
          </button>
        )}
      </div>
      {matchInFlight && (
        <p class="muted">
          A match is in flight. This reads every replay on disk on the same two cores holding
          100 tick, so it is blocked until the box is quiet. Force it only if you know it is.
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {job.status !== 'idle' && (
        <p class="muted">
          Last run: {job.mode === 'pending' ? 'new rounds' : 'everything'}, {job.status}
          {job.startedAt && `, started ${fmtTime(job.startedAt)}`}
          {job.finishedAt && `, finished ${fmtTime(job.finishedAt)}`}
          {job.status === 'failed' && job.exitCode !== null && ` (exit ${job.exitCode})`}
        </p>
      )}
      {job.output.length > 0 && <pre class="admin-log">{job.output.join('\n')}</pre>}
    </Panel>
  );
}
```

- [ ] **Step 5: The ban list**

`web/src/routes/admin/PeopleBans.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel, Tabs } from '../../components/bits';
import { fmtTime } from './useAction';
import { fileUrl, ticketUrl } from './adminRoutes';

const FILTERS = [
  { key: 'active', label: 'In force' },
  { key: 'expired', label: 'Expired' },
  { key: 'all', label: 'All' },
];

/**
 * The ban list, inside the panel where the rest of enforcement lives.
 *
 * Lifted and expired bans stay on it: a record that quietly removes its own
 * mistakes is not a record, and who lifted one and when is the part that
 * shows the process works. A row whose reason reads "Withheld" came from a
 * ticket this viewer is not on; the server decided that.
 */
export function PeopleBans() {
  const [filter, setFilter] = useState<'active' | 'expired' | 'all'>('active');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useFetch((s) => peopleApi.bans(filter, query, s), [filter, query]);
  const bans = data?.bans ?? [];

  return (
    <Panel class="panel--table">
      <Tabs tabs={FILTERS} active={filter} onSelect={(k) => setFilter(k as typeof filter)} />
      <form class="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} placeholder="Name or SteamID64" aria-label="Search bans"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit">Search</button>
      </form>
      {error && <Empty>Could not load the ban list.</Empty>}
      {data && bans.length === 0 && <Empty>{query ? 'Nobody by that name or ID.' : 'No bans here.'}</Empty>}
      {bans.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Player</th><th>Reason</th><th>Length</th><th>Issued</th><th>Status</th><th>Ticket</th></tr>
            </thead>
            <tbody>
              {bans.map((b) => (
                <tr key={b.id} class={b.active ? '' : 'is-lifted'}>
                  <td>
                    {b.canOpen ? <a href={fileUrl(b.steamid)}>{b.name}</a> : b.name}
                    <div class="mono muted">{b.steamid}</div>
                  </td>
                  {/* Staff-written text, rendered as text. */}
                  <td>{b.reason}</td>
                  <td>{b.length}</td>
                  <td class="muted">
                    {fmtTime(b.createdAt)}{b.createdByName ? ` by ${b.createdByName}` : ''}
                  </td>
                  <td>
                    {b.active ? <span class="admin-status admin-status--banned">in force</span>
                      : b.liftedAt ? <span class="muted">lifted {fmtTime(b.liftedAt)}{b.liftedByName ? ` by ${b.liftedByName}` : ''}</span>
                        : <span class="muted">expired</span>}
                  </td>
                  <td>{b.ticketId === null ? <span class="muted">none</span> : <a href={ticketUrl(b.ticketId)}>#{b.ticketId}</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run web/src/routes/people.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/NeedsALook.tsx web/src/routes/admin/AnalysisPanel.tsx web/src/routes/admin/PeopleBans.tsx web/src/routes/people.test.tsx
git commit -m "Add Needs a look, the analysis panel and the ban list to the People desk"
```

---

### Task 14: The three-desk shell, and real URLs everywhere

**Files:**
- Create: `web/src/components/Redirect.tsx`
- Modify: `web/src/routes/Admin.tsx` (rewritten), `web/src/main.tsx:134-153` (the routes), `web/src/components/Nav.tsx:241-247` (the Bans link), `web/src/routes/admin/AdminTickets.tsx:15-33` (selection comes from the URL), `web/src/routes/tickets.test.tsx` (the new URLs), `web/src/routes/admin.test.tsx` (render through the router; the Players and Integrity describes go)
- Test: `web/src/routes/tickets.test.tsx`, `web/src/routes/admin.test.tsx`

**Interfaces:**
- Consumes: `parseAdminPath`, `legacyRedirect`, `DESKS`, `PEOPLE_TABS`, `SETUP_TABS`, `ticketUrl` from `adminRoutes.ts`; `useLocation()` from preact-iso, which gives `path` and `route(url, replace?)`.
- Produces:
  - `Admin({ session }: { session: Session })`, now a URL-driven shell.
  - `AdminTickets({ onOpen }: { onOpen: (id: number) => void })`, a list and nothing else.
  - `Redirect({ to }: { to: string })`.

- [ ] **Step 1: Write the failing test**

Rewrite the top of `web/src/routes/tickets.test.tsx` so it renders through the router, and change the deep links:

```tsx
const { Admin } = await import('./Admin');
const { LocationProvider } = await import('preact-iso');

const renderAdmin = (path: string, me: { steamid: string; name: string; avatar: string | null; status: string; isAdmin: boolean; isMod: boolean }) => {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <Admin session={{ kind: 'active', me }} />
      <ConfirmHost />
    </LocationProvider>,
  );
};
```

Then replace each render and deep link in that file:

```tsx
  it('refuses a plain player', () => {
    renderAdmin('/admin/people/tickets', { ...mod, isMod: false });
    expect(screen.getByText('Staff only.')).toBeTruthy();
    expect(mockMod.tickets).not.toHaveBeenCalled();
  });

  it('a moderator sees the People desk only, and never calls the admin API', async () => {
    renderAdmin('/admin/people/tickets', mod);
    await screen.findByText('Walls');
    expect(screen.queryByRole('tab', { name: 'Live' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Setup' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Needs a look' })).toBeTruthy();
    expect(mockAdmin.players).not.toHaveBeenCalled();
    expect(screen.getByText(/2 reports from 2 people/)).toBeTruthy();
  });

  it('opens a ticket from the list at its own URL', async () => {
    renderAdmin('/admin/people/tickets', mod);
    fireEvent.click(await screen.findByText('Walls'));
    await screen.findByText('saw me through a wall');
    expect(location.pathname).toBe('/admin/people/tickets/12');
    const replay = screen.getByRole('link', { name: /replay moment/i }) as HTMLAnchorElement;
    expect(replay.getAttribute('href')).toBe('/match/66?ordinal=2&half=1&t=61500');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(mockMod.claim).toHaveBeenCalledWith(12, true));
  });

  it('opens straight to a ticket from an old feed link', async () => {
    renderAdmin('/admin?ticket=12', mod);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledWith(12, expect.anything());
    expect(location.pathname).toBe('/admin/people/tickets/12');
  });
```

and in the three remaining cases that used `history.replaceState(null, '', '/admin?ticket=12')` followed by a `render(...)`, call `renderAdmin('/admin/people/tickets/12', mod)` (or `{ ...mod, isAdmin: true }` for the admin case) instead. The `afterEach` becomes:

```tsx
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
```

In `web/src/routes/admin.test.tsx`, add the same helper after the imports:

```tsx
const { LocationProvider } = await import('preact-iso');

/** Every screen in the panel is a URL now, so tests navigate rather than
 *  clicking a tab. ConfirmHost rides along: it renders nothing until an
 *  action asks a question. */
const renderAdmin = (path: string, session: Parameters<typeof Admin>[0]['session'] = { kind: 'active', me }) => {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <Admin session={session} />
      <ConfirmHost />
    </LocationProvider>,
  );
};
```

then:
- delete the seven player-detail cases in the `Admin page` describe (from "lists players, opens a detail and bans with a reason" through "shows what an input flag rests on..."): those screens are gone, and `web/src/routes/playerFile.test.tsx` and `tests/peopleRoutes.test.ts` cover what they asserted;
- delete the whole `AdminIntegrity` describe: the board is replaced by Needs a look and by the file's evidence section, both tested in `web/src/routes/people.test.tsx` and `web/src/routes/playerFile.test.tsx`;
- keep `refuses a non-admin without calling the admin API`, rendered as `renderAdmin('/admin/people', { kind: 'active', me: { ...me, isAdmin: false } })`;
- the two settings cases and the campaign-pool case render with `renderAdmin('/admin/setup/settings')` and no tab click;
- `AdminMatches layout`'s `openTab` becomes:

```tsx
  const openTab = async () => {
    mockAdmin.overview.mockResolvedValue(overview());
    renderAdmin('/admin/live');
    await waitFor(() => expect(screen.getByText('Dallas')).toBeTruthy());
  };
```

- every `render(<Admin session={{ kind: 'active', me }} />)` in `AdminCampaigns` becomes `renderAdmin('/admin/setup/campaigns')` with the following `fireEvent.click(screen.getByRole('tab', { name: 'Campaigns' }))` line deleted.

Finally add one describe at the end of `admin.test.tsx`:

```tsx
describe('the panel shell', () => {
  beforeEach(() => {
    mockAdmin.overview.mockResolvedValue({ open: [], recent: [], aborted: [], voided: [], queue: [], servers: [], slowToReady: [] });
  });

  it('lands an admin on Live and a moderator on People', async () => {
    renderAdmin('/admin');
    await waitFor(() => expect(location.pathname).toBe('/admin/live'));
    cleanup();
    renderAdmin('/admin', { kind: 'active', me: { ...me, isAdmin: false, isMod: true } });
    await waitFor(() => expect(location.pathname).toBe('/admin/people'));
  });

  it('keeps a moderator out of the other two desks', async () => {
    renderAdmin('/admin/setup/settings', { kind: 'active', me: { ...me, isAdmin: false, isMod: true } });
    await waitFor(() => expect(location.pathname).toBe('/admin/people'));
    expect(mockAdmin.settings).not.toHaveBeenCalled();
  });

  it('says so for a URL that is not a screen', async () => {
    renderAdmin('/admin/people/nonsense');
    expect(await screen.findByText('No such page in the panel.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/routes/admin.test.tsx web/src/routes/tickets.test.tsx`
Expected: FAIL, the shell still renders tabs from component state and never changes the URL.

- [ ] **Step 3: The shell**

`web/src/routes/Admin.tsx`, replacing the whole file:

```tsx
import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Empty, Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { DESKS, PEOPLE_TABS, SETUP_TABS, legacyRedirect, parseAdminPath, ticketUrl } from './admin/adminRoutes';
import { AdminMatches } from './admin/AdminMatches';
import { AdminTickets } from './admin/AdminTickets';
import { AdminTicket } from './admin/AdminTicket';
import { AdminSettings } from './admin/AdminSettings';
import { AdminAudit } from './admin/AdminAudit';
import { AdminSeasons } from './admin/AdminSeasons';
import { AdminCampaigns } from './admin/AdminCampaigns';
import { PeopleSearch } from './admin/PeopleSearch';
import { NeedsALook } from './admin/NeedsALook';
import { PeopleBans } from './admin/PeopleBans';
import { PlayerFile } from './admin/file/PlayerFile';

/**
 * The staff panel: three desks, and the URL says which screen you are on.
 *
 * The tab state used to live in component memory, so nobody could link
 * anyone to what they were looking at and the back button left the panel.
 * Every screen is now a path, and the shell is only a switch over it.
 *
 * Live and Setup hold today's screens unchanged. Their own plans build the
 * live board, the servers section and the staff list; nothing here is the
 * final shape of either, and the URLs they will use already exist.
 *
 * The server enforces every route behind this. The guard here only spares
 * somebody a page of refusals.
 */
export function Admin({ session }: { session: Session }) {
  const { path, route } = useLocation();
  const isAdmin = session.kind === 'active' && session.me.isAdmin;
  const isStaff = isAdmin || (session.kind === 'active' && session.me.isMod === true);
  const target = isStaff ? legacyRedirect(path, location.search, isAdmin) : null;
  useEffect(() => { if (target) route(target, true); }, [target]);

  if (session.kind === 'loading') return <div class="page page--admin" />;
  if (session.kind !== 'active' || !isStaff) {
    return (
      <div class="page page--list">
        <Panel><Empty>Staff only.</Empty></Panel>
      </div>
    );
  }
  // One frame of nothing while the redirect lands, rather than rendering a
  // screen that is about to be replaced.
  if (target) return <div class="page page--admin" />;

  const me = session.me.steamid;
  const r = parseAdminPath(path, { isAdmin });
  const tabs = r.desk === 'people' ? PEOPLE_TABS : r.desk === 'setup' ? SETUP_TABS : [];
  // A file belongs under Players and a ticket under Tickets, so the tab strip
  // keeps a highlight while you are inside one.
  const activeTab = r.section === 'file' ? 'search' : r.section === 'ticket' ? 'tickets' : r.section;
  const go = (list: { key: string; path: string }[]) => (key: string) => {
    const found = list.find((t) => t.key === key);
    if (found) route(found.path);
  };

  return (
    <div class="page page--admin">
      <PageHeader eyebrow="Riverside" title={isAdmin ? 'Admin' : 'Moderation'} />
      {isAdmin && <Tabs tabs={DESKS} active={r.desk} onSelect={go(DESKS)} />}
      {tabs.length > 0 && <Tabs tabs={tabs} active={activeTab} onSelect={go(tabs)} />}
      <div class="admin-body">
        {r.desk === 'live' && <AdminMatches />}
        {r.desk === 'people' && r.section === 'search' && <PeopleSearch />}
        {r.desk === 'people' && r.section === 'file' && <PlayerFile steamid={r.param!} me={me} />}
        {r.desk === 'people' && r.section === 'review' && <NeedsALook />}
        {r.desk === 'people' && r.section === 'bans' && <PeopleBans />}
        {r.desk === 'people' && r.section === 'tickets' && <AdminTickets onOpen={(id) => route(ticketUrl(id))} />}
        {r.desk === 'people' && r.section === 'ticket' && (
          <AdminTicket
            id={Number(r.param)}
            onBack={() => route('/admin/people/tickets')}
            onOpen={(id) => route(ticketUrl(id))}
          />
        )}
        {r.desk === 'people' && r.section === 'unknown' && <Panel><Empty>No such page in the panel.</Empty></Panel>}
        {r.desk === 'setup' && r.section === 'campaigns' && <AdminCampaigns />}
        {r.desk === 'setup' && r.section === 'seasons' && <AdminSeasons />}
        {r.desk === 'setup' && r.section === 'settings' && <AdminSettings />}
        {r.desk === 'setup' && r.section === 'audit' && <AdminAudit />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: The ticket list follows the URL**

In `web/src/routes/admin/AdminTickets.tsx`, delete `ticketFromUrl`, the `selected` state, the `select` helper and the `AdminTicket` import, and take the opener as a prop:

```tsx
export function AdminTickets({ onOpen }: { onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState<'open' | 'mine' | 'closed'>('open');
  const { data } = useFetch((s) => modApi.tickets(filter, s), [filter]);

  return (
    <Panel>
      <Tabs active={filter} onSelect={(k) => setFilter(k as typeof filter)} tabs={FILTERS} />
      {data && data.tickets.length === 0 && <Empty>No {filter === 'mine' ? 'tickets claimed by you' : `${filter} tickets`}.</Empty>}
      <ul class="tickets">
        {data?.tickets.map((t) => (
          <li key={t.id}>
            <button type="button" class="ticket-row" onClick={() => onOpen(t.id)}>
```

The rest of the row markup, and the exported `reportLine`, stay exactly as they are.

- [ ] **Step 5: Routing and the nav**

`web/src/components/Redirect.tsx`:

```tsx
import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

/** Send the browser somewhere else and render nothing. For a URL that has
 *  moved but is still in bookmarks and in old Discord posts. */
export function Redirect({ to }: { to: string }) {
  const { route } = useLocation();
  useEffect(() => { route(to, true); }, [to]);
  return null;
}
```

In `web/src/main.tsx`, swap the `Bans` import for the redirect and give the panel its sub-paths:

```tsx
import { Redirect } from './components/Redirect';
```

```tsx
          <Route path="/admin" component={Admin} session={session} />
          {/* Every screen in the panel is a path now, so the shell needs the
              whole subtree rather than one route. */}
          <Route path="/admin/*" component={Admin} session={session} />
          {/* The ban list moved into the panel; the old URL is in bookmarks. */}
          <Route path="/bans" component={() => <Redirect to="/admin/people/bans" />} />
```

In `web/src/components/Nav.tsx`, point the Bans link at the panel and show it to moderators too:

```tsx
        {(me?.isAdmin || me?.isMod) && (
          <a href="/admin/people/bans" aria-current={path === '/admin/people/bans' ? 'page' : undefined}>Bans</a>
        )}
```

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run web/src/routes/admin.test.tsx web/src/routes/tickets.test.tsx web/src/components/Nav.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/Admin.tsx web/src/components/Redirect.tsx web/src/main.tsx web/src/components/Nav.tsx web/src/routes/admin/AdminTickets.tsx web/src/routes/admin.test.tsx web/src/routes/tickets.test.tsx
git commit -m "Turn the admin panel into three desks addressed by URL"
```

---

### Task 15: The ticket page uses the shared summary, and the old screens retire

**Files:**
- Create: `web/src/routes/admin/file/FileSummary.tsx`
- Modify: `web/src/routes/admin/AdminTicket.tsx:32-116` (the case-file section), `web/src/routes/Admin.tsx` (drop the now-unused `onOpen` on `AdminTicket`), `web/src/api.ts:969-987` (`CaseFile` goes, `TicketDetail.summary` arrives), `src/routes/tickets.ts:10,325-331` (drop `caseFile`), `tests/ticketRoutes.test.ts:131,264-275` (assert the summary), `web/src/routes/tickets.test.tsx:31` (the fixture), `web/src/routes/admin.test.tsx` (drop the now-unused integrity type imports)
- Delete: `src/tickets/caseFile.ts`, `web/src/routes/admin/AdminPlayers.tsx`, `web/src/routes/admin/AdminIntegrity.tsx`, `web/src/routes/admin/SteamAccountPanel.tsx`, `web/src/routes/Bans.tsx`, `web/src/routes/Bans.test.tsx`

**Interfaces:**
- Consumes: `FileSummaryData`, `playerFileSummary` (already served by Task 9).
- Produces: `FileSummary({ s }: { s: FileSummaryData })`; `TicketDetail.summary: FileSummaryData | null` replacing `TicketDetail.caseFile`; `AdminTicket({ id, onBack }: { id: number; onBack: () => void })`.

- [ ] **Step 1: Move the server assertions onto the summary**

In `tests/ticketRoutes.test.ts`, replace the case-file line in "the detail carries reports with the moment, events, the case file and the viewer cap" (rename it to "... the summary ...") with:

```ts
    expect(d.summary).toMatchObject({ steamid: ACCUSED, bans: 0, fileUrl: `/admin/people/${ACCUSED}` });
```

and replace the body of "a ban issued from a restricted ticket is withheld from a case file opened via a different ticket" after `const normalId = ...` with:

```ts
    const modBody = (await get(MOD, `/api/mod/tickets/${normalId}`)).json();
    expect(modBody.summary.bans).toBe(1);
    expect(modBody.summary.activeBan).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    expect(modBody.summary.activeBan.createdBy).toBeFalsy();
    expect(JSON.stringify(modBody.summary)).not.toContain('sensitive detail');
    expect(JSON.stringify(modBody.summary)).not.toContain(OWNER);
    // The summary carries counts rather than ticket ids, so the restricted
    // ticket cannot be inferred from it at all.
    expect(JSON.stringify(modBody.summary)).not.toContain(`"${restrictedId}"`);

    const ownerBody = (await get(OWNER, `/api/mod/tickets/${normalId}`)).json();
    expect(ownerBody.summary.activeBan).toMatchObject({ reason: 'sensitive detail', createdBy: OWNER });
```

In `web/src/routes/tickets.test.tsx`, replace the `caseFile:` line of the `detail` fixture with:

```tsx
  summary: {
    steamid: '7', name: 'Walls', avatar: null, status: 'active', isAdmin: false, isMod: false,
    sr: 1500, games: 40, createdAt: '2026-08-01', activeBan: null, bans: 0, penalties: 0,
    timeout: null, openTickets: 1, aliases: 0, sharesAddressWith: [], steamFlags: [],
    evidence: [{ source: 'lilac', count: 1 }], analyzer: null, lastReview: null,
    fileUrl: '/admin/people/7',
  },
```

and add one case to that file:

```tsx
  it('shows the accused\'s summary with a way into their file', async () => {
    renderAdmin('/admin/people/tickets/12', mod);
    await screen.findByText('saw me through a wall');
    expect(screen.getByText('About Walls')).toBeTruthy();
    expect(screen.getByText(/1 Little Anti-Cheat/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open full file' }).getAttribute('href')).toBe('/admin/people/7');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx`
Expected: FAIL, the ticket page still renders `caseFile` and the route still sends it.

- [ ] **Step 3: The summary component**

`web/src/routes/admin/file/FileSummary.tsx`:

```tsx
import type { FileSummaryData } from '../../../api';
import { fmtTime } from '../useAction';
import { SOURCE_LABEL } from './GlanceRow';

/**
 * The accused, beside a ticket.
 *
 * Rendered from the same builder as the Player File's glance row, so a new
 * evidence source appears in both places the day its adapter lands. Compact
 * on purpose: the whole record is one click away, unless this viewer may not
 * open it, in which case there is no link and the counts are what they get.
 */
export function FileSummary({ s }: { s: FileSummaryData }) {
  return (
    <section class="file-summary">
      <h4>About {s.name}</h4>
      <p class="muted">
        {s.status} · SR {s.sr ?? 'n/a'} · {s.games} games
        {s.activeBan ? ` · banned: ${s.activeBan.reason}` : ''}
        {s.timeout ? ` · queue timeout, ${s.timeout.offenses} offenses` : ''}
      </p>
      <ul class="admin-list">
        <li>
          {s.bans} ban{s.bans === 1 ? '' : 's'} on record, {s.penalties} penalt{s.penalties === 1 ? 'y' : 'ies'},
          {' '}{s.openTickets} open ticket{s.openTickets === 1 ? '' : 's'}
        </li>
        <li>
          {s.evidence.length === 0 ? 'Nothing recorded in the last 30 days.' : (
            <>
              Last 30 days: {s.evidence.map((e) => `${e.count} ${SOURCE_LABEL[e.source]}`).join(', ')}.
              {' '}Context, not a verdict.
            </>
          )}
        </li>
        {s.aliases > 0 && <li>{s.aliases} merged second account{s.aliases === 1 ? '' : 's'}</li>}
        {s.sharesAddressWith.length > 0 && (
          <li>Shares a connection with: {s.sharesAddressWith.map((o) => o.name).join(', ')}</li>
        )}
        {s.steamFlags.map((f) => <li key={f.kind} class="muted">{f.text}</li>)}
        <li class="muted">
          {s.lastReview
            ? `Looked at by ${s.lastReview.reviewedByName ?? s.lastReview.reviewedBy} ${fmtTime(s.lastReview.reviewedAt)}`
            : 'Nobody has marked this file looked at.'}
        </li>
      </ul>
      {s.fileUrl && <p><a class="chip" href={s.fileUrl}>Open full file</a></p>}
    </section>
  );
}
```

- [ ] **Step 4: The ticket page and the route**

In `web/src/routes/admin/AdminTicket.tsx`:

- change the signature to `export function AdminTicket({ id, onBack }: { id: number; onBack: () => void })`;
- change the destructure to `const { ticket: t } = data;`;
- import `FileSummary` from `./file/FileSummary`;
- replace the whole `{c && ( ... )}` block, the "About" section and the "Earlier tickets" list inside it, with:

```tsx
      {data.summary && <FileSummary s={data.summary} />}
```

Earlier tickets are not lost: they are on the file, which that section links to.

In `web/src/routes/Admin.tsx`, the ticket branch loses the prop that no longer exists:

```tsx
        {r.desk === 'people' && r.section === 'ticket' && (
          <AdminTicket id={Number(r.param)} onBack={() => route('/admin/people/tickets')} />
        )}
```

In `web/src/api.ts`, delete the `CaseFile` interface and change the field on `TicketDetail`:

```ts
  /** The accused as the Player File's glance row shows them. Null only if
   *  the player row vanished under the ticket. */
  summary: FileSummaryData | null;
```

In `src/routes/tickets.ts`, delete the `caseFile` import and the field, leaving:

```ts
    return { ...d, summary: playerFileSummary(db, d.ticket.targetId, fileViewer(db, me)) };
```

- [ ] **Step 5: Delete what nothing points at any more**

```bash
git rm src/tickets/caseFile.ts web/src/routes/admin/AdminPlayers.tsx web/src/routes/admin/AdminIntegrity.tsx web/src/routes/admin/SteamAccountPanel.tsx web/src/routes/Bans.tsx web/src/routes/Bans.test.tsx
```

`SteamAccountPanel.tsx` goes with `AdminPlayers.tsx`, which was its only caller; the same facts are on the file's Identity section. Then remove the now-unused `IntegrityClip`, `IntegrityPlayerRow` and `IntegrityRound` type imports at the top of `web/src/routes/admin.test.tsx`.

Check that nothing still points at any of them:

```bash
grep -rn "AdminPlayers\|AdminIntegrity\|SteamAccountPanel\|routes/Bans\|caseFile" src tests web/src
```
Expected: no matches.

The server routes stay: `GET /api/admin/players`, `GET /api/admin/players/:steamid`, `GET /api/admin/integrity*` and `GET /api/bans` still exist with their tests, and the Player File calls the admin-only mutations beside them.

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx web/src/routes/admin.test.tsx`
Expected: PASS.
Then: `npx vitest run`
Expected: PASS.
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/routes/tickets.ts src/tickets web/src/api.ts web/src/routes/Admin.tsx web/src/routes/admin web/src/routes/Bans.tsx web/src/routes/Bans.test.tsx tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx
git commit -m "Give the ticket page the shared summary and retire the screens it replaces"
```

---

### Task 16: Prove it in a browser, as admin and as moderator

Everything so far mocks the API on the web side and injects on the server side. Nothing has run the two together, and this step is where a 404 that should be a file, or a panel that overflows at 390 px, shows up.

**Files:** none changed unless a defect is found.

- [ ] **Step 1: The whole suite, types, and a build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS, `dist/public` produced.

- [ ] **Step 2: Run it for real against a scratch database**

```bash
DB_PATH=/tmp/claude-admin-desks/people.sqlite REPLAY_DIR=/tmp/claude-admin-desks/replays \
  DEV_MODE=1 PORT=8099 ADMIN_STEAMIDS=76561199000000001 npx tsx src/index.ts
```

Use a brand new sqlite file outside the repo, never a copy of production: a dev server over a production copy can dial rcon at the live boxes unless its `servers` rows are deleted first. Confirm `SELECT COUNT(*) FROM servers` is 0 before clicking anything.

`POST /api/dev/login` with `{ "steamid": "<17 digits>" }` creates and activates a player and sets the session cookie; it does not read `ADMIN_STEAMIDS`, so set `is_admin` and `is_mod` by hand with `sqlite3` for the owner, a second admin and a moderator, exactly as the tickets phase 1 verification did.

Seed enough to look at: one match row with a roster, a LilAC flag and an input detection under one player, a ban, a note, a penalty, and one report filed through `POST /api/reports`.

- [ ] **Step 3: Walk it as an admin**

With the admin session: `/admin` lands on `/admin/live`; the People tab reaches search; a player's name opens `/admin/people/<steamid>`; the file shows the header, the glance row, the timeline with its filter chips, Identity, Standing, the evidence detail and Notes; "Looked at this" removes the player from `/admin/people/review` and adds a review row to the timeline; `/admin/people/bans` lists the ban and its row opens the file; `/bans` redirects to it; an old `/admin?ticket=<id>` link lands on `/admin/people/tickets/<id>`; the ticket page shows "About <name>" with "Open full file".

- [ ] **Step 4: Walk it as a moderator**

With the moderator session: `/admin` lands on `/admin/people`; there are no Live or Setup tabs; the search list contains no staff; `/admin/people/<the admin's steamid>` says there is no such player; the file of an ordinary player shows every section, network rows included, with no ban form, no merge form, no sign-out and no review buttons; a note and "Looked at this" both work; `/admin/setup/settings` bounces back to `/admin/people`.

- [ ] **Step 5: Look at it, at both widths**

Frame-driven and layout bugs in this app are debugged with headless Chrome over CDP, never an in-app pane. Either point the screenshot rig at the running server (`SHOOT_BASE=http://localhost:8099 npm run shoot`, after temporarily adding the panel paths to `ROUTES` in `scripts/shoot-pages.mjs`), or copy that script to the scratch directory and drive it there, which is what the tickets phase 1 verification did because the panel needs a session cookie: log in with an in-page `fetch` to `/api/dev/login` first, then capture.

Capture at 1400 and 390 px, as admin and as moderator: `/admin/people`, `/admin/people/<steamid>`, `/admin/people/review`, `/admin/people/bans`, `/admin/people/tickets/<id>`. The rig flags horizontal overflow itself; look at every image as well. Fix any overflow in `.timeline__row`, `.file-head`, `.admin-table` or `.admin-form` before calling this done. Do not revert the screenshot rig's `ROUTES` edit in the repo unless you made one; if you did, revert it.

- [ ] **Step 6: Record what was and was not verified**

Append a short "Verification" section to this plan file saying exactly what was run and seen, and what was not: nothing on a real server, nothing through Discord, no production data. Commit:

```bash
git add docs/superpowers/plans/2026-09-21-admin-desks-1-people.md
git commit -m "Record what the People desk verification covered"
```

Do not merge to master and do not deploy. Hand back to the owner with the branch name and the verification notes.

---

## Deliberately left for the later plans

Named here so nobody reads them as oversights.

- **The live board**: presence, the clock controls, the low-allowance alert, cancel with a penalty choice and waive. Build order items 2 and 3. `/admin/live` shows today's Matches screen until then, and `FileAction` already carries `waive` so the Standing section has one name to ask about when it arrives.
- **Setup**: the regrouped sections, the Servers section, the Staff list and audit rows that link to a file. Build order item 4. `AnalysisPanel` is on Needs a look, marked as a temporary home, and moves to Setup, Servers.
- **Sorting the Needs a look columns on the server.** The list sorts in the browser over at most a screenful of rows; if it ever grows past that, the sort belongs in `needsALook`.
- **A file for a SteamID that has never signed in.** Evidence tables hold ids with no player row; `needsALook` leaves those off rather than listing a row that cannot open. Giving them a file means deciding what a file without an account looks like, which nothing needs yet.

---

## Verification

Task 16, 2026-09-21, on `worktree-admin-desks`. The server and the built web app
were run together for the first time and walked in a real browser as an admin
and as a moderator, at 1400 px and 390 px.

### How it was run

A brand new sqlite file in a scratch directory, never a copy of production, with
`DB_PATH`, `REPLAY_DIR`, `DEV_MODE=1`, `PORT=8099` and `ADMIN_STEAMIDS` set from
`src/config.ts`. `SELECT COUNT(*) FROM servers` was 0 before anything was
clicked and stayed 0: `openDb`'s `seed()` writes a season and the default
settings and no server row, so nothing on the box could dial rcon at a game
server, and `DEV_MODE=1` picks `DevOrchestrator` and starts no log listener at
all.

Seeded by hand: two completed matches with an eight-player roster, five
ready-ups with their per-player seconds, twelve measured analyzer rounds with a
map prior so the board ranks people, three analyzer clips, a persisted
`integrity_reviews` row, two LilAC flags, three input bursts with two
detections and one cap, a connect drop, a permanent ban, a lifted ban, notes,
penalties, network rows, and a pair of throwaway accounts with rows in five
tables for the merge preview. Three reports were filed through the real
`POST /api/reports` as ordinary players, which opened tickets 1 and 2. Sessions
came from `POST /api/dev/login`; `is_admin` and `is_mod` were set with sqlite3.

Screenshots were driven by headless Chrome over CDP from a copy of
`scripts/shoot-pages.mjs` in the scratch directory, extended with a dev login,
the landed URL after any client-side redirect, the rendered text and the page's
network requests. `scripts/shoot-pages.mjs` itself was not edited.

### What was seen

As an admin: `/admin` lands on `/admin/live`; `/admin?live=123` lands on
`/admin/live?live=123`; `/admin?ticket=1` lands on `/admin/people/tickets/1`;
`/bans` lands on `/admin/people/bans`. The Live desk renders its empty state
("No match is running", "No match is configuring or live") over the Open
matches, Servers, Queue, Recent results and Slow to ready panels; Recent
results shows both seeded matches with Void on screen at 1400 px without
horizontal scrolling and pinned beside Match and Score at 390 px; clicking
"Avg unready" re-sorts Slow to ready and moves the sort marker. The People desk
reaches search, a name opens the file, and a ban row opens the file. The file
shows the header and its action chips, the glance row, the timeline with its
filter chips, Identity, Standing, the evidence detail and Notes; the reviewed
analyzer round shows `dismissed` with its note; the merge form shows the
per-table row counts (`input_bursts 1`, `integrity_flags 1`, `match_players 1`,
`penalties 1`, `player_notes 1`) before "Merge and recompute"; the input flag
section shows its legend and its "not a verdict" wording; the LilAC section
shows its false-positive caveat. "Looked at this" took the player off Needs a
look and put a review row on the timeline and in the glance line. The ban list
shows "In force 1 / On record 2" on All, and Search with Clear once a search
has run. The ticket page shows the "About <name>" summary with "Open full
file", and the case file with "Earlier tickets" under it.
`/admin/people/%E0%A4%A` reached by client-side navigation, `/admin/servers`
and `/admin/people/tickets/abc` each show "No such page in the panel." and
never a blank screen.

As a moderator: `/admin` lands on `/admin/people`; there are no Live or Setup
desk tabs and the header reads "Moderation"; the search list holds no staff;
`/admin/live` and `/admin/setup/settings` both bounce to `/admin/people`; the
admin's file and the moderator's own file are "No such player, or not a file
you can open" and the API answers 404 for both, never 403. The file of an
ordinary player shows every section, network rows and the shared-connection
caveat included, with no ban form, no merge form, no sign-out, no staff-flag
buttons and no round review buttons; a note and "Looked at this" both worked.
Needs a look has no analysis panel and made no request to
`/api/admin/integrity/backfill` at either width, watched on the wire and in the
server log.

At 390 px no page body scrolls sideways on either walk. The only elements past
the viewport are `.admin-table`s inside their own `.table-wrap`, measured
rather than eyeballed. Every screenshot was looked at.

### Two defects found and fixed

- `web/src/styles/app.css` had an unclosed `@media (max-width: 480px)` block at
  line 1638, left by the commit that removed the orphaned admin CSS. `npm run
  build` failed outright, and in a browser every rule after that line was
  swallowed into the media query, so the whole live board, every admin table
  and every admin form were unstyled at desktop width. 3486 unit tests stayed
  green because nothing in the suite parses CSS. Fixed, with a test that reads
  the stylesheet and asserts every block it opens is closed.
- The ticket page headed the accused twice: `FileSummary` was added above a
  case-file section that already opened with the same "About <name>" heading
  and the same status line, so the page read as two blocks disagreeing with
  each other. The case file now heads itself "Case file" when there is a
  summary, and keeps its full heading when there is not, which is what a
  moderator on a restricted ticket about a colleague gets.

### What was NOT verified

- **Nothing on a real game server.** No server row existed, no rcon was dialled,
  no srcds was contacted, and `DEV_MODE=1` means no orchestrator that could.
- **Nothing through Discord.** No bot token was configured, so the admin feed,
  the ticket forum mirror and every card are untouched by this.
- **No production data.** A brand new sqlite file with hand-seeded rows only.
- The live board's own behaviour with a match actually running: presence, the
  clock controls, the low-allowance alert and Abort were seen only in their
  empty state, because nothing here can start a match on a server.
- A cold browser load of a URL holding a malformed percent escape, such as
  `/admin/people/%E0%A4%A` typed into the address bar, never reaches the panel:
  fastify's own URL parser answers 400 `FST_ERR_BAD_URL` before the SPA is
  served. That is site-wide and predates this plan (`/`, `/player/...` and
  `/match/...` all do it), and it is a JSON error page rather than a blank
  screen. `parseAdminPath`'s `decode` guard covers the navigation the router
  can actually see, which was checked.
