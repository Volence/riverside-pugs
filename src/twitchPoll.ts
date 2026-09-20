import type { DB } from './db.js';
import type { TwitchApi } from './twitch/api.js';
import { getSetting, setSetting } from './settings.js';

/** When the poller last completed a pass, successfully.
 *
 *  A setting rather than MAX(twitch_status.checked_at), because those two
 *  answer different questions and the difference is user-visible. An empty
 *  twitch_status is a perfectly healthy state: nobody has linked, or somebody
 *  linked ten seconds ago and the next tick has not come round yet. Reading
 *  "no rows" as "the poller is dead" put a "status unavailable" banner on the
 *  Streams page for the first 60 s after the very first player linked. */
const POLLED_AT = 'twitch_polled_at';

/** Helix takes 100 channels per request, so the whole community is one call
 *  whatever the interval. Polling faster than this buys nothing real: Twitch's
 *  own stream data lags by around a minute. */
export const TWITCH_POLL_MS = 60_000;

/** How old the last successful poll may be before the read path stops
 *  claiming anyone is live. A wrong "offline" is a shrug; a LIVE badge stuck
 *  on forever because the poller died makes the page untrustworthy. */
export const TWITCH_STALE_MS = 10 * 60_000;

interface LinkedRow { steamid: string; twitch_id: string; twitch_name: string | null }

/**
 * Refresh the cache for every linked channel.
 *
 * Failure leaves the cache exactly as it was, checked_at included, so the
 * staleness check can notice. Writing checked_at on a failed poll would be the
 * one thing that defeats it.
 */
export async function pollTwitch(db: DB, api: TwitchApi, now: Date = new Date()): Promise<void> {
  // An unlinked player's row is deleted here as well as in unlinkTwitch, so a
  // row orphaned by any other path (a merge, a manual edit) still goes away.
  db.exec(`DELETE FROM twitch_status WHERE player_id NOT IN
           (SELECT steamid FROM players WHERE twitch_id IS NOT NULL)`);

  const linked = db.prepare(
    'SELECT steamid, twitch_id, twitch_name FROM players WHERE twitch_id IS NOT NULL',
  ).all() as LinkedRow[];
  if (linked.length === 0) {
    // Nothing to ask Twitch, but the pass completed. Recording it is what
    // stops an empty table reading as a dead poller.
    setSetting(db, POLLED_AT, now.toISOString());
    return;
  }

  let streams;
  try {
    streams = await api.getStreams(linked.map((r) => r.twitch_id));
  } catch (err) {
    console.error('[twitch] poll failed, keeping the previous cache:', err);
    return;
  }

  const byId = new Map(streams.map((s) => [s.userId, s]));
  const iso = now.toISOString();

  const write = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO twitch_status
         (player_id, is_live, title, game_name, viewers, thumbnail, started_at, last_live_at, checked_at)
       VALUES (@player_id, @is_live, @title, @game_name, @viewers, @thumbnail, @started_at, @last_live_at, @checked_at)
       ON CONFLICT(player_id) DO UPDATE SET
         is_live = excluded.is_live,
         title = excluded.title,
         game_name = excluded.game_name,
         viewers = excluded.viewers,
         thumbnail = excluded.thumbnail,
         started_at = excluded.started_at,
         -- Only ever moves forward. An offline poll must not erase when they
         -- were last seen, because that is what orders the offline tier.
         last_live_at = COALESCE(excluded.last_live_at, twitch_status.last_live_at),
         checked_at = excluded.checked_at`,
    );
    const rename = db.prepare('UPDATE players SET twitch_name = ? WHERE steamid = ?');
    for (const row of linked) {
      const s = byId.get(row.twitch_id);
      upsert.run({
        player_id: row.steamid,
        is_live: s ? 1 : 0,
        title: s?.title ?? null,
        game_name: s?.gameName ?? null,
        viewers: s?.viewers ?? null,
        thumbnail: s?.thumbnailUrl ?? null,
        started_at: s?.startedAt ?? null,
        last_live_at: s ? iso : null,
        checked_at: iso,
      });
      // The login is a cache of something that changes. This is the only place
      // it is refreshed, and it is free here because we already have it. An
      // empty login is a gap in the response, not a rename, so it is ignored:
      // blanking the login would drop the player off the page entirely.
      if (s && s.userLogin && s.userLogin !== row.twitch_name) rename.run(s.userLogin, row.steamid);
    }
    // Inside the transaction, so the heartbeat and the rows it describes land
    // together or not at all.
    setSetting(db, POLLED_AT, iso);
  });
  write();
}

/**
 * True when nothing may be reported as live.
 *
 * Measured from the last COMPLETED pass, not from the newest row, so an empty
 * twitch_status is not mistaken for a dead poller. Also true before the first
 * pass of a fresh process, which is the one case where "we do not know" is
 * genuinely the right answer.
 */
export function twitchCacheStale(db: DB, now: Date = new Date()): boolean {
  const polledAt = getSetting(db, POLLED_AT);
  if (!polledAt) return true;
  const last = Date.parse(polledAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > TWITCH_STALE_MS;
}

/** Start polling. Returns the stop function for the server's onClose hook. */
export function startTwitchPoll(db: DB, api: TwitchApi): () => void {
  const tick = () => {
    void pollTwitch(db, api).catch((err) => {
      console.error('[twitch] poll threw:', err);
    });
  };
  tick();
  const timer = setInterval(tick, TWITCH_POLL_MS);
  // Never hold the process open for a stream status.
  timer.unref?.();
  return () => clearInterval(timer);
}
