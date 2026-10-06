import type { MatchRoomView, RoomLogLine, RoomPhase } from '../../../api';

/** The phase chip's label (plan T3a). */
export const PHASE_TEXT: Record<RoomPhase, string> = {
  pending: 'Waiting for teams', waiting: 'Not started', ready: 'Ready check', veto: 'Veto', lineup: 'Lineups',
  server: 'Waiting for the server', hold: 'On hold', done: 'Finished',
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
