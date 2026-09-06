import { useLocation } from 'preact-iso';
import type { Session } from '../hooks/useLiveState';

const LINKS = [
  ['/', 'Play'],
  ['/leaderboard', 'Leaderboard'],
  ['/matches', 'Matches'],
] as const;

export function Nav({ session }: { session: Session }) {
  const { path } = useLocation();
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;

  return (
    <header class="nav">
      <a class="nav__brand" href="/">L4D1 PUG</a>
      <nav class="nav__links">
        {LINKS.map(([href, label]) => (
          <a key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</a>
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
