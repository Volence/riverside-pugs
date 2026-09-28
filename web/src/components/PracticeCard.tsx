import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, ApiError, type PracticeParks } from '../api';
import { mapName } from '../format';
import { Panel } from './bits';
import { KIND_LABEL, leasePath } from '../practice';

/** Polled, like the signed-out queue count: the park's head count only
 *  changes on the server's minute tick, so anything faster is waste. */
const POLL_MS = 15_000;

/**
 * The Practice Park on the Play page (src/practiceLeases.ts).
 *
 * Shows every open park with its head count out of eight, so a player can
 * see there are people to practise with before joining. Join goes to the
 * park's invite page, which holds the connect line and password behind the
 * login; when no park is open, the button starts one. A player with a
 * practice server of their own gets a link back to it, since otherwise the
 * only way back to a drill server's page is the browser history.
 *
 * Signed out, it still lists the parks (a busy park says the site is alive,
 * the same job as the Landing block below it) and asks for a login to join.
 * Hidden entirely on an install that has no lease manager.
 */
export function PracticeCard({ signedIn }: { signedIn: boolean }) {
  const [data, setData] = useState<PracticeParks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Null outside a router (component tests render bare); the fallback is
  // a full page load, which lands on the same page.
  const loc = useLocation() as ReturnType<typeof useLocation> | undefined;
  const go = (path: string) => { if (loc?.route) loc.route(path); else location.assign(path); };

  useEffect(() => {
    let alive = true;
    const tick = () => api.practiceParks().then((r) => { if (alive) setData(r); }).catch(() => {});
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!data || !data.available) return null;

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const { lease } = await api.startPractice({ kind: 'park' });
      go(leasePath(lease.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the Practice Park.');
      setBusy(false);
    }
  };

  return (
    <Panel class="practice-card">
      <p class="eyebrow">Practice</p>
      <h3>Practice Park</h3>
      <p class="muted practice-card__blurb">
        Skeets, pounces, rocks and crowns on a real server with the PUG settings. Unranked, open to every player.
      </p>
      {data.parks.length === 0 ? (
        <p class="practice-card__empty">Nobody is in the park right now.</p>
      ) : (
        <ul class="practice-card__parks">
          {data.parks.map((p) => (
            <li key={p.id} class="practice-card__park">
              <span class="practice-card__server">{p.server}</span>
              <span class="num practice-card__count" aria-label={`${p.humans} of ${p.capacity} players`}>
                {p.humans}<span class="muted"> / {p.capacity}</span>
              </span>
              <span class="muted practice-card__map">{!p.ready ? 'starting up' : p.map ? mapName(p.map) : ''}</span>
              {signedIn
                ? <a class="btn" href={leasePath(p.id)}>Join</a>
                : null}
            </li>
          ))}
        </ul>
      )}
      {!signedIn ? (
        // target _top: /auth/steam is a backend route, see Play.tsx.
        <a class="btn btn--ghost" href="/auth/steam" target="_top" rel="noopener">Sign in to practise</a>
      ) : data.parks.length === 0 ? (
        <button class="btn btn--block" type="button" disabled={busy} onClick={start}>
          {busy ? 'Starting...' : 'Start a Practice Park'}
        </button>
      ) : null}
      {signedIn && data.mine && (
        <p class="practice-card__mine">
          <a href={leasePath(data.mine.id)}>Your {KIND_LABEL[data.mine.kind].toLowerCase()}</a> is open.
        </p>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
