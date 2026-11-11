import { randomBytes } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, statfsSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { DEFAULT_DELAY_MS } from './replayTail.js';
import { IN_PROGRESS_MS } from './demos.js';
import { errCode } from './replayPush.js';
import {
  FrameScanner, HEADER_BYTES, STABLE_HEADER_BYTES, hasDemoMagic, readHeader,
} from './demoFrames.js';

/**
 * The live SourceTV demo feed behind the live 3D view (docs/theatre-3d.md,
 * "Phase 2: live 3D").
 *
 * Bytes of a demo that is still being recorded come in from one of two
 * sources, and leave through one code path:
 *
 * - pushed: a sidecar on a remote game box POSTs the new bytes of the growing
 *   `pug_<token>_<ordinal>_<map>.dem` to /api/demos/push (`applyPush`). Every
 *   batch is offset-appended to a copy in the live demo directory, the same
 *   exact-prefix rule as the .rpl push (src/replayPush.ts), and to memory;
 * - local (Dallas): the site shares the disk with the game server, so
 *   `pollLocal` reads the growing file in DEMO_DIR itself, by size.
 *
 * Either way every appended range gets the wall time at which the site first
 * had it, and a byte is released to viewers only once that time is at least
 * `delayMs` (DEFAULT_DELAY_MS, 10 s) in the past. That hold is the
 * anti-ghosting control: a SourceTV demo carries every infected player's
 * position while they are ghosts, and the live view is public, so a delay in
 * the viewer would be a wallhack for anyone who opens the socket. The site's
 * arrival time is never earlier than srcds wrote the byte, so the hold is at
 * least `delayMs` behind the recording. Every failure mode releases less: a
 * copy reloaded from disk after a site restart counts as arriving at the
 * reload, a clock that steps backwards cannot make a newer range look older
 * than the one before it, and nothing at all is released for a delay of zero
 * or less.
 *
 * Fan-out is from one in-memory buffer per recording. The token never leaves
 * the server: a recording is named to viewers by a random id, and nothing here
 * logs a path or a token (see `errCode`).
 */

/** Request body cap for one push. The sidecar sends about 44 KB a second; a
 *  catch-up after an outage is cut into pieces no larger than this. */
export const DEMO_PUSH_MAX_BATCH_BYTES = 1024 * 1024;
export const DEMO_PUSH_BODY_LIMIT = DEMO_PUSH_MAX_BATCH_BYTES;
/** No live demo grows past this (a whole match map is about 30 MB). */
export const DEMO_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Total bytes the live demo directory may hold before a brand new copy is
 *  refused with 507. Appends to a copy already on disk are never refused by
 *  it, the same rule as PUSH_LIVE_STORE_MAX_BYTES for the .rpl push. */
export const DEMO_LIVE_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Free space the live demo directory's filesystem must keep: a new copy is
 *  refused with 507 below it, so a pile of demos cannot fill the site's disk. */
export const DEMO_LIVE_FREE_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
/** A recording that has not grown for this long is over ('end'), even while
 *  its match is live (a crashed recording, a dead sidecar). The same figure
 *  as IN_PROGRESS_MS: srcds writes a recording every few seconds. */
export const DEMO_IDLE_END_MS = IN_PROGRESS_MS;
/** How often the local mode lists DEMO_DIR for new recordings. Known files
 *  are polled by size every tick. */
const LOCAL_DISCOVER_MS = 2000;
/** How often stale copies in the live demo directory are deleted. */
const PRUNE_EVERY_MS = 60_000;
/** A copy untouched this long goes whatever its match is doing. */
export const DEMO_LIVE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Bytes per send to one viewer while it catches up (as the spike relay). */
const PIECE_BYTES = 256 * 1024;
/** Demo time per tick while the header is still unwritten (srcds fills in
 *  ticks and playback time only when the recording stops). Only `demoT` in
 *  hello and pos uses it. */
const FALLBACK_TICK_INTERVAL = 1 / 100;

const TOKEN_RE = /^[0-9a-f]{32}$/;
const MAP_RE = /^[A-Za-z0-9_.-]{1,96}$/;
const LOCAL_NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_(.+)\.dem$/;
const LIVE_NAME_RE = /^live_([0-9a-f]{32})_(\d+)_(\d+)\.dem$/;

export function liveDemoFileName(token: string, ordinal: number, started: number): string {
  return `live_${token}_${ordinal}_${started}.dem`;
}

// ---------------------------------------------------------------- one recording

export class Recording {
  /** What viewers call this recording (hello `id`, X-Demo-Id). Random, so it
   *  says nothing about the token; a new recording gets a new one. */
  readonly id = randomBytes(8).toString('hex');
  buf = Buffer.alloc(1 << 20);
  /** Bytes the site has. */
  len = 0;
  /** Bytes released to viewers: never more than `len`, never a byte younger
   *  than the delay. */
  released = 0;
  /** Appended ranges: ends[i] is where range i ends, times[i] when the site
   *  had it. Both only grow. */
  readonly ends: number[] = [];
  readonly times: number[] = [];
  lastArrival = 0;
  /** End of the newest complete frame within the released bytes, when it was
   *  released, and its demo time: the `pos` marks. */
  frameLen = 0;
  posWall = 0;
  demoT = 0;
  /** The released bytes reached a dem_stop frame. */
  stopped = false;
  private scanner = new FrameScanner();
  private scanBroken = false;
  private tickInterval = 0;
  readonly clients = new Set<LiveClient>();

  constructor(
    readonly token: string,
    readonly ordinal: number,
    readonly source: 'push' | 'local',
    /** The box's identity for this recording: a newer `started` at offset 0
     *  is a new recording at the same name. */
    readonly started: number,
  ) {}

  /** Append bytes the site has just had. `now` is clamped to the previous
   *  range's time so a clock stepping backwards cannot date new bytes before
   *  older ones. */
  append(b: Uint8Array, now: number): void {
    if (b.length === 0) return;
    if (this.len + b.length > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + b.length) cap *= 2;
      const next = Buffer.alloc(cap);
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    this.buf.set(b, this.len);
    this.len += b.length;
    const prev = this.times.length ? this.times[this.times.length - 1] : 0;
    const at = Math.max(prev, now);
    this.ends.push(this.len);
    this.times.push(at);
    this.lastArrival = at;
  }

  /** How many bytes may be out at `now`: the end of the last range the site
   *  had at least `delayMs` ago. Zero for a delay that is not positive. */
  releasable(now: number, delayMs: number): number {
    if (!(delayMs > 0)) return 0;
    const limit = now - delayMs;
    let lo = 0, hi = this.times.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= limit) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? 0 : this.ends[found];
  }

  /** Move the release point forward (never back) and update the pos marks. */
  release(now: number, delayMs: number): boolean {
    const r = Math.min(this.releasable(now, delayMs), this.len);
    if (r <= this.released) return false;
    this.released = r;
    const view = this.buf.subarray(0, r);
    if (!this.tickInterval) {
      const h = readHeader(view);
      if (h) this.tickInterval = h.tickInterval || FALLBACK_TICK_INTERVAL;
    }
    if (!this.scanBroken) {
      try {
        this.scanner.scan(view);
      } catch {
        // Not a frame layout this scanner knows: the bytes still go out (the
        // viewer's parser is the judge), only the pos marks stop moving.
        this.scanBroken = true;
      }
      if (this.scanner.off > this.frameLen && this.scanner.off <= r) {
        this.frameLen = this.scanner.off;
        this.posWall = now;
      }
      if (this.scanner.tick0 >= 0) {
        this.demoT = (this.scanner.lastTick - this.scanner.tick0) * (this.tickInterval || FALLBACK_TICK_INTERVAL);
      }
      if (this.scanner.stopped) this.stopped = true;
    }
    return true;
  }
}

/** One viewer, over WebSocket or HTTP. */
export interface LiveClient {
  /** Bytes of the recording this viewer has been sent (or had already). */
  sent: number;
  busy: boolean;
  /** Write demo bytes; resolves once the transport has taken them. */
  send(b: Uint8Array): Promise<void>;
  /** Text messages (WebSocket only: hello, pos, end, restart). */
  text?(s: string): void;
  /** Close normally (after 'end' or 'restart'). */
  end(): void;
}

// ---------------------------------------------------------------- pushes

export interface DemoPushMeta {
  token: string;
  ordinal: number;
  map: string;
  offset: number;
  started: number;
}
export type ParsedDemoPush = { ok: true; meta: DemoPushMeta } | { ok: false; status: 400 | 413; error: string };
export type DemoPushResult =
  | { status: 200; length: number }
  | { status: 409; length: number; error?: string }
  | { status: 400; error: string }
  | { status: 413; error: string }
  | { status: 507; error: string };

function headerValue(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? undefined : v;
}
function intHeader(v: string | undefined, max: number): number | null {
  if (v === undefined || !/^\d{1,15}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

/**
 * Read a push's fields from its request headers. The token travels in a
 * header, never the URL: URLs end up in access logs. Nothing here touches the
 * disk or the database.
 */
export function parseDemoPush(
  headers: Record<string, string | string[] | undefined>, body: unknown,
): ParsedDemoPush {
  const bad = (error: string): ParsedDemoPush => ({ ok: false, status: 400, error });
  const token = headerValue(headers, 'x-demo-token');
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad('bad token');
  const ordinal = intHeader(headerValue(headers, 'x-demo-ordinal'), 999);
  if (ordinal === null) return bad('bad ordinal');
  const map = headerValue(headers, 'x-demo-map');
  if (typeof map !== 'string' || !MAP_RE.test(map)) return bad('bad map');
  const offset = intHeader(headerValue(headers, 'x-demo-offset'), DEMO_MAX_FILE_BYTES);
  if (offset === null) return bad('bad offset');
  const started = intHeader(headerValue(headers, 'x-demo-started'), 0xffff_ffff);
  if (started === null || started === 0) return bad('bad started');
  if (body !== undefined && !Buffer.isBuffer(body)) return bad('expected application/octet-stream');
  const data = body ?? Buffer.alloc(0);
  if (data.length > DEMO_PUSH_MAX_BATCH_BYTES) return { ok: false, status: 413, error: 'batch too large' };
  if (offset + data.length > DEMO_MAX_FILE_BYTES) return { ok: false, status: 413, error: 'file too large' };
  return { ok: true, meta: { token, ordinal, map, offset, started } };
}

// ---------------------------------------------------------------- the feed

export interface DemoFeedOptions {
  db: DB;
  /** Where pushed copies are kept. Empty turns the push off. */
  liveDir?: string;
  /** DEMO_DIR, read directly when `local` is on (Dallas). */
  demoDir?: string;
  local?: boolean;
  delayMs?: number;
  idleEndMs?: number;
  maxStoreBytes?: number;
  freeFloorBytes?: number;
  /** Free bytes on the live directory's filesystem. Injectable for tests. */
  freeBytes?: (dir: string) => number;
  now?: () => number;
}

interface LocalTail { path: string; ino: number; pos: number; head: Buffer | null; rec: Recording }

function defaultFreeBytes(dir: string): number {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

export class DemoFeed {
  readonly liveDir: string;
  readonly demoDir: string;
  readonly local: boolean;
  readonly delayMs: number;
  readonly idleEndMs: number;
  private readonly db: DB;
  private readonly maxStoreBytes: number;
  private readonly freeFloorBytes: number;
  private readonly freeBytes: (dir: string) => number;
  readonly now: () => number;
  /** token/ordinal -> recording. */
  private readonly recordings = new Map<string, Recording>();
  private readonly tails = new Map<string, LocalTail>();
  /** Local recordings already finished and dropped, by key -> inode, so the
   *  directory listing does not pick them up again. */
  private readonly retired = new Map<string, number>();
  private liveTokens = new Set<string>();
  private lastDiscover = -Infinity;
  private lastPrune = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: DemoFeedOptions) {
    this.db = o.db;
    this.liveDir = o.liveDir ?? '';
    this.demoDir = o.demoDir ?? '';
    this.local = Boolean(o.local && this.demoDir);
    this.delayMs = o.delayMs ?? DEFAULT_DELAY_MS;
    this.idleEndMs = o.idleEndMs ?? DEMO_IDLE_END_MS;
    this.maxStoreBytes = o.maxStoreBytes ?? DEMO_LIVE_STORE_MAX_BYTES;
    this.freeFloorBytes = o.freeFloorBytes ?? DEMO_LIVE_FREE_FLOOR_BYTES;
    this.freeBytes = o.freeBytes ?? defaultFreeBytes;
    this.now = o.now ?? Date.now;
  }

  /** Whether any source is on. Off, the live routes answer 404. */
  get enabled(): boolean {
    return Boolean(this.liveDir) || this.local;
  }

  start(everyMs = 250): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => this.tickSafely(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const rec of this.recordings.values()) for (const c of rec.clients) c.end();
    this.recordings.clear();
    this.tails.clear();
  }

  private tickSafely(): void {
    try {
      this.tick();
    } catch (err) {
      console.error('[demos] live feed tick failed:', errCode(err));
    }
  }

  // ------------------------------------------------------------ pushes

  /**
   * Apply one pushed batch. Synchronous on purpose, as `applyPush` for the
   * .rpl push: Node runs one handler at a time, so nothing changes between the
   * checks and the write. The caller has already checked that the token
   * belongs to a live match.
   *
   * - The first batch (offset 0, with data) must carry the whole demo header.
   * - `started` names the recording on the box. Offset 0 with a newer
   *   `started` than the copy's is a new recording at the same (token,
   *   ordinal): the copy is replaced and its viewers are told to restart. An
   *   older `started` at offset 0, or any other `started` than the copy's at
   *   another offset, is 409 'stale recording' and changes nothing.
   * - Otherwise the batch must start exactly where the copy ends (409 with the
   *   length when not), except a retry whose bytes are all already there and
   *   identical (200, nothing written).
   * - A brand new copy is refused with 507 while the live directory is over
   *   its size cap or its filesystem is under the free-space floor.
   */
  applyPush(m: DemoPushMeta, data: Buffer): DemoPushResult {
    const key = keyOf(m.token, m.ordinal);
    let rec = this.recordings.get(key) ?? this.reloadPushed(m.token, m.ordinal);
    if (rec && rec.source === 'local') return { status: 409, length: rec.len, error: 'recorded locally' };

    if (m.offset === 0 && data.length > 0) {
      if (data.length < HEADER_BYTES || !hasDemoMagic(data)) {
        return { status: 400, error: 'the first batch must carry the whole demo header' };
      }
      if (rec && rec.started !== m.started) {
        if (m.started < rec.started) return { status: 409, length: rec.len, error: 'stale recording' };
        const full = this.storeFull();
        if (full) return full;
        this.dropPushedFile(rec);
        this.replace(key, null);
        rec = undefined;
      }
      if (!rec) {
        const full = this.storeFull();
        if (full) return full;
        rec = new Recording(m.token, m.ordinal, 'push', m.started);
        this.recordings.set(key, rec);
      }
    } else if (rec && rec.started !== m.started) {
      return { status: 409, length: rec.len, error: 'stale recording' };
    }
    if (!rec) return { status: 409, length: 0 };

    const end = m.offset + data.length;
    if (m.offset < rec.len) {
      if (end > rec.len) return { status: 409, length: rec.len };
      if (!rec.buf.subarray(m.offset, end).equals(data)) return { status: 409, length: rec.len };
      return { status: 200, length: rec.len };
    }
    if (m.offset !== rec.len) return { status: 409, length: rec.len };
    if (data.length === 0) return { status: 200, length: rec.len };
    if (end > DEMO_MAX_FILE_BYTES) return { status: 413, error: 'file too large' };

    // Disk first: a failed write leaves memory as it was, so the copy and the
    // buffer stay the same bytes and the sidecar resumes from the length.
    mkdirSync(this.liveDir, { recursive: true });
    const fd = openSync(join(this.liveDir, liveDemoFileName(rec.token, rec.ordinal, rec.started)), 'a');
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    rec.append(data, this.now());
    return { status: 200, length: rec.len };
  }

  private storeFull(): { status: 507; error: string } | null {
    if (!this.liveDir) return { status: 507, error: 'live store is full' };
    let total = 0;
    try {
      for (const name of readdirSync(this.liveDir)) {
        try { total += statSync(join(this.liveDir, name)).size; } catch { /* gone */ }
      }
    } catch { /* not created yet: empty */ }
    if (total > this.maxStoreBytes) return { status: 507, error: 'live store is full' };
    let free: number;
    try {
      mkdirSync(this.liveDir, { recursive: true });
      free = this.freeBytes(this.liveDir);
    } catch {
      // Free space unknown: refuse a new copy rather than guess.
      return { status: 507, error: 'live store is full' };
    }
    if (free < this.freeFloorBytes) return { status: 507, error: 'live store is full' };
    return null;
  }

  /** After a site restart the copy is on disk and memory is empty. Its bytes
   *  count as arriving now: the site cannot know when it had them, and later
   *  is the safe side. */
  private reloadPushed(token: string, ordinal: number): Recording | undefined {
    if (!this.liveDir) return undefined;
    let names: string[];
    try { names = readdirSync(this.liveDir); } catch { return undefined; }
    let best: { name: string; started: number } | null = null;
    for (const name of names) {
      const mm = LIVE_NAME_RE.exec(name);
      if (!mm || mm[1] !== token || Number(mm[2]) !== ordinal) continue;
      const started = Number(mm[3]);
      if (!best || started > best.started) best = { name, started };
    }
    if (!best) return undefined;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.liveDir, best.name));
    } catch (err) {
      console.error('[demos] could not reload a live demo copy:', errCode(err));
      return undefined;
    }
    const rec = new Recording(token, ordinal, 'push', best.started);
    rec.append(bytes, this.now());
    this.recordings.set(keyOf(token, ordinal), rec);
    return rec;
  }

  private dropPushedFile(rec: Recording): void {
    try {
      unlinkSync(join(this.liveDir, liveDemoFileName(rec.token, rec.ordinal, rec.started)));
    } catch (err) {
      if (errCode(err) !== 'ENOENT') console.error('[demos] could not delete a live demo copy:', errCode(err));
    }
  }

  /** Put `next` at `key` (or nothing), telling the old recording's viewers to
   *  start over: a new recording at the same name. */
  private replace(key: string, next: Recording | null): void {
    const old = this.recordings.get(key);
    if (old) {
      for (const c of old.clients) { c.text?.(JSON.stringify({ type: 'restart' })); c.end(); }
      old.clients.clear();
    }
    if (next) this.recordings.set(key, next); else this.recordings.delete(key);
  }

  // ------------------------------------------------------------ Dallas: the file itself

  /**
   * Read the growing demos of live matches straight from DEMO_DIR. Only files
   * written within IN_PROGRESS_MS when first listed are followed: a demo
   * pulled from another box arrives already finished and keeps its old mtime.
   * A file that shrank, was replaced or whose fixed header part changed is a
   * new recording (viewers restart).
   */
  pollLocal(now: number): void {
    if (!this.local) return;
    if (now - this.lastDiscover >= LOCAL_DISCOVER_MS) {
      this.lastDiscover = now;
      this.discoverLocal(now);
    }
    for (const [key, t] of this.tails) {
      if (!this.liveTokens.has(t.rec.token)) continue;
      try {
        this.readTail(key, t, now);
      } catch (err) {
        console.error('[demos] local demo read failed:', errCode(err));
      }
    }
  }

  private discoverLocal(now: number): void {
    if (this.liveTokens.size === 0) return;
    let names: string[];
    try { names = readdirSync(this.demoDir); } catch { return; }
    for (const name of names) {
      const mm = LOCAL_NAME_RE.exec(name);
      if (!mm || !this.liveTokens.has(mm[1])) continue;
      const key = keyOf(mm[1], Number(mm[2]));
      if (this.tails.has(key) || this.recordings.has(key)) continue;
      const path = join(this.demoDir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile() || now - st.mtimeMs > IN_PROGRESS_MS) continue;
      if (this.retired.get(key) === st.ino) continue;
      const rec = new Recording(mm[1], Number(mm[2]), 'local', now);
      this.recordings.set(key, rec);
      this.tails.set(key, { path, ino: st.ino, pos: 0, head: null, rec });
    }
  }

  private readTail(key: string, t: LocalTail, now: number): void {
    let st;
    try { st = statSync(t.path); } catch { return; }   // gone: it stops growing, idle ends it
    let restart = st.ino !== t.ino || st.size < t.pos;
    if (!restart && t.head) {
      const h = readAt(t.path, 0, STABLE_HEADER_BYTES);
      if (h && !h.equals(t.head)) restart = true;
    }
    if (restart) {
      const rec = new Recording(t.rec.token, t.rec.ordinal, 'local', now);
      this.replace(key, rec);
      t.rec = rec; t.ino = st.ino; t.pos = 0; t.head = null;
    }
    if (st.size <= t.pos) return;
    const want = Math.min(st.size, DEMO_MAX_FILE_BYTES) - t.pos;
    if (want <= 0) return;
    const b = readAt(t.path, t.pos, want, true);
    if (!b || b.length === 0) return;
    if (t.pos === 0 && !hasDemoMagic(b)) {
      // Not a demo, or not even 8 bytes yet: try again next tick, from 0.
      if (b.length >= 8) { this.retire(key, t); }
      return;
    }
    t.rec.append(b, now);
    t.pos += b.length;
    if (!t.head && t.pos >= STABLE_HEADER_BYTES) t.head = Buffer.from(t.rec.buf.subarray(0, STABLE_HEADER_BYTES));
  }

  private retire(key: string, t: LocalTail): void {
    this.retired.set(key, t.ino);
    this.tails.delete(key);
    this.replace(key, null);
  }

  // ------------------------------------------------------------ viewers

  /** Is this recording's match still live (as of the last tick)? */
  private matchLive(rec: Recording): boolean {
    return this.liveTokens.has(rec.token);
  }

  /** The recording viewers of this match are served: the highest ordinal
   *  that has released anything, else the highest one at all (a viewer then
   *  waits for its first bytes). A new map's recording takes over only once
   *  its own first bytes are out, so the switch is not announced early and
   *  the old map's last bytes are not cut off. */
  current(token: string): Recording | null {
    let best: Recording | null = null, bestAny: Recording | null = null;
    for (const rec of this.recordings.values()) {
      if (rec.token !== token) continue;
      if (!bestAny || rec.ordinal > bestAny.ordinal) bestAny = rec;
      if (rec.released > 0 && (!best || rec.ordinal > best.ordinal)) best = rec;
    }
    return best ?? bestAny;
  }

  isComplete(rec: Recording, now = this.now()): boolean {
    if (rec.released < rec.len) return false;
    return rec.stopped || !this.matchLive(rec) || (rec.len > 0 && now - rec.lastArrival >= this.idleEndMs);
  }

  private superseded(rec: Recording): boolean {
    const cur = this.current(rec.token);
    return cur !== null && cur !== rec;
  }

  /** Where a (re)connecting viewer starts: its offset when it names this
   *  recording and the offset is within what is released, else byte 0. */
  startOffset(rec: Recording, offset: unknown, id: unknown): number {
    const off = Number(offset);
    return id === rec.id && Number.isSafeInteger(off) && off >= 0 && off <= rec.released ? off : 0;
  }

  hello(rec: Recording, offset: number): string {
    return JSON.stringify({
      type: 'hello', id: rec.id, offset, size: rec.released, complete: this.isComplete(rec),
      demoT: +rec.demoT.toFixed(2), wall: this.now(),
    });
  }

  subscribe(rec: Recording, c: LiveClient): void {
    rec.clients.add(c);
    void this.pump(rec, c);
  }

  unsubscribe(rec: Recording, c: LiveClient): void {
    rec.clients.delete(c);
  }

  /** Send a viewer what is released and it has not had, in pieces, waiting
   *  for its transport each time; then 'end' or 'restart' once it has every
   *  byte and the recording is over or replaced by the next map's. */
  private async pump(rec: Recording, c: LiveClient): Promise<void> {
    if (c.busy) return;
    c.busy = true;
    try {
      while (rec.clients.has(c)) {
        if (c.sent >= rec.released) {
          if (c.sent >= rec.len) {
            if (this.isComplete(rec)) {
              c.text?.(JSON.stringify({ type: 'end', size: rec.len }));
              rec.clients.delete(c); c.end();
            } else if (this.superseded(rec)) {
              c.text?.(JSON.stringify({ type: 'restart' }));
              rec.clients.delete(c); c.end();
            }
          }
          break;
        }
        const n = Math.min(PIECE_BYTES, rec.released - c.sent);
        const piece = rec.buf.subarray(c.sent, c.sent + n);
        c.sent += n;
        try {
          await c.send(piece);
        } catch {
          rec.clients.delete(c);
          break;
        }
      }
    } finally {
      c.busy = false;
    }
  }

  // ------------------------------------------------------------ the clock

  /** Everything time-driven, about four times a second: which matches are
   *  live, the local files, releasing bytes whose hold is over, sending them,
   *  pos marks, end and restart, and dropping what nobody needs. */
  tick(now = this.now()): void {
    this.refreshLive();
    this.pollLocal(now);
    for (const rec of this.recordings.values()) rec.release(now, this.delayMs);
    for (const rec of this.recordings.values()) {
      if (rec.clients.size === 0) continue;
      const pos = rec.frameLen > 0
        ? JSON.stringify({ type: 'pos', off: rec.frameLen, wall: rec.posWall, demoT: +rec.demoT.toFixed(2) })
        : null;
      for (const c of [...rec.clients]) {
        // Pump first: its first piece goes out synchronously, so a mark can
        // follow the bytes it names in the same tick.
        void this.pump(rec, c);
        if (pos && c.text && rec.clients.has(c) && c.sent >= rec.frameLen) c.text(pos);
      }
    }
    this.dropFinished(now);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      // File ages are on the real clock, whatever clock drives the feed.
      this.pruneLiveDir(Date.now());
    }
  }

  private refreshLive(): void {
    const rows = this.db
      .prepare("SELECT token FROM matches WHERE state = 'live' AND token IS NOT NULL")
      .all() as { token: string }[];
    this.liveTokens = new Set(rows.map((r) => r.token));
  }

  /** Memory goes once a recording has no viewers and is either over or
   *  replaced by a newer map's. A pushed copy stays on disk (a late batch
   *  reloads it); a local one is remembered so it is not listed again. */
  private dropFinished(now: number): void {
    for (const [key, rec] of [...this.recordings]) {
      if (rec.clients.size > 0) continue;
      const over = !this.matchLive(rec) || this.superseded(rec)
        || (rec.len > 0 && now - rec.lastArrival >= this.idleEndMs);
      if (!over) continue;
      if (this.matchLive(rec) && rec.released < rec.len) continue;
      this.recordings.delete(key);
      const t = this.tails.get(key);
      if (t) {
        this.tails.delete(key);
        if (this.matchLive(rec)) this.retired.set(key, t.ino);
      }
    }
    for (const key of [...this.retired.keys()]) {
      if (!this.liveTokens.has(key.slice(0, 32))) this.retired.delete(key);
    }
  }

  /** Delete pushed copies whose match is no longer live, and any untouched
   *  for a day. Never throws; never logs a name. */
  pruneLiveDir(now: number): number {
    if (!this.liveDir) return 0;
    let names: string[];
    try { names = readdirSync(this.liveDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const mm = LIVE_NAME_RE.exec(name);
      if (!mm) continue;
      const path = join(this.liveDir, name);
      let mtimeMs: number;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      if (this.liveTokens.has(mm[1]) && now - mtimeMs <= DEMO_LIVE_FILE_MAX_AGE_MS) continue;
      const key = keyOf(mm[1], Number(mm[2]));
      const rec = this.recordings.get(key);
      if (rec && rec.clients.size > 0) continue;
      try {
        unlinkSync(path);
        removed++;
        if (rec && rec.started === Number(mm[3])) this.recordings.delete(key);
      } catch (err) {
        console.error('[demos] could not delete a live demo copy:', errCode(err));
      }
    }
    return removed;
  }

  /** For tests and status: the recordings held, without their tokens. */
  stats(): { id: string; ordinal: number; source: string; len: number; released: number; clients: number }[] {
    return [...this.recordings.values()].map((r) => ({
      id: r.id, ordinal: r.ordinal, source: r.source, len: r.len, released: r.released, clients: r.clients.size,
    }));
  }
}

function keyOf(token: string, ordinal: number): string {
  return `${token}/${ordinal}`;
}

/** `length` bytes at `at`, or fewer when `partial` and the file is shorter;
 *  null when it cannot be read. */
function readAt(path: string, at: number, length: number, partial = false): Buffer | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const b = Buffer.alloc(length);
    const n = readSync(fd, b, 0, length, at);
    if (n < length && !partial) return null;
    return n < length ? b.subarray(0, n) : b;
  } finally {
    closeSync(fd);
  }
}
