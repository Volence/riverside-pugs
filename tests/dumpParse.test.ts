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
      { steamid: '76561198000000001', team: 'a', sidmg: 1240, sikill: 8, ck: 312, ff: 45, rev: 3 },
      { steamid: '76561198000000002', team: 'b', sidmg: 980, sikill: 6, ck: 280, ff: 12, rev: 1 },
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
