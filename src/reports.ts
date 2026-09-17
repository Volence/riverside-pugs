import type { DB } from './db.js';

export const REPORT_CATEGORIES = ['griefing', 'cheating', 'toxicity', 'afk', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
const WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_TEXT = 1000;

/** SQLite datetime('now') strings are UTC without a zone marker. */
const parseSqlTime = (s: string) => Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);

export type Eligibility =
  | { canReport: true; targets: { steamid: string; name: string; alreadyReported: boolean }[] }
  | { canReport: false; reason: string; status: 403 | 404 };

/** Who may report whom on a match: roster members, about other roster
 *  members, while the match is running or up to 48 hours after it ended. */
export function reportEligibility(db: DB, matchId: number, reporter: string, now = Date.now()): Eligibility {
  const m = db.prepare('SELECT state, ended_at FROM matches WHERE id = ?').get(matchId) as
    | { state: string; ended_at: string | null } | undefined;
  if (!m) return { canReport: false, reason: 'no such match', status: 404 };
  const roster = db.prepare(
    'SELECT mp.player_id AS steamid, p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ?',
  ).all(matchId) as { steamid: string; name: string }[];
  if (!roster.some((r) => r.steamid === reporter)) return { canReport: false, reason: 'you did not play in this match', status: 403 };
  if (m.state === 'configuring') return { canReport: false, reason: 'the match has not started', status: 403 };
  if (m.ended_at && now - parseSqlTime(m.ended_at) > WINDOW_MS) {
    return { canReport: false, reason: 'reports close 48 hours after a match ends', status: 403 };
  }
  const done = new Set((db.prepare('SELECT target_id FROM reports WHERE match_id = ? AND reporter_id = ?')
    .all(matchId, reporter) as { target_id: string }[]).map((r) => r.target_id));
  return {
    canReport: true,
    targets: roster.filter((r) => r.steamid !== reporter).map((r) => ({ ...r, alreadyReported: done.has(r.steamid) })),
  };
}

export type FileResult = { ok: true; id: number } | { ok: false; status: number; error: string };

export function fileReport(
  db: DB, matchId: number, reporter: string, body: { targetId?: unknown; category?: unknown; text?: unknown },
): FileResult {
  const elig = reportEligibility(db, matchId, reporter);
  if (!elig.canReport) return { ok: false, status: elig.status, error: elig.reason };
  const target = elig.targets.find((t) => t.steamid === body.targetId);
  if (!target) return { ok: false, status: 400, error: 'pick a player from this match other than yourself' };
  if (typeof body.category !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(body.category)) {
    return { ok: false, status: 400, error: 'pick a category' };
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_TEXT) return { ok: false, status: 400, error: `keep it under ${MAX_TEXT} characters` };
  if (target.alreadyReported) return { ok: false, status: 409, error: 'you already reported this player for this match' };
  const id = Number(db.prepare(
    `INSERT INTO reports (match_id, reporter_id, target_id, category, text, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).run(matchId, reporter, target.steamid, body.category, text, new Date().toISOString()).lastInsertRowid);
  return { ok: true, id };
}

export function listReports(db: DB, status: string) {
  return (db.prepare(
    `SELECT r.*, pr.name AS reporter_name, pt.name AS target_name, m.campaign
     FROM reports r
     LEFT JOIN players pr ON pr.steamid = r.reporter_id
     LEFT JOIN players pt ON pt.steamid = r.target_id
     LEFT JOIN matches m ON m.id = r.match_id
     WHERE (? = 'all' OR r.status = ?)
     ORDER BY r.id DESC LIMIT 200`,
  ).all(status, status) as {
    id: number; match_id: number; reporter_id: string; target_id: string; category: string; text: string; status: string;
    resolved_by: string | null; resolution_note: string | null; created_at: string; resolved_at: string | null;
    reporter_name: string | null; target_name: string | null; campaign: string | null;
  }[]).map((r) => ({
    id: r.id, matchId: r.match_id, campaign: r.campaign, reporterId: r.reporter_id, reporterName: r.reporter_name,
    targetId: r.target_id, targetName: r.target_name, category: r.category, text: r.text, status: r.status,
    resolvedBy: r.resolved_by, resolutionNote: r.resolution_note, createdAt: r.created_at, resolvedAt: r.resolved_at,
  }));
}

export function resolveReport(db: DB, id: number, by: string, status: 'resolved' | 'dismissed', note: string): boolean {
  return db.prepare('UPDATE reports SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?')
    .run(status, by, note, new Date().toISOString(), id).changes > 0;
}
