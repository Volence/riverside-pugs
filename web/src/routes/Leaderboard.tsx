import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { api, type LeaderboardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { deriveLiveStats, labelFor, orderLiveStatKeys } from '../format';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { Headliner } from '../components/Headliner';

/** Columns that are not stats and so are not part of the stat bag.
 *
 *  `cls` is the layout hook the stylesheet pins or hides by: SR stays on
 *  screen with the rank and the name while the rest scrolls, and W, L and
 *  Win % go under 480px where there is no room for them (Games stays, as
 *  the one figure that says how much a rating is worth). */
const BASE_COLS = [
  { key: 'sr', label: 'SR', cls: 'lb__sr' },
  { key: 'wins', label: 'W', cls: 'lb__wl' },
  { key: 'losses', label: 'L', cls: 'lb__wl' },
  { key: 'games', label: 'Games', cls: '' },
  { key: 'winrate', label: 'Win %', cls: 'lb__wl' },
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

  // Ranked players first, provisional ones (under three games) after, each
  // group in the chosen order. The split survives every sort: a one-game
  // player is not on the board yet, whichever column is being compared.
  const { ranked, provisional } = useMemo(() => {
    const cmp = (x: Row, y: Row) => {
      const a = valueOf(x, sort.key);
      const b = valueOf(y, sort.key);
      // Absent always sorts last, whichever direction, rather than being
      // treated as zero and beating real low scores.
      if (a === null && b === null) return x.name.localeCompare(y.name);
      if (a === null) return 1;
      if (b === null) return -1;
      if (a === b) return x.name.localeCompare(y.name);
      return sort.desc ? b - a : a - b;
    };
    return {
      ranked: rows.filter((r) => r.ranked).sort(cmp),
      provisional: rows.filter((r) => !r.ranked).sort(cmp),
    };
  }, [rows, sort]);

  const th = (key: string, label: string, cls = '') => (
    <th
      class={`num sortable${cls ? ` ${cls}` : ''}${sort.key === key ? ' is-sorted' : ''}`}
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
      <PageHeader title="Leaderboard" aside={data ? data.season.name : undefined}>
        {rows.length > 0 && (
          <Figures>
            <Figure label="Players" value={rows.length} />
            {/* The API's distinct-match count. This was the top player's
                game count, which is only right while everyone has played
                every match. */}
            {data && <Figure label="Matches rated" value={data.matchesRated} />}
            {totals.tank_damage ? <Figure label="Tank damage" value={totals.tank_damage} /> : null}
            {totals.skeets ? <Figure label="Skeets" value={totals.skeets} /> : null}
            {totals.boomer_rate !== undefined
              ? <Figure label="Boomer %" value={`${totals.boomer_rate}%`} sub="everyone" />
              : null}
          </Figures>
        )}
      </PageHeader>

      <div class="lb-layout">
        <Panel class="panel--table">
          {error ? (
            <Empty>Couldn't load the leaderboard.</Empty>
          ) : !data ? (
            <Empty>Loading…</Empty>
          ) : rows.length === 0 ? (
            <Empty>No rated players yet.</Empty>
          ) : (
            <div class={`table-wrap lb${sort.key === 'sr' && sort.desc && ranked.length > 0 ? ' lb--ranked' : ''}`}>
              <table>
                <thead>
                  <tr>
                    <th class="rank lb__rank">#</th>
                    <th class="lb__pcol">Player</th>
                    {BASE_COLS.map((c) => th(c.key, c.label, c.cls))}
                    {statCols.map((k) => th(k, labelFor(k)))}
                  </tr>
                </thead>
                <tbody>
                  {[...ranked, ...provisional].map((r, i) => {
                    const decided = r.wins + r.losses;
                    // Rank follows the CURRENT sort, so it stays meaningful
                    // when the table is ordered by something other than SR.
                    // A provisional row has no rank at all, not a low one.
                    const rank = r.ranked ? String(i + 1).padStart(2, '0') : '–';
                    const rowClass = [
                      r.steamid === me ? 'is-me' : '',
                      r.ranked ? '' : 'is-provisional',
                    ].filter(Boolean).join(' ');
                    return (
                      <Fragment key={r.steamid}>
                        {i === ranked.length && (
                          <tr class="lb__group">
                            <td colSpan={2 + BASE_COLS.length + statCols.length}>
                              <span class="eyebrow">Provisional, under 3 games</span>
                            </td>
                          </tr>
                        )}
                        <tr class={rowClass}>
                          <td class={`rank lb__rank${r.ranked && i < 3 ? ' rank--top' : ''}`}>{rank}</td>
                          {/* The cell is a fixed width so SR can pin beside it on a
                              phone; a long name is clipped, and the title carries
                              the rest. */}
                          <td class="lb__pcol pname" title={r.name}><PlayerLink steamid={r.steamid} name={r.name} /></td>
                          <td class="num sr lb__sr">{r.sr}</td>
                          <td class="num lb__wl">{r.wins}</td>
                          <td class="num lb__wl">{r.losses}</td>
                          <td class="num muted">{r.games}</td>
                          <td class="num lb__wl">
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
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        {/* Top rated is chosen among RANKED players only: a provisional SR
            after one game is not a claim on the card. */}
        {ranked.length > 0 && (() => {
          const top = [...ranked].sort((a, b) => b.sr - a.sr)[0];
          const decided = top.wins + top.losses;
          return (
            <Headliner
              eyebrow="Top rated"
              name={top.name}
              rating={top.sr}
              stats={[
                { label: 'Record', value: `${top.wins}W ${top.losses}L` },
                { label: 'Win %', value: decided > 0 ? `${Math.round((top.wins / decided) * 100)}%` : 'n/a' },
                { label: 'Games', value: top.games },
              ]}
            />
          );
        })()}
      </div>
    </div>
  );
}
