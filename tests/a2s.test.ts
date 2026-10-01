import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { a2sInfo } from '../src/a2s.js';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
let sock: dgram.Socket | null = null;
afterEach(() => { sock?.close(); sock = null; });

/** A fake srcds: answers A2S_INFO, first with a challenge when `challenge` is set. */
function fake(o: { challenge?: boolean; silent?: boolean; players?: number; map?: string }): Promise<number> {
  return new Promise((resolve) => {
    sock = dgram.createSocket('udp4');
    sock.on('message', (msg, r) => {
      if (o.silent) return;
      const hasChallenge = msg.length >= 4 + 1 + 20 + 4;
      if (o.challenge && !hasChallenge) {
        sock!.send(Buffer.concat([HEADER, Buffer.from([0x41, 1, 2, 3, 4])]), r.port, r.address);
        return;
      }
      if (o.challenge) expect([...msg.subarray(msg.length - 4)]).toEqual([1, 2, 3, 4]);
      const str = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
      const body = Buffer.concat([
        HEADER, Buffer.from([0x49, 17]), str('Riverside #3'), str(o.map ?? 'l4d_vs_hospital02_subway'), str('left4dead'), str('L4D'),
        Buffer.from([0xf4, 0x01]), // app id 500 (L4D1), little endian; unused
        Buffer.from([o.players ?? 0, 18, 0]),
      ]);
      sock!.send(body, r.port, r.address);
    });
    sock.bind(0, '127.0.0.1', () => resolve((sock!.address() as { port: number }).port));
  });
}

describe('a2sInfo', () => {
  it('reads players and map from a direct answer', async () => {
    const port = await fake({ players: 7 });
    expect(await a2sInfo('127.0.0.1', port)).toEqual({ players: 7, map: 'l4d_vs_hospital02_subway' });
  });
  it('answers a challenge and then reads the answer', async () => {
    const port = await fake({ challenge: true, players: 3 });
    expect(await a2sInfo('127.0.0.1', port)).toEqual({ players: 3, map: 'l4d_vs_hospital02_subway' });
  });
  it('gives null on silence, within the timeout', async () => {
    const port = await fake({ silent: true });
    const t = Date.now();
    expect(await a2sInfo('127.0.0.1', port, 300)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});
