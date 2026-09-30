import { api } from '../api';
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
 * the viewer's own time zone, with the busiest stretch and the typical wait.
 *
 * For the player deciding when to queue. Most pops land in a few evening
 * hours (US time), and someone who queues at noon UTC sits alone at 1 / 8;
 * this is the page telling them so before they find out.
 */
export function ActivityPanel() {
  const { data } = useFetch((s) => api.activity(s), []);
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
        Brighter squares had more games. Queue at the busy times and the pop comes quicker.
      </p>
    </Panel>
  );
}
