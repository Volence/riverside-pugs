import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';

const A = '76561199000000701';
let db: DB;
let cup: number;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: A, name: 'boss', avatar: null }, []);
  cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
});

const event = (over: Record<string, unknown> = {}) => {
  const row = {
    slug: 'cup', name: 'Cup', organizer_steamid: A, entry_kind: 'team', starts_at: '2026-10-10T20:00:00.000Z',
    eligibility_json: '{}', checkin_json: '{}', roster_json: '{}', created_at: 'x', updated_at: 'x', ...over,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid);
};
const stage = (eventId: number, ordinal: number, type = 'swiss') => db.prepare(
  `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, created_at, updated_at)
   VALUES (?, ?, ?, '{}', ?, '[]', 'ban_to_one', 'rolling', 'x', 'x')`,
).run(eventId, ordinal, type, cup);

describe('event schema', () => {
  it('an event starts as an official draft in region na and refuses an unknown status or entry kind', () => {
    const id = event();
    expect(db.prepare('SELECT status, official, region, description, banner_key FROM events WHERE id = ?').get(id))
      .toEqual({ status: 'draft', official: 1, region: 'na', description: '', banner_key: null });
    expect(() => db.prepare("UPDATE events SET status = 'paused' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => event({ slug: 'other', entry_kind: 'solo' })).toThrow(/CHECK/);
  });

  it('holds every status and stage type the later plans need, so no CHECK has to widen', () => {
    const id = event();
    for (const s of ['announced', 'registration', 'checkin', 'live', 'finished', 'cancelled']) {
      db.prepare('UPDATE events SET status = ? WHERE id = ?').run(s, id);
    }
    ['single_elim', 'double_elim', 'round_robin', 'swiss', 'league'].forEach((t, i) => stage(id, i + 1, t));
    expect(() => stage(id, 9, 'ladder')).toThrow(/CHECK/);
  });

  it('slugs are unique over every event, and one ordinal per stage per event', () => {
    const id = event();
    expect(() => event()).toThrow(/UNIQUE/);
    stage(id, 1);
    expect(() => stage(id, 1)).toThrow(/UNIQUE/);
    stage(event({ slug: 'cup-2' }), 1);
  });

  it('one live place per player per entry, and a removed place can be taken again', () => {
    const id = event();
    const entry = Number(db.prepare("INSERT INTO event_entries (event_id, name, registered_by, created_at) VALUES (?, 'Rats', ?, 'x')")
      .run(id, A).lastInsertRowid);
    expect(db.prepare('SELECT status, tag, seed FROM event_entries WHERE id = ?').get(entry)).toEqual({ status: 'registered', tag: '', seed: null });
    const add = db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', 'x')");
    add.run(entry, A);
    expect(() => add.run(entry, A)).toThrow(/UNIQUE/);
    db.prepare("UPDATE event_entry_players SET removed_at = 'y' WHERE entry_id = ?").run(entry);
    add.run(entry, A);
  });

  it('event_log rows carry an action and default their detail to {}', () => {
    const id = event();
    db.prepare("INSERT INTO event_log (event_id, at, actor, action) VALUES (?, 'x', NULL, 'created')").run(id);
    expect(db.prepare('SELECT actor, action, detail FROM event_log WHERE event_id = ?').get(id))
      .toEqual({ actor: null, action: 'created', detail: '{}' });
  });

  it('has event_matches with every match-flow status and the stage bracket columns (plan T2)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    // The T2 columns, in order; plan T3a adds the room columns after them.
    expect(cols('event_matches').slice(0, 22)).toEqual([
      'id', 'event_id', 'stage_id', 'grp', 'round', 'slot', 'bm_match_id', 'entry_a', 'entry_b', 'status', 'best_of',
      'not_before', 'scheduled_at', 'window_start', 'window_end', 'booking_id', 'winner_entry', 'score_a', 'score_b',
      'result_source', 'created_at', 'finished_at',
    ]);
    expect(cols('event_stages')).toEqual(expect.arrayContaining(['entrants_json', 'bracket_json', 'bracket_rev', 'started_at', 'finished_at']));
    expect(cols('events')).toContain('live_at');
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'event_matches'").get() as { sql: string }).sql;
    for (const s of ['pending', 'waiting', 'veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'done', 'forfeit', 'bye', 'admin_hold']) {
      expect(sql).toContain(`'${s}'`);
    }
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_matches'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['event_matches_slot', 'event_matches_bm']));
  });
});

describe('T1b columns', () => {
  it('adds the lock, check-in and drop columns', () => {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('events')).toContain('locked_at');
    expect(cols('event_entries')).toEqual(expect.arrayContaining(['checked_in_at', 'checked_in_by', 'dropped_at', 'drop_reason', 'additions']));
  });

  it('allows one active entry per team per event, and another once the first is dropped', () => {
    const id = event();
    db.prepare("INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, created_at) VALUES ('Rats', 'rats', 'RAT', 'RAT', 'rats', ?, ?, '2026-10-01')").run(A, A);
    const team = (db.prepare("SELECT id FROM teams WHERE slug = 'rats'").get() as { id: number }).id;
    const add = () => db.prepare("INSERT INTO event_entries (event_id, team_id, name, registered_by, created_at) VALUES (?, ?, 'Rats', ?, '2026-10-01')").run(id, team, A);
    add();
    expect(add).toThrow(/UNIQUE/);
    db.prepare("UPDATE event_entries SET status = 'dropped' WHERE event_id = ?").run(id);
    expect(add).not.toThrow();
  });

  it('has the match room tables and columns (plan T3a)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('event_matches')).toEqual(expect.arrayContaining(['room_opened_at', 'room_higher', 'room_seed', 'ready_a_at', 'ready_b_at', 'deadline', 'hold_reason']));
    expect(cols('event_vetoes')).toEqual(['id', 'event_match_id', 'step', 'side', 'entry_id', 'action', 'campaign', 'by_steamid', 'auto', 'at']);
    expect(cols('event_games')).toEqual(['id', 'event_match_id', 'ordinal', 'campaign', 'picked_by', 'side_by', 'first_survivors', 'match_id', 'tiebreak_of', 'created_at',
      // plan T3b's columns follow
      'score_a', 'score_b', 'forfeit_side', 'winner', 'map', 'ended_at']);
    expect(cols('event_lineups')).toEqual(['id', 'event_match_id', 'game', 'entry_id', 'steamids', 'locked_by', 'auto', 'locked_at']);
    expect(cols('event_entry_prefs')).toEqual(['entry_id', 'default_four', 'side', 'updated_by', 'updated_at']);
    expect(cols('event_campaign_prefs')).toEqual(['entry_id', 'stage_id', 'campaigns', 'updated_by', 'updated_at']);
    const setting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string }).value;
    expect([setting('event_ready_minutes'), setting('event_veto_step_seconds'), setting('event_lineup_minutes')]).toEqual(['10', '60', '5']);
  });

  it('has the series columns and the confirm window setting (plan T3b)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('event_matches')).toEqual(expect.arrayContaining(['booked_at', 'server_alerted_at', 'confirm_a_at', 'confirm_b_at', 'dispute_side', 'dispute_by', 'dispute_reason', 'disputed_at']));
    expect(cols('event_games')).toEqual(expect.arrayContaining(['score_a', 'score_b', 'forfeit_side', 'winner', 'map', 'ended_at']));
    expect(cols('bookings')).toContain('next_map');
    expect(cols('booking_sides')).toContain('present_now');
    expect((db.prepare("SELECT value FROM settings WHERE key = 'event_confirm_minutes'").get() as { value: string }).value).toBe('15');
  });
});
