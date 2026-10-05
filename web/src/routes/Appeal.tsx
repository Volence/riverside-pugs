import { useEffect, useState } from 'preact/hooks';
import { ApiError, appealApi, type MyAppeals } from '../api';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { AppealBox } from '../components/AppealBox';

/**
 * /appeal: the one link the bot, the site and the Discord all give out.
 * Anyone can open it. A Steam session shows that account's bans; anyone
 * else signs in with Discord (/auth/discord/appeal), which is the only way
 * in for somebody banned from the Discord itself.
 */
export function Appeal() {
  const [state, setState] = useState<{ data: MyAppeals | null; signedOut: boolean }>({ data: null, signedOut: false });
  const failed = typeof location !== 'undefined' && new URLSearchParams(location.search).get('signin') === 'failed';
  useEffect(() => {
    appealApi.mine().then(
      (data) => setState({ data, signedOut: false }),
      (err) => setState({ data: null, signedOut: err instanceof ApiError && err.status === 401 }),
    );
  }, []);
  return (
    <div class="page page--play">
      <PageHeader eyebrow="Riverside" title="Appeal a ban" />
      <Panel>
        {failed && <p class="error">Signing in with Discord did not work. Try again.</p>}
        {state.signedOut && (
          <>
            <p>Sign in so we know whose ban this is.</p>
            {/* Backend routes: target keeps preact-iso from swallowing the click (see Play.tsx SignIn). */}
            <p>
              <a class="btn" href="/auth/steam" target="_top" rel="noopener">Sign in through Steam</a>{' '}
              <a class="btn" href="/auth/discord/appeal" target="_top" rel="noopener">Sign in with Discord</a>
            </p>
            <p class="muted">Banned from the Discord server? Use Sign in with Discord; it still works.</p>
          </>
        )}
        {state.data && (
          <>
            <p class="muted">Signed in as {state.data.name}.</p>
            <AppealBox fallback="Appeals are not open right now. Message a moderator in the Discord." />
          </>
        )}
      </Panel>
    </div>
  );
}
