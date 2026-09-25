import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { handleModCall, onModCall, onModCallHandled, markModCallHandled, getModCall, FOLD_WINDOW_MS, type ModCallEvent } from '../src/modCalls.js';
import { addAlias } from '../src/aliases.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const STRANGER = '76561199999999999';
let db: DB;
let matchId: number;
let serverId: number;

const ev = (over: Partial<ModCallEvent> = {}): ModCallEvent => ({
  kind: 'call', steamid: IDS[0], target: IDS[5], callerTeam: 2, reason: 'cheating', map: null,
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
    expect(call({ target: 'general', reason: 'toxicity', steamid: IDS[1] }, 1000).folded_into).toBe(first.id);
    const other = Number(db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('Chicago', '5.6.7.8', 27015, 27015, 'x')").run().lastInsertRowid);
    expect(call({ target: 'team', reason: 'toxicity', steamid: IDS[2] }, 2000, other).folded_into).toBeNull();
    expect(call({ target: 'team', reason: 'toxicity', steamid: IDS[3] }, FOLD_WINDOW_MS + 5000).folded_into).toBeNull();
  });

  it('does not fold a targetless call into an earlier targetless call with a different reason', () => {
    call({ target: 'general', reason: 'english' });
    expect(call({ target: 'none', reason: 'broke', steamid: IDS[1] }, 1000).folded_into).toBeNull();
  });

  it('folds two targetless calls with the same reason', () => {
    const first = call({ target: 'none', reason: 'broke' });
    const second = call({ target: 'none', reason: 'broke', steamid: IDS[1] }, 1000);
    expect(second.folded_into).toBe(first.id);
    expect(second.post_state).toBe('folded');
  });

  it('folds a call about a named player into an earlier call about that player even with a different reason', () => {
    const first = call({ reason: 'cheating' });
    const second = call({ reason: 'griefing', steamid: IDS[1] }, 1000);
    expect(second.folded_into).toBe(first.id);
    expect(second.post_state).toBe('folded');
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

describe('markModCallHandled', () => {
  const MOD = IDS[7];
  const by = { steamid: MOD, discordId: '907' };

  it('marks an open parent handled by the given player and Discord id, and signals it', () => {
    const row = call();
    const seen: number[] = [];
    const off = onModCallHandled((id) => { seen.push(id); });
    expect(markModCallHandled(db, row.id, by, at(1000))).toEqual({ ok: true });
    off();
    expect(seen).toEqual([row.id]);
    const after = getModCall(db, row.id)!;
    expect(after.handled_by_steamid).toBe(MOD);
    expect(after.handled_by_discord_id).toBe('907');
    expect(after.handled_at).toBe(at(1000).toISOString());
  });

  it('stores a null Discord id for a handler with none linked', () => {
    const row = call();
    expect(markModCallHandled(db, row.id, { steamid: MOD, discordId: null })).toEqual({ ok: true });
    expect(getModCall(db, row.id)!.handled_by_discord_id).toBeNull();
  });

  it('refuses a call that does not exist', () => {
    expect(markModCallHandled(db, 9999, by)).toEqual({ ok: false, why: 'no_call' });
  });

  it('refuses a call already handled, and keeps the first handler', () => {
    const row = call();
    expect(markModCallHandled(db, row.id, by).ok).toBe(true);
    const seen: number[] = [];
    const off = onModCallHandled((id) => { seen.push(id); });
    expect(markModCallHandled(db, row.id, { steamid: IDS[6], discordId: '906' })).toEqual({ ok: false, why: 'already' });
    off();
    expect(seen).toEqual([]);
    expect(getModCall(db, row.id)!.handled_by_steamid).toBe(MOD);
  });

  it('refuses a folded call: the parent is the one to handle', () => {
    const first = call();
    const child = call({ steamid: IDS[1] }, 1000);
    expect(child.folded_into).toBe(first.id);
    expect(markModCallHandled(db, child.id, by)).toEqual({ ok: false, why: 'folded' });
    expect(getModCall(db, child.id)!.handled_at).toBeNull();
  });

  it('refuses the player the call is about, through an alias on either side', () => {
    const ALT = '76561199888888888';
    const row = call({ target: MOD });
    expect(markModCallHandled(db, row.id, by)).toEqual({ ok: false, why: 'about_you' });
    // The handler signs in on an alt folded into the target's account.
    addAlias(db, { steamid: ALT, canonical: MOD, by: 'test' });
    expect(markModCallHandled(db, row.id, { steamid: ALT, discordId: null })).toEqual({ ok: false, why: 'about_you' });
    // The call names the alt; the handler is the canonical account.
    db.prepare('UPDATE mod_calls SET target_steamid = ? WHERE id = ?').run(ALT, row.id);
    expect(markModCallHandled(db, row.id, by)).toEqual({ ok: false, why: 'about_you' });
    expect(getModCall(db, row.id)!.handled_at).toBeNull();
  });

  it('answers about_you before already, so the subject learns nothing about its state', () => {
    const row = call({ target: MOD });
    expect(markModCallHandled(db, row.id, { steamid: IDS[6], discordId: null }).ok).toBe(true);
    expect(markModCallHandled(db, row.id, by)).toEqual({ ok: false, why: 'about_you' });
  });

  it('the update itself is guarded, so a handle that lands between the read and the write loses', () => {
    const row = call();
    // Another handler wins after this one's checks have read the row: the
    // competing write runs just before this call's own UPDATE is prepared.
    const racing = new Proxy(db, {
      get(target, prop, recv) {
        if (prop !== 'prepare') return Reflect.get(target, prop, recv);
        return (sql: string) => {
          if (/^\s*UPDATE mod_calls SET handled/.test(sql)) {
            target.prepare('UPDATE mod_calls SET handled_at = ?, handled_by_steamid = ? WHERE id = ?').run('x', IDS[6], row.id);
          }
          return target.prepare(sql);
        };
      },
    });
    expect(markModCallHandled(racing, row.id, by)).toEqual({ ok: false, why: 'already' });
    expect(getModCall(db, row.id)!.handled_by_steamid).toBe(IDS[6]);
  });
});
