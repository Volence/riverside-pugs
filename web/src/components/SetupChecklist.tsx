import { api, type Me, type SiteInfo } from '../api';
import { useFetch } from '../hooks/useFetch';

/** Backend routes and external links need a real navigation, not the SPA
 *  router (see SignIn in Play for the history). */
const OUT = { target: '_top', rel: 'noopener' } as const;

type StepState = 'done' | 'todo' | 'unknown';

/**
 * What you need before you can queue, ticked off against the signed-in
 * player. Used on the signup screen, in place of the Join button when a step
 * is missing, and on How to play.
 */
export function SetupChecklist({ me, compact = false }: { me: Me | null; compact?: boolean }) {
  const { data: site } = useFetch((s) => api.site(s), []);
  if (!site) return null;
  return <Checklist me={me} site={site} compact={compact} />;
}

export function Checklist({ me, site, compact }: { me: Me | null; site: SiteInfo; compact?: boolean }) {
  const member: StepState = !me?.discord ? 'todo' : me.discordMember === true ? 'done' : me.discordMember === false ? 'todo' : 'unknown';
  const steps: { title: string; body: string; state: StepState; action?: { href: string; label: string; external?: boolean } }[] = [
    {
      title: 'Sign in with Steam',
      body: 'Your Steam account is your PUG account: your SR and match history live on it.',
      state: me ? 'done' : 'todo',
      action: me ? undefined : { href: '/auth/steam', label: 'Sign in through Steam' },
    },
  ];
  if (site.discordEnabled) {
    steps.push(
      {
        title: 'Join the Riverside Discord',
        body: 'Queue pops, match cards and your team voice channel all happen there.',
        state: member,
        action: member === 'done' || !site.discordInviteUrl ? undefined : { href: site.discordInviteUrl, label: 'Join the Discord', external: true },
      },
      {
        title: 'Link your Discord account',
        body: 'So the bot knows which Steam account is you. One click, and you can queue from Discord too.',
        state: me?.discord ? 'done' : 'todo',
        action: me && !me.discord ? { href: '/auth/discord', label: 'Connect Discord' } : undefined,
      },
    );
  }
  const ready = steps.every((s) => s.state !== 'todo');
  return (
    <div class={`checklist${compact ? ' checklist--compact' : ''}`}>
      <ol>
        {steps.map((s, n) => (
          <li key={s.title} class={`checklist__step is-${s.state}`}>
            <span class="checklist__mark" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'unknown' ? '?' : n + 1}</span>
            <div>
              <p class="checklist__title">{s.title}{s.state === 'done' && <span class="sr-only"> (done)</span>}</p>
              {!compact && <p class="muted">{s.body}</p>}
              {s.state === 'unknown' && <p class="muted">Could not check the Discord server right now. If you are in it, you are fine.</p>}
              {me?.discord && s.title.startsWith('Link') && <p class="muted">Linked to {me.discord.name}.</p>}
              {s.action && (
                <a class="btn" href={s.action.href} {...(s.action.external ? { target: '_blank', rel: 'noopener' } : OUT)}>{s.action.label}</a>
              )}
            </div>
          </li>
        ))}
      </ol>
      {ready && me && !compact && <p class="checklist__ready">You are all set. Join the queue on <a href="/">Play</a> or in #queue-here on Discord.</p>}
    </div>
  );
}
