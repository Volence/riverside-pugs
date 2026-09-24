import type { DB } from './db.js';
import { getSetting } from './settings.js';
import {
  DEFAULT_THRESHOLDS, MAX_HOLDS, MAX_RATE_CEILING, MIN_RATE_FLOOR, SIGNATURES, burstStats, decodeIntervals,
  encodeIntervals, holdAnnotation, holdStats, isWheel, matchDetections, mostlySteady, STEADY_TAPS,
  type HoldAnnotation, type HoldStats, type Thresholds,
} from './inputStats.js';

/**
 * Storage for input bursts and the signatures that fire on them.
 *
 * Design: docs/superpowers/specs/2026-09-21-input-macro-detection-design.md
 *
 * A burst is evidence for an admin, never an accusation and never shown to
 * players. A detection is ONE row per player, match and signature, produced
 * only once the signature has repeated across separate bursts in that match,
 * and always severity 'low': it says "watch this replay", not "this player
 * cheated".
 */

const SEVERITY = 'low';

/** One int setting, presses per second. Falls back to the default for an
 *  absent, nonsense or humanly reachable value rather than disabling or
 *  weaponising the signature. */
function rateSetting(db: DB, key: string, fallback: number): number {
  const raw = Number(getSetting(db, key));
  return Number.isFinite(raw) && raw >= MIN_RATE_FLOOR && raw <= MAX_RATE_CEILING ? Math.floor(raw) : fallback;
}

/**
 * Thresholds from settings, so one can be raised without a deploy if a real
 * match ever shows a legitimate player above it.
 *
 * NOT `input_pounce_spam_threshold`. That key was seeded into production as 12,
 * meaning 12 TICKS, and seeding never overwrites an existing row, so changing
 * its default would have changed nothing on the live site. The unit changed
 * too (ticks to presses/s), so it gets a new key and the old row is ignored.
 */
export function inputThresholds(db: DB): Thresholds {
  return {
    pounceMinRate: rateSetting(db, 'input_pounce_min_rate', DEFAULT_THRESHOLDS.pounceMinRate),
    pistolMinRate: rateSetting(db, 'input_pistol_min_rate', DEFAULT_THRESHOLDS.pistolMinRate),
  };
}

export interface InputBurstInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  kind: 'fire' | 'pounce' | 'bhop';
  weapon: string;
  airPresses: number;
  groundTicks: number;
  serverTick: number;
  clientTick: number;
  intervals: number[];
  /** 1: plugin 0.1.0, intervals in SERVER TICKS. 2: intervals in USERCMDS,
   *  which is what a press rate actually is. Absent means 1. */
  wire?: 1 | 2;
  /** Server ticks from the first press to the last; wire 2 only. Against the
   *  sum of the intervals it shows lag bunching, or a client lying about its
   *  command numbers. */
  serverSpan?: number | null;
  /** How long each press was held, one per press. Null from plugin 0.1.0. */
  holds?: number[] | null;
}

export interface StoredBurst {
  id: number;
  /** Signatures this burst COMPLETED: the detection row did not exist before
   *  it. Later qualifying bursts count on that row and are not news. */
  detections: string[];
  /** The same, with what the holds across the evidence look like. */
  created: { signature: string; note: string }[];
}

/** Store one burst and run the shipped signatures over its player's match. */
export function recordInputBurst(
  db: DB, b: InputBurstInput, thresholds: Thresholds = DEFAULT_THRESHOLDS, now = new Date(),
): StoredBurst {
  const iso = now.toISOString();
  // encodeIntervals, never a local copy: this had its own inlined base and
  // silently drifted when the alphabet changed, so every stored burst decoded
  // to nothing on re-run and the signatures found zero.
  const encoded = encodeIntervals(b.intervals);
  const info = db.prepare(
    `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks,
       air_presses, server_tick, client_tick, intervals, at, wire, server_span, holds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.matchId, b.serverId, b.steamid, b.kind, b.weapon, b.intervals.length,
        b.groundTicks, b.airPresses, b.serverTick, b.clientTick, encoded, iso,
        b.wire ?? 1, b.serverSpan ?? null, b.holds ? encodeIntervals(b.holds) : null);
  const id = Number(info.lastInsertRowid);
  // A repeat needs a match to repeat within, and the group query below is only
  // worth running when this burst could have moved a count.
  if (b.matchId === null || !SIGNATURES.some((s) => s.qualifies(b, thresholds))) {
    return { id, detections: [], created: [] };
  }
  const created = evaluateGroup(db, b.matchId, b.steamid, thresholds);
  return { id, detections: created.map((c) => c.signature), created };
}

interface GroupRow {
  id: number; kind: string; weapon: string; intervals: string; at: string; wire: number; holds: string | null;
}

/**
 * What the holds across a detection's evidence look like, plus a warning when
 * any of it came from plugin 0.1.0: those bursts have no holds, were timed by
 * server tick, and were captured before ghosts were excluded, so a pounce
 * burst among them may be spawn mashing.
 */
function evidenceNote(
  evidence: readonly { wire: number; holds: string | null; intervals: readonly number[] }[],
): string {
  const all: number[] = [];
  for (const e of evidence) all.push(...(e.holds ? decodeIntervals(e.holds, MAX_HOLDS) ?? [] : []));
  let note: string = holdAnnotation(all);
  // Wheel binds are legal, a fixed-rate tapper is not: see STEADY_TAPS.
  if (note === 'wheel-like' && mostlySteady(evidence.map((e) => e.intervals))) note = STEADY_TAPS;
  return evidence.some((e) => e.wire === 1) ? `${note}, plugin 0.1.0 capture` : note;
}

/**
 * Bring one player's detections in one match in line with their stored
 * bursts. Returns the signatures whose row was CREATED by this call.
 */
function evaluateGroup(
  db: DB, matchId: number, steamid: string, thresholds: Thresholds,
): { signature: string; note: string }[] {
  const rows = db.prepare(
    `SELECT id, kind, weapon, intervals, at, wire, holds FROM input_bursts
     WHERE match_id = ? AND steamid = ? ORDER BY id`,
  ).all(matchId, steamid) as GroupRow[];
  const bursts = rows.flatMap((r) => {
    const intervals = decodeIntervals(String(r.intervals));
    return intervals ? [{ ...r, intervals }] : [];
  });
  const created: { signature: string; note: string }[] = [];
  for (const d of matchDetections(bursts, thresholds)) {
    const sig = SIGNATURES.find((s) => s.name === d.signature)!;
    const evidence = d.qualifying.map((i) => bursts[i]);
    // The burst that COMPLETED the repeat count dates and anchors the row, so
    // a rebuild from history lands on the same burst and the same time.
    const completing = evidence[sig.repeats - 1];
    const ids = JSON.stringify(evidence.map((e) => e.id));
    const note = evidenceNote(evidence);
    const existing = db.prepare(
      'SELECT id, note FROM input_detections WHERE match_id = ? AND steamid = ? AND signature = ?',
    ).get(matchId, steamid, d.signature) as { id: number; note: string } | undefined;
    if (existing) {
      db.prepare('UPDATE input_detections SET hits = ?, evidence = ?, note = ? WHERE id = ?')
        .run(evidence.length, ids, note, existing.id);
      // Created as a scroll wheel, so nobody was told; the holds have since
      // stopped looking like one, which makes it news for the first time.
      if (isWheel(existing.note) && !isWheel(note)) created.push({ signature: d.signature, note });
      continue;
    }
    db.prepare(
      `INSERT INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at, hits, evidence, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(completing.id, matchId, steamid, completing.kind, d.signature, SEVERITY, completing.at,
          evidence.length, ids, note);
    created.push({ signature: d.signature, note });
  }
  return created;
}

/** One qualifying burst, summarised for the admin panel. */
export interface EvidenceBurst {
  id: number;
  at: string;
  weapon: string;
  presses: number;
  ratePerSec: number;
  meanTicks: number;
  /** 1: timed by server tick (plugin 0.1.0). 2: timed by usercmd. */
  wire: number;
  /** Server ticks the burst spanned, to set against presses and rate. */
  serverSpan: number | null;
  hold: HoldStats | null;
  annotation: HoldAnnotation;
}

export interface DetectionRow {
  id: number; burstId: number; matchId: number | null; steamid: string;
  kind: string; signature: string; severity: string; at: string;
  /** Bursts that qualified, in this match, so far. */
  hits: number;
  /** Their ids. */
  evidence: number[];
  /** What the holds across all of them look like. An annotation, not a verdict. */
  note: string;
  /** The first EVIDENCE_SHOWN of them, summarised. */
  bursts: EvidenceBurst[];
}

const EVIDENCE_SHOWN = 12;

export function detectionsForPlayer(db: DB, steamid: string, limit = 50): DetectionRow[] {
  const rows = db.prepare(
    `SELECT id, burst_id AS burstId, match_id AS matchId, steamid, kind, signature, severity, at, hits, evidence, note
     FROM input_detections WHERE steamid = ? ORDER BY at DESC LIMIT ?`,
  ).all(steamid, limit) as (Omit<DetectionRow, 'evidence' | 'bursts'> & { evidence: string })[];
  return rows.map((r) => {
    const evidence = parseIds(r.evidence);
    return { ...r, evidence, bursts: evidenceBursts(db, evidence.slice(0, EVIDENCE_SHOWN)) };
  });
}

function evidenceBursts(db: DB, ids: readonly number[]): EvidenceBurst[] {
  if (ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT id, at, weapon, intervals, wire, server_span AS serverSpan, holds
     FROM input_bursts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
  ).all(...ids) as { id: number; at: string; weapon: string; intervals: string; wire: number; serverSpan: number | null; holds: string | null }[];
  return rows.map((r) => {
    const stats = burstStats(decodeIntervals(String(r.intervals)) ?? []);
    const holds = r.holds ? decodeIntervals(r.holds, MAX_HOLDS) : null;
    return {
      id: r.id, at: r.at, weapon: r.weapon, presses: stats.n + 1,
      ratePerSec: stats.ratePerSec, meanTicks: stats.meanTicks,
      wire: r.wire, serverSpan: r.serverSpan, hold: holdStats(holds), annotation: holdAnnotation(holds),
    };
  });
}

function parseIds(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export interface InputCapInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  kind: 'fire' | 'pounce' | 'bhop';
  serverTick: number;
}

/** The plugin ran out of budget for one kind of burst, for one player, this
 *  round. Stored so an admin reading a quiet player sees "capture truncated"
 *  rather than reading the silence as a clean round. */
export function recordInputCap(db: DB, c: InputCapInput, now = new Date()): void {
  db.prepare(
    'INSERT INTO input_caps (match_id, server_id, steamid, kind, server_tick, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(c.matchId, c.serverId, c.steamid, c.kind, c.serverTick, now.toISOString());
}

export interface CapRow { matchId: number | null; kind: string; serverTick: number; at: string }

export function capsForPlayer(db: DB, steamid: string, limit = 50): CapRow[] {
  return db.prepare(
    `SELECT match_id AS matchId, kind, server_tick AS serverTick, at
     FROM input_caps WHERE steamid = ? ORDER BY at DESC, id DESC LIMIT ?`,
  ).all(steamid, limit) as CapRow[];
}

export interface RerunResult {
  bursts: number;
  /** Player-matches examined. */
  groups: number;
  detections: number;
  /** Detections that existed before and do not now. */
  removed: number;
}

/**
 * Rebuild every detection from the stored bursts. This is the payoff of
 * storing raw ordered intervals: a signature written months from now applies
 * to everything recorded since day one, with nothing re-deployed to a game
 * server.
 *
 * It REPLACES rather than adds. Detections are a function of the bursts and
 * the current signatures, and a row written by a signature that has since been
 * recalibrated is a false statement about a player, not history worth keeping.
 * The bursts themselves, which are the evidence, are never touched.
 */
export function rerunSignatures(
  db: DB, thresholds: Thresholds = DEFAULT_THRESHOLDS, opts: { dryRun?: boolean } = {},
): RerunResult {
  const ROLLBACK = Symbol('dry run');
  let result: RerunResult = { bursts: 0, groups: 0, detections: 0, removed: 0 };
  const run = db.transaction(() => {
    const key = (r: { matchId: number; steamid: string; signature: string }): string =>
      `${r.matchId}/${r.steamid}/${r.signature}`;
    const select = 'SELECT match_id AS matchId, steamid, signature FROM input_detections';
    const before = new Set((db.prepare(select).all() as Parameters<typeof key>[0][]).map(key));
    db.prepare('DELETE FROM input_detections').run();
    const groups = db.prepare(
      'SELECT DISTINCT match_id AS matchId, steamid FROM input_bursts WHERE match_id IS NOT NULL ORDER BY match_id, steamid',
    ).all() as { matchId: number; steamid: string }[];
    for (const g of groups) evaluateGroup(db, g.matchId, g.steamid, thresholds);
    const after = new Set((db.prepare(select).all() as Parameters<typeof key>[0][]).map(key));
    result = {
      bursts: (db.prepare('SELECT COUNT(*) AS c FROM input_bursts').get() as { c: number }).c,
      groups: groups.length,
      detections: after.size,
      removed: [...before].filter((k) => !after.has(k)).length,
    };
    if (opts.dryRun) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return result;
}
