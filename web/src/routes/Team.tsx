import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type TeamView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { toLogoPng } from '../teamLogo';

const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : '');

export function Team({ slug, session }: { slug: string; session: Session; refresh?: () => void }) {
  const { route } = useLocation();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [confirmDisband, setConfirmDisband] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const me = session.kind === 'active' ? session.me.steamid : null;

  const load = (signal?: AbortSignal) =>
    teamsApi.get(slug, signal).then(setTeam, (e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); });

  // The initial load is cancelled on unmount or when the slug changes, so a
  // slow response for a team the viewer already navigated away from can
  // never land on this component after it is gone.
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [slug]);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try { await fn(); after?.(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (missing) return <main class="page"><PageHeader title="Team" /><Empty>No such team, or teams are not open yet.</Empty></main>;
  if (!team) return <main class="page"><PageHeader title="Team" /></main>;

  const live = team.disbandedAt === null;
  const role = team.viewer.role;
  const captain = live && (role === 'captain' || team.viewer.staff);
  const manager = live && team.manage !== null;
  const joinUrl = team.manage?.joinLinkToken ? `${location.origin}/team/join/${team.manage.joinLinkToken}` : null;

  return (
    <main class="page">
      <div class="teamhead">
        {team.logoKey ? <img class="teamhead__logo" src={logoUrl(team.logoKey)} alt="" width={96} height={96} />
          : <span class="teamhead__logo teambadge--tag">{team.tag}</span>}
        <div>
          <h1 class="teamhead__name">{team.name}</h1>
          <p class="teamhead__line">[{team.tag}] · since {day(team.createdAt)}{!live && ` · Disbanded ${day(team.disbandedAt!)}`}</p>
        </div>
      </div>
      {error && <p class="error" role="alert">{error}</p>}

      <Panel>
        <h3>Roster</h3>
        {team.members.length === 0 ? <Empty>Nobody is on this team.</Empty> : (
          <table class="teamroster">
            <tbody>
              {team.members.map((m) => (
                <tr key={m.steamid}>
                  <td><a href={`/player/${m.steamid}`}>{m.name}</a></td>
                  <td>{ROLE_LABEL[m.role]}</td>
                  <td>joined {day(m.joinedAt)}</td>
                  <td class="teamroster__actions">
                    {captain && m.role !== 'captain' && (
                      <>
                        {role === 'captain' && (m.role === 'member'
                          ? <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'cocaptain'))}>Make co-captain</button>
                          : <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'member'))}>Make member</button>)}
                        <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.makeCaptain(slug, m.steamid))}>Make captain</button>
                      </>
                    )}
                    {manager && m.steamid !== me && m.role !== 'captain' && (role === 'captain' || team.viewer.staff || m.role === 'member') && (
                      <button class="btn btn--sm btn--danger" disabled={busy} onClick={() => act(() => teamsApi.kick(slug, m.steamid))}>Kick</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {manager && (
        <Panel>
          <h3>Invite</h3>
          <div class="teamsearch">
            <label>Find a player<input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
            {/* Hitting Invite (or Enter) with results showing invites the top
             *  match; a specific row's own Invite button below picks any other
             *  one when the search turned up more than one player. */}
            <button
              class="btn btn--sm"
              type="button"
              disabled={busy || found.length === 0}
              onClick={() => { if (found[0]) void act(() => teamsApi.invite(slug, found[0].steamid), () => setQ('')); }}
            >
              Invite
            </button>
          </div>
          <ul class="teamsearch__results">
            {found.map((p) => (
              <li key={p.steamid}>
                <button class="btn btn--sm" disabled={busy} aria-label={`Invite ${p.name}`} onClick={() => act(() => teamsApi.invite(slug, p.steamid), () => setQ(''))}>Invite</button> {p.name}
              </li>
            ))}
          </ul>
          {team.manage!.invites.length > 0 && (
            <ul class="teaminvites">
              {team.manage!.invites.map((i) => (
                <li key={i.id}>{i.name} (invited {day(i.createdAt)})
                  <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.cancelInvite(i.id))}>Cancel invite</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {captain && (
        <Panel>
          <h3>Team settings</h3>
          <div class="teamsettings">
            {joinUrl
              ? <p>Join link: <code>{joinUrl}</code> <button class="btn btn--sm" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, false))}>Turn off join link</button></p>
              : <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, true))}>Turn on join link</button>}
            <label>Logo<input type="file" accept="image/*" disabled={busy} onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void act(async () => teamsApi.logo(slug, await toLogoPng(f)));
            }} /></label>
            <form class="teamform" onSubmit={(e) => { e.preventDefault(); void act(() => teamsApi.rename(slug, { ...(newName ? { name: newName } : {}), ...(newTag ? { tag: newTag } : {}) }), () => { setNewName(''); setNewTag(''); }); }}>
              <label>New name<input value={newName} maxLength={24} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} /></label>
              <label>New tag<input value={newTag} maxLength={5} onInput={(e) => setNewTag((e.target as HTMLInputElement).value)} /></label>
              <button class="btn" type="submit" disabled={busy}>Rename</button>
            </form>
            {confirmDisband
              ? <button class="btn btn--danger" disabled={busy} onClick={() => act(() => teamsApi.disband(slug))}>Yes, disband {team.name}</button>
              : <button class="btn btn--danger" onClick={() => setConfirmDisband(true)}>Disband team</button>}
          </div>
        </Panel>
      )}

      {live && role && (
        <button class="btn" disabled={busy} onClick={() => act(() => teamsApi.leave(slug), () => route('/teams'))}>Leave team</button>
      )}

      {team.former.length > 0 && (
        <Panel>
          <h3>Former players</h3>
          <ul class="teamformer">{team.former.map((f) => <li key={f.steamid}><a href={`/player/${f.steamid}`}>{f.name}</a> · left {day(f.leftAt)}</li>)}</ul>
        </Panel>
      )}
    </main>
  );
}

export default Team;
