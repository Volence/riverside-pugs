import { useMemo, useState } from 'preact/hooks';
import { api, type EndorseBoardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

type Key = 'total' | 'caller' | 'clutch' | 'vibes' | 'givers' | 'games';

/** Total first, the three kinds, then who gave them and how much they played.
 *  The labels match ENDORSE_LABEL in src/endorsements.ts. */
/** The three kinds, drawn as small bars so a row reads at a glance. */
const KINDS = new Set<Key>(['caller', 'clutch', 'vibes']);

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

  const max = (k: Key) => Math.max(1, ...rows.map((r) => r[k]));
  const top = [...rows].sort((x, y) => y.total - x.total || y.givers - x.givers || x.name.localeCompare(y.name)).slice(0, 3);

  return (
    <>
      <ol class="lbpod endpod" aria-label="Most endorsed">
        {top.map((r, i) => (
          <li key={r.steamid} class={`lbpod__card lbpod__card--${i + 1}`}>
            <span class="lbpod__place" aria-label={`Rank ${i + 1}`}>{i + 1}</span>
            <Face r={r} size={56} cls="lbpod__face" />
            <div class="lbpod__who">
              <a class="lbpod__name" href={`/player/${r.steamid}`}>{r.name}</a>
            </div>
            <p class="lbpod__sr num">{r.total.toLocaleString()}<span class="lbpod__unit">endorsements</span></p>
            <dl class="lbpod__stats">
              <div><dt>Caller</dt><dd class="num">{r.caller}</dd></div>
              <div><dt>Clutch</dt><dd class="num">{r.clutch}</dd></div>
              <div><dt>Good vibes</dt><dd class="num">{r.vibes}</dd></div>
            </dl>
            <p class="endpod__from muted">from {r.givers} {r.givers === 1 ? 'person' : 'people'}</p>
          </li>
        ))}
      </ol>
      <Panel class="panel--table">
        <div class="table-wrap lb endlb">
          <table>
            <thead>
              <tr>
                <th class="rank lb__rank">#</th>
                <th class="lb__pcol">Player</th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    class={`num sortable${sort.key === c.key ? ' is-sorted' : ''}${KINDS.has(c.key) ? ' endlb__kind' : ''}`}
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
                  <td class="lb__pcol pname" title={r.name}>
                    <span class="lbname">
                      <Face r={r} size={24} cls="lbname__face" />
                      <PlayerLink steamid={r.steamid} name={r.name} />
                    </span>
                  </td>
                  {COLS.map((c) => {
                    const v = r[c.key];
                    if (KINDS.has(c.key)) {
                      return (
                        <td key={c.key} class={`num endlb__kind endlb__kind--${c.key}${v ? '' : ' endlb__zero'}`}>
                          <span class="endlb__cell">
                            <span class="endlb__bar" aria-hidden="true"><span style={{ width: `${Math.round((v / max(c.key)) * 100)}%` }} /></span>
                            <span class="endlb__n">{v}</span>
                          </span>
                        </td>
                      );
                    }
                    return <td key={c.key} class={`num${c.key === 'games' || c.key === 'givers' ? ' muted' : ' endlb__total'}`}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

/** A face, or the player's initial when there is no avatar. */
function Face({ r, size, cls }: { r: EndorseBoardRow; size: number; cls: string }) {
  return r.avatar
    ? <img class={cls} src={r.avatar} alt="" width={size} height={size} loading="lazy" />
    : <span class={`${cls} ${cls}--none`} aria-hidden="true" data-initial={r.name.slice(0, 1).toUpperCase()} />;
}
