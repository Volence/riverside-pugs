import { describe, it, expect } from 'vitest';
import { encodePacket, decodePackets, SERVERDATA_AUTH, SERVERDATA_EXECCOMMAND } from '../src/rconPacket.js';

describe('rcon packet', () => {
  it('encodes with correct size and trailing nulls', () => {
    const p = encodePacket(7, SERVERDATA_EXECCOMMAND, 'status');
    expect(p.readInt32LE(0)).toBe(16);
    expect(p.readInt32LE(4)).toBe(7);
    expect(p.readInt32LE(8)).toBe(SERVERDATA_EXECCOMMAND);
    expect(p.subarray(12, 18).toString()).toBe('status');
    expect(p[p.length - 2]).toBe(0);
    expect(p[p.length - 1]).toBe(0);
  });

  it('round-trips through decode', () => {
    const buf = Buffer.concat([
      encodePacket(1, SERVERDATA_AUTH, 'pw'),
      encodePacket(2, SERVERDATA_EXECCOMMAND, 'hi'),
    ]);
    const { packets, rest } = decodePackets(buf);
    expect(rest.length).toBe(0);
    expect(packets).toEqual([
      { id: 1, type: SERVERDATA_AUTH, body: 'pw' },
      { id: 2, type: SERVERDATA_EXECCOMMAND, body: 'hi' },
    ]);
  });

  it('leaves a partial trailing packet in rest', () => {
    const full = encodePacket(9, SERVERDATA_EXECCOMMAND, 'abc');
    const partial = full.subarray(0, full.length - 3);
    const { packets, rest } = decodePackets(Buffer.concat([full, partial]));
    expect(packets).toHaveLength(1);
    expect(rest.length).toBe(partial.length);
  });
});
