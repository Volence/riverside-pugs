import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openDb, type DB } from '../src/db.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { parseIp2AsnTsv } from '../src/asnTable.js';
import { backfillNetworkAsn, chatLogLines, parseChatJoinLine } from '../src/asnBackfill.js';

const table = parseIp2AsnTsv(readFileSync(join(import.meta.dirname, 'fixtures/ip2asn-v4-sample.tsv'), 'utf8'));
const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';
const joinLine = (steam2: string, ip: string) => `[23:16:32] (${steam2}   | ${ip}) somebody has joined.`;
let db: DB;

beforeEach(() => { db = openDb(':memory:'); });

const asnOf = (steamid: string) =>
  (db.prepare('SELECT asn, as_org FROM player_networks WHERE player_id = ?').get(steamid) as { asn: number | null; as_org: string | null });

describe('parseChatJoinLine', () => {
  it('reads the SteamID and address off a join line', () => {
    expect(parseChatJoinLine('[23:16:32] (STEAM_1:1:84829798   | 142.111.152.210) name has joined.'))
      .toEqual({ steamid: '76561198129925325', ip: '142.111.152.210' });
  });

  it('ignores chat and malformed lines', () => {
    expect(parseChatJoinLine('[23:17:01] name: gg')).toBeNull();
    expect(parseChatJoinLine('[23:17:01] (STEAM_1:0:1 | not-an-ip) name has joined.')).toBeNull();
  });
});

describe('backfillNetworkAsn', () => {
  beforeEach(() => {
    recordPlayerNet(db, { steamid: A, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    recordPlayerNet(db, { steamid: B, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    recordPlayerNet(db, { steamid: C, ip: '203.0.113.200', country: 'US' }, new Date(), null);
  });
  const lines = [joinLine('STEAM_1:0:1', '198.51.100.4'), joinLine('STEAM_1:0:2', '203.0.113.200'), joinLine('STEAM_1:0:3', '45.76.1.1'), 'noise'];

  it('fills every row on a logged address and leaves the rest unknown', () => {
    const r = backfillNetworkAsn(db, lines, table);
    expect(r).toEqual({ lines: 4, joins: 3, addresses: 3, matchedAddresses: 2, updatedRows: 2, unresolved: 1 });
    expect(asnOf(A)).toEqual({ asn: 212238, as_org: 'DATACAMP-LIMITED' });
    expect(asnOf(B).asn).toBe(212238);
    expect(asnOf(C)).toEqual({ asn: null, as_org: null }); // logged, but no range covers it
    expect(JSON.stringify(db.prepare('SELECT * FROM player_networks').all())).not.toContain('198.51.100.4');
  });

  it('never overwrites a provider already known, and a dry run writes nothing', () => {
    expect(backfillNetworkAsn(db, lines, table, { dryRun: true }).updatedRows).toBe(2);
    expect(asnOf(A).asn).toBeNull();
    db.prepare("UPDATE player_networks SET asn = 1, as_org = 'KEPT' WHERE player_id = ?").run(A);
    expect(backfillNetworkAsn(db, lines, table).updatedRows).toBe(1);
    expect(asnOf(A)).toEqual({ asn: 1, as_org: 'KEPT' });
  });

  it('refuses a database that has never hashed an address', () => {
    expect(() => backfillNetworkAsn(openDb(':memory:'), lines, table)).toThrow(/ip_hash_salt/);
  });
});

describe('chatLogLines', () => {
  it('reads plain and gzipped chat logs and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'));
    writeFileSync(join(dir, 'server_27015_chat_2026_10_16.log'), 'one\ntwo\n');
    writeFileSync(join(dir, 'server_27015_chat_2026_10_17.log.gz'), gzipSync('three\n'));
    writeFileSync(join(dir, 'errors_20261017.log'), 'nope\n');
    expect([...chatLogLines(dir)].filter(Boolean)).toEqual(['one', 'two', 'three']);
  });
});

describe('scripts/backfill-network-asn.ts', () => {
  const root = join(import.meta.dirname, '..');
  const run = (...args: string[]) =>
    spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'scripts/backfill-network-asn.ts'), ...args], { encoding: 'utf8', cwd: root });
  const asnGz = () => {
    const dir = mkdtempSync(join(tmpdir(), 'asn-'));
    const p = join(dir, 'asn.tsv');
    writeFileSync(p, readFileSync(join(import.meta.dirname, 'fixtures/ip2asn-v4-sample.tsv'), 'utf8'));
    return p;
  };

  it('errors on a missing --db without creating it, and on a flag with no value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'));
    const missing = join(dir, 'nope.db');
    const logs = mkdtempSync(join(tmpdir(), 'chat-'));
    const r = run('--asn', asnGz(), '--logs', logs, '--db', missing);
    expect(r.status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    const r2 = run('--asn', asnGz(), '--logs', logs, '--db');
    expect(r2.status).not.toBe(0);
  });

  it('defaults to a dry run, writes only with --commit, and prints no address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-'));
    const dbPath = join(dir, 'x.db');
    const d = openDb(dbPath);
    recordPlayerNet(d, { steamid: A, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    d.close();
    const logs = mkdtempSync(join(tmpdir(), 'chat-'));
    writeFileSync(join(logs, 'server_27015_chat_2026_10_16.log'), joinLine('STEAM_1:0:1', '198.51.100.4') + '\n');
    const asn = asnGz();
    const read = () => { const c = openDb(dbPath); const v = c.prepare('SELECT asn FROM player_networks').get() as { asn: number | null }; c.close(); return v.asn; };
    const dry = run('--asn', asn, '--logs', logs, '--db', dbPath);
    expect(dry.status).toBe(0);
    expect(read()).toBeNull();
    const real = run('--asn', asn, '--logs', logs, '--db', dbPath, '--commit');
    expect(real.status).toBe(0);
    expect(read()).toBe(212238);
    for (const out of [dry.stdout + dry.stderr, real.stdout + real.stderr]) expect(out).not.toContain('198.51.100.4');
  });
});
