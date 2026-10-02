import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { overlayKey, readOverlayKey } from '../src/cast/key.js';
import { cleanState } from '../src/cast/studio.js';
import { camSlots } from '../src/cast/layout.js';
import { encodeFrame, encodeHeader, STATE, VERSION, type Frame, type PlayerSample } from '../src/replayFormat.js';
import { findFrameBoundary, LiveRoundReader } from '../src/cast/liveRound.js';
import { tagFrom } from '../src/cast/matchView.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000700${i}`);
const ADMIN = '76561199000007091';
const PLAYER = '76561199000007092';
const CASTER = '76561199000007094';
const OTHER_CASTER = '76561199000007095';
const TOKEN = 'e'.repeat(32);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let matchId: number;
let liveDir: string;

const call = (method: 'GET' | 'POST' | 'PUT', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });

beforeEach(async () => {
  db = openDb(':memory:');
  liveDir = mkdtempSync(join(tmpdir(), 'caststudio-live-'));
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'caststudio-')), replayDir: mkdtempSync(join(tmpdir(), 'caststudio-rpl-')), replayLiveDir: liveDir },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [...IDS, ADMIN, PLAYER, CASTER, OTHER_CASTER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid IN (?, ?)').run(CASTER, OTHER_CASTER);
  const serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  matchId = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, origin) VALUES (1, 'live', 'dead_air', ?, ?, 'queue')",
  ).run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});
afterEach(async () => { await app.close(); });

const keyOf = async (as: string): Promise<string> => (await call('GET', '/api/cast/studio', as)).json().key;
const feed = (key: string) => app.inject({ method: 'GET', url: `/api/overlay/feed?k=${encodeURIComponent(key)}` });

describe('overlay keys', () => {
  it('round-trips and refuses a tampered or malformed key', () => {
    const k = overlayKey('s', CASTER, 3);
    expect(readOverlayKey('s', k)).toEqual({ steamid: CASTER, gen: 3 });
    expect(readOverlayKey('other', k)).toBeNull();
    expect(readOverlayKey('s', k.replace(`.3.`, '.4.'))).toBeNull();
    expect(readOverlayKey('s', 'nope')).toBeNull();
    expect(readOverlayKey('s', undefined)).toBeNull();
  });
});

describe('studio state', () => {
  it('pins every field to its shape', () => {
    const s = cleanState({
      scene: 'bogus', theme: 'neon', title: 'x'.repeat(500), matchId: -3,
      overrides: { a: { name: ' Rats ', color: 'red', score: 12 }, b: { color: '#AABBCC', score: -1 } },
      casters: [{ name: 'A', camUrl: 'javascript:alert(1)' }, { name: 'B', camUrl: 'https://vdo.ninja/?view=x' }, {}, {}],
      bosses: { tank: 74.6, witch: 140, map: 'l4d_vs_airport02_offices' },
      elements: { survivors: true, tank: 'yes' },
      callout: { title: 'SKEET' },
    });
    expect(s.scene).toBe('starting');
    expect(s.theme).toBe('riverside');
    expect(s.title.length).toBe(80);
    expect(s.matchId).toBeNull();
    expect(s.overrides).toEqual({ a: { name: 'Rats', score: 12 }, b: { color: '#aabbcc' } });
    expect(s.casters).toHaveLength(3);
    expect(s.casters[0]!.camUrl).toBe('');
    expect(s.casters[1]!.camUrl).toBe('https://vdo.ninja/?view=x');
    expect(s.bosses).toEqual({ tank: 75, witch: null, map: 'l4d_vs_airport02_offices' });
    expect(s.elements).toEqual({ survivors: true, infected: false, tank: true, bosses: true });
    expect(s.callout).toBeNull();
  });

  it('lays cams out inside the canvas', () => {
    for (const n of [1, 2, 3]) {
      for (const r of camSlots(n)) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1920);
        expect(r.y + r.h).toBeLessThanOrEqual(1080);
        expect(Math.abs(r.w / r.h - 16 / 9)).toBeLessThan(0.01);
      }
    }
  });

  it('makes tags from names', () => {
    expect(tagFrom("Volence's group")).toBe('VOL');
    expect(tagFrom('Riverside Rats Club')).toBe('RRC');
  });
});

describe('panel routes', () => {
  it('lets casters and admins in, nobody else', async () => {
    expect((await call('GET', '/api/cast/studio')).statusCode).toBe(401);
    expect((await call('GET', '/api/cast/studio', PLAYER)).statusCode).toBe(403);
    expect((await call('GET', '/api/cast/studio', ADMIN)).statusCode).toBe(200);
    const r = await call('GET', '/api/cast/studio', CASTER);
    expect(r.statusCode).toBe(200);
    expect(r.json().matches.map((m: { id: number }) => m.id)).toEqual([matchId]);
  });

  it('saves a state and refuses a match the caster may not see', async () => {
    const ok = await call('PUT', '/api/cast/studio', CASTER, { matchId, scene: 'gameplay' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().studio.scene).toBe('gameplay');
    const scrim = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, kind, visibility) VALUES (1, 'live', 'dead_air', 'scrim', 'participants')",
    ).run().lastInsertRowid);
    // A scrim with no booking: not a PUG or tournament, so not castable.
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId: scrim })).statusCode).toBe(403);
  });

  it('stamps a callout with the server clock and keeps it through saves', async () => {
    const fired = await call('POST', '/api/cast/studio/callout', CASTER, { title: 'SKEET', text: 'Rat skeets', team: 'a', at: '2001-01-01T00:00:00Z' });
    expect(fired.statusCode).toBe(200);
    const at = fired.json().studio.callout.at;
    expect(Date.now() - Date.parse(at)).toBeLessThan(5000);
    const saved = await call('PUT', '/api/cast/studio', CASTER, { ...fired.json().studio, callout: { title: 'X', at: '2001-01-01T00:00:00Z' } });
    expect(saved.json().studio.callout.at).toBe(at);
    // A debounced save that left before the fire carries callout: null; it
    // must not clear the card.
    const late = await call('PUT', '/api/cast/studio', CASTER, { ...fired.json().studio, callout: null });
    expect(late.json().studio.callout.at).toBe(at);
    const cleared = await call('POST', '/api/cast/studio/callout/clear', CASTER);
    expect(cleared.json().studio.callout).toBeNull();
    expect((await call('POST', '/api/cast/studio/callout', CASTER, { text: 'no title' })).statusCode).toBe(400);
  });

  it('refuses a match the caster is rostered in', async () => {
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, CASTER);
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId })).statusCode).toBe(403);
    expect((await call('GET', '/api/cast/studio', CASTER)).json().matches).toEqual([]);
    // Staff too: an admin playing in it gets nothing either.
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'b')").run(matchId, ADMIN);
    expect((await call('PUT', '/api/cast/studio', ADMIN, { matchId })).statusCode).toBe(403);
  });

  it('refuses a tournament match the caster could not view', async () => {
    const hidden = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, kind, visibility) VALUES (1, 'live', 'dead_air', 'tournament', 'staff')",
    ).run().lastInsertRowid);
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId: hidden })).statusCode).toBe(403);
    expect((await call('PUT', '/api/cast/studio', ADMIN, { matchId: hidden })).statusCode).toBe(200);
  });

  it('only puts on air what the picker offers', async () => {
    const old = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'completed', 'dead_air', datetime('now', '-2 days'))",
    ).run().lastInsertRowid);
    const recent = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'completed', 'dead_air', datetime('now', '-1 hours'))",
    ).run().lastInsertRowid);
    const aborted = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'aborted', 'dead_air')").run().lastInsertRowid);
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId: old })).statusCode).toBe(403);
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId: aborted })).statusCode).toBe(403);
    expect((await call('PUT', '/api/cast/studio', CASTER, { matchId: recent })).statusCode).toBe(200);
  });

  it('serves a scene collection pointing at the caster key', async () => {
    await call('PUT', '/api/cast/studio', CASTER, { casters: [{ name: 'Ana', camUrl: 'https://vdo.ninja/?view=a' }] });
    const r = await call('GET', '/api/cast/studio/obs-collection', CASTER);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const key = await keyOf(CASTER);
    const urls = body.sources.filter((s: { id: string }) => s.id === 'browser_source').map((s: { settings: { url: string } }) => s.settings.url);
    expect(urls).toContain('https://vdo.ninja/?view=a');
    expect(urls.some((u: string) => u.endsWith(`/overlay/gameplay?k=${encodeURIComponent(key)}`))).toBe(true);
    expect(body.scene_order[0].name).toBe('RS Program');
  });
});

describe('overlay feed', () => {
  it('serves the on-air match to a valid key and refuses without one', async () => {
    await call('PUT', '/api/cast/studio', CASTER, { matchId, overrides: { a: { name: 'Rats' } } });
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, 'l4d_vs_airport01_greenhouse', 0, 420, 380)").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at) VALUES (?, 0, 1, 'b', 380, datetime('now'), datetime('now'))").run(matchId);
    expect((await app.inject({ method: 'GET', url: '/api/overlay/feed' })).statusCode).toBe(401);
    const r = await feed(await keyOf(CASTER));
    expect(r.statusCode).toBe(200);
    const f = r.json();
    expect(f.match.id).toBe(matchId);
    expect(f.match.teams.a.name).toBe('Rats');
    expect(f.match.teams.a.overridden).toEqual(['name']);
    expect(f.match.teams.a.score).toBe(420);
    expect(f.match.chapters[0]).toMatchObject({ number: 1, a: 420, b: 380, firstSurvivor: 'b', state: 'done' });
    expect(f.match.teams.a.players).toHaveLength(4);
    expect(f.match.teams.a.players[0].sr).not.toBeUndefined();
  });

  it('kills old URLs on a new key, on staff revoke, and when the flag goes', async () => {
    const k1 = await keyOf(CASTER);
    expect((await call('POST', '/api/cast/studio/key', CASTER)).statusCode).toBe(200);
    expect((await feed(k1)).statusCode).toBe(401);
    const k2 = await keyOf(CASTER);
    expect((await feed(k2)).statusCode).toBe(200);
    expect((await call('POST', `/api/admin/players/${CASTER}/cast-key/revoke`, CASTER)).statusCode).toBe(403);
    expect((await call('POST', `/api/admin/players/${CASTER}/cast-key/revoke`, ADMIN)).statusCode).toBe(200);
    expect((await feed(k2)).statusCode).toBe(401);
    const k3 = await keyOf(CASTER);
    db.prepare('UPDATE players SET is_caster = 0 WHERE steamid = ?').run(CASTER);
    expect((await feed(k3)).statusCode).toBe(403);
  });

  it('drops a match from the feed once the caster may no longer see it', async () => {
    await call('PUT', '/api/cast/studio', CASTER, { matchId });
    const key = await keyOf(CASTER);
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = ?").run(matchId);
    await new Promise((r) => setTimeout(r, 450));
    expect((await feed(key)).json().match).toBeNull();
  });

  it('serves a prep sheet for a castable match only', async () => {
    const r = await call('GET', `/api/cast/studio/prep/${matchId}`, CASTER);
    expect(r.statusCode).toBe(200);
    expect(r.json().players).toHaveLength(8);
    expect((await call('GET', '/api/cast/studio/prep/99999', CASTER)).statusCode).toBe(404);
  });
});

describe('live round reader', () => {
  const header = () => encodeHeader({
    version: VERSION, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'l4d_vs_airport01_greenhouse',
    startedUnix: Math.floor(Date.now() / 1000), indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: IDS, infectedMask: 0xf0, sidesKnown: true, losKnown: false,
  });
  const sample = (slot: number, p: Partial<PlayerSample>): PlayerSample => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: STATE.PRESENT | STATE.ALIVE, health: 100, temp: 1,
    cls: 0, weapon: 0, clip: 0, reserve: 0, ...p,
  });
  const frame = (tMs: number, tankHp: number): Frame => ({
    tMs, offset: 0, entities: [{ ref: 5, kind: 2, state: 1, x: 0, y: 0, z: 0, health: 1000 }],
    players: [
      sample(0, { health: 64, temp: 20, cls: 0, weapon: 3 }),
      sample(1, { state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP, health: 250, cls: 1 }),
      sample(2, { state: STATE.PRESENT, health: 0, cls: 2 }),
      sample(3, { cls: 3 }),
      sample(4, { cls: 5, health: tankHp }),
      sample(5, { cls: 3, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST, health: 250 }),
      sample(6, { cls: 1, health: 250 }),
      sample(7, { cls: 0, state: STATE.PRESENT }),
    ],
  });
  const setLive = () => {
    db.prepare("INSERT INTO match_live (match_id, last_seen, phase, phase_since) VALUES (?, datetime('now'), 'live', datetime('now'))").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'a', datetime('now'))").run(matchId);
  };

  it('reads the newest frame, then only new bytes', () => {
    setLive();
    const path = join(liveDir, `pug_${TOKEN}_0_1.rpl`);
    writeFileSync(path, Buffer.concat([header(), encodeFrame(frame(100, 6000)), encodeFrame(frame(200, 5000))]));
    const reader = new LiveRoundReader('', liveDir);
    const r1 = reader.read(db, matchId)!;
    expect(r1.tMs).toBe(200);
    expect(r1.survivors.map((s) => s.character)).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(r1.survivors[0]).toMatchObject({ health: 64, temp: 20, weapon: 'Pump Shotgun', alive: true });
    expect(r1.survivors[1]!.incap).toBe(true);
    expect(r1.survivors[2]!.alive).toBe(false);
    expect(r1.survivors[3]!.temp).toBe(0);
    expect(r1.infected.map((i) => [i.cls, i.ghost])).toEqual([['tank', false], ['hunter', true], ['smoker', false], ['', false]]);
    const tankName = (db.prepare('SELECT name FROM players WHERE steamid = ?').get(IDS[4]) as { name: string }).name;
    expect(r1.tank).toEqual({ health: 5000, maxHealth: 6000, controller: tankName });
    expect(r1.witches).toBe(1);
    // Half a frame arrives: still the last whole one.
    const next = encodeFrame(frame(300, 4000));
    appendFileSync(path, next.subarray(0, 50));
    expect(reader.read(db, matchId)!.tMs).toBe(200);
    appendFileSync(path, next.subarray(50));
    expect(reader.read(db, matchId)!.tank!.health).toBe(4000);
  });

  it('works out sides from the roster when the file has no side mask', () => {
    db.prepare("INSERT INTO match_live (match_id, last_seen, phase, phase_since) VALUES (?, datetime('now'), 'live', datetime('now'))").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'b', datetime('now'))").run(matchId);
    const h = header();
    h[157] = 0; // sides flag: unknown
    h[156] = 0;
    writeFileSync(join(liveDir, `pug_${TOKEN}_0_1.rpl`), Buffer.concat([h, encodeFrame(frame(100, 6000)), encodeFrame(frame(200, 6000))]));
    const r = new LiveRoundReader('', liveDir).read(db, matchId)!;
    // Team b (slots 4-7) is on survivors this round, not slot order's 0-3.
    expect(r.survivors.map((x) => x.steamid)).toEqual(IDS.slice(4));
    expect(r.infected.map((x) => x.steamid)).toEqual(IDS.slice(0, 4));
  });

  it('reads only the tail of a long file, and keeps entities from the last sampled frame', () => {
    setLive();
    const parts: Uint8Array[] = [header()];
    for (let i = 0; i < 4000; i++) {
      const f = frame(100 + i * 100, 6000 - i);
      if (i % 5 !== 0) f.entities = [];
      parts.push(encodeFrame(f));
    }
    writeFileSync(join(liveDir, `pug_${TOKEN}_0_1.rpl`), Buffer.concat(parts));
    const r = new LiveRoundReader('', liveDir).read(db, matchId)!;
    expect(r.tMs).toBe(100 + 3999 * 100);
    expect(r.tank!.health).toBe(6000 - 3999);
    // The last frame sampled no entities; the witch is still there.
    expect(r.witches).toBe(1);
  });

  it('finds a frame boundary in a window cut mid-frame', () => {
    const bytes = Buffer.concat(Array.from({ length: 50 }, (_, i) => encodeFrame(frame(i * 100, 6000))));
    const size = encodeFrame(frame(0, 6000)).length;
    expect(findFrameBoundary(bytes.subarray(37))).toBe(size - 37);
    expect(findFrameBoundary(bytes)).toBe(0);
  });

  it('lists a survivor bot after the players', () => {
    db.prepare("INSERT INTO match_live (match_id, last_seen, phase, phase_since) VALUES (?, datetime('now'), 'live', datetime('now'))").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'a', datetime('now'))").run(matchId);
    const h = header();
    h[156] = 0xf8; // slot 3 plays infected: three survivors and a bot
    const f = frame(100, 6000);
    f.entities.push({ ref: 9, kind: 5, state: STATE.PRESENT | STATE.ALIVE, x: 0, y: 0, z: 0, health: 55 });
    writeFileSync(join(liveDir, `pug_${TOKEN}_0_1.rpl`), Buffer.concat([h, encodeFrame(f), encodeFrame({ ...f, tMs: 200 })]));
    const r = new LiveRoundReader('', liveDir).read(db, matchId)!;
    expect(r.survivors).toHaveLength(4);
    expect(r.survivors[3]).toMatchObject({ name: 'Bot', health: 55, alive: true });
  });

  it('is null between rounds', () => {
    writeFileSync(join(liveDir, `pug_${TOKEN}_0_1.rpl`), Buffer.concat([header(), encodeFrame(frame(100, 6000))]));
    expect(new LiveRoundReader('', liveDir).read(db, matchId)).toBeNull();
  });
});
