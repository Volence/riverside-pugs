import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { discoverMatchDemos, recordMatchDemos, resolveDemoPath } from '../src/demos.js';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { upsertPlayer } from '../src/players.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

let dir: string;
let db: DB;

function touch(name: string, size = 16) {
  writeFileSync(join(dir, name), Buffer.alloc(size));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pugdemo-'));
  db = openDb(':memory:');
  db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)").run(TOKEN);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('discoverMatchDemos', () => {
  it('finds this match demos in ordinal order and ignores everything else', () => {
    touch(`pug_${TOKEN}_1_l4d_vs_hospital02_subway.dem`, 200);
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    touch(`pug_${OTHER}_0_l4d_vs_farm01_hilltop.dem`);      // another match
    touch('auto-20260911-0324-l4d_vs_airport01_greenhouse.dem'); // autorecord
    touch(`pug_${TOKEN}_0_notademo.txt`);                    // wrong extension

    const found = discoverMatchDemos(dir, TOKEN);
    expect(found.map((d) => d.ordinal)).toEqual([0, 1]);
    expect(found[0]).toMatchObject({
      ordinal: 0,
      map: 'l4d_vs_hospital01_apartment',
      filename: `pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`,
      bytes: 100,
    });
    expect(found[1].bytes).toBe(200);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    expect(discoverMatchDemos(join(dir, 'nope'), TOKEN)).toEqual([]);
  });

  it('returns empty when the demo dir is not configured', () => {
    expect(discoverMatchDemos('', TOKEN)).toEqual([]);
  });

  it('ignores a zero-byte demo, which is a recording that never got data', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 0);
    expect(discoverMatchDemos(dir, TOKEN)).toEqual([]);
  });

  it('refuses a token that is not 32 hex, so it can never become a glob', () => {
    expect(discoverMatchDemos(dir, '../../../etc')).toEqual([]);
    expect(discoverMatchDemos(dir, '')).toEqual([]);
  });
});

describe('recordMatchDemos', () => {
  it('writes one row per demo and is idempotent', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    touch(`pug_${TOKEN}_1_l4d_vs_hospital02_subway.dem`, 200);

    expect(recordMatchDemos(db, 1, TOKEN, dir)).toBe(2);
    expect(recordMatchDemos(db, 1, TOKEN, dir)).toBe(2);

    const rows = db.prepare('SELECT ordinal, map, bytes FROM match_demos WHERE match_id = 1 ORDER BY ordinal').all();
    expect(rows).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment', bytes: 100 },
      { ordinal: 1, map: 'l4d_vs_hospital02_subway', bytes: 200 },
    ]);
  });

  it('updates the size when a demo is still growing at first scan', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    recordMatchDemos(db, 1, TOKEN, dir);
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 500);
    recordMatchDemos(db, 1, TOKEN, dir);

    const row = db.prepare('SELECT bytes FROM match_demos WHERE match_id = 1 AND ordinal = 0').get();
    expect(row).toEqual({ bytes: 500 });
  });

  it('records nothing and does not throw when there are no demos', () => {
    expect(recordMatchDemos(db, 1, TOKEN, dir)).toBe(0);
  });

  // Two files can share an ordinal: warm-up before a campaign change, the tail
  // of a map transition, an empty recording. On 2026-09-23 matches 76, 93 and
  // 144 each had their row flip between such a pair after the upload, keeping
  // the other file's r2_key. The real recording is always the larger one.
  const row = () => db.prepare('SELECT filename, bytes, r2_key, r2_at FROM match_demos WHERE match_id = 1 AND ordinal = 0').get() as
    { filename: string; bytes: number; r2_key: string | null; r2_at: string | null };

  it('keeps the larger file when two share an ordinal, whatever the directory order', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_airport01_greenhouse.dem`, 100);
    touch(`pug_${TOKEN}_0_l4d_ihm01_forest.dem`, 900);
    expect(recordMatchDemos(db, 1, TOKEN, dir)).toBe(1);
    expect(row().filename).toBe(`pug_${TOKEN}_0_l4d_ihm01_forest.dem`);
  });

  it('never replaces an uploaded row with a different, smaller file', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_stadium1_apartment.dem`, 900);
    recordMatchDemos(db, 1, TOKEN, dir);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/x', r2_at = datetime('now')").run();
    rmSync(join(dir, `pug_${TOKEN}_0_l4d_vs_stadium1_apartment.dem`));   // reclaimed after upload
    touch(`pug_${TOKEN}_0_l4d_vs_airport01_greenhouse.dem`, 100);        // an empty later recording

    recordMatchDemos(db, 1, TOKEN, dir);

    expect(row()).toMatchObject({ filename: `pug_${TOKEN}_0_l4d_vs_stadium1_apartment.dem`, bytes: 900, r2_key: 'demos/1/x' });
  });

  it('clears the key when the row moves to a different, larger file, so that file gets uploaded', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_airport01_greenhouse.dem`, 100);
    recordMatchDemos(db, 1, TOKEN, dir);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/x', r2_at = datetime('now')").run();
    touch(`pug_${TOKEN}_0_l4d_ihm01_forest.dem`, 900);

    recordMatchDemos(db, 1, TOKEN, dir);

    expect(row()).toEqual({ filename: `pug_${TOKEN}_0_l4d_ihm01_forest.dem`, bytes: 900, r2_key: null, r2_at: null });
  });

  it('keeps the key when the same file only grows', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    recordMatchDemos(db, 1, TOKEN, dir);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/x', r2_at = datetime('now')").run();
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 500);

    recordMatchDemos(db, 1, TOKEN, dir);

    expect(row()).toMatchObject({ bytes: 500, r2_key: 'demos/1/x' });
  });
});

describe('resolveDemoPath', () => {
  beforeEach(() => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    recordMatchDemos(db, 1, TOKEN, dir);
  });

  it('resolves a recorded demo to a real path inside the demo dir', () => {
    const got = resolveDemoPath(db, 1, 0, dir);
    expect(got).not.toBeNull();
    expect(got!.path).toBe(join(dir, `pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`));
    expect(got!.filename).toBe(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`);
  });

  it('returns null for an unknown match or ordinal', () => {
    expect(resolveDemoPath(db, 1, 99, dir)).toBeNull();
    expect(resolveDemoPath(db, 99, 0, dir)).toBeNull();
  });

  it('returns null when the row exists but the file is gone (pruned)', () => {
    rmSync(join(dir, `pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`));
    expect(resolveDemoPath(db, 1, 0, dir)).toBeNull();
  });

  // The DB is not a trusted source for a filesystem path. Even though rows are
  // only written from a directory listing filtered by a strict pattern, a bad
  // row must never be able to read outside the demo directory.
  it('refuses a stored filename that tries to escape the demo dir', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'secret.dem'), Buffer.alloc(10));
    db.prepare('UPDATE match_demos SET filename = ? WHERE match_id = 1 AND ordinal = 0')
      .run('../secret.dem');
    expect(resolveDemoPath(db, 1, 0, join(dir, 'sub'))).toBeNull();
  });

  it('refuses a stored filename containing a path separator', () => {
    db.prepare('UPDATE match_demos SET filename = ? WHERE match_id = 1 AND ordinal = 0')
      .run('sub/evil.dem');
    expect(resolveDemoPath(db, 1, 0, dir)).toBeNull();
  });
});

// ---- route level ----

describe('demo routes', () => {
  const ME = '76561198000000000';
  let app: FastifyInstance;
  let cookies: Record<string, string>;
  let rdir: string;
  let rdb: DB;

  beforeEach(async () => {
    rdir = mkdtempSync(join(tmpdir(), 'pugdemo-route-'));
    rdb = openDb(':memory:');
    app = await buildServer({
      config: loadConfig({ DEMO_DIR: rdir }),
      db: rdb,
      orchestrator: stubOrchestrator(),
      serverExec: async () => {},
    });
    upsertPlayer(rdb, { steamid: ME, name: 'me', avatar: null }, [ME]);
    rdb.prepare("INSERT INTO matches (season_id, state, campaign, token, winner) VALUES (1, 'completed', 'no_mercy', ?, 'a')").run(TOKEN);
    // Every completed match has its maps: completeMatch writes them from the
    // dump, and the detail route lists demos only for those ordinals.
    rdb.prepare("INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (1, 0, 'l4d_vs_hospital01_apartment', 300, 200)").run();
    writeFileSync(join(rdir, `pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`), Buffer.alloc(64, 7));
    recordMatchDemos(rdb, 1, TOKEN, rdir);
    cookies = authedCookie(app, rdb, ME);
  });
  afterEach(async () => { await app.close(); rmSync(rdir, { recursive: true, force: true }); });

  it('lists demo metadata publicly on the match detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/matches/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().demos).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment', bytes: 64 },
    ]);
  });

  it('serves the bytes to an anonymous visitor', async () => {
    // Public by request (2026-09-11) so demos can be shared with people who
    // have no account. See the route comment for the tradeoff.
    const res = await app.inject({ method: 'GET', url: '/api/matches/1/demos/0' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(64);
  });

  it('serves the demo to a logged-in player with download headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/matches/1/demos/0', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe('64');
    // Short, typeable name rather than the 60-char on-disk one: `playdemo`
    // takes the filename and the Source console has no tab completion.
    expect(res.headers['content-disposition']).toContain('pug1-1.dem');
    expect(res.rawPayload.length).toBe(64);
  });

  it('404s for an ordinal that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/matches/1/demos/9', cookies });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the file was pruned out from under the row', async () => {
    rmSync(join(rdir, `pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`));
    const res = await app.inject({ method: 'GET', url: '/api/matches/1/demos/0', cookies });
    expect(res.statusCode).toBe(404);
  });
});

describe('recordMatchDemos: in-progress exclusion', () => {
  it('skips the highest-ordinal demo while a match is live', () => {
    // The newest demo is the one srcds is still writing; tv_record for the
    // next map is what closes it. Offering it would hand over a truncated file.
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    touch(`pug_${TOKEN}_1_l4d_vs_hospital02_subway.dem`, 50);

    expect(recordMatchDemos(db, 1, TOKEN, dir, { excludeInProgress: true })).toBe(1);
    const rows = db.prepare('SELECT ordinal FROM match_demos WHERE match_id = 1').all();
    expect(rows).toEqual([{ ordinal: 0 }]);
  });

  it('records everything once the match is over', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    touch(`pug_${TOKEN}_1_l4d_vs_hospital02_subway.dem`, 50);
    expect(recordMatchDemos(db, 1, TOKEN, dir)).toBe(2);
  });

  it('records nothing when the only demo is the one in progress', () => {
    touch(`pug_${TOKEN}_0_l4d_vs_hospital01_apartment.dem`, 100);
    expect(recordMatchDemos(db, 1, TOKEN, dir, { excludeInProgress: true })).toBe(0);
  });
});
