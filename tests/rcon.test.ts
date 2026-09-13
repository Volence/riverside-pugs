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
});
