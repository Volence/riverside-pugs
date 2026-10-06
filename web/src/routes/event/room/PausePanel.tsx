import type { MatchRoomView } from '../../../api';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Plan T5 Ruling 13: every technical pause of the match. The reason and the
 *  flag note show only to the two teams and staff: the server leaves them
 *  null for anyone else, and a null shows as nothing here. */
export function PausePanel({ v }: { v: MatchRoomView }) {
  if (v.pauses.length === 0) return null;
  const team = (side: 'a' | 'b') => (side === 'a' ? v.a?.name : v.b?.name) ?? `Team ${side.toUpperCase()}`;
  return (
    <ul class="room__pauses">
      {v.pauses.map((p) => (
        <li key={p.id}>
          {`Game ${p.game}${p.tiebreak ? ' tiebreak' : ''} · ${team(p.side)} · ${p.cause === 'disconnect' ? 'disconnect' : 'technical'} · ${clock(p.usedS)} of ${clock(p.budgetS)}`}
          {p.endedAt === null && ' · still paused'}
          {p.reason !== null && p.cause === 'call' && <> · <q>{p.reason}</q></>}
          {p.overrun && ' · ran into tactical pauses'}
          {p.flagged && ' · flagged by the other team'}
          {p.flagNote !== null && p.flagNote !== '' && <> (<q>{p.flagNote}</q>)</>}
          {p.penalty === 'warning' && ' · staff gave a warning'}
          {p.penalty === 'forfeit' && ' · staff ruled the game forfeited'}
        </li>
      ))}
    </ul>
  );
}
