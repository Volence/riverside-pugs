import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const parseLogLine = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));

const STAMP = 'L 09/21/2026 - 03:15:22: ';
const BODY = 'L4DM id=76561198030288393 k=pounce w=hunter_claw n=4 g=3 a=21 st=91422 ct=91420 d=0012';

describe('L4DM input burst line', () => {
  it('parses a well formed burst', () => {
    const ev = parseLogLine(STAMP + BODY);
    expect(ev).toMatchObject({
      kind: 'input_burst', steamid: '76561198030288393', burstKind: 'pounce',
      weapon: 'hunter_claw', groundTicks: 3, airPresses: 21, serverTick: 91422, clientTick: 91420,
    });
    expect((ev as { intervals: number[] }).intervals).toEqual([1, 1, 2, 3]);
  });

  // THE test. The game server relays every chat line on the same stream, so a
  // player whose name or message contains a whole L4DM body must not be able to
  // forge a burst for someone else. The marker is only honoured when it is the
  // first thing after the engine's stamp, which no player controlled text can be:
  // every engine line about a player opens with a quote.
  it('refuses a burst forged through chat', () => {
    const say = `${STAMP}"cheater<2><STEAM_1:0:5><Infected>" say "${BODY}"`;
    expect(parseLogLine(say)).not.toMatchObject({ kind: 'input_burst' });
  });

  it('refuses a burst forged through a player name', () => {
    const named = `${STAMP}"${BODY}<2><STEAM_1:0:5><Infected>" entered the game`;
    expect(parseLogLine(named)).not.toMatchObject({ kind: 'input_burst' });
  });

  it('refuses a malformed steamid', () => {
    expect(parseLogLine(STAMP + BODY.replace('76561198030288393', 'nope'))).toBeNull();
  });

  it('refuses an unknown anchor', () => {
    expect(parseLogLine(STAMP + BODY.replace('k=pounce', 'k=wallhack'))).toBeNull();
  });

  it('refuses intervals the plugin could not have produced', () => {
    expect(parseLogLine(STAMP + BODY.replace('d=0012', 'd=001N'))).toBeNull();
  });

  it('refuses a burst whose declared count disagrees with the data', () => {
    expect(parseLogLine(STAMP + BODY.replace('n=4', 'n=99'))).toBeNull();
  });

  it('refuses negative or absurd counters', () => {
    expect(parseLogLine(STAMP + BODY.replace('a=21', 'a=-1'))).toBeNull();
    expect(parseLogLine(STAMP + BODY.replace('g=3', 'g=999999'))).toBeNull();
  });

  it('accepts a fire burst with no airborne presses', () => {
    const fire = BODY.replace('k=pounce', 'k=fire').replace('a=21', 'a=0');
    expect(parseLogLine(STAMP + fire)).toMatchObject({ kind: 'input_burst', burstKind: 'fire', airPresses: 0 });
  });
});
