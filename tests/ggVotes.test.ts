import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { parseLogDatagram } from '../src/logParse.js';
import { recordGgLine, forfeitRecord } from '../src/ggVotes.js';
import { completedPug } from '../src/matchKinds.js';
import { upsertPlayer } from '../src/players.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const SID = '76561198000000001';

function framed(body: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 10/05/2026 - 01:00:00: ${body}\n`, 'utf8')]);
}

describe('GG line parsing', () => {
  it('parses a start with the player and the numbers it was judged on', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} GG event=start team=b steamid=${SID} gap=2000 best=1650 yes=1 need=4`));
    expect(ev).toEqual({
      kind: 'gg', token: TOKEN, event: 'start', team: 'b', steamid: SID, reason: null, gap: 2000, best: 1650, yes: 1, need: 4,
    });
  });

  it('parses a refusal with its reason and a team outcome with no player', () => {
    const r = parseLogDatagram(framed(`PUG ${TOKEN} GG event=refused team=a steamid=${SID} reason=winnable gap=300 best=1650 yes=0 need=0`));
    expect(r).toMatchObject({ event: 'refused', reason: 'winnable', gap: 300 });
    const f = parseLogDatagram(framed(`PUG ${TOKEN} GG event=fail team=a reason=timeout gap=-1 best=-1 yes=2 need=4`));
    expect(f).toMatchObject({ event: 'fail', steamid: null, gap: null, best: null, yes: 2, need: 4 });
  });

  it('refuses unknown events, teams and malformed ids', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} GG event=boom team=a gap=1 best=1 yes=0 need=0`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} GG event=start team=c gap=1 best=1 yes=0 need=0`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} GG event=start team=a steamid=123 gap=1 best=1 yes=0 need=0`))).toBeNull();
  });
});

describe('recordGgLine and forfeitRecord', () => {
  let db: DB;
  let matchId: number;
  beforeEach(() => {
    db = openDb(':memory:');
    upsertPlayer(db, { steamid: SID, name: 'p1', avatar: null }, []);
    matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)").run(TOKEN).lastInsertRowid);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'b')").run(matchId, SID);
  });

  it('stores lines against the match and drops ones for no match', () => {
    const base = { token: TOKEN, team: 'b' as const, steamid: SID, reason: null, gap: 2000, best: 1650, yes: 1, need: 4 };
    expect(recordGgLine(db, { ...base, event: 'start' })).toBe(matchId);
    expect(recordGgLine(db, { ...base, token: 'nope', event: 'start' })).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_gg_votes').get() as { n: number }).n).toBe(1);
  });

  it('counts forfeits and started votes in completed matches only', () => {
    recordGgLine(db, { token: TOKEN, event: 'start', team: 'b', steamid: SID, reason: null, gap: 2000, best: 1650, yes: 1, need: 4 });
    expect(forfeitRecord(db, SID, completedPug('m'))).toEqual({ forfeits: 0, ggStarted: 0 });
    db.prepare("UPDATE matches SET state = 'completed', winner = 'a', forfeit_team = 'b', ended_at = datetime('now') WHERE id = ?").run(matchId);
    expect(forfeitRecord(db, SID, completedPug('m'))).toEqual({ forfeits: 1, ggStarted: 1 });
  });
});
