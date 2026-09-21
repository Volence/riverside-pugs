import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { recordPhase } from '../src/liveView.js';
import { recordSignonDrop, markEntered } from '../src/signonDrops.js';
import { recordPresenceLine } from '../src/presence.js';
import { buildLiveBoard, type BoardPlayer } from '../src/admin/liveBoard.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const TOKEN = 'a'.repeat(32);
const at = (min: number, s = 0) => new Date(Date.UTC(2026, 8, 21, 20, min, s));
const NOW = at(10);
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((p, i) => {
    upsertPlayer(db, { steamid: p, name: `p${i}`, avatar: null }, []);
    activatePlayer(db, p);
    linkDiscord(db, p, `90${i}`, `d${i}`);
  });
  const serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  matchId = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, server_id, token, created_at, went_live_at)
     VALUES (1, 'live', 'dead_air', ?, ?, '2026-09-21 20:00:00', '2026-09-21 20:02:00')`,
  ).run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});

const board = (voice: { inVoice(id: string): boolean | null } | null = null) => buildLiveBoard(db, { voice, now: NOW });
const find = (steamid: string): BoardPlayer => {
  const m = board().matches[0];
  return [...m.teamA, ...m.teamB].find((p) => p.steamid === steamid)!;
};

describe('the match line', () => {
  it('names the server, the campaign, the state, the score and how long it has run', () => {
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_airport02_offices', datetime('now'))").run(matchId);
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, 'l4d_airport01_greenhouse', 0, 412, 380)").run(matchId);
    const b = board();
    expect(b.now).toBe(NOW.toISOString());
    expect(b.holdMaxMinutes).toBe(30);
    expect(b.matches[0]).toMatchObject({
      id: matchId, campaign: 'dead_air', map: 'l4d_airport02_offices', state: 'live', phase: null,
      server: { name: 'Dallas' }, teamAScore: 412, teamBScore: 380, elapsedS: 480, leaveControl: 'unknown',
    });
    expect(b.matches[0].teamA).toHaveLength(4);
    expect(b.matches[0].teamB).toHaveLength(4);
  });

  it('says paused when the game is, and waiting when there is no server', () => {
    recordPhase(db, TOKEN, { state: 'paused', team: null, limit: 0, leave: true, unready: [] });
    expect(board().matches[0]).toMatchObject({ state: 'paused', phase: 'paused' });
    db.prepare("UPDATE matches SET state = 'configuring', server_id = NULL WHERE id = ?").run(matchId);
    expect(board().matches[0]).toMatchObject({ state: 'waiting', server: null });
  });

  it('reports what is known about the plugin', () => {
    db.prepare('UPDATE matches SET leave_control = 0 WHERE id = ?').run(matchId);
    expect(board().matches[0].leaveControl).toBe('old_plugin');
    db.prepare('UPDATE matches SET leave_control = 1 WHERE id = ?').run(matchId);
    expect(board().matches[0].leaveControl).toBe('ok');
  });

  it('lists nothing that is over', () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect(board().matches).toEqual([]);
  });
});

describe('exactly one status per player', () => {
  it('never connected, with how long since the pop', () => {
    expect(find(IDS[0]).status).toEqual({ kind: 'never_connected', sincePopS: 600 });
  });

  it('on the server, from a presence row or from connected_at alone', () => {
    recordPresenceLine(db, { kind: 'player', token: TOKEN, steamid: IDS[0], event: 'connect' }, at(3));
    expect(find(IDS[0]).status).toEqual({ kind: 'connected', remainingS: null });
    db.prepare("UPDATE match_players SET connected_at = '2026-09-21 20:03:00' WHERE player_id = ?").run(IDS[1]);
    expect(find(IDS[1]).status).toEqual({ kind: 'connected', remainingS: null });
  });

  it('dropped, with how long ago and what is left now', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(9, 18));
    expect(find(IDS[2]).status).toEqual({ kind: 'dropped', sinceS: 42, remainingS: 258, held: false, holdLeftS: null });
    expect(board().matches[0].clocks).toEqual([
      { kind: 'abandon', steamid: IDS[2], name: 'p2', remainingS: 258, held: false, holdLeftS: null },
    ]);
  });

  it('dropped and held: the figure stands still and the ceiling counts down', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(9, 0));
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 270, held: true, holdLeft: 1800 }, at(9, 30));
    expect(find(IDS[2]).status).toEqual({ kind: 'dropped', sinceS: 60, remainingS: 270, held: true, holdLeftS: 1770 });
  });

  it('back, with a used allowance worth showing', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(8));
    recordPresenceLine(db, { kind: 'return', token: TOKEN, steamid: IDS[2], remaining: 240 }, at(9));
    expect(find(IDS[2]).status).toEqual({ kind: 'connected', remainingS: 240 });
    expect(board().matches[0].clocks).toEqual([]);
  });
});

describe('a reason, when known and never guessed', () => {
  it('rejected by the file check, from a connect drop since the pop with no entry after it', () => {
    recordSignonDrop(db, { steamid: IDS[0], name: 'p0', secs: 14, forced: 651 }, at(4));
    expect(find(IDS[0]).reason).toEqual({ kind: 'signon_drop', at: at(4).toISOString() });
    markEntered(db, IDS[0], at(5));
    expect(find(IDS[0]).reason).toBeNull();
  });

  it('ignores a connect drop from before this match popped', () => {
    recordSignonDrop(db, { steamid: IDS[0], name: 'p0', secs: 14, forced: 651 }, new Date(Date.UTC(2026, 8, 21, 19, 0, 0)));
    expect(find(IDS[0]).reason).toBeNull();
  });

  it('not in a voice channel, only when Discord says so', () => {
    const where: Record<string, boolean | null> = { '900': false, '901': true, '902': null };
    const voice = { inVoice: (id: string) => where[id] ?? null };
    const m = buildLiveBoard(db, { voice, now: NOW }).matches[0];
    expect(m.teamA.find((p) => p.steamid === IDS[0])!.reason).toEqual({ kind: 'not_in_voice' });
    expect(m.teamA.find((p) => p.steamid === IDS[1])!.reason).toBeNull();
    expect(m.teamA.find((p) => p.steamid === IDS[2])!.reason).toBeNull();
  });

  it('gives no reason for someone who is on the server', () => {
    recordPresenceLine(db, { kind: 'player', token: TOKEN, steamid: IDS[0], event: 'connect' }, at(3));
    const voice = { inVoice: () => false };
    expect(buildLiveBoard(db, { voice, now: NOW }).matches[0].teamA.find((p) => p.steamid === IDS[0])!.reason).toBeNull();
  });
});
