import { adminApi } from '../api';
import { useFetch } from '../hooks/useFetch';
import {
  busiestWindow, hourLabel, localActivity, nowLevel, ROW_DAYS, waitWords, type NowLevel,
} from '../activity';
import { Panel } from './bits';

/** Below this many pops in the window the grid is mostly empty squares and
 *  says more about a quiet month than about when to play. */
const MIN_POPS = 10;

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const NOW_TEXT: Record<NowLevel, string> = {
  busy: 'Right now is usually busy.',
  some: 'Right now usually has a game or two.',
  quiet: 'Right now is usually quiet.',
};

/**
 * "When people play": four weeks of queue pops as a weekday by hour grid, in
 * the viewer's own time zone, with the busiest stretch and how long the queue
 * takes to pop.
 *
 * Admin only, on the Live desk. It was on Play for a morning (2026-09-30) and
 * the owner moved it: a grid telling players when nobody is around teaches
 * them not to be around then, so the quiet hours stay quiet. For staff it
 * answers when to schedule events and whether waits are getting longer.
 */
export function ActivityPanel() {
  const { data } = useFetch((s) => adminApi.activity(s), []);
  if (!data || data.totalPops < MIN_POPS) return null;

  const now = new Date();
  const local = localActivity(data, now);
  const win = busiestWindow(local.byHour);
  const level = nowLevel(local, now.getDay(), now.getHours());
  const wait = data.waits.byHourSec[now.getUTCHours()] ?? data.waits.medianSec;
  const today = now.getDay();
  const thisHour = now.getHours();

  return (
    <Panel class="activity">
      <div class="panel__head"><h3>When people play</h3><span class="eyebrow">Last {data.days / 7} weeks</span></div>
      <p class="activity__summary">
        {win && <>Busiest from <strong>{hourLabel(win.start)}</strong> to <strong>{hourLabel(win.end)}</strong> your time. </>}
        {NOW_TEXT[level]}
        {wait !== null && <> A queue at this hour takes <strong>{waitWords(wait)}</strong> to pop.</>}
      </p>
      <p class="activity__waits muted">
        {data.waits.popped + data.waits.left === 0
          ? 'Queue waits are recorded from 2026-09-30; none yet.'
          : <>
              {data.waits.popped} queue{data.waits.popped === 1 ? '' : 's'} reached a pop
              {data.waits.medianSec !== null && <> (median wait {waitWords(data.waits.medianSec).replace('about ', '')})</>}
              ; {data.waits.left} left before one
              {data.waits.leftMedianSec !== null && <> (median {waitWords(data.waits.leftMedianSec).replace('about ', '')} in)</>}.
              {' '}Waits count until a ready check starts; requeues after a failed pop are left out.
            </>}
      </p>
      <div class="activity__grid" role="img"
        aria-label={win ? `Queue pops by day and hour. Busiest from ${hourLabel(win.start)} to ${hourLabel(win.end)} your time.` : 'Queue pops by day and hour.'}>
        {ROW_DAYS.map((day, r) => (
          <div class="activity__row" key={day}>
            <span class={`activity__day${day === today ? ' is-today' : ''}`}>{DAY_SHORT[day]}</span>
            {local.grid[r].map((v, h) => {
              const share = local.max > 0 ? v / local.max : 0;
              const perWeek = Math.round(v * 10) / 10;
              return (
                <span
                  key={h}
                  class={`activity__cell${day === today && h === thisHour ? ' is-now' : ''}`}
                  style={{ '--v': share.toFixed(3) }}
                  title={`${DAY_SHORT[day]} ${hourLabel(h)}: ${perWeek === 0 ? 'no games' : `${perWeek} game${perWeek === 1 ? '' : 's'} a week`}`}
                />
              );
            })}
          </div>
        ))}
        <div class="activity__row activity__row--axis" aria-hidden="true">
          <span class="activity__day" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} class="activity__tick">{h % 6 === 0 ? hourLabel(h) : ''}</span>
          ))}
        </div>
      </div>
      <p class="activity__legend muted">
        Brighter squares had more games. Hover a square for games a week.
      </p>
    </Panel>
  );
}
