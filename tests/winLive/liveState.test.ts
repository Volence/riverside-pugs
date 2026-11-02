import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../../src/db.js';
import { encodeFrame, encodeHeader, frameBytes, STATE, VERSION, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import { LiveHudStore, type LiveHudLine } from '../../src/cast/liveHud.js';
import { buildWinModel, liveWinLine, type HalfRow } from '../../src/winProb.js';
import { insertDraft, publishCampaign } from '../../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDirs } from '../../src/campaignRegistry.js';
import { setSetting } from '../../src/settings.js';
import { decodeRoundReplay } from '../../src/metrics/replayRound.js';
import { halfSnapshots, progressStep } from '../../src/winLive/snapshot.js';
import { buildProgressMap, furthestProg } from '../../src/winLive/progressMap.js';
import { progressMade } from '../../src/winLive/halfModel.js';
import {
  configureLiveWin, liveSnapshot, MAX_DECODE_BYTES, PROGRESS_MAPS, RECOMPUTE_MS, resetLiveWin, winLiveOption, writeProgressSamples,
} from '../../src/winLive/liveState.js';

const TOKEN = 'c'.repeat(32);
const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000800${i}`);
/** The half went live a minute before "now". */
const NOW = Math.floor(Date.now() / 1000) * 1000;
const START = NOW - 60_000;

function history(): HalfRow[] {
  const rows: HalfRow[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ map: 'm1', score: i % 3 === 0 ? 600 + (i % 7) * 20 : 40 + (i % 5) * 10, made: i % 3 === 0 });
    rows.push({ map: 'm2', score: i % 2 === 0 ? 800 + (i % 7) * 20 : 60 + (i % 5) * 10, made: i % 2 === 0 });
  }
  return rows;
}
const model = buildWinModel(history());

const ALIVE = STATE.PRESENT | STATE.ALIVE;
function player(slot: number, p: Partial<PlayerSample> = {}): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: ALIVE, health: 100, temp: 1, cls: slot < 4 ? 0 : 3, weapon: 0, clip: 0, reserve: 0, ...p };
}
/** A half every 500 ms up to `toMs` and one frame past it (a frame's
 *  snapshots come out once the next frame is read): survivors walk +x 10
 *  units per second, and from `tankAt` slot 4 is the tank. */
function frames(toMs: number, tankAt = 30_000, fromMs = 0): Frame[] {
  const out: Frame[] = [];
  for (let t = fromMs; t <= toMs + 500; t += 500) {
    const x = Math.round(t / 100);
    out.push({
      tMs: t, offset: 0, entities: [],
      players: [
        player(0, { x }), player(1, { x }), player(2, { x }), player(3, { x }),
        t >= tankAt ? player(4, { cls: 5, health: 6000 }) : player(4), player(5), player(6), player(7),
      ],
    });
  }
  return out;
}

let db: DB;
let id: number;
let liveDir: string;
let hud: LiveHudStore;

function writeHalf(fs: Frame[], startedUnixMs = START, map = 'm1', mtimeMs = NOW): string {
  const h = encodeHeader({
    version: VERSION, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map,
    startedUnix: Math.floor(startedUnixMs / 1000), indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: IDS, infectedMask: 0xf0, sidesKnown: true, losKnown: false,
  });
  const path = join(liveDir, `pug_${TOKEN}_0_1.rpl`);
  writeFileSync(path, Buffer.concat([h, ...fs.map(encodeFrame)]));
  // The writer is current: the file was touched just now.
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}
const line = (prog: number, tank = 40): LiveHudLine => ({ prog, tank, witch: 0, players: [] });
const sample = (at: number, prog: number, tank = 40) => hud.record(TOKEN, line(prog, tank), at, { ordinal: 0, half: 1 });

beforeEach(() => {
  db = openDb(':memory:');
  setMissionsDirs([]);
  invalidateCampaignCache();
  insertDraft(db, {
    slug: 'five', name: 'Five', vpkFilename: 'five.vpk', sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
  }, ['m1', 'm2', 'm1b', 'm2b', 'fin'].map((map, n) => ({ map, display: null, isFinale: n === 4 })));
  publishCampaign(db, 'five', 'Five');
  invalidateCampaignCache();
  id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'five', ?)").run(TOKEN).lastInsertRowid);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen, phase, phase_since) VALUES (?, 'm1', datetime('now'), 'live', datetime('now'))").run(id);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, reliable, started_at) VALUES (?, 0, 1, 'a', 1, datetime('now'))").run(id);
  liveDir = mkdtempSync(join(tmpdir(), 'winlive-'));
  hud = new LiveHudStore();
  configureLiveWin({ replayDir: '', liveDir, hud, progressMaps: new Map(), maxDecodeBytes: MAX_DECODE_BYTES });
  hud.resetReach(TOKEN, 0, 1, START);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(liveDir, { recursive: true, force: true });
  setMissionsDirs([]);
  invalidateCampaignCache();
});

describe('liveSnapshot', () => {
  it('uses only LIVEHUD samples as old as the delay: 4 s old is not used, 12 s old is', () => {
    writeHalf(frames(60_000));
    sample(START + 1000, 5, 40);
    sample(NOW - 20_000, 10, 41);
    sample(NOW - 12_000, 30, 45);
    sample(NOW - 4000, 50, 50);
    const pub = liveSnapshot(db, id, NOW, 10_000)!;
    // Frames up to 50 s are released; the 12 s old sample is the newest it stands on.
    expect(pub.snap.tMs).toBe(50_000);
    expect(pub.snap.prog).toBe(30 - 5);
    expect(pub.tankFlow).toBe(45);
    const caster = liveSnapshot(db, id, NOW, 0)!;
    expect(caster.snap.tMs).toBe(60_000);
    expect(caster.snap.prog).toBe(50 - 5);
    expect(caster.tankFlow).toBe(50);
  });

  it('is null with no LIVEHUD, and with no live replay', () => {
    writeHalf(frames(60_000));
    expect(liveSnapshot(db, id, NOW, 0)).toBeNull();
    rmSync(join(liveDir, `pug_${TOKEN}_0_1.rpl`));
    sample(START + 1000, 5);
    configureLiveWin({});
    expect(liveSnapshot(db, id, NOW, 0)).toBeNull();
  });

  it('takes a prog -1 sample as the previous one, never as 0%', () => {
    writeHalf(frames(60_000));
    sample(START + 1000, 5);
    sample(START + 20_000, 30);
    sample(START + 40_000, -1, -1);
    const s = liveSnapshot(db, id, NOW, 0)!;
    expect(s.snap.prog).toBe(25);
    expect(s.tankFlow).toBe(40);
  });

  it('reads progress the way the model was trained: running max of the trusted progress map, made from the first value', () => {
    const fs = frames(60_000);
    // A progress map along x: 0% at x 0, 1% per 6 units.
    const pm = buildProgressMap('m1', Array.from({ length: 120 }, (_, i) => ({ x: i * 6, y: 0, z: 0, prog: i })));
    configureLiveWin({ progressMaps: new Map([['m1', pm]]) });
    const path = writeHalf(fs);
    sample(START + 1000, 99); // LIVEHUD progress is not read on a mapped map
    const got = liveSnapshot(db, id, NOW, 0)!;
    // The dataset's pipeline (scripts/win-dataset.ts) on the same bytes.
    const rr = decodeRoundReplay(readFileSync(path), () => null)!;
    const pts = rr.frames.flatMap((f) => { const v = furthestProg(pm, f); return v === null ? [] : [{ tMs: f.tMs, prog: v }]; });
    const snaps = halfSnapshots(rr, progressStep(pts), null);
    const prog0 = snaps.find((x) => x.prog !== null)!.prog;
    const want = snaps[snaps.length - 1]!;
    expect(got.snap).toEqual({ ...want, prog: progressMade(want.prog, prog0) });
    expect(got.snap.prog).toBeGreaterThan(0);
  });

  it('stands on LIVEHUD progress until the first frame maps, then on the map, made from the first known value', () => {
    // One mapped cell at x 600: frames within 3 cells of it map, from about 13 s.
    const pm = buildProgressMap('m1', [{ x: 600, y: 0, z: 0, prog: 50 }]);
    configureLiveWin({ progressMaps: new Map([['m1', pm]]) });
    writeHalf(frames(60_000));
    sample(START + 1000, 5);
    const s = liveSnapshot(db, id, NOW, 0)!;
    // prog0 is the LIVEHUD 5 the opening seconds stood on; the map says 50 from then on.
    expect(s.snap.prog).toBe(45);
  });

  it('ignores the abandoned attempt of a restarted half until the new file arrives', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHalf(frames(60_000));
    sample(START + 1000, 5);
    expect(liveSnapshot(db, id, NOW, 0)).not.toBeNull();
    // The half restarts 50 s in; the old file is still there.
    hud.resetReach(TOKEN, 0, 1, START + 50_000);
    resetLiveWin(id, 0, 1);
    sample(START + 51_000, 5);
    expect(liveSnapshot(db, id, NOW + 6000, 0)).toBeNull();
  });
});

describe('liveWinLine with points during a half', () => {
  const plain = () => liveWinLine(db, id, 'five', model)!;
  const live = (delayMs: number, nowMs = NOW) => liveWinLine(db, id, 'five', model, { live: true, nowMs, delayMs })!;

  it('is today\'s line exactly when there is no LIVEHUD at all', () => {
    writeHalf(frames(60_000));
    expect(live(0)).toEqual(plain());
    expect(live(10_000)).toEqual(plain());
  });

  it('is today\'s line exactly with no live replay', () => {
    sample(START + 1000, 5);
    expect(live(0)).toEqual(plain());
  });

  it('starts on the half-end line and adds one point per 5 s, the public one only up to its delay', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    sample(START + 30_000, 20);
    const base = plain();
    const caster = live(0);
    const inHalf = caster.points.slice(base.points.length);
    expect(caster.points.slice(0, base.points.length)).toEqual(base.points);
    expect(inHalf.map((p) => p.tMs)).toEqual([0, 5000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000, 55_000, 60_000]);
    expect(inHalf.every((p) => p.ordinal === 0 && p.half === 1 && p.survTeam === 'a' && p.map === 'm1')).toBe(true);
    // The half going live does not move the line, though the first LIVEHUD
    // sample came 1.5 s in: the opening point stands on it.
    expect(inHalf[0]!.pA).toBeCloseTo(base.points[base.points.length - 1]!.pA, 9);
    const pub = live(10_000).points.slice(base.points.length);
    expect(pub.map((p) => p.tMs).at(-1)).toBe(50_000);
    expect(pub).toEqual(inHalf.slice(0, pub.length));
  });

  it('uses the public delay unless told otherwise', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    expect(liveWinLine(db, id, 'five', model, { live: true, nowMs: NOW })).toEqual(live(10_000));
  });

  it('marks the tank spawning', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    const pts = live(0).points.filter((p) => p.moment !== undefined);
    expect(pts.map((p) => [p.tMs, p.moment])).toEqual([[30_000, 'tank_spawn']]);
  });

  it('a restarted half starts clean', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    expect(live(0).points.length).toBeGreaterThan(1);
    // The admin restarts the half: ROUND_START resets the history and the points.
    const restart = NOW + 30_000;
    hud.resetReach(TOKEN, 0, 1, restart);
    resetLiveWin(id, 0, 1);
    expect(hud.history(TOKEN, 0, 1)).toEqual([]);
    expect(live(0, restart + 1000)).toEqual(plain());
    writeHalf(frames(10_000), restart);
    hud.record(TOKEN, line(5), restart, { ordinal: 0, half: 1 });
    const again = live(0, restart + 20_000).points.slice(1).map((p) => p.tMs);
    expect(again).toEqual([0, 5000, 10_000]);
  });

  it('shows a finished half\'s last seconds to the public only once they are the delay old', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    live(0);
    db.prepare("UPDATE match_rounds SET score = 640, ended_at = datetime('now'), survivors_alive = 3 WHERE match_id = ?").run(id);
    const tms = (l: ReturnType<typeof live>) => l.points.filter((p) => p.tMs !== undefined).map((p) => p.tMs);
    // The file's mtime puts frame 60.5 s at NOW: 60 s was seen 0.5 s before it.
    expect(tms(live(0, NOW + 1000)).at(-1)).toBe(60_000);
    expect(tms(live(10_000, NOW + 1000)).at(-1)).toBe(50_000);
    expect(tms(live(10_000, NOW + 9500)).at(-1)).toBe(60_000);
  });

  it('prices a finished half\'s points nobody asked for while it was live to the values they would have had', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    const during = live(0).points.slice(1);
    // The same half again, read but never priced while live.
    configureLiveWin({});
    liveSnapshot(db, id, NOW, 0);
    db.prepare("UPDATE match_rounds SET score = 640, ended_at = datetime('now'), survivors_alive = 0 WHERE match_id = ?").run(id);
    const after = live(0, NOW + 6000).points.slice(1, -1);
    expect(after.map((p) => p.tMs)).toEqual(during.map((p) => p.tMs));
    after.forEach((p, i) => expect(p.pA).toBeCloseTo(during[i]!.pA, 12));
  });

  it('keeps a finished half\'s points before its half-end point, the last marked when they made the saferoom', () => {
    writeHalf(frames(60_000));
    sample(START + 1500, 5);
    const during = live(0).points.slice(1);
    db.prepare("UPDATE match_rounds SET score = 640, ended_at = datetime('now'), survivors_alive = 3 WHERE match_id = ?").run(id);
    const after = live(0, NOW + 6000);
    expect(after.points).toHaveLength(1 + during.length + 1);
    expect(after.points.slice(1, -1).map((p) => p.pA)).toEqual(during.map((p) => p.pA));
    expect(after.points.at(-2)!.moment).toBe('saferoom');
    expect(after.points.at(-1)).toMatchObject({ ordinal: 0, half: 1, scoreA: 640 });
    expect(after.points.at(-1)!.tMs).toBeUndefined();
    // The biggest swing still names the half-end point.
    expect(after.turning).toBe(after.points.length - 1);
  });
});

describe('the half clock across a pause', () => {
  const sqlite = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  it('puts LIVEHUD samples after a pause on the frames\' clock (game time, which stood still)', () => {
    // Game time runs 0 to 30 s, a 20 s pause (wall 30 to 50 s), then on.
    db.prepare('INSERT INTO match_pauses (match_id, map_ordinal, half, started_at, ended_at) VALUES (?, 0, 1, ?, ?)')
      .run(id, sqlite(START + 30_000), sqlite(START + 50_000));
    sample(START + 1000, 5);
    writeHalf(frames(29_500), START, 'm1', START + 30_000);
    expect(liveSnapshot(db, id, START + 30_000, 0)).not.toBeNull();
    writeHalf(frames(34_500), START, 'm1', START + 55_000);
    liveSnapshot(db, id, START + 55_000, 0);
    // 58 s of wall time is 38 s of game time.
    sample(START + 58_000, 40);
    writeHalf(frames(44_500), START, 'm1', START + 65_000);
    const s = liveSnapshot(db, id, START + 65_000, 0)!;
    expect(s.snap.tMs).toBe(40_000);
    expect(s.snap.prog).toBe(40 - 5);
  });

  it('a frame read past the last clock mark (a capped catch-up across a pause) counts as seen at the read', () => {
    // Reads of at most 40 frames (20 s).
    configureLiveWin({ maxDecodeBytes: 40 * frameBytes(0) });
    sample(START + 1500, 5);
    writeHalf(frames(19_000), START, 'm1', START + 19_500);
    liveSnapshot(db, id, START + 19_500, 0); // the whole file: a mark, frame 19.5 s seen at wall 19.5 s
    // A 20 s pause, then 40 s more play; the next read only gets to 39.5 s.
    sample(START + 15_000, 5);
    writeHalf(frames(59_500), START, 'm1', START + 80_000);
    const READ = START + 80_000;
    liveSnapshot(db, id, READ, 0);
    db.prepare("UPDATE match_rounds SET score = 640, ended_at = datetime('now'), survivors_alive = 3 WHERE match_id = ?").run(id);
    const last = (nowMs: number, delayMs: number) =>
      liveWinLine(db, id, 'five', model, { live: true, nowMs, delayMs })!.points.filter((p) => p.tMs !== undefined).at(-1)?.tMs;
    expect(last(READ + 1000, 0)).toBe(35_000);
    // Frames to 19.5 s were covered by the mark; 20 to 35 s only by the read.
    expect(last(READ + 9000, 10_000)).toBe(15_000);
    expect(last(READ + 10_000, 10_000)).toBe(35_000);
  });

  it('one read with a push lag spike does not put later LIVEHUD samples early on the clock', () => {
    sample(START + 1500, 5);
    writeHalf(frames(29_500), START, 'm1', START + 30_000);
    liveSnapshot(db, id, START + 30_000, 0);
    // The file for 35 s lands 3 s late.
    writeHalf(frames(34_500), START, 'm1', START + 38_000);
    liveSnapshot(db, id, START + 35_000, 0);
    // At wall 41 s (game 41 s) progress jumps; the 40 s snapshot must not see it.
    sample(START + 41_000, 40);
    writeHalf(frames(40_000), START, 'm1', START + 41_500);
    const s = liveSnapshot(db, id, START + 41_500, 0)!;
    expect(s.snap.tMs).toBe(40_000);
    expect(s.snap.prog).toBe(0);
  });

  it('stores progress samples on the game clock, taking off the half\'s pauses when no replay was read', () => {
    db.prepare('INSERT INTO match_pauses (match_id, map_ordinal, half, started_at, ended_at) VALUES (?, 0, 1, ?, ?)')
      .run(id, sqlite(START + 30_000), sqlite(START + 50_000));
    writeProgressSamples(db, id, 0, 1, [{ at: START + 20_000, prog: 10, tank: 40 }, { at: START + 60_000, prog: 30, tank: 40 }], START);
    expect(db.prepare('SELECT t_ms, prog FROM match_progress_samples ORDER BY t_ms').all()).toEqual([
      { t_ms: 20_000, prog: 10 }, { t_ms: 40_000, prog: 30 },
    ]);
  });
});

describe('failure paths', () => {
  it('a missing file is not looked for again for RECOMPUTE_MS', () => {
    sample(START + 1500, 5);
    expect(liveSnapshot(db, id, NOW, 0)).toBeNull();
    writeHalf(frames(60_000));
    expect(liveSnapshot(db, id, NOW + 1000, 0)).toBeNull();
    expect(liveSnapshot(db, id, NOW + RECOMPUTE_MS, 0)).not.toBeNull();
  });

  it('logs an abandoned attempt (or a server clock behind) once per half', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHalf(frames(60_000));
    hud.resetReach(TOKEN, 0, 1, START + 50_000);
    sample(START + 51_000, 5);
    expect(liveSnapshot(db, id, NOW, 0)).toBeNull();
    expect(liveSnapshot(db, id, NOW + 2 * RECOMPUTE_MS, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('abandoned attempt');
    warn.mockRestore();
  });
});

describe('winLiveOption', () => {
  it('is off until win_chance_live is turned on, except for an admin viewer', () => {
    expect(winLiveOption(db)).toBe(false);
    expect(winLiveOption(db, true)).toBe(true);
    setSetting(db, 'win_chance_live', '1');
    expect(winLiveOption(db)).toBe(true);
  });
});

describe('writeProgressSamples', () => {
  it('stores one sample per 10 s of half time, skipping unknown progress, replacing what was there', () => {
    const at = (t: number, prog: number, tank: number) => ({ at: START + t, prog, tank });
    const n = writeProgressSamples(db, id, 0, 1, [
      at(0, 0, 40), at(2000, 1, 40), at(10_000, -1, 40), at(12_000, 8, -1), at(25_000, 20, 40),
    ], START);
    expect(n).toBe(3);
    expect(db.prepare('SELECT t_ms, prog, tank FROM match_progress_samples ORDER BY t_ms').all()).toEqual([
      { t_ms: 0, prog: 0, tank: 40 }, { t_ms: 12_000, prog: 8, tank: null }, { t_ms: 25_000, prog: 20, tank: 40 },
    ]);
    writeProgressSamples(db, id, 0, 1, [at(1000, 3, 40)], START);
    expect(db.prepare('SELECT t_ms, prog FROM match_progress_samples').all()).toEqual([{ t_ms: 1000, prog: 3 }]);
  });
});

describe('PROGRESS_MAPS', () => {
  it('ships only the trusted maps', () => {
    expect(PROGRESS_MAPS.size).toBe(22);
    expect(PROGRESS_MAPS.has('l4d_vs_farm01_hilltop')).toBe(true);
    expect(PROGRESS_MAPS.has('cdta_02road')).toBe(false);
  });
});

describe('progress samples from the log feed', () => {
  function freeUdpPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', reject);
      sock.bind(0, '127.0.0.1', () => {
        const { port } = sock.address() as AddressInfo;
        sock.close(() => resolve(port));
      });
    });
  }
  function send(port: number, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = dgram.createSocket('udp4');
      const text = Buffer.from(`L 10/28/2026 - 03:56:00: ${body}\n`, 'utf8');
      const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
      c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
    });
  }
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM match_progress_samples').get() as { n: number }).n;
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = null;
  });

  it('are written when the half ends and never while it is live', async () => {
    db.prepare('DELETE FROM match_rounds').run();
    const port = await freeUdpPort();
    app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: port }, db,
      serverExec: async () => {}, serverCleaner: async () => {},
    });
    await send(port, `PUG ${TOKEN} ROUND_START map=m1 half=1 surv=a`);
    await settle();
    const real = Date.now.bind(Date);
    await send(port, `PUG ${TOKEN} LIVEHUD prog=6 tank=40 witch=60 p=`);
    await settle();
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 11_000);
    await send(port, `PUG ${TOKEN} LIVEHUD prog=14 tank=40 witch=60 p=`);
    await settle();
    expect(count()).toBe(0);
    await send(port, `PUG ${TOKEN} ROUND_END map=m1 half=1 surv=a score=300 alive=4`);
    await settle();
    const rows = db.prepare('SELECT ordinal, half, t_ms, prog, tank FROM match_progress_samples ORDER BY t_ms').all() as
      { ordinal: number; half: number; t_ms: number; prog: number; tank: number }[];
    expect(rows.map((r) => [r.ordinal, r.half, r.prog, r.tank])).toEqual([[0, 1, 6, 40], [0, 1, 14, 40]]);
    expect(rows[1]!.t_ms - rows[0]!.t_ms).toBeGreaterThanOrEqual(10_000);
  });
});
