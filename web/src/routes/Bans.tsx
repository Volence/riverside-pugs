import { useState } from 'preact/hooks';
import { api, type PublicBan } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { fmtDate } from '../format';

/**
 * The ban list, public.
 *
 * Public because a ban list only admins can read asks everyone else to take
 * enforcement on trust. The reason text is already shown to the person banned,
 * so nothing here is new to them; what it adds is that everyone else can see
 * the same thing. Lifted bans stay on the list, because a record that quietly
 * removes its own mistakes is not a record.
 */
export function Bans() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useFetch((s) => api.bans(query, s), [query]);
  const bans = data?.bans ?? [];
  const active = bans.filter((b) => b.active).length;

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Riverside" title="Bans">
        {bans.length > 0 && (
          <Figures>
            <Figure label="In force" value={active} />
            <Figure label="On record" value={bans.length} />
          </Figures>
        )}
      </PageHeader>

      <Panel>
        <form
          class="ban-search"
          onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}
        >
          <input
            value={q} placeholder="Name or SteamID64"
            aria-label="Search bans"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <button class="btn" type="submit">Search</button>
          {query && (
            <button class="btn btn--ghost" type="button" onClick={() => { setQ(''); setQuery(''); }}>
              Clear
            </button>
          )}
        </form>
      </Panel>

      <Panel class="panel--table">
        {error ? (
          <Empty>Couldn't load the ban list.</Empty>
        ) : !data ? (
          <Empty>Loading…</Empty>
        ) : bans.length === 0 ? (
          <Empty>{query ? 'Nobody by that name or ID has been banned.' : 'Nobody is banned.'}</Empty>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Reason</th>
                  <th>Issued</th>
                  <th>Until</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bans.map((b) => <BanRow key={`${b.steamid}-${b.createdAt}`} b={b} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function BanRow({ b }: { b: PublicBan }) {
  return (
    <tr class={b.active ? '' : 'is-lifted'}>
      <td class="pname"><PlayerLink steamid={b.steamid} name={b.name} /></td>
      {/* Admin-written text. Rendered as text, never as markup: it is the one
          field on this public page a person types by hand. */}
      <td class="ban-reason">{b.reason}</td>
      <td class="muted">
        {fmtDate(b.createdAt)}
        {b.bannedByName && <span class="ban-by"> by {b.bannedByName}</span>}
      </td>
      <td class="muted">{b.permanent ? 'Never' : fmtDate(b.expiresAt!)}</td>
      <td>
        {b.active ? (
          <span class="ban-state ban-state--on">{b.permanent ? 'Permanent' : 'Active'}</span>
        ) : b.liftedAt ? (
          <span class="ban-state muted">
            Lifted{b.liftedByName ? ` by ${b.liftedByName}` : ''}
          </span>
        ) : (
          <span class="ban-state muted">Expired</span>
        )}
      </td>
    </tr>
  );
}
