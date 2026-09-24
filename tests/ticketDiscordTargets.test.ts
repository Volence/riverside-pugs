import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { listTickets, ticketCounts, ticketDetail } from '../src/tickets/views.js';
import { canSeeTicket, getTicketRow } from '../src/tickets/store.js';
import { myReports } from '../src/tickets/filing.js';
import { banFromTicket } from '../src/tickets/actions.js';
import { privateThreadAudience, forbiddenForumThreads } from '../src/tickets/threads.js';
import { ticketCard } from '../src/discord/ticketCard.js';

const MOD = '76561199000000401';
const REP = '76561199000000402';
const LURKER = '900000000000000001';
let db: DB;
let ticketId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MOD, REP]) {
    upsertPlayer(db, { steamid: id, name: id === MOD ? 'mod' : 'rep', avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare("UPDATE players SET is_mod = 1, discord_id = '800' WHERE steamid = ?").run(MOD);
  ticketId = Number(db.prepare(
    "INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES (?, 'Lurky', '2026-09-22T00:00:00Z')",
  ).run(LURKER).lastInsertRowid);
  db.prepare(
    "INSERT INTO ticket_reports (ticket_id, reporter_id, category, created_at) VALUES (?, ?, 'toxicity', '2026-09-22T00:00:00Z')",
  ).run(ticketId, REP);
  db.prepare(
    "INSERT INTO ticket_reports (ticket_id, reporter_discord_id, reporter_name, category, created_at) VALUES (?, '901', 'Other lurker', 'toxicity', '2026-09-22T00:00:01Z')",
  ).run(ticketId);
});

describe('the summary\'s target name is never shadowed by the raw stored column', () => {
  it('resolves through the joined player, even when the ticket\'s own target_name column disagrees', () => {
    // SUMMARY selects t.* (which includes the raw target_name column) beside
    // a COALESCE aliased as display_target_name; before the fix both were
    // named target_name and only worked because the COALESCE happened to be
    // listed last. A deliberately wrong stored value here proves the live
    // player's name wins regardless of column order, not by accident of it.
    const tid = Number(db.prepare(
      "INSERT INTO tickets (target_id, target_name, created_at) VALUES (?, 'Stale Name', '2026-09-22T00:00:00Z')",
    ).run(MOD).lastInsertRowid);
    const t = listTickets(db, REP, 'open').find((x) => x.id === tid)!;
    expect(t.targetName).toBe('mod');
  });
});

describe('a ticket about a Discord-only person', () => {
  it('is visible to staff in the list, the counts and the detail', () => {
    const [t] = listTickets(db, MOD, 'open');
    expect(t).toMatchObject({ id: ticketId, targetId: null, targetDiscordId: LURKER, targetName: 'Lurky', reports: 2, reporters: 2 });
    expect(ticketCounts(db, MOD).open).toBe(1);
    expect(canSeeTicket(db, getTicketRow(db, ticketId)!, MOD)).toBe(true);
    const d = ticketDetail(db, ticketId, MOD)!;
    expect(d.reports.map((r) => [r.reporterId, r.reporterDiscordId, r.reporterName])).toEqual([
      [REP, null, 'rep'], [null, '901', 'Other lurker'],
    ]);
  });

  it('shows on the reporter\'s own list', () => {
    expect(myReports(db, REP)).toMatchObject([{ targetId: null, targetDiscordId: LURKER, targetName: 'Lurky', status: 'open' }]);
  });

  it('a restricted one still lets its access list in, and offers staff to add', () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, MOD);
    expect(listTickets(db, MOD, 'open')).toHaveLength(1);
    expect(privateThreadAudience(db, ticketId).map((m) => m.steamid)).toEqual([MOD]);
  });

  it('a forum thread about it is forbidden only once the ticket is restricted', () => {
    db.prepare("INSERT INTO ticket_threads (ticket_id, kind, channel_id, thread_id, created_at, surface) VALUES (?, 'staff', 'f', 'th1', 'x', 'forum')").run(ticketId);
    expect(forbiddenForumThreads(db)).toHaveLength(0);
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect(forbiddenForumThreads(db)).toHaveLength(1);
  });

  it('cannot be server-banned from, since there is no player', () => {
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(MOD);
    expect(banFromTicket(db, ticketId, MOD, 'spam', 60)).toMatchObject({ ok: false, status: 400 });
  });

  it('the staff card names them without a profile link', () => {
    const card = ticketCard(db, ticketId, 'https://x')!;
    const fields = card.payload.embeds[0].fields!;
    const accused = fields.find((f) => f.name === 'Accused')!.value;
    expect(accused).toContain('Lurky');
    expect(accused).not.toContain('/player/');
    expect(fields.find((f) => f.name === 'Reports')!.value).toContain('2 from 2');
  });

  it('carries the Discord sanctions on this member, with active computed for the viewer', () => {
    db.prepare(
      `INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at)
       VALUES (?, 'timeout', '2099-01-01T00:00:00Z', 'spam', ?, ?, '2026-09-22T00:00:00Z')`,
    ).run(LURKER, ticketId, MOD);
    const d = ticketDetail(db, ticketId, MOD)!;
    expect(d.discordSanctions).toMatchObject([
      { kind: 'timeout', reason: 'spam', ticketId, createdBy: MOD, createdByName: 'mod', active: true },
    ]);
  });

  it('blanks the reason, the ticket id and the issuer of a sanction tied to a restricted ticket the viewer is not on', () => {
    const MOD2 = '76561199000000404';
    upsertPlayer(db, { steamid: MOD2, name: 'mod2', avatar: null }, []);
    activatePlayer(db, MOD2);
    db.prepare("UPDATE players SET is_mod = 1 WHERE steamid = ?").run(MOD2);
    const restrictedTicketId = Number(db.prepare(
      "INSERT INTO tickets (target_discord_id, target_name, restricted, status, created_at) VALUES (?, 'Lurky', 1, 'closed', '2026-09-22T00:00:00Z')",
    ).run(LURKER).lastInsertRowid);
    // Also lifted, by MOD, so the test proves liftedBy is really blanked
    // rather than merely already null.
    db.prepare(
      `INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at, lifted_by, lifted_at)
       VALUES (?, 'ban', NULL, 'secret staff-only reason', ?, ?, '2026-09-22T00:00:00Z', ?, '2026-09-22T01:00:00Z')`,
    ).run(LURKER, restrictedTicketId, MOD, MOD);
    // MOD2 opens the original, visible ticket about the same Discord member;
    // sanctionsFor still hands back the row from the restricted ticket, so
    // the detail must redact it rather than drop it.
    const d = ticketDetail(db, ticketId, MOD2)!;
    const redacted = d.discordSanctions.find((s) => s.kind === 'ban')!;
    expect(redacted).toBeTruthy();
    expect(redacted.ticketId).toBeNull();
    expect(redacted.reason).not.toBe('secret staff-only reason');
    expect(redacted.reason).not.toBe('');
    expect(redacted.createdBy).toBe('');
    expect(redacted.createdByName).toBeNull();
    expect(redacted.liftedBy).toBeNull();
  });
});
