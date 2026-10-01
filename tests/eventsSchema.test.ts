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
});
