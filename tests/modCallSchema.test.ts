import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { foldTicket } from '../src/tickets/store.js';
import { validateSetting } from '../src/settingsSchema.js';

const A = '76561199000000001';
const B = '76561199000000002';
const C = '76561199000000003';

describe('mod call storage', () => {
  it('creates mod_calls and seeds the two settings', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(mod_calls)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'created_at', 'server_id', 'match_id', 'map', 'map_ordinal', 'half', 't_ms',
      'caller_steamid', 'caller_team', 'target_kind', 'target_steamid', 'reason', 'text', 'via',
      'ticket_id', 'folded_into', 'pinged', 'post_state', 'note', 'discord_message_id',
      'handled_by_discord_id', 'handled_at',
    ]));
    expect(getSetting(db, 'mod_call_role_id')).toBe('');
    expect(getSetting(db, 'mod_calls_enabled')).toBe('1');
  });

  it('records the source of a report filed from the game', () => {
    const db = openDb(':memory:');
    for (const id of [A, B]) { upsertPlayer(db, { steamid: id, name: id, avatar: null }, []); activatePlayer(db, id); }
    const r = fileReport(db, A, { targetId: B, category: 'cheating', text: 'x' }, { adminSteamIds: [], source: 'game' });
    expect(r.ok).toBe(true);
    expect((db.prepare('SELECT source FROM ticket_reports').get() as { source: string }).source).toBe('game');
    const r2 = fileReport(db, B, { targetId: A, category: 'afk', text: '' }, { adminSteamIds: [] });
    expect(r2.ok).toBe(true);
    expect((db.prepare('SELECT source FROM ticket_reports WHERE reporter_id = ?').get(B) as { source: string | null }).source).toBeNull();
  });

  it('moves both steamid columns in a merge', () => {
    const db = openDb(':memory:');
    for (const id of [A, B, C]) { upsertPlayer(db, { steamid: id, name: id, avatar: null }, []); activatePlayer(db, id); }
    db.prepare(`INSERT INTO mod_calls (created_at, caller_steamid, target_kind, target_steamid, reason, text, via, pinged, post_state)
                VALUES (?, ?, 'player', ?, 'cheating', '', 'game', 1, 'pending')`).run(new Date().toISOString(), A, B);
    mergePlayers(db, { from: A, into: C });
    const row = db.prepare('SELECT caller_steamid, target_steamid FROM mod_calls').get() as { caller_steamid: string; target_steamid: string };
    expect(row.caller_steamid).toBe(C);
    expect(row.target_steamid).toBe(B);
  });

  it('follows a folded ticket onto the kept one', () => {
    const db = openDb(':memory:');
    for (const id of [A, B, C]) { upsertPlayer(db, { steamid: id, name: id, avatar: null }, []); activatePlayer(db, id); }
    const keep = fileReport(db, A, { targetId: B, category: 'cheating', text: '' }, { adminSteamIds: [] });
    const gone = fileReport(db, A, { targetId: C, category: 'cheating', text: '' }, { adminSteamIds: [] });
    if (!keep.ok || !gone.ok) throw new Error('filing failed');
    db.prepare(`INSERT INTO mod_calls (created_at, caller_steamid, target_kind, target_steamid, reason, text, via, pinged, post_state, ticket_id)
                VALUES (?, ?, 'player', ?, 'cheating', '', 'game', 1, 'posted', ?)`).run(new Date().toISOString(), A, C, gone.ticketId);
    db.transaction(() => foldTicket(db, gone.ticketId, keep.ticketId, 'merge'))();
    expect((db.prepare('SELECT ticket_id FROM mod_calls').get() as { ticket_id: number }).ticket_id).toBe(keep.ticketId);
  });

  it('accepts only an empty or snowflake-shaped mod call role', () => {
    expect(validateSetting('mod_call_role_id', '')).toEqual({ ok: true, value: '' });
    expect(validateSetting('mod_call_role_id', ' 1551114695010816040 ')).toEqual({ ok: true, value: '1551114695010816040' });
    for (const bad of ['everyone', '<@&1551114695010816040>', '123', '1'.repeat(21), '15511146950108160x0']) {
      expect(validateSetting('mod_call_role_id', bad).ok).toBe(false);
    }
  });
});
