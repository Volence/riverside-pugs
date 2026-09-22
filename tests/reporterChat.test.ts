import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, closeTicket } from '../src/tickets/actions.js';
import { foldTicket } from '../src/tickets/store.js';
import { insertThread } from '../src/tickets/threads.js';
import {
  CHAT_CLOSED, CHAT_NO_DISCORD, CHAT_REFUSED, PING_GAP_MS, checkChatStaff, checkContactReporter, checkReporterChat,
  isReporterMessage, openReportsOf, queueCloseNotices, reporterDiscordIdOf, reporterLabel, reporterThreadAudience,
  reporterThreadFor, requestPing, takeDuePings, takeNotices,
} from '../src/tickets/reporterChat.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000040${i}`);
const [R1, R2, ACCUSED, UNLINKED, , MOD2, MOD, ADMIN] = IDS;
const deps = { adminSteamIds: [ADMIN] };
const LURKER = { kind: 'discord' as const, discordId: '9990', name: 'Lurky', timedOutUntil: null };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (id !== UNLINKED) linkDiscord(db, id, `94${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const file = (by: string | typeof LURKER, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, deps) as { ok: true; reportId: number; ticketId: number };
const thread = (ticketId: number, ref: { reporterId?: string | null; reporterDiscordId?: string | null }, id = '8100') =>
  insertThread(db, { ticketId, kind: 'reporter', surface: 'private', channelId: 'chan1', threadId: id, reporterId: ref.reporterId ?? null, reporterDiscordId: ref.reporterDiscordId ?? null });

describe('who may open a chat', () => {
  it('the reporter of an open report, player or Discord-only', () => {
    const a = file(R1, ACCUSED);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual({
      ok: true, plan: { ticketId: a.ticketId, reportId: a.reportId, ref: { reporterId: R1, reporterDiscordId: null }, reporterDiscordId: '940', restricted: false, claimedBy: null },
    });
    const b = file(LURKER, ACCUSED, 'toxicity');
    expect(checkReporterChat(db, b.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: null })).toMatchObject({
      ok: true, plan: { ref: { reporterId: null, reporterDiscordId: '9990' }, reporterDiscordId: '9990' },
    });
  });

  it('refuses somebody else\'s report, a missing one and a closed one with the same words', () => {
    const a = file(R1, ACCUSED);
    const closed = { ok: false, status: 404, error: CHAT_CLOSED };
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R2 })).toEqual(closed);
    expect(checkReporterChat(db, 9999, { kind: 'player', steamid: R1 })).toEqual(closed);
    closeTicket(db, a.ticketId, MOD, 'no_action', '', false);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual(closed);
  });

  it('refuses a reporter who is not in good standing, timed out, or with no Discord to chat on', () => {
    const a = file(R1, ACCUSED);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)").run(R1, new Date().toISOString());
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual({ ok: false, status: 403, error: CHAT_REFUSED });
    const b = file(LURKER, ACCUSED, 'toxicity');
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(checkReporterChat(db, b.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: later })).toEqual({ ok: false, status: 403, error: CHAT_REFUSED });
    const c = file(UNLINKED, ACCUSED, 'afk');
    expect(checkReporterChat(db, c.reportId, { kind: 'player', steamid: UNLINKED })).toEqual({ ok: false, status: 400, error: CHAT_NO_DISCORD });
  });

  it('never opens a chat for a reporter who has since become the accused', () => {
    const a = file(R1, ACCUSED);
    db.prepare('UPDATE tickets SET target_id = ? WHERE id = ?').run(R1, a.ticketId);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toMatchObject({ ok: false, error: CHAT_CLOSED });
  });

  it('staff contact: visible, open, a report on this ticket, a reporter reachable on Discord', () => {
    const a = file(R1, ACCUSED);
    const other = file(R2, R1);
    expect(checkContactReporter(db, a.ticketId, a.reportId, MOD)).toMatchObject({ ok: true, plan: { reporterDiscordId: '940' } });
    expect(checkContactReporter(db, a.ticketId, other.reportId, MOD)).toMatchObject({ ok: false, status: 404 });
    expect(checkContactReporter(db, a.ticketId, a.reportId, ACCUSED)).toMatchObject({ ok: false, status: 404 });
    const u = file(UNLINKED, ACCUSED, 'afk');
    expect(checkContactReporter(db, a.ticketId, u.reportId, MOD)).toMatchObject({ ok: false, status: 400 });
    closeTicket(db, a.ticketId, MOD, 'no_action', '', false);
    expect(checkContactReporter(db, a.ticketId, a.reportId, MOD)).toMatchObject({ ok: false, status: 409 });
    expect(checkChatStaff(db, a.ticketId, ACCUSED)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('who may be in a chat', () => {
  it('on a normal ticket: the reporter and every linked, active member of staff but the accused', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
    const a = file(R1, ACCUSED);
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 })).sort()).toEqual(['940', '945', '946', '947']);
  });

  it('on a restricted ticket: the reporter and the access list', () => {
    const a = file(R1, ACCUSED, 'unsafe', 'threats');
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 })).sort()).toEqual(['940', '947']);
    addAccess(db, a.ticketId, ADMIN, MOD);
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 }, '8101')).sort()).toEqual(['940', '946', '947']);
  });

  it('a Discord-only reporter by their own id, and never a reporter who has become the accused', () => {
    const a = file(LURKER, ACCUSED, 'toxicity');
    const th = thread(a.ticketId, { reporterDiscordId: '9990' });
    expect(reporterThreadAudience(db, th)).toContain('9990');
    db.prepare("UPDATE tickets SET target_id = NULL, target_discord_id = '9990' WHERE id = ?").run(a.ticketId);
    expect(reporterThreadAudience(db, th)).not.toContain('9990');
  });

  it('finds a reporter\'s thread by either identity, NULL-safely', () => {
    const a = file(R1, ACCUSED);
    const b = file(LURKER, ACCUSED, 'toxicity');
    const mine = thread(a.ticketId, { reporterId: R1 });
    const theirs = thread(b.ticketId, { reporterDiscordId: '9990' }, '8102');
    expect(reporterThreadFor(db, a.ticketId, { reporterId: R1, reporterDiscordId: null })!.id).toBe(mine.id);
    expect(reporterThreadFor(db, b.ticketId, { reporterId: null, reporterDiscordId: '9990' })!.id).toBe(theirs.id);
    expect(reporterThreadFor(db, a.ticketId, { reporterId: R2, reporterDiscordId: null })).toBeUndefined();
    expect(reporterDiscordIdOf(db, { reporterId: R1, reporterDiscordId: null })).toBe('940');
    expect(reporterLabel(db, b.ticketId, { reporterId: null, reporterDiscordId: '9990' })).toBe('Lurky');
    expect(isReporterMessage(mine, { author_discord_id: '940', author_player_id: R1 })).toBe(true);
    expect(isReporterMessage(mine, { author_discord_id: '946', author_player_id: MOD })).toBe(false);
    expect(isReporterMessage(theirs, { author_discord_id: '9990', author_player_id: null })).toBe(true);
  });
});

describe('pings and notices', () => {
  it('a ping asked for is sent at most once an hour per thread, and one asked inside the hour waits', () => {
    const a = file(R1, ACCUSED);
    thread(a.ticketId, { reporterId: R1 });
    const t0 = new Date('2026-09-23T12:00:00Z');
    requestPing(db, '8100', t0);
    expect(takeDuePings(db, a.ticketId, t0)).toEqual(['8100']);
    expect(takeDuePings(db, a.ticketId, t0)).toEqual([]);
    requestPing(db, '8100', new Date(t0.getTime() + 60_000));
    expect(takeDuePings(db, a.ticketId, new Date(t0.getTime() + 120_000))).toEqual([]);
    expect(takeDuePings(db, a.ticketId, new Date(t0.getTime() + PING_GAP_MS))).toEqual(['8100']);
  });

  it('closing with the tick queues one notice per reporter reachable on Discord, Discord-only ones included', () => {
    const a = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    file(LURKER, ACCUSED, 'toxicity');
    file(UNLINKED, ACCUSED, 'cheating');
    expect(closeTicket(db, a.ticketId, MOD, 'warned', '', true)).toEqual({ ok: true });
    expect(takeNotices(db, a.ticketId).map((n) => n.discord_id).sort()).toEqual(['940', '941', '9990']);
    expect(takeNotices(db, a.ticketId)).toEqual([]);
  });

  it('a Discord-only reporter about a Discord-only accused is still told (the NULL trap)', () => {
    const r = fileReport(db, LURKER, { category: 'toxicity', text: '' }, {
      ...deps, targetDiscord: { discordId: '9991', name: 'Other', bot: false, administrator: false },
    }) as { ticketId: number };
    expect(queueCloseNotices(db, r.ticketId)).toBe(1);
  });

  it('closing without the tick queues nothing; a fold carries notices across', () => {
    const a = file(R1, ACCUSED);
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    expect(takeNotices(db, a.ticketId)).toEqual([]);
    const keep = file(R2, R1).ticketId;
    const gone = file(R2, UNLINKED).ticketId;
    queueCloseNotices(db, gone);
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(takeNotices(db, keep)).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('lists a presser\'s open reports, newest first, never a closed one', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, R2, 'afk');
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    expect(openReportsOf(db, { kind: 'player', steamid: R1 })).toEqual([{ reportId: b.reportId, targetName: 'player1', category: 'afk' }]);
    const c = file(LURKER, ACCUSED, 'toxicity');
    expect(openReportsOf(db, { kind: 'discord', discordId: '9990', timedOutUntil: null })).toEqual([{ reportId: c.reportId, targetName: 'player2', category: 'toxicity' }]);
  });
});
