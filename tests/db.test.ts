import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      'admin_actions',
      'alt_holds',
      'appeal_message', 'appeals',
      'balance_ignored_plugins', 'balance_patch_servers', 'balance_patches', 'balance_rollout_servers', 'balance_rollouts', 'balance_server_state',
      'bans', 'booking_casters', 'booking_events', 'booking_people', 'booking_sides', 'booking_voice', 'bookings', 'campaign_play_rules', 'cast_studios',
      'community_entries', 'community_likes',
      'custom_campaign_chapters', 'custom_campaign_installs', 'custom_campaigns',
      'discord_link_codes', 'discord_link_history', 'discord_messages', 'discord_sanctions', 'discord_voice', 'discord_voice_origin',
      'draft_captain_offers', 'draft_pick_lists', 'draft_picks', 'draft_rooms', 'draft_signups', 'endorsements', 'event_campaign_prefs', 'event_entries', 'event_entry_players', 'event_entry_prefs', 'event_games', 'event_lineups',
      'event_log', 'event_matches', 'event_reschedules', 'event_stages', 'event_vetoes', 'events', 'fleet_files', 'fleet_readings',
      'game_configs',
      'input_bursts', 'input_caps', 'input_detections',
      'integrity_clips', 'integrity_flags', 'integrity_prior', 'integrity_prior_rounds', 'integrity_reviews', 'integrity_rounds',
      'integrity_unanalysable',
      'map_looks',
      'match_abort_notices', 'match_chat', 'match_demos', 'match_gg_votes', 'match_live', 'match_live_events', 'match_live_map_stats', 'match_live_maps',
      'match_live_players', 'match_maps', 'match_name_sightings',
      'match_pauses', 'match_player_stats', 'match_players', 'match_presence',
      'match_readyup_players', 'match_readyups', 'match_replays', 'match_round_marks', 'match_round_stats', 'match_rounds',
      'matches', 'matchmaker_state',
      'mod_calls',
      'notification_prefs',
      'penalties', 'pending_reports', 'player_aliases', 'player_ingame_last', 'player_links', 'player_name_digest', 'player_name_uses', 'player_networks', 'player_notes', 'player_pings', 'player_ratings',
      'player_reviews', 'player_steam_signals', 'players', 'practice_drills', 'practice_leases', 'queue_stints',
      'rating_history', 'relay_messages', 'release_boxes', 'releases', 'report_message', 'reporter_chat_pings', 'reports', 'round_metric_context', 'round_metrics', 'rulesets', 'scrim_accepts', 'scrim_blocks', 'scrim_posts', 'scrim_reviews', 'seasons', 'server_chat', 'servers', 'settings', 'side_games', 'signon_drops',
      'skeet_streak_scans', 'skeet_streaks',
      'sourcetv_server_events', 'sourcetv_sessions', 'steam_signal_alerts',
      'team_invites', 'team_members', 'teams',
      'ticket_access', 'ticket_attachments', 'ticket_events', 'ticket_messages', 'ticket_notices', 'ticket_reports', 'ticket_threads', 'tickets', 'twitch_status',
      'weekly_award_weeks', 'weekly_awards',
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

  it('turns secure_delete on, so a removal actually erases the old bytes', () => {
    const db = openDb(':memory:');
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
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

describe('practice_leases kinds', () => {
  const seed = (db: ReturnType<typeof openDb>) => {
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'me')").run();
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('a', 'h', 27015, 27015, 'x')").run();
  };

  it('a new database takes hunter leases and still refuses unknown kinds', () => {
    const db = openDb(':memory:');
    seed(db);
    expect(() => db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'hunter', '76561199000000001', 'x', 'x')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'nonsense', '76561199000000001', 'x', 'x')`).run()).toThrow(/CHECK/);
  });

  it('an existing park/drill table is widened with its rows and indexes kept', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugdb-')), 'pug.db');
    let db = openDb(path);
    seed(db);
    // Put the table back the way production has it today.
    db.exec(`DROP TABLE practice_leases;
      CREATE TABLE practice_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES servers(id),
        kind TEXT NOT NULL CHECK (kind IN ('park','drill')), owner_player_id TEXT NOT NULL REFERENCES players(steamid),
        password TEXT NOT NULL, drill_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), ready_at TEXT,
        last_human_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT NOT NULL, humans INTEGER NOT NULL DEFAULT 0,
        map TEXT, warned_at TEXT, ending_at TEXT, ended_at TEXT, end_reason TEXT, setup_phase TEXT);
      CREATE INDEX practice_leases_open ON practice_leases (server_id) WHERE ended_at IS NULL;
      CREATE INDEX practice_leases_owner ON practice_leases (owner_player_id, created_at);
      INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at, humans)
        VALUES (1, 'park', '76561199000000001', 'pw1', 'e1', 3), (1, 'drill', '76561199000000001', 'pw2', 'e2', 0);`);
    db.close();
    db = openDb(path);
    expect(db.prepare('SELECT id, kind, password, humans FROM practice_leases ORDER BY id').all()).toEqual([
      { id: 1, kind: 'park', password: 'pw1', humans: 3 },
      { id: 2, kind: 'drill', password: 'pw2', humans: 0 },
    ]);
    db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'hunter', '76561199000000001', 'x', 'x')`).run();
    // AUTOINCREMENT carried on from the old table.
    expect(db.prepare("SELECT id FROM practice_leases WHERE kind = 'hunter'").get()).toEqual({ id: 3 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'practice_leases' ORDER BY name").all())
      .toEqual([{ name: 'practice_leases_open' }, { name: 'practice_leases_owner' }]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('custom campaigns default to not practice-only', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(custom_campaigns)').all() as { name: string; dflt_value: string }[];
    expect(cols.find((c) => c.name === 'practice_only')?.dflt_value).toBe('0');
  });
});
