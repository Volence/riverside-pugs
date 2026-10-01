import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type MyTeamItem, type TeamInviteItem, type TeamListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';

/** Mirrors src/teams/teams.ts: a full roster, and the players an event needs. */
const ROSTER_MAX = 8;
const ENTRY_MIN = 4;
const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;

export function TeamBadge({ tag, logoKey, size = 40 }: { tag: string; logoKey: string | null; size?: number }) {
  return logoKey
    ? <img class="teambadge" src={logoUrl(logoKey)} alt="" width={size} height={size} />
    : <span class="teambadge teambadge--tag" aria-hidden="true">{tag}</span>;
}

/** "5 / 8 players", plus where the roster stands for events. */
function rosterLine(members: number): string {
  const need = ENTRY_MIN - members;
  return `${members} / ${ROSTER_MAX} players · ${need > 0 ? `${need} more to enter events` : members < ROSTER_MAX ? 'ready for events' : 'roster full'}`;
}

/** One team as a row: badge, name and tag, a line under it, and whatever
 *  sits on the right (a role chip, or nothing). The whole row is the link. */
function TeamRow({ slug, name, tag, logoKey, line, chip }: {
  slug: string; name: string; tag: string; logoKey: string | null; line: string; chip?: { text: string; kind: string };
}) {
  return (
    <li>
      <a class="teamrow" href={`/team/${slug}`}>
        <TeamBadge tag={tag} logoKey={logoKey} />
        <span class="teamrow__who">
          <span class="teamrow__nameline">
            <span class="teamrow__name">{name}</span>
            <span class="teamrow__tag">[{tag}]</span>
          </span>
          <span class="teamroster__meta">{line}</span>
        </span>
        {chip && <span class={`teamchip teamchip--${chip.kind}`}>{chip.text}</span>}
      </a>
    </li>
  );
}

export function Teams({ session }: { session: Session }) {
  const { route } = useLocation();
  const signedIn = session.kind === 'active';
  const [all, setAll] = useState<TeamListItem[] | null>(null);
  const [mine, setMine] = useState<{ teams: MyTeamItem[]; invites: TeamInviteItem[]; canCreate: boolean } | null>(null);
  const [closed, setClosed] = useState(false);
  const [creating, setCreating] = useState(false);
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

  if (closed) return <main class="page page--profile teampage"><PageHeader title="Teams" /><Empty>Teams are not open yet.</Empty></main>;

  const onNone = mine !== null && mine.teams.length === 0;
  // With no team yet the form is the point of the page, so it shows at once;
  // otherwise it waits behind the header button.
  const showForm = !!mine?.canCreate && (creating || onNone);

  return (
    <main class="page page--profile teampage">
      <PageHeader eyebrow="Competitive" title="Teams" aside={mine?.canCreate && !showForm
        ? <button class="btn btn--ghost" onClick={() => setCreating(true)}>Start a team</button>
        : undefined} />
      {error && <p class="error" role="alert">{error}</p>}

      {mine && mine.invites.length > 0 && (
        <Panel>
          <h3>Invites</h3>
          <ul class="teamrows">
            {mine.invites.map((i) => (
              <li key={i.id} class="teaminvite">
                <span class="teamrow">
                  <TeamBadge tag={i.tag} logoKey={null} />
                  <span class="teamrow__who">
                    <span class="teamrow__nameline">
                      <a class="teamrow__name" href={`/team/${i.slug}`}>{i.name}</a>
                      <span class="teamrow__tag">[{i.tag}]</span>
                    </span>
                    <span class="teamroster__meta">{i.invitedByName ?? 'Someone'} invited you</span>
                  </span>
                  <span class="teamconfirm">
                    <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.accept(i.id))}>Accept</button>
                    <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.decline(i.id))}>Decline</button>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {mine && mine.teams.length > 0 && (
        <Panel>
          <h3>Your teams</h3>
          <ul class="teamrows">
            {mine.teams.map((t) => (
              <TeamRow key={t.slug} {...t} line={rosterLine(t.members)} chip={{ text: ROLE_LABEL[t.role], kind: t.role }} />
            ))}
          </ul>
        </Panel>
      )}

      {showForm && (
        <Panel>
          <h3>Start a team</h3>
          {onNone && <p class="teamnote teamnote--lead">You are not on a team yet. Start one here, or ask a captain for an invite or their join link.</p>}
          <form class="teamform" onSubmit={create}>
            <label class="teamfield">Team name<input value={name} maxLength={24} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label class="teamfield teamfield--tag">Tag<input value={tag} maxLength={5} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
            <button class="btn btn--sm" type="submit" disabled={busy}>Create team</button>
            {!onNone && <button class="btn btn--ghost btn--sm" type="button" onClick={() => setCreating(false)}>Cancel</button>}
          </form>
          <p class="teamnote">3 to 24 characters for the name, 2 to 5 letters or digits for the tag. You can rename it later.</p>
        </Panel>
      )}

      <Panel>
        <h3>All teams{all && all.length > 0 ? <span class="teamcount">{all.length}</span> : null}</h3>
        {all === null ? null : all.length === 0
          ? <Empty>No teams yet. Be the first.</Empty>
          : (
            <ul class="teamrows">
              {all.map((t) => (
                <TeamRow key={t.slug} {...t} line={`Captain ${t.captainName} · ${rosterLine(t.members)}`}
                  chip={t.members < ENTRY_MIN ? { text: 'Needs players', kind: 'open' } : undefined} />
              ))}
            </ul>
          )}
      </Panel>
    </main>
  );
}

export default Teams;
