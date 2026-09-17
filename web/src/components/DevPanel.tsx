import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

/** The dev-mode control panel, ported unchanged in function.
 *
 *  It is how the whole queue → ready → vote → match → ratings pipeline gets
 *  exercised without a live game server, so it earns its place in the new
 *  frontend. Visible only when the backend admits to DEV_MODE. */
export function DevPanel({ refresh }: { refresh: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [steamid, setSteamid] = useState('76561198000000001');

  useEffect(() => {
    // The route now answers in production too, so a 200 no longer means "dev
    // mode is on" -- the flag in the body does. The rejection path stays for an
    // older backend that still 404s this, and for an outright network failure.
    api.dev.enabled().then((r) => setEnabled(r?.enabled === true), () => setEnabled(false));
  }, []);

  if (!enabled) return null;

  const run = (fn: () => Promise<unknown>) => () => { void fn().catch(() => {}).then(refresh); };

  // Collapsible, because the panel is fixed to the bottom-right corner and at
  // full height it sits on top of the last rows of the leaderboard and stat
  // tables, exactly the rows you are usually trying to read while testing.
  return (
    <details class="devpanel" open>
      <summary class="eyebrow">dev</summary>
      <input
        value={steamid}
        aria-label="Dev login steamid"
        onInput={(e) => setSteamid((e.target as HTMLInputElement).value)}
      />
      <div class="devpanel__row">
        <button onClick={run(() => api.dev.login(steamid.trim()))}>login</button>
        <button onClick={run(api.dev.fill)}>fill</button>
        <button onClick={run(api.dev.readyAll)}>ready all</button>
        <button onClick={run(api.dev.voteAll)}>vote all</button>
        <button onClick={run(api.dev.clearMatches)}>clear</button>
        <button onClick={run(api.dev.simulateMatch)}>simulate</button>
      </div>
    </details>
  );
}
