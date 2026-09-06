import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function framed(body: string): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  const text = Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8');
  return Buffer.concat([head, text]);
}

describe('parseLogDatagram', () => {
  it('parses MATCH_START', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_START map=l4d_hospital01_apartment`));
    expect(ev).toEqual({ kind: 'match_start', token: TOKEN, map: 'l4d_hospital01_apartment' });
  });

  it('parses MAP_RESULT with numeric scores', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MAP_RESULT map=l4d_garage b=310 a=245`));
    expect(ev).toEqual({ kind: 'map_result', token: TOKEN, map: 'l4d_garage', a: 245, b: 310 });
  });

  it('parses HEARTBEAT', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT`));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('parses PLAYER connect/disconnect', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PLAYER steamid=76561198000000001 event=disconnect`));
    expect(ev).toEqual({ kind: 'player', token: TOKEN, steamid: '76561198000000001', event: 'disconnect' });
  });

  it('parses MATCH_END', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=812 b=1044 winner=b`));
    expect(ev).toEqual({ kind: 'match_end', token: TOKEN, a: 812, b: 1044, winner: 'b' });
  });

  it('parses an unframed body (raw text without engine header)', () => {
    const ev = parseLogDatagram(Buffer.from(`PUG ${TOKEN} HEARTBEAT`, 'utf8'));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('returns null for a non-PUG log line', () => {
    expect(parseLogDatagram(framed('"Alice<2><STEAM_1:0:1><Survivor>" say "hi"'))).toBeNull();
  });

  it('returns null for a bad token', () => {
    expect(parseLogDatagram(framed('PUG not-a-token HEARTBEAT'))).toBeNull();
  });

  it('returns null for an unknown verb', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} FROBNICATE x=1`))).toBeNull();
  });

  it('returns null for a MATCH_END with a bad winner', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=1 b=2 winner=x`))).toBeNull();
  });

  /* Byte-for-byte framing captured from the live L4D1 box on 2026-08-29 via
   * `logaddress_add` + a UDP sink:
   *   b'\xff\xff\xff\xffRL 08/29/2026 - 15:29:00: PUG <token> HEARTBEAT\n\x00'
   * The synthetic `framed()` above matched reality except for the trailing NUL
   * terminator, which these cases pin explicitly. */
  const liveFramed = (body: string): Buffer =>
    Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]),
      Buffer.from(`L 08/29/2026 - 15:29:00: ${body}\n`, 'utf8'),
      Buffer.from([0x00]),
    ]);

  it('parses a heartbeat in the exact live wire framing (trailing NUL)', () => {
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} HEARTBEAT`)))
      .toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('parses every verb in the live framing', () => {
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MATCH_START map=l4d_hospital01_apartment`)))
      .toEqual({ kind: 'match_start', token: TOKEN, map: 'l4d_hospital01_apartment' });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MAP_RESULT map=l4d_hospital01_apartment a=412 b=380`)))
      .toEqual({ kind: 'map_result', token: TOKEN, map: 'l4d_hospital01_apartment', a: 412, b: 380 });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} PLAYER steamid=76561198000000001 event=connect`)))
      .toEqual({ kind: 'player', token: TOKEN, steamid: '76561198000000001', event: 'connect' });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MATCH_END a=412 b=380 winner=a`)))
      .toEqual({ kind: 'match_end', token: TOKEN, a: 412, b: 380, winner: 'a' });
  });

  it('ignores the engine\'s own rcon echo lines', () => {
    // Real capture: the server echoes every rcon command back over the same
    // stream, including our own sm_pug_* commands. Those must not parse as events.
    expect(parseLogDatagram(liveFramed(
      `rcon from "45.32.199.85:46706": command "sm_pug_roster "76561198000000001:a""`,
    ))).toBeNull();
  });
});
