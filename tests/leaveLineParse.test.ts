import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = 'a'.repeat(32);
const ID = '76561199000000002';
const f = (l: string) => Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/21/2026 - 20:00:00: ${l}\n\0`),
]);

describe('LEAVE with the 0.3.4 keys', () => {
  it('a 0.3.3 line parses to exactly what it always did', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=254`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 254 });
  });

  it('reads a hold', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=1 hold_left=1800 auto=0`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200, held: true, holdLeft: 1800 });
  });

  it('reads the ceiling releasing a hold', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=0 hold_left=0 auto=1`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200, held: false, holdLeft: 0, auto: true });
  });

  it('a nonsense optional key costs the key, never the line', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=banana hold_left=-4 auto=yes`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200 });
  });

  it('RETURN is unchanged, extra keys and all', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} RETURN steamid=${ID} remaining=200 held=1`)))
      .toEqual({ kind: 'return', token: TOKEN, steamid: ID, remaining: 200 });
  });
});
