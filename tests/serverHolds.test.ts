import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, claimableServers, setEnabled } from '../src/serverPool.js';
import { holdFor, isHeld, NOT_HELD_SQL } from '../src/serverHolds.js';

const OWNER = '76561199000000001';

function seedOwner(db: DB): void {
  db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'owner')").run(OWNER);
}
function lease(db: DB, serverId: number, extra: { endReason?: string; ended?: boolean } = {}): number {
  return Number(db.prepare(
    `INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at, end_reason, ended_at)
     VALUES (?, 'park', ?, 'pw', datetime('now', '+1 hour'), ?, ?)`,
  ).run(serverId, OWNER, extra.endReason ?? null, extra.ended ? new Date().toISOString() : null).lastInsertRowid);
}
function sideGame(db: DB, serverId: number, extra: { endReason?: string; ended?: boolean } = {}): number {
  return Number(db.prepare(
    'INSERT INTO side_games (server_id, token, password, end_reason, ended_at) VALUES (?, ?, ?, ?, ?)',
  ).run(serverId, `t${serverId}`, 'p', extra.endReason ?? null, extra.ended ? new Date().toISOString() : null).lastInsertRowid);
}
let hosts = 0;
function box(db: DB, name: string): number {
  return addServer(db, { name, host: `10.0.0.${++hosts}`, port: 27015, rconPort: 27015, rconPassword: 'x' });
}

let db: DB;
let s1: number, s2: number, s3: number;
beforeEach(() => {
  db = openDb(':memory:');
  seedOwner(db);
  s1 = box(db, 's1'); s2 = box(db, 's2'); s3 = box(db, 's3');
});

describe('holdFor / isHeld', () => {
  it('a free box has no hold', () => {
    expect(holdFor(db, s1)).toBeNull();
    expect(isHeld(db, s1)).toBe(false);
  });

  it('an open practice lease holds its box, naming the lease row', () => {
    const id = lease(db, s1);
    expect(holdFor(db, s1)).toEqual({ kind: 'practice', rowId: id });
    expect(isHeld(db, s1)).toBe(true);
    expect(isHeld(db, s2)).toBe(false);
  });

  it('an open side game holds its box, naming the side game row', () => {
    const id = sideGame(db, s2);
    expect(holdFor(db, s2)).toEqual({ kind: 'side', rowId: id });
  });

  it('a lease or side game being wound down still holds (end_reason set, ended_at NULL)', () => {
    lease(db, s1, { endReason: 'owner' });
    sideGame(db, s2, { endReason: 'preempted' });
    expect(holdFor(db, s1)?.kind).toBe('practice');
    expect(holdFor(db, s2)?.kind).toBe('side');
  });

  it('an ended row holds nothing', () => {
    lease(db, s1, { endReason: 'owner', ended: true });
    sideGame(db, s2, { endReason: 'match', ended: true });
    expect(holdFor(db, s1)).toBeNull();
    expect(holdFor(db, s2)).toBeNull();
  });

  it('two holds on one box answer with the lower rank (practice before side)', () => {
    const id = lease(db, s1);
    sideGame(db, s1);
    expect(holdFor(db, s1)).toEqual({ kind: 'practice', rowId: id });
  });
});

describe('claimableServers / claimIdle against holds', () => {
  it('lists idle, enabled, unheld boxes lowest id first', () => {
    lease(db, s1);
    expect(claimableServers(db).map((s) => s.id)).toEqual([s2, s3]);
    sideGame(db, s2);
    expect(claimableServers(db).map((s) => s.id)).toEqual([s3]);
    setEnabled(db, s3, false);
    expect(claimableServers(db)).toEqual([]);
  });

  it('claimIdle skips a leased box, a side game box and a box being wound down', () => {
    lease(db, s1, { endReason: 'owner' });
    sideGame(db, s2);
    const got = claimIdle(db)!;
    expect(got.id).toBe(s3);
    expect(claimIdle(db)).toBeNull();
  });

  it('claimIdle takes a box again once its hold has ended', () => {
    const id = lease(db, s1);
    sideGame(db, s2); sideGame(db, s3);
    expect(claimIdle(db)).toBeNull();
    db.prepare("UPDATE practice_leases SET ended_at = datetime('now') WHERE id = ?").run(id);
    expect(claimIdle(db)!.id).toBe(s1);
  });

  it('NOT_HELD_SQL is usable as a bare WHERE fragment on servers', () => {
    lease(db, s1);
    const ids = (db.prepare(`SELECT id FROM servers WHERE ${NOT_HELD_SQL} ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([s2, s3]);
  });
});

describe('open_server_holds survives reopening and table rebuilds', () => {
  it('a file database reopened with open holds keeps them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugholds-')), 'pug.db');
    let fdb = openDb(path);
    seedOwner(fdb);
    const a = box(fdb, 'a');
    lease(fdb, a);
    fdb.close();
    fdb = openDb(path);
    expect(holdFor(fdb, a)?.kind).toBe('practice');
    fdb.close();
  });
});

describe('open_server_holds is only rewritten when its definition changes', () => {
  it('reopening an up-to-date database leaves the schema untouched, so other connections never see the view missing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugholds-')), 'pug.db');
    openDb(path).close();
    const before = openDb(path);
    const version = before.pragma('schema_version', { simple: true });
    const again = openDb(path);
    expect(before.pragma('schema_version', { simple: true })).toBe(version);
    again.close(); before.close();
  });

  it('a stale definition from an older build is replaced', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugholds-')), 'pug.db');
    let fdb = openDb(path);
    fdb.exec("DROP VIEW open_server_holds; CREATE VIEW open_server_holds AS SELECT server_id, 'practice' AS kind, id AS row_id, 1 AS rank FROM practice_leases WHERE ended_at IS NULL");
    seedOwner(fdb);
    const a = box(fdb, 'a');
    sideGame(fdb, a);
    expect(holdFor(fdb, a)).toBeNull();
    fdb.close();
    fdb = openDb(path);
    expect(holdFor(fdb, a)?.kind).toBe('side');
    fdb.close();
  });
});
