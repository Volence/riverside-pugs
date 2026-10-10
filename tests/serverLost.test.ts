import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { ServerLostWatch, classifyStatus, lostText } from '../src/serverLost.js';
import { ORPHAN_AFTER_MS, STALE_AFTER_MS } from '../src/liveView.js';

const NOW = Date.parse('2026-10-07T04:18:30Z');
const sql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let db: DB;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  db.exec("INSERT INTO servers (id, name, host, port, rcon_port, rcon_password, status) VALUES (3, 'Riverside #3', 'h', 27015, 27015, 'pw', 'live')");
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

function liveMatch(o: { lastSeenAgoMs: number; bookingId?: number | null; state?: string; maps?: number }): number {
  if (o.bookingId != null) {
    // Only the column matters here, not a whole booking row.
    db.pragma('foreign_keys = OFF');
  }
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, booking_id) VALUES (1, ?, 'no_mercy', 3, 'tok', ?)",
  ).run(o.state ?? 'live', o.bookingId ?? null).lastInsertRowid);
  db.prepare('INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, ?, ?)')
    .run(id, 'l4d_vs_hospital04_interior', sql(NOW - o.lastSeenAgoMs));
  for (let i = 0; i < (o.maps ?? 0); i++) {
    db.prepare('INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, ?, ?, 0, 0)')
      .run(id, `m${i}`, i + 1);
  }
  return id;
}

function watch(o: { status?: (id: number) => Promise<string>; a2s?: { players: number } | null } = {}) {
  const calls = { status: 0, a2s: 0 };
  const w = new ServerLostWatch({
    db,
    now: () => NOW,
    status: async () => { calls.status++; if (!o.status) throw new Error('rcon connect timeout'); return o.status(0); },
    a2s: async () => { calls.a2s++; return o.a2s ?? null; },
  });
  return { w, calls };
}

const problems = () => events.filter((e): e is Extract<AdminEvent, { kind: 'problem' }> => e.kind === 'problem');

describe('classifyStatus', () => {
  it('reads a restarted box (no match, other match, ended) as restarted', () => {
    expect(classifyStatus('STATUS state=none match=0 token=(none) campaign=(none)', 554)).toEqual({ kind: 'restarted', state: 'none' });
    expect(classifyStatus('STATUS state=live match=600 token=x', 554)).toEqual({ kind: 'restarted', state: 'live' });
    expect(classifyStatus('STATUS state=ended match=554 token=x', 554)).toEqual({ kind: 'restarted', state: 'ended' });
  });
  it('reads this match still live as logs_quiet', () => {
    expect(classifyStatus('junk\nSTATUS state=live match=554 token=abc\nSTATUS end', 554)).toEqual({ kind: 'logs_quiet' });
  });
  it('reads a body with no STATUS line (plugin not loaded yet) as restarted', () => {
    expect(classifyStatus('bhop table...', 554)).toEqual({ kind: 'restarted', state: null });
  });
});

describe('ServerLostWatch', () => {
  it('alerts once when a live match goes quiet and its server restarted', async () => {
    const id = liveMatch({ lastSeenAgoMs: STALE_AFTER_MS + 30_000, maps: 3 });
    const { w, calls } = watch({ status: async () => 'STATUS state=none match=0 token=(none)' });
    expect(await w.tick()).toEqual([id]);
    expect(calls.status).toBe(1);
    expect(problems()).toHaveLength(1);
    const p = problems()[0];
    expect(p.matchId).toBe(id);
    expect(p.link).toEqual({ label: 'Live board', path: `/admin/live?live=${id}` });
    expect(p.text).toContain(`Match #${id} (No Mercy, map 4 l4d_vs_hospital04_interior) on Riverside #3`);
    expect(p.text).toContain('srcds crashed or was restarted');
    expect(p.text).toContain('Nothing was changed');
    expect(p.text).not.toContain('tok');
    // Deduped, including across a new watch (a web restart).
    expect(await w.tick()).toEqual([]);
    expect(await watch({ status: async () => '' }).w.tick()).toEqual([]);
    expect(problems()).toHaveLength(1);
    expect(calls.status).toBe(1);
    // Nothing changed on the match or the server.
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(id)).toEqual({ state: 'live' });
    expect(db.prepare('SELECT status FROM servers WHERE id = 3').get()).toEqual({ status: 'live' });
  });

  it('leaves a match with a fresh heartbeat alone and never dials it', async () => {
    liveMatch({ lastSeenAgoMs: 30_000 });
    const { w, calls } = watch({ status: async () => 'STATUS state=none match=0' });
    expect(await w.tick()).toEqual([]);
    expect(calls.status).toBe(0);
    expect(problems()).toHaveLength(0);
  });

  it('skips bookings (they have crash recovery) and matches not live', async () => {
    liveMatch({ lastSeenAgoMs: STALE_AFTER_MS * 3, bookingId: 9 });
    liveMatch({ lastSeenAgoMs: STALE_AFTER_MS * 3, state: 'aborted' });
    const { w, calls } = watch({ status: async () => 'STATUS state=none match=0' });
    expect(await w.tick()).toEqual([]);
    expect(calls.status).toBe(0);
  });

  it('says the logs are quiet when the box still holds the match live', async () => {
    const id = liveMatch({ lastSeenAgoMs: STALE_AFTER_MS + 1_000 });
    const { w } = watch({ status: async () => `STATUS state=live match=${id} token=tok` });
    await w.tick();
    expect(problems()[0].text).toContain('still holds it live');
  });

  it('falls back to A2S when rcon fails: up without rcon, or down', async () => {
    const id = liveMatch({ lastSeenAgoMs: STALE_AFTER_MS + 1_000 });
    const up = watch({ a2s: { players: 7 } });
    await up.w.tick();
    expect(up.calls.a2s).toBe(1);
    expect(problems()[0].text).toContain('rcon does not answer but the server browser does (7 players)');

    db.prepare('UPDATE matches SET server_lost_alerted_at = NULL WHERE id = ?').run(id);
    events.length = 0;
    await watch({ a2s: null }).w.tick();
    expect(problems()[0].text).toContain('neither rcon nor the server browser answers');
  });

  it('says how long until the reaper aborts it', async () => {
    liveMatch({ lastSeenAgoMs: 150_000 });
    await watch({ status: async () => '' }).w.tick();
    const left = Math.round((ORPHAN_AFTER_MS - 150_000) / 60_000);
    expect(problems()[0].text).toContain(`aborted as server lost in about ${left} min`);
  });

  it('posts once when heartbeats come back and arms the match again', async () => {
    const id = liveMatch({ lastSeenAgoMs: STALE_AFTER_MS + 1_000 });
    const { w } = watch({ status: async () => `STATUS state=live match=${id}` });
    await w.tick();
    expect(problems()).toHaveLength(1);
    // A heartbeat lands after the alert.
    db.prepare('UPDATE match_live SET last_seen = ? WHERE match_id = ?').run(sql(NOW + 1_000), id);
    await w.tick();
    expect(problems()).toHaveLength(2);
    expect(problems()[1].text).toContain('is reporting again');
    expect(db.prepare('SELECT server_lost_alerted_at AS a FROM matches WHERE id = ?').get(id)).toEqual({ a: null });
    await w.tick();
    expect(problems()).toHaveLength(2);
  });

  it('says nothing when a heartbeat lands while the box is being asked', async () => {
    const id = liveMatch({ lastSeenAgoMs: STALE_AFTER_MS + 1_000 });
    const { w } = watch({
      status: async () => {
        db.prepare('UPDATE match_live SET last_seen = ? WHERE match_id = ?').run(sql(NOW), id);
        return 'STATUS state=none match=0';
      },
    });
    expect(await w.tick()).toEqual([]);
    expect(problems()).toHaveLength(0);
  });

  it('never throws when the database read fails', async () => {
    const { w } = watch();
    db.close();
    await expect(w.tick()).resolves.toEqual([]);
  });
});

describe('lostText', () => {
  it('says the reaper is due when past its deadline', () => {
    const t = lostText({
      matchId: 1, serverName: 'Dallas', campaign: 'No Mercy', mapNo: 1, mapName: null,
      silentS: 700, reaperInS: -100, verdict: { kind: 'down' },
    });
    expect(t).toContain('due to be aborted as server lost now');
    expect(t).not.toMatch(/\u2014/);
  });
});
