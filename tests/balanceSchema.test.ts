import { describe, expect, it } from 'vitest';
import { openDb, ORIGIN_BACKFILL_SQL } from '../src/db.js';

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('balance schema', () => {
  it('creates the tables and columns', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'balance_patches')).toEqual(expect.arrayContaining(
      ['id', 'fingerprint', 'name', 'notes', 'source', 'inputs_json', 'first_seen_at', 'reviewed']));
    expect(cols(db, 'balance_patch_servers')).toEqual(expect.arrayContaining(
      ['patch_id', 'server_id', 'first_seen_at', 'last_seen_at']));
    expect(cols(db, 'balance_server_state')).toEqual(expect.arrayContaining(
      ['server_id', 'patch_id', 'inventory_json', 'since']));
    expect(cols(db, 'match_round_stats')).toEqual(expect.arrayContaining(
      ['match_id', 'ordinal', 'half', 'player_id', 'stat', 'value']));
    expect(cols(db, 'match_round_marks')).toEqual(expect.arrayContaining(
      ['match_id', 'ordinal', 'half', 'kind', 't_ms']));
    expect(cols(db, 'match_rounds')).toEqual(expect.arrayContaining(['patch_id', 'variant', 'skill_detect']));
    expect(cols(db, 'matches')).toContain('origin');
  });

  it('indexes match_rounds by patch_id', () => {
    const db = openDb(':memory:');
    const indexes = (db.prepare('PRAGMA index_list(match_rounds)').all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('match_rounds_patch');
  });

  it('backfills origin from the roster source', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561198000000001', 'a')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x'), (2, 1, 'completed', 'x')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (1, '76561198000000001', 'a', 'web'), (2, '76561198000000001', 'a', 'udp')").run();
    db.prepare('UPDATE matches SET origin = NULL').run();
    // Re-running the backfill statement is what openDb does on the next boot.
    db.prepare(ORIGIN_BACKFILL_SQL).run();
    const rows = db.prepare('SELECT id, origin FROM matches ORDER BY id').all();
    expect(rows).toEqual([{ id: 1, origin: 'queue' }, { id: 2, origin: 'in_game' }]);
  });

  it('creates the rollout tables with a state check', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', '2026-09-24 00:00:00')").run();
    db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'x', 'a', 'now')").run();
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, 1, 'pending')").run();
    expect(() => db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, 2, 'nope')").run()).toThrow();
  });
});
