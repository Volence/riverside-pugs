# Balance Metrics Engine (piece 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every played round into balance numbers (per round, split by phase: tank alive, witch near, panic/finale event, normal play), stored so piece 3's dashboard can compare patches, and backfill all existing rounds.

**Architecture:** A pure core (`src/metrics/`) takes one round's data (events, round row, per-round stat lines, markers, decoded replay) and returns `{metric, phase, num, den}` rows from a registry of small metric functions. A loader builds that input from the database and the replay file; a store writes rows plus a per-round context row (map, origin, server, patch, side ratings). A reaper step computes a couple of rounds per minute when no match is live, and a CLI script backfills history.

**Tech Stack:** TypeScript, better-sqlite3, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-balance-analytics-design.md`, section "2. Metrics engine".

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages.
- Every `db` function takes `db: DB` as its first argument; no global handle.
- Schema changes go in `openDb` (`src/db.ts`) with `CREATE TABLE IF NOT EXISTS` / `ensureColumn`.
- Rates are stored as numerator and denominator, never as a finished percentage.
- A missing value is absent (no row), never zero.
- Phases: `all`, `tank`, `witch`, `event`, `normal`. A metric's `all` row is written whenever the metric is computable; sub-phase rows only when the round has a replay timeline.
- Do not touch `src/balance.ts` or `src/roundStats.ts` (unrelated modules with confusable names).
- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/balance-metrics` (branch `worktree-balance-metrics`).
- Nothing is deployed by this plan. The last task is a dry run against a local COPY of production.

## Decisions made while planning (deviations from the spec, all small)

1. **No map-distance data exists** (no flow or max distance anywhere in events, rounds or replays). "Distance at the point of the wipe" becomes `round.score_on_wipe` (the survivor score on rounds that ended in a wipe). "Saferoom reached" is `survivors_alive > 0` on a reliable, ended round, which is how `playerStats.ts` already defines survival.
2. **One engine version per round instead of a version per row.** `round_metric_context.engine` stores a string built from every registered metric's `id:version`. Bumping any metric's version changes it, and the job recomputes those rounds. Simpler than per-row versions and gives the same recompute behavior.
3. **Match-level-only stats are not used.** Per-round numbers come from `match_round_stats` (pug-match 0.3.9+) and events. Rounds before 0.3.9 get no stat-derived metrics (absent, not zero).
4. **Old replays without a side mask** get their mask rebuilt from the database with the existing `infectedMaskFor` (`src/routes/replays.ts`). If that fails, the round gets no replay-derived metrics rather than a slot-order guess.
5. **Paused stretches are dropped** with the existing `unpausedFrames` (`src/integrity/round.ts`).
6. **Witch startles are events, not replay state.** The replay only knows where a witch is; `witch_aggro` / `witch_killed` events carry the rest.
7. **The reaper computes at most 2 rounds per minute and only when no match is live**, because decoding a replay blocks the event loop (median file 1.2 MB). History is filled by the CLI script.
8. **Game type filter** uses `matches.origin` ('queue' / 'in_game') from piece 1; stored in the context row.

## File map

| File | Responsibility |
|---|---|
| `src/metrics/types.ts` | Shared types: Phase, Ratio, MetricOut, RoundInput, RoundReplay, MetricDef |
| `src/metrics/loadRound.ts` | Build a RoundInput (no replay) from the database |
| `src/metrics/replayRound.ts` | Read and decode a round's replay with the side fix and pause filter |
| `src/metrics/timeline.ts` | Tank / witch / event intervals, `phaseAt`, phase minutes |
| `src/metrics/kit.ts` | Helpers metric functions share (counts by phase, per minute, class at time) |
| `src/metrics/defs/outcomes.ts`, `pace.ts`, `tank.ts`, `witch.ts`, `si.ts`, `weapons.ts` | Metric definitions by group |
| `src/metrics/registry.ts` | All metrics, engine version string, `computeRound` |
| `src/metrics/store.ts` | Context row (ratings, map, origin, server, patch) and row writes |
| `src/metrics/job.ts` | Pending round selection, `runMetricsPass`, reaper hook |
| `scripts/backfill-round-metrics.ts` | CLI: compute all pending rounds, dry run by default, prints a summary |
| `src/db.ts` | Two new tables |
| `src/server.ts` | One reaper step |

---

### Task 1: Schema and shared types

**Files:**
- Modify: `src/db.ts` (inside `openDb`, before `seed(db)`)
- Create: `src/metrics/types.ts`
- Test: `tests/metrics/schema.test.ts`
- Modify: `tests/db.test.ts` only if it holds an exhaustive table list (add the two tables)

**Interfaces:**
- Produces tables `round_metrics`, `round_metric_context`; types in `src/metrics/types.ts` exactly as below.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/schema.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('metrics schema', () => {
  it('creates round_metrics and round_metric_context', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'round_metrics')).toEqual(
      ['match_id', 'ordinal', 'half', 'metric', 'phase', 'num', 'den']);
    expect(cols(db, 'round_metric_context')).toEqual(expect.arrayContaining([
      'match_id', 'ordinal', 'half', 'map', 'origin', 'server_id', 'patch_id',
      'surv_mu', 'inf_mu', 'has_replay', 'has_stats', 'engine', 'computed_at']));
    const idx = (db.prepare('PRAGMA index_list(round_metrics)').all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('round_metrics_metric');
  });

  it('rejects an unknown phase', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    expect(() => db.prepare(
      "INSERT INTO round_metrics VALUES (1, 0, 1, 'm', 'lunch', 1, 1)").run()).toThrow();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/schema.test.ts`
Expected: FAIL, `no such table: round_metrics`.

- [ ] **Step 3: Add the tables in `src/db.ts`** (inside `openDb`, before `seed(db)`):

```ts
  // Balance analytics piece 2: per-round metrics, one row per metric per phase.
  // docs/superpowers/specs/2026-09-23-balance-analytics-design.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS round_metrics (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      ordinal  INTEGER NOT NULL,
      half     INTEGER NOT NULL,
      metric   TEXT    NOT NULL,
      phase    TEXT    NOT NULL CHECK (phase IN ('all','tank','witch','event','normal')),
      num      REAL    NOT NULL,
      den      REAL    NOT NULL,
      PRIMARY KEY (match_id, ordinal, half, metric, phase)
    );
    CREATE INDEX IF NOT EXISTS round_metrics_metric ON round_metrics(metric, phase);
    CREATE TABLE IF NOT EXISTS round_metric_context (
      match_id    INTEGER NOT NULL REFERENCES matches(id),
      ordinal     INTEGER NOT NULL,
      half        INTEGER NOT NULL,
      map         TEXT,
      origin      TEXT,
      server_id   INTEGER,
      patch_id    INTEGER,
      surv_mu     REAL,
      inf_mu      REAL,
      has_replay  INTEGER NOT NULL,
      has_stats   INTEGER NOT NULL,
      engine      TEXT    NOT NULL,
      computed_at TEXT    NOT NULL,
      PRIMARY KEY (match_id, ordinal, half)
    );
  `);
```

- [ ] **Step 4: Write `src/metrics/types.ts`**

```ts
import type { Frame } from '../replayFormat.js';

export type Phase = 'all' | 'tank' | 'witch' | 'event' | 'normal';
export type SubPhase = Exclude<Phase, 'all'>;
export const SUB_PHASES: SubPhase[] = ['tank', 'witch', 'event', 'normal'];

/** A rate kept as its parts so pooling rounds weights them correctly. */
export interface Ratio { num: number; den: number }
/** What one metric returns for one round. A phase left out is "not computable". */
export type MetricOut = Partial<Record<Phase, Ratio>>;

export interface RoundKey { matchId: number; ordinal: number; half: 1 | 2 }

export interface RoundEvent {
  kind: string;
  actor: string;
  target: string | null;
  value: number;
  /** Milliseconds since the half went live; -1 when unknown. */
  tMs: number;
}

export interface RoundReplay {
  /** Decoded with real sides and with paused frames removed. */
  frames: Frame[];
  /** Unpaused playing time covered by the frames. */
  durationMs: number;
}

export interface RoundInput {
  key: RoundKey;
  survTeam: 'a' | 'b';
  reliable: boolean;
  ended: boolean;
  score: number;
  survivorsAlive: number | null;
  /** This round's events, ordered by tMs then seq. */
  events: RoundEvent[];
  marks: { kind: string; tMs: number }[];
  /** player -> stat -> per-round value. Empty when the round predates ROUND_STAT. */
  stats: Map<string, Map<string, number>>;
  /** ROUND_STATS_END arrived for this round. */
  hasStats: boolean;
  /** skill_detect was loaded for this round (meaningful only with hasStats). */
  skillDetect: boolean;
  teamOf: Map<string, 'a' | 'b'>;
  replay: RoundReplay | null;
}

export interface Timeline {
  durationMs: number;
  tank: Interval[];
  witch: Interval[];
  event: Interval[];
  /** Phase at a round time; tank wins over witch over event over normal. */
  phaseAt(tMs: number): SubPhase;
  /** Playing minutes spent in a phase ('all' is the whole round). */
  minutes(p: Phase): number;
}

export interface Interval { from: number; to: number }

export interface RoundCtx extends RoundInput { timeline: Timeline | null }

export type MetricGroup = 'outcomes' | 'tank' | 'witch' | 'hunter' | 'smoker' | 'boomer' | 'si' | 'weapons' | 'pace';

export interface MetricDef {
  id: string;
  group: MetricGroup;
  /** Plain English, shown on the dashboard and later the public page. */
  description: string;
  version: number;
  compute(c: RoundCtx): MetricOut | null;
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run tests/metrics/schema.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. If `tests/db.test.ts` fails on an exhaustive table list, add `round_metrics` and `round_metric_context` to it and rerun.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/metrics/types.ts tests/metrics/schema.test.ts tests/db.test.ts
git commit -m "metrics: round_metrics and context tables, shared types"
```

---

### Task 2: Round loader (database side)

**Files:**
- Create: `src/metrics/loadRound.ts`
- Test: `tests/metrics/loadRound.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `loadRoundInput(db: DB, key: RoundKey): Omit<RoundInput, 'replay'> | null` (null when the round row does not exist).

Facts the implementer needs: `match_rounds(match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive, skill_detect, ...)`; `match_live_events(match_id, map_ordinal, seq, kind, actor, target, value, half, t_ms)` where the round's events are `map_ordinal = ordinal AND half = half` (half -1 means "before round timing existed" and never matches); `match_round_stats(match_id, ordinal, half, player_id, stat, value)`; `match_round_marks(match_id, ordinal, half, kind, t_ms)`; `match_players(match_id, player_id, team)`. `skill_detect` is NULL until ROUND_STATS_END arrives.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/loadRound.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { loadRoundInput } from '../../src/metrics/loadRound.js';

const A = '76561198000000001', B = '76561198000000002';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  for (const p of [A, B]) db.prepare("INSERT INTO players (steamid, name) VALUES (?, ?)").run(p, p);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (1, ?, 'a'), (1, ?, 'b')").run(A, B);
  db.prepare(`INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive, skill_detect)
              VALUES (1, 0, 2, 'b', 412, 1, '2026-09-20 10:00:00', '2026-09-20 10:09:00', 0, 1)`).run();
  const ev = db.prepare(`INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, value, half, t_ms)
                         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ev.run(0, 2, 'tank_spawn', A, null, 0, 2, 5000);
  ev.run(0, 1, 'si_spawn', A, null, 3, 2, 1000);
  ev.run(0, 3, 'skeet', B, A, 0, 1, 900);      // other half: excluded
  ev.run(1, 4, 'skeet', B, A, 0, 2, 900);      // other map: excluded
  db.prepare("INSERT INTO match_round_stats VALUES (1, 0, 2, ?, 'crowns', 1), (1, 0, 2, ?, 'dmg_as_tank', 300)").run(B, A);
  db.prepare("INSERT INTO match_round_marks VALUES (1, 0, 2, 'panic', 7000)").run();
  return db;
}

describe('loadRoundInput', () => {
  it('loads one round and only its own events, ordered by time', () => {
    const r = loadRoundInput(setup(), { matchId: 1, ordinal: 0, half: 2 })!;
    expect(r.survTeam).toBe('b');
    expect(r.reliable).toBe(true);
    expect(r.ended).toBe(true);
    expect(r.score).toBe(412);
    expect(r.survivorsAlive).toBe(0);
    expect(r.events.map((e) => e.kind)).toEqual(['si_spawn', 'tank_spawn']);
    expect(r.events[0]).toEqual({ kind: 'si_spawn', actor: A, target: null, value: 3, tMs: 1000 });
    expect(r.stats.get(B)?.get('crowns')).toBe(1);
    expect(r.stats.get(A)?.get('dmg_as_tank')).toBe(300);
    expect(r.hasStats).toBe(true);
    expect(r.skillDetect).toBe(true);
    expect(r.marks).toEqual([{ kind: 'panic', tMs: 7000 }]);
    expect(r.teamOf.get(A)).toBe('a');
  });

  it('reports no stats for a round that predates ROUND_STAT', () => {
    const db = setup();
    db.prepare('UPDATE match_rounds SET skill_detect = NULL').run();
    db.prepare('DELETE FROM match_round_stats').run();
    const r = loadRoundInput(db, { matchId: 1, ordinal: 0, half: 2 })!;
    expect(r.hasStats).toBe(false);
    expect(r.skillDetect).toBe(false);
    expect(r.stats.size).toBe(0);
  });

  it('returns null for a missing round', () => {
    expect(loadRoundInput(setup(), { matchId: 1, ordinal: 5, half: 1 })).toBeNull();
  });
});
```

If the `players` insert needs more NOT NULL columns, copy the minimal insert from `tests/mergePlayers.test.ts`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/loadRound.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/metrics/loadRound.ts`**

```ts
import type { DB } from '../db.js';
import type { RoundEvent, RoundInput, RoundKey } from './types.js';

/** Everything a metric needs about one round except the replay. Null when the
 *  round row does not exist. */
export function loadRoundInput(db: DB, key: RoundKey): Omit<RoundInput, 'replay'> | null {
  const row = db.prepare(`SELECT surv_team, score, reliable, started_at, ended_at, survivors_alive, skill_detect
                          FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?`)
    .get(key.matchId, key.ordinal, key.half) as {
      surv_team: 'a' | 'b'; score: number; reliable: number; started_at: string | null; ended_at: string | null;
      survivors_alive: number | null; skill_detect: number | null } | undefined;
  if (!row) return null;

  const events = db.prepare(`SELECT kind, actor, target, value, t_ms AS tMs FROM match_live_events
                             WHERE match_id = ? AND map_ordinal = ? AND half = ?
                             ORDER BY t_ms, seq`)
    .all(key.matchId, key.ordinal, key.half) as RoundEvent[];

  const stats = new Map<string, Map<string, number>>();
  for (const s of db.prepare(`SELECT player_id, stat, value FROM match_round_stats
                              WHERE match_id = ? AND ordinal = ? AND half = ?`)
    .all(key.matchId, key.ordinal, key.half) as { player_id: string; stat: string; value: number }[]) {
    let m = stats.get(s.player_id);
    if (!m) { m = new Map(); stats.set(s.player_id, m); }
    m.set(s.stat, s.value);
  }

  const marks = db.prepare(`SELECT kind, t_ms AS tMs FROM match_round_marks
                            WHERE match_id = ? AND ordinal = ? AND half = ? ORDER BY t_ms`)
    .all(key.matchId, key.ordinal, key.half) as { kind: string; tMs: number }[];

  const teamOf = new Map((db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
    .all(key.matchId) as { player_id: string; team: 'a' | 'b' }[]).map((r) => [r.player_id, r.team] as const));

  return {
    key,
    survTeam: row.surv_team,
    reliable: row.reliable === 1,
    ended: row.ended_at !== null && row.started_at !== null,
    score: row.score,
    survivorsAlive: row.survivors_alive,
    events,
    marks,
    stats,
    hasStats: row.skill_detect !== null,
    skillDetect: row.skill_detect === 1,
    teamOf,
  };
}
```

- [ ] **Step 4: Run and see it pass**

Run: `npx vitest run tests/metrics/loadRound.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metrics/loadRound.ts tests/metrics/loadRound.test.ts
git commit -m "metrics: load one round's events, stats, marks and teams"
```

---

### Task 3: Replay loader with side fix and pause filter

**Files:**
- Create: `src/metrics/replayRound.ts`
- Test: `tests/metrics/replayRound.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `decodeFrames`, `HEADER_BYTES`, `slotInfected` (`src/replayFormat.ts`); `unpausedFrames` (`src/integrity/round.ts`); `resolveReplayPath` (`src/replays.ts`); `infectedMaskFor` (`src/routes/replays.ts`).
- Produces: `decodeRoundReplay(buf: Uint8Array, fallbackMask: () => number | null): RoundReplay | null`, `loadRoundReplay(db: DB, key: RoundKey, replayDir: string): RoundReplay | null`, and `FRAME_DT_CAP_MS = 1000`.

`durationMs` rule: sum over consecutive kept frames of `min(next.tMs - f.tMs, FRAME_DT_CAP_MS)`, plus one sample interval (`1000 / header.playerHz`, default 100) for the last frame. The cap stops a gap in the file (a dropped stretch) from counting as play.

- [ ] **Step 1: Write the failing test** (build real bytes with the encoder, following `tests/replayFormat.test.ts`'s `header()` helper for the full field list)

```ts
// tests/metrics/replayRound.test.ts
import { describe, expect, it } from 'vitest';
import { encodeFrame, encodeHeader, STATE, type Frame, type ReplayHeader } from '../../src/replayFormat.js';
import { decodeRoundReplay } from '../../src/metrics/replayRound.js';

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: 3, token: 'c'.repeat(32), ordinal: 0, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_hospital01_apartment', startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['1', '2', '', '', '', '', '', ''], infectedMask: 0b10, sidesKnown: true, losKnown: false, ...over,
  };
}
const idle = (slot: number) => ({ slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 });
function frame(tMs: number): Frame {
  const players = Array.from({ length: 8 }, (_, s) => idle(s));
  players[0] = { ...idle(0), state: STATE.PRESENT | STATE.ALIVE, health: 100 };
  players[1] = { ...idle(1), state: STATE.PRESENT | STATE.ALIVE, health: 250, cls: 3 };
  return { tMs, players, entities: [], offset: 0 };
}
function bytes(h: ReplayHeader, frames: Frame[]): Uint8Array {
  const parts = [encodeHeader(h), ...frames.map(encodeFrame)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('decodeRoundReplay', () => {
  it('uses the header side mask and drops paused frames', () => {
    const r = decodeRoundReplay(bytes(header(), [frame(0), frame(100), frame(100), frame(100), frame(200)]), () => null)!;
    expect(r.frames.map((f) => f.tMs)).toEqual([0, 100, 200]);
    expect(r.frames[0].players[1].infected).toBe(true);
    expect(r.frames[0].players[0].infected).toBe(false);
    expect(r.durationMs).toBe(300);
  });

  it('caps a gap in the file at one second', () => {
    const r = decodeRoundReplay(bytes(header(), [frame(0), frame(100), frame(60_000)]), () => null)!;
    expect(r.durationMs).toBe(100 + 1000 + 100);
  });

  it('uses the fallback mask for a file without one, and gives up without it', () => {
    const old = header({ version: 2, sidesKnown: false, infectedMask: 0 });
    const withMask = decodeRoundReplay(bytes(old, [frame(0), frame(100)]), () => 0b01)!;
    expect(withMask.frames[0].players[0].infected).toBe(true);
    expect(decodeRoundReplay(bytes(old, [frame(0), frame(100)]), () => null)).toBeNull();
  });

  it('returns null for garbage and for fewer than two frames', () => {
    expect(decodeRoundReplay(new Uint8Array(10), () => null)).toBeNull();
    expect(decodeRoundReplay(bytes(header(), [frame(0)]), () => null)).toBeNull();
  });
});
```

If `encodeHeader` for version 2 behaves differently (it may still write the mask bytes), make the test file's old-format header by zeroing byte `SIDES_FLAG_OFFSET` in the encoded buffer instead, and keep the assertions.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/replayRound.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/metrics/replayRound.ts`**

```ts
import { readFileSync } from 'node:fs';
import type { DB } from '../db.js';
import { decodeFrames, decodeHeader, HEADER_BYTES, slotInfected } from '../replayFormat.js';
import { unpausedFrames } from '../integrity/round.js';
import { resolveReplayPath } from '../replays.js';
import { infectedMaskFor } from '../routes/replays.js';
import type { RoundKey, RoundReplay } from './types.js';

/** A gap between two kept frames longer than this is a hole in the file, not play. */
export const FRAME_DT_CAP_MS = 1000;

/** Decode one round's bytes with the real sides and without paused frames.
 *  `fallbackMask` supplies the side mask for files older than format 3; null
 *  there means the sides cannot be trusted and the round gets no replay. */
export function decodeRoundReplay(buf: Uint8Array, fallbackMask: () => number | null): RoundReplay | null {
  const h = decodeHeader(buf);
  if (!h) return null;
  let sideOf: (slot: number) => boolean;
  if (h.sidesKnown) sideOf = (s) => slotInfected(h, s);
  else {
    const mask = fallbackMask();
    if (mask === null) return null;
    sideOf = (s) => ((mask >> s) & 1) === 1;
  }
  const end = h.indexOffset > 0 ? h.indexOffset : buf.length;
  const frames = unpausedFrames(decodeFrames(buf, HEADER_BYTES, end, sideOf).frames);
  if (frames.length < 2) return null;
  let durationMs = 0;
  for (let i = 0; i + 1 < frames.length; i++) {
    durationMs += Math.min(frames[i + 1].tMs - frames[i].tMs, FRAME_DT_CAP_MS);
  }
  durationMs += Math.round(1000 / (h.playerHz > 0 ? h.playerHz : 10));
  return { frames, durationMs };
}

/** The round's replay from disk, or null when there is none, it was pruned,
 *  it cannot be read, or its sides cannot be established. */
export function loadRoundReplay(db: DB, key: RoundKey, replayDir: string): RoundReplay | null {
  const found = resolveReplayPath(db, key.matchId, key.ordinal, key.half, replayDir);
  if (!found) return null;
  let buf: Buffer;
  try { buf = readFileSync(found.path); } catch { return null; }
  return decodeRoundReplay(buf, () => infectedMaskFor(db, found.path, key.matchId, key.ordinal, key.half));
}
```

- [ ] **Step 4: Run and see it pass; typecheck**

Run: `npx vitest run tests/metrics/replayRound.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/replayRound.ts tests/metrics/replayRound.test.ts
git commit -m "metrics: decode a round's replay with real sides and no paused frames"
```

---

### Task 4: Phase timeline

**Files:**
- Create: `src/metrics/timeline.ts`
- Create: `tests/metrics/fixtures.ts` (shared synthetic-round builders for Tasks 4 to 9)
- Test: `tests/metrics/timeline.test.ts`

**Interfaces:**
- Consumes: `RoundReplay`, `Timeline`, `Interval` (Task 1); `STATE`, `ENTITY_KIND`, `PlayerSample` (`src/replayFormat.ts`); `dist2d`, `isLiveSurvivor` (`src/integrity/geometry.ts`); `FRAME_DT_CAP_MS` (Task 3).
- Produces: `buildTimeline(replay: RoundReplay, marks: {kind: string; tMs: number}[]): Timeline`, constants `WITCH_NEAR_UNITS = 1000`, `MERGE_GAP_MS = 2000`, `PANIC_WINDOW_MS = 45000`, and frame predicates `tankAlive(f: Frame): boolean`, `liveSurvivors(f: Frame): PlayerSample[]`, `witchesIn(f: Frame): EntitySample[]`.

Rules:
- **tank:** a frame has a live tank when any player is infected, `cls === 5`, ALIVE and not GHOST, or any entity is `ENTITY_KIND.TANK_AI`.
- **witch:** a frame is witch-near when any `ENTITY_KIND.WITCH` entity is within `WITCH_NEAR_UNITS` (2D) of any live survivor (`!infected && isLiveSurvivor`).
- A flag's frames form intervals `[f.tMs, next.tMs)` (last frame: `+100`); intervals closer than `MERGE_GAP_MS` merge (a tank passing between players flickers).
- **event:** each `panic` mark gives `[t, t + PANIC_WINDOW_MS)`; `finale_start` / `finale_radio` give `[t, end of round)`; overlapping intervals merge.
- `phaseAt`: tank, then witch, then event, else normal.
- `minutes(p)`: for each frame add `min(next.tMs - tMs, FRAME_DT_CAP_MS)` (last frame one sample) to `phaseAt(frame.tMs)`; `all` is `durationMs`. Values in minutes.

- [ ] **Step 1: Write `tests/metrics/fixtures.ts`**

```ts
import { ENTITY_KIND, STATE, type EntitySample, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import type { RoundCtx, RoundEvent, RoundInput, RoundReplay } from '../../src/metrics/types.js';

export const SURV = ['s1', 's2', 's3', 's4'];
export const INF = ['i1', 'i2', 'i3', 'i4'];

const idle = (slot: number): PlayerSample => ({
  slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
});

export interface FrameSpec {
  tMs: number;
  /** survivors 0-3: [x, y, weapon] alive and standing unless state given */
  surv?: { x: number; y: number; weapon?: number; state?: number }[];
  /** infected slots 4-7 */
  inf?: { cls: number; state?: number; health?: number }[];
  witch?: { x: number; y: number }[];
  tankAi?: boolean;
}

export function frame(s: FrameSpec): Frame {
  const players = Array.from({ length: 8 }, (_, i) => idle(i));
  (s.surv ?? []).forEach((p, i) => {
    players[i] = { ...idle(i), x: p.x, y: p.y, weapon: p.weapon ?? 1, health: 100,
      state: p.state ?? (STATE.PRESENT | STATE.ALIVE), infected: false };
  });
  for (let i = 0; i < 4; i++) players[i].infected = false;
  (s.inf ?? []).forEach((p, i) => {
    players[4 + i] = { ...idle(4 + i), cls: p.cls, health: p.health ?? 250,
      state: p.state ?? (STATE.PRESENT | STATE.ALIVE), infected: true };
  });
  for (let i = 4; i < 8; i++) players[i].infected = true;
  const entities: EntitySample[] = [];
  (s.witch ?? []).forEach((w, i) => entities.push({ ref: 100 + i, kind: ENTITY_KIND.WITCH, state: 2, x: w.x, y: w.y, z: 0, health: 1000 }));
  if (s.tankAi) entities.push({ ref: 200, kind: ENTITY_KIND.TANK_AI, state: STATE.PRESENT | STATE.ALIVE, x: 0, y: 0, z: 0, health: 6000 });
  return { tMs: s.tMs, players, entities, offset: 0 };
}

/** Frames every 100 ms from `from` to `to` (exclusive) built by `spec(t)`. */
export function frames(from: number, to: number, spec: (t: number) => Omit<FrameSpec, 'tMs'>): Frame[] {
  const out: Frame[] = [];
  for (let t = from; t < to; t += 100) out.push(frame({ tMs: t, ...spec(t) }));
  return out;
}

export function replayOf(fs: Frame[]): RoundReplay {
  let d = 0;
  for (let i = 0; i + 1 < fs.length; i++) d += Math.min(fs[i + 1].tMs - fs[i].tMs, 1000);
  return { frames: fs, durationMs: d + 100 };
}

export const standing4 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];

export function input(over: Partial<RoundInput> = {}): RoundInput {
  const teamOf = new Map<string, 'a' | 'b'>();
  SURV.forEach((p) => teamOf.set(p, 'a'));
  INF.forEach((p) => teamOf.set(p, 'b'));
  return {
    key: { matchId: 1, ordinal: 0, half: 1 }, survTeam: 'a', reliable: true, ended: true,
    score: 400, survivorsAlive: 2, events: [], marks: [], stats: new Map(), hasStats: false,
    skillDetect: false, teamOf, replay: null, ...over,
  };
}

export function ev(kind: string, actor: string, tMs: number, target: string | null = null, value = 0): RoundEvent {
  return { kind, actor, target, value, tMs };
}

export function stats(rows: [player: string, stat: string, value: number][]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const [p, s, v] of rows) { if (!m.has(p)) m.set(p, new Map()); m.get(p)!.set(s, v); }
  return m;
}

export type { RoundCtx };
```

- [ ] **Step 2: Write the failing timeline test**

```ts
// tests/metrics/timeline.test.ts
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/metrics/timeline.js';
import { frames, replayOf, standing4 } from './fixtures.js';

describe('buildTimeline', () => {
  it('finds the tank window from a player tank', () => {
    const r = replayOf(frames(0, 10_000, (t) => ({
      surv: standing4, inf: t >= 3000 && t < 6000 ? [{ cls: 5 }] : [],
    })));
    const tl = buildTimeline(r, []);
    expect(tl.tank).toEqual([{ from: 3000, to: 6000 }]);
    expect(tl.phaseAt(4000)).toBe('tank');
    expect(tl.phaseAt(7000)).toBe('normal');
    expect(tl.minutes('tank')).toBeCloseTo(3000 / 60000, 5);
    expect(tl.minutes('all')).toBeCloseTo(10_000 / 60000, 5);
  });

  it('treats a ghost tank as not alive and merges a short flicker', () => {
    const r = replayOf(frames(0, 8000, (t) => ({
      surv: standing4,
      inf: t >= 1000 && t < 7000 ? [{ cls: 5, state: (t >= 3000 && t < 3500) ? 1 | 2 | 128 : 1 | 2 }] : [],
    })));
    expect(buildTimeline(r, []).tank).toEqual([{ from: 1000, to: 7000 }]);
  });

  it('counts an AI tank', () => {
    const r = replayOf(frames(0, 3000, (t) => ({ surv: standing4, tankAi: t >= 1000 })));
    expect(buildTimeline(r, []).tank).toEqual([{ from: 1000, to: 3000 }]);
  });

  it('marks witch-near only within range of a standing survivor', () => {
    const r = replayOf(frames(0, 4000, (t) => ({
      surv: standing4, witch: [{ x: t < 2000 ? 5000 : 500, y: 0 }],
    })));
    const tl = buildTimeline(r, []);
    expect(tl.witch).toEqual([{ from: 2000, to: 4000 }]);
    expect(tl.phaseAt(1000)).toBe('normal');
    expect(tl.phaseAt(2500)).toBe('witch');
  });

  it('adds a panic window and lets tank win over it', () => {
    const r = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 10_000 && t < 20_000 ? [{ cls: 5 }] : [] })));
    const tl = buildTimeline(r, [{ kind: 'panic', tMs: 5000 }]);
    expect(tl.event).toEqual([{ from: 5000, to: 50_000 }]);
    expect(tl.phaseAt(6000)).toBe('event');
    expect(tl.phaseAt(15_000)).toBe('tank');
    expect(tl.phaseAt(55_000)).toBe('normal');
  });

  it('runs a finale window to the end of the round', () => {
    const r = replayOf(frames(0, 10_000, () => ({ surv: standing4 })));
    expect(buildTimeline(r, [{ kind: 'finale_start', tMs: 4000 }]).event).toEqual([{ from: 4000, to: 10_000 }]);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/metrics/timeline.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/metrics/timeline.ts`**

```ts
import { ENTITY_KIND, STATE, type EntitySample, type Frame, type PlayerSample } from '../replayFormat.js';
import { dist2d, isLiveSurvivor } from '../integrity/geometry.js';
import { FRAME_DT_CAP_MS } from './replayRound.js';
import type { Interval, Phase, RoundReplay, SubPhase, Timeline } from './types.js';

export const WITCH_NEAR_UNITS = 1000;
export const MERGE_GAP_MS = 2000;
export const PANIC_WINDOW_MS = 45_000;
const TANK_CLS = 5;
const LAST_FRAME_MS = 100;

export function tankAlive(f: Frame): boolean {
  if (f.entities.some((e) => e.kind === ENTITY_KIND.TANK_AI)) return true;
  return f.players.some((p) => p.infected === true && p.cls === TANK_CLS
    && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0);
}

export function liveSurvivors(f: Frame): PlayerSample[] {
  return f.players.filter((p) => p.infected === false && isLiveSurvivor(p));
}

export function witchesIn(f: Frame): EntitySample[] {
  return f.entities.filter((e) => e.kind === ENTITY_KIND.WITCH);
}

function witchNear(f: Frame): boolean {
  const ws = witchesIn(f);
  if (ws.length === 0) return false;
  const ss = liveSurvivors(f);
  return ws.some((w) => ss.some((s) => dist2d(w, s) <= WITCH_NEAR_UNITS));
}

/** Intervals where `flag` holds, from frame times, merged across short gaps. */
function intervalsOf(fs: Frame[], flag: (f: Frame) => boolean): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < fs.length; i++) {
    if (!flag(fs[i])) continue;
    const from = fs[i].tMs;
    const to = i + 1 < fs.length ? fs[i + 1].tMs : fs[i].tMs + LAST_FRAME_MS;
    const last = out[out.length - 1];
    if (last && from - last.to <= MERGE_GAP_MS) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

function mergeAll(xs: Interval[]): Interval[] {
  const s = [...xs].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}

const inAny = (xs: Interval[], t: number) => xs.some((x) => t >= x.from && t < x.to);

export function buildTimeline(replay: RoundReplay, marks: { kind: string; tMs: number }[]): Timeline {
  const fs = replay.frames;
  const end = fs[fs.length - 1].tMs + LAST_FRAME_MS;
  const tank = intervalsOf(fs, tankAlive);
  const witch = intervalsOf(fs, witchNear);
  const event = mergeAll(marks.filter((m) => m.tMs >= 0).map((m) => (
    m.kind === 'panic' ? { from: m.tMs, to: m.tMs + PANIC_WINDOW_MS } : { from: m.tMs, to: end })));

  const phaseAt = (t: number): SubPhase =>
    inAny(tank, t) ? 'tank' : inAny(witch, t) ? 'witch' : inAny(event, t) ? 'event' : 'normal';

  const ms: Record<SubPhase, number> = { tank: 0, witch: 0, event: 0, normal: 0 };
  for (let i = 0; i < fs.length; i++) {
    const dt = i + 1 < fs.length ? Math.min(fs[i + 1].tMs - fs[i].tMs, FRAME_DT_CAP_MS) : LAST_FRAME_MS;
    ms[phaseAt(fs[i].tMs)] += dt;
  }
  return {
    durationMs: replay.durationMs, tank, witch, event, phaseAt,
    minutes: (p: Phase) => (p === 'all' ? replay.durationMs : ms[p]) / 60_000,
  };
}
```

- [ ] **Step 5: Run and see it pass**

Run: `npx vitest run tests/metrics/timeline.test.ts`
Expected: PASS (6 tests). If the ghost-flicker test fails because the ghost frames split the interval by less than `MERGE_GAP_MS`, check `intervalsOf`'s merge uses the previous interval's `to` (which ends at the first ghost frame).

- [ ] **Step 6: Commit**

```bash
git add src/metrics/timeline.ts tests/metrics/fixtures.ts tests/metrics/timeline.test.ts
git commit -m "metrics: tank, witch and event phase timeline"
```

---

### Task 5: Metric kit, registry and computeRound

**Files:**
- Create: `src/metrics/kit.ts`, `src/metrics/registry.ts`
- Test: `tests/metrics/kit.test.ts`, `tests/metrics/registry.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 4.
- Produces (kit):
  - `onSide(c: RoundCtx, steamid: string, side: 'survivor' | 'infected'): boolean`
  - `sideStat(c: RoundCtx, side: 'survivor' | 'infected', stat: string): number` (sum over that side's players; 0 when nobody has it)
  - `classAt(c: RoundCtx, steamid: string, tMs: number): number | null` (last `si_spawn` value, or 5 after `tank_spawn` / `tank_take`, at or before `tMs`)
  - `countByPhase(c: RoundCtx, evs: RoundEvent[], weight?: (e: RoundEvent) => number): MetricOut` (den 1 per round)
  - `perMinute(c: RoundCtx, evs: RoundEvent[], weight?: (e: RoundEvent) => number): MetricOut | null` (null without a timeline)
  - `ratioByPhase(c: RoundCtx, numEvs: RoundEvent[], denEvs: RoundEvent[], numWeight?: (e: RoundEvent) => number): MetricOut | null` (phases with den 0 left out; null when all-phase den is 0)
  - `single(num: number, den?: number): MetricOut` (`{ all: {num, den: den ?? 1} }`)
- Produces (registry): `METRICS: MetricDef[]`, `ENGINE: string`, `computeRound(input: RoundInput): { metric: string; phase: Phase; num: number; den: number }[]`, `registerMetrics(defs: MetricDef[]): void` (used by the group tasks' modules via one import list, see Step 5).

Phase rule for events: an event contributes to `all`, and also to `c.timeline.phaseAt(e.tMs)` when there is a timeline and `e.tMs >= 0`.

- [ ] **Step 1: Write the failing kit test**

```ts
// tests/metrics/kit.test.ts
import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/metrics/timeline.js';
import { classAt, countByPhase, perMinute, ratioByPhase, sideStat, single } from '../../src/metrics/kit.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const withTank = () => {
  const replay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 30_000 ? [{ cls: 5 }] : [] })));
  return { ...input({ replay }), timeline: buildTimeline(replay, []) };
};

describe('metric kit', () => {
  it('sums a stat over one side', () => {
    const c = { ...input({ stats: stats([['s1', 'crowns', 1], ['s2', 'crowns', 2], ['i1', 'crowns', 9]]) }), timeline: null };
    expect(sideStat(c, 'survivor', 'crowns')).toBe(3);
    expect(sideStat(c, 'infected', 'crowns')).toBe(9);
    expect(sideStat(c, 'survivor', 'nope')).toBe(0);
  });

  it('knows an infected player class at a time', () => {
    const c = { ...input({ events: [ev('si_spawn', 'i1', 1000, null, 3), ev('tank_spawn', 'i1', 5000), ev('si_spawn', 'i1', 9000, null, 1)] }), timeline: null };
    expect(classAt(c, 'i1', 500)).toBeNull();
    expect(classAt(c, 'i1', 2000)).toBe(3);
    expect(classAt(c, 'i1', 6000)).toBe(5);
    expect(classAt(c, 'i1', 9000)).toBe(1);
  });

  it('counts events per phase with one round as the denominator', () => {
    const c = withTank();
    const out = countByPhase(c, [ev('boom', 'i1', 10_000), ev('boom', 'i1', 40_000), ev('boom', 'i2', 45_000)]);
    expect(out.all).toEqual({ num: 3, den: 1 });
    expect(out.normal).toEqual({ num: 1, den: 1 });
    expect(out.tank).toEqual({ num: 2, den: 1 });
  });

  it('gives only all without a timeline, and skips unknown times in phases', () => {
    const c = { ...input(), timeline: null };
    expect(countByPhase(c, [ev('boom', 'i1', -1)])).toEqual({ all: { num: 1, den: 1 } });
  });

  it('rates per minute of each phase', () => {
    const c = withTank();
    const out = perMinute(c, [ev('ff', 's1', 40_000, 's2', 30)], (e) => e.value)!;
    expect(out.all!.num).toBe(30);
    expect(out.all!.den).toBeCloseTo(1, 3);
    expect(out.tank!.den).toBeCloseTo(0.5, 3);
    expect(perMinute({ ...input(), timeline: null }, [])).toBeNull();
  });

  it('builds a ratio per phase and drops empty denominators', () => {
    const c = withTank();
    const out = ratioByPhase(c, [ev('skeet', 's1', 40_000)], [ev('si_spawn', 'i1', 10_000, null, 3), ev('si_spawn', 'i1', 35_000, null, 3)])!;
    expect(out.all).toEqual({ num: 1, den: 2 });
    expect(out.tank).toEqual({ num: 1, den: 1 });
    expect(out.normal).toEqual({ num: 0, den: 1 });
    expect(out.witch).toBeUndefined();
    expect(ratioByPhase(c, [], [])).toBeNull();
  });

  it('single wraps one number', () => {
    expect(single(5)).toEqual({ all: { num: 5, den: 1 } });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/kit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/metrics/kit.ts`**

```ts
import type { MetricOut, Phase, RoundCtx, RoundEvent, SubPhase } from './types.js';
import { SUB_PHASES } from './types.js';

export function onSide(c: RoundCtx, steamid: string, side: 'survivor' | 'infected'): boolean {
  const t = c.teamOf.get(steamid);
  if (t === undefined) return false;
  return side === 'survivor' ? t === c.survTeam : t !== c.survTeam;
}

export function sideStat(c: RoundCtx, side: 'survivor' | 'infected', stat: string): number {
  let n = 0;
  for (const [p, m] of c.stats) if (onSide(c, p, side)) n += m.get(stat) ?? 0;
  return n;
}

const TANK = 5;
export function classAt(c: RoundCtx, steamid: string, tMs: number): number | null {
  let cls: number | null = null;
  for (const e of c.events) {
    if (e.tMs > tMs || e.tMs < 0) continue;
    if (e.actor !== steamid) continue;
    if (e.kind === 'si_spawn') cls = e.value;
    else if (e.kind === 'tank_spawn' || e.kind === 'tank_take') cls = TANK;
  }
  return cls;
}

function phaseOf(c: RoundCtx, e: RoundEvent): SubPhase | null {
  return c.timeline && e.tMs >= 0 ? c.timeline.phaseAt(e.tMs) : null;
}

function sums(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number) {
  const s: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  for (const e of evs) {
    const w = weight(e);
    s.all += w;
    const p = phaseOf(c, e);
    if (p) s[p] += w;
  }
  return s;
}

const one = () => 1;

export function single(num: number, den = 1): MetricOut {
  return { all: { num, den } };
}

export function countByPhase(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number = one): MetricOut {
  const s = sums(c, evs, weight);
  const out: MetricOut = { all: { num: s.all, den: 1 } };
  if (c.timeline) for (const p of SUB_PHASES) out[p] = { num: s[p], den: 1 };
  return out;
}

export function perMinute(c: RoundCtx, evs: RoundEvent[], weight: (e: RoundEvent) => number = one): MetricOut | null {
  if (!c.timeline) return null;
  const s = sums(c, evs, weight);
  const out: MetricOut = {};
  for (const p of ['all', ...SUB_PHASES] as Phase[]) {
    const m = c.timeline.minutes(p);
    if (m > 0) out[p] = { num: s[p], den: m };
  }
  return out.all ? out : null;
}

export function ratioByPhase(c: RoundCtx, numEvs: RoundEvent[], denEvs: RoundEvent[],
  numWeight: (e: RoundEvent) => number = one): MetricOut | null {
  const n = sums(c, numEvs, numWeight);
  const d = sums(c, denEvs, one);
  if (d.all === 0) return null;
  const out: MetricOut = { all: { num: n.all, den: d.all } };
  if (c.timeline) for (const p of SUB_PHASES) if (d[p] > 0) out[p] = { num: n[p], den: d[p] };
  return out;
}

/** Events of one kind. */
export const kind = (c: RoundCtx, k: string) => c.events.filter((e) => e.kind === k);
```

- [ ] **Step 4: Write the failing registry test**

```ts
// tests/metrics/registry.test.ts
import { describe, expect, it } from 'vitest';
import { computeRound, ENGINE, METRICS } from '../../src/metrics/registry.js';
import { input } from './fixtures.js';

describe('metric registry', () => {
  it('has unique ids and an engine string that names every metric version', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of METRICS) expect(ENGINE).toContain(`${m.id}:${m.version}`);
    expect(METRICS.every((m) => /^[a-z]+\.[a-z0-9_.]+$/.test(m.id))).toBe(true);
    expect(METRICS.every((m) => m.description.length > 10 && !m.description.includes('—'))).toBe(true);
  });

  it('computes rows for a bare round without throwing, and never a non-finite value', () => {
    const rows = computeRound(input());
    expect(rows.every((r) => Number.isFinite(r.num) && Number.isFinite(r.den) && r.den > 0)).toBe(true);
  });

  it('drops a metric that throws instead of failing the round', () => {
    const rows = computeRound(input({ events: [{ kind: 'si_spawn', actor: 'i1', target: null, value: 3, tMs: -1 }] }));
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 5: Implement `src/metrics/registry.ts`**

The group modules (Tasks 6 to 9) each export `const defs: MetricDef[]`. The registry imports them in one place. Until those tasks land, create the six group files with `export const defs: MetricDef[] = [];` so the import list compiles; each group task fills its own file.

```ts
import { buildTimeline } from './timeline.js';
import type { MetricDef, Phase, RoundCtx, RoundInput } from './types.js';
import { defs as outcomes } from './defs/outcomes.js';
import { defs as pace } from './defs/pace.js';
import { defs as tank } from './defs/tank.js';
import { defs as witch } from './defs/witch.js';
import { defs as si } from './defs/si.js';
import { defs as weapons } from './defs/weapons.js';

export const METRICS: MetricDef[] = [...outcomes, ...pace, ...tank, ...witch, ...si, ...weapons];

/** Changes whenever a metric is added, removed or has its version bumped; the
 *  job recomputes every round whose stored engine differs. */
export const ENGINE = METRICS.map((m) => `${m.id}:${m.version}`).sort().join(',');

export interface MetricRow { metric: string; phase: Phase; num: number; den: number }

export function computeRound(input: RoundInput): MetricRow[] {
  const ctx: RoundCtx = { ...input, timeline: input.replay ? buildTimeline(input.replay, input.marks) : null };
  const rows: MetricRow[] = [];
  for (const m of METRICS) {
    let out;
    try { out = m.compute(ctx); } catch (err) {
      console.error(`[metrics] ${m.id} failed on match ${input.key.matchId} round ${input.key.ordinal}/${input.key.half}`, err);
      continue;
    }
    if (!out) continue;
    for (const [phase, r] of Object.entries(out) as [Phase, { num: number; den: number }][]) {
      if (!r || !Number.isFinite(r.num) || !Number.isFinite(r.den) || r.den <= 0) continue;
      rows.push({ metric: m.id, phase, num: r.num, den: r.den });
    }
  }
  return rows;
}
```

Create each of `src/metrics/defs/{outcomes,pace,tank,witch,si,weapons}.ts` as:

```ts
import type { MetricDef } from '../types.js';

export const defs: MetricDef[] = [];
```

- [ ] **Step 6: Run both tests; typecheck**

Run: `npx vitest run tests/metrics/kit.test.ts tests/metrics/registry.test.ts && npm run typecheck`
Expected: PASS (the registry test passes trivially with no metrics yet; later tasks give it teeth).

- [ ] **Step 7: Commit**

```bash
git add src/metrics/kit.ts src/metrics/registry.ts src/metrics/defs tests/metrics/kit.test.ts tests/metrics/registry.test.ts
git commit -m "metrics: shared kit, registry, engine version and computeRound"
```

---

### Task 6: Outcome and pace metrics

**Files:**
- Modify: `src/metrics/defs/outcomes.ts`, `src/metrics/defs/pace.ts`
- Test: `tests/metrics/outcomesPace.test.ts`

**Interfaces:**
- Consumes: kit (Task 5), `liveSurvivors` (Task 4), `dist2d` (`src/integrity/geometry.ts`), `SUB_PHASES`.
- Produces metric ids: `round.saferoom`, `round.survivors_alive`, `round.score`, `round.score_on_wipe`, `round.length_min`, `round.phase_share`, `pace.si_damage_per_min`, `pace.ff_per_min`, `pace.incaps_per_min`, `pace.deaths_per_min`, `pace.revives`, `pace.pin_gap_s`, `pace.survivor_spread`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/outcomesPace.test.ts
import { describe, expect, it } from 'vitest';
import { defs as outcomes } from '../../src/metrics/defs/outcomes.js';
import { defs as pace } from '../../src/metrics/defs/pace.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const byId = (id: string) => [...outcomes, ...pace].find((m) => m.id === id)!;
const run = (id: string, i: RoundInput) => byId(id).compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('outcome metrics', () => {
  it('saferoom and survivors alive need a reliable, ended round', () => {
    expect(run('round.saferoom', input({ survivorsAlive: 3 }))).toEqual({ all: { num: 1, den: 1 } });
    expect(run('round.saferoom', input({ survivorsAlive: 0 }))).toEqual({ all: { num: 0, den: 1 } });
    expect(run('round.saferoom', input({ survivorsAlive: null }))).toBeNull();
    expect(run('round.saferoom', input({ reliable: false }))).toBeNull();
    expect(run('round.survivors_alive', input({ survivorsAlive: 2 }))).toEqual({ all: { num: 2, den: 1 } });
  });

  it('score on wipe only counts wipes', () => {
    expect(run('round.score_on_wipe', input({ survivorsAlive: 0, score: 250 }))).toEqual({ all: { num: 250, den: 1 } });
    expect(run('round.score_on_wipe', input({ survivorsAlive: 1 }))).toBeNull();
  });

  it('length and phase share come from the replay', () => {
    const replay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 45_000 ? [{ cls: 5 }] : [] })));
    expect(run('round.length_min', input({ replay }))!.all!.num).toBeCloseTo(1, 3);
    const share = run('round.phase_share', input({ replay }))!;
    expect(share.tank!.num / share.tank!.den).toBeCloseTo(0.25, 2);
    expect(share.all).toBeUndefined();
    expect(run('round.length_min', input())).toBeNull();
  });
});

describe('pace metrics', () => {
  const replay = replayOf(frames(0, 120_000, () => ({ surv: standing4 })));

  it('SI damage per minute from per-round stats', () => {
    const out = run('pace.si_damage_per_min', input({ replay, hasStats: true, stats: stats([['i1', 'damage_as_si', 200], ['i2', 'damage_as_si', 100]]) }))!;
    expect(out.all!.num).toBe(300);
    expect(out.all!.den).toBeCloseTo(2, 2);
    expect(run('pace.si_damage_per_min', input({ replay }))).toBeNull();
  });

  it('friendly fire per minute is weighted by damage', () => {
    const out = run('pace.ff_per_min', input({ replay, events: [ev('ff', 's1', 1000, 's2', 40)] }))!;
    expect(out.all!.num).toBe(40);
  });

  it('pin gap is the mean seconds between pins', () => {
    const out = run('pace.pin_gap_s', input({ events: [ev('pinned', 'i1', 10_000, 's1'), ev('pinned', 'i2', 30_000, 's2'), ev('pinned', 'i1', 40_000, 's3')] }))!;
    expect(out.all).toEqual({ num: 30, den: 2 });
  });

  it('survivor spread averages pairwise distance of standing survivors', () => {
    const out = run('pace.survivor_spread', input({ replay: replayOf(frames(0, 1000, () => ({ surv: [{ x: 0, y: 0 }, { x: 300, y: 0 }] }))) }))!;
    expect(out.all!.num / out.all!.den).toBeCloseTo(300, 3);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/outcomesPace.test.ts`
Expected: FAIL (ids not found, `.compute` of undefined).

- [ ] **Step 3: Implement `src/metrics/defs/outcomes.ts`**

```ts
import { SUB_PHASES, type MetricDef, type MetricOut, type RoundCtx } from '../types.js';
import { single } from '../kit.js';

const finished = (c: RoundCtx) => c.reliable && c.ended && c.survivorsAlive !== null;

export const defs: MetricDef[] = [
  {
    id: 'round.saferoom', group: 'outcomes', version: 1,
    description: 'Share of rounds where at least one survivor reached the saferoom.',
    compute: (c) => (finished(c) ? single(c.survivorsAlive! > 0 ? 1 : 0) : null),
  },
  {
    id: 'round.survivors_alive', group: 'outcomes', version: 1,
    description: 'Survivors still standing when the round ended (0 is a wipe).',
    compute: (c) => (finished(c) ? single(c.survivorsAlive!) : null),
  },
  {
    id: 'round.score', group: 'outcomes', version: 1,
    description: 'Survivor score for the round.',
    compute: (c) => (c.reliable && c.ended ? single(c.score) : null),
  },
  {
    id: 'round.score_on_wipe', group: 'outcomes', version: 1,
    description: 'Survivor score on rounds that ended in a wipe, a stand-in for how far a wiped team got.',
    compute: (c) => (finished(c) && c.survivorsAlive === 0 ? single(c.score) : null),
  },
  {
    id: 'round.length_min', group: 'outcomes', version: 1,
    description: 'Playing minutes in the round, pauses excluded.',
    compute: (c) => (c.timeline ? single(c.timeline.minutes('all')) : null),
  },
  {
    id: 'round.phase_share', group: 'outcomes', version: 1,
    description: 'Share of playing time spent in each phase (tank alive, witch near, event, normal).',
    compute: (c) => {
      if (!c.timeline) return null;
      const all = c.timeline.minutes('all');
      if (all <= 0) return null;
      const out: MetricOut = {};
      for (const p of SUB_PHASES) out[p] = { num: c.timeline.minutes(p), den: all };
      return out;
    },
  },
];
```

- [ ] **Step 4: Implement `src/metrics/defs/pace.ts`**

```ts
import { dist2d } from '../../integrity/geometry.js';
import type { MetricDef, MetricOut, Phase } from '../types.js';
import { SUB_PHASES } from '../types.js';
import { countByPhase, kind, perMinute, sideStat } from '../kit.js';
import { liveSurvivors } from '../timeline.js';

export const defs: MetricDef[] = [
  {
    id: 'pace.si_damage_per_min', group: 'pace', version: 1,
    description: 'Damage special infected dealt to survivors per playing minute (all phases combined).',
    compute: (c) => {
      if (!c.hasStats || !c.timeline) return null;
      const m = c.timeline.minutes('all');
      return m > 0 ? { all: { num: sideStat(c, 'infected', 'damage_as_si'), den: m } } : null;
    },
  },
  {
    id: 'pace.ff_per_min', group: 'pace', version: 1,
    description: 'Friendly fire damage per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'ff'), (e) => e.value),
  },
  {
    id: 'pace.incaps_per_min', group: 'pace', version: 1,
    description: 'Survivor incaps per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'incap')),
  },
  {
    id: 'pace.deaths_per_min', group: 'pace', version: 1,
    description: 'Survivor deaths with a player killer per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'death')),
  },
  {
    id: 'pace.revives', group: 'pace', version: 1,
    description: 'Revives per round.',
    compute: (c) => countByPhase(c, kind(c, 'revive')),
  },
  {
    id: 'pace.pin_gap_s', group: 'pace', version: 1,
    description: 'Average seconds between one pin and the next.',
    compute: (c) => {
      const ts = kind(c, 'pinned').map((e) => e.tMs).filter((t) => t >= 0).sort((a, b) => a - b);
      if (ts.length < 2) return null;
      let sum = 0;
      for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1];
      return { all: { num: sum / 1000, den: ts.length - 1 } };
    },
  },
  {
    id: 'pace.survivor_spread', group: 'pace', version: 1,
    description: 'Average distance in game units between standing survivors.',
    compute: (c) => {
      if (!c.replay || !c.timeline) return null;
      const sum: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
      const n: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
      for (const f of c.replay.frames) {
        const s = liveSurvivors(f);
        if (s.length < 2) continue;
        let d = 0, pairs = 0;
        for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { d += dist2d(s[i], s[j]); pairs++; }
        const mean = d / pairs;
        const p = c.timeline.phaseAt(f.tMs);
        sum.all += mean; n.all++;
        sum[p] += mean; n[p]++;
      }
      if (n.all === 0) return null;
      const out: MetricOut = { all: { num: sum.all, den: n.all } };
      for (const p of SUB_PHASES) if (n[p] > 0) out[p] = { num: sum[p], den: n[p] };
      return out;
    },
  },
];
```

- [ ] **Step 5: Run and see it pass; run the registry test too**

Run: `npx vitest run tests/metrics/outcomesPace.test.ts tests/metrics/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/metrics/defs/outcomes.ts src/metrics/defs/pace.ts tests/metrics/outcomesPace.test.ts
git commit -m "metrics: round outcome and pace metrics"
```

---

### Task 7: Tank and witch metrics

**Files:**
- Modify: `src/metrics/defs/tank.ts`, `src/metrics/defs/witch.ts`
- Test: `tests/metrics/tankWitch.test.ts`

**Interfaces:**
- Consumes: kit, timeline (`witchesIn`, intervals on `c.timeline.tank`).
- Produces ids: `tank.spawns`, `tank.killed_rate`, `tank.lifetime_s`, `tank.damage_per_tank`, `tank.punches_per_tank`, `tank.rocks_per_tank`, `tank.incaps_caused`, `tank.deaths_caused`, `tank.rock_skeets`, `witch.count`, `witch.crown_rate`, `witch.draw_crown_rate`, `witch.startle_rate`, `witch.kill_rate`, `witch.incaps`.

Definitions:
- Tanks in a round = number of `tank_spawn` events (an AI tank passed to a player shows as `tank_take`, not a new tank).
- `tank.lifetime_s`: sum of `c.timeline.tank` interval lengths in seconds over the count of intervals.
- `tank.incaps_caused` / `deaths_caused`: incap / death events (actor = victim survivor, target = attacker) whose target's `classAt` is 5, per tank.
- Stat-based tank metrics (`damage_per_tank` from `dmg_as_tank`, `punches_per_tank` from `tank_punches`) need `hasStats`; `rocks_per_tank` (`tank_rocks_landed`) and `rock_skeets` (`rock_skeets`) need `skillDetect`.
- Witches in a round = count of rising edges of "any witch entity present" across replay frames, merging gaps under 2 s (needs a replay). Without a replay, `witch.count` falls back to `witch_killed` + `witch_aggro` events only when both are 0 or not; to keep it honest: without a replay, witch metrics are null.
- `witch.crown_rate` (`crowns`, survivor side) and `witch.draw_crown_rate` (`draw_crowns`) need `skillDetect`, over witch count.
- `witch.startle_rate`: `witch_aggro` events over witch count. `witch.kill_rate`: `witch_killed` over witch count.
- `witch.incaps`: incap events with a NULL target (no player attacker) that fall in the witch phase, per witch.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/tankWitch.test.ts
import { describe, expect, it } from 'vitest';
import { defs as tank } from '../../src/metrics/defs/tank.js';
import { defs as witch } from '../../src/metrics/defs/witch.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const byId = (id: string) => [...tank, ...witch].find((m) => m.id === id)!;
const run = (id: string, i: RoundInput) => byId(id).compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

const tankReplay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 20_000 && t < 50_000 ? [{ cls: 5 }] : [] })));

describe('tank metrics', () => {
  const events = [ev('tank_spawn', 'i1', 20_000), ev('incap', 's1', 30_000, 'i1'), ev('incap', 's2', 31_000, 'i2'),
    ev('death', 's3', 40_000, 'i1'), ev('tank_death', 's4', 50_000)];

  it('spawns, killed rate and lifetime', () => {
    expect(run('tank.spawns', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', input())).toBeNull();
    expect(run('tank.lifetime_s', input({ replay: tankReplay }))!.all).toEqual({ num: 30, den: 1 });
  });

  it('incaps and deaths caused by the tank player, per tank', () => {
    expect(run('tank.incaps_caused', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.deaths_caused', input({ events }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('damage per tank needs per-round stats', () => {
    const i = input({ events, hasStats: true, stats: stats([['i1', 'dmg_as_tank', 480]]) });
    expect(run('tank.damage_per_tank', i)!.all).toEqual({ num: 480, den: 1 });
    expect(run('tank.damage_per_tank', input({ events }))).toBeNull();
    expect(run('tank.rocks_per_tank', { ...i, skillDetect: false })).toBeNull();
  });
});

describe('witch metrics', () => {
  const witchReplay = replayOf(frames(0, 30_000, (t) => ({ surv: standing4, witch: t >= 5000 && t < 25_000 ? [{ x: 400, y: 0 }] : [] })));

  it('counts witches and rates per witch', () => {
    const i = input({ replay: witchReplay, events: [ev('witch_aggro', 's1', 10_000), ev('witch_killed', 's1', 12_000)],
      hasStats: true, skillDetect: true, stats: stats([['s1', 'crowns', 1]]) });
    expect(run('witch.count', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.startle_rate', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.kill_rate', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.crown_rate', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('counts incaps with no player attacker during the witch phase', () => {
    const i = input({ replay: witchReplay, events: [ev('incap', 's2', 11_000, null), ev('incap', 's3', 28_000, null)] });
    expect(run('witch.incaps', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('is null without a replay or without witches', () => {
    expect(run('witch.count', input())).toBeNull();
    expect(run('witch.startle_rate', input({ replay: tankReplay }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/tankWitch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/defs/tank.ts`**

```ts
import type { MetricDef, RoundCtx } from '../types.js';
import { classAt, kind, ratioByPhase, sideStat, single } from '../kit.js';

const TANK = 5;
const tanks = (c: RoundCtx) => kind(c, 'tank_spawn').length;
const perTank = (num: number, c: RoundCtx) => (tanks(c) > 0 ? single(num, tanks(c)) : null);
const byTank = (c: RoundCtx, k: 'incap' | 'death') =>
  kind(c, k).filter((e) => e.target !== null && e.tMs >= 0 && classAt(c, e.target, e.tMs) === TANK);

export const defs: MetricDef[] = [
  {
    id: 'tank.spawns', group: 'tank', version: 1,
    description: 'Tanks per round.',
    compute: (c) => single(tanks(c)),
  },
  {
    id: 'tank.killed_rate', group: 'tank', version: 1,
    description: 'Share of tanks the survivors killed.',
    compute: (c) => ratioByPhase(c, kind(c, 'tank_death'), kind(c, 'tank_spawn')),
  },
  {
    id: 'tank.lifetime_s', group: 'tank', version: 1,
    description: 'Seconds a tank stayed alive, from spawn to death or round end.',
    compute: (c) => {
      const iv = c.timeline?.tank ?? [];
      if (iv.length === 0) return null;
      return single(iv.reduce((s, x) => s + (x.to - x.from), 0) / 1000, iv.length);
    },
  },
  {
    id: 'tank.damage_per_tank', group: 'tank', version: 1,
    description: 'Damage the tank dealt to survivors, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'dmg_as_tank'), c) : null),
  },
  {
    id: 'tank.punches_per_tank', group: 'tank', version: 1,
    description: 'Tank punches that landed, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'tank_punches'), c) : null),
  },
  {
    id: 'tank.rocks_per_tank', group: 'tank', version: 1,
    description: 'Tank rocks that hit a survivor, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'infected', 'tank_rocks_landed'), c) : null),
  },
  {
    id: 'tank.incaps_caused', group: 'tank', version: 1,
    description: 'Survivor incaps caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'incap').length, c),
  },
  {
    id: 'tank.deaths_caused', group: 'tank', version: 1,
    description: 'Survivor deaths caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'death').length, c),
  },
  {
    id: 'tank.rock_skeets', group: 'tank', version: 1,
    description: 'Tank rocks shot out of the air, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'survivor', 'rock_skeets'), c) : null),
  },
];
```

- [ ] **Step 4: Implement `src/metrics/defs/witch.ts`**

```ts
import type { MetricDef, RoundCtx } from '../types.js';
import { kind, sideStat, single } from '../kit.js';
import { MERGE_GAP_MS, witchesIn } from '../timeline.js';

/** Witch appearances: rising edges of "a witch exists", merged across short gaps. */
export function witchCount(c: RoundCtx): number | null {
  if (!c.replay) return null;
  let n = 0;
  let lastSeen = -Infinity;
  for (const f of c.replay.frames) {
    if (witchesIn(f).length === 0) continue;
    if (f.tMs - lastSeen > MERGE_GAP_MS) n++;
    lastSeen = f.tMs;
  }
  return n;
}

const perWitch = (c: RoundCtx, num: number) => {
  const w = witchCount(c);
  return w ? single(num, w) : null;
};

export const defs: MetricDef[] = [
  {
    id: 'witch.count', group: 'witch', version: 1,
    description: 'Witches per round.',
    compute: (c) => { const w = witchCount(c); return w === null ? null : single(w); },
  },
  {
    id: 'witch.crown_rate', group: 'witch', version: 1,
    description: 'Crowns (one-shot witch kills) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'crowns')) : null),
  },
  {
    id: 'witch.draw_crown_rate', group: 'witch', version: 1,
    description: 'Draw crowns (witch killed after chip damage) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'draw_crowns')) : null),
  },
  {
    id: 'witch.startle_rate', group: 'witch', version: 1,
    description: 'Share of witches that got startled.',
    compute: (c) => perWitch(c, kind(c, 'witch_aggro').length),
  },
  {
    id: 'witch.kill_rate', group: 'witch', version: 1,
    description: 'Share of witches killed.',
    compute: (c) => perWitch(c, kind(c, 'witch_killed').length),
  },
  {
    id: 'witch.incaps', group: 'witch', version: 1,
    description: 'Survivor incaps with no player attacker while a witch was near, per witch.',
    compute: (c) => {
      if (!c.timeline) return null;
      const n = kind(c, 'incap').filter((e) => e.target === null && e.tMs >= 0 && c.timeline!.phaseAt(e.tMs) === 'witch').length;
      return perWitch(c, n);
    },
  },
];
```

- [ ] **Step 5: Run and see it pass; registry test**

Run: `npx vitest run tests/metrics/tankWitch.test.ts tests/metrics/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/metrics/defs/tank.ts src/metrics/defs/witch.ts tests/metrics/tankWitch.test.ts
git commit -m "metrics: tank and witch metrics"
```

---

### Task 8: Special infected metrics (hunter, smoker, boomer, general)

**Files:**
- Modify: `src/metrics/defs/si.ts`
- Test: `tests/metrics/si.test.ts`

**Interfaces:**
- Consumes: kit (`classAt`, `ratioByPhase`, `countByPhase`, `perMinute`, `sideStat`, `kind`, `single`).
- Produces ids: `hunter.spawns`, `hunter.skeet_rate`, `hunter.dp_rate`, `hunter.dp_avg_damage`, `hunter.pounce_rate`, `hunter.damage_per_spawn`, `hunter.lifetime_s`, `smoker.spawns`, `smoker.pull_rate`, `smoker.clear_time_s`, `boomer.spawns`, `boomer.boomed_per_spawn`, `boomer.pop_rate`, `si.pins_per_min`, `si.kills_per_min`, `si.quad_caps`.

Class numbers: smoker 1, boomer 2, hunter 3. A pin (`pinned`, actor = pinner, target = survivor) is a hunter pounce when `classAt(actor, t) === 3`, a smoker pull when `=== 1`. `hunter.lifetime_s` comes from the replay: for each infected slot, intervals where `cls === 3`, ALIVE and not GHOST (a life starts at a rising edge); sum seconds over count of lives. `smoker.clear_time_s`: for each smoker pin, seconds until the next `cleared` event with the same target within 30 s; average over pins that were cleared.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/si.test.ts
import { describe, expect, it } from 'vitest';
import { defs } from '../../src/metrics/defs/si.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const run = (id: string, i: RoundInput) => defs.find((m) => m.id === id)!.compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('special infected metrics', () => {
  const events = [
    ev('si_spawn', 'i1', 1000, null, 3), ev('pinned', 'i1', 2000, 's1'),
    ev('si_spawn', 'i2', 1000, null, 1), ev('pinned', 'i2', 3000, 's2'), ev('cleared', 's3', 7000, 's2'),
    ev('si_spawn', 'i3', 1000, null, 3), ev('skeet', 's1', 4000, 'i3'),
    ev('si_spawn', 'i4', 1000, null, 3), ev('dp', 'i4', 5000, 's3', 20),
    ev('si_spawn', 'i1', 8000, null, 2), ev('boom', 'i1', 9000, 's1'), ev('boom', 'i1', 9000, 's2'),
  ];

  it('hunter rates per hunter spawn', () => {
    expect(run('hunter.spawns', input({ events }))!.all).toEqual({ num: 3, den: 1 });
    expect(run('hunter.skeet_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.dp_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.dp_avg_damage', input({ events }))!.all).toEqual({ num: 20, den: 1 });
    expect(run('hunter.pounce_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
  });

  it('smoker pulls and clear time', () => {
    expect(run('smoker.pull_rate', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('smoker.clear_time_s', input({ events }))!.all).toEqual({ num: 4, den: 1 });
  });

  it('boomer booms per spawn and pops need skill_detect', () => {
    expect(run('boomer.boomed_per_spawn', input({ events }))!.all).toEqual({ num: 2, den: 1 });
    expect(run('boomer.pop_rate', input({ events }))).toBeNull();
    expect(run('boomer.pop_rate', input({ events, hasStats: true, skillDetect: true, stats: stats([['s1', 'boomer_pops', 1]]) }))!.all)
      .toEqual({ num: 1, den: 1 });
  });

  it('hunter lifetime from the replay', () => {
    const replay = replayOf(frames(0, 20_000, (t) => ({ surv: standing4, inf: [{ cls: 3, state: t >= 5000 && t < 9000 ? 3 : 1 | 128 }] })));
    expect(run('hunter.lifetime_s', input({ replay }))!.all).toEqual({ num: 4, den: 1 });
  });

  it('quad caps need per-round stats', () => {
    expect(run('si.quad_caps', input())).toBeNull();
    expect(run('si.quad_caps', input({ hasStats: true, stats: stats([['i1', 'quad_caps', 1]]) }))!.all).toEqual({ num: 1, den: 1 });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/si.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/defs/si.ts`**

```ts
import { STATE } from '../../replayFormat.js';
import type { MetricDef, RoundCtx } from '../types.js';
import { classAt, countByPhase, kind, perMinute, ratioByPhase, sideStat, single } from '../kit.js';

const SMOKER = 1, BOOMER = 2, HUNTER = 3;
const spawnsOf = (c: RoundCtx, cls: number) => kind(c, 'si_spawn').filter((e) => e.value === cls);
const pinsBy = (c: RoundCtx, cls: number) =>
  kind(c, 'pinned').filter((e) => e.tMs >= 0 && classAt(c, e.actor, e.tMs) === cls);
const CLEAR_WINDOW_MS = 30_000;

function lifetimesOf(c: RoundCtx, cls: number): number[] | null {
  if (!c.replay) return null;
  const lives: number[] = [];
  for (let slot = 0; slot < 8; slot++) {
    let start: number | null = null;
    for (const f of c.replay.frames) {
      const p = f.players[slot];
      const up = p.infected === true && p.cls === cls && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0;
      if (up && start === null) start = f.tMs;
      if (!up && start !== null) { lives.push(f.tMs - start); start = null; }
    }
    if (start !== null) lives.push(c.replay.frames[c.replay.frames.length - 1].tMs - start);
  }
  return lives;
}

export const defs: MetricDef[] = [
  { id: 'hunter.spawns', group: 'hunter', version: 1, description: 'Hunter spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, HUNTER)) },
  { id: 'hunter.skeet_rate', group: 'hunter', version: 1, description: 'Skeets per hunter spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'skeet'), spawnsOf(c, HUNTER)) },
  { id: 'hunter.dp_rate', group: 'hunter', version: 1, description: 'Damage pounces per hunter spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'dp'), spawnsOf(c, HUNTER)) },
  { id: 'hunter.dp_avg_damage', group: 'hunter', version: 1, description: 'Average damage of a damage pounce.',
    compute: (c) => ratioByPhase(c, kind(c, 'dp'), kind(c, 'dp'), (e) => e.value) },
  { id: 'hunter.pounce_rate', group: 'hunter', version: 1, description: 'Pounces that pinned a survivor, per hunter spawn.',
    compute: (c) => ratioByPhase(c, pinsBy(c, HUNTER), spawnsOf(c, HUNTER)) },
  { id: 'hunter.damage_per_spawn', group: 'hunter', version: 1, description: 'Damage hunters dealt to standing survivors, per hunter spawn.',
    compute: (c) => {
      const n = spawnsOf(c, HUNTER).length;
      return c.hasStats && n > 0 ? single(sideStat(c, 'infected', 'dmg_as_hunter'), n) : null;
    } },
  { id: 'hunter.lifetime_s', group: 'hunter', version: 1, description: 'Seconds a hunter stayed alive after spawning.',
    compute: (c) => { const l = lifetimesOf(c, HUNTER); return l && l.length ? single(l.reduce((a, b) => a + b, 0) / 1000, l.length) : null; } },
  { id: 'smoker.spawns', group: 'smoker', version: 1, description: 'Smoker spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, SMOKER)) },
  { id: 'smoker.pull_rate', group: 'smoker', version: 1, description: 'Pulls that pinned a survivor, per smoker spawn.',
    compute: (c) => ratioByPhase(c, pinsBy(c, SMOKER), spawnsOf(c, SMOKER)) },
  { id: 'smoker.clear_time_s', group: 'smoker', version: 1, description: 'Seconds until a pulled survivor was freed by a teammate.',
    compute: (c) => {
      const clears = kind(c, 'cleared');
      let sum = 0, n = 0;
      for (const p of pinsBy(c, SMOKER)) {
        const cl = clears.find((e) => e.target === p.target && e.tMs >= p.tMs && e.tMs - p.tMs <= CLEAR_WINDOW_MS);
        if (cl) { sum += cl.tMs - p.tMs; n++; }
      }
      return n ? single(sum / 1000, n) : null;
    } },
  { id: 'boomer.spawns', group: 'boomer', version: 1, description: 'Boomer spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, BOOMER)) },
  { id: 'boomer.boomed_per_spawn', group: 'boomer', version: 1, description: 'Survivors covered in bile, per boomer spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'boom'), spawnsOf(c, BOOMER)) },
  { id: 'boomer.pop_rate', group: 'boomer', version: 1, description: 'Boomers popped before they could vomit, per boomer spawn.',
    compute: (c) => {
      const n = spawnsOf(c, BOOMER).length;
      return c.skillDetect && n > 0 ? single(sideStat(c, 'survivor', 'boomer_pops'), n) : null;
    } },
  { id: 'si.pins_per_min', group: 'si', version: 1, description: 'Pins (pounces and pulls) per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'pinned')) },
  { id: 'si.kills_per_min', group: 'si', version: 1, description: 'Special infected killed by survivors per playing minute.',
    compute: (c) => {
      if (!c.hasStats || !c.timeline) return null;
      const m = c.timeline.minutes('all');
      return m > 0 ? { all: { num: sideStat(c, 'survivor', 'sikill'), den: m } } : null;
    } },
  { id: 'si.quad_caps', group: 'si', version: 1, description: 'Rounds where all four survivors were pinned at once and nobody recovered.',
    compute: (c) => (c.hasStats ? single(sideStat(c, 'infected', 'quad_caps')) : null) },
];
```

- [ ] **Step 4: Run and see it pass; registry test**

Run: `npx vitest run tests/metrics/si.test.ts tests/metrics/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/defs/si.ts tests/metrics/si.test.ts
git commit -m "metrics: hunter, smoker, boomer and general special infected metrics"
```

---

### Task 9: Weapon metrics

**Files:**
- Modify: `src/metrics/defs/weapons.ts`
- Test: `tests/metrics/weapons.test.ts`

**Interfaces:**
- Consumes: `liveSurvivors` (Task 4), kit.
- Produces ids, one per gun for each of three families:
  - `weapons.hold.<w>`: share of standing-survivor time holding weapon `<w>` (replay, phase split).
  - `weapons.si_damage.<w>`: share of survivor SI damage dealt with `<w>` (`w_<w>_sidmg` over the sum of all `w_*_sidmg`, needs `hasStats`).
  - `weapons.tank_damage.<w>`: share of survivor tank damage dealt with `<w>` (`w_<w>_tankdmg`, needs `hasStats`).
  where `<w>` is one of `pistol, smg, pumpshotgun, autoshotgun, rifle, hunting_rifle` (the replay weapon ids 1 to 6 in that order; throwables and meds are not guns).

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/weapons.test.ts
import { describe, expect, it } from 'vitest';
import { defs, GUNS } from '../../src/metrics/defs/weapons.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { frames, input, replayOf, stats } from './fixtures.js';

const run = (id: string, i: RoundInput) => defs.find((m) => m.id === id)!.compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('weapon metrics', () => {
  it('defines three families for six guns', () => {
    expect(GUNS).toEqual(['pistol', 'smg', 'pumpshotgun', 'autoshotgun', 'rifle', 'hunting_rifle']);
    expect(defs).toHaveLength(18);
  });

  it('hold share over standing survivor time', () => {
    const replay = replayOf(frames(0, 1000, () => ({ surv: [{ x: 0, y: 0, weapon: 3 }, { x: 1, y: 0, weapon: 2 }, { x: 2, y: 0, weapon: 3 }, { x: 3, y: 0, weapon: 3 }] })));
    const out = run('weapons.hold.pumpshotgun', input({ replay }))!;
    expect(out.all!.num / out.all!.den).toBeCloseTo(0.75, 5);
    expect(run('weapons.hold.smg', input({ replay }))!.all!.num / run('weapons.hold.smg', input({ replay }))!.all!.den).toBeCloseTo(0.25, 5);
  });

  it('damage share from per-round weapon stats', () => {
    const i = input({ hasStats: true, stats: stats([['s1', 'w_pumpshotgun_sidmg', 300], ['s2', 'w_smg_sidmg', 100], ['i1', 'w_smg_sidmg', 999]]) });
    expect(run('weapons.si_damage.pumpshotgun', i)!.all).toEqual({ num: 300, den: 400 });
    expect(run('weapons.si_damage.rifle', i)!.all).toEqual({ num: 0, den: 400 });
    expect(run('weapons.tank_damage.rifle', i)).toBeNull();
    expect(run('weapons.si_damage.smg', input())).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/weapons.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/defs/weapons.ts`**

```ts
import type { MetricDef, MetricOut, Phase, RoundCtx } from '../types.js';
import { SUB_PHASES } from '../types.js';
import { sideStat } from '../kit.js';
import { liveSurvivors } from '../timeline.js';

/** Replay weapon ids 1 to 6, in id order. */
export const GUNS = ['pistol', 'smg', 'pumpshotgun', 'autoshotgun', 'rifle', 'hunting_rifle'] as const;
const LABEL: Record<(typeof GUNS)[number], string> = {
  pistol: 'pistols', smg: 'the Uzi', pumpshotgun: 'the pump shotgun', autoshotgun: 'the auto shotgun',
  rifle: 'the assault rifle', hunting_rifle: 'the hunting rifle',
};

function holdShare(c: RoundCtx, id: number): MetricOut | null {
  if (!c.replay || !c.timeline) return null;
  const held: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  const total: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
  for (const f of c.replay.frames) {
    const p = c.timeline.phaseAt(f.tMs);
    for (const s of liveSurvivors(f)) {
      total.all++; total[p]++;
      if (s.weapon === id) { held.all++; held[p]++; }
    }
  }
  if (total.all === 0) return null;
  const out: MetricOut = { all: { num: held.all, den: total.all } };
  for (const p of SUB_PHASES) if (total[p] > 0) out[p] = { num: held[p], den: total[p] };
  return out;
}

function damageShare(c: RoundCtx, gun: string, suffix: 'sidmg' | 'tankdmg'): MetricOut | null {
  if (!c.hasStats) return null;
  const all = GUNS.reduce((s, g) => s + sideStat(c, 'survivor', `w_${g}_${suffix}`), 0)
    + sideStat(c, 'survivor', `w_other_${suffix}`)
    + sideStat(c, 'survivor', `w_molotov_${suffix}`) + sideStat(c, 'survivor', `w_pipe_bomb_${suffix}`);
  if (all === 0) return null;
  return { all: { num: sideStat(c, 'survivor', `w_${gun}_${suffix}`), den: all } };
}

export const defs: MetricDef[] = GUNS.flatMap((g, i) => [
  { id: `weapons.hold.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of standing survivor time spent holding ${LABEL[g]}.`,
    compute: (c: RoundCtx) => holdShare(c, i + 1) },
  { id: `weapons.si_damage.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of survivor damage to special infected dealt with ${LABEL[g]}.`,
    compute: (c: RoundCtx) => damageShare(c, g, 'sidmg') },
  { id: `weapons.tank_damage.${g}`, group: 'weapons' as const, version: 1,
    description: `Share of survivor damage to the tank dealt with ${LABEL[g]}.`,
    compute: (c: RoundCtx) => damageShare(c, g, 'tankdmg') },
]);
```

- [ ] **Step 4: Run and see it pass; registry and full metrics tests**

Run: `npx vitest run tests/metrics`
Expected: PASS (all metrics files).

- [ ] **Step 5: Commit**

```bash
git add src/metrics/defs/weapons.ts tests/metrics/weapons.test.ts
git commit -m "metrics: weapon hold share and damage share per gun"
```

---

### Task 10: Context and store

**Files:**
- Create: `src/metrics/store.ts`
- Test: `tests/metrics/store.test.ts`

**Interfaces:**
- Consumes: `MetricRow`, `ENGINE` (Task 5), tables (Task 1).
- Produces:
  - `roundContext(db: DB, key: RoundKey): { map: string | null; origin: string | null; serverId: number | null; patchId: number | null; survMu: number | null; infMu: number | null }`
  - `writeRoundMetrics(db: DB, key: RoundKey, rows: MetricRow[], meta: { hasReplay: boolean; hasStats: boolean; engine: string; now?: string }): void` (one transaction: delete the round's old rows, insert new rows, upsert the context row)

Facts: map for a finished match is `match_maps.map` at `ordinal` (`match_live_maps` is cleared when a match completes); origin and server from `matches`; patch from `match_rounds.patch_id`; ratings from `rating_history.mu_before` joined to `match_players.team` for this match (rated players only; null when a side has none). Survivor side for the round is `match_rounds.surv_team`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/store.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { roundContext, writeRoundMetrics } from '../../src/metrics/store.js';

const A = '76561198000000001', B = '76561198000000002';
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  for (const p of [A, B]) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(p, p);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin) VALUES (1, 1, 'completed', 'x', 'queue')").run();
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (1, ?, 'a'), (1, ?, 'b')").run(A, B);
  db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (1, 0, 'l4d_vs_hospital01_apartment')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'b')").run();
  db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, 1, 1, 30, 5, 31, 5), (?, 1, 1, 20, 5, 19, 5)').run(A, B);
  return db;
}

describe('metrics store', () => {
  it('builds the round context with survivor and infected side ratings', () => {
    const ctx = roundContext(setup(), { matchId: 1, ordinal: 0, half: 1 });
    expect(ctx).toMatchObject({ map: 'l4d_vs_hospital01_apartment', origin: 'queue', survMu: 20, infMu: 30 });
  });

  it('replaces a round atomically', () => {
    const db = setup();
    const key = { matchId: 1, ordinal: 0, half: 1 as const };
    writeRoundMetrics(db, key, [{ metric: 'a.x', phase: 'all', num: 1, den: 1 }, { metric: 'a.y', phase: 'tank', num: 2, den: 3 }],
      { hasReplay: true, hasStats: false, engine: 'e1', now: '2026-09-23 10:00:00' });
    writeRoundMetrics(db, key, [{ metric: 'a.x', phase: 'all', num: 5, den: 1 }],
      { hasReplay: false, hasStats: true, engine: 'e2', now: '2026-09-23 11:00:00' });
    expect(db.prepare('SELECT metric, phase, num FROM round_metrics').all()).toEqual([{ metric: 'a.x', phase: 'all', num: 5 }]);
    expect(db.prepare('SELECT has_replay, has_stats, engine, map, surv_mu FROM round_metric_context').get())
      .toEqual({ has_replay: 0, has_stats: 1, engine: 'e2', map: 'l4d_vs_hospital01_apartment', surv_mu: 20 });
  });
});
```

If `rating_history` needs an explicit `id` or other NOT NULL columns, match `src/db.ts:171-181`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/store.ts`**

```ts
import type { DB } from '../db.js';
import type { MetricRow } from './registry.js';
import type { RoundKey } from './types.js';

export interface RoundContext {
  map: string | null; origin: string | null; serverId: number | null; patchId: number | null;
  survMu: number | null; infMu: number | null;
}

export function roundContext(db: DB, key: RoundKey): RoundContext {
  const m = db.prepare('SELECT origin, server_id FROM matches WHERE id = ?').get(key.matchId) as
    { origin: string | null; server_id: number | null } | undefined;
  const map = (db.prepare('SELECT map FROM match_maps WHERE match_id = ? AND ordinal = ?')
    .get(key.matchId, key.ordinal) as { map: string } | undefined)?.map ?? null;
  const r = db.prepare('SELECT surv_team, patch_id FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(key.matchId, key.ordinal, key.half) as { surv_team: 'a' | 'b'; patch_id: number | null } | undefined;
  const mu = db.prepare(`SELECT mp.team AS team, AVG(rh.mu_before) AS mu FROM rating_history rh
    JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
    WHERE rh.match_id = ? GROUP BY mp.team`).all(key.matchId) as { team: 'a' | 'b'; mu: number }[];
  const muOf = (t: 'a' | 'b') => mu.find((x) => x.team === t)?.mu ?? null;
  const surv = r?.surv_team ?? null;
  return {
    map, origin: m?.origin ?? null, serverId: m?.server_id ?? null, patchId: r?.patch_id ?? null,
    survMu: surv ? muOf(surv) : null, infMu: surv ? muOf(surv === 'a' ? 'b' : 'a') : null,
  };
}

export function writeRoundMetrics(db: DB, key: RoundKey, rows: MetricRow[],
  meta: { hasReplay: boolean; hasStats: boolean; engine: string; now?: string }): void {
  const now = meta.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ctx = roundContext(db, key);
  db.transaction(() => {
    db.prepare('DELETE FROM round_metrics WHERE match_id = ? AND ordinal = ? AND half = ?').run(key.matchId, key.ordinal, key.half);
    const ins = db.prepare('INSERT INTO round_metrics (match_id, ordinal, half, metric, phase, num, den) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(key.matchId, key.ordinal, key.half, r.metric, r.phase, r.num, r.den);
    db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, server_id, patch_id, surv_mu, inf_mu,
                  has_replay, has_stats, engine, computed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (match_id, ordinal, half) DO UPDATE SET map = excluded.map, origin = excluded.origin,
                  server_id = excluded.server_id, patch_id = excluded.patch_id, surv_mu = excluded.surv_mu, inf_mu = excluded.inf_mu,
                  has_replay = excluded.has_replay, has_stats = excluded.has_stats, engine = excluded.engine,
                  computed_at = excluded.computed_at`)
      .run(key.matchId, key.ordinal, key.half, ctx.map, ctx.origin, ctx.serverId, ctx.patchId, ctx.survMu, ctx.infMu,
        meta.hasReplay ? 1 : 0, meta.hasStats ? 1 : 0, meta.engine, now);
  })();
}
```

- [ ] **Step 4: Run and see it pass**

Run: `npx vitest run tests/metrics/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/store.ts tests/metrics/store.test.ts
git commit -m "metrics: round context (map, origin, patch, side ratings) and atomic writes"
```

---

### Task 11: Job and reaper step

**Files:**
- Create: `src/metrics/job.ts`
- Modify: `src/server.ts` (the 60 s reaper, ~:1138-1171; add one try/catch step)
- Test: `tests/metrics/job.test.ts`

**Interfaces:**
- Consumes: `loadRoundInput` (Task 2), `loadRoundReplay` (Task 3), `computeRound`, `ENGINE` (Task 5), `writeRoundMetrics` (Task 10).
- Produces:
  - `pendingRounds(db: DB, opts: { engine: string; replayWaitMin: number; limit: number; now?: string }): RoundKey[]`
  - `runMetricsPass(db: DB, replayDir: string, opts: { limit: number; replayWaitMin?: number; now?: string; load?: (key: RoundKey) => RoundReplay | null }): { computed: number }`
  - Constants `REAPER_ROUNDS_PER_TICK = 2`, `REPLAY_WAIT_MIN = 30`.

Selection rule (`pendingRounds`): rounds of matches with `state = 'completed'` and `voided_at IS NULL`, whose round row has `ended_at IS NOT NULL`, and where either no context row exists, or `engine != current`, or (`has_replay = 0` and a `match_replays` row with `pruned_at IS NULL` now exists). A round whose replay row is missing is only picked once its match's `ended_at` is more than `replayWaitMin` minutes old (remote servers' files arrive by a 2-minute pull). Order: oldest match first, then ordinal, half. `limit` caps the result.

Reaper rule: skip entirely while any match is `live` or `configuring` (decoding blocks the event loop); otherwise `runMetricsPass(db, config.replayDir, { limit: REAPER_ROUNDS_PER_TICK })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/job.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { pendingRounds, runMetricsPass } from '../../src/metrics/job.js';
import { ENGINE } from '../../src/metrics/registry.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES
    (1, 1, 'completed', 'x', '2026-09-23 08:00:00'),
    (2, 1, 'completed', 'x', '2026-09-23 09:50:00'),
    (3, 1, 'live', 'x', NULL),
    (4, 1, 'aborted', 'x', '2026-09-23 07:00:00')`).run();
  const r = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at, survivors_alive) VALUES (?, 0, ?, 'a', 100, '2026-09-23 07:00:00', '2026-09-23 07:10:00', 1)");
  for (const m of [1, 2, 3, 4]) { r.run(m, 1); r.run(m, 2); }
  return db;
}
const NOW = '2026-09-23 10:00:00';

describe('metrics job', () => {
  it('picks completed, unvoided matches and waits for a recent match replay', () => {
    const keys = pendingRounds(setup(), { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW });
    expect(keys.map((k) => `${k.matchId}/${k.half}`)).toEqual(['1/1', '1/2']);
  });

  it('takes a recent match once its replay row exists', () => {
    const db = setup();
    db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (2, 0, 1, 'f', 1, 1, 10)").run();
    const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW });
    expect(keys.map((k) => `${k.matchId}/${k.half}`)).toEqual(['1/1', '1/2', '2/1']);
  });

  it('computes, then skips until the engine changes', () => {
    const db = setup();
    const r1 = runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    expect(r1.computed).toBe(2);
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW })).toEqual([]);
    expect(pendingRounds(db, { engine: ENGINE + ',new.metric:1', replayWaitMin: 30, limit: 10, now: NOW })).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM round_metrics WHERE metric = 'round.saferoom'").get()).toEqual({ n: 2 });
  });

  it('recomputes a round whose replay arrived after it was computed', () => {
    const db = setup();
    runMetricsPass(db, '', { limit: 10, now: NOW, load: () => null });
    db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, 0, 2, 'f', 1, 1, 10)").run();
    expect(pendingRounds(db, { engine: ENGINE, replayWaitMin: 30, limit: 10, now: NOW }).map((k) => k.half)).toEqual([2]);
  });

  it('respects the limit', () => {
    expect(pendingRounds(setup(), { engine: ENGINE, replayWaitMin: 30, limit: 1, now: NOW })).toHaveLength(1);
  });
});
```

Check the `match_replays` NOT NULL columns in `src/db.ts:315-325` and adjust the inserts if needed.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/job.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/job.ts`**

```ts
import type { DB } from '../db.js';
import { loadRoundInput } from './loadRound.js';
import { loadRoundReplay } from './replayRound.js';
import { computeRound, ENGINE } from './registry.js';
import { writeRoundMetrics } from './store.js';
import type { RoundKey, RoundReplay } from './types.js';

export const REAPER_ROUNDS_PER_TICK = 2;
export const REPLAY_WAIT_MIN = 30;

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function pendingRounds(db: DB, opts: { engine: string; replayWaitMin: number; limit: number; now?: string }): RoundKey[] {
  const now = opts.now ?? sqliteNow();
  return (db.prepare(`
    SELECT r.match_id AS matchId, r.ordinal AS ordinal, r.half AS half
    FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    LEFT JOIN round_metric_context c ON c.match_id = r.match_id AND c.ordinal = r.ordinal AND c.half = r.half
    LEFT JOIN match_replays rp ON rp.match_id = r.match_id AND rp.ordinal = r.ordinal AND rp.half = r.half AND rp.pruned_at IS NULL
    WHERE m.state = 'completed' AND m.voided_at IS NULL AND r.ended_at IS NOT NULL
      AND (c.match_id IS NULL OR c.engine != ? OR (c.has_replay = 0 AND rp.match_id IS NOT NULL))
      AND (rp.match_id IS NOT NULL OR m.ended_at <= datetime(?, '-' || ? || ' minutes'))
    ORDER BY m.ended_at, r.match_id, r.ordinal, r.half
    LIMIT ?`).all(opts.engine, now, opts.replayWaitMin, opts.limit) as RoundKey[]);
}

export function runMetricsPass(db: DB, replayDir: string, opts: {
  limit: number; replayWaitMin?: number; now?: string; load?: (key: RoundKey) => RoundReplay | null;
}): { computed: number } {
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: opts.replayWaitMin ?? REPLAY_WAIT_MIN, limit: opts.limit, now: opts.now });
  let computed = 0;
  for (const key of keys) {
    const base = loadRoundInput(db, key);
    if (!base) continue;
    const replay = load(key);
    const rows = computeRound({ ...base, replay });
    writeRoundMetrics(db, key, rows, { hasReplay: replay !== null, hasStats: base.hasStats, engine: ENGINE, now: opts.now });
    computed++;
  }
  return { computed };
}

/** True while a match could be using the event loop for live ingestion. */
export function matchActive(db: DB): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring')").get() as { n: number }).n > 0;
}
```

Note: `m.ended_at` is written by `completeMatch`; check its format in `src/matchResult.ts` (SQLite `datetime('now')` or ISO). If ISO (`T` separator), compare with `datetime(m.ended_at)` in the SQL so both sides are SQLite format, and add a test row in ISO form.

- [ ] **Step 4: Wire the reaper in `src/server.ts`**

Inside the 60 s reaper, as its own step next to the integrity step, following the existing try/catch-per-step pattern:

```ts
      // Balance metrics: a couple of rounds per minute, never while a match
      // is running (decoding a replay blocks the event loop). History is
      // filled by scripts/backfill-round-metrics.ts.
      try {
        if (!matchActive(deps.db)) runMetricsPass(deps.db, deps.config.replayDir, { limit: REAPER_ROUNDS_PER_TICK });
      } catch (err) {
        console.error('[metrics] pass failed', err);
      }
```

Import `matchActive`, `runMetricsPass`, `REAPER_ROUNDS_PER_TICK` from `./metrics/job.js`. Match the variable names the reaper actually uses for the DB and config.

- [ ] **Step 5: Run the job test, typecheck, full suite**

Run: `npx vitest run tests/metrics && npm run typecheck && npx vitest run`
Expected: PASS (the full suite may show the known flaky `tests/server.test.ts` malformed-URL case; nothing else).

- [ ] **Step 6: Commit**

```bash
git add src/metrics/job.ts src/server.ts tests/metrics/job.test.ts
git commit -m "metrics: pending-round job and a reaper step when no match is live"
```

---

### Task 12: Backfill CLI and production dry run

**Files:**
- Create: `scripts/backfill-round-metrics.ts`
- Create: `src/metrics/summary.ts` (pooled numbers per patch, for the CLI and as a seed for piece 3)
- Test: `tests/metrics/summary.test.ts`

**Interfaces:**
- Consumes: `runMetricsPass` (Task 11), tables.
- Produces: `summarizeByPatch(db: DB, metrics: string[], phase?: Phase): { patchId: number | null; patchName: string | null; metric: string; rounds: number; value: number }[]` where `value = SUM(num) / SUM(den)` over rounds of completed, unvoided matches, grouped by `round_metric_context.patch_id` joined to `balance_patches.name`.

- [ ] **Step 1: Write the failing summary test**

```ts
// tests/metrics/summary.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { summarizeByPatch } from '../../src/metrics/summary.js';

describe('summarizeByPatch', () => {
  it('pools num over den per patch', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (7, 'Baseline', 'historical', '2000-01-01 00:00:00')").run();
    const ctx = db.prepare("INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at) VALUES (1, ?, ?, 7, 0, 0, 'e', 'n')");
    const row = db.prepare("INSERT INTO round_metrics VALUES (1, ?, ?, 'round.saferoom', 'all', ?, 1)");
    ctx.run(0, 1); row.run(0, 1, 1);
    ctx.run(0, 2); row.run(0, 2, 0);
    ctx.run(1, 1); row.run(1, 1, 1);
    expect(summarizeByPatch(db, ['round.saferoom'])).toEqual([
      { patchId: 7, patchName: 'Baseline', metric: 'round.saferoom', rounds: 3, value: 2 / 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/metrics/summary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/metrics/summary.ts`**

```ts
import type { DB } from '../db.js';
import type { Phase } from './types.js';

export function summarizeByPatch(db: DB, metrics: string[], phase: Phase = 'all') {
  if (metrics.length === 0) return [];
  const marks = metrics.map(() => '?').join(',');
  return db.prepare(`
    SELECT c.patch_id AS patchId, p.name AS patchName, rm.metric AS metric,
           COUNT(*) AS rounds, SUM(rm.num) / SUM(rm.den) AS value
    FROM round_metrics rm
    JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
    JOIN matches m ON m.id = rm.match_id
    LEFT JOIN balance_patches p ON p.id = c.patch_id
    WHERE rm.phase = ? AND rm.metric IN (${marks}) AND m.state = 'completed' AND m.voided_at IS NULL
    GROUP BY c.patch_id, rm.metric
    ORDER BY MIN(p.first_seen_at), rm.metric`).all(phase, ...metrics) as
    { patchId: number | null; patchName: string | null; metric: string; rounds: number; value: number }[];
}
```

- [ ] **Step 4: Implement `scripts/backfill-round-metrics.ts`**

```ts
import { openDb } from '../src/db.js';
import { runMetricsPass } from '../src/metrics/job.js';
import { summarizeByPatch } from '../src/metrics/summary.js';

const [dbPath, replayDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!dbPath) {
  console.error('usage: tsx scripts/backfill-round-metrics.ts <pug.db> <replayDir> [--apply]');
  process.exit(2);
}
const db = openDb(dbPath);
const t0 = Date.now();
let total = 0;
const work = () => {
  for (;;) {
    const { computed } = runMetricsPass(db, replayDir ?? '', { limit: 50, replayWaitMin: 0 });
    total += computed;
    if (computed === 0) break;
    process.stdout.write(`\r${total} rounds`);
  }
};
if (apply) work();
else {
  // Dry run: compute inside a transaction and roll it back.
  try { db.transaction(() => { work(); throw new Error('dry run'); })(); } catch (e) { if ((e as Error).message !== 'dry run') throw e; }
}
console.log(`\n${apply ? 'applied' : 'dry run'}: ${total} rounds in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (apply) {
  const rows = summarizeByPatch(db, ['round.saferoom', 'tank.killed_rate', 'hunter.skeet_rate', 'witch.startle_rate', 'round.length_min']);
  for (const r of rows) console.log(`${(r.patchName ?? 'untagged').padEnd(36)} ${r.metric.padEnd(22)} rounds ${String(r.rounds).padStart(4)}  ${r.value.toFixed(3)}`);
}
```

Note: in the dry run the summary is not printed because the rows are rolled back; to preview numbers, run with `--apply` against a COPY of the database (Step 6).

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/metrics && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Dry run and a real run against a LOCAL COPY of production (read-only on the box)**

```bash
mkdir -p /tmp/claude-1000/metrics-dry && cd /tmp/claude-1000/metrics-dry
scp root@45.32.199.85:/home/pug/app/data/pug.db ./pug.db
scp root@45.32.199.85:/home/pug/app/data/pug.db-wal ./pug.db-wal 2>/dev/null || true
# Replays: copy a sample of up to 40 files to keep this small, named as on the box.
ssh root@45.32.199.85 'grep -E "^REPLAY_DIR=" /home/pug/app/.env'
# then rsync -a root@45.32.199.85:<REPLAY_DIR>/ ./replays/ --include 'pug_*.rpl' ... (limit to the newest 40 by mtime)
cd /home/volence/l4d/pug/.claude/worktrees/balance-metrics
npx tsx scripts/backfill-round-metrics.ts /tmp/claude-1000/metrics-dry/pug.db /tmp/claude-1000/metrics-dry/replays
npx tsx scripts/backfill-round-metrics.ts /tmp/claude-1000/metrics-dry/pug.db /tmp/claude-1000/metrics-dry/replays --apply
```

Never write to the box. Record in the report: rounds computed, seconds taken (and per-round time for rounds with a replay), how many rounds had `has_replay = 1`, the printed per-patch summary, and 3 rounds spot-checked by opening their replay in the site's viewer (or `scripts/dump-replay.ts`) and confirming `tank.lifetime_s` and `witch.count` look right. Delete the copy afterwards (player data).

- [ ] **Step 7: Commit**

```bash
git add scripts/backfill-round-metrics.ts src/metrics/summary.ts tests/metrics/summary.test.ts
git commit -m "metrics: backfill CLI and per-patch summary"
```

---

## Ship notes (not a task; for the owner's go-ahead later)

Deploy order: back up the DB, `deploy-web.sh` (creates the two tables; the reaper starts computing 2 rounds per minute when no match is live), then run `npx tsx scripts/backfill-round-metrics.ts /home/pug/app/data/pug.db <REPLAY_DIR> --apply` on the box once, ideally when no match is live. No plugin change.

## Self-review notes

- Spec coverage: unit and storage (Tasks 1, 10), numerator/denominator (all), context row with map, game type, server, patch, side ratings (Task 10), job with replay wait and missing-as-absent (Task 11), registry with id/group/description/version and recompute on version bump (Tasks 5, 11), phases tank/witch/normal/event (Task 4), catalogue groups 1 to 7 (Tasks 6 to 9), backfill (Task 12). Deviations listed at the top.
- Types: `RoundCtx`, `MetricOut`, `RoundKey`, `MetricRow`, `ENGINE` used consistently across tasks.
