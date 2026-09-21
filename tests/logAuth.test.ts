import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, _resetAmbiguityReports } from '../src/serverPool.js';
import { LogAuth, macOf, newLogSecret, setLogAuthMode, setLogSecret, REORDER_WINDOW } from '../src/logAuth.js';
import { parseLogDatagram, readLogAuthTrailer } from '../src/logParse.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';

const STAMP = 'L 09/21/2026 - 14:00:00: ';
const BOOT = 1790000000;
const FEED = '45.32.199.85';
const TOKEN = '0123456789abcdef0123456789abcdef';
const LILAC = 'L4DL id=76561198030413993 cheat=3 banned=1';

/** A datagram as the plugin would have sent it: body, counter, MAC. */
function signed(secret: string, body: string, seq: number, boot = BOOT): Buffer {
  const withSeq = `${body} lseq=${boot}.${seq}`;
  return Buffer.from(`${STAMP}${withSeq} mac=${macOf(secret, Buffer.from(withSeq, 'utf8'))}\n`, 'utf8');
}
const plain = (body: string): Buffer => Buffer.from(`${STAMP}${body}\n`, 'utf8');

describe('the signature trailer on a log line', () => {
  it('is read off the end of the line, with the bytes that were signed', () => {
    const secret = newLogSecret();
    const t = readLogAuthTrailer(signed(secret, LILAC, 42))!;
    expect(t.boot).toBe(BOOT);
    expect(t.seq).toBe(42);
    expect(t.signed.toString('utf8')).toBe(`${LILAC} lseq=${BOOT}.42`);
    expect(t.mac).toBe(macOf(secret, t.signed));
    expect(readLogAuthTrailer(plain(LILAC))).toBeNull();
  });

  it('signs BYTES: a name that is not valid UTF-8 still verifies', () => {
    const secret = newLogSecret();
    const head = Buffer.from('L4DC SIGNON_DROP steamid=76561198030413993 secs=14 forced=651 name=', 'utf8');
    const body = Buffer.concat([head, Buffer.from([0xc3, 0x28, 0xff, 0x41]), Buffer.from(` lseq=${BOOT}.1`, 'utf8')]);
    const dgram = Buffer.concat([Buffer.from(STAMP), body, Buffer.from(` mac=${macOf(secret, body)}\n`)]);
    const t = readLogAuthTrailer(dgram)!;
    expect(t.signed.equals(body)).toBe(true);
    expect(macOf(secret, t.signed)).toBe(t.mac);
  });

  it('never reaches the grammar: a name keeps no trailer and EVENT keeps its own seq', () => {
    const secret = newLogSecret();
    const drop = parseLogDatagram(signed(secret, 'L4DC SIGNON_DROP steamid=76561198030413993 secs=14 forced=651 name=vol ence', 9));
    expect(drop).toMatchObject({ kind: 'signon_drop', name: 'vol ence' });
    const ev = parseLogDatagram(signed(secret, `PUG ${TOKEN} EVENT seq=7 kind=skeet actor=76561198030413993 target=0 value=1`, 5000));
    expect(ev).toMatchObject({ kind: 'live_event', seq: 7 });
    const roster = parseLogDatagram(signed(secret, `PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=a name=Bob`, 5001));
    expect(roster).toMatchObject({ kind: 'match_roster', name: 'Bob' });
  });
});

describe('LogAuth', () => {
  let db: DB;
  let auth: LogAuth;
  let now: number;
  let dallas: number;
  let chicago: number;
  let secretD: string;
  let secretC: string;
  let problems: string[];
  let unsub: () => void;

  const check = (dgram: Buffer, address = '104.153.111.16', port = 27015) => {
    const ev = parseLogDatagram(dgram);
    if (!ev) throw new Error('test datagram did not parse');
    return auth.check({ ev, trailer: readLogAuthTrailer(dgram), address, port });
  };

  beforeEach(() => {
    db = openDb(':memory:');
    dallas = addServer(db, { name: 'dallas', host: FEED, port: 27015, rconPort: 27015, rconPassword: 'x' });
    chicago = addServer(db, { name: 'chicago', host: '104.153.111.16', port: 27015, rconPort: 27015, rconPassword: 'x' });
    secretD = newLogSecret();
    secretC = newLogSecret();
    setLogSecret(db, dallas, secretD);
    setLogSecret(db, chicago, secretC);
    now = (BOOT + 3600) * 1000;
    auth = new LogAuth(db, FEED, () => now);
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => { unsub(); _resetAmbiguityReports(); });

  it('defaults every server to off, which accepts everything and counts nothing', () => {
    expect((db.prepare('SELECT log_auth FROM servers WHERE id = ?').get(chicago) as any).log_auth).toBe('off');
    expect(check(plain(LILAC))).toMatchObject({ accept: true, verified: false });
    expect(check(signed('0'.repeat(32), LILAC, 1))).toMatchObject({ accept: true, verified: false });
    expect(auth.counters(chicago)).toMatchObject({ ok: 0, missing: 0, badMac: 0, replay: 0 });
  });

  it('verifies a signed line in any mode, and names the server it came from', () => {
    expect(check(signed(secretC, LILAC, 1))).toEqual({ accept: true, verified: true, serverId: chicago });
    expect(auth.counters(chicago).ok).toBe(1);
  });

  it('log mode counts an unsigned or badly signed line and lets it through', () => {
    setLogAuthMode(db, chicago, 'log');
    expect(check(plain(LILAC))).toMatchObject({ accept: true, verified: false });
    expect(check(signed('f'.repeat(32), LILAC, 1))).toMatchObject({ accept: true, verified: false });
    expect(auth.counters(chicago)).toMatchObject({ ok: 0, missing: 1, badMac: 1 });
  });

  it('enforce mode drops both', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(plain(LILAC)).accept).toBe(false);
    expect(check(signed('f'.repeat(32), LILAC, 1)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 1)).accept).toBe(true);
    expect(auth.counters(chicago)).toMatchObject({ ok: 1, missing: 1, badMac: 1 });
  });

  it('enforce mode is per server: Dallas still off does not loosen Chicago, nor the reverse', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(plain(LILAC), FEED).accept).toBe(true);
    expect(check(plain(LILAC), '104.153.111.16').accept).toBe(false);
  });

  it('refuses a line it has already seen, and a line from before the last one by more than the window', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(signed(secretC, LILAC, 500)).accept).toBe(true);
    expect(check(signed(secretC, LILAC, 500)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 500 - REORDER_WINDOW)).accept).toBe(false);
    expect(auth.counters(chicago).replay).toBe(2);
  });

  it('tolerates datagrams arriving out of order inside the window, each once', () => {
    setLogAuthMode(db, chicago, 'enforce');
    for (const seq of [10, 12, 11, 9]) expect(check(signed(secretC, LILAC, seq)).accept, `seq ${seq}`).toBe(true);
    expect(check(signed(secretC, LILAC, 11)).accept).toBe(false);
  });

  it('accepts a low counter again only under a LATER boot stamp, and then refuses the old boot for good', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(signed(secretC, LILAC, 9000)).accept).toBe(true);
    expect(check(signed(secretC, LILAC, 1)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 1, BOOT + 600)).accept).toBe(true);
    expect(check(signed(secretC, LILAC, 9001)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 2, BOOT - 600)).accept).toBe(false);
  });

  it('does not let a boot stamp from the far future pin the stream', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(signed(secretC, LILAC, 1, BOOT + 30 * 86400)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 2)).accept).toBe(true);
  });

  it('remembers where each server had got to across a restart of the backend', () => {
    setLogAuthMode(db, chicago, 'enforce');
    expect(check(signed(secretC, LILAC, 700)).accept).toBe(true);
    auth.flush();
    auth = new LogAuth(db, FEED, () => now);
    expect(check(signed(secretC, LILAC, 700)).accept).toBe(false);
    expect(check(signed(secretC, LILAC, 701)).accept).toBe(true);
  });

  it('holds a token-bearing line to the secret of the server its MATCH is on, wherever it claims to come from', () => {
    db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'no_mercy', ?, ?)").run(chicago, TOKEN);
    setLogAuthMode(db, chicago, 'enforce');
    const end = `PUG ${TOKEN} MATCH_END a=1 b=2 winner=b`;
    // Unsigned, and from Dallas's address where auth is off: still Chicago's match.
    expect(check(plain(end), FEED).accept).toBe(false);
    // Signed with a real secret, but the wrong server's.
    expect(check(signed(secretD, end, 1), FEED).accept).toBe(false);
    expect(check(signed(secretC, end, 1), '104.153.111.16')).toEqual({ accept: true, verified: true, serverId: chicago });
  });

  it('cannot sign the engine\'s own "entered the game" line, so never holds it to a signature', () => {
    setLogAuthMode(db, chicago, 'enforce');
    const entered = plain('"volence<61><STEAM_1:1:35074132><>" entered the game');
    expect(check(entered)).toMatchObject({ accept: true, verified: false });
    expect(auth.counters(chicago).missing).toBe(0);
  });

  it('treats a server with a mode but no secret as off: there is nothing to check against', () => {
    db.prepare("UPDATE servers SET log_secret = NULL, log_auth = 'enforce' WHERE id = ?").run(chicago);
    expect(check(plain(LILAC)).accept).toBe(true);
  });

  describe('two servers on one address', () => {
    let r3: number;
    let r4: number;
    let s3: string;
    let s4: string;
    beforeEach(() => {
      r3 = addServer(db, { name: 'riverside3', host: '66.59.208.5', port: 27015, rconPort: 27015, rconPassword: 'x' });
      r4 = addServer(db, { name: 'riverside4', host: '66.59.208.5', port: 27016, rconPort: 27016, rconPassword: 'x' });
      s3 = newLogSecret(); s4 = newLogSecret();
      setLogSecret(db, r3, s3); setLogSecret(db, r4, s4);
    });

    it('a valid signature names the server outright, whatever port the line came from', () => {
      expect(check(signed(s4, LILAC, 1), '66.59.208.5', 40123)).toEqual({ accept: true, verified: true, serverId: r4 });
      expect(check(signed(s3, LILAC, 1), '66.59.208.5', 40123)).toEqual({ accept: true, verified: true, serverId: r3 });
      expect(problems).toEqual([]);
    });

    it('an unsigned line it cannot attribute is dropped only when EVERY server it could be from enforces', () => {
      setLogAuthMode(db, r3, 'enforce');
      expect(check(plain(LILAC), '66.59.208.5', 40123).accept).toBe(true);
      setLogAuthMode(db, r4, 'enforce');
      expect(check(plain(LILAC), '66.59.208.5', 40123).accept).toBe(false);
    });
  });

  it('tells an admin about failures on an enforcing server, once, not per line', () => {
    setLogAuthMode(db, chicago, 'enforce');
    for (let i = 0; i < 5; i++) check(plain(LILAC));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('chicago');
  });

  it('says nothing about unsigned lines in log mode, which is what a roll-out looks like, but does about a bad signature', () => {
    setLogAuthMode(db, chicago, 'log');
    for (let i = 0; i < 5; i++) check(plain(LILAC));
    expect(problems).toEqual([]);
    check(signed('f'.repeat(32), LILAC, 1));
    expect(problems).toHaveLength(1);
  });
});

describe('LogAuth with nothing turned on', () => {
  it('says nothing at all, even about an address it cannot attribute', () => {
    const db = openDb(':memory:');
    addServer(db, { name: 'riverside3', host: '66.59.208.5', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'riverside4', host: '66.59.208.5', port: 27016, rconPort: 27016, rconPassword: 'x' });
    const problems: string[] = [];
    const unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
    const auth = new LogAuth(db, FEED);
    const dgram = plain(`PUG ${TOKEN} HEARTBEAT`);
    const res = auth.check({ ev: parseLogDatagram(dgram)!, trailer: null, address: '66.59.208.5', port: 40123 });
    unsub();
    _resetAmbiguityReports();
    expect(res).toEqual({ accept: true, verified: false, serverId: null });
    expect(problems).toEqual([]);
  });
});
