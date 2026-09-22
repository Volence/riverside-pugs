import type { DB } from '../db.js';
import { hasActiveBan } from '../banState.js';
import { getPlayer, playerByDiscordId } from '../players.js';
import { getSetting } from '../settings.js';
import { inGoodStanding } from '../standing.js';
import { addTicketEvent, canSeeTicket, getTicketRow, hasStaffFlag, seedAccess } from './store.js';
import { activeDiscordSanction } from './discordSanctions.js';
import { type Person, personKey, TARGET_KEY_SQL, REPORTER_KEY_SQL } from './person.js';
import { publishTicketSignal } from './signals.js';

export const REPORT_CATEGORIES = ['griefing', 'cheating', 'toxicity', 'afk', 'unsafe', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const MAX_TEXT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The match two players most recently shared, for a report that was not
 * given one explicitly. Restricted to matches that actually happened
 * ('live', 'completed', 'aborted', never 'configuring', whose lobby filled
 * but never reached a server) and to the last 48 hours: that is nearly
 * always what a same-night report is about, and reaching further back
 * guesses wrong more often than it helps.
 *
 * Both '/report' and the report button call this so the two surfaces cannot
 * drift. That matters beyond cosmetics: whichever match a report lands with
 * is also what fileReport's duplicate rule keys on, so a difference here
 * would silently make one surface stricter or looser than the other about
 * reporting the same player twice.
 */
export function latestSharedMatch(db: DB, a: string, b: string): number | null {
  const shared = db.prepare(
    `SELECT m.id FROM matches m
     JOIN match_players x ON x.match_id = m.id AND x.player_id = ?
     JOIN match_players y ON y.match_id = m.id AND y.player_id = ?
     WHERE m.state IN ('live', 'completed', 'aborted')
       AND (m.ended_at IS NULL OR m.ended_at > datetime('now', '-48 hours'))
     ORDER BY m.id DESC LIMIT 1`,
  ).get(a, b) as { id: number } | undefined;
  return shared?.id ?? null;
}

export interface FilingDeps {
  /** config.adminSteamIds: who is let into a restricted ticket first. */
  adminSteamIds: string[];
  now?: Date;
  /** A member picked in a Discord surface, with the facts Discord supplied
   *  about them. Only a Discord surface sets this, per call, never from a
   *  request body: the body is untrusted, and `bot`/`administrator` decide
   *  whether the report is even allowed and whether it is restricted. */
  targetDiscord?: PickedTarget;
}

/** How often a Discord-only reporter may file: tighter than the per-day
 *  limit, because they have not gone through Steam auth at all. */
export const DISCORD_REPORT_GAP_MS = 10 * 60_000;

export interface DiscordReporter { kind: 'discord'; discordId: string; name: string; timedOutUntil: string | null }
/** A member picked in Discord, with the facts Discord supplied about them. */
export interface PickedTarget { discordId: string; name: string; bot: boolean; administrator: boolean }
export interface FileBody { targetId?: unknown; category?: unknown; text?: unknown; matchId?: unknown; moment?: unknown }
type Fail = { ok: false; status: number; error: string };
export type FileResult = { ok: true; reportId: number; ticketId: number; created: boolean; restricted: boolean } | Fail;

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The open ticket about this player in this flavour, or a new one. Runs
 *  inside the caller's transaction. */
function findOrOpen(
  db: DB, target: Person, restricted: boolean, openedBy: string | null, deps: FilingDeps,
): { id: number; created: boolean } {
  const now = deps.now ?? new Date();
  const key = personKey(target);
  // The same expression as tickets_one_open, so SQLite uses that index.
  const open = db.prepare(`SELECT id FROM tickets t WHERE ${TARGET_KEY_SQL} = ? AND restricted = ? AND status = 'open'`)
    .get(key, restricted ? 1 : 0) as { id: number } | undefined;
  if (open) return { id: open.id, created: false };
  const id = Number(db.prepare(
    'INSERT INTO tickets (target_id, target_discord_id, target_name, restricted, opened_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    target.kind === 'player' ? target.steamid : null,
    target.kind === 'discord' ? target.discordId : null,
    target.kind === 'discord' ? target.name.slice(0, 100) : '',
    restricted ? 1 : 0, openedBy, now.toISOString(),
  ).lastInsertRowid);
  if (restricted) seedAccess(db, id, key, deps.adminSteamIds, [], now);
  addTicketEvent(db, id, openedBy, 'opened', {}, now);
  return { id, created: true };
}

type Reporter = { kind: 'player'; steamid: string } | DiscordReporter;

/** A Discord account that has linked Steam is that player, always: the
 *  surfaces pass what Discord gave them, and this is the one place that
 *  decides. */
function asReporter(db: DB, r: string | DiscordReporter): Reporter {
  if (typeof r === 'string') return { kind: 'player', steamid: r };
  const linked = playerByDiscordId(db, r.discordId);
  return linked ? { kind: 'player', steamid: linked.steamid } : r;
}

/**
 * File a report. Any active player or Discord member in good standing, about
 * any other player or Discord member, at any time; a match and a replay
 * moment are optional, and only ever between two players. The accused is
 * never told.
 */
export function fileReport(db: DB, reporterIn: string | DiscordReporter, body: FileBody, deps: FilingDeps): FileResult {
  const now = deps.now ?? new Date();
  const reporter = asReporter(db, reporterIn);
  if (reporter.kind === 'player') {
    // Here rather than in each caller, and through the one predicate every
    // surface shares: active, no ban in force, and not a SteamID that has been
    // merged into another account. The website's guard and the Discord command
    // both check this before they get here, and the day a third surface forgets
    // to, this is what stops a banned player filing reports from it.
    if (!inGoodStanding(db, reporter.steamid, now)) return fail(403, 'not an active player');
  } else {
    // The Discord-side equivalent of inGoodStanding: timed out in Discord
    // right now, or under a sanction the bot carried out (phase 3c).
    const timedOut = reporter.timedOutUntil !== null && Date.parse(reporter.timedOutUntil) > now.getTime();
    if (timedOut || activeDiscordSanction(db, reporter.discordId, now)) return fail(403, 'you cannot file reports right now');
    // A Discord-only reporter has no player row of their own, which is
    // exactly the gap a banned player can walk through: unlink (or never
    // link at all before the ban), then file through Discord with nothing
    // above to catch it. linkDiscord already refuses the opposite direction
    // (a banned account's Discord cannot attach to a new one) by checking
    // discord_link_history for this Discord id's most recent owner; the same
    // lookup, the same rule, applied here.
    const lastOwner = db.prepare(
      'SELECT steamid FROM discord_link_history WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
    ).get(reporter.discordId) as { steamid: string } | undefined;
    if (lastOwner && hasActiveBan(db, lastOwner.steamid, now)) return fail(403, 'you cannot file reports right now');
  }

  let target: Person;
  if (typeof body.targetId === 'string' && body.targetId) {
    const p = getPlayer(db, body.targetId);
    if (!p) return fail(404, 'no such player');
    target = { kind: 'player', steamid: p.steamid };
  } else if (deps.targetDiscord) {
    const d = deps.targetDiscord;
    if (d.bot) return fail(400, 'you cannot report a bot');
    const linked = playerByDiscordId(db, d.discordId);
    target = linked ? { kind: 'player', steamid: linked.steamid } : { kind: 'discord', discordId: d.discordId, name: d.name };
  } else {
    return fail(400, 'pick a player');
  }

  const reporterKey = reporter.kind === 'player' ? reporter.steamid : `d:${reporter.discordId}`;
  const selfByDiscord = reporter.kind === 'player' && target.kind === 'discord'
    && getPlayer(db, reporter.steamid)?.discord_id === target.discordId;
  if (reporterKey === personKey(target) || selfByDiscord) return fail(400, 'you cannot report yourself');

  if (typeof body.category !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(body.category)) {
    return fail(400, 'pick a category');
  }
  const category = body.category;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_TEXT) return fail(400, `keep it under ${MAX_TEXT} characters`);
  if (body.category === 'unsafe' && !text) return fail(400, 'say what happened, so the right people can look into it');

  const bothPlayers = reporter.kind === 'player' && target.kind === 'player';
  if (!bothPlayers && ((body.matchId !== undefined && body.matchId !== null) || (body.moment !== undefined && body.moment !== null))) {
    return fail(400, 'a match can only be attached between two players');
  }
  let matchId: number | null = null;
  if (body.matchId !== undefined && body.matchId !== null) {
    matchId = Number(body.matchId);
    if (!Number.isInteger(matchId) || !db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return fail(404, 'no such match');
    if (target.kind === 'player' && !db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, target.steamid)) {
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
  const recent = (db.prepare(`SELECT COUNT(*) AS n FROM ticket_reports r WHERE ${REPORTER_KEY_SQL} = ? AND created_at > ? AND legacy_report_id IS NULL`)
    .get(reporterKey, since) as { n: number }).n;
  if (recent >= perDay) return fail(429, `you can file ${perDay} reports a day; try again tomorrow`);
  if (reporter.kind === 'discord') {
    const gapSince = new Date(now.getTime() - DISCORD_REPORT_GAP_MS).toISOString();
    if (db.prepare(`SELECT 1 FROM ticket_reports r WHERE ${REPORTER_KEY_SQL} = ? AND created_at > ?`).get(reporterKey, gapSince)) {
      return fail(429, 'wait a few minutes before filing another report');
    }
  }

  // Which ticket this report would land on, which is also which ticket both
  // duplicate limits are counted against: a safety report belongs to the
  // restricted sibling and is not a duplicate of a normal one, with or
  // without a match. Without this a safety report about a match you had
  // already reported would have to give up its match to get through.
  const restricted = category === 'unsafe'
    || (target.kind === 'player' ? hasStaffFlag(db, target.steamid) : deps.targetDiscord!.administrator);
  const targetKey = personKey(target);
  const dupe = matchId !== null
    ? db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE ${REPORTER_KEY_SQL} = ? AND ${TARGET_KEY_SQL} = ? AND r.match_id = ? AND t.restricted = ?`)
      .get(reporterKey, targetKey, matchId, restricted ? 1 : 0)
    : db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE ${REPORTER_KEY_SQL} = ? AND ${TARGET_KEY_SQL} = ? AND r.match_id IS NULL AND t.status = 'open' AND t.restricted = ?`)
      .get(reporterKey, targetKey, restricted ? 1 : 0);
  if (dupe) return fail(409, matchId !== null ? 'you already reported this player for this match' : 'you already have an open report about this player');

  const result = db.transaction((): FileResult => {
    const ticket = findOrOpen(db, target, restricted, null, deps);
    // feed_held is set here, not decided later: whether this report may ever
    // reach the admin feed is fixed at the moment it lands, by whether the
    // ticket it lands on is restricted right now.
    const reportId = Number(db.prepare(
      `INSERT INTO ticket_reports (ticket_id, reporter_id, reporter_discord_id, reporter_name, category, text, match_id, map_ordinal, half, t_ms, created_at, feed_held)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ticket.id,
      reporter.kind === 'player' ? reporter.steamid : null,
      reporter.kind === 'discord' ? reporter.discordId : null,
      reporter.kind === 'discord' ? reporter.name.slice(0, 100) : '',
      category, text, matchId, moment?.ordinal ?? null, moment?.half ?? null, moment?.tMs ?? null,
      now.toISOString(), restricted ? 1 : 0,
    ).lastInsertRowid);
    if (!ticket.created) addTicketEvent(db, ticket.id, null, 'report_attached', { reportId }, now);
    return { ok: true, reportId, ticketId: ticket.id, created: ticket.created, restricted };
  })();
  // After the commit. The signal goes out for a restricted ticket too: it
  // carries an id and stays in this process. Whether anything is SAID about
  // the report, and where, is TicketSync's decision: in the ticket's thread,
  // or as a line in the admin channel while no forum is set.
  if (result.ok) publishTicketSignal({ kind: 'ticket', ticketId: result.ticketId });
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
  const opened = db.transaction(() => {
    const ticket = findOrOpen(db, { kind: 'player', steamid: targetId }, restricted, by, deps);
    if (note) addTicketEvent(db, ticket.id, by, 'note', { text: note }, now);
    const row = getTicketRow(db, ticket.id)!;
    return { ok: true as const, ticketId: canSeeTicket(db, row, by) ? ticket.id : null, auditId: ticket.id };
  })();
  publishTicketSignal({ kind: 'ticket', ticketId: opened.auditId });
  return opened;
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
  ).all(matchId, reporter) as { target_id: string | null }[]).map((r) => r.target_id));
  return { canReport: true, targets: roster.filter((r) => r.steamid !== reporter).map((r) => ({ ...r, alreadyReported: done.has(r.steamid) })) };
}

export interface MyReport { id: number; targetId: string | null; targetDiscordId: string | null; targetName: string | null; category: string; matchId: number | null; createdAt: string; status: 'open' | 'closed' }

/** What a reporter may know about their own reports: that they exist, and
 *  whether the ticket is still open. Never the outcome, and never a ticket
 *  about themselves: a merge can leave a report filed by what is now the
 *  accused's own account. */
export function myReports(db: DB, reporter: string): MyReport[] {
  return db.prepare(
    `SELECT r.id, t.target_id AS targetId, t.target_discord_id AS targetDiscordId,
            COALESCE(p.name, NULLIF(t.target_name, '')) AS targetName, r.category, r.match_id AS matchId,
            r.created_at AS createdAt, t.status
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE r.reporter_id = ? AND t.target_id IS NOT r.reporter_id ORDER BY r.id DESC LIMIT 100`,
  ).all(reporter) as MyReport[];
}
