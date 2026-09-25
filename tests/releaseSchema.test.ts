import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addServer, getServer } from '../src/serverPool.js';

describe('release schema', () => {
  it('has releases, release_boxes and balance_patches.release_id', () => {
    const db = openDb(':memory:');
    const id = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, created_by, created_at)
      VALUES ('deploy', '[]', 'staged', '1', 'x')`).run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, 1, 'staged', NULL, '{}', 'x')").run(id);
    db.prepare("INSERT INTO balance_patches (source, first_seen_at, release_id) VALUES ('detected', 'x', ?)").run(id);
    expect(() => db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'nope', '1', 'x')").run()).toThrow();
  });
  it('gives every server a deploy_slug that a rename does not change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slug-'));
    try {
      const path = join(dir, 'pug.db');
      let db = openDb(path);
      const id = addServer(db, { name: 'Riverside #3', host: 'h', port: 1, rconPort: 1, rconPassword: 'x' });
      expect(getServer(db, id)!.deploy_slug).toBe('riverside-3');
      db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('Old Box', 'h', 2, 2, 'x')").run();
      db.prepare('UPDATE servers SET name = ? WHERE id = ?').run('Riverside Three', id);
      db.close();
      db = openDb(path); // an existing row with none is backfilled from its name
      expect((db.prepare("SELECT deploy_slug FROM servers WHERE name = 'Old Box'").get() as { deploy_slug: string }).deploy_slug).toBe('old-box');
      expect(getServer(db, id)!.deploy_slug).toBe('riverside-3');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('puts the repo clone and backups beside the database', () => {
    const c = loadConfig({ DB_PATH: '/srv/data/pug.db' });
    expect(c.deployRepoDir).toBe('/srv/data/deploy-repo.git');
    expect(c.releasesDir).toBe('/srv/data/releases');
    expect(c.deployRepoUrl).toBe('git@github.com:Volence/l4d-deploy.git');
    expect(c.deployRepoKey).toBeNull();
    expect(loadConfig({ DEPLOY_REPO_KEY: '/k' }).deployRepoKey).toBe('/k');
  });
});
