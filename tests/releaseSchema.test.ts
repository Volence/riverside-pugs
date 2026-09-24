import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

describe('release schema', () => {
  it('has releases, release_boxes and balance_patches.release_id', () => {
    const db = openDb(':memory:');
    const id = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, created_by, created_at)
      VALUES ('deploy', '[]', 'staged', '1', 'x')`).run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, 1, 'staged', NULL, '{}', 'x')").run(id);
    db.prepare("INSERT INTO balance_patches (source, first_seen_at, release_id) VALUES ('detected', 'x', ?)").run(id);
    expect(() => db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'nope', '1', 'x')").run()).toThrow();
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
