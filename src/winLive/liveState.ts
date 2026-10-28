import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { decodeFrames, decodeHeader, ENTITY_KIND, frameBytes, HEADER_BYTES, slotInfected, VERSION, type Frame } from '../replayFormat.js';
import { releasableFrames } from '../replayTail.js';
import { resolveFurther } from '../replaySessions.js';
import { liveFileName } from '../replayPush.js';
import { infectedMaskForHeader } from '../replaySides.js';
import { roundInProgress } from '../liveView.js';
import { liveHudStore, type LiveHudSample, type LiveHudStore } from '../cast/liveHud.js';
import { CALIBRATION, provideInHalfPoints, sumDists, winChanceDists, type FutureHalf, type PlayedHalf, type WinModel, type WinPoint } from '../winProb.js';
import { teamForm, tilt, type FormParams } from '../winForm.js';
import { HALF_PARAMS, predictHalf, progressMade } from './halfModel.js';
import { halfSnapshots, progressStep, SNAPSHOT_EVERY_MS, type Snapshot } from './snapshot.js';
import { furthestProg, type ProgressMap } from './progressMap.js';

/**
 * The live win chance during a half: the state of the half in progress, read
 * from the live replay file and the LIVEHUD history, turned into a point on
 * the win line every 5 s of half time (src/winLive/halfModel.ts prices it).
 *
 * Train/serve parity. The model was trained on snapshots from
 * `halfSnapshots` (scripts/win-dataset.ts) whose progress is the running max
 * of the furthest survivor's mapped progress (furthestProg on the map's
 * trusted progress map), turned into progress made with the half's first
 * known value. Here the same frames (decoded the same way, paused frames
 * dropped by the same rule as `unpausedFrames`) go through the same
 * `halfSnapshots` with the same progress function. A map without a trusted
 * progress map falls back to the LIVEHUD progress history, running max too.
 *
 * What the public may see. LIVEHUD and the live replay are undelayed, so a
 * public line (/live) only shows points whose frame the live viewer could
 * already have been sent (`releasableFrames`, DEFAULT_DELAY_MS) and whose
 * LIVEHUD sample is at least as old. The caster overlay passes no delay.
 * Everything here is memory only; nothing reaches the database during a
 * half (writeProgressSamples runs at half end).
 *
 * Cost. One file per match is decoded incrementally (never more than
 * MAX_DECODE_BYTES per update, so the first read after a web restart
 * catches up over a few updates instead of blocking), and the snapshots and
 * points are recomputed at most once per RECOMPUTE_MS per match however many
 * people are watching. Each point is priced once per form variant and kept.
 *
 * Points are held per match and half: a finished half keeps its points for
 * the rest of the match, a restarted half (resetLiveWin, at ROUND_START)
 * loses them, and a match nobody has asked about for FORGET_MS is dropped.
 */

/** The trusted progress maps (scripts/win-dataset.ts pass 1, the maps whose
 *  held-out median error passed), by lowercased map name. */
export const PROGRESS_MAPS: ReadonlyMap<string, ProgressMap> = new Map(
  (JSON.parse(readFileSync(new URL('./progressMaps.json', import.meta.url), 'utf8')) as ProgressMap[])
    .map((pm) => [pm.map.toLowerCase(), pm]),
);

/** Snapshots and points are recomputed at most this often per match. */
export const RECOMPUTE_MS = SNAPSHOT_EVERY_MS;
/** At most this much of the file is decoded per update. */
const MAX_DECODE_BYTES = 2 * 1024 * 1024;
/** A match nobody has asked about for this long is forgotten. */
const FORGET_MS = 10 * 60_000;
/** A file that went live this much earlier than the half's ROUND_START is
 *  the abandoned attempt of a restarted half (same file name), not this one. */
const STALE_ATTEMPT_MS = 15_000;

export interface LiveWinSources {
  replayDir: string;
  liveDir: string;
  hud: LiveHudStore;
  progressMaps: ReadonlyMap<string, ProgressMap>;
}

let sources: LiveWinSources = { replayDir: '', liveDir: '', hud: liveHudStore, progressMaps: PROGRESS_MAPS };

/** Where the live replay files are (set once at server start) and, for
 *  tests, which LIVEHUD store and progress maps to read. Forgets every match. */
export function configureLiveWin(s: Partial<LiveWinSources>): void {
  sources = { ...sources, ...s };
  matches.clear();
}

/** Whether a line shows points during a half: win_chance_live is on, or the
 *  viewer is an admin (the Live page only), who sees it before it goes public. */
export function winLiveOption(db: DB, adminViewer = false): boolean {
  return adminViewer || getSetting(db, 'win_chance_live') === '1';
}

type Moment = NonNullable<WinPoint['moment']>;

interface StoredPoint {
  tMs: number;
  /** The snapshot, its prog already progress made in the half. */
  snap: Snapshot;
  moment?: Moment;
  /** The newest LIVEHUD sample the point stands on (this process's clock). */
  hudAt: number;
  /** Team A's chance, per form variant (null: no form), priced once. */
  prices: Map<FormParams | null, number>;
}

/** The half being read: the decoded frames so far and what came of them. */
interface HalfTrack {
  token: string;
  ordinal: number;
  half: 1 | 2;
  path: string;
  startedUnix: number;
  sideOf: (slot: number) => boolean;
  /** File offset of the next undecoded frame. */
  offset: number;
  /** Kept frames, slimmed to what snapshots read (players, AI tanks). */
  frames: Frame[];
  /** Furthest survivor progress per frame, on a trusted map only. */
  mapPts: { tMs: number; prog: number }[];
  pm: ProgressMap | null;
  /** The file's mtime, read after the bytes that were decoded. */
  mtimeMs: number;
  updatedAt: number;
  /** The half's first known progress (progressMade's prog0), raw. */
  prog0: number | null;
  /** The newest snapshot already turned into a point (or skipped). */
  doneTMs: number;
  prev: Snapshot | null;
}

interface MatchState {
  track: HalfTrack | null;
  points: Map<string, StoredPoint[]>;
  usedAt: number;
}

const matches = new Map<number, MatchState>();
const halfKey = (ordinal: number, half: number) => `${ordinal}:${half}`;

function stateOf(matchId: number, nowMs: number): MatchState {
  let st = matches.get(matchId);
  if (!st) { st = { track: null, points: new Map(), usedAt: nowMs }; matches.set(matchId, st); }
  st.usedAt = nowMs;
  for (const [id, s] of matches) if (nowMs - s.usedAt > FORGET_MS) matches.delete(id);
  return st;
}

/** A half (re)started: forget its points and anything read from its file. */
export function resetLiveWin(matchId: number, ordinal: number, half: number): void {
  const st = matches.get(matchId);
  if (!st) return;
  st.points.delete(halfKey(ordinal, half));
  if (st.track && st.track.ordinal === ordinal && st.track.half === half) st.track = null;
}

/** The match ended: forget it. */
export function forgetLiveWin(matchId: number): void {
  matches.delete(matchId);
}

/** The half the plugin says is being played, with its token and surviving
 *  team, or null (between halves, or a side the plugin did not know). */
function currentHalf(db: DB, matchId: number): { token: string; ordinal: number; half: 1 | 2; survTeam: 'a' | 'b' } | null {
  const rip = roundInProgress(db, matchId);
  if (!rip || (rip.half !== 1 && rip.half !== 2)) return null;
  const half = rip.half as 1 | 2;
  const row = db.prepare(
    `SELECT m.token, r.surv_team AS survTeam, r.reliable FROM matches m
     JOIN match_rounds r ON r.match_id = m.id AND r.ordinal = ? AND r.half = ?
     WHERE m.id = ?`,
  ).get(rip.ordinal, rip.half, matchId) as { token: string | null; survTeam: 'a' | 'b'; reliable: number } | undefined;
  if (!row?.token || row.reliable !== 1) return null;
  return { token: row.token, ordinal: rip.ordinal, half, survTeam: row.survTeam };
}

function readBytes(path: string, at: number, len: number): Uint8Array | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = new Uint8Array(len);
    const n = readSync(fd, buf, 0, len, at);
    return n === len ? buf : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The frame cut to what a snapshot reads: every player, and only the AI
 *  tanks among the entities (commons and the rest would only cost memory). */
function slim(f: Frame): Frame {
  return { tMs: f.tMs, offset: 0, players: f.players, entities: f.entities.filter((e) => e.kind === ENTITY_KIND.TANK_AI) };
}

/** Open (or keep) the track for this half's file and decode what was added.
 *  Null when there is no file, it cannot be read, its sides are unknown, or
 *  it is the abandoned attempt of a restarted half. */
function advance(
  db: DB, matchId: number, st: MatchState, cur: { token: string; ordinal: number; half: 1 | 2 }, map: string, nowMs: number,
): HalfTrack | null {
  const held = st.track;
  if (held && held.ordinal === cur.ordinal && held.half === cur.half && nowMs - held.updatedAt < RECOMPUTE_MS) return held;
  const found = resolveFurther(sources.replayDir, sources.liveDir, liveFileName(cur.token, cur.ordinal, cur.half), nowMs);
  if (!found) return null;
  let size: number;
  try { size = statSync(found.path).size; } catch { return null; }
  const head = readBytes(found.path, 0, HEADER_BYTES);
  const header = head && head.length === HEADER_BYTES ? decodeHeader(head) : null;
  if (!header || header.version > VERSION) return null;
  const startedAt = sources.hud.halfStartedAt(cur.token, cur.ordinal, cur.half);
  if (startedAt !== null && header.startedUnix * 1000 < startedAt - STALE_ATTEMPT_MS) return null;

  let t = st.track;
  if (t && (t.ordinal !== cur.ordinal || t.half !== cur.half)) t = null;
  if (t && (t.path !== found.path || t.startedUnix !== header.startedUnix || size < t.offset)) {
    // The same half from a new start: a restart nobody told us about, so
    // what came of the old attempt goes too.
    if (t.startedUnix !== header.startedUnix) st.points.delete(halfKey(cur.ordinal, cur.half));
    t = null;
  }
  if (!t) {
    let sideOf: (slot: number) => boolean;
    if (header.sidesKnown) sideOf = (s) => slotInfected(header, s);
    else {
      const mask = infectedMaskForHeader(db, Buffer.from(head!), matchId, cur.ordinal, cur.half);
      if (mask === null) return null;
      sideOf = (s) => ((mask >> s) & 1) === 1;
    }
    // Points already made for this half (a track dropped and read again)
    // are not made twice.
    const made = st.points.get(halfKey(cur.ordinal, cur.half));
    t = {
      token: cur.token, ordinal: cur.ordinal, half: cur.half, path: found.path, startedUnix: header.startedUnix, sideOf,
      offset: HEADER_BYTES, frames: [], mapPts: [], pm: sources.progressMaps.get(map.toLowerCase()) ?? null,
      mtimeMs: 0, updatedAt: -Infinity, prog0: null, doneTMs: made && made.length > 0 ? made[made.length - 1]!.tMs : -Infinity, prev: null,
    };
    st.track = t;
  }

  const end = header.indexOffset > 0 && header.indexOffset <= size ? header.indexOffset : size;
  const len = Math.min(end - t.offset, MAX_DECODE_BYTES);
  if (len > 0) {
    const chunk = readBytes(found.path, t.offset, len);
    if (chunk) {
      const { frames } = decodeFrames(chunk, 0, chunk.length, t.sideOf);
      if (frames.length > 0) {
        const last = frames[frames.length - 1]!;
        t.offset += last.offset + frameBytes(last.entities.length);
      }
      // The unpausedFrames rule, applied as the frames arrive: a frame is
      // kept only when its clock is past the last kept one.
      let lastT = t.frames.length > 0 ? t.frames[t.frames.length - 1]!.tMs : -Infinity;
      for (const f of frames) {
        if (f.tMs <= lastT) continue;
        lastT = f.tMs;
        t.frames.push(slim(f));
        if (t.pm) {
          const v = furthestProg(t.pm, f);
          if (v !== null) t.mapPts.push({ tMs: f.tMs, prog: v });
        }
      }
    }
  }
  // After the read: an mtime newer than the bytes decoded only holds frames
  // back (see releasableFrames), one older would release them early.
  try { t.mtimeMs = statSync(found.path).mtimeMs; } catch { t.mtimeMs = 0; }
  t.updatedAt = nowMs;
  return t;
}

/** The newest sample at or before `at`, or null. */
function sampleAt(samples: LiveHudSample[], at: number): LiveHudSample | null {
  let lo = 0, hi = samples.length - 1, best: LiveHudSample | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.at <= at) { best = samples[mid]!; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** What happened between two consecutive snapshots worth marking. */
function momentOf(prev: Snapshot | null, s: Snapshot): Moment | undefined {
  if (!prev) return undefined;
  if (s.alive <= 0 && prev.alive > 0) return 'wipe';
  if (s.tank === 'alive' && prev.tank !== 'alive') return 'tank_spawn';
  if (s.tank === 'dead' && prev.tank === 'alive') return 'tank_death';
  return undefined;
}

/** The half's snapshots from every decoded frame, raw progress (not yet
 *  progress made). `wallOf` turns a snapshot time into this process's clock. */
function snapshotsOf(t: HalfTrack, samples: LiveHudSample[], wallOf: (tMs: number) => number): Snapshot[] {
  let prog: (tMs: number) => number | null;
  if (t.pm) prog = progressStep(t.mapPts);
  else {
    // No trusted progress map: LIVEHUD's progress, placed on the half's clock
    // by its arrival time. A pause makes that time run ahead of the game
    // clock, so a sample only ever lands later than it happened, never early.
    const origin = wallOf(0);
    prog = progressStep(samples.map((s) => ({ tMs: s.at - origin, prog: s.prog })));
  }
  return halfSnapshots({ frames: t.frames, durationMs: 0, slots: [] }, prog, null);
}

/** Bring the half's points up to date: one per new snapshot that has a
 *  LIVEHUD sample at or before it. */
function extendPoints(st: MatchState, t: HalfTrack, snaps: Snapshot[], samples: LiveHudSample[], wallOf: (tMs: number) => number): void {
  const k = halfKey(t.ordinal, t.half);
  let list = st.points.get(k);
  if (!list) { list = []; st.points.set(k, list); }
  for (const s of snaps) {
    if (t.prog0 === null && s.prog !== null) t.prog0 = s.prog;
    if (s.tMs <= t.doneTMs) continue;
    t.doneTMs = s.tMs;
    const prev = t.prev;
    t.prev = s;
    const hud = sampleAt(samples, wallOf(s.tMs));
    if (!hud) continue;
    const moment = momentOf(prev, s);
    list.push({
      tMs: s.tMs, snap: { ...s, prog: progressMade(s.prog, t.prog0) }, hudAt: hud.at, prices: new Map(),
      ...(moment ? { moment } : {}),
    });
  }
}

/** Update the match's current half (at most once per RECOMPUTE_MS) and say
 *  which of its points a viewer `delayMs` behind may see. */
function refresh(db: DB, matchId: number, map: string, nowMs: number, delayMs: number):
  { st: MatchState; cur: { token: string; ordinal: number; half: 1 | 2; survTeam: 'a' | 'b' } | null; visible: (p: StoredPoint) => boolean } {
  const st = stateOf(matchId, nowMs);
  const none = { st, cur: null, visible: () => false };
  const cur = currentHalf(db, matchId);
  if (!cur) { st.track = null; return none; }
  const before = st.track?.updatedAt;
  const t = advance(db, matchId, st, cur, map, nowMs);
  if (!t) return { ...none, cur };
  if (t.updatedAt !== before) {
    // The half's clock on this process's: from when it was seen going live,
    // else from the file's own start.
    const origin = sources.hud.halfStartedAt(cur.token, cur.ordinal, cur.half) ?? t.startedUnix * 1000;
    const wallOf = (tMs: number) => origin + tMs;
    const samples = sources.hud.history(cur.token, cur.ordinal, cur.half);
    extendPoints(st, t, snapshotsOf(t, samples, wallOf), samples, wallOf);
  }
  let cutoffTMs = Infinity;
  if (delayMs > 0) {
    const released = releasableFrames(t.frames, t.startedUnix * 1000, nowMs, delayMs, t.mtimeMs);
    cutoffTMs = released.length > 0 ? released[released.length - 1]!.tMs : -Infinity;
  }
  const hudCutoff = nowMs - Math.max(0, delayMs);
  return { st, cur, visible: (p) => p.tMs <= cutoffTMs && p.hudAt <= hudCutoff };
}

/**
 * The newest state of the half in progress a viewer `delayMs` behind may
 * see: its snapshot (prog is progress made in the half) and the tank flow %
 * from the newest LIVEHUD sample it stands on. Null when there is no half in
 * progress, no live replay, no LIVEHUD sample old enough, or the file is an
 * abandoned attempt of the half. `delayMs` 0 is the caster overlay's
 * undelayed view.
 */
export function liveSnapshot(
  db: DB, matchId: number, nowMs: number, delayMs: number,
): { ordinal: number; half: number; snap: Snapshot; tankFlow: number | null } | null {
  const map = mapOfCurrent(db, matchId);
  if (map === null) return null;
  const { st, cur, visible } = refresh(db, matchId, map, nowMs, delayMs);
  if (!cur) return null;
  const list = st.points.get(halfKey(cur.ordinal, cur.half)) ?? [];
  let p: StoredPoint | null = null;
  for (let i = list.length - 1; i >= 0; i--) if (visible(list[i]!)) { p = list[i]!; break; }
  if (!p) return null;
  // The tank flow from the newest sample at or before the point's that knew it.
  const samples = sources.hud.history(cur.token, cur.ordinal, cur.half);
  let tankFlow: number | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.at > p.hudAt) continue;
    if (s.tank >= 0 && s.tank <= 100) { tankFlow = s.tank; break; }
  }
  return { ordinal: cur.ordinal, half: cur.half, snap: p.snap, tankFlow };
}

/** The map of the half in progress, from the campaign plan. */
function mapOfCurrent(db: DB, matchId: number): string | null {
  const rip = roundInProgress(db, matchId);
  if (!rip) return null;
  const named = db.prepare('SELECT map FROM match_live_maps WHERE match_id = ? AND ordinal = ?').get(matchId, rip.ordinal) as { map: string } | undefined;
  if (named) return named.map;
  const cur = db.prepare('SELECT current_map AS map FROM match_live WHERE match_id = ?').get(matchId) as { map: string | null } | undefined;
  return cur?.map ?? null;
}

/** The pieces of a price that do not change within a half: every other
 *  half still to play, convolved per team, and the half's form tilt. */
interface PriceCtx { othersA: Float64Array; othersB: Float64Array; theta: number; calibration: number }

function priceCtx(model: WinModel, played: PlayedHalf[], future: FutureHalf[], idx: number, survTeam: 'a' | 'b', form: FormParams | null): PriceCtx {
  const t = form ? teamForm(model, played, undefined, form) : { a: 0, b: 0 };
  const rest = (team: 'a' | 'b', theta: number) =>
    sumDists(future.filter((x, i) => i !== idx && x.team === team).map((x) => tilt(model.dist(x.map), theta)));
  return { othersA: rest('a', t.a), othersB: rest('b', t.b), theta: t[survTeam], calibration: form?.calibration ?? CALIBRATION };
}

export interface InHalfOpts {
  form?: FormParams;
  nowMs: number;
  delayMs: number;
}

/**
 * The in-half points for a live match's line (liveWinLine with `live`):
 * those of halves already played (by half key), and those of the half in
 * progress a viewer `delayMs` behind may see. `played` and `future` are the
 * line's own; the half in progress is the future half its surviving team
 * plays on its map, and it is priced against the rest exactly as the
 * half-end line prices it, so the opening snapshot sits on the line's last
 * point. A point is shown only in the form variant it was priced in while
 * its half was live.
 */
export function inHalfPoints(
  db: DB, matchId: number, model: WinModel, played: PlayedHalf[], future: FutureHalf[], opts: InHalfOpts,
): { finished: Map<string, WinPoint[]>; current: WinPoint[] } {
  const form = opts.form ?? null;
  const scoreA = played.filter((r) => r.survTeam === 'a').reduce((n, r) => n + r.score, 0);
  const scoreB = played.filter((r) => r.survTeam === 'b').reduce((n, r) => n + r.score, 0);
  const last = played[played.length - 1];
  const next = last ? (last.half === 1 ? { ordinal: last.ordinal, half: 2 } : { ordinal: last.ordinal + 1, half: 1 }) : { ordinal: 0, half: 1 };
  const nextMap = last && last.half === 1 ? last.map : future[0]?.map ?? null;

  const out = { finished: new Map<string, WinPoint[]>(), current: [] as WinPoint[] };
  const { st, cur, visible } = nextMap === null
    ? { st: stateOf(matchId, opts.nowMs), cur: null, visible: () => false }
    : refresh(db, matchId, nextMap, opts.nowMs, opts.delayMs);

  // Halves already played keep whatever points they had, the last one
  // marked when the survivors made it to the saferoom.
  const aliveOf = db.prepare('SELECT survivors_alive AS alive FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?');
  // The score each half started from.
  let runA = 0, runB = 0;
  for (const r of played) {
    const [fromA, fromB] = [runA, runB];
    if (r.survTeam === 'a') runA += r.score; else runB += r.score;
    const list = st.points.get(halfKey(r.ordinal, r.half));
    if (!list || list.length === 0) continue;
    const pts: WinPoint[] = list.filter((p) => p.prices.has(form)).map((p) => ({
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam, map: r.map, scoreA: fromA, scoreB: fromB, pA: p.prices.get(form)!,
      tMs: p.tMs, ...(p.moment ? { moment: p.moment } : {}),
    }));
    const alive = (aliveOf.get(matchId, r.ordinal, r.half) as { alive: number | null } | undefined)?.alive ?? null;
    if (pts.length > 0 && alive !== null && alive > 0) pts[pts.length - 1] = { ...pts[pts.length - 1]!, moment: 'saferoom' };
    if (pts.length > 0) out.finished.set(halfKey(r.ordinal, r.half), pts);
  }

  if (!cur || cur.ordinal !== next.ordinal || cur.half !== next.half || nextMap === null) return out;
  const idx = future.findIndex((x) => x.team === cur.survTeam && x.map === nextMap);
  if (idx < 0) return out;
  const list = st.points.get(halfKey(cur.ordinal, cur.half)) ?? [];
  let ctx: PriceCtx | null = null;
  for (const p of list) {
    if (!visible(p)) continue;
    let pA = p.prices.get(form);
    if (pA === undefined) {
      ctx ??= priceCtx(model, played, future, idx, cur.survTeam, form);
      const pred = predictHalf(model, HALF_PARAMS, nextMap, ctx.theta, p.snap, cur.half);
      pA = winChanceDists(
        scoreA - scoreB,
        cur.survTeam === 'a' ? [ctx.othersA, pred] : [ctx.othersA],
        cur.survTeam === 'b' ? [ctx.othersB, pred] : [ctx.othersB],
        ctx.calibration,
      );
      p.prices.set(form, pA);
    }
    out.current.push({
      ordinal: cur.ordinal, half: cur.half, survTeam: cur.survTeam, map: nextMap, scoreA, scoreB, pA,
      tMs: p.tMs, ...(p.moment ? { moment: p.moment } : {}),
    });
  }
  return out;
}

/**
 * Store a finished half's LIVEHUD progress, one sample per 10 s of half time
 * (the first in each 10 s window with a known progress), replacing anything
 * stored for the half before. Called by the round-end handler only: the
 * samples are undelayed, so they reach the database once the half is over.
 * `startedAt` is when the half went live on this process's clock; without
 * it the round row's started_at stands in. Returns the rows written.
 */
export function writeProgressSamples(
  db: DB, matchId: number, ordinal: number, half: number, samples: LiveHudSample[], startedAt: number | null,
): number {
  let origin = startedAt;
  if (origin === null) {
    const row = db.prepare('SELECT started_at AS s FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
      .get(matchId, ordinal, half) as { s: string | null } | undefined;
    origin = row?.s ? Date.parse(`${row.s.replace(' ', 'T')}Z`) : null;
  }
  const rows: { t: number; prog: number; tank: number | null }[] = [];
  if (origin !== null && Number.isFinite(origin)) {
    let window = -1;
    for (const s of samples) {
      const t = s.at - origin;
      if (t < 0 || s.prog < 0 || s.prog > 100) continue;
      const w = Math.floor(t / PROGRESS_SAMPLE_MS);
      if (w <= window) continue;
      window = w;
      rows.push({ t, prog: s.prog, tank: s.tank >= 0 && s.tank <= 100 ? s.tank : null });
    }
  }
  const ins = db.prepare('INSERT OR REPLACE INTO match_progress_samples (match_id, ordinal, half, t_ms, prog, tank) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    clearProgressSamples(db, matchId, ordinal, half);
    for (const r of rows) ins.run(matchId, ordinal, half, r.t, r.prog, r.tank);
  })();
  return rows.length;
}

/** A half restarted: its stored samples belong to the abandoned attempt. */
export function clearProgressSamples(db: DB, matchId: number, ordinal: number, half: number): void {
  db.prepare('DELETE FROM match_progress_samples WHERE match_id = ? AND ordinal = ? AND half = ?').run(matchId, ordinal, half);
}

/** One stored progress sample per this much half time. */
export const PROGRESS_SAMPLE_MS = 10_000;

provideInHalfPoints(inHalfPoints);
