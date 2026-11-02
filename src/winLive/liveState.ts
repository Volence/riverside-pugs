import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { decodeFrames, decodeHeader, frameBytes, HEADER_BYTES, slotInfected, VERSION, type Frame } from '../replayFormat.js';
import { releasableFrames } from '../replayTail.js';
import { resolveFurther } from '../replaySessions.js';
import { liveFileName } from '../replayPush.js';
import { infectedMaskForHeader } from '../replaySides.js';
import { roundInProgress } from '../liveView.js';
import { liveHudStore, type LiveHudSample, type LiveHudStore } from '../cast/liveHud.js';
import { CALIBRATION, provideInHalfPoints, sumDists, winChanceDists, type FutureHalf, type PlayedHalf, type WinModel, type WinPoint } from '../winProb.js';
import { teamForm, tilt, type FormParams } from '../winForm.js';
import { HALF_PARAMS, predictHalf, progressMade } from './halfModel.js';
import { mapThenFallback, progressStep, SnapshotWalker, SNAPSHOT_EVERY_MS, type Snapshot } from './snapshot.js';
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
export const MAX_DECODE_BYTES = 2 * 1024 * 1024;
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
  /** At most this much of a file per read (MAX_DECODE_BYTES; tests shrink it). */
  maxDecodeBytes: number;
}

let sources: LiveWinSources = {
  replayDir: '', liveDir: '', hud: liveHudStore, progressMaps: PROGRESS_MAPS, maxDecodeBytes: MAX_DECODE_BYTES,
};

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

export type Moment = NonNullable<WinPoint['moment']>;

interface StoredPoint {
  tMs: number;
  /** The snapshot, its prog already progress made in the half. */
  snap: Snapshot;
  moment?: Moment;
  /** The LIVEHUD sample the point stands on (this process's clock). */
  hudAt: number;
  /** The newest moment anything the point stands on was seen: its sample,
   *  or its frame (the half clock's wall time for its tMs). A public viewer
   *  sees the point only once this is the delay old. */
  seenAt: number;
  /** Team A's chance, per form variant (null: no form), priced once. */
  prices: Map<FormParams | null, number>;
}

/** Where the half clock (RoundMs, game time, which stops in a pause) stood
 *  against this process's clock, from one read that reached the end of the
 *  file: at wall time `wall` (the file's mtime) its newest frame was at
 *  `upToTMs`, so tMs 0 was at `zero` = wall - upToTMs, every pause so far
 *  included. The file is written a little after its frames (the push's
 *  lag), so `zero` is never early: for any frame up to `upToTMs`, zero +
 *  its tMs is no earlier than it really happened. Past `upToTMs` a mark
 *  says nothing (a pause may have come since). */
interface ClockMark { wall: number; zero: number; upToTMs: number }

/** How many recent marks a time is read against. The smallest zero of them
 *  wins: one read with a lag spike (or a write between the stat and the
 *  read) does not hold the clock late for the rest of the half. */
const MARKS_KEPT = 3;

/** The half being read. Frames are not kept: a SnapshotWalker carries the
 *  snapshot state forward, and only each frame's time stays (the public
 *  cutoff, releasableFrames, reads nothing else). */
interface HalfTrack {
  token: string;
  ordinal: number;
  half: 1 | 2;
  path: string;
  startedUnix: number;
  sideOf: (slot: number) => boolean;
  /** File offset of the next undecoded frame. */
  offset: number;
  /** Each kept frame's time, as a bare frame. */
  times: Frame[];
  walker: SnapshotWalker;
  /** Running max of the furthest survivor's mapped progress (trusted map),
   *  or the LIVEHUD fallback, as of the frames pushed so far. */
  prog: (tMs: number) => number | null;
  progTs: number[];
  progPs: number[];
  pm: ProgressMap | null;
  /** Snapshots out of the walker not yet made into points (they wait for
   *  the half's first LIVEHUD sample). */
  queue: Snapshot[];
  /** The file's mtime, read after the bytes that were decoded. */
  mtimeMs: number;
  marks: ClockMark[];
  updatedAt: number;
  /** The half's first known progress (progressMade's prog0), raw. */
  prog0: number | null;
  /** The newest snapshot already made into a point. */
  doneTMs: number;
  prev: Snapshot | null;
}

interface MatchState {
  track: HalfTrack | null;
  points: Map<string, StoredPoint[]>;
  /** The last failed read of a half's file, so a missing file, an abandoned
   *  attempt or unknown sides are not looked at again for RECOMPUTE_MS. */
  miss: { ordinal: number; half: number; at: number } | null;
  /** Abandoned attempts already logged, by half and start. */
  warned: Set<string>;
  usedAt: number;
}

const matches = new Map<number, MatchState>();
const halfKey = (ordinal: number, half: number) => `${ordinal}:${half}`;
const EMPTY: never[] = [];

function stateOf(matchId: number, nowMs: number): MatchState {
  let st = matches.get(matchId);
  if (!st) { st = { track: null, points: new Map(), miss: null, warned: new Set(), usedAt: nowMs }; matches.set(matchId, st); }
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
  st.miss = null;
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

const sqliteMs = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

/**
 * This process's time turned into the half's clock (RoundMs: game time since
 * the half went live, which stops in a pause, the clock replay frames carry).
 * `origin` is when the half went live on this process's clock.
 *
 * With a track of the half, the recent clock marks at or before the time
 * say where tMs 0 stood (the smallest zero of the last MARKS_KEPT of them,
 * none from before a pause that has ended: match_pauses says when). A
 * pause after them is not in it yet, so the time only ever lands later than
 * it happened. A mark carries the push's lag (a fraction of a second the
 * other way), which taking the smallest of a few keeps from latching.
 * Before the first mark, or with no track, the half's pauses
 * (match_pauses) are taken off instead.
 */
function halfClock(db: DB, matchId: number, ordinal: number, half: number, origin: number): (at: number) => number {
  const t = matches.get(matchId)?.track;
  const marks = t && t.ordinal === ordinal && t.half === half ? t.marks : EMPTY as ClockMark[];
  const pauses = (db.prepare(
    'SELECT started_at AS s, ended_at AS e FROM match_pauses WHERE match_id = ? AND map_ordinal = ? AND half = ?',
  ).all(matchId, ordinal, half) as { s: string; e: string | null }[])
    .map((r) => ({ from: sqliteMs(r.s), to: r.e === null ? Infinity : sqliteMs(r.e) }))
    // A pause of an abandoned attempt (before this one went live) is not this half's.
    .filter((r) => Number.isFinite(r.from) && r.to > origin);
  return (at) => {
    // A mark from before the newest pause that had ended by `at` predates
    // that pause: it would put the time a whole pause late.
    let pausedUntil = -Infinity;
    for (const p of pauses) if (p.to <= at) pausedUntil = Math.max(pausedUntil, p.to);
    let zero = Infinity;
    for (let i = marks.length - 1, n = 0; i >= 0 && n < MARKS_KEPT; i--) {
      if (marks[i]!.wall > at) continue;
      if (marks[i]!.wall < pausedUntil) break;
      zero = Math.min(zero, marks[i]!.zero);
      n++;
    }
    if (zero !== Infinity) return at - zero;
    let paused = 0;
    for (const p of pauses) paused += Math.max(0, Math.min(p.to, at) - Math.max(p.from, origin));
    return at - origin - paused;
  };
}

/** Open (or keep) the track for this half's file and read what was added,
 *  turning new snapshots into points. Null when there is no file, it cannot
 *  be read, its sides are unknown, or it is the abandoned attempt of a
 *  restarted half; a failure is not tried again for RECOMPUTE_MS. */
function advance(
  db: DB, matchId: number, st: MatchState, cur: { token: string; ordinal: number; half: 1 | 2 }, map: string, nowMs: number,
): HalfTrack | null {
  const held = st.track;
  if (held && held.ordinal === cur.ordinal && held.half === cur.half && nowMs - held.updatedAt < RECOMPUTE_MS) return held;
  if (st.miss && st.miss.ordinal === cur.ordinal && st.miss.half === cur.half && nowMs - st.miss.at < RECOMPUTE_MS) return null;
  const t = open(db, matchId, st, cur, map, nowMs);
  if (!t) { st.miss = { ordinal: cur.ordinal, half: cur.half, at: nowMs }; return null; }
  st.miss = null;
  read(db, matchId, st, t, nowMs);
  return t;
}

/** The track for the half's file as it is now, new or kept. */
function open(
  db: DB, matchId: number, st: MatchState, cur: { token: string; ordinal: number; half: 1 | 2 }, map: string, nowMs: number,
): HalfTrack | null {
  const found = resolveFurther(sources.replayDir, sources.liveDir, liveFileName(cur.token, cur.ordinal, cur.half), nowMs);
  if (!found) return null;
  let size: number;
  try { size = statSync(found.path).size; } catch { return null; }
  const head = readBytes(found.path, 0, HEADER_BYTES);
  const header = head && head.length === HEADER_BYTES ? decodeHeader(head) : null;
  if (!header || header.version > VERSION) return null;
  const startedAt = sources.hud.halfStartedAt(cur.token, cur.ordinal, cur.half);
  if (startedAt !== null && header.startedUnix * 1000 < startedAt - STALE_ATTEMPT_MS) {
    // Either the file is the attempt before a restart (its new file is not
    // here yet), or the game server's clock is that far behind this one, in
    // which case no half on that box ever gets points: worth a line.
    const k = `${halfKey(cur.ordinal, cur.half)}:${header.startedUnix}`;
    if (!st.warned.has(k)) {
      st.warned.add(k);
      console.warn(`[win-live] match ${matchId} map ${cur.ordinal} half ${cur.half}: the replay file went live ${Math.round(startedAt / 1000 - header.startedUnix)} s before ROUND_START; read as an abandoned attempt (or the server clock is behind)`);
    }
    return null;
  }

  let t = st.track;
  if (t && (t.ordinal !== cur.ordinal || t.half !== cur.half)) t = null;
  if (t && (t.path !== found.path || t.startedUnix !== header.startedUnix || size < t.offset)) {
    // The same half from a new start: a restart nobody told us about, so
    // what came of the old attempt goes too.
    if (t.startedUnix !== header.startedUnix) st.points.delete(halfKey(cur.ordinal, cur.half));
    t = null;
  }
  if (t) return t;
  let sideOf: (slot: number) => boolean;
  if (header.sidesKnown) sideOf = (sl) => slotInfected(header, sl);
  else {
    const mask = infectedMaskForHeader(db, Buffer.from(head!), matchId, cur.ordinal, cur.half);
    if (mask === null) return null;
    sideOf = (sl) => ((mask >> sl) & 1) === 1;
  }
  // Points already made for this half (a track dropped and read again) are
  // not made twice.
  const made = st.points.get(halfKey(cur.ordinal, cur.half));
  const fresh: HalfTrack = {
    token: cur.token, ordinal: cur.ordinal, half: cur.half, path: found.path, startedUnix: header.startedUnix, sideOf,
    offset: HEADER_BYTES, times: [], walker: null!, prog: () => null, progTs: [], progPs: [],
    pm: sources.progressMaps.get(map.toLowerCase()) ?? null, queue: [], mtimeMs: 0, marks: [],
    updatedAt: -Infinity, prog0: null, doneTMs: made && made.length > 0 ? made[made.length - 1]!.tMs : -Infinity, prev: null,
  };
  // The walker asks the track's current progress function, so the LIVEHUD
  // fallback can be rebuilt each read.
  fresh.walker = new SnapshotWalker((tMs) => fresh.prog(tMs), null);
  st.track = fresh;
  return fresh;
}

/** The running max at or before `tMs` from parallel sorted arrays, or null. */
function stepAt(ts: number[], ps: number[], tMs: number): number | null {
  let lo = 0, hi = ts.length - 1, best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= tMs) { best = ps[mid]!; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** One read: decode what was added (at most MAX_DECODE_BYTES), feed the
 *  frames to the walker, and make points of the snapshots. */
function read(db: DB, matchId: number, st: MatchState, t: HalfTrack, nowMs: number): void {
  const origin = sources.hud.halfStartedAt(t.token, t.ordinal, t.half) ?? t.startedUnix * 1000;
  const clock = halfClock(db, matchId, t.ordinal, t.half, origin);
  const samples = sources.hud.history(t.token, t.ordinal, t.half);
  const placed = samples.map((sm) => ({ tMs: clock(sm.at), sm }));
  // LIVEHUD's progress, on the half clock: the whole answer without a trusted
  // progress map, and the stand-in on one until a frame maps.
  const hudProg = progressStep(placed.map((x) => ({ tMs: x.tMs, prog: x.sm.prog })));
  if (t.pm) {
    // Asked per call: frames pushed below extend progTs, and the first mapped
    // frame ends the fallback.
    t.prog = (tMs) => mapThenFallback((u) => stepAt(t.progTs, t.progPs, u), t.progTs.length > 0 ? t.progTs[0]! : null, hudProg)(tMs);
  } else t.prog = hudProg;

  // One stat for both: the mtime is then the write that made the file this
  // long, never a later one than the bytes read (which would put a clock
  // mark late) nor an earlier one (which would release frames early, see
  // releasableFrames). A capped read leaves newer frames unread; that only
  // holds frames back.
  let size = 0;
  t.mtimeMs = 0;
  try { const stt = statSync(t.path); size = stt.size; t.mtimeMs = stt.mtimeMs; } catch { /* nothing to read */ }
  const head = readBytes(t.path, 0, HEADER_BYTES);
  const header = head && head.length === HEADER_BYTES ? decodeHeader(head) : null;
  const end = header && header.indexOffset > 0 && header.indexOffset <= size ? header.indexOffset : size;
  const len = Math.min(end - t.offset, sources.maxDecodeBytes);
  if (len > 0) {
    const chunk = readBytes(t.path, t.offset, len);
    if (chunk) {
      const { frames } = decodeFrames(chunk, 0, chunk.length, t.sideOf);
      if (frames.length > 0) {
        const last = frames[frames.length - 1]!;
        t.offset += last.offset + frameBytes(last.entities.length);
      }
      // The unpausedFrames rule, applied as the frames arrive: a frame is
      // kept only when its clock is past the last kept one.
      let lastT = t.times.length > 0 ? t.times[t.times.length - 1]!.tMs : -Infinity;
      for (const f of frames) {
        if (f.tMs <= lastT) continue;
        lastT = f.tMs;
        t.times.push({ tMs: f.tMs, offset: 0, players: EMPTY, entities: EMPTY });
        if (t.pm) {
          const v = furthestProg(t.pm, f);
          if (v !== null) {
            t.progTs.push(f.tMs);
            t.progPs.push(Math.max(v, t.progPs.length > 0 ? t.progPs[t.progPs.length - 1]! : -Infinity));
          }
        }
        t.queue.push(...t.walker.push(f));
      }
    }
  }
  // A clock mark, once the whole file has been read (the mtime belongs to
  // its last frame, not to one in the middle of a catch-up).
  const newest = t.times[t.times.length - 1];
  const lastMark = t.marks[t.marks.length - 1];
  if (newest && t.offset >= end && t.mtimeMs > 0 && (!lastMark || t.mtimeMs > lastMark.wall)) {
    t.marks.push({ wall: t.mtimeMs, zero: t.mtimeMs - newest.tMs, upToTMs: newest.tMs });
    // An hour of reads; older samples fall back to match_pauses.
    if (t.marks.length > 720) t.marks.splice(0, t.marks.length - 720);
  }
  t.updatedAt = nowMs;
  makePoints(st, t, placed, nowMs);
}

/** What happened between two consecutive snapshots worth marking. */
export function momentOf(prev: Snapshot | null, s: Snapshot): Moment | undefined {
  if (!prev) return undefined;
  if (s.alive <= 0 && prev.alive > 0) return 'wipe';
  if (s.tank === 'alive' && prev.tank !== 'alive') return 'tank_spawn';
  if (s.tank === 'dead' && prev.tank === 'alive') return 'tank_death';
  return undefined;
}

/** The queued snapshots as points. Each stands on the newest LIVEHUD sample
 *  at or before it on the half clock, or the half's first sample when none
 *  is (the opening seconds, before the first one arrived). With no sample
 *  at all yet they wait: a half without LIVEHUD gets no points. */
function makePoints(st: MatchState, t: HalfTrack, placed: { tMs: number; sm: LiveHudSample }[], nowMs: number): void {
  if (placed.length === 0 || t.queue.length === 0) return;
  const k = halfKey(t.ordinal, t.half);
  let list = st.points.get(k);
  if (!list) { list = []; st.points.set(k, list); }
  // When the frame was seen: zero + tMs from a recent clock mark that covers
  // it (its newest frame at or past it), the smallest of them; a frame past
  // every mark (read in a capped catch-up, a pause may have come since) was
  // seen now, the safe answer. Points already made keep their seenAt.
  const recent = t.marks.slice(-MARKS_KEPT);
  const seenOf = (tMs: number) => {
    let best = Infinity;
    for (const m of recent) if (m.upToTMs >= tMs) best = Math.min(best, m.zero + tMs);
    return best === Infinity ? nowMs : Math.min(best, nowMs);
  };
  for (const s of t.queue) {
    if (t.prog0 === null && s.prog !== null) t.prog0 = s.prog;
    if (s.tMs <= t.doneTMs) continue;
    t.doneTMs = s.tMs;
    const prev = t.prev;
    t.prev = s;
    let hud = placed[0]!.sm;
    for (let i = placed.length - 1; i >= 0; i--) if (placed[i]!.tMs <= s.tMs) { hud = placed[i]!.sm; break; }
    const moment = momentOf(prev, s);
    list.push({
      tMs: s.tMs, snap: { ...s, prog: progressMade(s.prog, t.prog0) }, hudAt: hud.at,
      seenAt: Math.max(hud.at, seenOf(s.tMs)), prices: new Map(),
      ...(moment ? { moment } : {}),
    });
  }
  t.queue = [];
}

/** Update the match's current half (at most once per RECOMPUTE_MS) and say
 *  which of its points a viewer `delayMs` behind may see. */
function refresh(db: DB, matchId: number, map: string, nowMs: number, delayMs: number):
  { st: MatchState; cur: { token: string; ordinal: number; half: 1 | 2; survTeam: 'a' | 'b' } | null; visible: (p: StoredPoint) => boolean } {
  const st = stateOf(matchId, nowMs);
  const none = { st, cur: null, visible: () => false };
  const cur = currentHalf(db, matchId);
  if (!cur) { st.track = null; return none; }
  const t = advance(db, matchId, st, cur, map, nowMs);
  if (!t) return { ...none, cur };
  let cutoffTMs = Infinity;
  if (delayMs > 0) {
    const released = releasableFrames(t.times, t.startedUnix * 1000, nowMs, delayMs, t.mtimeMs);
    cutoffTMs = released.length > 0 ? released[released.length - 1]!.tMs : -Infinity;
  }
  const seenCutoff = nowMs - Math.max(0, delayMs);
  return { st, cur, visible: (p) => p.tMs <= cutoffTMs && p.hudAt <= seenCutoff && p.seenAt <= seenCutoff };
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
    const sm = samples[i]!;
    if (sm.at > p.hudAt) continue;
    if (sm.tank >= 0 && sm.tank <= 100) { tankFlow = sm.tank; break; }
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
export interface PriceCtx { othersA: Float64Array; othersB: Float64Array; theta: number; calibration: number }

/** `future[idx]` is the half being priced, left out of the others; `played`
 *  the halves before it, which give the form tilt. */
export function priceCtx(model: WinModel, played: PlayedHalf[], future: FutureHalf[], idx: number, survTeam: 'a' | 'b', form: FormParams | null): PriceCtx {
  const t = form ? teamForm(model, played, undefined, form) : { a: 0, b: 0 };
  const rest = (team: 'a' | 'b', theta: number) =>
    sumDists(future.filter((x, i) => i !== idx && x.team === team).map((x) => tilt(model.dist(x.map), theta)));
  return { othersA: rest('a', t.a), othersB: rest('b', t.b), theta: t[survTeam], calibration: form?.calibration ?? CALIBRATION };
}

/** Team A's chance with the half `map` (surviving `survTeam`, its
 *  `half`-th turn on the map) at `snap` and the rest from `ctx`. */
export function price(model: WinModel, ctx: PriceCtx, map: string, survTeam: 'a' | 'b', half: 1 | 2, gap: number, snap: Snapshot): number {
  const pred = predictHalf(model, HALF_PARAMS, map, ctx.theta, snap, half);
  return winChanceDists(
    gap,
    survTeam === 'a' ? [ctx.othersA, pred] : [ctx.othersA],
    survTeam === 'b' ? [ctx.othersB, pred] : [ctx.othersB],
    ctx.calibration,
  );
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
 * point. A played half's points are priced the same way against the line
 * as it stood when that half began, so a point nobody asked for while its
 * half was live (or a form variant nobody asked for) is priced afterwards
 * to the same value.
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
  // marked when the survivors made it to the saferoom. A public viewer is
  // still the delay behind the half's end, so its last seconds wait.
  const seenCutoff = opts.nowMs - Math.max(0, opts.delayMs);
  const aliveOf = db.prepare('SELECT survivors_alive AS alive FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?');
  // The score each half started from, and the halves still to play then
  // (this one first).
  const slots: FutureHalf[] = [...played.map((r) => ({ team: r.survTeam, map: r.map })), ...future];
  let runA = 0, runB = 0;
  played.forEach((r, j) => {
    const [fromA, fromB] = [runA, runB];
    if (r.survTeam === 'a') runA += r.score; else runB += r.score;
    const list = st.points.get(halfKey(r.ordinal, r.half));
    if (!list || list.length === 0) return;
    let ctx: PriceCtx | null = null;
    const pts: WinPoint[] = list.filter((p) => p.seenAt <= seenCutoff).map((p) => {
      let pA = p.prices.get(form);
      if (pA === undefined) {
        ctx ??= priceCtx(model, played.slice(0, j), slots.slice(j), 0, r.survTeam, form);
        pA = price(model, ctx, r.map, r.survTeam, r.half as 1 | 2, fromA - fromB, p.snap);
        p.prices.set(form, pA);
      }
      return {
        ordinal: r.ordinal, half: r.half, survTeam: r.survTeam, map: r.map, scoreA: fromA, scoreB: fromB, pA,
        tMs: p.tMs, ...(p.moment ? { moment: p.moment } : {}),
      };
    });
    const alive = (aliveOf.get(matchId, r.ordinal, r.half) as { alive: number | null } | undefined)?.alive ?? null;
    if (pts.length > 0 && alive !== null && alive > 0) pts[pts.length - 1] = { ...pts[pts.length - 1]!, moment: 'saferoom' };
    if (pts.length > 0) out.finished.set(halfKey(r.ordinal, r.half), pts);
  });

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
      pA = price(model, ctx, nextMap, cur.survTeam, cur.half, scoreA - scoreB, p.snap);
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
 * Times are on the half clock (RoundMs, pauses excluded, the clock of replay
 * frames and the data feeds; see halfClock). `startedAt` is when the half
 * went live on this process's clock; without it the round row's started_at
 * stands in. Returns the rows written.
 */
export function writeProgressSamples(
  db: DB, matchId: number, ordinal: number, half: number, samples: LiveHudSample[], startedAt: number | null,
): number {
  let origin = startedAt;
  if (origin === null) {
    const row = db.prepare('SELECT started_at AS s FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
      .get(matchId, ordinal, half) as { s: string | null } | undefined;
    origin = row?.s ? sqliteMs(row.s) : null;
  }
  const rows: { t: number; prog: number; tank: number | null }[] = [];
  if (origin !== null && Number.isFinite(origin)) {
    const clock = halfClock(db, matchId, ordinal, half, origin);
    const placed = samples
      .filter((s) => s.prog >= 0 && s.prog <= 100)
      .map((s) => ({ t: Math.round(clock(s.at)), s }))
      .filter((x) => x.t >= 0)
      .sort((x, y) => x.t - y.t);
    let window = -1;
    for (const { t, s } of placed) {
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
