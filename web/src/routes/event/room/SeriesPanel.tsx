import type { MatchRoomView } from '../../../api';
import { gameLine, seriesLine } from './roomText';

/** The series score and one row per game in play order, replacing the veto
 *  panel's plain game list once the series is set (plan T3b). */
export function SeriesPanel({ v }: { v: MatchRoomView }) {
  return (
    <div class="roomseries">
      <p class="roomseries__score">{seriesLine(v)}</p>
      <ol class="roomseries__games">
        {v.games.map((g) => (
          <li key={g.id} class={`roomseries__game roomseries__game--${g.state}`}>
            {g.matchId !== null && g.state !== 'upcoming' ? <a href={`/match/${g.matchId}`}>{gameLine(v, g)}</a> : gameLine(v, g)}
          </li>
        ))}
      </ol>
    </div>
  );
}
