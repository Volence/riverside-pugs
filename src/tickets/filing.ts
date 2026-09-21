import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import { inGoodStanding } from '../standing.js';
import { addTicketEvent, canSeeTicket, getTicketRow, hasStaffFlag, seedAccess } from './store.js';

export const REPORT_CATEGORIES = ['griefing', 'cheating', 'toxicity', 'afk', 'unsafe', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
const MAX_TEXT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FilingDeps {
  /** config.adminSteamIds: who is let into a restricted ticket first. */
  adminSteamIds: string[];
  now?: Date;
}
export interface FileBody { targetId?: unknown; category?: unknown; text?: unknown; matchId?: unknown; moment?: unknown }
type Fail = { ok: false; status: number; error: string };
export type FileResult = { ok: true; reportId: number; ticketId: number; created: boolean; restricted: boolean } | Fail;

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The open ticket about this player in this flavour, or a new one. Runs
 *  inside the caller's transaction. */
function findOrOpen(
  db: DB, targetId: string, restricted: boolean, openedBy: string | null, deps: FilingDeps,
): { id: number; created: boolean } {
  const now = deps.now ?? new Date();
  const open = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
    .get(targetId, restricted ? 1 : 0) as { id: number } | undefined;
  if (open) return { id: open.id, created: false };
  const id = Number(db.prepare('INSERT INTO tickets (target_id, restricted, opened_by, created_at) VALUES (?, ?, ?, ?)')
    .run(targetId, restricted ? 1 : 0, openedBy, now.toISOString()).lastInsertRowid);
  if (restricted) seedAccess(db, id, targetId, deps.adminSteamIds, [], now);
  addTicketEvent(db, id, openedBy, 'opened', {}, now);
  return { id, created: true };
}

/**
 * File a report. Any active player, about any other player, at any time; a
 * match and a replay moment are optional. The accused is never told.
 */
export function fileReport(db: DB, reporter: string, body: FileBody, deps: FilingDeps): FileResult {
  const now = deps.now ?? new Date();
  // Here rather than in each caller, and through the one predicate every
  // surface shares: active, no ban in force, and not a SteamID that has been
  // merged into another account. The website's guard and the Discord command
  // both check this before they get here, and the day a third surface forgets
  // to, this is what stops a banned player filing reports from it.
  if (!inGoodStanding(db, reporter, now)) return fail(403, 'not an active player');
  if (typeof body.targetId !== 'string' || !body.targetId) return fail(400, 'pick a player');
  if (body.targetId === reporter) return fail(400, 'you cannot report yourself');
  const target = getPlayer(db, body.targetId);
  if (!target) return fail(404, 'no such player');
  if (typeof body.category !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(body.category)) {
    return fail(400, 'pick a category');
  }
  const category = body.category;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_TEXT) return fail(400, `keep it under ${MAX_TEXT} characters`);
  if (body.category === 'unsafe' && !text) return fail(400, 'say what happened, so the right people can look into it');

  let matchId: number | null = null;
  if (body.matchId !== undefined && body.matchId !== null) {
    matchId = Number(body.matchId);
    if (!Number.isInteger(matchId) || !db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return fail(404, 'no such match');
    if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, target.steamid)) {
      return fail(400, 'that player was not in that match');
    }
  }
  let moment: { ordinal: number; half: number; tMs: number } | null = null;
  if (body.moment !== undefined && body.moment !== null) {
    const m = body.moment as { ordinal?: unknown; half?: unknown; tMs?: unknown };
    if (matchId === null || !isCount(m.ordinal) || !isCount(m.half) || !isCount(m.tMs)) return fail(400, 'a replay moment needs a match, a map, a half and a time');
    moment = { ordinal: m.ordinal, half: m.half, tMs: m.tMs };
  }

  const perDay = Number(getSetting(db, 'ticket_reports_per_day') ?? '5');
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = (db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE reporter_id = ? AND created_at > ? AND legacy_report_id IS NULL')
    .get(reporter, since) as { n: number }).n;
  if (recent >= perDay) return fail(429, `you can file ${perDay} reports a day; try again tomorrow`);

  // Which ticket this report would land on, which is also which ticket both
  // duplicate limits are counted against: a safety report belongs to the
  // restricted sibling and is not a duplicate of a normal one, with or
  // without a match. Without this a safety report about a match you had
  // already reported would have to give up its match to get through.
  const restricted = category === 'unsafe' || hasStaffFlag(db, target.steamid);
  const dupe = matchId !== null
    ? db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.reporter_id = ? AND t.target_id = ? AND r.match_id = ? AND t.restricted = ?`)
      .get(reporter, target.steamid, matchId, restricted ? 1 : 0)
    : db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.reporter_id = ? AND t.target_id = ? AND r.match_id IS NULL AND t.status = 'open' AND t.restricted = ?`)
      .get(reporter, target.steamid, restricted ? 1 : 0);
  if (dupe) return fail(409, matchId !== null ? 'you already reported this player for this match' : 'you already have an open report about this player');

  const result = db.transaction((): FileResult => {
    const ticket = findOrOpen(db, target.steamid, restricted, null, deps);
    const reportId = Number(db.prepare(
      `INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, match_id, map_ordinal, half, t_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ticket.id, reporter, category, text, matchId, moment?.ordinal ?? null, moment?.half ?? null, moment?.tMs ?? null, now.toISOString()).lastInsertRowid);
    if (!ticket.created) addTicketEvent(db, ticket.id, null, 'report_attached', { reportId }, now);
    return { ok: true, reportId, ticketId: ticket.id, created: ticket.created, restricted };
  })();
  // After the commit, and only for a ticket the whole team may read.
  if (result.ok && !result.restricted) {
    publishAdminEvent({ kind: 'report', ticketId: result.ticketId, targetId: target.steamid, category, created: result.created });
  }
  return result;
}

/**
 * A ticket opened by staff with no report behind it: something seen in
 * Discord, or told to a moderator in person.
 *
 * Opening by hand grants the opener nothing: the access list is seeded the
 * same way filing seeds it, and a restricted ticket the opener is not on
 * comes back as a null `ticketId`. The answer is then the same whether the
 * ticket was just created or already existed, so this cannot be used to ask
 * whether a player has an open restricted case. The note is still recorded on
 * the ticket, as a player's report is when it attaches to one they cannot see.
 *
 * `auditId` is the real id, for the caller's audit row only. Never answer a
 * request with it.
 */
export function openStaffTicket(
  db: DB, by: string, body: { targetId?: unknown; note?: unknown; restricted?: unknown }, deps: FilingDeps,
): { ok: true; ticketId: number | null; auditId: number } | Fail {
  const now = deps.now ?? new Date();
  if (typeof body.targetId !== 'string' || !getPlayer(db, body.targetId)) return fail(404, 'no such player');
  if (body.targetId === by) return fail(400, 'you cannot open a ticket about yourself');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_TEXT) : '';
  const targetId = body.targetId;
  const restricted = body.restricted === true || hasStaffFlag(db, targetId);
  return db.transaction(() => {
    const ticket = findOrOpen(db, targetId, restricted, by, deps);
    if (note) addTicketEvent(db, ticket.id, by, 'note', { text: note }, now);
    const row = getTicketRow(db, ticket.id)!;
    return { ok: true as const, ticketId: canSeeTicket(db, row, by) ? ticket.id : null, auditId: ticket.id };
  })();
}

export type MatchTargets =
  | { canReport: true; targets: { steamid: string; name: string; alreadyReported: boolean }[] }
  | { canReport: false; reason: string; status: 404 };

/** The report chip on a match page: that match's roster minus the viewer. */
export function matchReportTargets(db: DB, matchId: number, reporter: string): MatchTargets {
  if (!db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return { canReport: false, reason: 'no such match', status: 404 };
  const roster = db.prepare(
    'SELECT mp.player_id AS steamid, p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ? ORDER BY mp.rowid',
  ).all(matchId) as { steamid: string; name: string }[];
  const done = new Set((db.prepare(
    'SELECT t.target_id FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.match_id = ? AND r.reporter_id = ?',
  ).all(matchId, reporter) as { target_id: string }[]).map((r) => r.target_id));
  return { canReport: true, targets: roster.filter((r) => r.steamid !== reporter).map((r) => ({ ...r, alreadyReported: done.has(r.steamid) })) };
}

export interface MyReport { id: number; targetId: string; targetName: string | null; category: string; matchId: number | null; createdAt: string; status: 'open' | 'closed' }

/** What a reporter may know about their own reports: that they exist, and
 *  whether the ticket is still open. Never the outcome, and never a ticket
 *  about themselves: a merge can leave a report filed by what is now the
 *  accused's own account. */
export function myReports(db: DB, reporter: string): MyReport[] {
  return db.prepare(
    `SELECT r.id, t.target_id AS targetId, p.name AS targetName, r.category, r.match_id AS matchId,
            r.created_at AS createdAt, t.status
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE r.reporter_id = ? AND t.target_id != r.reporter_id ORDER BY r.id DESC LIMIT 100`,
  ).all(reporter) as MyReport[];
}
