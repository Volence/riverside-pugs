import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { banPlayer } from '../src/admin/players.js';
import { widgetData, WIDGET_KINDS, RECENT_FINAL_MS } from '../src/widgets.js';
import { stubOrchestrator } from './helpers.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache } from '../src/campaignRegistry.js';

// Team a: P1, P2. Team b: P3, P4. P5 is a player who is in no match.
const P = ['76561198000000001', '76561198000000002', '76561198000000003', '76561198000000004', '76561198000000005'];
const [P1, P2, P3, P4, P5] = P;
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
  for (const id of P) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
});
afterEach(async () => { await app.close(); });

/** A match with P1, P2 on team a and P3, P4 on team b. */
function seedMatch(state: string, opts: { visibility?: string; endedSql?: string; a?: number; b?: number } = {}): number {
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, visibility, kind, team_a_score, team_b_score, winner, ended_at)
     VALUES (1, ?, 'no_mercy', ?, ?, 'pug', ?, ?, ?, ${opts.endedSql ? `datetime('now', '${opts.endedSql}')` : 'NULL'})`,
  ).run(state, `tok${Math.random()}`, opts.visibility ?? 'public', opts.a ?? 0, opts.b ?? 0,
    state === 'completed' ? ((opts.a ?? 0) > (opts.b ?? 0) ? 'a' : 'b') : null).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  ins.run(id, P1, 'a'); ins.run(id, P2, 'a'); ins.run(id, P3, 'b'); ins.run(id, P4, 'b');
  return id;
}

const get = (steamid: string, query = '') => app.inject({ method: 'GET', url: `/api/widget/${steamid}${query}` });

describe('widget types', () => {
  it('exports the kinds and the final hold', () => {
    expect(WIDGET_KINDS).toEqual(['live', 'rating', 'session', 'last', 'queue']);
    expect(RECENT_FINAL_MS).toBe(5 * 60_000);
  });
});

describe('GET /api/widget/:steamid', () => {
  it('404 for an unknown steamid', async () => {
    const res = await get('76561198099999999');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no such player' });
  });

  it('404 for a banned player', async () => {
    banPlayer(db, P2, P1, 'toxic', 60);
    const res = await get(P2);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no such player' });
  });

  it('answers with no-store, the player, and the queue', async () => {
    const res = await get(P5);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.player).toEqual({ steamid: P5, name: 'p5' });
    expect(body.queue).toEqual({ count: 0, size: 8, inQueue: false });
    expect(body.live).toBeNull();
    expect(body.last).toBeNull();
    expect(body.session).toBeNull();
    expect(typeof body.serverNow).toBe('number');
  });

  it("live puts the streamer's team first with mine: true and adds the half-time score to the totals", async () => {
    const id = seedMatch('live');
    const map = db.prepare('INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)');
    map.run(id, 'l4d_hospital01_apartment', 0, 512, 480);
    map.run(id, 'l4d_hospital02_subway', 1, 610, 590);
    db.prepare(
      `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at)
       VALUES (?, 2, 1, 'a', 438, 1, datetime('now', '-300 seconds'), datetime('now', '-60 seconds'))`,
    ).run(id);
    const live = (await get(P3)).json().live;
    expect(live.matchId).toBe(id);
    expect(live.final).toBe(false);
    expect(live.mapsPlayed).toBe(2);
    expect(live.mine).toMatchObject({ side: 'b', mine: true, score: 1070, names: ['p3', 'p4'] });
    expect(live.theirs).toMatchObject({ side: 'a', mine: false, score: 1560, names: ['p1', 'p2'] });
    expect(live.maps).toEqual([
      { ordinal: 0, map: 'l4d_hospital01_apartment', mine: 480, theirs: 512 },
      { ordinal: 1, map: 'l4d_hospital02_subway', mine: 590, theirs: 610 },
    ]);
    expect(live.halfTime).toEqual({ ordinal: 2, mineSurvived: false, score: 438 });
    // The other side sees it the other way round.
    const theirs = (await get(P1)).json().live;
    expect(theirs.mine).toMatchObject({ side: 'a', score: 1560 });
    expect(theirs.halfTime.mineSurvived).toBe(true);
  });

  it('mapsTotal is the planned map count when the campaign is known, else null', async () => {
    // Five chapters, so the default stop map is the fourth.
    insertDraft(db, {
      slug: 'five', name: 'Five', vpkFilename: 'five.vpk', sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
    }, ['m1', 'm2', 'm3', 'm4', 'fin'].map((map, n) => ({ map, display: null, isFinale: n === 4 })));
    publishCampaign(db, 'five', 'Five');
    invalidateCampaignCache();
    try {
      const id = seedMatch('live');
      expect((await get(P1)).json().live.mapsTotal).toBeNull(); // no_mercy: no missions directory here
      db.prepare("UPDATE matches SET campaign = 'five' WHERE id = ?").run(id);
      expect((await get(P1)).json().live.mapsTotal).toBe(4);
      // A scrim picks its own maps.
      db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = ?").run(id);
      expect((await get(P1)).json().live.mapsTotal).toBeNull();
    } finally {
      invalidateCampaignCache();
    }
  });

  it('live is null when the player is not on either roster', async () => {
    seedMatch('live');
    expect((await get(P5)).json().live).toBeNull();
  });

  it('live is null for a non-public match', async () => {
    seedMatch('live', { visibility: 'participants' });
    expect((await get(P1)).json().live).toBeNull();
    seedMatch('completed', { visibility: 'staff', endedSql: '-1 minutes', a: 900, b: 800 });
    expect((await get(P1)).json().live).toBeNull();
  });

  it('a finished match is held as final for 5 minutes', async () => {
    const id = seedMatch('completed', { endedSql: '-4 minutes', a: 1200, b: 1500 });
    const mm = db.prepare('INSERT INTO match_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)');
    mm.run(id, 'l4d_hospital01_apartment', 0, 600, 700);
    mm.run(id, 'l4d_hospital02_subway', 1, 600, 800);
    const live = (await get(P1)).json().live;
    expect(live).toMatchObject({ matchId: id, final: true, mapsPlayed: 2, halfTime: null });
    expect(live.mine).toMatchObject({ side: 'a', score: 1200, mine: true });
    expect(live.theirs).toMatchObject({ side: 'b', score: 1500, mine: false });
    expect(live.maps[1]).toEqual({ ordinal: 1, map: 'l4d_hospital02_subway', mine: 600, theirs: 800 });

    db.prepare("UPDATE matches SET ended_at = datetime('now', '-6 minutes') WHERE id = ?").run(id);
    expect((await get(P1)).json().live).toBeNull();
  });

  it('garbage tz and future since are ignored', async () => {
    const a = await get(P1, '?tz=banana&since=later');
    expect(a.statusCode).toBe(200);
    expect(a.json().session).toBeNull();
    const b = await get(P1, `?tz=9999&since=${Date.now() + 3_600_000}`);
    expect(b.statusCode).toBe(200);
    expect(b.json().session).toBeNull();
    // Out of range tz reads as UTC: same answer as tz=0.
    const now = Date.parse('2026-11-04T03:00:00Z');
    seedRated('2026-11-03 23:30:00', 25, 26);
    seedRated('2026-11-04 01:30:00', 26, 27);
    const at = (tz: number) => widgetData(db, P1, { tzOffsetMin: tz, since: null, now })!.rating!.todayDelta;
    expect(at(9999)).toBe(at(0));
    expect(at(Number.NaN)).toBe(at(0));
    expect(widgetData(db, P1, { tzOffsetMin: 0, since: now + 1000, now })!.session).toBeNull();
    expect(widgetData(db, P1, { tzOffsetMin: 0, since: Number.NaN, now })!.session).toBeNull();
  });
});

/** A completed public PUG P1 won (team a), rated mu `before` -> `after`. */
function seedRated(endedAt: string, before: number, after: number, won = true): number {
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, kind, team_a_score, team_b_score, winner, ended_at)
     VALUES (1, 'completed', 'no_mercy', ?, 'pug', 1000, 900, ?, ?)`,
  ).run(`tok${Math.random()}`, won ? 'a' : 'b', endedAt).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage, common_kills) VALUES (?, ?, ?, ?, ?)');
  ins.run(id, P1, 'a', 1234, 210); ins.run(id, P3, 'b', 0, 0);
  db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, ?, 1, ?, 4, ?, 4)')
    .run(P1, id, before, after);
  db.prepare(
    `INSERT INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, ?, 4, ?, ?)
     ON CONFLICT (player_id, season_id) DO UPDATE SET mu = excluded.mu, wins = wins + excluded.wins, losses = losses + excluded.losses`,
  ).run(P1, after, won ? 1 : 0, won ? 0 : 1);
  return id;
}

describe('widgetData: rating, session, last', () => {
  it("todayDelta counts from the streamer's local midnight", () => {
    const now = Date.parse('2026-11-04T03:00:00Z');
    seedRated('2026-11-03 23:30:00', 25, 26);
    seedRated('2026-11-04 01:30:00', 26, 28);
    const one = widgetData(db, P1, { tzOffsetMin: 0, since: null, now })!;
    const both = widgetData(db, P1, { tzOffsetMin: -300, since: null, now })!;
    expect(one.rating!.todayDelta).toBeGreaterThan(0);
    // Both games moved SR up, and the earlier one only counts in UTC-5.
    expect(both.rating!.todayDelta).toBeGreaterThan(one.rating!.todayDelta);
    // UTC+1 has passed midnight too, but its midnight is 23:00 UTC: both count.
    expect(widgetData(db, P1, { tzOffsetMin: 60, since: null, now })!.rating!.todayDelta).toBe(both.rating!.todayDelta);
    expect(both.rating).toMatchObject({ wins: 2, losses: 0 });
    expect(both.rating!.sr).not.toBeNull();
  });

  it('position is the place the leaderboard page shows: none while provisional', () => {
    const now = Date.parse('2026-11-04T03:00:00Z');
    seedRated('2026-11-03 20:00:00', 24, 25);
    seedRated('2026-11-03 21:00:00', 25, 26);
    // Season 0 rules: under three games is provisional, listed but unplaced.
    expect(widgetData(db, P1, { tzOffsetMin: 0, since: null, now })!.rating!.position).toBeNull();
    seedRated('2026-11-03 22:00:00', 26, 27);
    expect(widgetData(db, P1, { tzOffsetMin: 0, since: null, now })!.rating!.position).toBe(1);
  });

  it('session counts matches since the given time, and is null without one', () => {
    const now = Date.parse('2026-11-04T03:00:00Z');
    seedRated('2026-11-03 20:00:00', 24, 25);
    seedRated('2026-11-04 01:00:00', 25, 26);
    seedRated('2026-11-04 02:00:00', 26, 25, false);
    expect(widgetData(db, P1, { tzOffsetMin: 0, since: null, now })!.session).toBeNull();
    const since = Date.parse('2026-11-04T00:30:00Z');
    const s = widgetData(db, P1, { tzOffsetMin: 0, since, now })!.session!;
    expect(s).toMatchObject({ since, wins: 1, losses: 1 });
    const all = widgetData(db, P1, { tzOffsetMin: 0, since: Date.parse('2026-11-03T00:00:00Z'), now })!.session!;
    expect(all).toMatchObject({ wins: 2, losses: 1 });
    expect(all.srDelta).toBeGreaterThan(s.srDelta);
  });

  it('last is the most recent match with its scores and stats', () => {
    const now = Date.parse('2026-11-04T03:00:00Z');
    seedRated('2026-11-04 01:00:00', 25, 26);
    const id = seedRated('2026-11-04 02:00:00', 26, 25, false);
    db.prepare("INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, 'skeets', 3), (?, ?, 'team_skeets', 2)")
      .run(id, P1, id, P1);
    const last = widgetData(db, P1, { tzOffsetMin: 0, since: null, now })!.last!;
    expect(last).toMatchObject({
      matchId: id, campaign: 'no_mercy', endedAt: '2026-11-04 02:00:00', result: 'loss', mine: 1000, theirs: 900,
      stats: { siDamage: 1234, skeets: 3, commons: 210 },
    });
    expect(last.srDelta).toBeLessThan(0);
  });
});
