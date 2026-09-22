import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { macOf, newLogSecret, setLogAuthMode, setLogSecret } from '../src/logAuth.js';

/**
 * From the UDP socket to the table, with the real listener and the real
 * verifier: the forgery item 15 of the 2026-09-21 audit describes, a LilAC
 * "banned" flag planted on somebody from a game server's address.
 */
const VICTIM = '76561198030413993';
const FLAG = `L4DL id=${VICTIM} cheat=3 banned=1`;
const BOOT = Math.floor(Date.now() / 1000) - 3600;

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/21/2026 - 14:23:01: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}
const sign = (secret: string, body: string, seq: number): string => {
  const withSeq = `${body} lseq=${BOOT}.${seq}`;
  return `${withSeq} mac=${macOf(secret, Buffer.from(withSeq, 'utf8'))}`;
};
const settle = () => new Promise((r) => setTimeout(r, 80));
const flags = (db: DB) => db.prepare('SELECT steamid, server_id, severity FROM integrity_flags ORDER BY id').all();

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(async () => { await app?.close(); app = null; });

describe('log signing, end to end', () => {
  it('off: a flag from the game server\'s address is believed, signed or not (today\'s behaviour)', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, FLAG);
    await settle();
    expect(flags(db)).toHaveLength(1);
  });

  it('enforce: the same forged flag is dropped, and the signed one is kept', async () => {
    const port = await freeUdpPort();
    const dallas = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const secret = newLogSecret();
    setLogSecret(db, dallas, secret);
    setLogAuthMode(db, dallas, 'enforce');
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });

    await send(port, FLAG);
    await send(port, sign('f'.repeat(32), FLAG, 1));
    await settle();
    expect(flags(db)).toEqual([]);

    await send(port, sign(secret, FLAG, 2));
    await settle();
    expect(flags(db)).toEqual([{ steamid: VICTIM, server_id: dallas, severity: 'banned' }]);

    // Captured off the wire and sent again: refused.
    db.prepare('DELETE FROM integrity_flags').run();
    await send(port, sign(secret, FLAG, 2));
    await settle();
    expect(flags(db)).toEqual([]);
  });

  it('credits a signed line to the server that signed it when two share an address and the port says nothing', async () => {
    const port = await freeUdpPort();
    addServer(db, { name: 'riverside3', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const r4 = addServer(db, { name: 'riverside4', host: '127.0.0.1', port: 27016, rconPort: 27016, rconPassword: 'x' });
    const secret = newLogSecret();
    setLogSecret(db, r4, secret);
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    await send(port, sign(secret, FLAG, 1));
    await settle();
    expect(flags(db)).toEqual([{ steamid: VICTIM, server_id: r4, severity: 'banned' }]);
  });
});
