import { describe, it, expect } from 'vitest';
import { openDb, DEFAULT_SETTINGS } from '../src/db.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { insertBan, liftOneBan, activeBan } from '../src/admin/players.js';
import { subscribeBanChanges } from '../src/banEvents.js';
import { ensureAppealSchema } from '../src/appeals/schema.js';

const P = '76561198000000001';
const insertAppeal = (db: ReturnType<typeof openDb>, banId: number, state: string) =>
  db.prepare(`INSERT INTO appeals (ban_id, steamid, appellant_name, what_happened, why_lift, state, source, created_at)
              VALUES (?, ?, 'p', 'a', 'b', ?, 'site', '2026-10-04T00:00:00.000Z')`).run(banId, P, state);

describe('appeals schema', () => {
  it('allows one open appeal per ban, any number of settled ones', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
    const ban = insertBan(db, P, 'system', 'abandon', 60 * 48);
    insertAppeal(db, ban, 'denied');
    insertAppeal(db, ban, 'open');
    expect(() => insertAppeal(db, ban, 'asked')).toThrow(/UNIQUE/);
    insertAppeal(db, ban, 'moot');
  });

  it('refuses a row about both a ban and a sanction, or neither', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare(`INSERT INTO appeals (appellant_name, discord_id, what_happened, why_lift, state, source, created_at)
      VALUES ('x', '1', 'a', 'b', 'open', 'site', 'now')`).run()).toThrow(/CHECK/);
  });

  it('adds no_appeal to bans and discord_sanctions, and is idempotent', () => {
    const db = openDb(':memory:');
    ensureAppealSchema(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('bans')).toContain('no_appeal');
    expect(cols('discord_sanctions')).toContain('no_appeal');
  });

  it('every appeal setting is seeded and in the Settings schema, off by default', () => {
    const keys = ['appeals_enabled', 'appeal_min_ban_hours', 'appeal_cooldown_days', 'appeal_max_per_ban',
      'appeal_text_max', 'appeal_answer_max', 'appeal_answer_hours'];
    for (const k of keys) {
      expect(DEFAULT_SETTINGS[k], k).toBeDefined();
      expect(SETTINGS_SCHEMA.some((s) => s.key === k), k).toBe(true);
    }
    expect(DEFAULT_SETTINGS.appeals_enabled).toBe('0');
  });
});

describe('liftOneBan', () => {
  it('lifts only the named ban; the player stays banned while another is open', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
    activatePlayer(db, P);
    const a = insertBan(db, P, 'system', 'abandon', 60 * 48);
    const b = insertBan(db, P, 'admin', 'toxic', null);
    const changes: string[] = [];
    const off = subscribeBanChanges((e) => changes.push(e.kind));
    expect(liftOneBan(db, b, 'mod')).toBe(true);
    expect(activeBan(db, P)?.id).toBe(a);
    expect(getPlayer(db, P)?.status).toBe('banned');
    expect(changes).toEqual([]);
    expect(liftOneBan(db, a, 'mod')).toBe(true);
    expect(getPlayer(db, P)?.status).toBe('active');
    expect(changes).toEqual(['unban']);
    expect(liftOneBan(db, a, 'mod')).toBe(false);
    off();
  });
});
