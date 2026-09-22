import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  checkDiscordSanction, recordDiscordSanction, checkLift, recordLift, sanctionsFor, activeDiscordSanction,
  DISCORD_TIMEOUT_MAX_MINUTES,
} from '../src/tickets/discordSanctions.js';

const MOD = '76561199000000701';
const ADMIN = '76561199000000702';
const PLAYER = '76561199000000703';
const LURKER = '990';
let db: DB;
let ticketId: number;
const now = new Date('2026-09-23T12:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MOD, ADMIN, PLAYER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  ticketId = Number(db.prepare("INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES (?, 'Lurky', 'x')").run(LURKER).lastInsertRowid);
});

const ask = (by: string, body: object, id = ticketId) => checkDiscordSanction(db, id, by, body);

describe('checkDiscordSanction', () => {
  it('lets a moderator time out up to the moderator cap', () => {
    expect(ask(MOD, { kind: 'timeout', minutes: 60, reason: ' spam ' })).toEqual({
      ok: true, plan: { ticketId, discordId: LURKER, kind: 'timeout', minutes: 60, reason: 'spam', restricted: false },
    });
    expect(ask(MOD, { kind: 'timeout', minutes: 10081, reason: 'x' })).toMatchObject({ ok: false, status: 403 });
    setSetting(db, 'ticket_mod_ban_max_minutes', '525600');
    // The setting can be higher than Discord allows; Discord's limit still wins.
    expect(ask(MOD, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES + 1, reason: 'x' })).toMatchObject({ ok: false });
    expect(ask(MOD, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES, reason: 'x' })).toMatchObject({ ok: true });
  });

  it('keeps bans for admins, and admins to Discord\'s 28 days for a timeout', () => {
    expect(ask(MOD, { kind: 'ban', reason: 'x' })).toMatchObject({ ok: false, status: 403 });
    expect(ask(ADMIN, { kind: 'ban', minutes: 5, reason: 'x' })).toMatchObject({ ok: true, plan: { kind: 'ban', minutes: null } });
    expect(ask(ADMIN, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES + 1, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a player ticket, a closed ticket, no reason, a bad kind or length', () => {
    const playerTicket = Number(db.prepare("INSERT INTO tickets (target_id, created_at) VALUES (?, 'x')").run(PLAYER).lastInsertRowid);
    expect(ask(ADMIN, { kind: 'ban', reason: 'x' }, playerTicket)).toMatchObject({ ok: false, status: 400 });
    expect(ask(ADMIN, { kind: 'ban', reason: '  ' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(ADMIN, { kind: 'kick', reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(MOD, { kind: 'timeout', minutes: 0, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(MOD, { kind: 'timeout', minutes: 1.5, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(ticketId);
    expect(ask(ADMIN, { kind: 'ban', reason: 'x' })).toMatchObject({ ok: false, status: 409 });
  });

  it('answers 404 for a restricted ticket the actor is not on, as for a missing one', () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect(ask(MOD, { kind: 'timeout', minutes: 5, reason: 'x' })).toEqual({ ok: false, status: 404, error: 'no such ticket' });
    expect(ask(MOD, { kind: 'timeout', minutes: 5, reason: 'x' }, 999)).toEqual({ ok: false, status: 404, error: 'no such ticket' });
  });
});

describe('recording and lifting', () => {
  it('records a timeout with its end, an event, and makes the person unable to report', () => {
    const c = ask(MOD, { kind: 'timeout', minutes: 60, reason: 'spam' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, MOD, now);
    expect(db.prepare('SELECT discord_id, kind, until, ticket_id, created_by FROM discord_sanctions WHERE id = ?').get(id))
      .toEqual({ discord_id: LURKER, kind: 'timeout', until: '2026-09-23T13:00:00.000Z', ticket_id: ticketId, created_by: MOD });
    expect(db.prepare("SELECT kind FROM ticket_events WHERE kind = 'discord_sanction'").get()).toEqual({ kind: 'discord_sanction' });
    expect(activeDiscordSanction(db, LURKER, now)).toMatchObject({ kind: 'timeout' });
    expect(activeDiscordSanction(db, LURKER, new Date('2026-09-23T13:00:01Z'))).toBeNull();
  });

  it('lets only an admin lift an active sanction, once', () => {
    const c = ask(ADMIN, { kind: 'ban', reason: 'x' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, ADMIN, now);
    expect(checkLift(db, id, MOD, now)).toMatchObject({ ok: false, status: 403 });
    const l = checkLift(db, id, ADMIN, now);
    expect(l).toMatchObject({ ok: true, plan: { sanctionId: id, discordId: LURKER, kind: 'ban' } });
    if (!l.ok) throw new Error('lift check failed');
    recordLift(db, l.plan, ADMIN, now);
    expect(checkLift(db, id, ADMIN, now)).toMatchObject({ ok: false, status: 409 });
    expect(checkLift(db, 999, ADMIN, now)).toMatchObject({ ok: false, status: 404 });
    expect(sanctionsFor(db, LURKER, now)).toMatchObject([{ id, kind: 'ban', active: false, liftedBy: ADMIN }]);
  });

  it('an expired timeout cannot be lifted', () => {
    const c = ask(MOD, { kind: 'timeout', minutes: 1, reason: 'x' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, MOD, now);
    expect(checkLift(db, id, ADMIN, new Date('2026-09-23T12:02:00Z'))).toMatchObject({ ok: false, status: 409 });
  });
});
