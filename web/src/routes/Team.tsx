import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, logoUrl, teamsApi, type TeamView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { toLogoPng } from '../teamLogo';

const ROLE_LABEL = { captain: 'Captain', cocaptain: 'Co-captain', member: 'Member' } as const;
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
/** Mirrors src/teams/teams.ts: a full roster, and the players an event needs. */
const ROSTER_MAX = 8;
const ENTRY_MIN = 4;

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
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
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

  if (missing) return <main class="page page--profile"><PageHeader title="Team" /><Empty>No such team, or teams are not open yet.</Empty></main>;
  if (!team) return <main class="page page--profile"><PageHeader title="Team" /></main>;

  const live = team.disbandedAt === null;
  const role = team.viewer.role;
  // The server has no staff bypass for invitePlayer, cancelInvite, kickMember
  // or setJoinLink (src/teams/teams.ts): those need the viewer's own role to
  // be captain or (for kick/invite/cancel) cocaptain. `team.manage` is sent
  // to staff too, so it is never used alone to decide what to show here.
  const isCaptain = live && role === 'captain';
  const canManage = live && (role === 'captain' || role === 'cocaptain');
  // transferCaptain, renameTeam, disbandTeam and setLogoKey DO have a staff
  // bypass, so staff who are not on the team still get these.
  const staffControls = live && (role === 'captain' || team.viewer.staff);
  const joinUrl = team.manage?.joinLinkToken ? `${location.origin}/team/join/${team.manage.joinLinkToken}` : null;

  const starters = Math.min(team.members.length, ENTRY_MIN);
  const openSlots = live ? Math.max(0, ENTRY_MIN - team.members.length) : 0;
  const myRole = role ? ROLE_LABEL[role] : null;

  return (
    <main class="page page--profile teampage">
      <header class="teamhead">
        {team.logoKey ? <img class="teamhead__logo" src={logoUrl(team.logoKey)} alt="" width={112} height={112} />
          : <span class="teamhead__logo teamhead__logo--tag" aria-hidden="true">{team.tag}</span>}
        <div class="teamhead__text">
          <p class="teamhead__tag">[{team.tag}]</p>
          <h1 class="teamhead__name">{team.name}</h1>
          <p class="teamhead__line">
            {live ? <>Founded {day(team.createdAt)} · {team.members.length} / {ROSTER_MAX} players</>
              : <>Disbanded {day(team.disbandedAt!)}</>}
            {myRole && live && <span class="teamchip">You are {myRole.toLowerCase()}</span>}
          </p>
        </div>
      </header>
      {error && <p class="error" role="alert">{error}</p>}

      <Panel>
        <h3>Roster</h3>
        {team.members.length === 0 ? <Empty>Nobody is on this team.</Empty> : (
          <ul class="teamroster">
            {team.members.map((m) => (
              <li key={m.steamid} class="teamroster__row">
                {m.avatar ? <img class="teamroster__avatar" src={m.avatar} alt="" width={36} height={36} />
                  : <span class="teamroster__avatar teamroster__avatar--none" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>}
                <span class="teamroster__who">
                  <span class="teamroster__nameline">
                    <a class="teamroster__name" href={`/player/${m.steamid}`}>{m.name}</a>
                    <span class={`teamchip teamchip--${m.role}`}>{ROLE_LABEL[m.role]}</span>
                  </span>
                  <span class="teamroster__meta">Joined {day(m.joinedAt)}</span>
                </span>
                <span class="teamroster__actions">
                  {staffControls && m.role !== 'captain' && (
                    <>
                      {role === 'captain' && (m.role === 'member'
                        ? <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'cocaptain'))}>Make co-captain</button>
                        : <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.setRole(slug, m.steamid, 'member'))}>Make member</button>)}
                      <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.makeCaptain(slug, m.steamid))}>Make captain</button>
                    </>
                  )}
                  {canManage && m.steamid !== me && m.role !== 'captain' && (role === 'captain' || m.role === 'member') && (
                    <button class="btn btn--ghost btn--sm btn--quietdanger" disabled={busy} onClick={() => act(() => teamsApi.kick(slug, m.steamid))}>Kick</button>
                  )}
                </span>
              </li>
            ))}
            {Array.from({ length: openSlots }, (_, i) => (
              <li key={`open-${i}`} class="teamroster__row teamroster__row--open">
                <span class="teamroster__avatar teamroster__avatar--open" aria-hidden="true">+</span>
                <span class="teamroster__who"><span class="teamroster__meta">Open starter slot</span></span>
              </li>
            ))}
          </ul>
        )}
        {live && team.members.length > 0 && (
          <p class="teamnote">
            {starters < ENTRY_MIN
              ? `${ENTRY_MIN - team.members.length} more ${ENTRY_MIN - team.members.length === 1 ? 'player' : 'players'} needed to enter events.`
              : `Ready for events. Room for ${ROSTER_MAX - team.members.length} more as subs.`}
          </p>
        )}
      </Panel>

      {(canManage || isCaptain) && (
        <div class="teamgrid2">
          {canManage && (
            <Panel>
              <h3>Invite players</h3>
              <label class="teamfield">Find a player
                <input value={q} placeholder="Type at least two letters" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
              </label>
              {found.length > 0 && (
                <ul class="teamlist">
                  {found.map((p) => (
                    <li key={p.steamid}>
                      <span>{p.name}</span>
                      <button class="btn btn--sm" disabled={busy} aria-label={`Invite ${p.name}`} onClick={() => act(() => teamsApi.invite(slug, p.steamid), () => setQ(''))}>Invite</button>
                    </li>
                  ))}
                </ul>
              )}
              {team.manage!.invites.length > 0 && (
                <>
                  <p class="teamsub">Waiting on</p>
                  <ul class="teamlist">
                    {team.manage!.invites.map((i) => (
                      <li key={i.id}>
                        <span>{i.name} <span class="teamroster__meta">invited {day(i.createdAt)}</span></span>
                        <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.cancelInvite(i.id))}>Cancel invite</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>
          )}
          {isCaptain && (
            <Panel>
              <h3>Join link</h3>
              {joinUrl ? (
                <>
                  <p class="teamnote">Anyone with this link can join until you turn it off.</p>
                  <div class="teamlink">
                    <input readOnly value={joinUrl} aria-label="Join link" onFocus={(e) => (e.target as HTMLInputElement).select()} />
                    <button class="btn btn--sm" onClick={() => { void navigator.clipboard?.writeText(joinUrl); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, false), () => setCopied(false))}>Turn off join link</button>
                </>
              ) : (
                <>
                  <p class="teamnote">A link you can paste in Discord. Turning it off, or making a new one, stops the old link working.</p>
                  <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => teamsApi.joinLink(slug, true))}>Turn on join link</button>
                </>
              )}
            </Panel>
          )}
        </div>
      )}

      {staffControls && (
        <Panel>
          <h3>Team settings</h3>
          <div class="teamsetting">
            <div class="teamsetting__label">Logo<span class="teamroster__meta">Square images work best; it is cropped to fit.</span></div>
            <label class="btn btn--ghost btn--sm teamupload">
              {team.logoKey ? 'Replace logo' : 'Upload logo'}
              <input class="sr-only" type="file" accept="image/*" aria-label="Logo" disabled={busy} onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void act(async () => teamsApi.logo(slug, await toLogoPng(f)));
              }} />
            </label>
          </div>
          <div class="teamsetting">
            <div class="teamsetting__label">Name and tag<span class="teamroster__meta">{team.name} [{team.tag}]</span></div>
            {!renaming && <button class="btn btn--ghost btn--sm" onClick={() => { setNewName(team.name); setNewTag(team.tag); setRenaming(true); }}>Rename</button>}
          </div>
          {renaming && (
            <form class="teamform" onSubmit={(e) => {
              e.preventDefault();
              void act(() => teamsApi.rename(slug, {
                ...(newName !== team.name ? { name: newName } : {}),
                ...(newTag !== team.tag ? { tag: newTag } : {}),
              }), () => setRenaming(false));
            }}>
              <label class="teamfield">Name<input value={newName} maxLength={24} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} /></label>
              <label class="teamfield teamfield--tag">Tag<input value={newTag} maxLength={5} onInput={(e) => setNewTag((e.target as HTMLInputElement).value)} /></label>
              <button class="btn btn--sm" type="submit" disabled={busy}>Save</button>
              <button class="btn btn--ghost btn--sm" type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          )}
        </Panel>
      )}

      {live && (role || staffControls) && (
        <section class="teamdanger" aria-label="Leave or disband">
          {role && (
            <div class="teamsetting">
              <div class="teamsetting__label">Leave team<span class="teamroster__meta">
                {team.members.length === 1 ? 'You are the last player: leaving disbands the team.'
                  : role === 'captain' ? 'The captaincy passes to a co-captain, or the longest-serving player.' : 'You can be invited back later.'}
              </span></div>
              <button class="btn btn--ghost btn--sm btn--quietdanger" disabled={busy} onClick={() => act(() => teamsApi.leave(slug), () => route('/teams'))}>Leave team</button>
            </div>
          )}
          {staffControls && (
            <div class="teamsetting">
              <div class="teamsetting__label">Disband team<span class="teamroster__meta">Everyone leaves and the name and tag become free. The page stays as history.</span></div>
              {confirmDisband
                ? <span class="teamconfirm">
                    <button class="btn btn--sm btn--danger" disabled={busy} onClick={() => act(() => teamsApi.disband(slug))}>Yes, disband {team.name}</button>
                    <button class="btn btn--ghost btn--sm" onClick={() => setConfirmDisband(false)}>Keep it</button>
                  </span>
                : <button class="btn btn--ghost btn--sm btn--quietdanger" onClick={() => setConfirmDisband(true)}>Disband team</button>}
            </div>
          )}
        </section>
      )}

      {team.former.length > 0 && (
        <Panel>
          <h3>Former players</h3>
          <ul class="teamformer">{team.former.map((f) => <li key={f.steamid}><a href={`/player/${f.steamid}`}>{f.name}</a> <span class="teamroster__meta">left {day(f.leftAt)}</span></li>)}</ul>
        </Panel>
      )}
    </main>
  );
}

export default Team;
