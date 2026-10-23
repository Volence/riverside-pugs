import type { ComponentChildren } from 'preact';
import { adminApi, modApi, type FileAction, type PlayerFileData } from '../../../api';
import { type Run } from '../useAction';
import { ticketUrl } from '../adminRoutes';

/** A day in the viewer's own words ("Sep 18, 2026"); the hour adds nothing
 *  to when someone joined. */
export const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Who this is: face, name, roles and the four facts every visit wants (SR,
 * games, when they joined, which Discord). Standing and the actions sit
 * beside it in the hero; see StandingBanner and FileActions.
 */
export function FileHeader({ d }: { d: PlayerFileData }) {
  const h = d.header;
  return (
    <header class="file-head">
      {h.avatar
        ? <img class="file-head__avatar" src={h.avatar} alt="" />
        : <span class="file-head__avatar file-head__avatar--none" aria-hidden="true">{h.name.slice(0, 1)}</span>}
      <div class="file-head__who">
        <h2>
          {h.name}
          {h.isAdmin && <span class="admin-tag">admin</span>}
          {h.isMod && <span class="admin-tag">mod</span>}
          {h.isCaster && <span class="admin-tag">caster</span>}
          <span class={`admin-status admin-status--${h.status}`}>{h.status}</span>
        </h2>
        <p class="file-head__sub">
          <span class="mono">{h.steamid}</span>
          {' · '}<a href={`/player/${h.steamid}`}>public profile</a>
        </p>
        <dl class="file-facts">
          <div class="file-facts__sr"><dt>SR</dt><dd>{h.sr ?? 'n/a'}</dd></div>
          <div><dt>Games</dt><dd>{h.games}</dd></div>
          <div><dt>Joined</dt><dd>{fmtDay(h.createdAt)}</dd></div>
          <div><dt>Discord</dt><dd>{h.discordName ?? <span class="muted">not linked</span>}</dd></div>
        </dl>
      </div>
    </header>
  );
}

function Group({ label, children }: { label: string; children: ComponentChildren[] }) {
  const shown = children.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div class="file-acts__group" role="group" aria-label={label}>
      <span class="file-acts__label">{label}</span>
      <div class="file-acts__chips">{shown}</div>
    </div>
  );
}

/**
 * The actions that are a single call, grouped by what they touch: the case
 * (a ticket, the merge tool), the person's roles here, and their sign-ins.
 *
 * Ban and Unban are not here: they live on the standing banner, next to the
 * thing they change. Merge needs its preview form, so it jumps down to it.
 */
export function FileActions(
  { d, me, busy, run, can }: {
    d: PlayerFileData;
    me: string;
    busy: boolean;
    run: Run;
    can: (action: FileAction) => boolean;
  },
) {
  const h = d.header;
  const self = h.steamid === me;
  return (
    <div class="file-acts">
      <Group label="Case">{[
        can('open_ticket') && (
          <button key="ticket" class="chip" type="button" disabled={busy}
            onClick={() => run(async () => {
              const r = await modApi.open(h.steamid, '', false);
              if (r.ticketId !== null) location.href = ticketUrl(r.ticketId);
            })}>
            Open a ticket
          </button>
        ),
        can('merge') && <a key="merge" class="chip" href="#merge">Merge</a>,
        can('staff_flags') && h.status === 'invited' && (
          <button key="activate" class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.activate(h.steamid))}>Activate</button>
        ),
      ]}</Group>
      <Group label="Roles">{[
        can('staff_flags') && !self && (
          <button key="admin" class={`chip${h.isAdmin ? ' is-on' : ''}`} type="button" disabled={busy}
            onClick={() => run(() => adminApi.setAdmin(h.steamid, !h.isAdmin), h.isAdmin ? {
              title: `Remove admin from ${h.name}?`,
              body: 'They lose the admin panel and their admin on every game server.',
              confirmLabel: 'Remove admin',
              danger: true,
            } : {
              title: `Make ${h.name} an admin?`,
              body: 'They get the admin panel here and the same admin rights on every game server.',
              confirmLabel: 'Make admin',
            })}>
            {h.isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        ),
        can('staff_flags') && (
          <button key="mod" class={`chip${h.isMod ? ' is-on' : ''}`} type="button" disabled={busy}
            onClick={() => run(() => adminApi.setMod(h.steamid, !h.isMod), h.isMod ? undefined : {
              title: `Make ${h.name} a moderator?`,
              body: 'They can see and work tickets and open any player file but their own and other staff. They get no settings and nothing on the game servers.',
              confirmLabel: 'Make moderator',
            })}>
            {h.isMod ? 'Remove moderator' : 'Make moderator'}
          </button>
        ),
        can('staff_flags') && (
          <button key="caster" class={`chip${h.isCaster ? ' is-on' : ''}`} type="button" disabled={busy}
            onClick={() => run(() => adminApi.setCaster(h.steamid, !h.isCaster), h.isCaster ? undefined : {
              title: `Make ${h.name} a caster?`,
              body: 'They can open the Cast page, which shows the game server and password of every live match so they can join as a spectator. They see both teams in first person. Nothing else: no tickets, no files, no admin on the game servers.',
              confirmLabel: 'Make caster',
            })}>
            {h.isCaster ? 'Remove caster' : 'Make caster'}
          </button>
        ),
        can('staff_flags') && (h.isCaster || h.isAdmin) && (
          <button key="overlay" class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.revokeCastKey(h.steamid), {
              title: `Reset ${h.name}'s overlay links?`,
              body: 'Every caster studio overlay link they have handed to OBS stops working at once. They can copy fresh links from the studio. For a leaked link; to take casting away from a caster, remove the flag instead.',
              confirmLabel: 'Reset links',
              danger: true,
            })}>
            Reset overlay links
          </button>
        ),
      ]}</Group>
      <Group label="Sign-ins">{[
        can('staff_flags') && h.discordName && (
          <button key="unlink" class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.unlinkDiscord(h.steamid), {
              title: `Unlink ${h.name}'s Discord?`,
              body: 'They will have to link it again before they can queue, if Discord is required to queue.',
              confirmLabel: 'Unlink',
              danger: true,
            })}>
            Unlink Discord
          </button>
        ),
        can('sign_out') && (
          <button key="signout" class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.signOutPlayer(h.steamid), {
              title: `Sign ${h.name} out everywhere?`,
              body: 'Every browser they are signed in on stops working at once and has to sign in through Steam again. Use it when an account may be in somebody else\'s hands.',
              confirmLabel: 'Sign out',
            })}>
            Sign out everywhere
          </button>
        ),
      ]}</Group>
    </div>
  );
}
