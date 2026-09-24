import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel, Tabs } from '../../components/bits';
import { Figure, Figures } from '../../components/PageHeader';
import { fmtTime } from './useAction';
import { fileUrl, ticketUrl } from './adminRoutes';

const FILTERS = [
  { key: 'active', label: 'In force' },
  { key: 'expired', label: 'Expired' },
  { key: 'all', label: 'All' },
];

/**
 * The ban list, inside the panel where the rest of enforcement lives.
 *
 * Lifted and expired bans stay on it: a record that quietly removes its own
 * mistakes is not a record, and who lifted one and when is the part that
 * shows the process works. A row whose reason reads "Withheld" came from a
 * ticket this viewer is not on; the server decided that.
 */
export function PeopleBans() {
  const [filter, setFilter] = useState<'active' | 'expired' | 'all'>('active');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useFetch((s) => peopleApi.bans(filter, query, s), [filter, query]);
  const bans = data?.bans ?? [];

  return (
    <Panel class="panel--table">
      {/* Only meaningful on the All tab: on Active or Expired every row already
          shares the same status, so "in force" and "on record" would just
          repeat the row count. All is the one view where the payload already
          holds both figures without a second request. */}
      {filter === 'all' && bans.length > 0 && (
        <Figures>
          <Figure label="In force" value={bans.filter((b) => b.active).length} />
          <Figure label="On record" value={bans.length} />
        </Figures>
      )}
      <Tabs tabs={FILTERS} active={filter} onSelect={(k) => setFilter(k as typeof filter)} />
      <form class="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} placeholder="Name or SteamID64" aria-label="Search bans"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit">Search</button>
        {query && (
          <button class="btn btn--ghost" type="button" onClick={() => { setQ(''); setQuery(''); }}>
            Clear
          </button>
        )}
      </form>
      {error && <Empty>Could not load the ban list.</Empty>}
      {data && bans.length === 0 && <Empty>{query ? 'Nobody by that name or ID.' : 'No bans here.'}</Empty>}
      {bans.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Player</th><th>Reason</th><th>Length</th><th>Issued</th><th>Status</th><th>Ticket</th></tr>
            </thead>
            <tbody>
              {bans.map((b) => (
                <tr key={b.id} class={b.active ? '' : 'is-lifted'}>
                  <td>
                    {b.canOpen ? <a href={fileUrl(b.steamid)}>{b.name}</a> : b.name}
                    <div class="mono muted">{b.steamid}</div>
                  </td>
                  {/* Staff-written text, rendered as text. */}
                  <td>{b.reason}</td>
                  <td>{b.length}</td>
                  <td class="muted">
                    {fmtTime(b.createdAt)}{b.createdByName ? ` by ${b.createdByName}` : ''}
                  </td>
                  <td>
                    {b.active ? <span class="admin-status admin-status--banned">in force</span>
                      : b.liftedAt ? <span class="muted">lifted {fmtTime(b.liftedAt)}{b.liftedByName ? ` by ${b.liftedByName}` : ''}</span>
                        : <span class="muted">expired</span>}
                  </td>
                  <td>{b.ticketId === null ? <span class="muted">none</span> : <a href={ticketUrl(b.ticketId)}>#{b.ticketId}</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
