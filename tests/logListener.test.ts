import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { LogListener } from '../src/logListener.js';
import type { LogEvent } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

let listener: LogListener | null = null;
afterEach(async () => { if (listener) await listener.close(); listener = null; });

describe('LogListener', () => {
  it('delivers events for a registered token and drops others', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0);
    listener.register(TOKEN);

    await send(port, `PUG ${TOKEN} HEARTBEAT`);
    await send(port, `PUG ${OTHER} HEARTBEAT`);
    await send(port, 'some other log line');
    await send(port, `PUG ${TOKEN} MATCH_END a=1 b=2 winner=a`);

    await new Promise((r) => setTimeout(r, 50));

    expect(got).toEqual([
      { kind: 'heartbeat', token: TOKEN },
      { kind: 'match_end', token: TOKEN, a: 1, b: 2, winner: 'a' },
    ]);
  });

  it('stops delivering after unregister', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0);
    listener.register(TOKEN);
    listener.unregister(TOKEN);
    await send(port, `PUG ${TOKEN} HEARTBEAT`);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
  });
});
