import type { MatchRoomView, RoomGame, RoomLogLine, RoomPhase } from '../../../api';

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
