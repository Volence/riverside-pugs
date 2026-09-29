import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const P = '76561199048276493';
const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

describe('PUGSIDE parsing', () => {
  it('reads a ready line', () => {
    expect(parse(`PUGSIDE event=ready token=ab12cd34 steamid=${P}`)).toEqual({
      kind: 'side', event: 'ready', token: 'ab12cd34', steamid: P, map: null, campaign: null,
    });
  });
  it('reads a vote with its campaign and a map end with its map', () => {
    expect(parse(`PUGSIDE event=vote token=ab12cd34 steamid=${P} campaign=no_mercy`)).toMatchObject({ campaign: 'no_mercy' });
    expect(parse('PUGSIDE event=mapend token=ab12cd34 map=l4d_vs_hospital01_apartment'))
      .toMatchObject({ event: 'mapend', steamid: null, map: 'l4d_vs_hospital01_apartment' });
  });
  it('drops unknown events, bad tokens, bad maps and bad campaigns', () => {
    expect(parse('PUGSIDE event=explode token=ab12cd34')).toBeNull();
    expect(parse('PUGSIDE event=mapend token=zz;quit map=x')).toBeNull();
    expect(parse('PUGSIDE event=mapend token=ab12cd34 map=bad*map')).toMatchObject({ map: null });
    expect(parse(`PUGSIDE event=vote token=ab12cd34 steamid=${P} campaign=Bad;Slug`)).toMatchObject({ campaign: null });
  });
  it('drops a player event without a valid steamid', () => {
    expect(parse('PUGSIDE event=ready token=ab12cd34 steamid=nope')).toBeNull();
  });
});
