import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../src/db.js';
import { createGameConfig, deleteGameConfig, gameConfigList, updateGameConfig } from '../src/gameConfigStore.js';
import { ADMIN, eventFixture, must } from './eventFixture.js';
import * as E from '../src/events/events.js';

let db: DB;
let eventId: number;
let s1: number;
const errOf = (r: { ok: boolean; error?: string }) => (r.ok ? 'ok' : r.error);
const done = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); };
const audit = () => db.prepare('SELECT action, target, detail FROM admin_actions ORDER BY id').all() as { action: string; target: string; detail: string }[];
const configs = () => db.prepare('SELECT key, label, cfg, enabled FROM game_configs ORDER BY key').all();

beforeEach(() => {
  ({ db, eventId, s1 } = eventFixture('draft'));
});

describe('game configs', () => {
  it('adds a config, enabled, with the cfg setup will exec, and audits it', () => {
    expect(errOf(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }))).toBe('ok');
    expect(configs()).toEqual([
      { key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: 1 },
      { key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: 1 },
    ]);
    expect(audit()).toEqual([{ action: 'game_config_create', target: 'zonemod', detail: JSON.stringify({ after: { label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true } }) }]);
  });

  it('refuses a key, label or cfg outside the rules, and a key that exists', () => {
    const add = (over: Record<string, unknown>) => errOf(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', ...over }));
    expect(add({ key: 'z' })).toBe('bad_key');
    expect(add({ key: 'ZoneMod' })).toBe('bad_key');
    expect(add({ key: 'zone-mod' })).toBe('bad_key');
    expect(add({ key: 'z'.repeat(33) })).toBe('bad_key');
    expect(add({ label: 'zm' })).toBe('bad_label');
    expect(add({ label: 'x'.repeat(61) })).toBe('bad_label');
    expect(add({ cfg: 'zonemod.cfg' })).toBe('bad_cfg');
    expect(add({ cfg: 'pug_match; quit' })).toBe('bad_cfg');
    expect(add({ cfg: '../server' })).toBe('bad_cfg');
    expect(add({ cfg: '' })).toBe('bad_cfg');
    expect(add({ key: 'standard' })).toBe('key_taken');
    expect(configs()).toHaveLength(1);
    expect(audit()).toEqual([]);
  });

  it('renames and turns a config off and on, with before and after; standard stays on', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }));
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod (test)', enabled: false }))).toBe('ok');
    expect(db.prepare("SELECT label, enabled FROM game_configs WHERE key = 'zonemod'").get()).toEqual({ label: 'ZoneMod (test)', enabled: 0 });
    expect(JSON.parse(audit()[1].detail)).toEqual({
      before: { label: 'ZoneMod 4v4', cfg: 'zonemod_4v4', enabled: true }, after: { label: 'ZoneMod (test)', cfg: 'zonemod_4v4', enabled: false },
    });
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard', enabled: false }))).toBe('standard_locked');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard', enabled: 'no' }))).toBe('bad_enabled');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'standard', label: 'Standard Rotoblin', enabled: true }))).toBe('ok');
    expect(errOf(updateGameConfig(db, { by: ADMIN, key: 'nope', label: 'Whatever', enabled: true }))).toBe('not_found');
  });

  it('deletes an unused config but never standard or one an open booking or unfinished event uses', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'zonemod', label: 'ZoneMod 4v4', cfg: 'zonemod_4v4' }));
    done(createGameConfig(db, { by: ADMIN, key: 'spare', label: 'Spare config', cfg: 'spare' }));
    db.prepare("UPDATE event_stages SET game_config = 'zonemod' WHERE id = ?").run(s1);
    expect(gameConfigList(db).find((c) => c.key === 'zonemod')!.inUse).toEqual({ bookings: 0, events: 1 });
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'zonemod' }))).toBe('in_use');
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'standard' }))).toBe('standard_locked');
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'nope' }))).toBe('not_found');
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'spare', '{}', '[]', ?, 'x')`,
    ).run(ADMIN);
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'spare' }))).toBe('in_use');
    db.prepare("UPDATE bookings SET state = 'ended'").run();
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'spare' }))).toBe('ok');
    must(E.deleteDraftEvent(db, { eventId, by: ADMIN }));
    expect(errOf(deleteGameConfig(db, { by: ADMIN, key: 'zonemod' }))).toBe('ok');
    expect(configs()).toEqual([{ key: 'standard', label: 'Standard (Rotoblin PUG 4v4)', cfg: 'pug_match', enabled: 1 }]);
    expect(audit().slice(-2).map((a) => [a.action, a.target])).toEqual([['game_config_delete', 'spare'], ['game_config_delete', 'zonemod']]);
  });

  it('lists standard first and says it is locked', () => {
    done(createGameConfig(db, { by: ADMIN, key: 'alpha', label: 'Alpha config', cfg: 'alpha' }));
    expect(gameConfigList(db).map((c) => [c.key, c.locked, c.enabled])).toEqual([['standard', true, true], ['alpha', false, true]]);
  });
});
