import { describe, it, expect, beforeEach } from 'vitest';
import type { DB } from '../src/db.js';
import { TEMPLATES } from '../src/rulesets.js';
import {
  createRuleset, readEditableRules, rulesetList, rulesetOptions, setRulesetArchived, updateRuleset, type EditableRules,
} from '../src/rulesetStore.js';
import { ADMIN, eventFixture, must } from './eventFixture.js';
import * as E from '../src/events/events.js';

let db: DB;
let eventId: number;
const idOf = (name: string) => (db.prepare('SELECT id FROM rulesets WHERE name = ?').get(name) as { id: number }).id;
const row = (id: number) => db.prepare('SELECT name, rules_json, template, based_on, created_by, archived_at FROM rulesets WHERE id = ?').get(id) as {
  name: string; rules_json: string; template: number; based_on: number | null; created_by: string | null; archived_at: string | null;
};
const audit = () => db.prepare('SELECT action, target, detail FROM admin_actions ORDER BY id').all() as { action: string; target: string; detail: string }[];
const { rated: _rated, penalties: _penalties, ...cupEditable } = TEMPLATES['Standard Cup'];
const edit = (over: Partial<EditableRules> = {}): EditableRules => ({ ...cupEditable, ...over });
const okOf = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const errOf = (r: { ok: boolean; error?: string }) => (r.ok ? 'ok' : r.error);

beforeEach(() => {
  ({ db, eventId } = eventFixture('announced'));
});

describe('reading the editable rules', () => {
  it('takes every field and turns blank pause limits into no limit', () => {
    expect(okOf(readEditableRules(edit({ pause: { limit: null, seconds: null, mutualUnpause: false, techPauses: 0 } }))).pause)
      .toEqual({ limit: null, seconds: null, mutualUnpause: false, techPauses: 0 });
    expect(okOf(readEditableRules(edit({ pause: { limit: 0, seconds: 30, mutualUnpause: true, techPauses: 5 } }))).pause)
      .toEqual({ limit: 0, seconds: 30, mutualUnpause: true, techPauses: 5 });
  });

  it('refuses each out-of-range or mistyped field with its own reason', () => {
    const p = cupEditable.pause;
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: 11 } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: '3' as never } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, limit: 1.5 } })))).toBe('bad_pause_limit');
    expect(errOf(readEditableRules(edit({ pause: { ...p, seconds: 29 } })))).toBe('bad_pause_seconds');
    expect(errOf(readEditableRules(edit({ pause: { ...p, techPauses: 6 } })))).toBe('bad_tech_pauses');
    expect(errOf(readEditableRules(edit({ noShowGraceMinutes: 4 })))).toBe('bad_grace');
    expect(errOf(readEditableRules(edit({ noShowGraceMinutes: 61 })))).toBe('bad_grace');
    expect(errOf(readEditableRules(edit({ bosses: 'sometimes' as never })))).toBe('bad_choice');
    expect(errOf(readEditableRules(edit({ sideRule: 'loser' as never })))).toBe('bad_choice');
    expect(errOf(readEditableRules(edit({ teamLock: 'yes' as never })))).toBe('bad_rules');
    expect(errOf(readEditableRules(null))).toBe('bad_rules');
    expect(errOf(readEditableRules({ ...edit(), spectate: undefined }))).toBe('bad_rules');
  });

  it('drops lockAfterDamage when a half cannot be restarted at all', () => {
    expect(okOf(readEditableRules(edit({ restartHalf: { allowed: false, lockAfterDamage: true } }))).restartHalf)
      .toEqual({ allowed: false, lockAfterDamage: false });
  });
});

describe('the ruleset list', () => {
  it('lists the templates with their summary, PUG read only, and counts what uses each', () => {
    const list = rulesetList(db);
    expect(list.map((r) => [r.name, r.template, r.readOnly, r.archived, r.basedOn])).toEqual([
      ['PUG', true, true, false, null], ['Standard Cup', true, false, false, null], ['Casual Scrim', true, false, false, null],
    ]);
    expect(list[1].summary).toBe('3 pauses of 120 s · higher seed picks sides · 15 min no-show grace');
    expect(list[1].rules).toEqual(TEMPLATES['Standard Cup']);
    // The fixture's announced event has two stages on Standard Cup: one event.
    expect(list[1].inUse).toEqual({ bookings: 0, events: 1 });
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'standard', '{}', ?, '[]', ?, 'x')`,
    ).run(idOf('Casual Scrim'), ADMIN);
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, state, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'ended', 'p', 't', 'standard', '{}', ?, '[]', ?, 'x')`,
    ).run(idOf('Casual Scrim'), ADMIN);
    expect(rulesetList(db)[2].inUse).toEqual({ bookings: 1, events: 0 });
    must(E.cancelEvent(db, { eventId, by: ADMIN, reason: 'rain' }));
    expect(rulesetList(db)[1].inUse).toEqual({ bookings: 0, events: 0 });
  });
});

describe('creating a ruleset', () => {
  it('copies the chosen ruleset under a new name, unrated and without penalties, and audits it', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: '  League Night  ' }));
    const r = row(id);
    expect(r).toMatchObject({ name: 'League Night', template: 0, based_on: idOf('PUG'), created_by: ADMIN, archived_at: null });
    expect(JSON.parse(r.rules_json)).toEqual({ ...TEMPLATES.PUG, rated: false, penalties: false });
    expect(rulesetList(db).find((x) => x.id === id)!.basedOn).toBe('PUG');
    const [a] = audit();
    expect(a).toMatchObject({ action: 'ruleset_create', target: String(id) });
    expect(JSON.parse(a.detail)).toMatchObject({ copyFrom: { id: idOf('PUG'), name: 'PUG' }, after: { name: 'League Night' } });
  });

  it('refuses a missing source, a bad name and a name taken in any case, writing nothing', () => {
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: 999, name: 'Fine name' }))).toBe('not_found');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: '2', name: 'Fine name' }))).toBe('not_found');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'ab' }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'x'.repeat(41) }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'bad\nname' }))).toBe('bad_name');
    expect(errOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'casual SCRIM' }))).toBe('name_taken');
    expect(db.prepare('SELECT COUNT(*) AS n FROM rulesets').get()).toEqual({ n: 3 });
    expect(audit()).toEqual([]);
  });
});

describe('editing a ruleset', () => {
  it('saves the rules unrated with before and after in the audit row', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('Casual Scrim'), name: 'Late Scrim' }));
    const rules = edit({ noShowGraceMinutes: 30, sideRule: 'coin' });
    okOf(updateRuleset(db, { by: ADMIN, id, name: 'Later Scrim', rules: { ...rules, rated: true, penalties: true } }));
    expect(row(id).name).toBe('Later Scrim');
    expect(JSON.parse(row(id).rules_json)).toEqual({ ...rules, rated: false, penalties: false });
    const last = audit().at(-1)!;
    expect(last.action).toBe('ruleset_update');
    const detail = JSON.parse(last.detail);
    expect(detail.before).toEqual({ name: 'Late Scrim', rules: TEMPLATES['Casual Scrim'] });
    expect(detail.after.name).toBe('Later Scrim');
    expect(detail.after.rules.noShowGraceMinutes).toBe(30);
  });

  it('PUG is read only, a template keeps its name, and a name cannot clash', () => {
    const before = row(idOf('PUG')).rules_json;
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('PUG'), name: 'PUG', rules: edit() }))).toBe('read_only');
    expect(row(idOf('PUG')).rules_json).toBe(before);
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Cup', rules: edit() }))).toBe('template_locked');
    expect(errOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 2 }) }))).toBe('bad_grace');
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'Mine' }));
    expect(errOf(updateRuleset(db, { by: ADMIN, id, name: 'standard cup', rules: edit() }))).toBe('name_taken');
    expect(errOf(updateRuleset(db, { by: ADMIN, id: 999, name: 'Whatever', rules: edit() }))).toBe('not_found');
    expect(audit().map((a) => a.action)).toEqual(['ruleset_create']);
  });

  it('a template may change its rules under its own name', () => {
    okOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 20 }) }));
    expect(JSON.parse(row(idOf('Standard Cup')).rules_json).noShowGraceMinutes).toBe(20);
  });

  it('never touches the copy a published stage or a booking already took', () => {
    const stagesBefore = db.prepare('SELECT id, rules_json FROM event_stages WHERE event_id = ? ORDER BY id').all(eventId);
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'p', 't', 'standard', ?, ?, '[]', ?, 'x')`,
    ).run(JSON.stringify(TEMPLATES['Standard Cup']), idOf('Standard Cup'), ADMIN);
    okOf(updateRuleset(db, { by: ADMIN, id: idOf('Standard Cup'), name: 'Standard Cup', rules: edit({ noShowGraceMinutes: 45 }) }));
    expect(db.prepare('SELECT id, rules_json FROM event_stages WHERE event_id = ? ORDER BY id').all(eventId)).toEqual(stagesBefore);
    expect(JSON.parse((db.prepare('SELECT rules_json FROM bookings').get() as { rules_json: string }).rules_json).noShowGraceMinutes).toBe(15);
  });
});

describe('archiving a ruleset', () => {
  it('hides a copy and brings it back, keeping the first archive time, audited both ways', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('PUG'), name: 'Old Rules' }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true, now: new Date('2026-10-01T12:00:00.000Z') }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true, now: new Date('2026-10-02T12:00:00.000Z') }));
    expect(row(id).archived_at).toBe('2026-10-01T12:00:00.000Z');
    expect(rulesetList(db).at(-1)).toMatchObject({ id, archived: true });
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: false }));
    expect(row(id).archived_at).toBeNull();
    expect(audit().map((a) => a.action)).toEqual(['ruleset_create', 'ruleset_archive', 'ruleset_archive', 'ruleset_unarchive']);
    expect(JSON.parse(audit()[1].detail)).toEqual({ name: 'Old Rules', before: { archivedAt: null }, after: { archivedAt: '2026-10-01T12:00:00.000Z' } });
  });

  it('never archives a template', () => {
    for (const name of ['PUG', 'Standard Cup', 'Casual Scrim']) {
      expect(errOf(setRulesetArchived(db, { by: ADMIN, id: idOf(name), archived: true }))).toBe('template_locked');
    }
    expect(errOf(setRulesetArchived(db, { by: ADMIN, id: 999, archived: true }))).toBe('not_found');
  });
});

describe('picker options', () => {
  it('offers the live rulesets in id order, each with its summary, and leaves archived ones out', () => {
    const { id } = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('Casual Scrim'), name: 'Gone Soon' }));
    okOf(setRulesetArchived(db, { by: ADMIN, id, archived: true }));
    expect(rulesetOptions(db)).toEqual([
      { id: idOf('PUG'), name: 'PUG', summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace' },
      { id: idOf('Standard Cup'), name: 'Standard Cup', summary: '3 pauses of 120 s · higher seed picks sides · 15 min no-show grace' },
      { id: idOf('Casual Scrim'), name: 'Casual Scrim', summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace' },
    ]);
  });
});
