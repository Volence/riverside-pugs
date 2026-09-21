import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted } from '../src/tickets/actions.js';
import { subscribeBanChanges } from '../src/banEvents.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let ticket: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  ticket = (fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'x' }, deps) as { ticketId: number }).ticketId;
});

const row = (id = ticket) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;
const kinds = (id = ticket) => (db.prepare('SELECT kind FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(id) as { kind: string }[]).map((e) => e.kind);

describe('claim', () => {
  it('claims and releases, and another mod can take it over', () => {
    expect(claimTicket(db, ticket, MOD, true)).toEqual({ ok: true });
    expect(row().claimed_by).toBe(MOD);
    expect(claimTicket(db, ticket, MOD2, true)).toEqual({ ok: true });
    expect(row().claimed_by).toBe(MOD2);
    expect(claimTicket(db, ticket, MOD2, false)).toEqual({ ok: true });
    expect(row().claimed_by).toBeNull();
    expect(kinds()).toEqual(['opened', 'claimed', 'claimed', 'unclaimed']);
  });
});

describe('visibility', () => {
  it('a ticket the actor cannot see is a 404 for every action', () => {
    const about = (fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps) as { ticketId: number }).ticketId;
    for (const who of [MOD, MOD2, ADMIN]) {
      expect(claimTicket(db, about, who, true)).toMatchObject({ ok: false, status: 404 });
      expect(closeTicket(db, about, who, 'no_action', '')).toMatchObject({ ok: false, status: 404 });
    }
    expect(claimTicket(db, about, OWNER, true)).toEqual({ ok: true });
    expect(claimTicket(db, 9999, OWNER, true)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('restrict and access', () => {
  it('restricting by hand seeds the owner and the actor, and hides it from everyone else', () => {
    expect(setRestricted(db, ticket, MOD, true, deps.adminSteamIds)).toEqual({ ok: true });
    expect(row().restricted).toBe(1);
    expect(claimTicket(db, ticket, MOD2, true)).toMatchObject({ status: 404 });
    expect(claimTicket(db, ticket, MOD, true)).toEqual({ ok: true });
    expect(addAccess(db, ticket, MOD, MOD2)).toEqual({ ok: true });
    expect(claimTicket(db, ticket, MOD2, true)).toEqual({ ok: true });
    expect(addAccess(db, ticket, MOD, ACCUSED)).toMatchObject({ ok: false, status: 400 });
    expect(addAccess(db, ticket, MOD, R2)).toMatchObject({ ok: false, status: 400 });
  });

  it('un-restricting is refused while the accused is staff or a report is unsafe', () => {
    const staff = (fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, staff, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
    const unsafe = (fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, unsafe, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a change that would make two open tickets of one flavour', () => {
    const sibling = (fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps) as { ticketId: number }).ticketId;
    expect(sibling).not.toBe(ticket);
    expect(setRestricted(db, ticket, MOD, true, deps.adminSteamIds)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('close and reopen', () => {
  it('closes with an outcome and a note, and reopens', () => {
    expect(closeTicket(db, ticket, MOD, 'maybe', '')).toMatchObject({ ok: false, status: 400 });
    expect(closeTicket(db, ticket, MOD, 'warned', ' told them off ')).toEqual({ ok: true });
    expect(row()).toMatchObject({ status: 'closed', outcome: 'warned', outcome_note: 'told them off', closed_by: MOD });
    expect(closeTicket(db, ticket, MOD, 'warned', '')).toMatchObject({ ok: false, status: 409 });
    expect(reopenTicket(db, ticket, MOD2)).toEqual({ ok: true });
    expect(row()).toMatchObject({ status: 'open', outcome: null, closed_at: null, closed_by: null });
    expect(kinds()).toEqual(['opened', 'closed', 'reopened']);
  });

  it('will not reopen over a newer open ticket', () => {
    closeTicket(db, ticket, MOD, 'no_action', '');
    fileReport(db, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    expect(reopenTicket(db, ticket, MOD)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('ban from a ticket', () => {
  it('a mod bans up to the cap, the ban links to the ticket, and the change is published after commit', () => {
    const seen: unknown[] = [];
    const off = subscribeBanChanges((c) => seen.push(c));
    expect(banFromTicket(db, ticket, MOD, 'walls', null)).toMatchObject({ ok: false, status: 403 });
    expect(banFromTicket(db, ticket, MOD, 'walls', 10081)).toMatchObject({ ok: false, status: 403 });
    expect(banFromTicket(db, ticket, MOD, '', 60)).toMatchObject({ ok: false, status: 400 });
    expect(seen).toEqual([]);
    expect(banFromTicket(db, ticket, MOD, 'walls', 10080)).toEqual({ ok: true });
    off();
    expect(db.prepare('SELECT player_id, reason, created_by, ticket_id FROM bans').get()).toEqual({ player_id: ACCUSED, reason: 'walls', created_by: MOD, ticket_id: ticket });
    expect(getPlayer(db, ACCUSED)?.status).toBe('banned');
    expect(seen).toEqual([{ kind: 'ban', steamid: ACCUSED, reason: 'walls' }]);
    expect(kinds()).toContain('banned');
  });

  it('a moderator cannot ban an admin, even from a ticket they were let into', () => {
    const about = (fileReport(db, R1, { targetId: ADMIN, category: 'toxicity', text: 'x' }, deps) as { ticketId: number }).ticketId;
    expect(addAccess(db, about, OWNER, MOD)).toEqual({ ok: true });
    expect(banFromTicket(db, about, MOD, 'abuse', 60)).toMatchObject({ ok: false, status: 403 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM bans').get()).toEqual({ n: 0 });
    expect(banFromTicket(db, about, OWNER, 'abuse', 60)).toEqual({ ok: true });
  });

  it('an admin bans for any length, permanent included', () => {
    expect(banFromTicket(db, ticket, ADMIN, 'walls', null)).toEqual({ ok: true });
    expect((db.prepare('SELECT expires_at FROM bans').get() as { expires_at: string | null }).expires_at).toBeNull();
  });

  it('refuses on a closed ticket', () => {
    closeTicket(db, ticket, MOD, 'no_action', '');
    expect(banFromTicket(db, ticket, ADMIN, 'walls', 60)).toMatchObject({ ok: false, status: 409 });
  });
});
