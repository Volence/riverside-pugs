import type { DB } from '../db.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import { lineupsOf } from './room.js';
import { matchLabel } from './playViews.js';

/**
 * The Events section of a player's profile (foundation spec section 1,
 * Profiles: "a Tournament tab (public)"). Every event the player was on an
 * entry of, newest first, with that entry's record and its matches. Event
 * play never feeds the PUG numbers on the same page (src/matchKinds.ts); this
 * is the only place a profile shows it.
 */

export interface ProfileEventMatch {
  id: number; roundLabel: string; opponent: string | null;
  result: 'win' | 'loss' | null; scoreFor: number | null; scoreAgainst: number | null; forfeit: boolean;
  /** The event match row's status (done, forfeit, live, waiting...). */
  status: string;
}
export interface ProfileEvent {
  slug: string; name: string; status: E.EventRow['status']; startsAt: string; finishedAt: string | null;
  entry: { id: number; name: string; tag: string; logoKey: string | null; captain: boolean; seed: number | null };
  /** Final place, set when the event finished; null before. */
  placement: number | null;
  wins: number; losses: number;
  matches: ProfileEventMatch[];
}

/** Events still being set up or called off never show on a profile. */
const HIDDEN = new Set(['draft', 'cancelled']);
const DECIDED = new Set(['done', 'forfeit']);

export function profileEvents(db: DB, steamid: string): ProfileEvent[] {
  // Any place the player ever held on an entry, so a player replaced mid-event
  // keeps the matches they played; one row per entry. current = still on it.
  const held = db.prepare(
    'SELECT entry_id, MAX(removed_at IS NULL) AS current FROM event_entry_players WHERE steamid = ? GROUP BY entry_id',
  ).all(steamid) as { entry_id: number; current: number }[];
  const out: ProfileEvent[] = [];
  for (const { entry_id: entryId, current } of held) {
    const entry = N.getEntry(db, entryId);
    if (!entry || entry.status === 'dropped') continue;
    const ev = E.getEvent(db, entry.event_id);
    if (!ev || HIDDEN.has(ev.status)) continue;
    const name = (id: number | null) => (id === null ? null : N.getEntry(db, id)?.name ?? null);
    const rows = db.prepare(
      `SELECT * FROM event_matches WHERE (entry_a = ? OR entry_b = ?) AND status != 'bye'
       ORDER BY stage_id, round, slot, id`,
    ).all(entryId, entryId) as P.MatchRow[];
    // Only the matches the player was part of: on a locked lineup for this
    // team, or, where the team locked none (not reached yet, admin result),
    // still on the roster. A player moved between teams mid-event shows each
    // team's matches they actually played, not the whole run of both.
    const played = rows.filter((m) => {
      const mine = lineupsOf(db, m.id).filter((l) => l.entry_id === entryId);
      if (mine.length === 0) return current === 1;
      return mine.some((l) => (JSON.parse(l.steamids) as string[]).includes(steamid));
    });
    // A team left before playing a match for it never shows.
    if (current !== 1 && played.length === 0) continue;
    const matches = played.map((m): ProfileEventMatch => {
      const mine = m.entry_a === entryId ? 'a' : 'b';
      const decided = DECIDED.has(m.status) && m.winner_entry !== null;
      return {
        id: m.id, roundLabel: matchLabel(db, ev, m), opponent: name(mine === 'a' ? m.entry_b : m.entry_a),
        result: decided ? (m.winner_entry === entryId ? 'win' : 'loss') : null,
        scoreFor: mine === 'a' ? m.score_a : m.score_b, scoreAgainst: mine === 'a' ? m.score_b : m.score_a,
        forfeit: m.status === 'forfeit', status: m.status,
      };
    });
    out.push({
      slug: ev.slug, name: ev.name, status: ev.status, startsAt: ev.starts_at, finishedAt: ev.finished_at,
      entry: { id: entry.id, name: entry.name, tag: entry.tag, logoKey: entry.logo_key, captain: N.entryManagers(db, entry).includes(steamid), seed: entry.seed },
      // The team's final place is the player's only if they finished with it.
      placement: current === 1 ? entry.placement : null,
      wins: matches.filter((m) => m.result === 'win').length,
      losses: matches.filter((m) => m.result === 'loss').length,
      matches,
    });
  }
  return out.sort((x, y) => y.startsAt.localeCompare(x.startsAt));
}
