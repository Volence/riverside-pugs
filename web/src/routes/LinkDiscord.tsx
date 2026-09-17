import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, ApiError } from '../api';
import { Panel } from '../components/bits';
import type { Session } from '../hooks/useLiveState';

/**
 * Landing page for the link the Discord bot hands an unlinked user.
 *
 * Signed out: one button, through Steam and straight back here (the backend
 * keeps `next` across the OpenID round trip). Signed in: spends the code once
 * on arrival, so the whole flow is two clicks from Discord.
 */
export function LinkDiscord({ session, refresh }: { session: Session; refresh: () => void }) {
  const { query } = useLocation();
  const code = (query as Record<string, string>).code ?? '';
  const [result, setResult] = useState<
    | { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; name: string; active: boolean } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const tried = useRef(false);

  const signedIn = session.kind === 'active' || session.kind === 'pending';

  useEffect(() => {
    if (!signedIn || !code || tried.current) return;
    tried.current = true;
    setResult({ kind: 'busy' });
    api.linkDiscordCode(code)
      .then((r) => {
        setResult({ kind: 'ok', name: r.discordName, active: r.active });
        refresh();
      })
      .catch((err) => {
        const e = err instanceof ApiError ? err.message : '';
        setResult({
          kind: 'error',
          message: e === 'discord_taken'
            ? 'That Discord account is already linked to a different Steam account.'
            : 'This link has expired or was already used. Press a button on the bot again for a fresh one.',
        });
      });
  }, [signedIn, code]);

  if (session.kind === 'loading') return <div class="page page--play" />;

  return (
    <div class="page page--play">
      <Panel class="hero-panel">
        <p class="eyebrow">Discord</p>
        <h1>Link your accounts</h1>
        {!code && <p class="error">This link is missing its code. Use the button the bot gave you.</p>}
        {code && !signedIn && (
          <>
            <p class="muted">Sign in with Steam once and your Discord account is linked to it.</p>
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
