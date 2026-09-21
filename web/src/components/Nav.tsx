import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, type StateSnapshot } from '../api';
import { campaignName } from '../format';
import type { Session } from '../hooks/useLiveState';

/** [href, label, target?].
 *
 *  A target is what keeps preact-iso's click handler off a link: it only
 *  intercepts same-origin clicks whose target is absent or _self
 *  (router.js:45), so anything that is a real file rather than a route needs
 *  one. Nothing here needs it today, since the crosshair maker became a route.
 *  The rule is kept, and tested, because the next static page added here would
 *  otherwise land on the SPA's not-found.
 *
 *  The maps route is labelled Campaigns: that is how players refer to what it
 *  lists. The path stays /maps so nothing bookmarked breaks. */
export const NAV_LINKS: readonly (readonly [string, string, string?])[] = [
  ['/', 'Play'],
  ['/live', 'Live'],
  ['/streams', 'Streams'],
  ['/leaderboard', 'Leaderboard'],
  ['/matches', 'Matches'],
  ['/maps', 'Campaigns'],
  ['/custom-campaigns', 'Custom'],
  ['/crosshair', 'Crosshair'],
  ['/how-to-play', 'How to play'],
];

export function Nav(
  { session, state, onSignedOut }: {
    session: Session;
    state: StateSnapshot | null;
    /** Called once the session is gone, to re-read who is signed in. */
    onSignedOut?: () => void;
  },
) {
  const { path } = useLocation();
  const [leaving, setLeaving] = useState(false);
  // Offered to a pending or banned account as well: signing out is never
  // something to withhold. On failure the control comes back so they can
  // try again; on success the session re-read removes it.
  const signOut = async () => {
    setLeaving(true);
    try {
      await api.logout();
      onSignedOut?.();
    } finally {
      setLeaving(false);
    }
  };
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
        {/* The ban list is admins only for now, so its link is too. */}
        {me?.isAdmin && (
          <a href="/bans" aria-current={path === '/bans' ? 'page' : undefined}>Bans</a>
        )}
        {me?.isAdmin && (
          <a href="/admin" aria-current={path === '/admin' ? 'page' : undefined}>Admin</a>
        )}
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
          <button type="button" class="nav__signout" onClick={signOut} disabled={leaving}>Sign out</button>
        </div>
      )}
    </header>
  );
}
