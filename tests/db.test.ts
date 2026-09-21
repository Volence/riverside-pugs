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
      'admin_actions', 'bans', 'campaign_play_rules',
      'custom_campaign_chapters', 'custom_campaign_installs', 'custom_campaigns',
      'discord_link_codes', 'discord_link_history', 'discord_messages', 'discord_voice', 'discord_voice_origin',
      'endorsements',
      'input_bursts', 'input_caps', 'input_detections',
      'integrity_clips', 'integrity_flags', 'integrity_prior', 'integrity_prior_rounds', 'integrity_reviews', 'integrity_rounds',
      'integrity_unanalysable',
      'match_chat', 'match_demos', 'match_live', 'match_live_events', 'match_live_map_stats', 'match_live_maps',
      'match_live_players', 'match_maps',
      'match_pauses', 'match_player_stats', 'match_players', 'match_readyup_players', 'match_readyups', 'match_replays', 'match_rounds',
      'matches', 'matchmaker_state',
      'penalties', 'player_aliases', 'player_links', 'player_networks', 'player_notes', 'player_ratings',
      'player_steam_signals', 'players',
      'rating_history', 'reports', 'seasons', 'servers', 'settings', 'signon_drops', 'steam_signal_alerts',
      'ticket_access', 'ticket_events', 'ticket_reports', 'tickets', 'twitch_status',
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

  it('gives servers a has_dlc4 column defaulting to 0', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(servers)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('has_dlc4');
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

describe('social profile schema', () => {
  it('players carries the profile and twitch columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(players)').all() as { name: string }[])
      .map((c) => c.name);
    for (const c of ['bio', 'pronouns', 'country', 'twitch_id', 'twitch_name']) {
      expect(cols).toContain(c);
    }
  });

  it('one twitch channel cannot be claimed by two players', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('2', 'b')").run();
    db.prepare("UPDATE players SET twitch_id = '999' WHERE steamid = '1'").run();
    expect(() => db.prepare("UPDATE players SET twitch_id = '999' WHERE steamid = '2'").run())
      .toThrow();
  });

  it('unlinked players do not collide on a null twitch_id', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('2', 'b')").run();
    const n = db.prepare('SELECT COUNT(*) AS n FROM players WHERE twitch_id IS NULL')
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('player_links is one row per player per platform', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    const ins = db.prepare('INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)');
    ins.run('1', 'x', 'alice');
    expect(() => ins.run('1', 'x', 'bob')).toThrow();
    ins.run('1', 'youtube', 'alice');
    const n = db.prepare('SELECT COUNT(*) AS n FROM player_links').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('twitch_status is one row per player', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('1', 'a')").run();
    const ins = db.prepare(
      'INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?,?,?)',
    );
    ins.run('1', 1, '2026-09-20T00:00:00Z');
    expect(() => ins.run('1', 0, '2026-09-20T00:01:00Z')).toThrow();
  });

  it('seeds the social settings', () => {
    const db = openDb(':memory:');
    const get = (k: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    expect(get('chemistry_min_games')).toBe('5');
    expect(get('endorse_budget')).toBe('2');
    expect(get('endorse_window_hours')).toBe('24');
    expect(get('endorse_title_min')).toBe('5');
    expect(get('endorse_title_min_games')).toBe('10');
  });
});
