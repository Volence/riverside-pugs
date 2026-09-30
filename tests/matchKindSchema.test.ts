import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('match kind schema', () => {
  it('defaults a new match to a public pug with no rules snapshot', () => {
    const db = openDb(':memory:');
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
    expect(db.prepare('SELECT kind, visibility, rules_json, game_config FROM matches WHERE id = ?').get(id))
      .toEqual({ kind: 'pug', visibility: 'public', rules_json: null, game_config: null });
  });

  it('rejects an unknown kind or visibility', () => {
    const db = openDb(':memory:');
    const ins = (kind: string, vis: string) => db.prepare(
      "INSERT INTO matches (season_id, state, campaign, kind, visibility) VALUES (1, 'live', 'c', ?, ?)",
    ).run(kind, vis);
    expect(() => ins('ranked', 'public')).toThrow(/CHECK/);
    expect(() => ins('scrim', 'friends')).toThrow(/CHECK/);
    expect(() => ins('scrim', 'participants')).not.toThrow();
  });

  it('is idempotent on reopen and seeds the standard game config once', () => {
    const db = openDb(':memory:');
    expect(db.prepare('SELECT key, cfg, enabled FROM game_configs').all())
      .toEqual([{ key: 'standard', cfg: 'pug_match', enabled: 1 }]);
  });
});
