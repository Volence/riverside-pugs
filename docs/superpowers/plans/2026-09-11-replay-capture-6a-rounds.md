# Round-Aware Capture (6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist which pug team played survivor in each round of each map, and stamp every live event with the round and the millisecond it happened, so that stats and events can be attributed to a side and a moment.

**Architecture:** `pug-match.sp` already knows everything needed. `OnRoundIsLive` marks a half going live, `Event_RoundEnd` closes it, `g_iPugSide[]` holds the pug-team to game-team mapping. None of it is persisted. Two new UDP log lines (`ROUND_START`, `ROUND_END`) feed a new `match_rounds` table, and the existing `EVENT` line gains `half` and `t` fields. Per-round stat attribution is then derived, not stored, because `statKeys.ts` already partitions every stat key by side.

**Tech Stack:** SourcePawn 1.12 (spcomp under wine), TypeScript, Fastify, better-sqlite3, Preact, vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-replay-capture-design.md`

**Sibling plans:** 6b (replay recording and live streaming) and 6c (admin storage panel) follow. This plan ships on its own.

## Global Constraints

- **No em dashes** anywhere: code, comments, docs, commit messages.
- **A capture failure must never affect a ranked result.** Nothing added here may throw into the match result or rating path. Follow the never-throws discipline of `src/demos.ts`.
- **Counters stay authoritative for totals; events carry timing only.** Never derive a total by counting rows in `match_live_events`. That feed rides lossy UDP.
- **Never restart the live server to deploy the plugin.** `plugin/stage.sh` copies one file and reloads.
- Plugin builds via `plugin/build.sh`, which copies sources into the Rotoblin scripting dir and compiles relative, because absolute unix paths break `spcomp` under wine. Any new source file must be copied and cleaned up the same way.
- There is deliberately **no migration framework**. New columns go through the `ensureColumn` helper in `src/db.ts`; new tables go in the `SCHEMA` string.
- UDP is lossy, unordered, and can duplicate. Every write triggered by a datagram must be an idempotent upsert.
- `TEAM_SURVIVOR` is game team 2. `g_iPugSide[1]` is the game team of pug team a, `g_iPugSide[2]` of pug team b. `0` means unknown.
- Run tests with `npm test`. Typecheck with `npm run typecheck`.

---

### Task 1: Event kind registry

The single source of truth for live event kinds. This exists for the same reason `src/statKeys.ts` exists: a typo'd kind is not an error, it is a feed that is silently missing a category forever. Today the only labeled kind is `dp`, hardcoded in `web/src/components/StatTable.tsx`.

**Files:**
- Create: `src/eventKinds.ts`
- Test: `tests/eventKinds.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `EventSide`, `EventKindDef`, `EVENT_KINDS`, `eventKindDef(kind: string): EventKindDef | undefined`, `isKnownEventKind(kind: string): boolean`, `eventKindKeys(): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/eventKinds.test.ts
import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, eventKindDef, isKnownEventKind, eventKindKeys } from '../src/eventKinds.js';

describe('event kind registry', () => {
  it('has unique kinds', () => {
    const keys = EVENT_KINDS.map((d) => d.kind);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the same slug shape the plugin regex accepts', () => {
    // src/logParse.ts validates kind against /^[a-z_]{1,24}$/. A kind that
    // fails this is dropped on the wire and would never reach the database.
    for (const d of EVENT_KINDS) expect(d.kind).toMatch(/^[a-z_]{1,24}$/);
  });

  it('keeps the legacy dp kind, which is already in production data', () => {
    expect(isKnownEventKind('dp')).toBe(true);
  });

  it('gives every kind a verb for the feed', () => {
    for (const d of EVENT_KINDS) expect(d.verb.length).toBeGreaterThan(0);
  });

  it('resolves a known kind and rejects an unknown one', () => {
    expect(eventKindDef('pinned')?.side).toBe('infected');
    expect(eventKindDef('cleared')?.side).toBe('survivor');
    expect(eventKindDef('not_a_kind')).toBeUndefined();
    expect(isKnownEventKind('not_a_kind')).toBe(false);
  });

  it('lists every kind', () => {
    expect(eventKindKeys()).toHaveLength(EVENT_KINDS.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/eventKinds.test.ts`
Expected: FAIL, cannot resolve `../src/eventKinds.js`

- [ ] **Step 3: Write the registry**

```ts
// src/eventKinds.ts
/** Single source of truth for live event kinds.
 *
 *  Same hazard as src/statKeys.ts, same mitigation. `match_live_events.kind`
 *  is free text, so the plugin emitting `witch_agro` while the web looks for
 *  `witch_aggro` is not a DB error, it is a timeline that is quietly missing
 *  every witch forever. The plugin, the parser and the UI all resolve kinds
 *  through here, and tests/eventKindsParity.test.ts holds the plugin to it.
 *
 *  Events carry TIMING, never TOTALS. The feed rides lossy UDP, so counting
 *  rows here would disagree with match_player_stats and create a second,
 *  wrong source of truth for "how many skeets". */

/** Which side the ACTOR was on when this happened. */
export type EventSide = 'survivor' | 'infected';

export interface EventKindDef {
  kind: string;
  side: EventSide;
  /** Feed verb: "<actor> <verb> <target>". */
  verb: string;
  /** Unit word before a non-zero value, e.g. "for 22". */
  unit?: string;
  /** True when this kind has a target player. */
  hasTarget: boolean;
}

const def = (
  kind: string, side: EventSide, verb: string,
  hasTarget: boolean, unit?: string,
): EventKindDef => ({ kind, side, verb, hasTarget, unit });

export const EVENT_KINDS: readonly EventKindDef[] = [
  // The pin cycle. `pinned` and `cleared` are the pair that makes clear
  // latency computable, which is the single most actionable number the
  // analytics produce and which no counter can express.
  def('pinned', 'infected', 'pinned', true),
  def('cleared', 'survivor', 'cleared', true),

  // Round shape.
  def('incap', 'survivor', 'was incapped by', true),
  def('death', 'survivor', 'was killed by', true),
  def('revive', 'survivor', 'revived', true),

  // Friendly fire carries damage as its value.
  def('ff', 'survivor', 'shot', true, 'for'),

  // Infected pressure.
  def('si_spawn', 'infected', 'spawned as', false),
  def('dp', 'infected', 'pounced', true, 'for'),
  def('boom', 'infected', 'boomed', true),

  // Tank. Control passes in this ruleset, so tank_pass has a target.
  def('tank_spawn', 'infected', 'became the tank', false),
  def('tank_pass', 'infected', 'passed the tank to', true),
  def('tank_death', 'survivor', 'killed the tank', false),

  // Survivor answers.
  def('skeet', 'survivor', 'skeeted', true),

  // Map hazards. Both are blame stats: who woke her up, who set it off.
  def('witch_aggro', 'survivor', 'startled the witch', false),
  def('witch_killed', 'survivor', 'killed the witch', false),
  def('car_alarm', 'survivor', 'set off a car alarm', false),
];

const BY_KIND = new Map(EVENT_KINDS.map((d) => [d.kind, d]));

export function eventKindDef(kind: string): EventKindDef | undefined {
  return BY_KIND.get(kind);
}

export function isKnownEventKind(kind: string): boolean {
  return BY_KIND.has(kind);
}

export function eventKindKeys(): string[] {
  return EVENT_KINDS.map((d) => d.kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/eventKinds.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/eventKinds.ts tests/eventKinds.test.ts
git commit -m "feat(stats): add shared event kind registry"
```

---

### Task 2: Schema for rounds and event timing

`match_rounds` is new. `match_live_events` gains `half` and `t_ms`. Both columns get a sentinel default rather than NULL, because `ensureColumn` runs `ALTER TABLE ADD COLUMN` on a populated table and SQLite requires a non-null default there. `-1` means "recorded before this existed", which must stay distinguishable from `0`, a real first-millisecond event.

**Files:**
- Modify: `src/db.ts` (SCHEMA string, and the `ensureColumn` block in `openDb`)
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `openDb` from `src/db.ts`
- Produces: tables `match_rounds(match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at)`; columns `match_live_events.half` and `match_live_events.t_ms`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('round schema', () => {
  it('creates match_rounds with a composite key on match, map and half', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(match_rounds)').all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['match_id', 'ordinal', 'half', 'surv_team', 'score', 'reliable', 'started_at', 'ended_at']),
    );
  });

  it('rejects a survivor team that is not a or b', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run();
    expect(() => db.prepare(
      "INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'c')",
    ).run()).toThrow();
  });

  it('adds half and t_ms to match_live_events, defaulting to the -1 sentinel', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(match_live_events)').all() as
      { name: string; dflt_value: string | null }[];
    const half = cols.find((c) => c.name === 'half');
    const tms = cols.find((c) => c.name === 't_ms');
    expect(half?.dflt_value).toBe('-1');
    expect(tms?.dflt_value).toBe('-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL, `match_rounds` has no columns and `half` is undefined

- [ ] **Step 3: Add the table and the columns**

In `src/db.ts`, inside the `SCHEMA` template string, immediately after the `match_maps` table:

```sql
-- Which pug team played survivor in each round, and what they scored.
--
-- Written from the UDP feed, unlike match_maps which is written once at
-- completion from the rcon dump. That is acceptable here because nothing in
-- the rating path reads this table: it exists so stats and events can be
-- attributed to a side and a moment, which is presentation, not scoring.
--
-- `reliable` goes to 0 when the round was restarted after stats accrued, or a
-- rostered player changed team mid-match. Consumers must show an unreliable
-- round as unavailable rather than guessing, the same way absent stats are
-- never rendered as fabricated zeros.
CREATE TABLE IF NOT EXISTS match_rounds (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  ordinal    INTEGER NOT NULL,
  half       INTEGER NOT NULL,
  surv_team  TEXT    NOT NULL CHECK (surv_team IN ('a','b')),
  score      INTEGER NOT NULL DEFAULT 0,
  reliable   INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  ended_at   TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);
```

In `openDb`, beside the existing `map_ordinal` call:

```ts
  // -1, not 0 or NULL: ALTER TABLE ADD COLUMN on a populated table needs a
  // non-null default, and 0 is a real value here (an event in the first
  // millisecond of a round). -1 means "recorded before round timing existed".
  ensureColumn(db, 'match_live_events', 'half', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'match_live_events', 't_ms', 'INTEGER NOT NULL DEFAULT -1');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(db): add match_rounds and round timing columns on live events"
```

---

### Task 3: Parse the round log lines

Two new verbs on the existing UDP feed, plus `half` and `t` on the existing `EVENT` line. `parseLogDatagram` must never throw and must return `null` for anything malformed, because a bad datagram is a normal condition on this transport.

**Files:**
- Modify: `src/logParse.ts` (the `LogEvent` union, and the `switch (verb)` block)
- Test: `tests/logParse.test.ts`

**Interfaces:**
- Consumes: `parseLogDatagram` from `src/logParse.ts`
- Produces: `LogEvent` variants `{ kind: 'round_start'; token; map; half; surv }` and `{ kind: 'round_end'; token; half; surv; score }`; `live_event` gains `half: number` and `tMs: number`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/logParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = 'a'.repeat(32);
const dg = (body: string) => Buffer.from(`PUG ${TOKEN} ${body}`);

describe('round lines', () => {
  it('parses ROUND_START', () => {
    expect(parseLogDatagram(dg('ROUND_START map=l4d_hospital01_apartment half=1 surv=a'))).toEqual({
      kind: 'round_start', token: TOKEN, map: 'l4d_hospital01_apartment', half: 1, surv: 'a',
    });
  });

  it('parses ROUND_END', () => {
    expect(parseLogDatagram(dg('ROUND_END half=2 surv=b score=412'))).toEqual({
      kind: 'round_end', token: TOKEN, half: 2, surv: 'b', score: 412,
    });
  });

  it('rejects a survivor team that is not a or b', () => {
    expect(parseLogDatagram(dg('ROUND_START map=m half=1 surv=c'))).toBeNull();
  });

  it('rejects a half that is not 1 or 2', () => {
    expect(parseLogDatagram(dg('ROUND_START map=m half=3 surv=a'))).toBeNull();
    expect(parseLogDatagram(dg('ROUND_END half=0 surv=a score=1'))).toBeNull();
  });

  it('carries half and t_ms on an EVENT line', () => {
    const ev = parseLogDatagram(dg('EVENT seq=7 kind=pinned actor=STEAM_1 target=STEAM_2 value=0 half=1 t=4320'));
    expect(ev).toMatchObject({ kind: 'live_event', event: 'pinned', half: 1, tMs: 4320 });
  });

  it('defaults half and t_ms to -1 on an EVENT line from an older plugin', () => {
    const ev = parseLogDatagram(dg('EVENT seq=7 kind=dp actor=STEAM_1 target=STEAM_2 value=22'));
    expect(ev).toMatchObject({ kind: 'live_event', half: -1, tMs: -1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logParse.test.ts`
Expected: FAIL, `ROUND_START` returns null and `live_event` has no `half`

- [ ] **Step 3: Extend the union and the switch**

In `src/logParse.ts`, add to the `LogEvent` union:

```ts
  // One half of one map. Emitted at OnRoundIsLive and again at round_end.
  // The END value of `surv` is authoritative: the plugin's orientation
  // mapping is unreliable early in a round, which is exactly why that
  // reconciliation logic exists at all.
  | { kind: 'round_start'; token: string; map: string; half: number; surv: 'a' | 'b' }
  | { kind: 'round_end'; token: string; half: number; surv: 'a' | 'b'; score: number }
```

Change the `live_event` variant to add the two fields:

```ts
  | {
      kind: 'live_event'; token: string; seq: number; event: string;
      actor: string; target: string | null; value: number;
      // -1 when the plugin predates round timing. Distinct from 0, which is
      // a real event in the first millisecond of a round.
      half: number; tMs: number;
    };
```

Add a shared validator above `parseLogDatagram`:

```ts
function teamOf(s: string | undefined): 'a' | 'b' | null {
  return s === 'a' || s === 'b' ? s : null;
}

function halfOf(s: string | undefined): number | null {
  const n = intOf(s);
  return n === 1 || n === 2 ? n : null;
}
```

Add two cases to the `switch (verb)` block:

```ts
    case 'ROUND_START': {
      const rest = kv(parts.slice(3));
      const half = halfOf(rest.half);
      const surv = teamOf(rest.surv);
      if (!rest.map || half === null || surv === null) return null;
      return { kind: 'round_start', token, map: rest.map, half, surv };
    }
    case 'ROUND_END': {
      const rest = kv(parts.slice(3));
      const half = halfOf(rest.half);
      const surv = teamOf(rest.surv);
      const score = intOf(rest.score);
      if (half === null || surv === null || score === null) return null;
      return { kind: 'round_end', token, half, surv, score };
    }
```

In the existing `case 'EVENT':` block, before the `return`, read the two optional fields and default them:

```ts
      // Optional so a staged older plugin still produces usable events.
      const half = halfOf(rest.half) ?? -1;
      const tMs = intOf(rest.t) ?? -1;
```

and add `half, tMs` to the returned object.

- [ ] **Step 3b: Repair the existing fixtures the new required fields break**

Making `half` and `tMs` required on the `live_event` variant breaks every object literal of that shape. Five call sites need the two fields added as `half: -1, tMs: -1`:

- `tests/logParse.test.ts:206` is a full `toEqual`, so the fields must be added to the expected object or it fails on extra properties.
- `tests/liveView.test.ts` lines 130, 251, 353 and 451 are literals passed to `recordLiveEvent`, which will not typecheck without them.

Use `-1`, not `0`. Zero is a real event in the first millisecond of a round; these fixtures represent events with no round timing at all.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/logParse.test.ts tests/liveView.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean. If typecheck still reports a `live_event` literal missing properties, a fixture exists that Step 3b did not list; add the two fields there too.

- [ ] **Step 5: Commit**

```bash
git add src/logParse.ts tests/logParse.test.ts
git commit -m "feat(stats): parse ROUND_START, ROUND_END and event round timing"
```

---

### Task 4: Persist rounds

Upserts, because UDP duplicates. `ROUND_START` creates the row; `ROUND_END` fills in the score, the end time, and the authoritative side. A start/end side disagreement is logged and the end value wins.

**Files:**
- Modify: `src/liveView.ts`
- Modify: `src/server.ts:146` area (the `ev.kind` dispatch chain)
- Test: `tests/liveView.test.ts`

**Interfaces:**
- Consumes: `liveMatchIdOf`, `touch` (both already private to `src/liveView.ts`); `LogEvent` from `src/logParse.ts`
- Produces: `recordRoundStart(db: DB, token: string, ev: Extract<LogEvent, { kind: 'round_start' }>): void`, `recordRoundEnd(db: DB, token: string, ev: Extract<LogEvent, { kind: 'round_end' }>): void`, `roundsFor(db: DB, matchId: number): RoundRow[]`, `interface RoundRow { ordinal: number; half: number; survTeam: 'a' | 'b'; score: number; reliable: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/liveView.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRoundStart, recordRoundEnd, roundsFor } from '../src/liveView.js';

const TOKEN = 'b'.repeat(32);

function liveMatch() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)").run(TOKEN);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
  return db;
}

describe('round persistence', () => {
  it('records a round and closes it with the score', () => {
    const db = liveMatch();
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, TOKEN, { kind: 'round_end', token: TOKEN, half: 1, surv: 'a', score: 300 });
    expect(roundsFor(db, 1)).toEqual([
      { ordinal: 0, half: 1, survTeam: 'a', score: 300, reliable: true },
    ]);
  });

  it('is idempotent across a duplicated datagram', () => {
    const db = liveMatch();
    const ev = { kind: 'round_start', token: TOKEN, map: 'm', half: 1, surv: 'a' } as const;
    recordRoundStart(db, TOKEN, ev);
    recordRoundStart(db, TOKEN, ev);
    expect(roundsFor(db, 1)).toHaveLength(1);
  });

  it('trusts the round-end side when start and end disagree', () => {
    const db = liveMatch();
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, TOKEN, { kind: 'round_end', token: TOKEN, half: 1, surv: 'b', score: 120 });
    expect(roundsFor(db, 1)[0].survTeam).toBe('b');
  });

  it('stamps the ordinal from how many maps have finished', () => {
    const db = liveMatch();
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (1, 'm0', 0, 1, 2)").run();
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, map: 'm1', half: 1, surv: 'a' });
    expect(roundsFor(db, 1)[0].ordinal).toBe(1);
  });

  it('ignores a round for an unknown token rather than throwing', () => {
    const db = liveMatch();
    expect(() => recordRoundStart(db, 'c'.repeat(32), {
      kind: 'round_start', token: 'c'.repeat(32), map: 'm', half: 1, surv: 'a',
    })).not.toThrow();
    expect(roundsFor(db, 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/liveView.test.ts`
Expected: FAIL, `recordRoundStart` is not exported

- [ ] **Step 3: Implement**

Add to `src/liveView.ts`, next to `recordLiveEvent`:

```ts
export interface RoundRow {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  score: number;
  reliable: boolean;
}

/** Which map this round belongs to: however many have already finished.
 *  Same derivation recordLiveEvent uses for map_ordinal, and for the same
 *  reason: nothing on the wire carries it. */
function currentOrdinal(db: DB, matchId: number): number {
  const done = db
    .prepare('SELECT COUNT(*) AS n FROM match_live_maps WHERE match_id = ?')
    .get(matchId) as { n: number };
  return done.n;
}

export function recordRoundStart(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'round_start' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (match_id, ordinal, half) DO NOTHING`,
    // DO NOTHING, not an update: a duplicated ROUND_START must not reset the
    // started_at that t_ms values are already measured against.
  ).run(id, currentOrdinal(db, id), ev.half, ev.surv);
  touch(db, id);
}

export function recordRoundEnd(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'round_end' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  const ordinal = currentOrdinal(db, id);
  const existing = db.prepare(
    'SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?',
  ).get(id, ordinal, ev.half) as { surv_team: string } | undefined;
  if (existing && existing.surv_team !== ev.surv) {
    // Not an error. The orientation mapping is provisional early in a round,
    // which is why pug-match reconciles it at all. Logged so a systematic
    // disagreement is visible rather than silently absorbed.
    console.warn(
      `[rounds] match ${id} map ${ordinal} half ${ev.half}: side moved ${existing.surv_team} -> ${ev.surv}`,
    );
  }
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (match_id, ordinal, half) DO UPDATE SET
       surv_team = excluded.surv_team,
       score = excluded.score,
       ended_at = excluded.ended_at`,
  ).run(id, ordinal, ev.half, ev.surv, ev.score);
  touch(db, id);
}

export function roundsFor(db: DB, matchId: number): RoundRow[] {
  return (db.prepare(
    `SELECT ordinal, half, surv_team, score, reliable FROM match_rounds
     WHERE match_id = ? ORDER BY ordinal, half`,
  ).all(matchId) as { ordinal: number; half: number; surv_team: 'a' | 'b'; score: number; reliable: number }[])
    .map((r) => ({
      ordinal: r.ordinal, half: r.half, survTeam: r.surv_team,
      score: r.score, reliable: r.reliable === 1,
    }));
}
```

Extend `recordLiveEvent` to persist the new columns. Change its INSERT to:

```ts
    `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, seq) DO UPDATE SET
       kind = excluded.kind, actor = excluded.actor,
       target = excluded.target, value = excluded.value`,
```

and its `.run(...)` to `.run(id, ev.seq, ev.event, ev.actor, ev.target, ev.value, done.n, ev.half, ev.tMs)`.

In `src/server.ts`, add to the dispatch chain beside `else if (ev.kind === 'live_event')`:

```ts
          else if (ev.kind === 'round_start') recordRoundStart(deps.db, ev.token, ev);
          else if (ev.kind === 'round_end') recordRoundEnd(deps.db, ev.token, ev);
```

and add `recordRoundStart, recordRoundEnd` to the existing import from `./liveView.js` on line 18.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/liveView.test.ts && npm run typecheck`
Expected: PASS, 5 new tests

- [ ] **Step 5: Commit**

```bash
git add src/liveView.ts src/server.ts tests/liveView.test.ts
git commit -m "feat(stats): persist match rounds and event round timing"
```

---

### Task 5: Per-round side attribution

**This task validates the load-bearing claim of the spec.** The design asserts that per-round stat snapshots are unnecessary, because every key in `statKeys.ts` declares a side and survivor stats can only accrue while a player is survivor. Given `match_rounds.surv_team`, the existing per-map snapshots therefore already yield per-round attribution. If this test cannot be made to pass, that claim is wrong and a per-round snapshot table is required after all. Do not paper over a failure here; stop and report it.

**Files:**
- Create: `src/roundStats.ts`
- Test: `tests/roundStats.test.ts`

**Interfaces:**
- Consumes: `roundsFor` from `src/liveView.ts`, `mapStatsFor` from `src/liveView.ts`, `statDef` from `src/statKeys.ts`
- Produces: `interface RoundAttribution { ordinal: number; half: number; survTeam: 'a' | 'b'; reliable: boolean; byPlayer: Record<string, Record<string, number>> }`, `roundAttribution(db: DB, matchId: number, teamOf: Map<string, 'a' | 'b'>): RoundAttribution[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/roundStats.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { roundAttribution } from '../src/roundStats.js';

const P_A = 'STEAM_0:0:1';
const P_B = 'STEAM_0:0:2';

/** One map, two halves. Team a is survivor in half 1, team b in half 2. */
function matchWithOneMap() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (1, 0, 1, 'a', 300)").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (1, 0, 2, 'b', 250)").run();
  // Cumulative end-of-map snapshot, exactly as the live pipeline writes it.
  // The player on team a has both a survivor stat and an infected stat from
  // the same map, because they played both sides on it.
  const ins = db.prepare(
    'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (1, 0, ?, ?)',
  );
  ins.run(P_A, JSON.stringify({ skeets: 3, damage_as_si: 500 }));
  ins.run(P_B, JSON.stringify({ skeets: 1, damage_as_si: 800 }));
  return db;
}

const TEAMS = new Map<string, 'a' | 'b'>([[P_A, 'a'], [P_B, 'b']]);

describe('per-round side attribution', () => {
  it('puts a survivor stat only in the round its owner held survivor', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    // Team a were survivors in half 1, so their skeets belong there.
    expect(h1.byPlayer[P_A]).toEqual({ skeets: 3 });
    // And their SI damage belongs to half 2, when they were infected.
    expect(h2.byPlayer[P_A]).toEqual({ damage_as_si: 500 });
  });

  it('attributes the opposing team the other way round', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    expect(h1.byPlayer[P_B]).toEqual({ damage_as_si: 800 });
    expect(h2.byPlayer[P_B]).toEqual({ skeets: 1 });
  });

  it('drops an unknown stat key rather than guessing its side', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_live_map_stats SET stats_json = ? WHERE player_id = ?')
      .run(JSON.stringify({ skeets: 3, not_a_stat: 9 }), P_A);
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.byPlayer[P_A]).toEqual({ skeets: 3 });
  });

  it('reports an unreliable round so callers can refuse to show it', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE half = 1').run();
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.reliable).toBe(false);
  });

  it('returns nothing for a match with no rounds recorded', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
    expect(roundAttribution(db, 1, TEAMS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/roundStats.test.ts`
Expected: FAIL, cannot resolve `../src/roundStats.js`

- [ ] **Step 3: Implement**

```ts
// src/roundStats.ts
import type { DB } from './db.js';
import { roundsFor, mapStatsFor } from './liveView.js';
import { statDef } from './statKeys.js';

/**
 * Per-round stats, DERIVED rather than stored.
 *
 * The spec's load-bearing simplification. Every key in statKeys.ts declares a
 * side, and a survivor stat can only accrue while its owner is survivor. So
 * knowing which pug team held survivor in a round (match_rounds) is enough to
 * split an existing per-MAP snapshot into its two rounds: a player's
 * survivor-side keys belong to whichever half their team held survivor, and
 * their infected-side keys to the other.
 *
 * This is why there is no per-round snapshot table. tests/roundStats.test.ts
 * is what holds the claim up; if it fails, the claim is wrong.
 *
 * Unknown keys are dropped rather than assigned a side. An unrecognised key
 * has no side to reason about, and silently filing it under the wrong round
 * would be worse than omitting it.
 */
export interface RoundAttribution {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  reliable: boolean;
  byPlayer: Record<string, Record<string, number>>;
}

export function roundAttribution(
  db: DB, matchId: number, teamOf: Map<string, 'a' | 'b'>,
): RoundAttribution[] {
  const rounds = roundsFor(db, matchId);
  if (rounds.length === 0) return [];
  const byMap = mapStatsFor(db, matchId);

  return rounds.map((r) => {
    const mapStats = byMap.get(r.ordinal) ?? {};
    const byPlayer: Record<string, Record<string, number>> = {};
    for (const [steamid, stats] of Object.entries(mapStats)) {
      const team = teamOf.get(steamid);
      if (!team) continue;
      const side = team === r.survTeam ? 'survivor' : 'infected';
      const kept: Record<string, number> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (statDef(key)?.side === side) kept[key] = value;
      }
      byPlayer[steamid] = kept;
    }
    return {
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam,
      reliable: r.reliable, byPlayer,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/roundStats.test.ts && npm run typecheck`
Expected: PASS, 5 tests. **If the first two fail, stop and report: the spec's "no new stat snapshot table" decision is wrong.**

- [ ] **Step 5: Commit**

```bash
git add src/roundStats.ts tests/roundStats.test.ts
git commit -m "feat(stats): derive per-round side attribution from map snapshots"
```

---

### Task 6: Expose rounds on the match API

The match endpoint gains a `rounds` array. No UI consumes it yet; 6a ships the data and plan 6b's pages read it. Adding it now means the shape is settled and tested before anything depends on it.

**Files:**
- Modify: `src/routes/stats.ts` (the `app.get('/api/matches/:id')` handler, around line 226)
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `roundAttribution` from `src/roundStats.ts`, `roundsFor` from `src/liveView.ts`
- Produces: `GET /api/matches/:id` response gains `rounds: { ordinal, half, survTeam, score, reliable, byPlayer }[]`

- [ ] **Step 1: Write the failing test**

```ts
// Add INSIDE the existing `describe('stats routes', ...)` block in
// tests/stats.test.ts, so it reuses that block's db/app/beforeEach and the
// local playCompletedMatch() fixture. Do not create a new describe with its
// own server: buildServer is already wired there.

  it('returns rounds with side attribution', async () => {
    const matchId = playCompletedMatch(db, 'a');
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 1, 'a', 300)").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 2, 'b', 250)").run(matchId);
    // Cumulative end-of-map snapshot, as the live pipeline writes it. IDS[0]
    // is on team a, IDS[4] on team b (playCompletedMatch splits at index 4).
    const ins = db.prepare(
      'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (?, 0, ?, ?)',
    );
    ins.run(matchId, IDS[0], JSON.stringify({ skeets: 3, damage_as_si: 500 }));

    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rounds).toHaveLength(2);
    expect(body.rounds[0]).toMatchObject({ ordinal: 0, half: 1, survTeam: 'a', score: 300, reliable: true });
    // Team a held survivor in half 1, so their skeets belong there and their
    // SI damage does not.
    expect(body.rounds[0].byPlayer[IDS[0]]).toEqual({ skeets: 3 });
    expect(body.rounds[1].byPlayer[IDS[0]]).toEqual({ damage_as_si: 500 });
  });

  it('returns an empty rounds array for a match recorded before rounds existed', async () => {
    const matchId = playCompletedMatch(db, 'b');
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(body.rounds).toEqual([]);
  });
```


- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stats.test.ts`
Expected: FAIL, `body.rounds` is undefined

- [ ] **Step 3: Implement**

In `src/routes/stats.ts`, inside the `/api/matches/:id` handler, after `players` is built and before the response is returned:

```ts
    // Per-round side attribution. Derived, not stored: see src/roundStats.ts.
    // teamOf comes from match_players, which is the authoritative roster
    // written at completion, rather than from anything on the live feed.
    const teamOf = new Map(players.map((p) => [p.steamid, p.team as 'a' | 'b']));
    const rounds = roundAttribution(db, id, teamOf);
```

Add `rounds` to the returned object, and add the import at the top of the file:

```ts
import { roundAttribution } from '../roundStats.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/stats.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.ts tests/stats.test.ts
git commit -m "feat(stats): expose per-round side attribution on the match endpoint"
```

---

### Task 7: Plugin emits rounds and event timing

The plugin already knows all of this. It just never said so. Three additions: a half counter, a round start time, and the side derivation.

**Files:**
- Modify: `plugin/pug-match.sp`
- Test: `tests/eventKindsParity.test.ts` (create)

**Interfaces:**
- Consumes: `EVENT_KINDS` from `src/eventKinds.ts`
- Produces: log lines `PUG <token> ROUND_START map=<map> half=<1|2> surv=<a|b>` and `PUG <token> ROUND_END half=<1|2> surv=<a|b> score=<n>`; the existing `EVENT` line gains ` half=<n> t=<ms>`

- [ ] **Step 1: Write the failing parity test**

```ts
// tests/eventKindsParity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eventKindKeys } from '../src/eventKinds.js';

/** Parity backstop between plugin/pug-match.sp and src/eventKinds.ts.
 *
 *  Same hazard as tests/statKeysParity.test.ts. A kind the plugin emits that
 *  the registry does not know is an event the UI cannot label; a kind in the
 *  registry that the plugin never emits is a promise the feed does not keep.
 *  The first is a real bug and is asserted here. The second is allowed,
 *  because a kind may legitimately land ahead of its hook.
 *
 *  Parsing is deliberately simple regex-over-text. If the plugin's shape
 *  changes enough that the regex stops matching, the explicit non-zero
 *  assertion turns that into a loud failure rather than a vacuous pass. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');

/** Every literal passed as `kind` to the plugin's event emitters.
 *
 *  Matches EmitEvent AND EmitClientEvent. Note that "EmitClientEvent(" does
 *  not contain the substring "EmitEvent(", so a regex anchored on the bare
 *  name silently matches nothing in the client-resolved handlers. */
function emittedKinds(src: string): string[] {
  const calls = src.match(/Emit(?:Client)?Event\s*\(\s*"([a-z_]{1,24})"/g) ?? [];
  return [...new Set(calls.map((c) => c.replace(/.*"([a-z_]+)".*/, '$1')))];
}

describe('event kind parity', () => {
  it('finds event emissions in the plugin', () => {
    expect(emittedKinds(pluginSrc).length).toBeGreaterThan(0);
  });

  it('emits no kind the registry does not know', () => {
    const known = new Set(eventKindKeys());
    const unknown = emittedKinds(pluginSrc).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/eventKindsParity.test.ts`
Expected: FAIL on the first assertion, because `EmitEvent` does not exist yet in the plugin (the current emitter is an inline `EmitPug("EVENT ...")` at `plugin/pug-match.sp:236`).

- [ ] **Step 3: Add the plugin state, the emitter, and the round lines**

In `plugin/pug-match.sp`, beside `g_iRound1Logical` near line 79, add:

```sourcepawn
int   g_iHalf;              // 1 or 2 within the current map; 0 = not live
float g_fRoundLiveAt;       // GetGameTime() when this half went live; 0 = not live
```

Add the side derivation and the round-relative clock as helpers:

```sourcepawn
/** Which pug team is on the survivor side right now, as "a"/"b", or "" when
 *  the orientation mapping has not settled. g_iPugSide[1] is the GAME team of
 *  pug team a; TEAM_SURVIVOR is 2. */
void SurvPugTeam(char[] out, int maxlen)
{
	if (g_iPugSide[1] == TEAM_SURVIVOR) strcopy(out, maxlen, "a");
	else if (g_iPugSide[2] == TEAM_SURVIVOR) strcopy(out, maxlen, "b");
	else out[0] = '\0';
}

/** Milliseconds since this half went live. -1 before it does, which the
 *  parser treats as "no round timing", distinct from 0. */
int RoundMs()
{
	if (g_fRoundLiveAt <= 0.0) return -1;
	return RoundToNearest((GetGameTime() - g_fRoundLiveAt) * 1000.0);
}
```

Replace the inline emission at line 236 with a named emitter, so the parity test has something to match and every kind goes through one place:

```sourcepawn
/** One discrete thing that happened, for the live feed and the timeline.
 *
 *  `kind` MUST exist in src/eventKinds.ts. tests/eventKindsParity.test.ts
 *  enforces that. Timing rides along so the viewer can align events against
 *  replay frames without a clock. */
void EmitEvent(const char[] kind, const char[] actor, const char[] target, int value)
{
	g_iEventSeq++;
	EmitPug("EVENT seq=%d kind=%s actor=%s target=%s value=%d half=%d t=%d",
		g_iEventSeq, kind, actor, target, value, g_iHalf, RoundMs());
}
```

Update the existing `dp` emission site to call `EmitEvent("dp", ...)` instead of formatting the line itself.

In `OnRoundIsLive()`, after the existing body:

```sourcepawn
	g_iHalf++;
	g_fRoundLiveAt = GetGameTime();
	char surv[2];
	SurvPugTeam(surv, sizeof(surv));
	// An empty side means the orientation mapping has not settled. Emit
	// anyway with the best guess of "a": the backend trusts ROUND_END, and a
	// missing ROUND_START would leave the round with no started_at at all.
	if (surv[0] == '\0') strcopy(surv, sizeof(surv), "a");
	EmitPug("ROUND_START map=%s half=%d surv=%s", g_sCurrentMap, g_iHalf, surv);
```

In `Event_RoundEnd`, after the half score is resolved and before `FinalizeMap` is considered:

```sourcepawn
	char survEnd[2];
	SurvPugTeam(survEnd, sizeof(survEnd));
	if (survEnd[0] != '\0')
	{
		// The survivor team's own score for this half. g_iHalfScoreA/B are
		// already the per-half accumulators.
		int mine = StrEqual(survEnd, "a") ? g_iHalfScoreA : g_iHalfScoreB;
		EmitPug("ROUND_END half=%d surv=%s score=%d", g_iHalf, survEnd, mine);
	}
	g_fRoundLiveAt = 0.0;
```

In `FinalizeMap()`, after `g_iMapCount++`, reset the half counter so the next map starts at half 1:

```sourcepawn
	g_iHalf = 0;
```

In `ResetMatchState()`, beside the other resets:

```sourcepawn
	g_iHalf = 0;
	g_fRoundLiveAt = 0.0;
```

- [ ] **Step 4: Build the plugin and run the parity test**

Run: `./plugin/build.sh && npx vitest run tests/eventKindsParity.test.ts`
Expected: `spcomp` reports 0 errors, and both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/pug-match.sp tests/eventKindsParity.test.ts
git commit -m "feat(plugin): emit round boundaries, sides and event round timing"
```

---

### Task 8: Emit the event vocabulary

Task 1 registered 16 kinds; only `dp` is emitted so far, so the parity test passes vacuously. This wires the rest. Every event name below is taken from `l4d2_skill_detect.sp`, which is verified running on L4D1 in this deployment, or from a Rotoblin-AZMod plugin in `Rotoblin-AZMod/SourceCode/scripting-az/`. None are guessed.

**Files:**
- Modify: `plugin/pug-match.sp`
- Test: `tests/eventKindsParity.test.ts` (already created in Task 7; it becomes meaningful here)

**Interfaces:**
- Consumes: `EmitEvent`, `StatsActive`, `g_iClientRoster`, `g_sRosterId` from `plugin/pug-match.sp`
- Produces: emissions for `pinned`, `cleared`, `incap`, `death`, `ff`, `si_spawn`, `tank_spawn`, `tank_pass`, `tank_death`, `witch_aggro`, `witch_killed`, `car_alarm`

- [ ] **Step 1: Strengthen the parity test to require real coverage**

Replace the second test in `tests/eventKindsParity.test.ts` and add a third:

```ts
  it('emits no kind the registry does not know', () => {
    const known = new Set(eventKindKeys());
    const unknown = emittedKinds(pluginSrc).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('emits every kind the registry promises except the ones explicitly deferred', () => {
    // `skeet` and `boom` come from skill_detect forwards rather than from a
    // pug-match hook, and are emitted in pug-stats.inc. Everything else must
    // have an emission site here, or the registry is advertising a feed the
    // plugin does not produce.
    const deferred = new Set(['skeet', 'boom']);
    const emitted = new Set(emittedKinds(pluginSrc));
    const missing = eventKindKeys().filter((k) => !deferred.has(k) && !emitted.has(k));
    expect(missing).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/eventKindsParity.test.ts`
Expected: FAIL, `missing` lists 12 kinds.

- [ ] **Step 3: Add pin tracking and the hooks**

In `plugin/pug-match.sp`, beside the other client arrays near line 90:

```sourcepawn
// Who currently has each survivor pinned, as a client index; 0 = free.
// Needed because a "cleared" event has to name the survivor who did the
// clearing, which is not carried by any release event.
int g_iPinnedBy[MAXPLAYERS + 1];
```

Register the hooks in `OnPluginStart`, beside the existing `HookEvent` calls at line 161:

```sourcepawn
	// Names verified against l4d2_skill_detect.sp, which runs on L4D1 here.
	// Note player_incapacitated_START: the bare player_incapacitated does not
	// fire on this engine.
	HookEvent("lunge_pounce", Event_Pounce);
	HookEvent("tongue_grab", Event_TongueGrab);
	HookEvent("tongue_release", Event_TongueRelease);
	HookEvent("player_incapacitated_start", Event_Incap);
	HookEvent("witch_harasser_set", Event_WitchAggro);
	HookEvent("witch_killed", Event_WitchKilled);
	HookEvent("triggered_car_alarm", Event_CarAlarm);
	HookEvent("tank_spawn", Event_TankSpawn);
	// Tank control passing goes through a bot swap on this engine, which is
	// how l4dscores.sp and three other Rotoblin plugins detect it.
	HookEvent("player_replace", Event_PlayerReplace);
	HookEvent("bot_player_replace", Event_BotReplace);
```

Add a helper that turns a client into its roster SteamID, returning false for anyone not rostered, so an unrostered spectator can never appear in the feed:

```sourcepawn
bool RosterIdOf(int client, char[] out, int maxlen)
{
	if (client <= 0 || client > MaxClients) return false;
	int slot = g_iClientRoster[client];
	if (slot < 0) return false;
	strcopy(out, maxlen, g_sRosterId[slot]);
	return true;
}

/** Emit with actor and optional target resolved from client indices.
 *  Silently does nothing when the actor is not rostered. */
void EmitClientEvent(const char[] kind, int actor, int target, int value)
{
	if (!StatsActive()) return;
	char a[32], t[32];
	if (!RosterIdOf(actor, a, sizeof(a))) return;
	if (!RosterIdOf(target, t, sizeof(t))) t[0] = '\0';
	EmitEvent(kind, a, t, value);
}
```

Add the handlers:

```sourcepawn
public void Event_Pounce(Event event, const char[] name, bool dontBroadcast)
{
	int hunter = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = hunter;
	EmitClientEvent("pinned", hunter, victim, 0);
}

public void Event_TongueGrab(Event event, const char[] name, bool dontBroadcast)
{
	int smoker = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = smoker;
	EmitClientEvent("pinned", smoker, victim, 0);
}

public void Event_TongueRelease(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = 0;
}

public void Event_Incap(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = 0;
	// Actor is the survivor it happened to, so the feed reads
	// "<name> was incapped by <attacker>".
	EmitClientEvent("incap", victim, attacker, 0);
}

public void Event_WitchAggro(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("witch_aggro", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

public void Event_WitchKilled(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("witch_killed", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

public void Event_CarAlarm(Event event, const char[] name, bool dontBroadcast)
{
	// userid may be absent or 0 when the director trips an alarm with nobody
	// responsible. EmitClientEvent drops it, which is correct: an unattributed
	// alarm is not a blame stat.
	EmitClientEvent("car_alarm", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

public void Event_TankSpawn(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("tank_spawn", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

/** A human taking over a bot. When the bot was the tank, this is a tank pass. */
public void Event_PlayerReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_pass", player, 0, 0);
}

public void Event_BotReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_pass", player, 0, 0);
}

bool IsTankClient(int client)
{
	if (client <= 0 || client > MaxClients || !IsClientInGame(client)) return false;
	if (GetClientTeam(client) != TEAM_INFECTED) return false;
	return GetEntProp(client, Prop_Send, "m_zombieClass") == ZC_TANK;
}
```

Extend the existing `Event_PlayerDeath` handler. It already runs; add at the end of its body:

```sourcepawn
	// Free anyone this player was pinning, and credit whoever killed them.
	for (int i = 1; i <= MaxClients; i++)
	{
		if (g_iPinnedBy[i] != victim) continue;
		g_iPinnedBy[i] = 0;
		EmitClientEvent("cleared", attacker, i, 0);
	}
	if (GetClientTeam(victim) == TEAM_SURVIVOR) EmitClientEvent("death", victim, attacker, 0);
	else if (IsTankClient(victim)) EmitClientEvent("tank_death", attacker, 0, 0);
```

using whatever local names that handler already uses for the dead client and the attacker.

Extend the existing `Event_PlayerHurt` handler, which already computes friendly fire, to emit alongside the counter it already increments:

```sourcepawn
	// Emitted beside the ff_dealt counter, never instead of it. The counter
	// stays authoritative for totals; this carries only when and to whom.
	EmitClientEvent("ff", attacker, victim, damage);
```

Extend the existing `Event_PlayerSpawn` handler, which already runs for boomer attribution:

```sourcepawn
	if (GetClientTeam(client) == TEAM_INFECTED)
		EmitClientEvent("si_spawn", client, 0, GetEntProp(client, Prop_Send, "m_zombieClass"));
```

In `Event_RoundStart` and `ResetMatchState`, clear the pin array beside the other per-client resets:

```sourcepawn
		g_iPinnedBy[i] = 0;
```

- [ ] **Step 4: Build and run the parity test**

Run: `./plugin/build.sh && npx vitest run tests/eventKindsParity.test.ts`
Expected: `spcomp` reports 0 errors, all 3 tests PASS, `missing` is empty.

- [ ] **Step 5: Commit**

```bash
git add plugin/pug-match.sp tests/eventKindsParity.test.ts
git commit -m "feat(plugin): emit the full live event vocabulary"
```

---

### Task 9: Verify on the box

Nothing above proves the plugin agrees with the backend about which team held survivor. Only a real match does. **Do not run this without an explicit go-ahead: players are frequently on the Dallas box.**

**Files:**
- Modify: `plugin/TESTING.md` (add the runbook section below)

**Interfaces:**
- Consumes: everything above
- Produces: nothing in code

- [ ] **Step 1: Stage the plugin**

Run: `./plugin/stage.sh`
Expected: one file copied and reloaded. No server restart.

- [ ] **Step 2: Play or simulate one full map of a PUG**

Both halves must go live and end. `sm_pug_debug 1` first if the orientation mapping needs watching.

- [ ] **Step 3: Confirm the rounds landed and the sides are opposite**

```bash
sqlite3 data/pug.db "SELECT match_id, ordinal, half, surv_team, score, reliable FROM match_rounds ORDER BY match_id DESC, ordinal, half LIMIT 10;"
```

Expected: two rows per map, halves 1 and 2, with **different** `surv_team` values. Two rows with the same side is the failure this task exists to catch, and it means the orientation mapping is being read too early.

- [ ] **Step 4: Confirm events carry timing**

```bash
sqlite3 data/pug.db "SELECT kind, half, t_ms FROM match_live_events WHERE t_ms >= 0 ORDER BY match_id DESC, seq DESC LIMIT 10;"
```

Expected: non-negative `t_ms` values increasing within a half, and `half` matching the round the event fell in. All `-1` means the staged plugin did not actually reload.

- [ ] **Step 5: Confirm the new event kinds actually fire**

```bash
sqlite3 data/pug.db "SELECT kind, COUNT(*) FROM match_live_events GROUP BY kind ORDER BY 2 DESC;"
```

Expected: `pinned`, `cleared`, `incap`, `death`, `ff` and `si_spawn` all present after one full map. A kind with zero rows is either a hook that did not fire or an event name wrong for this engine; both need chasing before 6b builds a timeline on top. `tank_pass` legitimately shows zero if nobody passed the tank, and `car_alarm` and `witch_*` are map-dependent.

- [ ] **Step 6: Confirm attribution against a player who is known to have played both sides**

```bash
curl -s localhost:8080/api/matches/<id> | python3 -m json.tool | head -60
```

Expected: `rounds` has two entries per map; a given player's survivor keys appear only in the half their team held survivor, and their infected keys only in the other.

- [ ] **Step 7: Record the result and commit the runbook**

```bash
git add plugin/TESTING.md
git commit -m "docs(plugin): add round capture verification runbook"
```
