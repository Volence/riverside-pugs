import type { MatchRoomView } from '../api';
import { seriesMath, seriesNeedsText } from '../routes/event/room/seriesMath';
import './seriesBox.css';

/**
 * The series math for casters (owner 2026-11-22, DT2: "more spots for the
 * math of things for casters for more than one map in best of series"):
 * each game's score, the series total so far with the live game in it, the
 * gap, and what the trailing team needs. One table for the studio panel and
 * the caster desk; the numbers come from seriesMath, as the match page's
 * header does.
 */
export function SeriesBox({ room, title = true }: { room: MatchRoomView; title?: boolean }) {
  const m = seriesMath(room);
  const name = (s: 'a' | 'b') => (s === 'a' ? room.a?.name : room.b?.name) ?? 'TBD';
  return (
    <div class="seriesbox">
      {title && (
        <p class="seriesbox__head">
          <b>{room.eventName}</b> · {room.roundLabel}
        </p>
      )}
      {!m ? (
        <p class="muted seriesbox__none">{room.result ? 'Decided without a game.' : 'No series yet: the veto has not set the games.'}</p>
      ) : (
        <>
          <table class="seriesbox__table">
            <thead>
              <tr>
                <th class="is-text">{m.totalScore ? 'Total score' : `Best of ${m.bestOf}`}</th>
                <th>{name('a')}</th>
                <th>{name('b')}</th>
              </tr>
            </thead>
            <tbody>
              {m.games.map((g) => (
                <tr key={g.id} class={`is-${g.state}`}>
                  <td class="is-text">
                    {g.title} · {g.campaignName}
                    <span class="seriesbox__state">{g.state === 'done' ? (g.forfeit ? ' · forfeit' : ' · final') : g.state === 'live' ? ` · live${g.map ? ` on ${g.map}` : ''}` : ' · up next'}</span>
                  </td>
                  <td class={g.winner === 'a' ? 'is-win' : ''}>{g.a ?? '-'}</td>
                  <td class={g.winner === 'b' ? 'is-win' : ''}>{g.b ?? '-'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th class="is-text">{m.totalScore ? (m.liveIncluded ? 'Total so far (live game in)' : 'Total') : 'Games won'}</th>
                <td class={m.leader === 'a' ? 'is-lead' : ''}>{m.a}</td>
                <td class={m.leader === 'b' ? 'is-lead' : ''}>{m.b}</td>
              </tr>
              {m.totalScore && (
                <tr>
                  <th class="is-text">Gap</th>
                  <td colSpan={2}>{m.gap === 0 ? 'Level' : `${m.gap} to ${name(m.leader!)}`}</td>
                </tr>
              )}
            </tfoot>
          </table>
          <p class={`seriesbox__needs${m.needs ? ' is-chase' : ''}`} role="status">{seriesNeedsText(m, name)}</p>
        </>
      )}
    </div>
  );
}
