import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

describe('fleet schema', () => {
  it('has the reading tables', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO fleet_readings (server_id, attempt_at) VALUES (1, 'x')").run();
    db.prepare("INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, 'left4dead/cfg/a.cfg', 3, NULL)").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM fleet_files').get()).toEqual({ n: 1 });
  });
  it('puts the fleet dir beside the database unless FLEET_DIR is set', () => {
    expect(loadConfig({ DB_PATH: '/srv/data/pug.db' }).fleetDir).toBe('/srv/data/fleet');
    expect(loadConfig({ DB_PATH: '/srv/data/pug.db', FLEET_DIR: '/tmp/f' }).fleetDir).toBe('/tmp/f');
  });
});
