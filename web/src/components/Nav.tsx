import { useLocation } from 'preact-iso';
import type { Session } from '../hooks/useLiveState';

/** [href, label, target?].
 *
 *  A target is what keeps preact-iso's click handler off a link: it only
 *  intercepts same-origin clicks whose target is absent or _self (router.js:45).
 *  The crosshair maker is a standalone static page with its own document, not a
 *  route, so without the target the router would swallow the click and show the
 *  SPA's not-found instead of the page. */
export const NAV_LINKS: readonly (readonly [string, string, string?])[] = [
  ['/', 'Play'],
  ['/live', 'Live'],
  ['/leaderboard', 'Leaderboard'],
  ['/matches', 'Matches'],
  ['/maps', 'Maps'],
  ['/replays', 'Replays'],
  ['/crosshair.html', 'Crosshair', '_blank'],
];

export function Nav({ session }: { session: Session }) {
  const { path } = useLocation();
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;

  return (
    <header class="nav">
      <a class="nav__brand" href="/">L4D1 PUG</a>
      <nav class="nav__links">
        {NAV_LINKS.map(([href, label, target]) => (
          <a key={href} href={href} target={target}
             rel={target ? 'noopener' : undefined}
             aria-current={path === href ? 'page' : undefined}>{label}</a>
        ))}
      </nav>
      {me && (
        <div class="nav__me">
          {me.avatar && <img src={me.avatar} alt="" />}
          <a href={`/player/${encodeURIComponent(me.steamid)}`}>{me.name}</a>
        </div>
      )}
    </header>
  );
}
