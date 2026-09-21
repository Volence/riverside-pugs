import type { DB } from '../db.js';
import type { PhaseState } from '../logParse.js';
import { phaseFor } from '../liveView.js';
import { spectateFor, type SpectateInfo } from '../spectate.js';
import { holdMaxSeconds, remainingNow, type PresenceRow } from '../presence.js';

/**
 * The admin live board: every ongoing match, who is missing from it, and the
 * clocks running against it.
 *
 * Every duration here is whole seconds AS OF `now`, and the payload says what
 * `now` was. The browser counts on from the moment it received the payload,
 * so a wrong clock on an admin's PC cannot move a countdown that decides
 * whether someone gets banned.
 */

/** The slice of discord/voicePresence.ts this needs. Null answer = unknown. */
export interface VoiceLookup { inVoice(discordId: string): boolean | null }

/** Why someone is not on the server, when something on record says so. There
 *  is deliberately no "Steam ID not verified" kind: the plugin kicks for that
 *  exactly when it could not read a SteamID, so there is nobody to pin it on
 *  and no line is sent. */
export type BoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };

export type BoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  | { kind: 'never_connected'; sincePopS: number }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };

export interface BoardPlayer { steamid: string; name: string; team: 'a' | 'b'; status: BoardStatus; reason: BoardReason | null }

/** One running clock. Part one has only the abandon allowance; the no-show
 *  clock joins this union in part two. */
export interface BoardClock { kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null }

export interface BoardMatch {
  id: number;
  campaign: string;
  map: string | null;
  /** waiting = configuring with no server yet; paused = live and the game is paused. */
  state: 'waiting' | 'configuring' | 'live' | 'paused';
  phase: PhaseState | null;
  server: { id: number; name: string } | null;
  teamAScore: number;
  teamBScore: number;
  /** Since it went live, or since the pop while it has not. */
  elapsedS: number;
  spectate: SpectateInfo | null;
  leaveControl: 'ok' | 'old_plugin' | 'unknown';
  teamA: BoardPlayer[];
  teamB: BoardPlayer[];
  clocks: BoardClock[];
}

export interface LiveBoard { now: string; holdMaxMinutes: number; matches: BoardMatch[] }

/** sqlite's datetime('now') or an ISO string, as epoch milliseconds. */
const toMs = (t: string): number => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
const secondsSince = (ms: number, now: Date): number => Math.max(0, Math.floor((now.getTime() - ms) / 1000));

interface MatchRow {
  id: number; campaign: string; state: 'configuring' | 'live'; serverId: number | null; serverName: string | null;
  createdAt: string; wentLiveAt: string | null; leaveControl: number | null; currentMap: string | null;
}

interface PlayerRow extends Partial<Pick<PresenceRow, 'state' | 'since' | 'remaining_s' | 'remaining_at' | 'held' | 'hold_until'>> {
  steamid: string; name: string; team: 'a' | 'b'; discordId: string | null; connectedAt: string | null;
}

export function buildLiveBoard(db: DB, opts: { voice: VoiceLookup | null; now?: Date }): LiveBoard {
  const now = opts.now ?? new Date();
  const matches = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.server_id AS serverId, s.name AS serverName,
            m.created_at AS createdAt, m.went_live_at AS wentLiveAt, m.leave_control AS leaveControl,
            l.current_map AS currentMap
     FROM matches m
     LEFT JOIN servers s ON s.id = m.server_id
     LEFT JOIN match_live l ON l.match_id = m.id
     WHERE m.state IN ('configuring', 'live') ORDER BY m.id DESC`,
  ).all() as MatchRow[];

  const playersOf = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, mp.team, p.discord_id AS discordId, mp.connected_at AS connectedAt,
            pr.state, pr.since, pr.remaining_s, pr.remaining_at, pr.held, pr.hold_until
     FROM match_players mp
     JOIN players p ON p.steamid = mp.player_id
     LEFT JOIN match_presence pr ON pr.match_id = mp.match_id AND pr.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY mp.team, p.name`,
  );
  const scoreOf = db.prepare(
    'SELECT COALESCE(SUM(team_a_score), 0) AS a, COALESCE(SUM(team_b_score), 0) AS b FROM match_live_maps WHERE match_id = ?',
  );
  // Since the pop, and with no entry after it: markEntered stamps every open
  // drop the moment the same steamid gets in, so this is "still not in".
  const dropOf = db.prepare(
    'SELECT at FROM signon_drops WHERE steamid = ? AND at >= ? AND entered_after_at IS NULL ORDER BY id DESC LIMIT 1',
  );

  return {
    now: now.toISOString(),
    holdMaxMinutes: Math.round(holdMaxSeconds(db) / 60),
    matches: matches.map((m) => {
      const poppedMs = toMs(m.createdAt);
      const poppedIso = new Date(poppedMs).toISOString();
      const phase = m.state === 'live' ? phaseFor(db, m.id) : null;
      const score = scoreOf.get(m.id) as { a: number; b: number };

      const players = (playersOf.all(m.id) as PlayerRow[]).map((p): BoardPlayer => {
        let status: BoardStatus;
        if (p.state === 'dropped' && p.since) {
          const held = p.held === 1;
          status = {
            kind: 'dropped',
            sinceS: secondsSince(Date.parse(p.since), now),
            remainingS: remainingNow({ state: 'dropped', remaining_s: p.remaining_s ?? null, remaining_at: p.remaining_at ?? null, held: p.held ?? 0 }, now),
            held,
            holdLeftS: held && p.hold_until ? Math.max(0, Math.ceil((Date.parse(p.hold_until) - now.getTime()) / 1000)) : null,
          };
        } else if (p.state === 'connected' || p.connectedAt !== null) {
          // connected_at alone covers a match that was already running when
          // this table arrived, and a box whose first connect line was lost.
          status = { kind: 'connected', remainingS: p.remaining_s ?? null };
        } else {
          status = { kind: 'never_connected', sincePopS: secondsSince(poppedMs, now) };
        }

        let reason: BoardReason | null = null;
        if (status.kind !== 'connected') {
          const drop = dropOf.get(p.steamid, poppedIso) as { at: string } | undefined;
          if (drop) reason = { kind: 'signon_drop', at: drop.at };
          else if (opts.voice && p.discordId && opts.voice.inVoice(p.discordId) === false) reason = { kind: 'not_in_voice' };
        }
        return { steamid: p.steamid, name: p.name, team: p.team, status, reason };
      });

      const clocks: BoardClock[] = [];
      for (const p of players) {
        if (p.status.kind === 'dropped' && p.status.remainingS !== null) {
          clocks.push({ kind: 'abandon', steamid: p.steamid, name: p.name, remainingS: p.status.remainingS, held: p.status.held, holdLeftS: p.status.holdLeftS });
        }
      }

      return {
        id: m.id,
        campaign: m.campaign,
        map: m.currentMap,
        state: m.state === 'configuring'
          ? (m.serverId === null ? 'waiting' : 'configuring')
          : (phase?.state === 'paused' ? 'paused' : 'live'),
        phase: phase?.state ?? null,
        server: m.serverId !== null && m.serverName !== null ? { id: m.serverId, name: m.serverName } : null,
        teamAScore: score.a,
        teamBScore: score.b,
        elapsedS: secondsSince(m.wentLiveAt ? toMs(m.wentLiveAt) : poppedMs, now),
        spectate: spectateFor(db, m.serverId),
        leaveControl: m.leaveControl === null ? 'unknown' : m.leaveControl === 1 ? 'ok' : 'old_plugin',
        teamA: players.filter((p) => p.team === 'a'),
        teamB: players.filter((p) => p.team === 'b'),
        clocks,
      };
    }),
  };
}
