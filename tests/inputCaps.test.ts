import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { openDb, type DB } from '../src/db.js';
import { LogListener } from '../src/logListener.js';
import { parseLogDatagram, type LogEvent } from '../src/logParse.js';
import { capsForPlayer, recordInputCap } from '../src/inputBursts.js';
import { captureHealth } from '../src/integrityFlags.js';

/**
 * The capture budget marker. The plugin stops emitting a kind of burst for a
 * player once that kind's budget for the round is spent, and it used to do so
 * in silence, which made "nothing captured" and "nothing to capture" look the
 * same. It now says so, once per kind, player and round.
 */

const STAMP = 'L 09/21/2026 - 03:15:22: ';
const CAP = 'L4DM id=76561198030288393 k=cap c=bhop st=91422 v=2';
const A = '76561198030288393';
const parse = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));

describe('L4DM cap marker', () => {
  it('parses which budget ran out, for whom, and when', () => {
    expect(parse(STAMP + CAP)).toEqual({ kind: 'input_cap', steamid: A, burstKind: 'bhop', serverTick: 91422 });
  });

  it('refuses a marker for a kind that has no budget', () => {
    expect(parse(STAMP + CAP.replace('c=bhop', 'c=cap'))).toBeNull();
    expect(parse(STAMP + CAP.replace('c=bhop', 'c=aim'))).toBeNull();
    expect(parse(STAMP + CAP.replace(' c=bhop', ''))).toBeNull();
  });

  it('refuses a malformed steamid or tick', () => {
    expect(parse(STAMP + CAP.replace(A, 'nope'))).toBeNull();
    expect(parse(STAMP + CAP.replace('st=91422', 'st=-1'))).toBeNull();
  });

  // Same anchoring as every L4DM line: the marker could otherwise be used to
  // make an admin distrust a clean capture of someone else.
  it('refuses a marker forged through chat', () => {
    const say = `${STAMP}"cheater<2><STEAM_1:0:5><Infected>" say "${CAP}"`;
    expect(parse(say)).not.toMatchObject({ kind: 'input_cap' });
  });
});

describe('LogListener admits the cap marker by source address', () => {
  let listener: LogListener | null = null;
  afterEach(async () => { if (listener) await listener.close(); listener = null; });
  const send = (port: number): Promise<void> => new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`${STAMP}${CAP}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('delivers it from a game server and from nowhere else', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    let port = await listener.listen(0, '127.0.0.1');
    await send(port);
    await settle();
    expect(got).toEqual([]);

    await listener.close();
    listener = new LogListener((ev) => got.push(ev));
    port = await listener.listen(0, '127.0.0.1');
    listener.allowMatchCreateFrom('127.0.0.1');
    await send(port);
    await settle();
    expect(got.map((e) => e.kind)).toEqual(['input_cap']);
  });
});

describe('recordInputCap', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('stores the marker and hands it back for the player panel', () => {
    recordInputCap(db, { matchId: 7, serverId: 1, steamid: A, kind: 'bhop', serverTick: 91422 },
      new Date('2026-09-21T12:00:00.000Z'));
    expect(capsForPlayer(db, A)).toEqual([
      { matchId: 7, kind: 'bhop', serverTick: 91422, at: '2026-09-21T12:00:00.000Z' },
    ]);
  });

  it('is counted by capture health, so truncation is visible from the front door', () => {
    expect(captureHealth(db).caps).toBe(0);
    recordInputCap(db, { matchId: 7, serverId: 1, steamid: A, kind: 'fire', serverTick: 1 });
    expect(captureHealth(db).caps).toBe(1);
  });
});
