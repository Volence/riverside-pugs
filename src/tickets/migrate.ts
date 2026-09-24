import type { DB } from '../db.js';
import { addTicketEvent, hasStaffFlag, seedAccess } from './store.js';

interface Legacy {
  id: number; match_id: number; reporter_id: string; target_id: string; category: string; text: string;
  status: 'open' | 'resolved' | 'dismissed'; resolved_by: string | null; resolution_note: string | null;
  created_at: string; resolved_at: string | null;
}

/**
 * Carry the old `reports` rows into tickets, once. Idempotent through
 * ticket_reports.legacy_report_id, so it is safe on every boot. The reports
 * table is left exactly as it was: nothing writes to it any more, and it is
 * the undo if this ever turns out wrong.
 *
 * Open reports are grouped by target, which is what filing would have done.
 * A settled report keeps its own closed ticket, because each one was decided
 * on its own and merging them would invent a decision nobody made.
 *
 * No owner list is available at openDb time, so a restricted migrated ticket
 * falls back to every admin but the accused (seedAccess with an empty list).
 *
 * A created ticket gets the events its history implies, dated then, so a
 * migrated case reads as a timeline rather than as nothing ever happening.
 */
export function migrateLegacyReports(db: DB): number {
  const rows = db.prepare(
    `SELECT r.* FROM reports r
     WHERE NOT EXISTS (SELECT 1 FROM ticket_reports t WHERE t.legacy_report_id = r.id)
       AND EXISTS (SELECT 1 FROM players p WHERE p.steamid = r.reporter_id)
       AND EXISTS (SELECT 1 FROM players p WHERE p.steamid = r.target_id)
     ORDER BY r.id`,
  ).all() as Legacy[];
  if (rows.length === 0) return 0;
  const insTicket = db.prepare(
    `INSERT INTO tickets (target_id, status, outcome, outcome_note, restricted, created_at, closed_at, closed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // announced_at is set to the report's own created_at: a migrated report is
  // never news, and the admin feed must not announce a backlog of old cases
  // the first time the site boots with tickets. feed_held follows the ticket's
  // restriction, exactly as filing sets it on a live report.
  const insReport = db.prepare(
    `INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, match_id, created_at, legacy_report_id, feed_held, announced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // An old report can point at a match that was deleted by hand, and
  // ticket_reports.match_id is a foreign key: keep the report, lose the match.
  const matchExists = db.prepare('SELECT 1 FROM matches WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const restricted = hasStaffFlag(db, r.target_id) ? 1 : 0;
      let ticketId: number;
      if (r.status === 'open') {
        const open = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
          .get(r.target_id, restricted) as { id: number } | undefined;
        ticketId = open?.id ?? Number(insTicket.run(r.target_id, 'open', null, '', restricted, r.created_at, null, null).lastInsertRowid);
        if (!open) addTicketEvent(db, ticketId, null, 'opened', {}, new Date(r.created_at));
      } else {
        const outcome = r.status === 'resolved' ? 'action_taken' : 'invalid';
        const note = r.resolution_note ?? '';
        ticketId = Number(insTicket.run(
          r.target_id, 'closed', outcome, note,
          restricted, r.created_at, r.resolved_at ?? r.created_at, r.resolved_by,
        ).lastInsertRowid);
        addTicketEvent(db, ticketId, null, 'opened', {}, new Date(r.created_at));
        addTicketEvent(db, ticketId, r.resolved_by, 'closed', { outcome, note }, new Date(r.resolved_at ?? r.created_at));
      }
      if (restricted) seedAccess(db, ticketId, r.target_id, []);
      const matchId = matchExists.get(r.match_id) ? r.match_id : null;
      insReport.run(ticketId, r.reporter_id, r.category, r.text, matchId, r.created_at, r.id, restricted, r.created_at);
    }
  })();
  return rows.length;
}
