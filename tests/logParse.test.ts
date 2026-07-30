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
});
