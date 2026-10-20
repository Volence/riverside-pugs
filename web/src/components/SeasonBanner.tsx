import { useState } from 'preact/hooks';
import { seasonProgress, useSeasonLook } from '../seasonTheme';

/** The strip under the nav on Play and the leaderboard while a themed season
 *  runs: its name, which week it is, and the days left once staff have set an
 *  end date. A season without a theme shows nothing, so Season 0 is
 *  unchanged. The name is split at its first colon or "Season N" prefix so
 *  "Season 1: Wrong Way" reads as a number and a title.
 *
 *  `is-tearing` plays Wrong Way's tear (app.css) once when the banner first
 *  shows and again on hover; the banner's own animation ending clears it.
 *  Other looks, and reduced motion, have no tear, so the class does nothing
 *  there. */
export function SeasonBanner({ path }: { path: string }) {
  const season = useSeasonLook();
  const [tearing, setTearing] = useState(true);
  if (!season?.theme || !(path === '/' || path === '/leaderboard')) return null;
  const { week, weeks, daysLeft } = seasonProgress(season);
  const m = season.name.match(/^(season\s+\d+)\s*[:\-·]?\s*(.*)$/i);
  const number = m ? m[1] : season.name;
  const title = m && m[2] ? m[2] : (season.theme === 'wrong-way' ? 'Wrong Way' : '');
  return (
    <aside
      class={`season-banner${tearing ? ' is-tearing' : ''}`} aria-label="Current season"
      onMouseEnter={() => setTearing(true)}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setTearing(false); }}
    >
      <span class="season-banner__number" data-text={number}>{number}</span>
      {title && <span class="season-banner__title"><span class="season-banner__title-text" data-text={title}>{title}</span></span>}
      <span class="season-banner__when">
        {weeks ? `Week ${week} of ${weeks}` : `Week ${week}`}
        {daysLeft !== null && ` · ${daysLeft <= 1 ? 'last day' : `${daysLeft} days left`}`}
      </span>
    </aside>
  );
}
