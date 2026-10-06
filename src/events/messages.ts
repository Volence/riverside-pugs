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

/** The event DMs (plan T1b Ruling 11, and the two match room DMs of plan
 *  T3a Ruling 2). Every player-chosen name goes through escapeName, as in
 *  src/bookings/messages.ts. */
export type EventNotifyType = 'event_checkin_open' | 'event_dropped' | 'event_roster_added' | 'event_match_room' | 'event_match_forfeit'
  | 'event_match_connect' | 'event_match_result';

const ROLE_TEXT: Record<R.Role, string> = { starter: 'a starter', sub: 'a sub', coach: 'the coach' };

export function eventMessage(
  db: DB, publicUrl: string, eventId: number, type: EventNotifyType,
  extra: { entryId?: number; reason?: R.DropReason; by?: string; role?: R.Role; matchId?: number; why?: 'ready' | 'server' } = {},
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
    case 'event_match_connect':
    case 'event_match_result': {
      const m = extra.matchId !== undefined ? P.getMatch(db, extra.matchId) : undefined;
      if (!m || m.entry_a === null || m.entry_b === null) return null;
      const a = escapeName(getEntry(db, m.entry_a)?.name ?? 'Team A');
      const b = escapeName(getEntry(db, m.entry_b)?.name ?? 'Team B');
      if (type === 'event_match_connect') {
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
        content = `${a} vs ${b} in ${event} is a forfeit win for ${winner}: ${loser} ${extra.why === 'server' ? 'did not have four players on the server when the grace to connect ended' : 'did not press Ready in the match room in time'}.`;
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
