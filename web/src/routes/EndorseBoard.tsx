import { useMemo, useState } from 'preact/hooks';
import { api, type EndorseBoardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

type Key = 'total' | 'caller' | 'clutch' | 'vibes' | 'givers' | 'games';

/** Total first, the three kinds, then who gave them and how much they played.
 *  The labels match ENDORSE_LABEL in src/endorsements.ts. */
const COLS: { key: Key; label: string; title: string }[] = [
  { key: 'total', label: 'Total', title: 'Every endorsement, all kinds' },
  { key: 'caller', label: 'Caller', title: 'Caller endorsements' },
  { key: 'clutch', label: 'Clutch', title: 'Clutch endorsements' },
  { key: 'vibes', label: 'Good vibes', title: 'Good vibes endorsements' },
  { key: 'givers', label: 'People', title: 'How many different people endorsed them' },
  { key: 'games', label: 'Games', title: 'Games played this season' },
];

/**
 * Who the community endorsed this season. Sorted by any column; ties go to
 * the player more different people endorsed, so ten from one duo partner do
 * not outrank ten from ten people.
 */
export function EndorseBoard({ season, me }: { season?: number; me: string | null }) {
  const { data, error } = useFetch((s) => api.endorseBoard(s, season), [season]);
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: 'total', desc: true });

  const rows = useMemo(() => [...(data?.rows ?? [])].sort((x: EndorseBoardRow, y: EndorseBoardRow) => {
    const d = sort.desc ? y[sort.key] - x[sort.key] : x[sort.key] - y[sort.key];
    return d || y.givers - x.givers || y.total - x.total || x.name.localeCompare(y.name);
  }), [data, sort]);

  if (error) return <Panel class="panel--table"><Empty>Couldn't load endorsements.</Empty></Panel>;
  if (!data) return <Panel class="panel--table"><Empty>Loading…</Empty></Panel>;
  if (rows.length === 0) return <Panel class="panel--table"><Empty>Nobody has been endorsed this season yet.</Empty></Panel>;

  return (
    <Panel class="panel--table">
      <div class="table-wrap lb">
        <table>
          <thead>
            <tr>
              <th class="rank lb__rank">#</th>
              <th class="lb__pcol">Player</th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  class={`num sortable${sort.key === c.key ? ' is-sorted' : ''}`}
                  title={`${c.title}. Click to sort.`}
                  onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}
                >
                  {c.label}
                  {sort.key === c.key && <span class="sortable__arrow">{sort.desc ? '▾' : '▴'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.steamid} class={r.steamid === me ? 'is-me' : ''}>
                <td class={`rank lb__rank${i < 3 ? ' rank--top' : ''}`}>{String(i + 1).padStart(2, '0')}</td>
                <td class="lb__pcol pname" title={r.name}><PlayerLink steamid={r.steamid} name={r.name} /></td>
                {COLS.map((c) => (
                  <td key={c.key} class={`num${c.key === 'games' ? ' muted' : r[c.key] ? '' : ' is-dim'}`}>{r[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
