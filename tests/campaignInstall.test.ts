import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, installsOf } from '../src/customCampaigns.js';
import { fakeAddonsTransport } from './fakes/fakeAddonsTransport.js';
import { installCampaign, uninstallCampaign, isInstalledEverywhere } from '../src/campaignInstall.js';

let db: DB;
let dir: string;
let src: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'inst-'));
  src = join(dir, 'dbd.vpk');
  writeFileSync(src, 'vpk bytes');
  db.prepare(
    "INSERT INTO servers (id, name, host, port, rcon_port, rcon_password, status) VALUES (1,'A','h',1,1,'p','idle'),(2,'B','h',2,2,'p','idle')",
  ).run();
  insertDraft(db, {
    slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
    sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [{ map: 'dbd1', display: null, isFinale: true }]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('installCampaign', () => {
  it('installs to every server and records it', async () => {
    const a = fakeAddonsTransport();
    const b = fakeAddonsTransport();
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: a.transport }, { id: 2, transport: b.transport }],
    });
    expect(installsOf(db, 'dbd').map((r) => r.state)).toEqual(['installed', 'installed']);
    expect(a.files.has('dbd.vpk')).toBe(true);
    expect(b.files.has('dbd.vpk')).toBe(true);
  });

  // One unreachable box must not stop the other from being installed, or a
  // single flaky server keeps every campaign out of the pool.
  it('records a failure per server without abandoning the rest', async () => {
    const good = fakeAddonsTransport();
    const bad = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: bad.transport }, { id: 2, transport: good.transport }],
    });
    const rows = installsOf(db, 'dbd');
    expect(rows.find((r) => r.server_id === 1)!.state).toBe('failed');
    expect(rows.find((r) => r.server_id === 1)!.error).toMatch(/connection refused/);
    expect(rows.find((r) => r.server_id === 2)!.state).toBe('installed');
  });

  // A server with no transport configured is a configuration gap, not an
  // outage. It is recorded as failed so the panel says so out loud.
  it('records an unconfigured server as failed', async () => {
    await installCampaign(db, 'dbd', {
      sourcePath: src, servers: [{ id: 1, transport: null }],
    });
    expect(installsOf(db, 'dbd')[0].error).toMatch(/not configured/i);
  });

  // The size check is the whole verification: a truncated upload that the
  // transport did not throw on must not be recorded as installed.
  it('fails when the landed size does not match', async () => {
    const t = fakeAddonsTransport();
    db.prepare('UPDATE custom_campaigns SET size_bytes = 999 WHERE slug = ?').run('dbd');
    await installCampaign(db, 'dbd', {
      sourcePath: src, servers: [{ id: 1, transport: t.transport }],
    });
    expect(installsOf(db, 'dbd')[0].state).toBe('failed');
    expect(installsOf(db, 'dbd')[0].error).toMatch(/size/i);
  });

  it('retries a previously failed server and succeeds', async () => {
    const t = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    expect(installsOf(db, 'dbd')[0].state).toBe('failed');
    t.state.failPut = false;
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    expect(installsOf(db, 'dbd')[0].state).toBe('installed');
  });
});

describe('isInstalledEverywhere', () => {
  it('is false while any server is not installed', async () => {
    const good = fakeAddonsTransport();
    const bad = fakeAddonsTransport({ failPut: true });
    await installCampaign(db, 'dbd', {
      sourcePath: src,
      servers: [{ id: 1, transport: good.transport }, { id: 2, transport: bad.transport }],
    });
    expect(isInstalledEverywhere(db, 'dbd', [1, 2])).toBe(false);
    expect(isInstalledEverywhere(db, 'dbd', [1])).toBe(true);
  });
});

describe('uninstallCampaign', () => {
  it('removes the file and the install rows', async () => {
    const t = fakeAddonsTransport();
    await installCampaign(db, 'dbd', { sourcePath: src, servers: [{ id: 1, transport: t.transport }] });
    await uninstallCampaign(db, 'dbd', { servers: [{ id: 1, transport: t.transport }] });
    expect(t.files.has('dbd.vpk')).toBe(false);
    expect(installsOf(db, 'dbd')).toEqual([]);
  });
});
