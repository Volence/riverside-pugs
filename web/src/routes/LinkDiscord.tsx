import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, ApiError } from '../api';
import { Panel } from '../components/bits';
import type { Session } from '../hooks/useLiveState';

const EXPIRED = 'This link has expired or was already used. Press a button on the bot again for a fresh one.';

/** What the backend refused with, as a sentence. */
function linkError(err: unknown): string {
  const e = err instanceof ApiError ? err.message : '';
  if (e === 'discord_taken') return 'That Discord account is already linked to a different Steam account.';
  if (e === 'already_linked') {
    return 'Your Steam account is already linked to a different Discord account. Disconnect it on your profile first.';
  }
  if (e === 'discord_banned') {
    return 'That Discord account cannot be linked right now. Contact an admin.';
  }
  return EXPIRED;
}

/**
 * Landing page for the link the Discord bot hands an unlinked user.
 *
 * Signed out: one button, through Steam and straight back here (the backend
 * keeps `next` across the OpenID round trip). Signed in: the page says which
 * Discord account is about to be attached to which Steam account, and does
 * nothing until the button is pressed.
 *
 * It used to spend the code on arrival. A link is a URL, and a URL can be sent
 * to somebody else: whoever opened it while signed in had the SENDER's Discord
 * attached to their account, and the sender could then queue, ready up and be
 * sent the match password as them. Arriving here must never be the consent.
 */
export function LinkDiscord({ session, refresh }: { session: Session; refresh: () => void }) {
  const { query } = useLocation();
  const code = (query as Record<string, string>).code ?? '';
  const [pending, setPending] = useState<{ discordId: string; discordName: string } | null>(null);
  const [result, setResult] = useState<
    | { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; name: string; active: boolean } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  const signedIn = me !== null;

  // Reads the code, never spends it.
  useEffect(() => {
    if (!signedIn || !code) return;
    let stale = false;
    api.peekDiscordCode(code)
      .then((p) => { if (!stale) setPending(p); })
      .catch((err) => { if (!stale) setResult({ kind: 'error', message: linkError(err) }); });
    return () => { stale = true; };
  }, [signedIn, code]);

  const confirm = () => {
    setResult({ kind: 'busy' });
    api.linkDiscordCode(code)
      .then((r) => {
        setResult({ kind: 'ok', name: r.discordName, active: r.active });
        refresh();
      })
      .catch((err) => setResult({ kind: 'error', message: linkError(err) }));
  };

  if (session.kind === 'loading') return <div class="page page--play" />;

  const other = me && pending && me.discord && me.discord.id !== pending.discordId ? me.discord : null;

  return (
    <div class="page page--play">
      <Panel class="hero-panel">
        <p class="eyebrow">Discord</p>
        <h1>Link your accounts</h1>
        {!code && <p class="error">This link is missing its code. Use the button the bot gave you.</p>}
        {code && !signedIn && (
          <>
            <p class="muted">Sign in with Steam first. You will be asked before anything is linked.</p>
            <a
              class="btn"
              href={`/auth/steam?next=${encodeURIComponent(`/link/discord?code=${code}`)}`}
              target="_top"
              rel="noopener"
            >
              Sign in through Steam
            </a>
          </>
        )}
        {me && pending && result.kind !== 'ok' && (
          <>
            <p>
              Discord account <strong>{pending.discordName}</strong>{' '}
              <span class="muted">(id {pending.discordId})</span>
            </p>
            <p>
              Steam account <strong>{me.name}</strong>{' '}
              <span class="muted">({me.steamid})</span>
            </p>
            {other ? (
              <p class="error">
                This Steam account is already linked to the Discord account {other.name}. Disconnect it on your
                profile first if you really mean to replace it.
              </p>
            ) : (
              <>
                <p class="muted">
                  Whoever holds that Discord account can queue, ready up and get the match password as you.
                  Only continue if it is yours and you asked the bot for this link yourself.
                </p>
                <button class="btn" onClick={confirm} disabled={result.kind === 'busy'}>Link these accounts</button>{' '}
                <a class="btn btn--ghost" href="/">Not me, cancel</a>
              </>
            )}
          </>
        )}
        {result.kind === 'busy' && <p class="muted">Linking...</p>}
        {result.kind === 'ok' && (
          <>
            <p>Linked to <strong>{result.name}</strong>.</p>
            <p class="muted">
              {result.active
                ? 'You can queue from Discord or from this site now.'
                : 'Linked, but your account is not active yet. Join the Riverside Discord server, or enter an invite code on the Play page.'}
            </p>
            <a class="btn" href="/">Go to Play</a>
          </>
        )}
        {result.kind === 'error' && <p class="error">{result.message}</p>}
      </Panel>
    </div>
  );
}
