import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import type { AttachmentRow, MessageRow } from './messages.js';
import { REPORTER_KEY_SQL } from './person.js';
import { canSeeTicket, getTicketRow } from './store.js';
import { staffThread, surfaceFor } from './threads.js';

/** The visibility rule as SQL, for lists. Must say exactly what canSeeTicket
 *  says; tests/ticketRoutes.test.ts holds the two together. */
const VISIBLE = `t.target_id IS NOT @viewer AND (t.restricted = 0 OR EXISTS
  (SELECT 1 FROM ticket_access a WHERE a.ticket_id = t.id AND a.steamid = @viewer))`;

const SUMMARY = `SELECT t.*, COALESCE(pt.name, NULLIF(t.target_name, '')) AS display_target_name, pc.name AS claimed_name, po.name AS opened_name, px.name AS closed_name,
    (SELECT COUNT(*) FROM ticket_reports r WHERE r.ticket_id = t.id) AS reports,
    (SELECT COUNT(DISTINCT ${REPORTER_KEY_SQL}) FROM ticket_reports r WHERE r.ticket_id = t.id) AS reporters,
    (SELECT GROUP_CONCAT(DISTINCT r.category) FROM ticket_reports r WHERE r.ticket_id = t.id) AS categories,
    (SELECT MAX(r.created_at) FROM ticket_reports r WHERE r.ticket_id = t.id) AS last_report_at
  FROM tickets t
  LEFT JOIN players pt ON pt.steamid = t.target_id LEFT JOIN players pc ON pc.steamid = t.claimed_by
  LEFT JOIN players po ON po.steamid = t.opened_by LEFT JOIN players px ON px.steamid = t.closed_by`;

interface SummaryRow {
  id: number; target_id: string | null; target_discord_id: string | null; status: 'open' | 'closed'; outcome: string | null; outcome_note: string; restricted: number;
  claimed_by: string | null; opened_by: string | null; created_at: string; closed_at: string | null; closed_by: string | null;
  display_target_name: string | null; claimed_name: string | null; opened_name: string | null; closed_name: string | null;
  reports: number; reporters: number; categories: string | null; last_report_at: string | null;
}

const toSummary = (r: SummaryRow) => ({
  id: r.id, targetId: r.target_id, targetDiscordId: r.target_discord_id, targetName: r.display_target_name, status: r.status, outcome: r.outcome,
  restricted: r.restricted === 1, claimedBy: r.claimed_by, claimedByName: r.claimed_name,
  reports: r.reports, reporters: r.reporters, categories: r.categories ? r.categories.split(',') : [],
  createdAt: r.created_at, lastReportAt: r.last_report_at, closedAt: r.closed_at,
});
export type TicketSummary = ReturnType<typeof toSummary>;
export type TicketFilter = 'open' | 'mine' | 'closed';

export function listTickets(db: DB, viewer: string, filter: TicketFilter): TicketSummary[] {
  const where = filter === 'closed' ? "t.status = 'closed'"
    : filter === 'mine' ? "t.status = 'open' AND t.claimed_by = @viewer" : "t.status = 'open'";
  return (db.prepare(`${SUMMARY} WHERE ${VISIBLE} AND ${where} ORDER BY COALESCE(last_report_at, t.created_at) DESC LIMIT 200`)
    .all({ viewer }) as SummaryRow[]).map(toSummary);
}

/** How many tickets sit behind each filter, for this viewer. Counted with
 *  the same VISIBLE clause as the list, so a count can never give away a
 *  restricted ticket the list would not show. */
export function ticketCounts(db: DB, viewer: string): { open: number; mine: number; closed: number } {
  return db.prepare(
    `SELECT COALESCE(SUM(t.status = 'open'), 0) AS open,
            COALESCE(SUM(t.status = 'open' AND t.claimed_by = @viewer), 0) AS mine,
            COALESCE(SUM(t.status = 'closed'), 0) AS closed
     FROM tickets t WHERE ${VISIBLE}`,
  ).get({ viewer }) as { open: number; mine: number; closed: number };
}

/** Every ticket about one player that this viewer may see, newest first. */
export function ticketsAbout(db: DB, targetId: string, viewer: string): TicketSummary[] {
  return (db.prepare(`${SUMMARY} WHERE ${VISIBLE} AND t.target_id = @targetId ORDER BY t.id DESC LIMIT 50`)
    .all({ viewer, targetId }) as SummaryRow[]).map(toSummary);
}

export function ticketDetail(db: DB, id: number, viewer: string, opts: { guildId?: string | null } = {}) {
  const row = getTicketRow(db, id);
  if (!row || !canSeeTicket(db, row, viewer)) return null;
  const s = db.prepare(`${SUMMARY} WHERE t.id = ?`).get(id) as SummaryRow;
  const reports = (db.prepare(
    `SELECT r.id, r.reporter_id, r.reporter_discord_id, COALESCE(p.name, NULLIF(r.reporter_name, '')) AS reporter_name,
            r.category, r.text, r.match_id, m.campaign,
            r.map_ordinal, r.half, r.t_ms, r.created_at
     FROM ticket_reports r LEFT JOIN players p ON p.steamid = r.reporter_id LEFT JOIN matches m ON m.id = r.match_id
     WHERE r.ticket_id = ? ORDER BY r.id`,
  ).all(id) as {
    id: number; reporter_id: string | null; reporter_discord_id: string | null; reporter_name: string | null; category: string; text: string; match_id: number | null;
    campaign: string | null; map_ordinal: number | null; half: number | null; t_ms: number | null; created_at: string;
  }[]).map((r) => ({
    id: r.id, reporterId: r.reporter_id, reporterDiscordId: r.reporter_discord_id, reporterName: r.reporter_name, category: r.category, text: r.text,
    matchId: r.match_id, campaign: r.campaign,
    moment: r.map_ordinal === null || r.half === null || r.t_ms === null ? null : { ordinal: r.map_ordinal, half: r.half, tMs: r.t_ms },
    createdAt: r.created_at,
  }));
  const events = (db.prepare(
    `SELECT e.id, e.actor_id, p.name AS actor_name, e.kind, e.detail, e.created_at
     FROM ticket_events e LEFT JOIN players p ON p.steamid = e.actor_id WHERE e.ticket_id = ? ORDER BY e.id`,
  ).all(id) as { id: number; actor_id: string | null; actor_name: string | null; kind: string; detail: string; created_at: string }[])
    .map((e) => ({ id: e.id, actorId: e.actor_id, actorName: e.actor_name, kind: e.kind, detail: JSON.parse(e.detail) as Record<string, unknown>, createdAt: e.created_at }));
  const bans = db.prepare(
    `SELECT b.id, b.reason, b.created_by AS createdBy, p.name AS createdByName, b.created_at AS createdAt,
            b.expires_at AS expiresAt, b.lifted_at AS liftedAt
     FROM bans b LEFT JOIN players p ON p.steamid = b.created_by WHERE b.ticket_id = ? ORDER BY b.id DESC`,
  ).all(id);
  const access = row.restricted === 1 ? db.prepare(
    `SELECT a.steamid, COALESCE(p.name, a.steamid) AS name FROM ticket_access a
     LEFT JOIN players p ON p.steamid = a.steamid WHERE a.ticket_id = ? ORDER BY name`,
  ).all(id) : [];
  const accessCandidates = row.restricted === 1 ? db.prepare(
    `SELECT steamid, name FROM players WHERE (is_admin = 1 OR is_mod = 1) AND steamid IS NOT ?
       AND steamid NOT IN (SELECT steamid FROM ticket_access WHERE ticket_id = ?) ORDER BY name`,
  ).all(row.target_id, id) : [];
  // The mirrored discussion. Everything here is behind the canSeeTicket check
  // at the top of this function, like the rest of the detail. `stored_name`
  // stays on the server: the page asks for a file by attachment id.
  const files = db.prepare(
    `SELECT a.* FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE m.ticket_id = ? ORDER BY a.id`,
  ).all(id) as AttachmentRow[];
  const messages = (db.prepare(
    `SELECT m.*, pa.name AS author_player_name, pr.name AS removed_by_name FROM ticket_messages m
       LEFT JOIN players pa ON pa.steamid = m.author_player_id LEFT JOIN players pr ON pr.steamid = m.removed_by
     WHERE m.ticket_id = ? ORDER BY m.created_at, m.id`,
  ).all(id) as (MessageRow & { author_player_name: string | null; removed_by_name: string | null })[]).map((m) => ({
    id: m.id, channel: m.channel, authorName: m.author_name, authorPlayerId: m.author_player_id, authorPlayerName: m.author_player_name,
    content: m.content, history: JSON.parse(m.history) as string[],
    createdAt: m.created_at, editedAt: m.edited_at, deletedAt: m.deleted_at,
    removed: m.removed_at === null ? null : { at: m.removed_at, by: m.removed_by, byName: m.removed_by_name, reason: m.removed_reason ?? '' },
    attachments: files.filter((f) => f.message_id === m.id).map((f) => ({
      id: f.id, filename: f.filename, contentType: f.content_type, size: f.size, sha256: f.sha256,
      stored: f.stored_name !== null && f.removed_at === null, skipReason: f.skip_reason, removed: f.removed_at !== null,
    })),
  }));
  const me = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(viewer) as { is_admin: number } | undefined;
  const isAdmin = me?.is_admin === 1;
  // What the page says about Discord. 'pending' is an open ticket whose
  // thread the bot has not made yet; a closed ticket that never had one
  // (every ticket migrated from the old reports) is simply 'none'.
  const thread = staffThread(db, id);
  const where = surfaceFor(db, row);
  const discussion = {
    state: thread ? 'ready' as const
      : where.why === 'unconfigured' ? 'unconfigured' as const
        : where.why === 'about_staff' ? 'about_staff' as const
          : row.status === 'open' ? 'pending' as const : 'none' as const,
    surface: thread?.surface ?? where.surface,
    url: thread && opts.guildId ? `https://discord.com/channels/${opts.guildId}/${thread.thread_id}` : null,
  };
  return {
    ticket: {
      ...toSummary(s), outcomeNote: s.outcome_note, openedBy: s.opened_by, openedByName: s.opened_name,
      closedBy: s.closed_by, closedByName: s.closed_name,
    },
    reports, events, bans, access, accessCandidates, discussion, messages,
    viewer: { isAdmin, banCapMinutes: isAdmin ? null : Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080') },
  };
}
