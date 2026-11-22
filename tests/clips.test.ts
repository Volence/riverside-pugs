import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { openDb, type DB } from '../src/db.js';
import {
  CLIP_TRIPLES_SINCE, CLIPS_SINCE, claimClip, failClip, findClipBursts, findQuads, finishClip, getClip, jobFor, listClips, scanClips, setClipFile,
  setReelFile,
} from '../src/clips.js';
import { findSkeetStreaks } from '../src/skeetStreaks.js';
import { clipRoutes } from '../src/routes/clips.js';

const PID = '76561197972484944';
let db: DB; let matchId: number;

function match(endedAt: string, over: { visibility?: string; kind?: string } = {}): number {
  return Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, ended_at, visibility, kind) VALUES (1, 'completed', 'smalltown', ?, ?, ?)",
  ).run(endedAt, over.visibility ?? 'public', over.kind ?? 'pug').lastInsertRowid);
}
let seq = 0;
function skeet(m: number, times: number[], over: { actor?: string; mapOrdinal?: number; half?: number } = {}): void {
  const ins = db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, half, t_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const t of times) ins.run(m, over.mapOrdinal ?? 0, seq++, 'skeet', over.actor ?? PID, null, over.half ?? 2, t);
}

beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'Self Sacrifice', 'active')").run(PID);
  matchId = match('2026-11-21 06:00:00');
});

describe('findClipBursts', () => {
  it('finds a double and a triple with the triple keyed like its skeet post', () => {
    skeet(matchId, [7859, 9000, 90281, 91680, 91680]);
    const b = findClipBursts(db, matchId);
    expect(b.map((x) => x.times)).toEqual([[7859, 9000], [90281, 91680, 91680]]);
    expect(findSkeetStreaks(db, matchId).map((s) => s.tMs)).toEqual([90281]);
  });

  it('keeps the triple the post found where a double scan would group differently', () => {
    // a plain min-2 scan would take [0, 4900] and [9000, 9500]; the post's triple is [4900, 9000, 9500]
    skeet(matchId, [0, 4900, 9000, 9500]);
    expect(findClipBursts(db, matchId).map((x) => x.times)).toEqual([[4900, 9000, 9500]]);
  });

  it('never joins across a half, a map or a player', () => {
    skeet(matchId, [1000], { half: 1 }); skeet(matchId, [2000], { half: 2 });
    skeet(matchId, [3000], { mapOrdinal: 1 }); skeet(matchId, [3500], { mapOrdinal: 1, actor: '76561190000000001' });
    expect(findClipBursts(db, matchId)).toEqual([]);
  });
});

describe('scan, claim and finish', () => {
  it('queues doubles only from CLIPS_SINCE, triples from the post start; skips private and voided', () => {
    expect(CLIPS_SINCE > CLIP_TRIPLES_SINCE).toBe(true);
    skeet(matchId, [0, 1000]);
    const old = match('2026-10-01 00:00:00'); skeet(old, [0, 1000]); skeet(old, [50000, 51000, 52000]);
    const priv = match('2026-11-21 07:00:00', { visibility: 'staff' }); skeet(priv, [0, 1000]);
    const voided = match('2026-11-21 07:00:00'); skeet(voided, [0, 1000]);
    db.prepare("UPDATE matches SET voided_at = datetime('now') WHERE id = ?").run(voided);
    const scrim = match('2026-11-21 07:00:00', { visibility: 'participants', kind: 'scrim' }); skeet(scrim, [0, 1000]);
    // a finished tournament game counts, and its doubles from before CLIPS_SINCE too
    const tourn = match('2026-10-24 01:00:00', { visibility: 'participants', kind: 'tournament' }); skeet(tourn, [0, 1000]);
    expect(scanClips(db)).toBe(3);
    expect(scanClips(db)).toBe(0);
    const rows = db.prepare('SELECT match_id, count FROM clips ORDER BY match_id').all();
    expect(rows).toEqual([{ match_id: matchId, count: 2 }, { match_id: old, count: 3 }, { match_id: tourn, count: 2 }]);
  });

  it('claims newest first, retries a failure, and lists only finished clips', () => {
    skeet(matchId, [90281, 91680, 91680]);
    scanClips(db);
    const row = claimClip(db)!;
    expect(row.status).toBe('rendering');
    expect(claimClip(db)).toBeNull();
    expect(jobFor(db, row).caption[0]).toBe('Self Sacrifice: TRIPLE SKEET');
    failClip(db, row.id, 'boom');
    expect(getClip(db, row.id)!.status).toBe('queued');
    const again = claimClip(db)!;
    expect(finishClip(db, again.id)).toBe(false);   // no video yet
    setClipFile(db, again.id, 'video', 'clips/1/1.mp4', 123);
    expect(finishClip(db, again.id)).toBe(true);
    const list = listClips(db, (k) => `https://a/${k}`);
    expect(list).toHaveLength(1);
    expect(list[0]!.video).toBe('https://a/clips/1/1.mp4');
    expect(listClips(db, (k) => k, { player: '76561190000000001' })).toEqual([]);
  });

  it('a claim older than the timeout goes back to the queue, failed after three tries', () => {
    skeet(matchId, [0, 1000]);
    scanClips(db);
    const t0 = new Date('2026-11-22T00:00:00Z');
    for (let i = 0; i < 3; i++) expect(claimClip(db, new Date(t0.getTime() + i * 61 * 60_000))).not.toBeNull();
    expect(claimClip(db, new Date(t0.getTime() + 3 * 61 * 60_000))).toBeNull();
    expect(db.prepare('SELECT status FROM clips').get()).toEqual({ status: 'failed' });
  });
});

describe('worker routes', () => {
  it('hide behind the token and hand out jobs', async () => {
    const app = Fastify();
    const r2 = { endpoint: 'http://r2.invalid', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto', publicUrl: 'https://assets' } as never;
    await app.register(clipRoutes, { db, r2, token: 'sekrit' });
    skeet(matchId, [0, 1000]);
    scanClips(db);
    expect((await app.inject({ method: 'POST', url: '/api/clips/worker/claim' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/clips/worker/claim', headers: { 'x-clip-token': 'nope' } })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: '/api/clips/worker/claim', headers: { 'x-clip-token': 'sekrit' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ matchId, ordinal: 0, half: 2, steamid: PID, times: [0, 1000], count: 2 });
    expect((await app.inject({ method: 'POST', url: '/api/clips/worker/claim', headers: { 'x-clip-token': 'sekrit' } })).statusCode).toBe(204);
    const done = await app.inject({ method: 'POST', url: `/api/clips/worker/${ok.json().id}/done`, headers: { 'x-clip-token': 'sekrit' } });
    expect(done.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/clips' })).json()).toEqual({ clips: [] });
    await app.close();
  });
});

describe('quad caps', () => {
  const S = ['76561190000000011', '76561190000000012', '76561190000000013', '76561190000000014'];
  const I = ['76561190000000021', '76561190000000022', '76561190000000023', '76561190000000024'];
  function ev(m: number, kind: string, actor: string, target: string, t: number): void {
    db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, half, t_ms) VALUES (?, 2, ?, ?, ?, ?, 2, ?)').run(m, seq++, kind, actor, target, t);
  }
  it('finds match 1259 map 3 half 2: four pins in 1.06 s, filmed by the fourth capper', () => {
    [71172, 71492, 72086, 72227].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    [74000, 74100, 75000, 76000].forEach((t, i) => ev(matchId, 'incap', S[i]!, I[i]!, t));
    expect(findQuads(db, matchId)).toEqual([{ kind: 'quad', steamid: I[3], mapOrdinal: 2, half: 2, times: [71172, 71492, 72086, 72227], people: I }]);
  });
  it('a pin cleared, or its attacker killed, before the fourth lands is no quad', () => {
    [0, 300, 600].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    ev(matchId, 'cleared', S[3]!, S[0]!, 700);
    ev(matchId, 'pinned', I[3]!, S[3]!, 800);
    expect(findQuads(db, matchId)).toEqual([]);
    ev(matchId, 'death', I[1]!, S[3]!, 850);   // the hunter on S[1] dies: S[1] is free
    ev(matchId, 'pinned', I[0]!, S[0]!, 900);
    expect(findQuads(db, matchId)).toEqual([]);
  });
  it('match 1242 map 1 half 2: a survivor cleared 40 ms after the fourth pin is no quad; 1242 map 2: everyone incapped is', () => {
    [84672, 84914, 85367, 86102].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    ev(matchId, 'cleared', S[3]!, S[1]!, 86141);
    expect(findQuads(db, matchId)).toEqual([]);
    const m2 = match('2026-11-21 07:00:00');
    [157258, 157477, 158195, 159922].forEach((t, i) => ev(m2, 'pinned', I[i]!, S[i]!, t));
    [161469, 167453, 168469, 168586].forEach((t, i) => ev(m2, 'incap', S[i]!, I[i]!, t));   // actor goes down
    ev(m2, 'death', I[0]!, S[0]!, 169000);   // a capper dying after its victim is down frees nobody
    expect(findQuads(db, m2)).toHaveLength(1);
  });
  it('match 1239 map 1 half 2: one smoker pinning a second survivor has let go of the first', () => {
    ev(matchId, 'pinned', I[0]!, S[0]!, 63148);
    ev(matchId, 'pinned', I[1]!, S[1]!, 64969);
    ev(matchId, 'pinned', I[2]!, S[2]!, 65883);
    ev(matchId, 'pinned', I[0]!, S[3]!, 68148);
    expect(findQuads(db, matchId)).toEqual([]);
  });
  it('two survivors never seen going down (a tongue that broke without an event) means no quad; one is the round-ending incap', () => {
    [0, 300, 600, 900].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    [2000, 2100].forEach((t, i) => ev(matchId, 'incap', S[i]!, I[i]!, t));
    expect(findQuads(db, matchId)).toEqual([]);
    ev(matchId, 'incap', S[2]!, I[2]!, 2200);
    expect(findQuads(db, matchId)).toHaveLength(1);
  });
  it('a revive before the round ends means someone got back up', () => {
    [0, 300, 600, 900].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    [2000, 2100, 2200, 2300].forEach((t, i) => ev(matchId, 'incap', S[i]!, I[i]!, t));
    ev(matchId, 'revive', S[0]!, S[1]!, 9000);
    expect(findQuads(db, matchId)).toEqual([]);
  });
  it('is queued only when the match quad stat agrees, and lists on every capper', () => {
    for (const id of [...I, ...S]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(id, `p${id.slice(-2)}`);
    [71172, 71492, 72086, 72227].forEach((t, i) => ev(matchId, 'pinned', I[i]!, S[i]!, t));
    [74000, 74100, 75000, 76000].forEach((t, i) => ev(matchId, 'incap', S[i]!, I[i]!, t));
    expect(scanClips(db)).toBe(0);
    const m2 = match('2026-11-22 05:47:47');
    [71172, 71492, 72086, 72227].forEach((t, i) => ev(m2, 'pinned', I[i]!, S[i]!, t));
    [74000, 74100, 75000, 76000].forEach((t, i) => ev(m2, 'incap', S[i]!, I[i]!, t));
    db.prepare("INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, 'quad_caps', 1)").run(m2, I[0]);
    expect(scanClips(db)).toBe(1);
    const row = claimClip(db)!;
    const job = jobFor(db, row);
    expect(job.kind).toBe('quad');
    expect(job.caption[0]).toBe('QUAD CAP: p21, p22, p23, p24');
    setClipFile(db, row.id, 'video', 'clips/x.mp4', 1); finishClip(db, row.id);
    expect(listClips(db, (k) => k, { player: I[0] })).toHaveLength(1);
    expect(listClips(db, (k) => k, { minCount: 3 })).toHaveLength(0);
  });
});

describe('event reels', () => {
  it('upload behind the token, show only for a finished event', async () => {
    db.prepare(`INSERT INTO events (slug, name, region, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
      VALUES ('cup', 'Cup', 'na', ?, 'team', 'live', '2026-11-22T00:00:00Z', '{}', '{}', '{}', '2026-11-22', '2026-11-22')`).run(PID);
    const app = Fastify();
    const sent: string[] = [];
    const r2 = { endpoint: 'http://r2.invalid', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto', publicUrl: 'https://assets' } as never;
    await app.register(clipRoutes, { db, r2, token: 'sekrit' });
    expect((await app.inject({ method: 'PUT', url: '/api/clips/worker/reel/cup/video', payload: Buffer.from('x'), headers: { 'content-type': 'video/mp4' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/clips/worker/reel/nope/video', payload: Buffer.from('x'), headers: { 'content-type': 'video/mp4', 'x-clip-token': 'sekrit' } })).statusCode).toBe(404);
    setReelFile(db, 1, 'video', 'clips/reels/cup-1.mp4', 1);
    expect((await app.inject({ method: 'GET', url: '/api/clips/reel/cup' })).statusCode).toBe(404);   // not finished yet
    db.prepare("UPDATE events SET status = 'finished' WHERE slug = 'cup'").run();
    expect((await app.inject({ method: 'GET', url: '/api/clips/reel/cup' })).json()).toEqual({ video: 'https://assets/clips/reels/cup-1.mp4', thumb: null });
    expect(sent).toEqual([]);
  });
});
