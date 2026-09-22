import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB, DEFAULT_SETTINGS } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('report button schema', () => {
  it('creates the pending_reports and report_message tables', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_reports', 'report_message')",
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['pending_reports', 'report_message']);
  });

  it('holds report_message to a single row', () => {
    const ins = db.prepare(
      "INSERT INTO report_message (id, channel_id, message_id, hash, updated_at) VALUES (?, 'c1', 'm1', 'h', '2026-09-22T00:00:00.000Z')",
    );
    ins.run(1);
    expect(() => ins.run(2)).toThrow();
  });

  it('defaults the report channel setting to empty', () => {
    expect(getSetting(db, 'discord_report_channel_id')).toBe('');
  });

  it('keeps a pending report only for a real player', () => {
    expect(() => db.prepare(
      "INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES ('76561199000000099', 'griefing', '', 'bob', '[]', '2026-09-22T00:00:00.000Z')",
    ).run()).toThrow();
  });
});

describe('settings parity', () => {
  it('gives every default a schema entry and every schema entry a default', () => {
    const defaults = Object.keys(DEFAULT_SETTINGS).sort();
    const schema = SETTINGS_SCHEMA.map((s) => s.key).sort();
    expect(defaults).toEqual(schema);
  });
});

import { COMMAND_DEFS, REPORT_LABELS } from '../src/discord/commands.js';

describe('details wording', () => {
  const report = () => COMMAND_DEFS.find((c) => c.name === 'report')!;
  const details = () => report().options!.find((o) => o.name === 'details')!;

  it('does not lead with the map', () => {
    expect(details().description.toLowerCase()).not.toContain('map');
  });

  it('asks for what happened, in the reporter\'s own words', () => {
    expect(details().description).toBe('What happened, in your own words');
  });

  it('stays inside Discord\'s 100 character limit', () => {
    expect(details().description.length).toBeLessThanOrEqual(100);
  });

  it('exports the category labels so the form can share them', () => {
    expect(REPORT_LABELS.unsafe).toBe('Safety concern (handled privately)');
  });
});
