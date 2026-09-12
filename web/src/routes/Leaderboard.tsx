import { useMemo, useState } from 'preact/hooks';
import { api, type LeaderboardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { deriveLiveStats, labelFor, orderLiveStatKeys } from '../format';
import { Empty, Panel, PlayerLink, Tile, Tiles } from '../components/bits';

/** Columns that are not stats and so are not part of the stat bag. */
const BASE_COLS = [
  { key: 'sr', label: 'SR' },
  { key: 'wins', label: 'W' },
  { key: 'losses', label: 'L' },
  { key: 'games', label: 'Games' },
  { key: 'winrate', label: 'Win %' },
] as const;

type Row = LeaderboardRow & { stats?: Record<string, number> };

/** Everything sortable resolves through here, so a column header and the
 *  comparator can never disagree about what a column means. */
function valueOf(r: Row, key: string): number | null {
  switch (key) {
    case 'sr': return r.sr;
    case 'wins': return r.wins;
    case 'losses': return r.losses;
    case 'games': return r.games;
    case 'winrate': {
      const decided = r.wins + r.losses;
      // No decided games is ABSENT, not 0%: it sorts last either way, but the
      // cell must not claim a 0% win rate for someone who has not lost.
      return decided > 0 ? (r.wins / decided) * 100 : null;
    }
    default: return r.stats?.[key] ?? null;
  }
}

export function Leaderboard({ me }: { me: string | null }) {
  const { data, error } = useFetch((s) => api.leaderboard(s), []);
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'sr', desc: true });

  const rows = (data?.rows ?? []) as Row[];

  // Stat columns come from the data present, so a season with no skill_detect
  // matches shows no permanently empty columns.
  const statCols = useMemo(
    () => orderLiveStatKeys(Array.from(new Set(rows.flatMap((r) => Object.keys(r.stats ?? {}))))),
    [rows],
  );

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((x, y) => {
      const a = valueOf(x, sort.key);
      const b = valueOf(y, sort.key);
      // Absent always sorts last, whichever direction, rather than being
      // treated as zero and beating real low scores.
      if (a === null && b === null) return x.name.localeCompare(y.name);
      if (a === null) return 1;
      if (b === null) return -1;
      if (a === b) return x.name.localeCompare(y.name);
      return sort.desc ? b - a : a - b;
    });
    return out;
  }, [rows, sort]);

  const th = (key: string, label: string) => (
    <th
      class={`num sortable${sort.key === key ? ' is-sorted' : ''}`}
      key={key}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
      title={`Sort by ${label}`}
    >
      {label}
      {sort.key === key && <span class="sortable__arrow">{sort.desc ? '▾' : '▴'}</span>}
    </th>
  );

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.stats ?? {})) t[k] = (t[k] ?? 0) + v;
    return deriveLiveStats(t);
  }, [rows]);

  return (
    <div class="page page--list">
      <div class="page__head">
        <h2>Leaderboard</h2>
        {data && <span class="eyebrow">{data.season.name}</span>}
      </div>

      {rows.length > 0 && (
        <Tiles>
          <Tile label="Players" value={rows.length} />
          <Tile label="Matches rated" value={Math.max(...rows.map((r) => r.games))} />
          {totals.tank_damage ? <Tile label="Tank damage" value={totals.tank_damage} /> : null}
          {totals.skeets ? <Tile label="Skeets" value={totals.skeets} /> : null}
          {totals.boomer_rate !== undefined
            ? <Tile label="Boomer %" value={`${totals.boomer_rate}%`} sub="everyone" />
            : null}
        </Tiles>
      )}

      <Panel class="panel--table">
        {error ? (
          <Empty>Couldn't load the leaderboard.</Empty>
        ) : !data ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>No rated players yet.</Empty>
        ) : (
          <div class={`table-wrap lb${sort.key === 'sr' && sort.desc ? ' lb--ranked' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th class="rank">#</th>
                  <th class="lb__pcol">Player</th>
                  {BASE_COLS.map((c) => th(c.key, c.label))}
                  {statCols.map((k) => th(k, labelFor(k)))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const decided = r.wins + r.losses;
                  return (
                    <tr key={r.steamid} class={r.steamid === me ? 'is-me' : ''}>
                      {/* Rank follows the CURRENT sort, so it stays meaningful
                          when the table is ordered by something other than SR. */}
                      <td class={`rank ${i < 3 ? 'rank--top' : ''}`}>{String(i + 1).padStart(2, '0')}</td>
                      <td class="lb__pcol pname"><PlayerLink steamid={r.steamid} name={r.name} /></td>
                      <td class="num sr">{r.sr}</td>
                      <td class="num">{r.wins}</td>
                      <td class="num">{r.losses}</td>
                      <td class="num muted">{r.games}</td>
                      <td class="num">
                        {decided > 0
                          ? `${Math.round((r.wins / decided) * 100)}%`
                          : <span class="muted">n/a</span>}
                      </td>
                      {statCols.map((k) => {
                        const v = r.stats?.[k];
                        return (
                          <td class={`num${v ? '' : ' is-dim'}`} key={k}>
                            {v === undefined ? <span class="muted">n/a</span> : v}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
