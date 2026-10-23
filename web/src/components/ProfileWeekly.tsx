import { useState } from 'preact/hooks';
import { api, type WeeklyHistoryRow, type WeeklyPlayerStat } from '../api';
import { useFetch } from '../hooks/useFetch';
import { ordinal } from '../routes/WeeklyBoard';

/** Rows shown before "Show all": about two months of weeks. */
const WEEKS_SHOWN = 8;
/** This week's boards shown, best placed first. */
const STATS_SHOWN = 6;

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const weekName = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** This week's boards the player places best on, by their total's rank. */
function bestBoards(stats: WeeklyPlayerStat[]): WeeklyPlayerStat[] {
  return stats
    .filter((s) => s.total && s.total.value > 0)
    .sort((a, b) => (a.total!.rank ?? 99) - (b.total!.rank ?? 99) || b.total!.value - a.total!.value)
    .slice(0, STATS_SHOWN);
}

function WeekRow({ r }: { r: WeeklyHistoryRow }) {
  return (
    <tr>
      <td>
        <a href={`/leaderboard?week=${r.week}`}>{weekName(r.week)}</a>
        {r.live && <span class="pweek__live">Live</span>}
      </td>
      <td class="num">{r.games}</td>
      <td class="num">{n0(r.skeets)}</td>
      <td class="num pweek__opt">{n0(r.siDamage)}</td>
      <td class="num pweek__opt">{n0(r.damageAsSi)}</td>
      <td class="pweek__awards">
        {r.awards.map((a) => (
          <span class="pweek__award" key={`${a.key}:${a.kind}`}>
            {a.kind === 'avg' ? `${a.label} (avg)` : a.kind === 'total' ? `${a.label} (total)` : a.label}
          </span>
        ))}
      </td>
    </tr>
  );
}

/**
 * A player's weeks (Lulu's request, 2026-10-23): where they stand on this
 * week's boards, and every week they played with a few headline numbers and
 * the awards they won, each linking to that week's board.
 */
export function ProfileWeekly({ steamid }: { steamid: string }) {
  const [all, setAll] = useState(false);
  const { data: now } = useFetch((s) => api.weeklyPlayer(steamid, s).catch(() => null), [steamid]);
  const { data: hist } = useFetch((s) => api.weeklyPlayerHistory(steamid, s).catch(() => null), [steamid]);
  const weeks = hist?.weeks ?? [];
  if (!now && !weeks.length) return null;
  if ((now?.games ?? 0) === 0 && !weeks.length) return null;
  const best = now && now.games > 0 ? bestBoards(now.stats) : [];
  const shown = all ? weeks : weeks.slice(0, WEEKS_SHOWN);
  return (
    <section class="panel pweek" aria-label="Weekly">
      <h3>Weekly</h3>
      {now && now.games > 0 && (
        <div class="pweek__now">
          <p class="pweek__nowline">
            This week: <strong class="num">{now.games}</strong> {now.games === 1 ? 'game' : 'games'}
            {now.qualifies ? '' : `, ${now.minGames - now.games} more to qualify for averages`}.
            {' '}<a href={`/leaderboard?week=${now.week}`}>See the board</a>
          </p>
          {best.length > 0 && (
            <ul class="pweek__boards">
              {best.map((s) => (
                <li class={`pweek__board${s.total!.rank !== null && s.total!.rank <= 3 ? ' pweek__board--top' : ''}`} key={s.key}>
                  <span class="pweek__blabel">{s.label}</span>
                  <span class="pweek__bval num">{n0(s.total!.value)}</span>
                  <span class="pweek__brank">{ordinal(s.total!.rank!)} of {s.total!.of}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {weeks.length > 0 && (
        <div class="table-wrap">
          <table class="pweek__table">
            <thead>
              <tr>
                <th>Week</th>
                <th class="num">Games</th>
                <th class="num">Skeets</th>
                <th class="num pweek__opt">SI dmg</th>
                <th class="num pweek__opt">Dmg as SI</th>
                <th>Awards</th>
              </tr>
            </thead>
            <tbody>{shown.map((r) => <WeekRow key={r.week} r={r} />)}</tbody>
          </table>
        </div>
      )}
      {!all && weeks.length > WEEKS_SHOWN && (
        <button type="button" class="btn btn--ghost btn--sm pweek__more" onClick={() => setAll(true)}>
          Show all {weeks.length} weeks
        </button>
      )}
    </section>
  );
}
