import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { discordHistoryOf, getPlayer } from '../players.js';
import { penaltyHistory, activeTimeout } from '../penalties.js';
import { networksOf, sharesAddressWith } from '../playerNetworks.js';
import { capsForPlayer, detectionsForPlayer } from '../inputBursts.js';
import { signonDropSummary } from '../signonDrops.js';
import { ticketsAbout } from '../tickets/views.js';
import { activeBan, searchPlayers, type BanRow } from './players.js';
import { steamAccountView } from './steamAccount.js';
import { integrityPlayer } from './integrity.js';
import { analyzerRankOf } from './analyzerRanks.js';
import { banRedactor } from './banRedaction.js';
import { canOpenFile, fileActions, type FileAction, type FileViewer } from './fileAccess.js';
import { lastReviewOf, type FileReview } from './reviews.js';
import { playerFileSummary, type PlayerFileSummary } from './playerFileSummary.js';
import { playerTimeline } from './playerTimeline.js';
import type { TimelineItem } from './timeline/types.js';

export interface PlayerFile {
  steamid: string;
  header: {
    steamid: string;
    name: string;
    avatar: string | null;
    status: string;
    isAdmin: boolean;
    isMod: boolean;
    discordName: string | null;
    sr: number | null;
    games: number;
    createdAt: string;
  };
  glance: PlayerFileSummary;
  timeline: TimelineItem[];
  sections: {
    identity: ReturnType<typeof identity>;
    standing: {
      activeBan: BanRow | null;
      bans: BanRow[];
      penalties: ReturnType<typeof penaltyHistory>;
      timeout: { until: string; offenses: number } | null;
    };
    matches: unknown[];
    tickets: ReturnType<typeof ticketsAbout>;
    notes: { id: number; authorId: string; authorName: string | null; text: string; createdAt: string }[];
    evidence: ReturnType<typeof evidence>;
  };
  actions: FileAction[];
  lastReview: FileReview | null;
}

/** Aliases, Discord history, the Steam account and the shared connections.
 *  Moderators get all of it: the owner reversed the first ruling the same
 *  day, because "is this a second account" is exactly a moderator's job. */
function identity(db: DB, steamid: string) {
  return {
    aliases: aliasesOf(db, steamid),
    discordHistory: discordHistoryOf(db, steamid),
    steamAccount: steamAccountView(db, steamid),
    networks: networksOf(db, steamid),
    sharesAddressWith: sharesAddressWith(db, steamid),
  };
}

/** The evidence behind the timeline rows, for the reader who wants the
 *  numbers: bursts under an input flag, clips and rounds under an analyzer
 *  row, the drop rows, the live anti-cheat flags. */
function evidence(db: DB, steamid: string) {
  const integrity = integrityPlayer(db, steamid);
  return {
    analyzer: analyzerRankOf(db, steamid),
    rounds: integrity.rounds,
    clips: integrity.clips,
    flags: integrity.flags,
    inputFlags: detectionsForPlayer(db, steamid),
    inputCaps: capsForPlayer(db, steamid),
    signonDrops: signonDropSummary(db, steamid),
  };
}

/**
 * Everything known about one player, in one answer.
 *
 * Null both for a player who does not exist and for a file this viewer may
 * not open, so the route can turn either into the same 404: which members of
 * staff exist is not something to publish through a status code.
 */
export function playerFile(
  db: DB, steamid: string, viewer: FileViewer, now = new Date(),
): PlayerFile | null {
  const canonical = resolveAlias(db, steamid);
  const player = getPlayer(db, canonical);
  if (!player) return null;
  if (!canOpenFile(db, viewer, canonical)) return null;

  const row = searchPlayers(db, canonical, 1).find((p) => p.steamid === canonical);
  const timeline = playerTimeline(db, canonical, viewer.steamid);
  const redact = banRedactor(db, canonical, viewer.steamid);
  const ban = activeBan(db, canonical, now);
  const bans = (db.prepare(
    `SELECT b.*, pc.name AS created_by_name, pl.name AS lifted_by_name FROM bans b
     LEFT JOIN players pc ON pc.steamid = b.created_by
     LEFT JOIN players pl ON pl.steamid = b.lifted_by
     WHERE b.player_id = ? ORDER BY b.id DESC`,
  ).all(canonical) as {
    id: number; reason: string; created_by: string; created_at: string; expires_at: string | null;
    lifted_by: string | null; lifted_at: string | null; created_by_name: string | null; lifted_by_name: string | null;
  }[]).map((b) => redact({
    id: b.id, reason: b.reason, createdBy: b.created_by, createdAt: b.created_at,
    expiresAt: b.expires_at, liftedBy: b.lifted_by, liftedAt: b.lifted_at,
    createdByName: b.created_by_name, liftedByName: b.lifted_by_name,
  }));
  const notes = (db.prepare(
    `SELECT n.id, n.author_id, a.name AS author_name, n.text, n.created_at FROM player_notes n
     LEFT JOIN players a ON a.steamid = n.author_id WHERE n.player_id = ? ORDER BY n.id DESC`,
  ).all(canonical) as { id: number; author_id: string; author_name: string | null; text: string; created_at: string }[])
    .map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, text: n.text, createdAt: n.created_at }));
  const matches = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.ended_at AS endedAt, m.winner, mp.team, mp.connected_at AS connectedAt
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? ORDER BY m.id DESC LIMIT 20`,
  ).all(canonical);
  const timeout = activeTimeout(db, canonical, now);

  return {
    steamid: canonical,
    header: {
      steamid: canonical,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      isAdmin: player.is_admin === 1,
      isMod: player.is_mod === 1,
      discordName: player.discord_name,
      sr: row?.sr ?? null,
      games: row?.games ?? 0,
      createdAt: player.created_at,
    },
    glance: playerFileSummary(db, canonical, viewer, { now, timeline })!,
    timeline,
    sections: {
      identity: identity(db, canonical),
      standing: {
        activeBan: ban ? redact(ban) : null,
        bans,
        penalties: penaltyHistory(db, canonical),
        timeout: timeout ? { until: timeout.until.toISOString(), offenses: timeout.offenses } : null,
      },
      matches,
      tickets: ticketsAbout(db, canonical, viewer.steamid),
      notes,
      evidence: evidence(db, canonical),
    },
    actions: fileActions(db, viewer, canonical),
    lastReview: lastReviewOf(db, canonical),
  };
}
