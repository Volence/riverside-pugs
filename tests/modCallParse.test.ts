import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const P = '76561199048276493';
const T = '76561199122132251';
const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));
const full = (extra = '', text = 'aimlocking through walls') =>
  `PUGCALL steamid=${P} target=${T} tteam=2 reason=cheating match=42 ord=3 half=2 tms=61234 via=game${extra} text=${text}`;

describe('PUGCALL parsing', () => {
  it('reads a full call, text last', () => {
    expect(parse(full())).toEqual({
      kind: 'call', steamid: P, target: T, callerTeam: 2, reason: 'cheating',
      matchId: 42, ordinal: 3, half: 2, tMs: 61234, via: 'game', map: null, text: 'aimlocking through walls',
    });
  });

  it('reads the map the plugin names, so a call outside a match still has one', () => {
    expect(parse(full(' map=l4d_vs_hospital01_apartment'))).toMatchObject({ map: 'l4d_vs_hospital01_apartment' });
  });

  it('drops a map value that is not a plain map name', () => {
    expect(parse(full(' map=bad*map'))).toMatchObject({ map: null, reason: 'cheating' });
    expect(parse(full(` map=${'a'.repeat(65)}`))).toMatchObject({ map: null });
  });

  it('never takes the map from inside the text', () => {
    expect(parse(full('', 'x map=l4d_vs_farm05_cornfield'))).toMatchObject({ map: null, text: 'x map=l4d_vs_farm05_cornfield' });
  });

  it('never takes a field from inside the text', () => {
    expect(parse(full('', `x steamid=${T} target=team reason=other match=7`)))
      .toMatchObject({ steamid: P, target: T, reason: 'cheating', matchId: 42, text: `x steamid=${T} target=team reason=other match=7` });
  });

  it('keeps the text whole when the signature trailer follows it', () => {
    expect(parse(`${full()} lseq=1790141171.12 mac=0a1b2c3d`)).toMatchObject({ text: 'aimlocking through walls' });
  });

  it('allows empty text', () => {
    expect(parse(full('', ''))).toMatchObject({ text: '' });
  });

  it('reads targetless calls', () => {
    for (const t of ['team', 'general', 'none']) {
      expect(parse(full().replace(`target=${T}`, `target=${t}`))).toMatchObject({ target: t });
    }
  });

  it('has no match or moment outside a match or a round', () => {
    expect(parse(full().replace('match=42', 'match=0').replace('tms=61234', 'tms=-1')))
      .toMatchObject({ matchId: null, tMs: null });
  });

  it('ignores the marker inside an engine chat line', () => {
    expect(parse(`"zero<22><STEAM_1:1:544005382><Infected>" say "${full()}"`)).toBeNull();
  });

  it.each([
    `PUGCALL steamid=123 target=team tteam=2 reason=other match=0 ord=0 half=0 tms=-1 via=game text=`,
    `PUGCALL steamid=${P} target=bob tteam=2 reason=other match=0 ord=0 half=0 tms=-1 via=game text=`,
    `PUGCALL steamid=${P} target=team tteam=2 reason=spam match=0 ord=0 half=0 tms=-1 via=game text=`,
    `PUGCALL steamid=${P} target=team tteam=2 reason=other match=0 ord=0 half=0 tms=-1 via=radio text=`,
    `PUGCALL steamid=${P} target=team tteam=2 reason=other match=0 ord=0 half=0 tms=-1 via=game`,
  ])('rejects the malformed line %j', (line) => {
    expect(parse(line)).toBeNull();
  });
});
