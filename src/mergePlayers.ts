import type { DB } from './db.js';
import { addAlias } from './aliases.js';
import { recomputeSeasonRatings } from './rating.js';

/**
 * Fold one Steam account into another, as if the second had always been the
 * only one.
 *
 * Written for match 65 (2026-09-20), where one player was on the server under
 * two accounts. Both were rostered on the same team in four matches, both were
 * rated, and his side was scored as five-a-side each time, which moved the
 * rating of everyone in those matches and not just his. Correcting that is
 * what the recompute at the end is for: ratings are sequential, so fixing a
 * roster four matches back changes every rating computed since.
 *
 * Everything runs in one transaction. A half-merged player is worse than an
 * unmerged one: `from` would still hold rows nothing points at, and the
 * recompute would build a season from a roster that is neither shape.
 */

/** Tables holding a steamid in a column that cannot collide, so the rows can
 *  simply be rewritten. A player id here is a reference, not part of a key. */
const PLAIN: [table: string, column: string][] = [
  ['match_chat', 'steamid'],
  ['match_live_events', 'actor'],
  ['match_live_events', 'target'],
  ['admin_actions', 'target'],
  ['bans', 'player_id'],
  ['player_notes', 'player_id'],
  ['penalties', 'player_id'],
  ['reports', 'reporter_id'],
  ['reports', 'target_id'],
  ['integrity_rounds', 'steamid'],
  ['integrity_clips', 'steamid'],
  // Evidence. None of it has a foreign key, so leaving it behind never
  // failed: it just stayed on an id with no player row and no admin page.
  ['integrity_flags', 'steamid'],
  ['input_bursts', 'steamid'],
  ['input_detections', 'steamid'],
  ['signon_drops', 'steamid'],
  // The losing account's open link is closed first, below: the survivor
  // inherits the record of it, not the link.
  ['discord_link_history', 'steamid'],
];

/** Tables where the steamid is part of the primary key, so `from` and `into`
 *  can already both be present. The row is moved when the slot is free and
 *  dropped when it is not: for scratch and per-round tables the surviving row
 *  is as good as the one discarded, and the two that need their numbers added
 *  up instead are handled before this runs. */
const KEYED: [table: string, column: string][] = [
  ['match_live_players', 'player_id'],
  ['match_live_map_stats', 'player_id'],
  ['match_readyup_players', 'player_id'],
  // A handle per platform. Where both accounts have one, `into` keeps its own.
  ['player_links', 'player_id'],
  // Summed first, below, where both accounts were seen on one address.
  ['player_networks', 'player_id'],
];

/** A merge that cannot be done because of what was asked for, as opposed to
 *  a fault. Routes turn this into a 400 and let everything else be a 500, so
 *  a programming error is never disguised as bad input. */
export class MergeError extends Error {}

/** Every (table, column) pair the merge rewrites when folding `from` into
 *  `into`: PLAIN and KEYED, plus the tables handled by hand because their key
 *  or their arithmetic does not fit either list. A test enumerates every
 *  foreign key that actually points at players and checks it against this,
 *  so a table added later without being taught to the merge fails loudly
 *  instead of throwing at merge time on whoever happens to hold a row in it. */
export const MERGE_HANDLED_PLAYER_COLUMNS: [table: string, column: string][] = [
  ...PLAIN,
  ...KEYED,
  ['match_players', 'player_id'],
  ['match_player_stats', 'player_id'],
  ['player_ratings', 'player_id'],
  ['rating_history', 'player_id'],
  ['player_aliases', 'canonical_id'],
  ['twitch_status', 'player_id'],
  ['endorsements', 'from_id'],
  ['endorsements', 'to_id'],
];

export interface MergePlan {
  from: string;
  into: string;
  /** Matches the losing account was rostered in. */
  matchesMoved: number;
  /** Matches where BOTH accounts were rostered, whose rows were summed. */
  matchesCollapsed: number;
  rowsByTable: Record<string, number>;
  seasons: number[];
}

export function mergePlayers(
  db: DB, opts: { from: string; into: string; dryRun?: boolean; by?: string },
): MergePlan {
  const { from, into } = opts;
  if (from === into) throw new MergeError('from and into are the same account');
  for (const id of [from, into]) {
    if (!db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(id)) {
      throw new MergeError(`player not found: ${id}`);
    }
  }

  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { n: number }).n;

  const rowsByTable: Record<string, number> = {};
  const note = (table: string, n: number): void => {
    if (n > 0) rowsByTable[table] = (rowsByTable[table] ?? 0) + n;
  };

  for (const [table, column] of [...PLAIN, ...KEYED]) {
    note(table, count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, from));
  }
  note('match_players', count('SELECT COUNT(*) AS n FROM match_players WHERE player_id = ?', from));
  note('match_player_stats', count('SELECT COUNT(*) AS n FROM match_player_stats WHERE player_id = ?', from));
  note('player_ratings', count('SELECT COUNT(*) AS n FROM player_ratings WHERE player_id = ?', from));
  note('rating_history', count('SELECT COUNT(*) AS n FROM rating_history WHERE player_id = ?', from));
  note('endorsements', count('SELECT COUNT(*) AS n FROM endorsements WHERE from_id = ? OR to_id = ?', from, from));
  note('twitch_status', count('SELECT COUNT(*) AS n FROM twitch_status WHERE player_id = ?', from));

  const matchesMoved = count('SELECT COUNT(DISTINCT match_id) AS n FROM match_players WHERE player_id = ?', from);
  const matchesCollapsed = count(
    `SELECT COUNT(*) AS n FROM match_players a JOIN match_players b
       ON a.match_id = b.match_id AND a.player_id = ? AND b.player_id = ?`,
    from, into,
  );
  // Every season either account has a rating or a result in, because the
  // recompute has to replay all of them, not just the ones that collided.
  const seasons = (db.prepare(
    `SELECT DISTINCT season_id AS s FROM player_ratings WHERE player_id IN (?, ?)
     UNION
     SELECT DISTINCT m.season_id FROM matches m JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.player_id IN (?, ?)
     ORDER BY s`,
  ).all(from, into, from, into) as { s: number }[]).map((r) => r.s);

  const plan: MergePlan = { from, into, matchesMoved, matchesCollapsed, rowsByTable, seasons };
  if (opts.dryRun) return plan;

  db.transaction(() => {
    // 1. Matches both accounts were rostered in: add the figures together and
    //    keep one row. Summing is right even though one row is usually a ghost
    //    that scored nothing, because which row that is varies: in match 65 it
    //    was the main, and the alt is the one that played.
    db.prepare(
      `UPDATE match_players AS keep SET
         si_damage    = keep.si_damage    + gone.si_damage,
         si_kills     = keep.si_kills     + gone.si_kills,
         common_kills = keep.common_kills + gone.common_kills,
         ff_dealt     = keep.ff_dealt     + gone.ff_dealt,
         revives      = keep.revives      + gone.revives,
         -- The earlier of the two: someone who was there from the start was
         -- there from the start, whichever account carried the row.
         joined_map   = MIN(keep.joined_map, gone.joined_map),
         connected_at = COALESCE(keep.connected_at, gone.connected_at)
       FROM match_players AS gone
       WHERE gone.match_id = keep.match_id AND keep.player_id = ? AND gone.player_id = ?`,
    ).run(into, from);
    db.prepare(
      `DELETE FROM match_players WHERE player_id = ? AND match_id IN
         (SELECT match_id FROM match_players WHERE player_id = ?)`,
    ).run(from, into);
    db.prepare('UPDATE match_players SET player_id = ? WHERE player_id = ?').run(into, from);

    // 2. Per-stat rows: same idea, one key deeper.
    db.prepare(
      `UPDATE match_player_stats AS keep SET value = keep.value + gone.value
       FROM match_player_stats AS gone
       WHERE gone.match_id = keep.match_id AND gone.stat = keep.stat
         AND keep.player_id = ? AND gone.player_id = ?`,
    ).run(into, from);
    db.prepare(
      `DELETE FROM match_player_stats WHERE player_id = ? AND (match_id, stat) IN
         (SELECT match_id, stat FROM match_player_stats WHERE player_id = ?)`,
    ).run(from, into);
    db.prepare('UPDATE match_player_stats SET player_id = ? WHERE player_id = ?').run(into, from);

    // The losing account's Discord link dies with its player row, so its
    // history row is closed here. Left open, it would move to the survivor
    // below and claim a link the survivor never had.
    db.prepare(
      "UPDATE discord_link_history SET unlinked_at = ?, unlinked_by = 'merge' WHERE steamid = ? AND unlinked_at IS NULL",
    ).run(new Date().toISOString(), from);

    for (const [table, column] of PLAIN) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(into, from);
    }

    // An address both accounts were seen on is one sighting history, not two:
    // add the counts and take the widest span, then let KEYED drop the row.
    db.prepare(
      `UPDATE player_networks AS keep SET
         seen_count = keep.seen_count + gone.seen_count,
         first_seen = MIN(keep.first_seen, gone.first_seen),
         last_seen  = MAX(keep.last_seen, gone.last_seen),
         country    = COALESCE(keep.country, gone.country)
       FROM player_networks AS gone
       WHERE gone.ip_hash = keep.ip_hash AND keep.player_id = ? AND gone.player_id = ?`,
    ).run(into, from);

    // Twitch. The link is two columns on the player row plus the poll cache,
    // and the cache references players with no cascade, so it has to be gone
    // before the row is. The link follows the person when `into` has none of
    // its own; otherwise `into` keeps its own and this one is released. The
    // cache only ever moves WITH the link: on its own it would show `into`
    // live on somebody else's channel until the next poll.
    const twitchOf = (id: string) => db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?')
      .get(id) as { twitch_id: string | null; twitch_name: string | null };
    const gone = twitchOf(from);
    if (gone.twitch_id && !twitchOf(into).twitch_id) {
      // Cleared first: twitch_id is unique, and both rows still exist here.
      db.prepare('UPDATE players SET twitch_id = NULL, twitch_name = NULL WHERE steamid = ?').run(from);
      db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
        .run(gone.twitch_id, gone.twitch_name, into);
      db.prepare('UPDATE OR IGNORE twitch_status SET player_id = ? WHERE player_id = ?').run(into, from);
    }
    db.prepare('DELETE FROM twitch_status WHERE player_id = ?').run(from);

    for (const [table, column] of KEYED) {
      db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(into, from);
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(from);
    }

    // 3. Ratings are not moved, they are discarded. Both accounts' numbers
    //    were computed against rosters that no longer exist, so carrying
    //    either one forward would be carrying the error forward. The
    //    recompute below rebuilds them from the merged rosters.
    db.prepare('DELETE FROM rating_history WHERE player_id IN (?, ?)').run(from, into);
    db.prepare('DELETE FROM player_ratings WHERE player_id = ?').run(from);

    // 4. Endorsements have TWO player columns inside one primary key
    //    (match_id, from_id, to_id), so they fit neither PLAIN nor KEYED: a
    //    row can collide on either column independently of the other. Each
    //    column is moved and its leftovers dropped in turn, the same way
    //    KEYED does it, then a row that now points at the same player on
    //    both sides is dropped rather than survive as a self endorsement.
    db.prepare('UPDATE OR IGNORE endorsements SET from_id = ? WHERE from_id = ?').run(into, from);
    db.prepare('DELETE FROM endorsements WHERE from_id = ?').run(from);
    db.prepare('UPDATE OR IGNORE endorsements SET to_id = ? WHERE to_id = ?').run(into, from);
    db.prepare('DELETE FROM endorsements WHERE to_id = ?').run(from);
    db.prepare('DELETE FROM endorsements WHERE from_id = to_id').run();

    // The alias outlives the player row and is the whole reason this merge
    // is not a one-off tidy-up: without it the same person logs in on the
    // same alt tomorrow and a second identity is created again.
    // Aliases that pointed at the losing account follow it, rather than being
    // dropped: somebody with three accounts merged two at a time would
    // otherwise lose the first alias here, and that id would be free to
    // become an identity again. Must run BEFORE addAlias, which refuses to
    // alias an account that is still canonical for someone else.
    db.prepare('UPDATE player_aliases SET canonical_id = ? WHERE canonical_id = ?').run(into, from);
    db.prepare('DELETE FROM players WHERE steamid = ?').run(from);
    addAlias(db, { steamid: from, canonical: into, by: opts.by ?? 'merge' });
  })();

  // Outside the transaction above because it opens its own.
  for (const season of seasons) recomputeSeasonRatings(db, season);
  return plan;
}
