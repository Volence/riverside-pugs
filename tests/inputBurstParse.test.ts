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

  // Plugin 0.1.0 is live on four servers and stays there until 0.2.0 is staged
  // on an empty box, so its lines must keep parsing exactly as they did.
  it('reads a line from plugin 0.1.0 as wire 1 with no server span', () => {
    expect(parseLogLine(STAMP + BODY)).toMatchObject({ kind: 'input_burst', wire: 1, serverSpan: null });
  });
});

describe('L4DM wire 2: intervals timed by usercmd', () => {
  const V2 = 'L4DM id=76561198030288393 k=fire w=weapon_pistol n=4 g=0 a=0 st=91422 ct=91419 sp=31 v=2 d=7787';

  it('parses the version and the server tick span', () => {
    expect(parseLogLine(STAMP + V2)).toMatchObject({
      kind: 'input_burst', burstKind: 'fire', wire: 2, serverSpan: 31, serverTick: 91422, clientTick: 91419,
    });
  });

  it('takes the fields in any order, since it reads them by key', () => {
    const shuffled = 'L4DM v=2 d=7787 id=76561198030288393 sp=31 k=fire w=weapon_pistol n=4 g=0 a=0 st=1 ct=1';
    expect(parseLogLine(STAMP + shuffled)).toMatchObject({ kind: 'input_burst', wire: 2 });
  });

  // A version this parser has never heard of may have changed what a field
  // means. Refused, not guessed at: web deploys before the plugin, always.
  it('refuses a wire version from the future', () => {
    expect(parseLogLine(STAMP + V2.replace('v=2', 'v=3'))).toBeNull();
    expect(parseLogLine(STAMP + V2.replace('v=2', 'v=two'))).toBeNull();
  });

  it('refuses a nonsense server span', () => {
    expect(parseLogLine(STAMP + V2.replace('sp=31', 'sp=-4'))).toBeNull();
    expect(parseLogLine(STAMP + V2.replace('sp=31', 'sp=9999999'))).toBeNull();
  });
});

describe('L4DM hold series', () => {
  // One hold per PRESS, so one more than the intervals between them.
  const H = 'L4DM id=76561198030288393 k=fire w=weapon_pistol n=4 g=0 a=0 st=91422 ct=91419 sp=31 v=2 d=7787 h=23242';

  it('parses the holds as a second ordered series', () => {
    expect(parseLogLine(STAMP + H)).toMatchObject({ kind: 'input_burst', intervals: [8, 8, 9, 8], holds: [3, 4, 3, 5, 3] });
  });

  it('is optional: a line without it parses, with holds null', () => {
    expect(parseLogLine(STAMP + H.replace(' h=23242', ''))).toMatchObject({ kind: 'input_burst', holds: null });
    expect(parseLogLine(STAMP + BODY)).toMatchObject({ kind: 'input_burst', holds: null });
  });

  it('refuses holds that do not line up with the presses', () => {
    expect(parseLogLine(STAMP + H.replace('h=23242', 'h=2324'))).toBeNull();
    expect(parseLogLine(STAMP + H.replace('h=23242', 'h=232421'))).toBeNull();
  });

  it('refuses a hold the plugin could not have produced', () => {
    expect(parseLogLine(STAMP + H.replace('h=23242', 'h=2324N'))).toBeNull();
    expect(parseLogLine(STAMP + H.replace('h=23242', 'h='))).toBeNull();
  });

  // A bhop line is one jump: one placeholder interval, one real hold.
  it('takes exactly one hold on a bhop line', () => {
    const hop = 'L4DM id=76561198030288393 k=bhop w= n=1 g=2 a=0 st=5 ct=5 sp=0 v=2 d=0 h=0';
    expect(parseLogLine(STAMP + hop)).toMatchObject({ burstKind: 'bhop', holds: [1] });
    expect(parseLogLine(STAMP + hop.replace('h=0', 'h=00'))).toBeNull();
  });

  // The longest line the plugin can emit must stay well inside one log line.
  it('fits the largest possible burst in under 900 bytes', () => {
    const d = 'M'.repeat(256), h = 'M'.repeat(257);
    const line = `${STAMP}L4DM id=76561198030288393 k=pounce w=${'w'.repeat(31)} n=256 g=100000 a=100000 st=2147483647 ct=2147483647 sp=100000 v=2 d=${d} h=${h}`;
    expect(Buffer.byteLength(line)).toBeLessThan(900);
    expect(parseLogLine(line)).toMatchObject({ kind: 'input_burst' });
  });
});
