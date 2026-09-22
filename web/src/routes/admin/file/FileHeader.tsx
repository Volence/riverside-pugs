import { adminApi, modApi, type FileAction, type PlayerFileData } from '../../../api';
import { fmtTime, type Run } from '../useAction';
import { ticketUrl } from '../adminRoutes';

/**
 * Who this is, and the actions that are a single call.
 *
 * Ban and merge are not here: both need a form and both live in the section
 * that already explains them, so the header links down to them instead of
 * carrying a second copy of either.
 */
export function FileHeader(
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
    <header class="file-head">
      {h.avatar && <img class="file-head__avatar" src={h.avatar} alt="" />}
      <div>
        <h2>
          {h.name}
          {h.isAdmin && <span class="admin-tag">admin</span>}
          {h.isMod && <span class="admin-tag">mod</span>}
          <span class={`admin-status admin-status--${h.status}`}>{h.status}</span>
        </h2>
        <p class="muted mono">{h.steamid}</p>
        <p class="muted">
          SR {h.sr ?? 'n/a'} · {h.games} games · joined {fmtTime(h.createdAt)} ·
          {' '}Discord: {h.discordName ?? 'not linked'} ·
          {' '}<a href={`/player/${h.steamid}`}>public profile</a>
        </p>
      </div>
      <div class="admin-actions">
        {can('open_ticket') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(async () => {
              const r = await modApi.open(h.steamid, '', false);
              if (r.ticketId !== null) location.href = ticketUrl(r.ticketId);
            })}>
            Open a ticket
          </button>
        )}
        {can('ban') && <a class="chip" href="#standing">Ban</a>}
        {can('merge') && <a class="chip" href="#identity">Merge</a>}
        {can('staff_flags') && h.status === 'invited' && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.activate(h.steamid))}>Activate</button>
        )}
        {can('staff_flags') && !self && (
          <button class="chip" type="button" disabled={busy}
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
        )}
        {can('staff_flags') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.setMod(h.steamid, !h.isMod), h.isMod ? undefined : {
              title: `Make ${h.name} a moderator?`,
              body: 'They can see and work tickets and open any player file but their own and other staff. They get no settings and nothing on the game servers.',
              confirmLabel: 'Make moderator',
            })}>
            {h.isMod ? 'Remove moderator' : 'Make moderator'}
          </button>
        )}
        {can('staff_flags') && h.discordName && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.unlinkDiscord(h.steamid), {
              title: `Unlink ${h.name}'s Discord?`,
              body: 'They will have to link it again before they can queue, if Discord is required to queue.',
              confirmLabel: 'Unlink',
              danger: true,
            })}>
            Unlink Discord
          </button>
        )}
        {can('sign_out') && (
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.signOutPlayer(h.steamid), {
              title: `Sign ${h.name} out everywhere?`,
              body: 'Every browser they are signed in on stops working at once and has to sign in through Steam again. Use it when an account may be in somebody else\'s hands.',
              confirmLabel: 'Sign out',
            })}>
            Sign out everywhere
          </button>
        )}
      </div>
    </header>
  );
}
