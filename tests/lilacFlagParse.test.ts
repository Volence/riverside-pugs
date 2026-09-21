import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const parse = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const STAMP = 'L 09/21/2026 - 12:15:22: ';
const BODY = 'L4DL id=76561198030288393 cheat=5 banned=0';

describe('L4DL lilac flag line', () => {
  it('parses a suspicion', () => {
    expect(parse(STAMP + BODY)).toMatchObject({
      kind: 'lilac_flag', steamid: '76561198030288393', cheat: 5, banned: false,
    });
  });

  it('parses a ban', () => {
    expect(parse(STAMP + BODY.replace('banned=0', 'banned=1')))
      .toMatchObject({ kind: 'lilac_flag', banned: true });
  });

  // Same protection as the consistency drop and the input burst: the game
  // server relays every chat line on this stream, so the marker only counts
  // when it is the first thing after the engine's own timestamp.
  it('refuses a flag forged through chat', () => {
    expect(parse(`${STAMP}"x<2><STEAM_1:0:5><Infected>" say "${BODY}"`))
      .not.toMatchObject({ kind: 'lilac_flag' });
  });

  it('refuses a flag forged through a player name', () => {
    expect(parse(`${STAMP}"${BODY}<2><STEAM_1:0:5><Infected>" entered the game`))
      .not.toMatchObject({ kind: 'lilac_flag' });
  });

  it('refuses a bad steamid', () => {
    expect(parse(STAMP + BODY.replace('76561198030288393', 'nope'))).toBeNull();
  });

  it('refuses a cheat number outside what LilAC can emit', () => {
    expect(parse(STAMP + BODY.replace('cheat=5', 'cheat=99'))).toBeNull();
    expect(parse(STAMP + BODY.replace('cheat=5', 'cheat=-1'))).toBeNull();
  });

  it('refuses a missing field', () => {
    expect(parse(STAMP + 'L4DL id=76561198030288393 banned=0')).toBeNull();
  });
});
