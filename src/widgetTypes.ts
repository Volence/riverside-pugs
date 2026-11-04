/**
 * Stream widget shapes shared by the server and the browser. No imports, so
 * the web project can include this file as it is (pattern: src/cast/types.ts).
 * The payload is built in src/widgets.ts and served by GET /api/widget/:steamid.
 */

export const WIDGET_KINDS = ['live', 'rating', 'session', 'last', 'queue'] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];

/** How long a finished match stays on the live widget, marked final. */
export const RECENT_FINAL_MS = 5 * 60_000;

export interface WidgetLiveTeam { side: 'a' | 'b'; names: string[]; score: number; mine: boolean }

export interface WidgetLive {
  matchId: number; campaign: string; currentMap: string | null;
  /** Finished maps. */
  mapsPlayed: number;
  /** Maps in the campaign plan, null if unknown. */
  mapsTotal: number | null;
  /** The streamer's team and the other one. Totals include halfTime. */
  mine: WidgetLiveTeam; theirs: WidgetLiveTeam;
  /** Finished maps; ordinals are 0-based. */
  maps: { ordinal: number; map: string; mine: number; theirs: number }[];
  /** The first half of the map in progress, after the live delay. */
  halfTime: { ordinal: number; mineSurvived: boolean; score: number } | null;
  /** True during the hold after the match ended (RECENT_FINAL_MS). */
  final: boolean;
}

export interface WidgetRating {
  /** Null while placing. */
  sr: number | null;
  /** The rank's name, e.g. "Gold II". */
  rank: string | null;
  placing: { played: number; of: number } | null;
  /** Place on the current season's leaderboard, null when unranked. */
  position: number | null;
  wins: number; losses: number;
  /** SR change since the streamer's local midnight. */
  todayDelta: number;
}

export interface WidgetSession { since: number; srDelta: number; wins: number; losses: number }

export interface WidgetLastMatch {
  matchId: number; campaign: string;
  /** sqlite UTC 'YYYY-MM-DD HH:MM:SS'. */
  endedAt: string;
  result: 'win' | 'loss' | 'draw';
  mine: number; theirs: number; srDelta: number | null;
  stats: { siDamage: number; skeets: number; commons: number };
}

export interface WidgetPayload {
  serverNow: number; theme: string | null;
  player: { steamid: string; name: string };
  live: WidgetLive | null; rating: WidgetRating | null; session: WidgetSession | null;
  last: WidgetLastMatch | null; queue: { count: number; size: number; inQueue: boolean } | null;
}
