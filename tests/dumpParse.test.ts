import { describe, it, expect } from 'vitest';
import { parseDump } from '../src/dumpParse.js';

const SAMPLE = [
  'DUMP match=42',
  'MAP map=l4d_hospital01_apartment a=245 b=310',
  'MAP map=l4d_hospital02_subway a=400 b=300',
  'STAT steamid=76561198000000001 team=a sidmg=1240 sikill=8 ck=312 ff=45 rev=3',
  'STAT steamid=76561198000000002 team=b sidmg=980 sikill=6 ck=280 ff=12 rev=1',
  'END winner=a a=645 b=610',
].join('\n');

describe('parseDump', () => {
  it('parses a full dump', () => {
    const d = parseDump(SAMPLE)!;
    expect(d.matchId).toBe(42);
    expect(d.maps).toEqual([
      { map: 'l4d_hospital01_apartment', a: 245, b: 310 },
      { map: 'l4d_hospital02_subway', a: 400, b: 300 },
    ]);
    expect(d.players).toEqual([
      { steamid: '76561198000000001', team: 'a', joinedMap: 0, sidmg: 1240, sikill: 8, ck: 312, ff: 45, rev: 3 },
      { steamid: '76561198000000002', team: 'b', joinedMap: 0, sidmg: 980, sikill: 6, ck: 280, ff: 12, rev: 1 },
    ]);
    expect(d.winner).toBe('a');
    expect(d.totalA).toBe(645);
    expect(d.totalB).toBe(610);
  });

  it('tolerates leading RCON noise/whitespace and CRLF', () => {
    const d = parseDump(`\r\nsome console echo\r\n${SAMPLE.replace(/\n/g, '\r\n')}\r\n`)!;
    expect(d.matchId).toBe(42);
    expect(d.players).toHaveLength(2);
  });

  it('returns null when DUMP header missing', () => {
    expect(parseDump('MAP map=x a=1 b=2\nEND winner=a a=1 b=2')).toBeNull();
  });

  it('returns null when END missing', () => {
    expect(parseDump('DUMP match=1\nMAP map=x a=1 b=2')).toBeNull();
  });

  it('returns null on a malformed STAT line', () => {
    const bad = SAMPLE.replace('sidmg=1240', 'sidmg=oops');
    expect(parseDump(bad)).toBeNull();
  });
});

const SKILL_SAMPLE = [
  'DUMP match=42 skilldetect=1',
  'MAP map=l4d_vs_airport01_greenhouse a=824 b=400',
  'STAT steamid=76561198000000001 team=a sidmg=1850 sikill=13 ck=44 ff=4 rev=2',
  'SKILL steamid=76561198000000001 skeets=2 skeets_shotgun=2 deadstops=1 tank_damage=1699 times_skeeted=3',
  'END winner=a a=824 b=400',
].join('\n');

describe('parseDump SKILL lines', () => {
  it('parses skill stats and the capability flag', () => {
    const d = parseDump(SKILL_SAMPLE)!;
    expect(d.skillDetect).toBe(true);
    expect(d.skills).toEqual([
      { steamid: '76561198000000001',
        stats: { skeets: 2, skeets_shotgun: 2, deadstops: 1, tank_damage: 1699, times_skeeted: 3 } },
    ]);
  });

  it('defaults skillDetect to false when the header omits it', () => {
    expect(parseDump(SAMPLE)!.skillDetect).toBe(false);
    expect(parseDump(SAMPLE)!.skills).toEqual([]);
  });

  it('drops unknown stat keys rather than failing the dump', () => {
    const body = SKILL_SAMPLE.replace('deadstops=1', 'deadstops=1 wat=9');
    const d = parseDump(body)!;
    expect(d.skills[0].stats).not.toHaveProperty('wat');
    expect(d.skills[0].stats.deadstops).toBe(1);
  });

  it('rejects the dump when a SKILL steamid is malformed', () => {
    expect(parseDump(SKILL_SAMPLE.replace('steamid=76561198000000001 skeets', 'steamid=nope skeets'))).toBeNull();
  });

  it('rejects the dump when a known stat has a non-integer value', () => {
    expect(parseDump(SKILL_SAMPLE.replace('skeets=2', 'skeets=x'))).toBeNull();
  });
});

// Audit 2026-09-21 item 23. pug-match 0.3.3 echoes the backend's nonce and its
// own match state on both the DUMP and the END line.
describe('parseDump with a nonce', () => {
  const N = '0123456789abcdef';
  const block = (nonce: string | null, state: string | null, winner = 'a', match = 42): string => {
    const tail = `${nonce ? ` nonce=${nonce}` : ''}${state ? ` state=${state}` : ''}`;
    return [
      `DUMP match=${match} skilldetect=0${tail}`,
      'MAP map=l4d_hospital01_apartment a=245 b=310',
      'STAT steamid=76561198000000001 team=a joined_map=0 sidmg=1 sikill=1 ck=1 ff=1 rev=1',
      `END winner=${winner} a=645 b=610${tail}`,
    ].join('\n');
  };

  it('reads the nonce and the state off an answer that echoes ours', () => {
    const d = parseDump(block(N, 'ended'), { nonce: N })!;
    expect(d.nonce).toBe(N);
    expect(d.state).toBe('ended');
    expect(d.matchId).toBe(42);
  });

  it('takes the LAST block that carries our nonce, not the first block in the response', () => {
    const body = [block('ffffffffffffffff', 'ended', 'b'), 'unrelated console chatter', block(N, 'ended', 'a'), block(N, 'ended', 'draw')].join('\n');
    expect(parseDump(body, { nonce: N })!.winner).toBe('draw');
  });

  it('is not fooled by an earlier block that has no nonce at all', () => {
    const body = [block(null, null, 'b'), block(N, 'live', 'a')].join('\n');
    const d = parseDump(body, { nonce: N })!;
    expect(d.winner).toBe('a');
    expect(d.state).toBe('live');
  });

  it('refuses an answer whose blocks carry a nonce, none of them ours', () => {
    expect(parseDump(block('ffffffffffffffff', 'ended'), { nonce: N })).toBeNull();
  });

  it('refuses a block whose END line does not repeat the nonce', () => {
    const body = block(N, 'ended').replace(/(END .*) nonce=\w+/, '$1 nonce=ffffffffffffffff');
    expect(parseDump(body, { nonce: N })).toBeNull();
    expect(parseDump(block(N, 'ended').replace(/(END [^\n]*?) nonce=\w+/, '$1'), { nonce: N })).toBeNull();
  });

  it('refuses a state it does not know, rather than guessing whether the match is over', () => {
    expect(parseDump(block(N, 'banana'), { nonce: N })).toBeNull();
  });

  it('reads an old plugin, which echoes nothing, exactly as before: first DUMP, first END', () => {
    const body = [block(null, null, 'b'), block(null, null, 'a')].join('\n');
    const d = parseDump(body, { nonce: N })!;
    expect(d.winner).toBe('b');
    expect(d.nonce).toBeNull();
    expect(d.state).toBeNull();
    expect(parseDump(body)!.winner).toBe('b');
  });
});
