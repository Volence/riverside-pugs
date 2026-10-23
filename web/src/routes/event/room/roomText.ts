import type { MatchRoomView, RoomGame, RoomLogLine, RoomPhase, RoomPlanStep } from '../../../api';

/** The phase chip's label (plan T3a, plan T3b). */
export const PHASE_TEXT: Record<RoomPhase, string> = {
  pending: 'Waiting for teams', waiting: 'Not started', ready: 'Ready check', veto: 'Veto', lineup: 'Lineups',
  server: 'Waiting for the server', connect: 'Connect', live: 'Live', confirming: 'Confirming', hold: 'On hold', done: 'Finished',
};

const team = (v: MatchRoomView, s: 'a' | 'b'): string => (s === 'a' ? v.a?.name ?? 'TBD' : v.b?.name ?? 'TBD');

/** Whose turn it is and what, by team name. */
export function stepText(v: MatchRoomView): string {
  const n = v.next;
  if (!n) return '';
  if (n.kind === 'wait') return `Game ${n.game} is picked after game ${n.game - 1}.`;
  const who = team(v, n.by);
  switch (n.kind) {
    case 'order': return `${who}: go first or second`;
    case 'ban': return `${who}: ban a campaign`;
    case 'pick': return `${who}: pick game ${n.game}`;
    case 'side': return `${who}: choose sides for game ${n.game}`;
    default: return '';
  }
}

/** One plain sentence for a veto log line, marking automatic steps. */
export function logText(v: MatchRoomView, l: RoomLogLine): string {
  const who = team(v, l.side);
  const what = l.action === 'ban' ? `banned ${l.campaignName}` : l.action === 'pick' ? `picked ${l.campaignName}`
    : l.action === 'first' ? 'chose to go first' : l.action === 'second' ? 'chose to go second'
      : l.action === 'survivors' ? 'chose survivors first' : 'chose infected first';
  return `${who} ${what}${l.auto ? ' (automatic)' : ''}`;
}

/** `m:ss`, clamped to `0:00` at or below zero. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function gameTitle(g: RoomGame): string {
  return g.tiebreak ? `Tiebreak of game ${g.game}` : `Game ${g.game}`;
}

/** One line per game: its campaign (and chapter for a tiebreak), then the
 *  sides, the live map and score, or the final score. v.a and v.b can be
 *  null on a pending bracket match (T3a), hence team(). */
export function gameLine(v: MatchRoomView, g: RoomGame): string {
  const where = g.tiebreak && g.map ? `${g.campaignName}, ${g.map}` : g.campaignName;
  const score = (a: number, b: number) => `${team(v, 'a')} ${a} - ${b} ${team(v, 'b')}`;
  if (g.state === 'done' && g.forfeit) {
    // A !gg loses the game whatever the score, so a forfeiting side ahead on
    // points must not read as the winner (T3b final review).
    const scored = g.scoreA !== null && g.scoreB !== null ? ` · ${score(g.scoreA, g.scoreB)}` : '';
    const won = g.forfeit === 'a' ? 'b' : 'a';
    return `${gameTitle(g)} · ${where}${scored} · FF: ${team(v, g.forfeit)} forfeited, ${team(v, won)} win`;
  }
  if (g.state === 'done' && g.scoreA !== null && g.scoreB !== null) return `${gameTitle(g)} · ${where} · ${score(g.scoreA, g.scoreB)}`;
  if (g.state === 'live') return `${gameTitle(g)} · ${where} · live${g.live?.map ? ` on ${g.live.map}` : ''}${g.live ? ` · ${score(g.live.scoreA, g.live.scoreB)}` : ''}`;
  const first = g.firstSurvivors ? ` · ${team(v, g.firstSurvivors)} start as survivors` : '';
  return `${gameTitle(g)} · ${where}${first}`;
}

export function seriesLine(v: MatchRoomView): string {
  const s = v.series;
  if (!s) return '';
  return s.totalScore ? `Two games, total score · ${team(v, 'a')} ${s.totalA} - ${s.totalB} ${team(v, 'b')}` : `Best of ${s.bestOf} · ${team(v, 'a')} ${s.winsA} - ${s.winsB} ${team(v, 'b')}`;
}

export function resultLine(v: MatchRoomView): string {
  const s = v.series;
  if (!s || !s.winner) return '';
  const w = s.winner;
  const l = w === 'a' ? 'b' : 'a';
  const line = s.totalScore
    ? `${w === 'a' ? s.totalA : s.totalB} to ${w === 'a' ? s.totalB : s.totalA} on total score`
    : `${w === 'a' ? s.winsA : s.winsB} games to ${w === 'a' ? s.winsB : s.winsA}`;
  return `${team(v, w)} beat ${team(v, l)} ${line}.`;
}

/** Plain text for every reason src/events passes to holdMatch (the room
 *  clock, the series runner and a booking's end, booking_ plus its
 *  end_reason). Staff also hold with a reason they type, which has no entry. */
export const HOLD_TEXT: Record<string, string> = {
  window_expired: 'The scheduling window ended with no time agreed.',
  nobody_ready: 'Neither team readied up in time.',
  lineup_short: 'A team did not have four players to lock a lineup.',
  no_presence: 'The server could not be watched when the connect grace ended, so nobody was forfeited.',
  no_show_both: 'Neither team had enough players on the server when the connect grace ended.',
  game_aborted: 'A game was aborted before it finished.',
  game_lost: 'The server went down during a game and it could not be restored.',
  tiebreak_unknown: 'A game tied but its last chapter was not recorded, so no tiebreak could be set.',
  tiebreak_refused: 'A game tied again and no further tiebreak could be added.',
  no_result: 'The confirm window ended but the games do not add up to a result.',
  dispute: 'A captain disputed the result.',
  booking_time: 'The server booking ran out of time before the series finished.',
  booking_idle: 'The server booking closed because nobody was on it.',
  booking_captain: 'A captain ended the server booking before the series finished.',
  booking_staff: 'Staff ended the server booking before the series finished.',
  booking_cancelled: 'The server booking was cancelled.',
  booking_declined: 'The server booking was declined.',
  booking_no_show: 'The server booking closed because a team did not show.',
  booking_setup_failed: 'The server could not be set up.',
  booking_done: 'Everyone left the server before the series finished.',
  booking_bumped: 'The server was needed for another match.',
  booking_ended: 'The server booking ended before the series finished.',
};

/** A hold reason as text: the plain sentence for a known code, otherwise
 *  what staff typed, as is. */
export function holdText(reason: string): string {
  return HOLD_TEXT[reason] ?? reason;
}

/** The veto banner (owner 2026-10-23: testers thought they were still
 *  banning when it was their pick). For the team whose turn it is it says
 *  "Your turn" and the verb in capitals; for everyone else whose turn it is. */
export function turnBanner(v: MatchRoomView): { tone: 'ban' | 'pick' | 'side' | 'order' | 'wait'; title: string; detail: string } | null {
  const n = v.next;
  if (!n) return null;
  if (n.kind === 'wait') return { tone: 'wait', title: `Game ${n.game} is picked after game ${n.game - 1}`, detail: `The loser of game ${n.game - 1} picks it.` };
  const mine = v.me?.side === n.by && v.me.manager;
  const who = team(v, n.by);
  switch (n.kind) {
    case 'ban': return mine
      ? { tone: 'ban', title: 'Your turn: BAN a campaign', detail: 'The campaign you ban is out. You are not picking yet.' }
      : { tone: 'ban', title: `${who} is banning a campaign`, detail: 'Wait for your turn.' };
    case 'pick': return mine
      ? { tone: 'pick', title: `Your turn: PICK the campaign you will play${n.game && n.game > 1 ? ` in game ${n.game}` : ''}`, detail: 'This is not a ban: the campaign you press is the one that gets played.' }
      : { tone: 'pick', title: `${who} is picking the campaign${n.game && n.game > 1 ? ` for game ${n.game}` : ''}`, detail: 'Wait for your turn.' };
    case 'side': return mine
      ? { tone: 'side', title: `Your turn: choose your side for game ${n.game}`, detail: 'Survivors first or infected first.' }
      : { tone: 'side', title: `${who} is choosing sides for game ${n.game}`, detail: 'Wait for your turn.' };
    case 'order': return mine
      ? { tone: 'order', title: 'Your turn: go first or second', detail: orderTrade(v) }
      : { tone: 'order', title: `${who} is choosing to go first or second`, detail: 'Wait for your turn.' };
    default: return null;
  }
}

/** What going first or second gives the higher seed, from the plan (whose
 *  steps after an open order are listed as if they go first). */
export function orderTrade(v: MatchRoomView): string {
  const plan = v.plan ?? [];
  const higher = v.higher;
  if (!higher) return '';
  const after = plan.filter((p) => p.tentative && p.by !== null && p.kind !== 'wait');
  const gets = (mineIfFirst: boolean): string => {
    const own = after.filter((p) => (p.by === higher) === mineIfFirst);
    const bans = own.map((p) => after.filter((x) => x.kind === 'ban').indexOf(p) + 1).filter((i) => i > 0);
    const parts: string[] = [];
    if (bans.length > 0) parts.push(`${bans.length === 1 ? 'ban' : 'bans'} ${bans.join(', ')}`);
    if (own.some((p) => p.kind === 'pick' && p.game === 1)) parts.push('the pick of game 1');
    if (own.some((p) => p.kind === 'side' && p.game === 1)) parts.push('the side choice for game 1');
    return parts.length > 0 ? parts.join(', ') : 'nothing more in this veto';
  };
  return `Go first and you get ${gets(true)}. Go second and you get ${gets(false)}.`;
}

/** One line of the step list: what the step is and who takes it. */
export function planLine(v: MatchRoomView, p: RoomPlanStep, banNo: number): string {
  const who = p.by === null ? '' : p.tentative && v.higher
    ? (p.by === v.higher ? 'the team that goes first' : 'the team that goes second')
    : team(v, p.by);
  switch (p.kind) {
    case 'order': return `${who} chooses to go first or second`;
    case 'ban': return `Ban ${banNo}: ${who}`;
    case 'pick': return `PICK${p.game && p.game > 1 ? ` game ${p.game}` : ' the campaign'}: ${who}`;
    case 'side': return `Sides for game ${p.game}: ${who}`;
    case 'wait': return `Game ${p.game}: the loser of game ${(p.game ?? 2) - 1} picks, the other team chooses sides`;
  }
}

/** Each team's share of the veto, in a sentence per team: its bans, the
 *  game 1 pick, the side choice. "You" for the viewer's own team. */
export function shareLines(v: MatchRoomView): { side: 'a' | 'b'; text: string }[] {
  const plan = (v.plan ?? []).filter((p) => p.by !== null && !p.tentative);
  if (plan.length === 0) return [];
  return (['a', 'b'] as const).map((side) => {
    const own = plan.filter((p) => p.by === side);
    const bans = own.filter((p) => p.kind === 'ban').length;
    const parts: string[] = [];
    if (bans > 0) parts.push(`${bans} ${bans === 1 ? 'ban' : 'bans'}`);
    if (own.some((p) => p.kind === 'pick' && p.game === 1)) parts.push('picks the campaign');
    if (own.some((p) => p.kind === 'side' && p.game === 1)) parts.push('chooses sides');
    const you = v.me?.side === side;
    return { side, text: `${you ? `You (${team(v, side)})` : team(v, side)}: ${parts.length > 0 ? parts.join(', ') : 'no veto steps'}` };
  });
}
