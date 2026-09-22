import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { resolveAlias } from './aliases.js';

/**
 * What Steam says about an account, fetched, stored and turned into the two
 * things worth interrupting an admin for.
 *
 * Every call is best effort and independent. A private profile, a rate limit
 * or an outage leaves that one signal unknown and never throws, because every
 * caller is on a path that matters more than this does: a login, a match going
 * live, a timer. No api key means no signals at all, silently.
 *
 * Admin-only. Nothing read from here belongs in a public payload.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.steampowered.com';
/** Left 4 Dead, the first one. */
const L4D1_APPID = 500;

/** How old a row may get before the background refresher takes it again. */
export const SIGNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Players per background pass. Two batch requests plus two per player, so a
 *  pass is a dozen calls against a daily allowance of 100,000, and a community
 *  of a few hundred is walked in about an hour after the first deploy. */
export const SIGNAL_BATCH = 5;
/** One pass a minute, and never a second one while the first is still out. */
export const SIGNAL_REFRESH_MS = 60_000;
/** A ban older than this is history rather than news for the admin feed. */
export const RECENT_BAN_DAYS = 365;

export interface SummarySignal {
  /** Unix seconds. Null when the profile is private: Steam leaves it out. */
  timeCreated: number | null;
  /** communityvisibilitystate. 3 is public. */
  visibility: number | null;
  profileState: number | null;
}

export interface BanSignal {
  vacBanned: boolean;
  vacBans: number;
  gameBans: number;
  daysSinceLastBan: number;
  communityBanned: boolean;
  economyBan: string;
}

export interface GamesSignal {
  /** False when game details are private, which Steam says with an empty
   *  response. Then the minutes are unknown, never zero. */
  visible: boolean;
  /** Null with `visible`: L4D1 is not in the library at all. */
  l4d1Minutes: number | null;
}

/** One account's answers. A null group is a call that failed or said nothing
 *  about this id; it is never a finding. */
export interface FetchedSignals {
  summary: SummarySignal | null;
  bans: BanSignal | null;
  games: GamesSignal | null;
  level: number | null;
  /** Null: not asked, or the call failed. `lender` null: playing their own copy
   *  (or not playing at all, which Steam answers the same way). */
  sharing: { lender: string | null } | null;
}

export interface FetchOpts {
  /** The per-player endpoints: owned games and level. On by default. */
  details?: boolean;
  /** IsPlayingSharedGame. Only meaningful while the player is in game. */
  sharing?: boolean;
}

async function getJson(url: string, fetchFn: FetchFn): Promise<any | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Null when any request failed, so a caller can tell "Steam said nothing
 *  about this id" from "Steam did not answer". Up to 100 ids per request. */
async function fetchSummaries(ids: string[], key: string, fetchFn: FetchFn): Promise<Map<string, SummarySignal> | null> {
  const out = new Map<string, SummarySignal>();
  for (let i = 0; i < ids.length; i += 100) {
    const data = await getJson(
      `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${ids.slice(i, i + 100).join(',')}`, fetchFn,
    );
    if (!Array.isArray(data?.response?.players)) return null;
    for (const p of data.response.players) {
      if (typeof p?.steamid !== 'string') continue;
      out.set(p.steamid, {
        timeCreated: int(p.timecreated),
        visibility: int(p.communityvisibilitystate),
        profileState: int(p.profilestate),
      });
    }
  }
  return out;
}

/** GetPlayerBans answers with no `response` wrapper and spells the id `SteamId`. */
async function fetchBans(ids: string[], key: string, fetchFn: FetchFn): Promise<Map<string, BanSignal> | null> {
  const out = new Map<string, BanSignal>();
  for (let i = 0; i < ids.length; i += 100) {
    const data = await getJson(
      `${API}/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${ids.slice(i, i + 100).join(',')}`, fetchFn,
    );
    if (!Array.isArray(data?.players)) return null;
    for (const p of data.players) {
      if (typeof p?.SteamId !== 'string') continue;
      out.set(p.SteamId, {
        vacBanned: p.VACBanned === true,
        vacBans: int(p.NumberOfVACBans) ?? 0,
        gameBans: int(p.NumberOfGameBans) ?? 0,
        daysSinceLastBan: int(p.DaysSinceLastBan) ?? 0,
        communityBanned: p.CommunityBanned === true,
        economyBan: typeof p.EconomyBan === 'string' ? p.EconomyBan : 'none',
      });
    }
  }
  return out;
}

async function fetchL4d1Playtime(id: string, key: string, fetchFn: FetchFn): Promise<GamesSignal | null> {
  const data = await getJson(
    `${API}/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${id}` +
    `&include_played_free_games=1&appids_filter[0]=${L4D1_APPID}`,
    fetchFn,
  );
  const r = data?.response;
  if (!r || typeof r !== 'object') return null;
  // Private game details come back as an empty object, not as an empty list.
  if (r.game_count === undefined && r.games === undefined) return { visible: false, l4d1Minutes: null };
  const game = Array.isArray(r.games) ? r.games.find((g: any) => g?.appid === L4D1_APPID) : undefined;
  return { visible: true, l4d1Minutes: game ? int(game.playtime_forever) : null };
}

async function fetchLevel(id: string, key: string, fetchFn: FetchFn): Promise<number | null> {
  const data = await getJson(`${API}/IPlayerService/GetSteamLevel/v1/?key=${key}&steamid=${id}`, fetchFn);
  return int(data?.response?.player_level);
}

async function fetchLender(id: string, key: string, fetchFn: FetchFn): Promise<{ lender: string | null } | null> {
  const data = await getJson(
    `${API}/IPlayerService/IsPlayingSharedGame/v1/?key=${key}&steamid=${id}&appid_playing=${L4D1_APPID}`, fetchFn,
  );
  const lender = data?.response?.lender_steamid;
  if (typeof lender !== 'string') return null;
  return { lender: /^\d{17}$/.test(lender) ? lender : null };
}

/** Everything Steam will say about these accounts. One entry per id asked
 *  for, whatever failed; empty without an api key. Never throws. */
export async function fetchSteamSignals(
  steamids: string[], apiKey: string | null, fetchFn: FetchFn = fetch, opts: FetchOpts = {},
): Promise<Map<string, FetchedSignals>> {
  const out = new Map<string, FetchedSignals>();
  if (!apiKey || steamids.length === 0) return out;
  const ids = [...new Set(steamids)];
  const [summaries, bans] = await Promise.all([
    fetchSummaries(ids, apiKey, fetchFn), fetchBans(ids, apiKey, fetchFn),
  ]);
  for (const id of ids) {
    out.set(id, {
      summary: summaries?.get(id) ?? null,
      bans: bans?.get(id) ?? null,
      games: opts.details === false ? null : await fetchL4d1Playtime(id, apiKey, fetchFn),
      level: opts.details === false ? null : await fetchLevel(id, apiKey, fetchFn),
      sharing: opts.sharing ? await fetchLender(id, apiKey, fetchFn) : null,
    });
  }
  return out;
}

export interface SteamSignalRow {
  steamid: string;
  time_created: number | null;
  visibility: number | null;
  profile_state: number | null;
  vac_banned: number | null;
  vac_bans: number | null;
  game_bans: number | null;
  days_since_last_ban: number | null;
  community_banned: number | null;
  economy_ban: string | null;
  bans_checked_at: string | null;
  games_visible: number | null;
  l4d1_minutes: number | null;
  steam_level: number | null;
  lender_id: string | null;
  lender_seen_at: string | null;
  checked_at: string;
}

export function getSteamSignals(db: DB, steamid: string): SteamSignalRow | null {
  return (db.prepare('SELECT * FROM player_steam_signals WHERE steamid = ?').get(steamid) as
    SteamSignalRow | undefined) ?? null;
}

/** Days since the last ban as of `now`. Steam sends an age rather than a date,
 *  so the stored figure is only right on the day it was read. */
export function daysSinceLastBan(row: SteamSignalRow, now: Date): number | null {
  if (row.days_since_last_ban === null || !row.bans_checked_at) return null;
  const elapsed = Math.floor((now.getTime() - Date.parse(row.bans_checked_at)) / 86_400_000);
  return row.days_since_last_ban + Math.max(0, elapsed);
}

/**
 * Write what came back, and only what came back. A group that is null leaves
 * its columns exactly as they were: yesterday's answer beats no answer, and a
 * NULL written over a known ban count would read as "checked, nothing there".
 */
function storeSignals(db: DB, steamid: string, s: FetchedSignals, now: Date): void {
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO player_steam_signals (steamid, checked_at) VALUES (?, ?)
     ON CONFLICT(steamid) DO UPDATE SET checked_at = excluded.checked_at`,
  ).run(steamid, iso);
  if (s.summary) {
    db.prepare(
      `UPDATE player_steam_signals
          SET time_created = COALESCE(?, time_created), visibility = ?, profile_state = ? WHERE steamid = ?`,
    ).run(s.summary.timeCreated, s.summary.visibility, s.summary.profileState, steamid);
  }
  if (s.bans) {
    db.prepare(
      `UPDATE player_steam_signals
          SET vac_banned = ?, vac_bans = ?, game_bans = ?, days_since_last_ban = ?, community_banned = ?,
              economy_ban = ?, bans_checked_at = ? WHERE steamid = ?`,
    ).run(
      s.bans.vacBanned ? 1 : 0, s.bans.vacBans, s.bans.gameBans, s.bans.daysSinceLastBan,
      s.bans.communityBanned ? 1 : 0, s.bans.economyBan, iso, steamid,
    );
  }
  if (s.games) {
    // Hidden keeps the last figure seen, for "was 4 h when last visible".
    // Visible overwrites it even with NULL: the game has left the library.
    if (s.games.visible) {
      db.prepare('UPDATE player_steam_signals SET games_visible = 1, l4d1_minutes = ? WHERE steamid = ?')
        .run(s.games.l4d1Minutes, steamid);
    } else {
      db.prepare('UPDATE player_steam_signals SET games_visible = 0 WHERE steamid = ?').run(steamid);
    }
  }
  if (s.level !== null) {
    db.prepare('UPDATE player_steam_signals SET steam_level = ? WHERE steamid = ?').run(s.level, steamid);
  }
  if (s.sharing?.lender) {
    db.prepare('UPDATE player_steam_signals SET lender_id = ?, lender_seen_at = ? WHERE steamid = ?')
      .run(s.sharing.lender, iso, steamid);
  }
}

export interface SignalDeps {
  db: DB;
  apiKey: string | null;
  fetchFn?: FetchFn;
  now?: () => Date;
}

export interface RefreshOpts {
  /** Also ask whose copy of the game is being played. */
  sharing?: boolean;
  /** Skip everything but the sharing check for a row checked this recently. */
  freshMs?: number;
  /** The live match these players are rostered in. Only a refresh made for a
   *  match raises admin feed alerts: login and the background pass do not. */
  matchId?: number;
}

/** Banned on THIS site, following a merge: a lender that was folded into
 *  another account is that account. */
function bannedHere(db: DB, steamid: string): boolean {
  const row = db.prepare('SELECT status FROM players WHERE steamid = ?').get(resolveAlias(db, steamid)) as
    { status: string } | undefined;
  return row?.status === 'banned';
}

/** True the first time this player, condition and marker are seen together. */
function firstAlert(db: DB, steamid: string, kind: string, marker: string, matchId: number, now: Date): boolean {
  return db.prepare(
    'INSERT OR IGNORE INTO steam_signal_alerts (player_id, kind, marker, match_id, at) VALUES (?, ?, ?, ?, ?)',
  ).run(steamid, kind, marker, matchId, now.toISOString()).changes === 1;
}

function raiseAlerts(db: DB, steamid: string, lenderNow: string | null, matchId: number, now: Date): void {
  const row = getSteamSignals(db, steamid);
  if (!row) return;
  const bans = (row.vac_bans ?? 0) + (row.game_bans ?? 0);
  const days = daysSinceLastBan(row, now);
  // Keyed on the count, so a second ban on an account already posted about is
  // news again while the same ban is not.
  if (bans > 0 && days !== null && days < RECENT_BAN_DAYS && firstAlert(db, steamid, 'recent_ban', String(bans), matchId, now)) {
    publishAdminEvent({
      kind: 'steam_signal', steamid, matchId,
      signal: { what: 'recent_ban', vacBans: row.vac_bans ?? 0, gameBans: row.game_bans ?? 0, daysSinceLastBan: days },
    });
  }
  // Only the lender Steam named just now. The stored one may be months old,
  // and the point is what the player is playing on in this match.
  if (lenderNow && bannedHere(db, lenderNow) && firstAlert(db, steamid, 'banned_lender', lenderNow, matchId, now)) {
    publishAdminEvent({ kind: 'steam_signal', steamid, matchId, signal: { what: 'banned_lender', lenderId: lenderNow } });
  }
}

/**
 * Refresh these players' rows. Returns how many rows were written. Ids that
 * are not players are ignored: the row hangs off the players table.
 *
 * Never throws, so it can be fired and forgotten from a login or a log event.
 */
export async function refreshSteamSignals(deps: SignalDeps, steamids: string[], opts: RefreshOpts = {}): Promise<number> {
  if (!deps.apiKey) return 0;
  try {
    const { db } = deps;
    const now = deps.now?.() ?? new Date();
    const known = db.prepare('SELECT 1 FROM players WHERE steamid = ?');
    const ids = [...new Set(steamids)].filter((id) => known.get(id));
    if (ids.length === 0) return 0;

    const fresh = (id: string): boolean => {
      if (!opts.freshMs) return false;
      const row = getSteamSignals(db, id);
      return row !== null && now.getTime() - Date.parse(row.checked_at) < opts.freshMs;
    };
    const due = ids.filter((id) => !fresh(id));
    const sharingOnly = opts.sharing ? ids.filter((id) => !due.includes(id)) : [];

    const key = deps.apiKey;
    const fetchFn = deps.fetchFn ?? fetch;
    const [summaries, bans] = due.length > 0
      ? await Promise.all([fetchSummaries(due, key, fetchFn), fetchBans(due, key, fetchFn)])
      : [null, null];
    // Neither batch call answered: Steam is down or the key is refused. Stop
    // here rather than stamp rows as checked with nothing learned, which
    // would park them for a week, and rather than go on to ask a dead API
    // two more questions per player.
    if (due.length > 0 && !summaries && !bans) return 0;
    const fetched = new Map<string, FetchedSignals>();
    for (const id of due) {
      fetched.set(id, {
        summary: summaries?.get(id) ?? null,
        bans: bans?.get(id) ?? null,
        games: await fetchL4d1Playtime(id, key, fetchFn),
        level: await fetchLevel(id, key, fetchFn),
        sharing: opts.sharing ? await fetchLender(id, key, fetchFn) : null,
      });
    }

    let written = 0;
    const lenderNow = new Map<string, string | null>();
    for (const id of due) {
      const s = fetched.get(id)!;
      storeSignals(db, id, s, now);
      lenderNow.set(id, s.sharing?.lender ?? null);
      written++;
    }
    for (const id of sharingOnly) {
      const sharing = await fetchLender(id, key, fetchFn);
      lenderNow.set(id, sharing?.lender ?? null);
      if (sharing?.lender) {
        db.prepare('UPDATE player_steam_signals SET lender_id = ?, lender_seen_at = ? WHERE steamid = ?')
          .run(sharing.lender, now.toISOString(), id);
        written++;
      }
    }
    if (opts.matchId !== undefined) {
      for (const id of ids) raiseAlerts(db, id, lenderNow.get(id) ?? null, opts.matchId, now);
    }
    return written;
  } catch (err) {
    console.error('[steamSignals] refresh failed:', err);
    return 0;
  }
}

/** One background pass: players never checked first, then the longest
 *  unchecked past SIGNAL_MAX_AGE_MS. Sharing is not asked, because nobody
 *  picked by age is known to be in game. */
export async function refreshStaleSignals(deps: SignalDeps): Promise<number> {
  if (!deps.apiKey) return 0;
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - SIGNAL_MAX_AGE_MS).toISOString();
  const rows = deps.db.prepare(
    `SELECT p.steamid FROM players p LEFT JOIN player_steam_signals s ON s.steamid = p.steamid
      WHERE s.steamid IS NULL OR s.checked_at < ?
      ORDER BY s.checked_at IS NOT NULL, s.checked_at LIMIT ?`,
  ).all(cutoff, SIGNAL_BATCH) as { steamid: string }[];
  return refreshSteamSignals(deps, rows.map((r) => r.steamid));
}

/** Start the background refresher. Returns the stop function for the server's
 *  onClose hook. A no-op without an api key. */
export function startSteamSignalRefresh(deps: SignalDeps): () => void {
  if (!deps.apiKey) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void refreshStaleSignals(deps)
      .catch((err) => console.error('[steamSignals] background pass threw:', err))
      .finally(() => { running = false; });
  }, SIGNAL_REFRESH_MS);
  // Never hold the process open for a profile lookup.
  timer.unref?.();
  return () => clearInterval(timer);
}
