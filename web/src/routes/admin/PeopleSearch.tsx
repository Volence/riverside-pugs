import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fileUrl } from './adminRoutes';

/** Find a person and open their file. The list holds only files this viewer
 *  could open: the server decides that, and a moderator simply never sees a
 *  colleague's row rather than seeing one that refuses to open. */
export function PeopleSearch() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useFetch((s) => peopleApi.people(query, s), [query]);
  const players = data?.players ?? [];

  return (
    <Panel class="panel--table">
      <form class="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input
          value={q} placeholder="Name, SteamID or Discord" aria-label="Search players"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <button class="btn" type="submit">Search</button>
      </form>
      {error && <Empty>Could not load the player list.</Empty>}
      {data && players.length === 0 && <Empty>No players match.</Empty>}
      {players.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Player</th><th>Status</th><th class="num">SR</th>
                <th class="num">Games</th><th>Discord</th><th class="num">Offenses</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.steamid}>
                  <td>
                    <a href={fileUrl(p.steamid)}>{p.name}</a>
                    {p.isAdmin && <span class="admin-tag">admin</span>}
                    {p.isMod && <span class="admin-tag">mod</span>}
                    <div class="mono muted">{p.steamid}</div>
                  </td>
                  <td><span class={`admin-status admin-status--${p.status}`}>{p.status}</span></td>
                  <td class="num">{p.sr ?? <span class="muted">n/a</span>}</td>
                  <td class="num">{p.games}</td>
                  <td>{p.discordName ?? <span class="muted">not linked</span>}</td>
                  <td class={`num${p.offenses ? ' admin-warn' : ' muted'}`}>{p.offenses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
