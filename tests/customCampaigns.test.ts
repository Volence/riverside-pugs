import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  insertDraft, getCampaign, listCampaigns, chaptersOf, publishCampaign,
  deleteCampaign, installsOf, setInstall,
} from '../src/customCampaigns.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const draft = (slug = 'dbd') =>
  insertDraft(db, {
    slug, name: 'Dead Before Dawn', vpkFilename: `${slug}.vpk`,
    sizeBytes: 1234, sha256: 'a'.repeat(64), uploadedBy: '76561198000000001',
  }, [
    { map: 'dbd1_alley', display: 'Alley', isFinale: false },
    { map: 'dbd2_mall', display: 'Mall', isFinale: false },
    { map: 'dbd3_roof', display: 'Roof', isFinale: true },
  ]);

describe('custom campaign store', () => {
  it('stores a draft with its chapters in file order', () => {
    draft();
    const c = getCampaign(db, 'dbd')!;
    expect(c.state).toBe('draft');
    expect(c.enabled).toBe(0);
    expect(chaptersOf(db, 'dbd').map((ch) => ch.map))
      .toEqual(['dbd1_alley', 'dbd2_mall', 'dbd3_roof']);
  });

  // Every chapter starts included and in file order, so a campaign that is
  // never touched on the confirm screen still plays exactly as it shipped.
  it('defaults every chapter to included, in file order', () => {
    draft();
    for (const ch of chaptersOf(db, 'dbd')) {
      expect(ch.included).toBe(1);
      expect(ch.play_order).toBe(ch.ordinal);
    }
  });

  it('marks the last chapter as the finale', () => {
    draft();
    expect(chaptersOf(db, 'dbd').map((c) => c.is_finale)).toEqual([0, 0, 1]);
  });

  // The real case: L4D1 mission files rarely mark which chapter is the finale,
  // so most uploads arrive with isFinale: false on every chapter. The fallback
  // ensures the last chapter is still marked as the finale. This test catches
  // refactors that would drop the fallback logic.
  it('marks the last chapter as the finale even when caller passes false for all', () => {
    insertDraft(db, {
      slug: 'cc', name: 'Custom Campaign', vpkFilename: 'cc.vpk',
      sizeBytes: 5000, sha256: 'b'.repeat(64), uploadedBy: '76561198000000002',
    }, [
      { map: 'cc1_start', display: 'Start', isFinale: false },
      { map: 'cc2_mid', display: 'Middle', isFinale: false },
      { map: 'cc3_end', display: 'End', isFinale: false },
    ]);
    expect(chaptersOf(db, 'cc').map((c) => c.is_finale)).toEqual([0, 0, 1]);
  });

  // A draft is half-uploaded and must never reach the pool or the public page.
  it('lists only published campaigns when asked', () => {
    draft('dbd');
    draft('other');
    publishCampaign(db, 'dbd', 'Dead Before Dawn');
    expect(listCampaigns(db, { state: 'published' }).map((c) => c.slug)).toEqual(['dbd']);
  });

  it('records install state per server', () => {
    draft();
    // Create test servers to satisfy the foreign key constraint
    db.prepare('INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES (?, ?, ?, ?, ?)')
      .run('server1', 'localhost', 27015, 27015, 'pass');
    db.prepare('INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES (?, ?, ?, ?, ?)')
      .run('server2', 'localhost', 27016, 27016, 'pass');
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'b'.repeat(64) });
    setInstall(db, 'dbd', 2, 'failed', { error: 'connection refused' });
    const rows = installsOf(db, 'dbd');
    expect(rows.find((r) => r.server_id === 1)!.state).toBe('installed');
    expect(rows.find((r) => r.server_id === 2)!.error).toBe('connection refused');
  });

  // setInstall is called on every retry, so it must update rather than throw.
  it('overwrites an install row on retry', () => {
    draft();
    // Create test server to satisfy the foreign key constraint
    db.prepare('INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES (?, ?, ?, ?, ?)')
      .run('server1', 'localhost', 27015, 27015, 'pass');
    setInstall(db, 'dbd', 1, 'failed', { error: 'timeout' });
    setInstall(db, 'dbd', 1, 'installed', { sha256: 'c'.repeat(64), error: null });
    const row = installsOf(db, 'dbd')[0];
    expect(row.state).toBe('installed');
    expect(row.error).toBeNull();
  });

  it('deletes chapters and installs along with the campaign', () => {
    draft();
    // Create test server to satisfy the foreign key constraint
    db.prepare('INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES (?, ?, ?, ?, ?)')
      .run('server1', 'localhost', 27015, 27015, 'pass');
    setInstall(db, 'dbd', 1, 'installed');
    deleteCampaign(db, 'dbd');
    expect(getCampaign(db, 'dbd')).toBeUndefined();
    expect(chaptersOf(db, 'dbd')).toEqual([]);
    expect(installsOf(db, 'dbd')).toEqual([]);
  });
});
