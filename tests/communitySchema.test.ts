import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';

const columns = (db: DB, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('community schema', () => {
  it('creates community_entries with the spec columns', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'community_entries')).toEqual([
      'id', 'kind', 'author_id', 'title', 'description', 'payload', 'preset', 'aspect', 'advanced',
      'import_id', 'import_name', 'preview', 'bytes', 'created_at', 'deleted_at', 'deleted_by',
      'delete_reason', 'purged_at', 'preview_infected',
    ]);
  });

  it('adds preview_infected to a table made before it, keeping the rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'community-schema-'));
    try {
      const path = join(dir, 'pug.db');
      const first = openDb(path);
      first.exec('DROP INDEX IF EXISTS idx_community_preview_infected');
      first.exec('ALTER TABLE community_entries DROP COLUMN preview_infected');
      first.prepare("INSERT INTO players (steamid, name) VALUES ('76561198000000001', 'a')").run();
      first.prepare(
        `INSERT INTO community_entries (kind, author_id, title, payload, preview, created_at)
         VALUES ('hud', '76561198000000001', 'Old', '{}', ?, '2026-09-24T00:00:00.000Z')`,
      ).run('a'.repeat(64));
      expect(columns(first, 'community_entries')).not.toContain('preview_infected');
      first.close();
      const db = openDb(path);
      expect(columns(db, 'community_entries')).toContain('preview_infected');
      expect(db.prepare('SELECT preview, preview_infected FROM community_entries').get())
        .toEqual({ preview: 'a'.repeat(64), preview_infected: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates community_likes keyed on entry and player', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'community_likes')).toEqual(['entry_id', 'player_id', 'created_at']);
    const pk = (db.prepare('PRAGMA table_info(community_likes)').all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(['entry_id', 'player_id']);
  });

  it('gives ticket_reports a community_entry_id column', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'ticket_reports')).toContain('community_entry_id');
  });

  it('opens the same file twice without complaint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'community-schema-'));
    try {
      const path = join(dir, 'pug.db');
      openDb(path).close();
      const db = openDb(path);
      expect(columns(db, 'community_entries')).toContain('purged_at');
      expect(columns(db, 'ticket_reports').filter((c) => c === 'community_entry_id')).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('community settings', () => {
  it('seeds the five defaults', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'community_uploads')).toBe('1');
    expect(getSetting(db, 'community_huds_per_player')).toBe('2');
    expect(getSetting(db, 'community_crosshairs_per_player')).toBe('2');
    expect(getSetting(db, 'community_shares_per_day')).toBe('6');
    expect(getSetting(db, 'community_store_mb')).toBe('1024');
  });

  it('validates each at its bounds', () => {
    expect(validateSetting('community_uploads', '0')).toEqual({ ok: true, value: '0' });
    expect(validateSetting('community_uploads', 'maybe').ok).toBe(false);
    for (const key of ['community_huds_per_player', 'community_crosshairs_per_player']) {
      expect(validateSetting(key, '0')).toEqual({ ok: true, value: '0' });
      expect(validateSetting(key, '5')).toEqual({ ok: true, value: '5' });
      expect(validateSetting(key, '-1').ok).toBe(false);
      expect(validateSetting(key, '6').ok).toBe(false);
    }
    expect(validateSetting('community_shares_per_day', '1')).toEqual({ ok: true, value: '1' });
    expect(validateSetting('community_shares_per_day', '50')).toEqual({ ok: true, value: '50' });
    expect(validateSetting('community_shares_per_day', '0').ok).toBe(false);
    expect(validateSetting('community_shares_per_day', '51').ok).toBe(false);
    expect(validateSetting('community_store_mb', '100')).toEqual({ ok: true, value: '100' });
    expect(validateSetting('community_store_mb', '20000')).toEqual({ ok: true, value: '20000' });
    expect(validateSetting('community_store_mb', '99').ok).toBe(false);
    expect(validateSetting('community_store_mb', '20001').ok).toBe(false);
  });
});
