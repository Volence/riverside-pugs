import { useState } from 'preact/hooks';
import { peopleApi, type PingTable } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fileUrl } from './adminRoutes';

/** A player's lowest ping across hosts, for marking their best column. */
function bestHost(cells: PingTable['players'][number]['cells']): string | null {
  let best: string | null = null;
  for (const [host, c] of Object.entries(cells)) if (best === null || c.ms < cells[best].ms) best = host;
  return best;
}

/**
 * Pings: every player's typical ping to every server host.
 *
 * The same numbers the ping chooser picks match servers with
 * (src/serverPick.ts): the median of each player's most recent 20 rounds on
 * that host within 60 days, measured by pug-match. Two servers on one machine
 * share a column, because they share a route. Staff, read only.
 */
export function PeoplePings() {
  const { data, error } = useFetch((s) => peopleApi.pings(s), []);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const players = (data?.players ?? []).filter((p) =>
    !needle || p.name.toLowerCase().includes(needle) || p.steamid.includes(needle));

  return (
    <Panel class="panel--table">
      <h3>Pings</h3>
      <p class="muted">
        Each player's typical ping to each server, from the last 20 rounds they played there (60 days at most).
        Their lowest is in bold. Hover a number for how many rounds it comes from and the packet loss.
        {data && (data.pickByPing
          ? ' Pick servers by ping is on, so these numbers decide which server a match gets.'
          : ' Pick servers by ping is off, so these numbers are recorded but not used.')}
      </p>
      {error && <Empty>Could not load the pings.</Empty>}
      {data && data.players.length === 0 && <Empty>No pings recorded yet. They arrive with each round played on a server running pug-match 0.3.23 or later.</Empty>}
      {data && data.players.length > 0 && (
        <>
          <div class="admin-search">
            <input type="search" placeholder="Filter by name or SteamID" value={q}
              aria-label="Filter players" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Player</th>
                  {data.hosts.map((h) => <th key={h.host} class="num" title={h.host}>{h.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const best = bestHost(p.cells);
                  return (
                    <tr key={p.steamid}>
                      <td><a href={fileUrl(p.steamid)}>{p.name}</a></td>
                      {data.hosts.map((h) => {
                        const c = p.cells[h.host];
                        if (!c) return <td key={h.host} class="num muted">-</td>;
                        const label = `${c.rounds} round${c.rounds === 1 ? '' : 's'}, ${c.loss}% loss`;
                        return (
                          <td key={h.host} class="num" title={label}>
                            {h.host === best ? <strong>{c.ms} ms</strong> : `${c.ms} ms`}
                            {c.rounds < 3 && <span class="muted"> ({c.rounds})</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {players.length === 0 && <Empty>Nobody matches that filter.</Empty>}
        </>
      )}
    </Panel>
  );
}
