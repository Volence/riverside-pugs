import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { teamsApi } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { TeamBadge } from './Teams';

export function TeamJoin({ token }: { token: string }) {
  const { route } = useLocation();
  const [team, setTeam] = useState<{ slug: string; name: string; tag: string; logoKey: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    teamsApi.joinInfo(token).then(setTeam, () => setError('That join link is turned off or was replaced.'));
  }, [token]);
  const join = async () => {
    setError(null);
    try { route(`/team/${(await teamsApi.join(token)).slug}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <main class="page">
      <PageHeader title="Join a team" />
      {error && <p class="error" role="alert">{error}</p>}
      {team
        ? <Panel><div class="teamjoin"><TeamBadge tag={team.tag} logoKey={team.logoKey} /><span>[{team.tag}] {team.name}</span><button class="btn" onClick={join}>Join {team.name}</button></div></Panel>
        : !error && <Empty>Loading...</Empty>}
    </main>
  );
}

export default TeamJoin;
