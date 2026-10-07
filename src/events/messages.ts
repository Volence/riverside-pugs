import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { whenUtc } from '../bookings/messages.js';
import * as E from './events.js';
import { getEntry } from './entries.js';
import * as R from './entryRules.js';
import * as P from './play.js';
import { gamesOf, roomTimers, seriesGames } from './room.js';
import { seriesVerdict, winsLine } from './seriesRules.js';
import { bookingRules, getBooking } from '../bookings/bookings.js';
import { getServer } from '../serverPool.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { getProposal, scheduleRules } from './schedule.js';
import type { CutRole } from './draftRules.js';

/** The event DMs (plan T1b Ruling 11, and the two match room DMs of plan
 *  T3a Ruling 2). Every player-chosen name goes through escapeName, as in
 *  src/bookings/messages.ts. */
export type EventNotifyType = 'event_checkin_open' | 'event_dropped' | 'event_roster_added' | 'event_match_room' | 'event_match_forfeit'
  | 'event_match_connect' | 'event_match_result' | 'event_match_staff' | 'event_reschedule' | 'event_match_time'
  | 'draft_signup_removed' | 'draft_cut_role' | 'draft_captain_offer';

/** A reschedule DM's occasion (plan T4 Ruling 11). */
export type RescheduleNotice = 'proposed' | 'countered' | 'declined' | 'withdrawn' | 'reminder';
/** Discord renders this in each reader's own time zone (Global Constraints). */
export const discordTime = (iso: string): string => `<t:${Math.floor(Date.parse(iso) / 1000)}:F>`;

/** What staff did on the desk (plan T3c Ruling 17), one sentence each. */
export type StaffAction = 'ready' | 'veto' | 'lineup' | 'veto_reopened' | 'chapter_replayed' | 'server_moved' | 'grace_extended' | 'hold_released' | 'frozen' | 'unfrozen' | 'tech_warning' | 'tech_forfeit';
const STAFF_TEXT: Record<StaffAction, string> = {
  ready: 'pressed Ready for a team', veto: 'took a veto step for a team', lineup: 'locked a lineup for a team',
  veto_reopened: 'reopened the veto; the room starts again from the first step',
  chapter_replayed: 'had a chapter replayed from its start', server_moved: 'moved the match to another server; a new connect line follows',
  grace_extended: 'extended the time to connect', hold_released: 'released the hold on the match',
  frozen: 'froze the game; only staff can unfreeze it', unfrozen: 'unfroze the game',
  tech_warning: 'gave a warning for a technical pause',
  tech_forfeit: 'ruled that a team forfeits the game over a technical pause',
};

const ROLE_TEXT: Record<R.Role, string> = { starter: 'a starter', sub: 'a sub', coach: 'the coach' };

/** Why staff removed a draft signup (drafts plan D1 Ruling 11). */
export type SignupRemoval = 'removed' | 'ineligible';
const REMOVAL_TEXT: Record<SignupRemoval, string> = { removed: 'an organizer removed it', ineligible: 'you are not eligible for this event' };

export function eventMessage(
  db: DB, publicUrl: string, eventId: number, type: EventNotifyType,
  extra: { entryId?: number; reason?: R.DropReason; by?: string; role?: R.Role; matchId?: number; why?: 'ready' | 'server' | 'window'; what?: StaffAction | RescheduleNotice | 'staff'; detail?: string; proposalId?: number; removal?: SignupRemoval; cutRole?: CutRole; expiresAt?: string } = {},
): MessagePayload | null {
  const ev = E.getEvent(db, eventId);
  if (!ev) return null;
  const entry = extra.entryId !== undefined ? getEntry(db, extra.entryId) : undefined;
  const event = escapeName(ev.name);
  const team = escapeName(entry?.name ?? 'Your team');
  let content: string;
  switch (type) {
    case 'event_checkin_open': {
      const { closesAt } = R.checkinTimes(ev.starts_at, E.fieldsOf(ev).checkin);
      content = `Check-in is open for ${event}. A captain or co-captain of ${team} checks in on the event page before ${whenUtc(closesAt)}; teams not checked in by then are dropped.`;
      break;
    }
    case 'event_dropped':
      content = `${team} is out of ${event}: ${R.DROP_TEXT[extra.reason ?? 'withdrawn']}.`;
      break;
    case 'event_roster_added': {
      const by = escapeName((extra.by ? getPlayer(db, extra.by)?.name : undefined) ?? 'Your captain');
      content = `${by} put you on ${team}'s roster for ${event} as ${ROLE_TEXT[extra.role ?? 'starter']}. You can leave the roster from the event page.`;
      break;
    }
    case 'draft_signup_removed':
      content = `Staff removed your signup for ${event}: ${REMOVAL_TEXT[extra.removal ?? 'removed']}.`;
      break;
    case 'draft_cut_role': {
      const draftAt = E.fieldsOf(ev).draft?.draftAt;
      if (!draftAt || !extra.cutRole) return null;
      const link = `${publicUrl}/event/${ev.slug}`;
      const when = discordTime(draftAt);
      content = extra.cutRole === 'captain'
        ? `You are a captain in ${event}. Teams are made ${when}: staff either balance them by SR or you pick your players live, and you will hear which. Keep the time free: ${link}`
        : extra.cutRole === 'pool'
          ? `You are in the player pool for ${event}. Teams are made ${when}, by SR balance or a live captains' draft; you will get a DM with your team: ${link}`
          : `You are on the free-agent bench for ${event}. Teams are made ${when}; captains can call on you as a stand-in, so keep the night free if you can: ${link}`;
      break;
    }
    case 'draft_captain_offer':
      if (!extra.expiresAt) return null;
      content = `${event} needs another captain and you said you were willing. Accept or decline on the event page by ${discordTime(extra.expiresAt)}: ${publicUrl}/event/${ev.slug}`;
      break;
    case 'event_match_connect':
    case 'event_match_result':
    case 'event_match_staff':
    case 'event_reschedule':
    case 'event_match_time': {
      const m = extra.matchId !== undefined ? P.getMatch(db, extra.matchId) : undefined;
      if (!m || m.entry_a === null || m.entry_b === null) return null;
      const a = escapeName(getEntry(db, m.entry_a)?.name ?? 'Team A');
      const b = escapeName(getEntry(db, m.entry_b)?.name ?? 'Team B');
      if (type === 'event_reschedule') {
        const p = extra.proposalId !== undefined ? getProposal(db, extra.proposalId) : undefined;
        if (!p || p.event_match_id !== m.id) return null;
        const who = p.side === 'a' ? a : b;
        const otherTeam = p.side === 'a' ? b : a;
        const by = escapeName(getPlayer(db, p.proposed_by)?.name ?? 'A captain');
        const note = p.note ? ` ("${escapeName(p.note)}")` : '';
        // A proposal with no lock time needs an answer (made too close to its time, or to the room opening at the time set now).
        const lock = p.auto_accept_at ? ` Unanswered, it locks on ${discordTime(p.auto_accept_at)}.` : ' It needs an answer: it does not lock on its own.';
        const what = extra.what ?? 'proposed';
        content = what === 'proposed' || what === 'countered'
          ? `${by} of ${who} ${what === 'countered' ? 'counters with' : 'proposes'} ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}${note}. A captain or co-captain accepts, declines or counters on the match page.${lock}`
          : what === 'reminder'
            ? `${who}'s proposed time for ${a} vs ${b} in ${event}, ${discordTime(p.proposed_time)}, locks on ${discordTime(p.auto_accept_at ?? p.proposed_time)} unless a captain or co-captain of your team answers on the match page.`
            : what === 'declined'
              ? `${otherTeam} declined ${who}'s proposed time ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}. Propose another on the match page.`
              : `${who} withdrew its proposed time ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}.`;
      } else if (type === 'event_match_time') {
        if (m.scheduled_at === null) return null;
        const lead = scheduleRules(db).leadMinutes;
        content = `${a} vs ${b} in ${event} is set for ${discordTime(m.scheduled_at)}${extra.what === 'staff' ? ' (staff set it)' : ''}. The match room opens ${lead} minutes before; a captain or co-captain of each team presses Ready there, then the veto and lineups follow and the server is booked.`;
      } else if (type === 'event_match_staff') {
        const detail = extra.detail ? ` (${escapeName(extra.detail)})` : '';
        content = `${a} vs ${b} in ${event}: staff ${STAFF_TEXT[(extra.what as StaffAction | undefined) ?? 'hold_released']}${detail}.`;
      } else if (type === 'event_match_connect') {
        const bk = m.booking_id !== null ? getBooking(db, m.booking_id) : undefined;
        const s = bk && bk.server_id !== null ? getServer(db, bk.server_id) : undefined;
        if (!bk || !s) return null;
        const g1 = gamesOf(db, m.id).find((g) => g.ordinal === 1);
        const first = g1?.first_survivors === m.entry_a ? a : g1?.first_survivors === m.entry_b ? b : null;
        const game = g1 ? `Game 1: ${escapeName(campaignDisplayName(db, g1.campaign))}${first ? `, ${first} start as survivors` : ''}. ` : '';
        const grace = bookingRules(bk)?.noShowGraceMinutes ?? 15;
        content = `${a} vs ${b} in ${event}: your server is ready. In the game console:\n\`connect ${s.host}:${s.port}; password ${bk.password}\`\n${game}Both teams must have their four on the server within ${grace} minutes; a team that does not loses by forfeit.`;
      } else {
        const v = seriesVerdict(E.stageSettingsOf(E.getStage(db, m.stage_id)!).veto, seriesGames(db, m));
        if (v.winner === null) return null;
        const winner = v.winner === 'a' ? a : b;
        const loser = v.winner === 'a' ? b : a;
        const line = v.forfeit !== null
          ? `by forfeit (${loser} typed !gg)`
          : v.totalScore
          ? `${v.winner === 'a' ? v.totalA : v.totalB} to ${v.winner === 'a' ? v.totalB : v.totalA} on total score`
          : winsLine(v.winner === 'a' ? v.winsA : v.winsB, v.winner === 'a' ? v.winsB : v.winsA);
        content = `${a} vs ${b} in ${event}: ${winner} beat ${loser} ${line}. Captains have ${roomTimers(db).confirmMinutes} minutes to confirm or dispute the result on the match page; otherwise it stands.`;
      }
      return {
        content, embeds: [],
        components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}/match/${m.id}`, label: 'Open the match room' }]],
        mentionUserIds: [],
      };
    }
    case 'event_match_room':
    case 'event_match_forfeit': {
      const m = extra.matchId !== undefined ? P.getMatch(db, extra.matchId) : undefined;
      if (!m || m.entry_a === null || m.entry_b === null) return null;
      const a = escapeName(getEntry(db, m.entry_a)?.name ?? 'Team A');
      const b = escapeName(getEntry(db, m.entry_b)?.name ?? 'Team B');
      if (type === 'event_match_room') {
        content = `${a} vs ${b} in ${event}: the match room is open. A captain or co-captain of each team presses Ready within ${roomTimers(db).readyMinutes} minutes; a team that does not loses by forfeit.`;
      } else {
        const winner = m.winner_entry === m.entry_a ? a : b;
        const loser = m.winner_entry === m.entry_a ? b : a;
        const why = extra.why === 'server' ? 'did not have four players on the server when the grace to connect ended'
          : extra.why === 'window' ? 'never answered the other team\'s proposed time and never played before the window closed'
            : 'did not press Ready in the match room in time';
        content = `${a} vs ${b} in ${event} is a forfeit win for ${winner}: ${loser} ${why}.`;
      }
      return {
        content, embeds: [],
        components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}/match/${m.id}`, label: 'Open the match room' }]],
        mentionUserIds: [],
      };
    }
  }
  return {
    content,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' }]],
    mentionUserIds: [],
  };
}
