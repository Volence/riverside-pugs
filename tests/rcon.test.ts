import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { RconClient } from '../src/rcon.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';

function fakeServer(password = 'secret'): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            const ok = p.body === password;
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(ok ? p.id : -1, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            if (p.body === 'bigcmd') {
              // What srcds does past about 4 KB: the body arrives as several
              // RESPONSE_VALUE packets with the command's id and no end marker.
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, 'x'.repeat(4000)));
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, 'y'.repeat(1500)));
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, 'END'));
            } else {
              const body = p.body === 'dumpcmd' ? 'DUMPBODY' : `ran:${p.body}`;
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, body));
            }
          } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
            // The multi-packet terminator: Source answers an empty
            // RESPONSE_VALUE request with an empty response for that id and
            // then a second packet with a four-byte junk body for the same id.
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

describe('RconClient', () => {
  it('authenticates and runs a command', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const client = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    await client.connect();
    expect(await client.exec('status')).toBe('ran:status');
    expect(await client.exec('dumpcmd')).toBe('DUMPBODY');
    client.close();
  });

  it('reassembles a response that arrives in several packets', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const client = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    await client.connect();
    const body = await client.exec('bigcmd');
    expect(body).toHaveLength(4000 + 1500 + 3);
    expect(body.endsWith('END')).toBe(true);
    // The marker's junk follow-up packet must not leak into the next command.
    expect(await client.exec('status')).toBe('ran:status');
    client.close();
  });

  it('rejects a bad password', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const client = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'wrong' });
    await expect(client.connect()).rejects.toThrow(/auth/i);
    client.close();
  });

  // srcds drops every other rcon connection the moment one of them closes
  // (reproduced ten times out of ten on a real server, 2026-09-21), so two
  // batches to one box must never overlap.
  it('never holds two connections to one server at once', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const mk = () => new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    const order: string[] = [];
    const run = async (tag: string) => {
      const c = mk();
      await c.connect();
      order.push(`${tag}:open`);
      await c.exec('status');
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${tag}:close`);
      c.close();
    };
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(order).toEqual(['a:open', 'a:close', 'b:open', 'b:close', 'c:open', 'c:close']);
  });

  it('a failed connect gives the turn to the next caller', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const bad = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'wrong' });
    const good = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    const first = bad.connect();
    const second = good.connect();
    await expect(first).rejects.toThrow('rcon auth failed');
    await second;
    expect(await good.exec('status')).toBe('ran:status');
    good.close();
  });

  it('a holder that never closes loses its turn after the hold limit', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const hog = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret', holdMaxMs: 50 });
    const next = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    await hog.connect();
    await next.connect();
    // The hog's socket was destroyed before the next one opened.
    await expect(hog.exec('status')).rejects.toThrow('rcon not connected');
    next.close();
  });

  it('different servers do not wait for each other', async () => {
    const s1 = await fakeServer();
    const s2 = await fakeServer();
    stop = async () => { await s1.close(); await s2.close(); };
    const a = new RconClient({ host: '127.0.0.1', port: s1.port, password: 'secret' });
    const b = new RconClient({ host: '127.0.0.1', port: s2.port, password: 'secret' });
    await a.connect();
    await b.connect();
    expect(await b.exec('status')).toBe('ran:status');
    a.close();
    b.close();
  });
});
