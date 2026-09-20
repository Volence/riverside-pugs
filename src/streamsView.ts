import type { DB } from './db.js';
import { twitchCacheStale } from './twitchPoll.js';

/** How many offline channels the page shows before "show all". The page has to
 *  stay a list of streamers rather than becoming an avatar wall of everyone
 *  who ever linked: the community grows and the page should not. */
export const OFFLINE_CAP = 24;

export interface StreamMatch { id: number; campaign: string; map: string | null }

export interface StreamCard {
  steamid: string;
  name: string;
  avatar: string | null;
  /** The Twitch login. The twitch id is never serialised: it is an internal
   *  join key, and a test pins that it does not appear on any card. */
  twitchName: string;
  title: string;
  gameName: string;
  viewers: number;
  /** Twitch's template, {width}x{height} intact. Substituted at render. */
  thumbnail: string;
  startedAt: string | null;
  /** The PUG this stream is of, when there is one. */
  match: StreamMatch | null;
}

export interface OfflineCard {
  steamid: string;
  name: string;
  avatar: string | null;
  twitchName: string;
  lastLiveAt: string | null;
}

export interface StreamsView {
  /** True when the poll cache is too old to claim anyone is live. */
  stale: boolean;
  inPug: StreamCard[];
  live: StreamCard[];
  offline: OfflineCard[];
  /** How many offline channels exist, which is not offline.length once capped. */
  offlineTotal: number;
}

interface Row {
  steamid: string; name: string; avatar: string | null; twitch_name: string;
  is_live: number | null; title: string | null; game_name: string | null;
  viewers: number | null; thumbnail: string | null; started_at: string | null;
  last_live_at: string | null;
}

/**
 * The three tiers.
 *
 * `engaged` is the set of steamids in the queue or in a lobby right now. It is
 * passed in rather than read, because the queue lives in memory in the
 * matchmaker and nothing good comes of making the query layer reach for it.
 */
export function streamsView(
  db: DB,
  opts: { engaged: string[]; all?: boolean; now?: Date },
): StreamsView {
  const now = opts.now ?? new Date();
  const stale = twitchCacheStale(db, now);

  // LEFT JOIN, so somebody who linked a minute ago and has never been polled
  // still appears, as offline, rather than vanishing until the next tick.
  const rows = db.prepare(
    `SELECT p.steamid, p.name, p.avatar, p.twitch_name,
            t.is_live, t.title, t.game_name, t.viewers, t.thumbnail, t.started_at, t.last_live_at
     FROM players p
     LEFT JOIN twitch_status t ON t.player_id = p.steamid
     WHERE p.twitch_id IS NOT NULL AND p.twitch_name IS NOT NULL`,
  ).all() as Row[];

  // Who is on a live match roster, and which match. A player on two live
  // matches is not a state the matchmaker can produce, so first wins.
  const liveMatches = db.prepare(
    `SELECT mp.player_id, m.id, m.campaign, ml.current_map
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     LEFT JOIN match_live ml ON ml.match_id = m.id
     WHERE m.state = 'live'`,
  ).all() as { player_id: string; id: number; campaign: string; current_map: string | null }[];
  const matchOf = new Map<string, StreamMatch>();
  for (const r of liveMatches) {
    if (!matchOf.has(r.player_id)) {
      matchOf.set(r.player_id, { id: r.id, campaign: r.campaign, map: r.current_map });
    }
  }

  const engaged = new Set(opts.engaged);

  const inPug: StreamCard[] = [];
  const live: StreamCard[] = [];
  const offline: OfflineCard[] = [];

  for (const r of rows) {
    // A stale cache means we do not know, and "we do not know" is reported as
    // not-live rather than as a claim.
    const isLive = !stale && r.is_live === 1;
    if (!isLive) {
      offline.push({
        steamid: r.steamid,
        name: r.name,
        avatar: r.avatar,
        twitchName: r.twitch_name,
        lastLiveAt: r.last_live_at,
      });
      continue;
    }
    const match = matchOf.get(r.steamid) ?? null;
    const card: StreamCard = {
      steamid: r.steamid,
      name: r.name,
      avatar: r.avatar,
      twitchName: r.twitch_name,
      title: r.title ?? '',
      gameName: r.game_name ?? '',
      viewers: r.viewers ?? 0,
      thumbnail: r.thumbnail ?? '',
      startedAt: r.started_at,
      match,
    };
    if (match || engaged.has(r.steamid)) inPug.push(card);
    else live.push(card);
  }

  const byViewers = (a: StreamCard, b: StreamCard) => b.viewers - a.viewers;
  inPug.sort(byViewers);
  live.sort(byViewers);

  // Most recently live first. Never seen live sorts last rather than first,
  // which is what an empty string compared as a date would do.
  offline.sort((a, b) => {
    if (a.lastLiveAt === b.lastLiveAt) return a.name.localeCompare(b.name);
    if (a.lastLiveAt === null) return 1;
    if (b.lastLiveAt === null) return -1;
    return b.lastLiveAt.localeCompare(a.lastLiveAt);
  });

  return {
    stale,
    inPug,
    live,
    offline: opts.all ? offline : offline.slice(0, OFFLINE_CAP),
    offlineTotal: offline.length,
  };
}
