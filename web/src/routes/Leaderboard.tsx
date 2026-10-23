import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { api, type LeaderboardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { deriveLiveStats, FEATURED_STAT_KEYS, labelFor, orderLiveStatKeys, statLeaders } from '../format';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { Headliner } from '../components/Headliner';
import { TitleTag } from '../components/TitleTag';
import { PlacingTag, RankBadge, Top10Tag } from '../components/SeasonRank';
import { WeeklyBoard } from './WeeklyBoard';
import { EndorseBoard } from './EndorseBoard';
import { withNetDamageAsSi } from '../../../src/siDamage';

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
  // The Discord post links `/leaderboard?week=YYYY-MM-DD`: that query alone
  // must open the weekly view, so it is read once on mount rather than
  // through the router (this route has no other query params to lose).
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const [board, setBoard] = useState<'season' | 'week' | 'endorse'>(params.has('week') ? 'week' : 'season');
  const weekly = board === 'week';
  const endorse = board === 'endorse';
  const [week, setWeek] = useState<string | undefined>(params.get('week') ?? undefined);
  // A profile's past-season row links `/leaderboard?season=N`.
  const [season, setSeason] = useState<number | undefined>(
    params.has('season') && Number.isInteger(Number(params.get('season'))) ? Number(params.get('season')) : undefined,
  );
  const { data, error } = useFetch((s) => api.leaderboard(s, season), [season]);
  const { data: seasonList } = useFetch((s) => api.seasons(s).catch(() => ({ seasons: [] })), []);
  const seasons = seasonList?.seasons ?? [];
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'sr', desc: true });

  // Damage as SI net of damage to incapped survivors (src/siDamage.ts), once,
  // here, so the column, its sort and the leader card all read one figure.
  const rows = useMemo(
    () => ((data?.rows ?? []) as Row[]).map((r) => ({ ...r, stats: withNetDamageAsSi(r.stats ?? {}) })),
    [data],
  );

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

  // Seasons from Season 1 on carry ranks and placement; Season 0 neither.
  const showRanks = !!data?.season.ranks;
  const placementGames = data?.season.placementGames ?? 0;
  const groupLabel = data?.season.ended
    ? `Under the ${data.season.finalMinGames ?? 20}-game minimum for a final place`
    : placementGames > 0 ? `Placing, under ${placementGames} games` : 'Provisional, under 3 games';
  const cols = 2 + (showRanks ? 1 : 0) + BASE_COLS.length + statCols.length;

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    // From the raw rows: deriveLiveStats does the damage subtraction itself.
    for (const r of data?.rows ?? []) for (const [k, v] of Object.entries(r.stats ?? {})) t[k] = (t[k] ?? 0) + v;
    return deriveLiveStats(t);
  }, [data]);

  return (
    <div class="page page--list">
      <PageHeader
        title="Leaderboard"
        aside={(
          <div class="lb-aside">
            <div class="lb-toggle" role="group" aria-label="Board">
              <button type="button" class={board === 'season' ? 'is-on' : ''} aria-pressed={board === 'season'} onClick={() => setBoard('season')}>Season</button>
              <button type="button" class={weekly ? 'is-on' : ''} aria-pressed={weekly} onClick={() => setBoard('week')}>This week</button>
              <button type="button" class={endorse ? 'is-on' : ''} aria-pressed={endorse} onClick={() => setBoard('endorse')}>Endorsements</button>
            </div>
            {!weekly && (seasons.length > 1 ? (
              <select
                class="season-picker" aria-label="Season"
                value={String(season ?? seasons.find((s) => s.current)?.id ?? '')}
                onChange={(e) => {
                  const id = Number((e.target as HTMLSelectElement).value);
                  setSeason(seasons.find((s) => s.id === id)?.current ? undefined : id);
                }}
              >
                {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}{s.current ? '' : ' (ended)'}</option>)}
              </select>
            ) : data ? data.season.name : undefined)}
          </div>
        )}
      >
        {board === 'season' && rows.length > 0 && (
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

      {board === 'season' && <StatLeaders rows={rows} sortKey={sort.key} onPick={(k) => setSort({ key: k, desc: true })} />}

      {weekly ? (
        <WeeklyBoard week={week} onWeek={setWeek} />
      ) : endorse ? (
        <EndorseBoard season={season} me={me} />
      ) : (
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
                      {th(BASE_COLS[0].key, BASE_COLS[0].label, BASE_COLS[0].cls)}
                      {/* After SR, not before: SR pins beside the name on a
                          phone, and a column between them pushed it off screen. */}
                      {showRanks && <th class="lb__rankcol">Rank</th>}
                      {BASE_COLS.slice(1).map((c) => th(c.key, c.label, c.cls))}
                      {statCols.map((k) => th(k, labelFor(k)))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...ranked, ...provisional].map((r, i) => {
                      const decided = r.wins + r.losses;
                      // Rank follows the CURRENT sort, so it stays meaningful
                      // when the table is ordered by something other than SR.
                      // A provisional row has no rank at all, not a low one.
                      // A finished season shows its frozen final place.
                      const place = data.season.ended ? r.finalRank ?? null : r.ranked ? i + 1 : null;
                      const rank = place !== null ? String(place).padStart(2, '0') : '–';
                      const rowClass = [
                        r.steamid === me ? 'is-me' : '',
                        r.ranked ? '' : 'is-provisional',
                      ].filter(Boolean).join(' ');
                      return (
                        <Fragment key={r.steamid}>
                          {i === ranked.length && (
                            <tr class="lb__group">
                              <td colSpan={cols}>
                                <span class="eyebrow">{groupLabel}</span>
                              </td>
                            </tr>
                          )}
                          <tr class={rowClass}>
                            <td class={`rank lb__rank${place !== null && place <= 3 ? ' rank--top' : ''}`}>{rank}</td>
                            {/* The cell is a fixed width so SR can pin beside it on a
                                phone; a long name is clipped, and the title carries
                                the rest. */}
                            <td class="lb__pcol pname" title={r.name}><PlayerLink steamid={r.steamid} name={r.name} />{r.top10 && <Top10Tag />}<TitleTag kind={r.title} /></td>
                            <td class="num sr lb__sr">{r.placing ? <PlacingTag placing={r.placing} /> : r.sr ?? <span class="muted">n/a</span>}</td>
                            {showRanks && <td class="lb__rankcol">{r.rank ? <RankBadge rank={r.rank} /> : <span class="muted">–</span>}</td>}
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
          {ranked.some((r) => r.sr !== null) && (() => {
            const top = [...ranked].filter((r) => r.sr !== null).sort((a, b) => b.sr! - a.sr!)[0];
            const decided = top.wins + top.losses;
            return (
              <Headliner
                eyebrow="Top rated"
                name={top.name}
                rating={top.sr!}
                stats={[
                  { label: 'Record', value: `${top.wins}W ${top.losses}L` },
                  { label: 'Win %', value: decided > 0 ? `${Math.round((top.wins / decided) * 100)}%` : 'n/a' },
                  { label: 'Games', value: top.games },
                ]}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
}


/**
 * Who leads the season in each of a few stats, as a row of cards.
 *
 * The table below already carries every one of these numbers and sorts by any
 * of them, so this adds no data. What it adds is glanceability: the table is
 * twenty-odd numeric columns wide and answers "who is best at skeets" only if
 * you already know to scroll sideways and click that header. A reader who does
 * not know the table is sortable never finds it at all.
 *
 * So each card is also the control: clicking it sorts the table by that stat,
 * which is the discoverability the column headers were missing.
 */
function StatLeaders(
  { rows, sortKey, onPick }: {
    rows: Row[];
    sortKey: string;
    onPick: (key: string) => void;
  },
) {
  const cards = useMemo(
    () => FEATURED_STAT_KEYS
      .map((key) => ({ key, leaders: statLeaders(rows, key) }))
      // A stat nobody has scored in yet gets no card, rather than a card
      // reading "nobody, 0". Keeps a fresh season honest.
      .filter((c) => c.leaders.length > 0),
    [rows],
  );
  if (cards.length === 0) return null;

  return (
    <div class="statleaders">
      {cards.map(({ key, leaders }) => {
        const [first, ...rest] = leaders;
        return (
          <button
            key={key}
            type="button"
            class={`statleader${sortKey === key ? ' is-active' : ''}`}
            aria-pressed={sortKey === key}
            title={`Sort the table by ${labelFor(key)}`}
            onClick={() => onPick(key)}
          >
            <span class="statleader__label eyebrow">{labelFor(key)}</span>
            <span class="statleader__name">{first.name}</span>
            <span class="statleader__value num">{first.value.toLocaleString()}</span>
            {rest.length > 0 && (
              <span class="statleader__rest muted">
                {rest.map((r, i) => (
                  <span key={r.steamid}>{i > 0 ? ' · ' : ''}{r.name} {r.value.toLocaleString()}</span>
                ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
