import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { logoUrl, teamsApi } from '../api';
import type { Session } from '../hooks/useLiveState';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** Mirrors src/teams/teams.ts. */
const ROSTER_MAX = 8;

type JoinInfo = { slug: string; name: string; tag: string; logoKey: string | null; members: number; captainName: string };

export function TeamJoin({ token, session }: { token: string; session: Session }) {
  const { route } = useLocation();
  const signedIn = session.kind === 'active';
  const [team, setTeam] = useState<JoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Signed out, GET /api/teams/join/:token answers 401 whatever the link
    // holds: there is nothing wrong with the link, the visitor just has not
    // signed in yet, so this skips the fetch rather than report it as the
    // link being off.
    if (!signedIn) return;
    teamsApi.joinInfo(token).then(setTeam, () => setError('That join link is turned off or was replaced. Ask the captain for a new one.'));
  }, [token, signedIn]);
  const join = async () => {
    setError(null);
    setBusy(true);
    try { route(`/team/${(await teamsApi.join(token)).slug}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (session.kind === 'loading') return <main class="page page--play" />;
  if (session.kind === 'pending') {
    // Signed in, but not through the invite or Discord gate yet: "sign in"
    // would send them round in a circle.
    return (
      <main class="page page--play">
        <PageHeader title="Join a team" />
        <Panel>
          {session.me.status === 'banned'
            ? <p>This account cannot join teams.</p>
            : <p>Your account is not active yet. Finish getting set up on the <a href="/play">Play page</a>, then open this link again.</p>}
        </Panel>
      </main>
    );
  }
  if (!signedIn) {
    return (
      <main class="page page--play">
        <PageHeader title="Join a team" />
        <Panel>
          <p>Sign in to join this team.</p>
          {/* target _top: /auth/steam is a backend route, see Play.tsx. */}
          <a class="btn" href={`/auth/steam?next=${encodeURIComponent(`/team/join/${token}`)}`} target="_top" rel="noopener">
            Sign in through Steam
          </a>
        </Panel>
      </main>
    );
  }
  return (
    <main class="page page--play teampage">
      {error && <p class="error" role="alert">{error}</p>}
      {team ? (
        <section class="teamjoincard">
          <p class="teamhead__tag">You are invited to join</p>
          <header class="teamhead">
            {team.logoKey ? <img class="teamhead__logo" src={logoUrl(team.logoKey)} alt="" width={112} height={112} />
              : <span class="teamhead__logo teamhead__logo--tag" aria-hidden="true">{team.tag}</span>}
            <div class="teamhead__text">
              <p class="teamhead__tag">[{team.tag}]</p>
              <h1 class="teamhead__name">{team.name}</h1>
              <p class="teamhead__line">Captain {team.captainName} · {team.members} / {ROSTER_MAX} players</p>
            </div>
          </header>
          <div class="teamconfirm teamjoincard__actions">
            <button class="btn" disabled={busy || team.members >= ROSTER_MAX} onClick={join}>Join {team.name}</button>
            <a class="btn btn--ghost" href={`/team/${team.slug}`}>See the team first</a>
          </div>
          {team.members >= ROSTER_MAX && <p class="teamnote">The roster is full right now.</p>}
        </section>
      ) : !error && <Empty>Loading...</Empty>}
    </main>
  );
}

export default TeamJoin;
