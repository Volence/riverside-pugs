import { useLocation } from 'preact-iso';
import type { StateSnapshot } from '../api';
import { campaignName } from '../format';
import type { Session } from '../hooks/useLiveState';

/** [href, label, target?].
 *
 *  A target is what keeps preact-iso's click handler off a link: it only
 *  intercepts same-origin clicks whose target is absent or _self (router.js:45).
 *  The crosshair maker is a standalone static page with its own document, not a
 *  route, so without the target the router would swallow the click and show the
 *  SPA's not-found instead of the page.
 *
 *  The maps route is labelled Campaigns: that is how players refer to what it
 *  lists. The path stays /maps so nothing bookmarked breaks. */
export const NAV_LINKS: readonly (readonly [string, string, string?])[] = [
  ['/', 'Play'],
  ['/live', 'Live'],
  ['/leaderboard', 'Leaderboard'],
  ['/matches', 'Matches'],
  ['/maps', 'Campaigns'],
  ['/crosshair.html', 'Crosshair', '_blank'],
];

export function Nav({ session, state }: { session: Session; state: StateSnapshot | null }) {
  const { path } = useLocation();
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  const live = state?.match && state.match.state === 'live' ? state.match : null;

  return (
    <header class="nav">
      <a class="nav__brand" href="/">Riverside</a>
      <nav class="nav__links">
        {NAV_LINKS.map(([href, label, target]) => (
          <a key={href} href={href} target={target}
             rel={target ? 'noopener' : undefined}
             aria-current={path === href ? 'page' : undefined}>{label}</a>
        ))}
      </nav>
      {live && (
        <a class="nav__live" href="/live">
          <span class="nav__live-dot" aria-hidden="true" />
          Live · {campaignName(live.campaign)}
        </a>
      )}
      {me && (
        <div class="nav__me">
          {me.avatar && <img src={me.avatar} alt="" />}
          <a href={`/player/${encodeURIComponent(me.steamid)}`}>{me.name}</a>
        </div>
      )}
    </header>
  );
}
