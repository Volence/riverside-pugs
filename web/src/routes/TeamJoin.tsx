import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { teamsApi } from '../api';
import type { Session } from '../hooks/useLiveState';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { TeamBadge } from './Teams';

export function TeamJoin({ token, session }: { token: string; session: Session }) {
  const { route } = useLocation();
  const signedIn = session.kind === 'active';
  const [team, setTeam] = useState<{ slug: string; name: string; tag: string; logoKey: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Signed out, GET /api/teams/join/:token answers 401 whatever the link
    // holds: there is nothing wrong with the link, the visitor just has not
    // signed in yet, so this skips the fetch rather than report it as the
    // link being off.
    if (!signedIn) return;
    teamsApi.joinInfo(token).then(setTeam, () => setError('That join link is turned off or was replaced.'));
  }, [token, signedIn]);
  const join = async () => {
    setError(null);
    try { route(`/team/${(await teamsApi.join(token)).slug}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  if (session.kind === 'loading') return <main class="page page--play" />;
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
    <main class="page page--play">
      <PageHeader title="Join a team" />
      {error && <p class="error" role="alert">{error}</p>}
      {team
        ? <Panel><div class="teamjoin"><TeamBadge tag={team.tag} logoKey={team.logoKey} /><span>[{team.tag}] {team.name}</span><button class="btn" onClick={join}>Join {team.name}</button></div></Panel>
        : !error && <Empty>Loading...</Empty>}
    </main>
  );
}

export default TeamJoin;
