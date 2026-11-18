import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { completeMatch, storeDumpAlt } from '../src/matchResult.js';
import { parseDump, type Dump } from '../src/dumpParse.js';
import { upsertPlayer } from '../src/players.js';
import { upsertAltRound } from '../src/altRoundStore.js';
import { parseAltFields } from '../src/logParse.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MAP0 = 'l4d_vs_hospital01_apartment';
const MAP1 = 'l4d_vs_hospital02_subway';
const MAP2 = 'l4d_vs_hospital03_sewers';

let db: DB;

function seedLiveMatch(): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'hospital')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

function altLine(map: string, half: 1 | 2, walk: number): string {
  return `ALT map=${map} half=${half} surv=${half === 1 ? 'a' : 'b'} rule=hr1 walk=${walk} tank=164 door=0 wm=115 dm=175 `
    + 'ws=180.25 wt=40.50 wr=96.00 ts=150.00 tt=60.00 tr=90.00 ds=0.00 dt=0.00 dr=0.00 tankpct=41 tankby=surv tanks=1 in=0';
}

function body(matchId: number, alt: string[]): string {
  return [
    `DUMP match=${matchId}`,
    `MAP map=${MAP0} a=400 b=350`,
    `MAP map=${MAP1} a=200 b=500`,
    ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=100 sikill=1 ck=50 ff=0 rev=0`),
    ...alt,
    'END winner=b a=600 b=850',
  ].join('\n');
}

function dumpOf(matchId: number, alt: string[]): Dump {
  const d = parseDump(body(matchId, alt));
  if (!d) throw new Error('fixture dump did not parse');
  return d;
}

/** The same fields the UDP ALT_ROUND line would carry for a half. */
function udpFields(map: string, half: 1 | 2, walk: number) {
  const kv = Object.fromEntries(altLine(map, half, walk).split(' ').slice(1).map((p) => p.split('=') as [string, string]));
  return parseAltFields(kv)!;
}

function altRows(matchId: number) {
  return db.prepare('SELECT ordinal, half, walk, source FROM match_round_alt WHERE match_id = ? ORDER BY ordinal, half').all(matchId);
}

function result(matchId: number) {
  return {
    match: db.prepare('SELECT state, team_a_score, team_b_score, winner FROM matches WHERE id = ?').get(matchId),
    maps: db.prepare('SELECT ordinal, map, team_a_score, team_b_score FROM match_maps WHERE match_id = ? ORDER BY ordinal').all(matchId),
  };
}

beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ALT lines in the match dump', () => {
  it('replaces udp rows with the dump values and inserts halves only the dump has', () => {
    const m = seedLiveMatch();
    upsertAltRound(db, m, 0, udpFields(MAP0, 1, 100), 'udp');
    upsertAltRound(db, m, 0, udpFields(MAP0, 2, 110), 'udp');
    expect(completeMatch(db, m, dumpOf(m, [altLine(MAP0, 1, 400), altLine(MAP0, 2, 410), altLine(MAP1, 1, 420)]))).toBe(true);
    expect(altRows(m)).toEqual([
      { ordinal: 0, half: 1, walk: 400, source: 'dump' },
      { ordinal: 0, half: 2, walk: 410, source: 'dump' },
      { ordinal: 1, half: 1, walk: 420, source: 'dump' },
    ]);
  });

  it('leaves match_maps and the winner exactly as the same dump without ALT lines', () => {
    const plain = seedLiveMatch();
    const withAlt = seedLiveMatch();
    expect(completeMatch(db, plain, dumpOf(plain, []))).toBe(true);
    expect(completeMatch(db, withAlt, dumpOf(withAlt, [altLine(MAP0, 1, 400), altLine(MAP1, 2, 410)]))).toBe(true);
    expect(result(withAlt)).toEqual(result(plain));
    expect(altRows(plain)).toEqual([]);
  });

  it('a failing alt write costs the match nothing: it completes with the same result and storeDumpAlt does not throw', () => {
    const plain = seedLiveMatch();
    expect(completeMatch(db, plain, dumpOf(plain, []))).toBe(true);
    db.exec('DROP TABLE match_round_alt');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = seedLiveMatch();
    const dump = dumpOf(m, [altLine(MAP0, 1, 400)]);
    expect(completeMatch(db, m, dump)).toBe(true);
    expect(result(m)).toEqual(result(plain));
    expect(errors).toHaveBeenCalled();
    const logged: string[] = [];
    expect(() => storeDumpAlt(db, m, dump, (msg) => logged.push(msg))).not.toThrow();
    expect(logged).toHaveLength(1);
  });

  it('an ALT line whose map has no MAP line takes ordinal = the MAP count', () => {
    const m = seedLiveMatch();
    expect(completeMatch(db, m, dumpOf(m, [altLine(MAP2, 1, 300)]))).toBe(true);
    expect(altRows(m)).toEqual([{ ordinal: 2, half: 1, walk: 300, source: 'dump' }]);
  });

  it('a dump with no alt field (hand-built, or an older plugin) writes nothing', () => {
    const m = seedLiveMatch();
    const { alt: _alt, ...dump } = dumpOf(m, []);
    expect(() => storeDumpAlt(db, m, dump)).not.toThrow();
    expect(altRows(m)).toEqual([]);
  });
});
