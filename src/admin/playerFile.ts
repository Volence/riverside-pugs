import type { DB } from '../db.js';
import { abandonsOfPlayer, type AbandonRecord } from './matches.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { nameHistory } from '../playerNames.js';
import { discordHistoryOf, getPlayer } from '../players.js';
import { penaltyHistory, activeTimeout, type PenaltyKind } from '../penalties.js';
import { networksOf, sharesAddressWith } from '../playerNetworks.js';
import { capsForPlayer, detectionsForPlayer } from '../inputBursts.js';
import { signonDropSummary } from '../signonDrops.js';
import { ticketsAbout, redactDiscordSanction } from '../tickets/views.js';
import { sanctionsForPlayer, type SanctionRow } from '../tickets/discordSanctions.js';
import {
  activeBan, bansOf, notesOf, recentMatchesOf, searchPlayers,
  type BanRow, type PlayerNoteRow, type RecentMatchRow,
} from './players.js';
import { steamAccountView } from './steamAccount.js';
import { integrityPlayer } from './integrity.js';
import { analyzerRankOf } from './analyzerRanks.js';
import { banRedactor } from './banRedaction.js';
import { canOpenFile, fileActions, type FileAction, type FileViewer } from './fileAccess.js';
import { lastReviewOf, type FileReview } from './reviews.js';
import { holdsAbout } from '../altHolds.js';
import { evaderFlagOf } from '../ipWatch.js';
import { playerFileSummary, type PlayerFileSummary } from './playerFileSummary.js';
import { playerTimeline } from './playerTimeline.js';
import type { TimelineItem } from './timeline/types.js';
import { conductOf, type ConductSection } from './conduct.js';
import { scrimRecordOf, type ScrimRecord } from '../scrims/reliability.js';
import { scrimReviewsOf, type ScrimReviews } from '../scrims/reviews.js';
import { scrimBlocksOf, type ScrimBlocks } from '../scrims/blocks.js';

export interface PlayerFile {
  steamid: string;
  header: {
    steamid: string;
    name: string;
    avatar: string | null;
    status: string;
    isAdmin: boolean;
    isMod: boolean;
    isCaster: boolean;
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
      timeout: { until: string; offenses: number; kind: PenaltyKind } | null;
      discordSanctions: SanctionRow[];
      /** Every abandon, with whether its rating loss was restored. */
      abandons: AbandonRecord[];
    };
    matches: RecentMatchRow[];
    conduct: ConductSection;
    /** Scrim records (plan 2): as a pickup captain and each current team's. */
    scrims: ScrimRecord;
    /** Review aggregates and toxic flags (plan 2 Ruling 6), beside the record. */
    scrimReviews: ScrimReviews;
    /** Scrim blocks: as a pickup captain and each current team's. Read-only. */
    scrimBlocks: ScrimBlocks;
    tickets: ReturnType<typeof ticketsAbout>;
    notes: PlayerNoteRow[];
    evidence: ReturnType<typeof evidence>;
  };
  actions: FileAction[];
  lastReview: FileReview | null;
}

/** Aliases, Discord history, the Steam account and the shared connections.
 *  Moderators get all of it: the owner reversed the first ruling the same
 *  day, because "is this a second account" is exactly a moderator's job. */
function identity(db: DB, steamid: string, viewer: FileViewer) {
  return {
    aliases: aliasesOf(db, steamid),
    // Every name played under in a match, with when and how often. The
    // profile shows a few; staff get all of them.
    names: nameHistory(db, steamid),
    discordHistory: discordHistoryOf(db, steamid),
    steamAccount: steamAccountView(db, steamid),
    networks: networksOf(db, steamid),
    sharesAddressWith: sharesAddressWith(db, steamid),
    // Alt holds naming this account on either side (src/altHolds.ts). The
    // other side has to be a file this viewer may open, as on the Alts tab.
    altHolds: holdsAbout(db, steamid).filter((h) => canOpenFile(db, viewer, h.steamid) && canOpenFile(db, viewer, h.otherSteamid)),
    // Flagged as a ban evader: their connections are on the IP watch list.
    evaderFlag: evaderFlagOf(db, steamid),
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
  // Built here and handed on, like the timeline: both this section and the
  // glance want the analyzer rank, and each call to it scores the whole
  // board off every round row at the current version.
  const ev = evidence(db, canonical);
  // canOpenFile above already refused any viewer who is neither admin nor
  // mod, which is the only reason playerFileSummary ever refuses one: a
  // staff viewer who reached this line always gets a summary back.
  const glance = playerFileSummary(db, canonical, viewer, { now, timeline, analyzer: ev.analyzer });
  if (!glance) throw new Error(`playerFileSummary refused a staff viewer that canOpenFile already allowed for ${canonical}`);
  const redact = banRedactor(db, canonical, viewer.steamid);
  const ban = activeBan(db, canonical, now);
  // Same readers playerDetail uses, so a fixed note or ban shape never drifts
  // between the two. Redaction happens here, not inside bansOf: only the
  // caller knows which viewer it is building the row for.
  const bans = bansOf(db, canonical).map(redact);
  const notes = notesOf(db, canonical);
  const matches = recentMatchesOf(db, canonical);
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
      isCaster: player.is_caster === 1,
      discordName: player.discord_name,
      sr: row?.sr ?? null,
      games: row?.games ?? 0,
      createdAt: player.created_at,
    },
    glance,
    timeline,
    sections: {
      identity: identity(db, canonical, viewer),
      standing: {
        activeBan: ban ? redact(ban) : null,
        bans,
        penalties: penaltyHistory(db, canonical),
        timeout: timeout ? { until: timeout.until.toISOString(), offenses: timeout.offenses, kind: timeout.kind } : null,
        discordSanctions: sanctionsForPlayer(db, canonical).map((s) => redactDiscordSanction(db, s, viewer.steamid)),
        abandons: abandonsOfPlayer(db, canonical),
      },
      matches,
      conduct: conductOf(db, canonical),
      scrims: scrimRecordOf(db, canonical, now.getTime()),
      scrimReviews: scrimReviewsOf(db, canonical, now.getTime()),
      scrimBlocks: scrimBlocksOf(db, canonical),
      tickets: ticketsAbout(db, canonical, viewer.steamid),
      notes,
      evidence: ev,
    },
    actions: fileActions(db, viewer, canonical),
    lastReview: lastReviewOf(db, canonical),
  };
}
