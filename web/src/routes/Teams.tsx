import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type MyTeamItem, type TeamInviteItem, type TeamListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';

export function TeamBadge({ tag, logoKey }: { tag: string; logoKey: string | null }) {
  return logoKey
    ? <img class="teambadge" src={logoUrl(logoKey)} alt="" width={40} height={40} />
    : <span class="teambadge teambadge--tag" aria-hidden="true">{tag}</span>;
}

function TeamCard({ slug, name, tag, logoKey, line }: { slug: string; name: string; tag: string; logoKey: string | null; line: string }) {
  return (
    <a class="teamcard" href={`/team/${slug}`}>
      <TeamBadge tag={tag} logoKey={logoKey} />
      <span class="teamcard__name">{name}</span>
      <span class="teamcard__line">[{tag}] · {line}</span>
    </a>
  );
}

const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;

export function Teams({ session }: { session: Session }) {
  const { route } = useLocation();
  const signedIn = session.kind === 'active';
  const [all, setAll] = useState<TeamListItem[] | null>(null);
  const [mine, setMine] = useState<{ teams: MyTeamItem[]; invites: TeamInviteItem[]; canCreate: boolean } | null>(null);
  const [closed, setClosed] = useState(false);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    teamsApi.list().then((r) => setAll(r.teams), (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
    if (signedIn) teamsApi.mine().then(setMine, () => {});
  };
  useEffect(load, [signedIn]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const create = async (ev: Event) => {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { slug } = await teamsApi.create(name, tag);
      route(`/team/${slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (closed) return <main class="page"><PageHeader title="Teams" /><Empty>Teams are not open yet.</Empty></main>;

  return (
    <main class="page">
      <PageHeader title="Teams" />
      {error && <p class="error" role="alert">{error}</p>}
      {mine && mine.invites.length > 0 && (
        <Panel>
          <h3>Invites</h3>
          <ul class="teaminvites">
            {mine.invites.map((i) => (
              <li key={i.id}>
                <span>{i.invitedByName ?? 'Someone'} invited you to <a href={`/team/${i.slug}`}>[{i.tag}] {i.name}</a></span>
                <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.accept(i.id))}>Accept</button>
                <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => teamsApi.decline(i.id))}>Decline</button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {mine && mine.teams.length > 0 && (
        <Panel>
          <h3>Your teams</h3>
          <div class="teamgrid">
            {mine.teams.map((t) => <TeamCard key={t.slug} {...t} line={ROLE_LABEL[t.role]} />)}
          </div>
        </Panel>
      )}
      {mine?.canCreate && (
        <Panel>
          <h3>Start a team</h3>
          <form class="teamform" onSubmit={create}>
            <label>Team name<input value={name} maxLength={24} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>Tag<input value={tag} maxLength={5} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
            <button class="btn" type="submit" disabled={busy}>Create team</button>
          </form>
        </Panel>
      )}
      <Panel>
        <h3>All teams</h3>
        {all === null ? null : all.length === 0
          ? <Empty>No teams yet.</Empty>
          : <div class="teamgrid">{all.map((t) => <TeamCard key={t.slug} {...t} line={`${t.members} players`} />)}</div>}
      </Panel>
    </main>
  );
}

export default Teams;
