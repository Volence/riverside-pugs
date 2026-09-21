import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { activeTimeout, penaltyHistory } from '../penalties.js';
import { sharesAddressWith } from '../playerNetworks.js';
import { ticketsAbout } from '../tickets/views.js';
import { activeBan, searchPlayers, type BanRow } from './players.js';
import { steamAccountView } from './steamAccount.js';
import { analyzerRankOf, type AnalyzerRank } from './analyzerRanks.js';
import { banRedactor } from './banRedaction.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { lastReviewOf, type FileReview } from './reviews.js';
import { playerTimeline } from './playerTimeline.js';
import { isEvidence, type EvidenceSource, type TimelineItem } from './timeline/types.js';

/** How far back "is there anything here" looks. Older evidence is still on
 *  the timeline; it is simply not news. */
export const EVIDENCE_WINDOW_DAYS = 30;

export interface EvidenceCount { source: EvidenceSource; count: number }

/**
 * The compact answer to "is there anything here", shared by the file's own
 * At a glance row and the accused's section of a ticket page.
 *
 * One builder on purpose: a new evidence source then appears in both places
 * the day its adapter lands, rather than in whichever of them somebody
 * remembered.
 *
 * Gated on staff, not on canOpenFile. It returns null outright for any
 * viewer who is neither an admin nor a moderator, because it carries the
 * same evidence (steamFlags, sharesAddressWith, alias/ban/penalty counts,
 * the analyzer rank, the last review) as the full file, just compacted.
 * canOpenFile is a stricter, further rule on top of "is staff at all": it
 * also refuses a moderator their own file and a colleague's, which is
 * right for the FULL file but wrong here, because this summary is also
 * what the ticket case file shows the accused's side to a moderator an
 * admin deliberately put on a restricted ticket about a staff member,
 * exactly as the ticket page already did before this file existed. The
 * caller owns that narrower check: the ticket route only reaches this
 * function after the ticket's own visibility rule (canSeeTicket) has
 * already let the viewer see the ticket the summary is being shown on.
 * `fileUrl` is the one field that still asks canOpenFile, since it is
 * the one field that offers to open the full file.
 */
export interface PlayerFileSummary {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  isAdmin: boolean;
  isMod: boolean;
  sr: number | null;
  games: number;
  createdAt: string | null;
  activeBan: BanRow | null;
  bans: number;
  penalties: number;
  timeout: { until: string; offenses: number } | null;
  openTickets: number;
  aliases: number;
  sharesAddressWith: { steamid: string; name: string }[];
  /** Steam's plain-worded flags: new account, banned elsewhere, borrowed
   *  game, private profile, low hours. Already hedged by steamAccountView. */
  steamFlags: { kind: string; text: string }[];
  evidence: EvidenceCount[];
  analyzer: AnalyzerRank | null;
  lastReview: FileReview | null;
  /** Where the full file is, or null when this viewer may not open it. */
  fileUrl: string | null;
}

export function playerFileSummary(
  db: DB, steamid: string, viewer: FileViewer,
  opts: { now?: Date; timeline?: TimelineItem[]; analyzer?: AnalyzerRank | null } = {},
): PlayerFileSummary | null {
  if (!viewer.isAdmin && !viewer.isMod) return null;
  const canonical = resolveAlias(db, steamid);
  const player = getPlayer(db, canonical);
  if (!player) return null;
  const now = opts.now ?? new Date();
  const row = searchPlayers(db, canonical, 1).find((p) => p.steamid === canonical);
  // Reused when the caller has already built one: the file asks for the
  // timeline anyway and building it twice is the whole cost of this page.
  const timeline = opts.timeline ?? playerTimeline(db, canonical, viewer.steamid);
  // Same bargain for the analyzer rank, and a sharper one: every call to
  // analyzerRankOf scores the whole board, reading and parsing every round
  // at the current version, synchronously. `null` is a real answer here, so
  // this asks whether the caller passed one rather than whether it is set.
  const analyzer = 'analyzer' in opts ? opts.analyzer ?? null : analyzerRankOf(db, canonical);
  const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * 86_400_000).toISOString();

  const counts = new Map<EvidenceSource, number>();
  for (const item of timeline) {
    if (!isEvidence(item) || item.at < since) continue;
    const source = item.source as EvidenceSource;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const redact = banRedactor(db, canonical, viewer.steamid);
  const ban = activeBan(db, canonical, now);
  const timeout = activeTimeout(db, canonical, now);
  const steam = steamAccountView(db, canonical, now);
  return {
    steamid: canonical,
    name: player.name,
    avatar: player.avatar,
    status: player.status,
    isAdmin: player.is_admin === 1,
    isMod: player.is_mod === 1,
    sr: row?.sr ?? null,
    games: row?.games ?? 0,
    createdAt: player.created_at,
    activeBan: ban ? redact(ban) : null,
    bans: (db.prepare('SELECT COUNT(*) AS n FROM bans WHERE player_id = ?').get(canonical) as { n: number }).n,
    penalties: penaltyHistory(db, canonical).length,
    timeout: timeout ? { until: timeout.until.toISOString(), offenses: timeout.offenses } : null,
    openTickets: ticketsAbout(db, canonical, viewer.steamid).filter((t) => t.status === 'open').length,
    aliases: aliasesOf(db, canonical).length,
    sharesAddressWith: sharesAddressWith(db, canonical).map((s) => ({ steamid: s.steamid, name: s.name })),
    steamFlags: steam?.flags ?? [],
    evidence: [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => a.source.localeCompare(b.source)),
    analyzer,
    lastReview: lastReviewOf(db, canonical),
    fileUrl: canOpenFile(db, viewer, canonical) ? `/admin/people/${canonical}` : null,
  };
}
