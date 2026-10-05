import type { DB } from '../db.js';
import { findSlurs } from '../slurs.js';
import { publishAdminEvent } from '../adminFeed.js';
import { appealSettings, canAppeal, refusalText } from './rules.js';
import { publishAppealSignal } from './signals.js';
import { appealIsQuiet, type Fail } from './access.js';
import { OPEN_STATES, type AppealRef, type AppealRow, type AppealSource, type Appellant } from './types.js';

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');
const OPEN_SQL = inList(OPEN_STATES);

export function getAppeal(db: DB, id: number): AppealRow | undefined {
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as AppealRow | undefined;
}

/** The appellant may act on this row: it is about one of their accounts,
 *  or about their own Discord sanction. */
export function ownsAppeal(who: Appellant, row: AppealRow): boolean {
  if (row.steamid !== null) return who.steamids.includes(row.steamid);
  return row.sanction_id !== null && row.discord_id !== null && row.discord_id === who.discordId;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function fileAppeal(
  db: DB, who: Appellant,
  input: { ref: AppealRef; whatHappened: unknown; whyLift: unknown; source: AppealSource },
  now = new Date(),
): { ok: true; id: number; state: 'open' | 'auto_denied' } | Fail {
  const s = appealSettings(db);
  const what = text(input.whatHappened);
  const why = text(input.whyLift);
  if (!what || !why) return fail(400, 'Fill in both boxes.');
  if (what.length > s.textMax || why.length > s.textMax) return fail(400, `Each box takes up to ${s.textMax} characters.`);
  const slurs = [...new Set([...findSlurs(what), ...findSlurs(why)])];
  const iso = now.toISOString();
  let result: { ok: true; id: number; state: 'open' | 'auto_denied' } | Fail;
  try {
    result = db.transaction(() => {
      const v = canAppeal(db, who, input.ref, now);
      if (!v.ok) return fail(409, refusalText(v));
      const t = v.target;
      const state = slurs.length > 0 ? 'auto_denied' as const : 'open' as const;
      const id = Number(db.prepare(
        `INSERT INTO appeals (ban_id, sanction_id, steamid, discord_id, appellant_name, what_happened, why_lift, state,
                              decided_by, decided_at, slurs, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.ref.kind === 'ban' ? input.ref.id : null, input.ref.kind === 'sanction' ? input.ref.id : null,
        t.steamid, t.discordId ?? who.discordId, who.name.slice(0, 100), what, why, state,
        state === 'auto_denied' ? 'system' : null, state === 'auto_denied' ? iso : null,
        slurs.length > 0 ? JSON.stringify(slurs) : null, input.source, iso,
      ).lastInsertRowid);
      return { ok: true as const, id, state };
    })();
  } catch (err) {
    // The partial unique index: a second submit raced the first past canAppeal.
    if (String(err).includes('UNIQUE')) return fail(409, refusalText({ ok: false, reason: 'already_open' }));
    throw err;
  }
  if (result.ok) {
    const row = getAppeal(db, result.id)!;
    if (!appealIsQuiet(db, row)) {
      publishAdminEvent({ kind: 'appeal', appealId: row.id, what: result.state === 'open' ? 'filed' : 'auto_denied', name: row.appellant_name, slurs });
    }
    publishAppealSignal(result.id);
  }
  return result;
}

export function askQuestion(db: DB, id: number, by: string, question: unknown, now = new Date()): { ok: true } | Fail {
  const q = text(question);
  if (!q || q.length > 500) return fail(400, 'A question is up to 500 characters.');
  const changed = db.prepare("UPDATE appeals SET state = 'asked', question = ?, asked_by = ?, asked_at = ? WHERE id = ? AND state = 'open'")
    .run(q, by, now.toISOString(), id).changes > 0;
  if (!changed) return fail(409, 'A question can only be asked once, before anything else happens.');
  publishAppealSignal(id);
  return { ok: true };
}

export function answerQuestion(
  db: DB, who: Appellant, id: number, answer: unknown, now = new Date(),
): { ok: true; state: 'answered' | 'auto_denied' } | Fail {
  const row = getAppeal(db, id);
  if (!row || !ownsAppeal(who, row)) return fail(404, 'no such appeal');
  if (row.state !== 'asked') return fail(409, 'There is no question waiting for an answer.');
  const s = appealSettings(db);
  if (Date.parse(row.asked_at!) + s.answerHours * 3600_000 <= now.getTime()) return fail(409, 'The time to answer has run out.');
  const a = text(answer);
  if (!a || a.length > s.answerMax) return fail(400, `An answer is up to ${s.answerMax} characters.`);
  const slurs = findSlurs(a);
  const iso = now.toISOString();
  const state = slurs.length > 0 ? 'auto_denied' as const : 'answered' as const;
  const changed = db.prepare(
    `UPDATE appeals SET state = ?, answer = ?, answered_at = ?,
       decided_by = CASE WHEN ? = 'auto_denied' THEN 'system' ELSE decided_by END,
       decided_at = CASE WHEN ? = 'auto_denied' THEN ? ELSE decided_at END,
       slurs = CASE WHEN ? = 'auto_denied' THEN ? ELSE slurs END
     WHERE id = ? AND state = 'asked'`,
  ).run(state, a, iso, state, state, iso, state, JSON.stringify(slurs), id).changes > 0;
  if (!changed) return fail(409, 'There is no question waiting for an answer.');
  if (state === 'auto_denied' && !appealIsQuiet(db, row)) {
    publishAdminEvent({ kind: 'appeal', appealId: id, what: 'auto_denied', name: row.appellant_name, slurs });
  }
  publishAppealSignal(id);
  return { ok: true, state };
}

/** The one guarded write behind every staff decision. False: somebody else
 *  decided first, or the appeal was closed by the sweep. */
export function recordDecision(
  db: DB, id: number, by: string, state: 'accepted' | 'shortened' | 'denied', newExpiresAt: string | null, now = new Date(),
): boolean {
  const changed = db.prepare(
    `UPDATE appeals SET state = ?, decided_by = ?, decided_at = ?, new_expires_at = ? WHERE id = ? AND state IN (${OPEN_SQL})`,
  ).run(state, by, now.toISOString(), newExpiresAt, id).changes > 0;
  if (changed) publishAppealSignal(id);
  return changed;
}

export function mootAppeal(db: DB, id: number, now = new Date()): boolean {
  const changed = db.prepare(
    `UPDATE appeals SET state = 'moot', decided_by = 'system', decided_at = ? WHERE id = ? AND state IN (${OPEN_SQL})`,
  ).run(now.toISOString(), id).changes > 0;
  if (changed) publishAppealSignal(id);
  return changed;
}

/** Whether the ban or sanction an appeal is about is still in force. */
export function targetInForce(db: DB, row: AppealRow, now = new Date()): boolean {
  const iso = now.toISOString();
  return row.ban_id !== null
    ? !!db.prepare('SELECT 1 FROM bans WHERE id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(row.ban_id, iso)
    : !!db.prepare('SELECT 1 FROM discord_sanctions WHERE id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)').get(row.sanction_id, iso);
}

/** Runs on the 60 s reaper. An unanswered question past its time closes as
 *  lapsed (counts as a denial); an appeal whose ban has ended any other way
 *  closes as moot (counts for nothing).
 *
 *  Ruling: the lapse step is skipped while appeals are turned off. A player
 *  cannot see their own appeal with the feature off (the whole box is
 *  hidden), so they cannot know a question was asked, let alone answer it;
 *  turning appeals off must not be a way to cost them a strike they never
 *  saw. Moot still runs: a ban that ended on its own, or by hand, should
 *  close the appeal either way. */
export function sweepAppeals(db: DB, now = new Date()): { lapsed: number[]; moot: number[] } {
  const s = appealSettings(db);
  const cutoff = new Date(now.getTime() - s.answerHours * 3600_000).toISOString();
  const lapsed: number[] = [];
  if (s.enabled) {
    for (const { id } of db.prepare("SELECT id FROM appeals WHERE state = 'asked' AND asked_at <= ?").all(cutoff) as { id: number }[]) {
      const changed = db.prepare("UPDATE appeals SET state = 'lapsed', decided_by = 'system', decided_at = ? WHERE id = ? AND state = 'asked'")
        .run(now.toISOString(), id).changes > 0;
      if (changed) { lapsed.push(id); publishAppealSignal(id); }
    }
  }
  const moot: number[] = [];
  for (const row of db.prepare(`SELECT * FROM appeals WHERE state IN (${OPEN_SQL})`).all() as AppealRow[]) {
    if (!targetInForce(db, row, now) && mootAppeal(db, row.id, now)) moot.push(row.id);
  }
  return { lapsed, moot };
}
