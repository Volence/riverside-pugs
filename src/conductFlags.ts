import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { publishAdminEvent } from './adminFeed.js';
import { liveMatchOf } from './integrityFlags.js';
import { findSlurs } from './slurs.js';

/**
 * Slurs in chat and in names, reported to the admin channel as they happen.
 *
 * Asked for on 2026-09-23 after a report showed the chat had been carrying
 * slurs for days without anyone on staff seeing them: chat scrolls past, the
 * people it is aimed at rarely report it, and the full log is only visible to
 * someone who opens a match. The lines come from the plugin's PUGSAY and
 * PUGNAME (see logParse), which cover every human on the box, spectators and
 * matchless warmups included.
 *
 * Stored in integrity_flags as source 'conduct', kind 'chat' or 'name', with
 * the exact text as the detail, so it shows on the player file beside the
 * other evidence and moves with a merged alt.
 *
 * Posting is rationed, storing is not:
 *   - chat posts only after a quiet minute since the player's last slur, so a
 *     burst is one post. Every line is still stored, because the second slur
 *     in a burst is as much evidence as the first.
 *   - a name posts once per player per name, ever. The plugin reports the name
 *     on every connect, and a player who keeps a slur as their name would
 *     otherwise post on every map change.
 */

/** A chat slur posts only when the same player's previous one is at least
 *  this old: a steady stream is one post, not one a minute. */
export const CHAT_POST_EVERY_MS = 60_000;

type ConductEvent = Extract<LogEvent, { kind: 'say' } | { kind: 'name' }>;

export function handleConduct(db: DB, ev: ConductEvent, serverId: number | null, now = new Date()): void {
  const where = ev.kind === 'say' ? 'chat' : 'name';
  const text = ev.kind === 'say' ? ev.message : ev.name;
  const slurs = findSlurs(text);
  if (slurs.length === 0) return;

  const iso = now.toISOString();
  let post: boolean;
  if (where === 'name') {
    const seen = db.prepare(
      "SELECT 1 FROM integrity_flags WHERE source = 'conduct' AND kind = 'name' AND steamid = ? AND detail = ? LIMIT 1",
    ).get(ev.steamid, text);
    if (seen) return;
    post = true;
  } else {
    const since = new Date(now.getTime() - CHAT_POST_EVERY_MS).toISOString();
    post = !db.prepare(
      "SELECT 1 FROM integrity_flags WHERE source = 'conduct' AND kind = 'chat' AND steamid = ? AND at > ? AND at <= ? LIMIT 1",
    ).get(ev.steamid, since, iso);
  }

  const matchId = liveMatchOf(db, serverId, ev.steamid);
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (?, ?, ?, 'conduct', ?, 'suspected', ?, ?)`,
  ).run(matchId, serverId, ev.steamid, where, text, iso);

  if (post) publishAdminEvent({ kind: 'conduct_flag', steamid: ev.steamid, where, text, slurs, matchId, serverId });
}
