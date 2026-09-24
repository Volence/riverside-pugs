import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { handleModCall, onModCall, FOLD_WINDOW_MS, type ModCallEvent } from '../src/modCalls.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const STRANGER = '76561199999999999';
let db: DB;
let matchId: number;
let serverId: number;

const ev = (over: Partial<ModCallEvent> = {}): ModCallEvent => ({
  kind: 'call', steamid: IDS[0], target: IDS[5], callerTeam: 2, reason: 'cheating',
  matchId, ordinal: 1, half: 1, tMs: 5000, via: 'game', text: 'walls', ...over,
});
const at = (msFromStart: number) => new Date(Date.UTC(2026, 8, 24, 20, 0, 0) + msFromStart);
const call = (over: Partial<ModCallEvent> = {}, ms = 0, sid: number | null = serverId) =>
  handleModCall(db, ev(over), sid, { adminSteamIds: [], now: at(ms) });

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id) => { upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []); activatePlayer(db, id); });
  serverId = Number(db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('Dallas', '1.2.3.4', 27015, 27015, 'x')").run().lastInsertRowid);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
});

describe('handleModCall', () => {
  it('files a ticket for a named player with the match and moment', () => {
    const row = call();
    expect(row.ticket_id).not.toBeNull();
    expect(row.pinged).toBe(1);
    expect(row.post_state).toBe('pending');
    const r = db.prepare('SELECT category, text, match_id, map_ordinal, half, t_ms, source FROM ticket_reports').get();
    expect(r).toEqual({ category: 'cheating', text: 'walls', match_id: matchId, map_ordinal: 1, half: 1, t_ms: 5000, source: 'game' });
  });

  it('maps english to other with a prefix', () => {
    call({ reason: 'english', text: 'only russian' });
    expect(db.prepare('SELECT category, text FROM ticket_reports').get()).toEqual({ category: 'other', text: 'Not speaking English: only russian' });
  });

  it('never files for something broke, and drops its target', () => {
    const row = call({ reason: 'broke', target: IDS[5] });
    expect(row.ticket_id).toBeNull();
    expect(row.target_kind).toBe('none');
    expect(row.target_steamid).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM ticket_reports').get()).toEqual({ n: 0 });
  });

  it('files without the match when the target is not on the roster', () => {
    upsertPlayer(db, { steamid: STRANGER, name: 'spec', avatar: null }, []); activatePlayer(db, STRANGER);
    const row = call({ target: STRANGER });
    expect(row.ticket_id).not.toBeNull();
    expect(db.prepare('SELECT match_id, t_ms FROM ticket_reports').get()).toEqual({ match_id: null, t_ms: null });
  });

  it('stores and posts a call from someone with no account, without a ticket', () => {
    const row = call({ steamid: STRANGER });
    expect(row.ticket_id).toBeNull();
    expect(row.note).toBe('No ticket: caller has no account');
    expect(row.post_state).toBe('pending');
  });

  it('records why fileReport refused', () => {
    call();
    const again = call({}, FOLD_WINDOW_MS + 1000);
    expect(again.ticket_id).toBeNull();
    expect(again.note).toMatch(/^No ticket: you already reported this player for this match/);
  });

  it('skips a banned caller entirely', () => {
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'admin', ?)").run(IDS[0], at(-1000).toISOString());
    const row = call();
    expect(row.post_state).toBe('skipped');
    expect(row.ticket_id).toBeNull();
    expect(row.note).toBe('Caller is banned');
  });

  it('folds a second call about the same player on the same server', () => {
    const first = call();
    const second = call({ steamid: IDS[1] }, 60_000);
    expect(second.folded_into).toBe(first.id);
    expect(second.post_state).toBe('folded');
    expect(second.pinged).toBe(0);
    expect(second.ticket_id).toBe(first.ticket_id);
  });

  it('folds targetless calls together but not across servers or after the window', () => {
    const first = call({ target: 'team', reason: 'toxicity' });
    expect(call({ target: 'general', steamid: IDS[1] }, 1000).folded_into).toBe(first.id);
    const other = Number(db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('Chicago', '5.6.7.8', 27015, 27015, 'x')").run().lastInsertRowid);
    expect(call({ target: 'team', steamid: IDS[2] }, 2000, other).folded_into).toBeNull();
    expect(call({ target: 'team', steamid: IDS[3] }, FOLD_WINDOW_MS + 5000).folded_into).toBeNull();
  });

  it('does not fold into a handled call', () => {
    const first = call({ target: 'team' });
    db.prepare("UPDATE mod_calls SET handled_at = ?, handled_by_discord_id = '1' WHERE id = ?").run(at(1).toISOString(), first.id);
    expect(call({ target: 'team', steamid: IDS[1] }, 1000).folded_into).toBeNull();
  });

  it('stops pinging a caller after five calls in an hour', () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => call({ target: 'general', reason: 'other' }, i * (FOLD_WINDOW_MS + 1000)));
    expect(rows.slice(0, 5).every((r) => r.pinged === 1)).toBe(true);
    expect(rows[5].pinged).toBe(0);
    expect(rows[5].note).toContain('Not pinged: rate cap');
  });

  it('stores but does not post when calls are turned off', () => {
    setSetting(db, 'mod_calls_enabled', '0');
    expect(call().post_state).toBe('skipped');
  });

  it('tells listeners after the row exists', () => {
    const seen: number[] = [];
    const off = onModCall((id) => { seen.push(id); expect(db.prepare('SELECT 1 FROM mod_calls WHERE id = ?').get(id)).toBeTruthy(); });
    const row = call();
    off();
    expect(seen).toEqual([row.id]);
  });
});
