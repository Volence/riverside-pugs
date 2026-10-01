import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { settingDef, validateSetting } from '../src/settingsSchema.js';
import { isNotifyType, NOTIFY_TYPES, wants } from '../src/notify/notify.js';

const A = '76561199000001001';
const B = '76561199000001002';

function seedTeamAndPost(db: DB): { teamId: number; postId: number } {
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'b', 'active')").run(B);
  const teamId = Number(db.prepare(
    "INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by) VALUES ('Riverside', 'riverside', 'RS', 'rs', 'riverside', ?, ?)",
  ).run(A, A).lastInsertRowid);
  const postId = Number(db.prepare(
    `INSERT INTO scrim_posts (side_kind, team_id, captain_steamid, starts_at, block_minutes, campaigns_json, created_at)
     VALUES ('team', ?, ?, '2026-10-05T20:00:00.000Z', 120, '["no_mercy"]', '2026-10-01T00:00:00.000Z')`,
  ).run(teamId, A).lastInsertRowid);
  return { teamId, postId };
}

describe('scrim_posts schema', () => {
  it('holds the columns the plan calls for', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(scrim_posts)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'side_kind', 'team_id', 'captain_steamid', 'region', 'starts_at', 'block_minutes',
      'campaigns_json', 'sr_range', 'note', 'status', 'created_at', 'target_team_id', 'booking_id',
    ]));
  });

  it('defaults region to na, status to open and note to empty', () => {
    const db = openDb(':memory:');
    const { postId } = seedTeamAndPost(db);
    const row = db.prepare('SELECT region, status, note, sr_range FROM scrim_posts WHERE id = ?').get(postId) as any;
    expect(row).toEqual({ region: 'na', status: 'open', note: '', sr_range: null });
  });

  it('rejects a side_kind that is not team or pickup', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
    expect(() => db.prepare(
      `INSERT INTO scrim_posts (side_kind, captain_steamid, starts_at, block_minutes, campaigns_json, created_at)
       VALUES ('clan', ?, 'x', 60, '[]', 'x')`,
    ).run(A)).toThrow(/CHECK/);
  });

  it('rejects a status outside the five named states', () => {
    const db = openDb(':memory:');
    const { postId } = seedTeamAndPost(db);
    expect(() => db.prepare("UPDATE scrim_posts SET status = 'cancelled' WHERE id = ?").run(postId)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scrim_posts SET status = 'booked' WHERE id = ?").run(postId)).not.toThrow();
  });

  it('indexes posts by status and start time', () => {
    const db = openDb(':memory:');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scrim_posts'").all() as { name: string }[];
    expect(idx.map((r) => r.name)).toContain('scrim_posts_status_starts');
    const info = db.prepare("PRAGMA index_info(scrim_posts_status_starts)").all() as { name: string }[];
    expect(info.map((r) => r.name)).toEqual(['status', 'starts_at']);
  });
});

describe('scrim_accepts schema', () => {
  it('holds the columns the plan calls for', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(scrim_accepts)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'post_id', 'side_kind', 'team_id', 'captain_steamid', 'campaigns_json', 'status', 'created_at', 'responded_at',
    ]));
  });

  it('defaults campaigns_json to an empty list and status to pending', () => {
    const db = openDb(':memory:');
    const { postId } = seedTeamAndPost(db);
    const acceptId = Number(db.prepare(
      "INSERT INTO scrim_accepts (post_id, side_kind, captain_steamid, created_at) VALUES (?, 'pickup', ?, 'x')",
    ).run(postId, B).lastInsertRowid);
    const row = db.prepare('SELECT campaigns_json, status FROM scrim_accepts WHERE id = ?').get(acceptId) as any;
    expect(row).toEqual({ campaigns_json: '[]', status: 'pending' });
  });

  it('rejects a status outside the five named states', () => {
    const db = openDb(':memory:');
    const { postId } = seedTeamAndPost(db);
    const acceptId = Number(db.prepare(
      "INSERT INTO scrim_accepts (post_id, side_kind, captain_steamid, created_at) VALUES (?, 'pickup', ?, 'x')",
    ).run(postId, B).lastInsertRowid);
    expect(() => db.prepare("UPDATE scrim_accepts SET status = 'accepted' WHERE id = ?").run(acceptId)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scrim_accepts SET status = 'chosen' WHERE id = ?").run(acceptId)).not.toThrow();
  });

  it('indexes accepts by post and status', () => {
    const db = openDb(':memory:');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scrim_accepts'").all() as { name: string }[];
    expect(idx.map((r) => r.name)).toContain('scrim_accepts_post_status');
    const info = db.prepare('PRAGMA index_info(scrim_accepts_post_status)').all() as { name: string }[];
    expect(info.map((r) => r.name)).toEqual(['post_id', 'status']);
  });
});

describe('scrim settings', () => {
  it('seeds discord_scrims_channel_id empty and scrim_accept_campaigns_max at 2', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'discord_scrims_channel_id')).toBe('');
    expect(getSetting(db, 'scrim_accept_campaigns_max')).toBe('2');
  });

  it('discord_scrims_channel_id is a Discord-group string that may be empty', () => {
    const def = settingDef('discord_scrims_channel_id');
    expect(def?.group).toBe('Discord');
    expect(def?.help.length).toBeGreaterThan(0);
    expect(validateSetting('discord_scrims_channel_id', '')).toEqual({ ok: true, value: '' });
    expect(validateSetting('discord_scrims_channel_id', '123456789012345678')).toEqual({ ok: true, value: '123456789012345678' });
  });

  it('scrim_accept_campaigns_max is a Competitive-group int from 0 to 4', () => {
    const def = settingDef('scrim_accept_campaigns_max');
    expect(def?.group).toBe('Competitive');
    expect(def?.help.length).toBeGreaterThan(0);
    expect(validateSetting('scrim_accept_campaigns_max', 0)).toEqual({ ok: true, value: '0' });
    expect(validateSetting('scrim_accept_campaigns_max', 4)).toEqual({ ok: true, value: '4' });
    expect(validateSetting('scrim_accept_campaigns_max', 5).ok).toBe(false);
    expect(validateSetting('scrim_accept_campaigns_max', -1).ok).toBe(false);
  });
});

describe('scrim notify types', () => {
  it('adds the five scrim types with labels, each on by default', () => {
    const db = openDb(':memory:');
    const types: readonly string[] = ['scrim_challenge', 'scrim_accepted', 'scrim_booked', 'scrim_taken', 'scrim_declined'];
    for (const t of types) {
      expect(isNotifyType(t)).toBe(true);
      const def = NOTIFY_TYPES.find((n) => n.type === t);
      expect(def?.label.length).toBeGreaterThan(0);
      expect(wants(db, A, t as any)).toBe(true);
    }
  });

  it('does not recognize an unrelated string as a notify type', () => {
    expect(isNotifyType('scrim_cancelled')).toBe(false);
  });
});
