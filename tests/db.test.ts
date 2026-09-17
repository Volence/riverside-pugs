import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting, setSetting, getJsonSetting } from '../src/settings.js';

describe('openDb', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual([
      'admin_actions', 'bans',
      'discord_link_codes', 'discord_messages', 'discord_voice',
      'match_chat', 'match_demos', 'match_live', 'match_live_events', 'match_live_map_stats', 'match_live_maps',
      'match_live_players', 'match_maps',
      'match_player_stats', 'match_players', 'match_replays', 'match_rounds',
      'matches',
      'player_notes', 'player_ratings', 'players',
      'rating_history', 'seasons', 'servers', 'settings',
    ]);
  });

  it('seeds season 1 and default settings, idempotently', () => {
    const db = openDb(':memory:');
    const seasons = db.prepare('SELECT * FROM seasons').all();
    expect(seasons).toHaveLength(1);
    expect(getSetting(db, 'invite_code')).toBe('change-me');
    expect(getSetting(db, 'ready_seconds')).toBe('120');
    expect(getSetting(db, 'vote_seconds')).toBe('30');
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual([
      'no_mercy', 'death_toll', 'dead_air', 'blood_harvest',
    ]);
  });

  it('settings set/get roundtrip', () => {
    const db = openDb(':memory:');
    setSetting(db, 'invite_code', 'sekrit');
    expect(getSetting(db, 'invite_code')).toBe('sekrit');
  });
});

describe('round schema', () => {
  it('creates match_rounds with a composite key on match, map and half', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(match_rounds)').all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['match_id', 'ordinal', 'half', 'surv_team', 'score', 'reliable', 'started_at', 'ended_at']),
    );
  });

  it('rejects a survivor team that is not a or b', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run();
    expect(() => db.prepare(
      "INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'c')",
    ).run()).toThrow();
  });

  it('adds half and t_ms to match_live_events, defaulting to the -1 sentinel', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(match_live_events)').all() as
      { name: string; dflt_value: string | null }[];
    const half = cols.find((c) => c.name === 'half');
    const tms = cols.find((c) => c.name === 't_ms');
    expect(half?.dflt_value).toBe('-1');
    expect(tms?.dflt_value).toBe('-1');
  });
});
