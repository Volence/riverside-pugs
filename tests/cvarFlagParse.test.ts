import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const parse = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const STAMP = 'L 09/22/2026 - 12:15:22: ';
const BODY = 'L4DV id=76561198030288393 cvar=cpu_level value=0';

describe('L4DV client setting line', () => {
  it('parses a low cpu_level, whether the client sends 0 or 0.000000', () => {
    expect(parse(STAMP + BODY)).toEqual({ kind: 'cvar_flag', steamid: '76561198030288393', cvar: 'cpu_level', value: 0, act: 'live' });
    expect(parse(STAMP + BODY.replace('value=0', 'value=0.000000'))).toMatchObject({ kind: 'cvar_flag', value: 0 });
  });

  it('reads what the plugin did, and a 0.1.0 line with no act as live', () => {
    expect(parse(`${STAMP}${BODY} act=held`)).toMatchObject({ kind: 'cvar_flag', value: 0, act: 'held' });
    expect(parse(`${STAMP}${BODY.replace('value=0', 'value=2')} act=fixed`)).toMatchObject({ value: 2, act: 'fixed' });
    expect(parse(`${STAMP}${BODY} act=live`)).toMatchObject({ act: 'live' });
    expect(parse(`${STAMP}${BODY} act=kicked`)).toBeNull();
  });

  it('refuses a setting it does not know, and a value that is not a plain number', () => {
    expect(parse(STAMP + BODY.replace('cpu_level', 'sv_cheats'))).toBeNull();
    expect(parse(STAMP + BODY.replace('value=0', 'value=abc'))).toBeNull();
    expect(parse(STAMP + BODY.replace('value=0', ''))).toBeNull();
    expect(parse(STAMP + BODY.replace('76561198030288393', 'nobody'))).toBeNull();
  });

  // Same protection as every other token-less line: the marker only counts as
  // the first thing after the engine's timestamp, never inside chat.
  it('refuses a line forged through chat', () => {
    expect(parse(`${STAMP}"x<2><STEAM_1:0:5><Infected>" say "${BODY}"`))
      .not.toMatchObject({ kind: 'cvar_flag' });
  });
});
