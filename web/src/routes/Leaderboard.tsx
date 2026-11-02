import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { api, type LeaderboardRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { deriveLiveStats, FEATURED_STAT_KEYS, fmtPerGame, labelFor, orderLiveStatKeys, STAT_MIN_GAMES, statFigure, statHelp, statLeaders, type StatMode } from '../format';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
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
 *  comparator can never disagree about what a column means. A stat column
 *  reads per game or as a total by `mode`; per game is absent under the
 *  minimum, so those rows sort after everyone who qualifies. */
function valueOf(r: Row, key: string, mode: StatMode, minGames: number): number | null {
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
    default: return statFigure(r, key, mode, minGames);
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
  // Per game by default (owner, 2026-10-23): a season total mostly ranks who
  // played the most. Totals stay one click away.
  const [mode, setMode] = useState<StatMode>('avg');
  const minGames = data?.statMinGames ?? STAT_MIN_GAMES;
  const statSort = !BASE_COLS.some((c) => c.key === sort.key);

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
      const a = valueOf(x, sort.key, mode, minGames);
      const b = valueOf(y, sort.key, mode, minGames);
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
  }, [rows, sort, mode, minGames]);

  const th = (key: string, label: string, cls = '') => (
    <th
      class={`num sortable${cls ? ` ${cls}` : ''}${sort.key === key ? ' is-sorted' : ''}`}
      key={key}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
      title={statHelp(key) ? `${statHelp(key)} Click to sort.` : `Sort by ${label}`}
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
            <Figure label="Players" value={rows.length.toLocaleString()} />
            {/* The API's distinct-match count. This was the top player's
                game count, which is only right while everyone has played
                every match. */}
            {data && <Figure label="Matches rated" value={data.matchesRated.toLocaleString()} />}
            {totals.tank_damage ? <Figure label="Tank damage" value={totals.tank_damage.toLocaleString()} /> : null}
            {totals.skeets ? <Figure label="Skeets" value={totals.skeets.toLocaleString()} /> : null}
            {totals.boomer_rate !== undefined
              ? <Figure label="Boomer %" value={`${totals.boomer_rate}%`} sub="everyone" />
              : null}
          </Figures>
        )}
      </PageHeader>

      {/* The podium is chosen among RANKED players only, by SR whatever the
          table is sorted by: a provisional SR after one game is not a claim
          on it. It replaces the old Top rated sidebar, which repeated #1 and
          squeezed the table into two thirds of the page. */}
      {board === 'season' && <Podium rows={ranked} />}
      {board === 'season' && (
        <div class="lb-statmode">
          <div class="lb-toggle" role="group" aria-label="Stat columns">
            <button type="button" class={mode === 'avg' ? 'is-on' : ''} aria-pressed={mode === 'avg'} onClick={() => setMode('avg')}>Per game</button>
            <button type="button" class={mode === 'total' ? 'is-on' : ''} aria-pressed={mode === 'total'} onClick={() => setMode('total')}>Totals</button>
          </div>
          <span class="muted">
            {mode === 'avg'
              ? `Stats per game. Ranked from ${minGames} games; leader cards are for ranked players only.`
              : 'Season totals. Leader cards are for ranked players only.'}
          </span>
        </div>
      )}
      {board === 'season' && (
        <StatLeaders
          rows={ranked} mode={mode} minGames={minGames}
          sortKey={sort.key} onPick={(k) => setSort({ key: k, desc: true })}
        />
      )}

      {weekly ? (
        <WeeklyBoard week={week} onWeek={setWeek} me={me} />
      ) : endorse ? (
        <EndorseBoard season={season} me={me} />
      ) : (
        <div class="lb-full">
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
                      // Sorted by a stat, a row with no figure for it (under
                      // the per-game minimum, or never recorded) has no place
                      // either: it is listed, not ranked.
                      const unranked = statSort && valueOf(r, sort.key, mode, minGames) === null;
                      const place = data.season.ended ? r.finalRank ?? null : r.ranked && !unranked ? i + 1 : null;
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
                            <td class="lb__pcol" title={r.name}>
                              <span class="lbname">
                                {r.avatar
                                  ? <img class="lbname__face" src={r.avatar} alt="" width={24} height={24} loading="lazy" />
                                  : <span class="lbname__face lbname__face--none" aria-hidden="true" data-initial={r.name.slice(0, 1).toUpperCase()} />}
                                <PlayerLink steamid={r.steamid} name={r.name} />
                                {r.top10 && <Top10Tag />}
                                <TitleTag kind={r.title} />
                              </span>
                            </td>
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
                              if (v === undefined) return <td class="num is-dim" key={k}><span class="muted">n/a</span></td>;
                              if (mode === 'total') return <td class={`num${v ? '' : ' is-dim'}`} key={k}>{v.toLocaleString()}</td>;
                              // Per game. Under the minimum the average still
                              // shows, greyed and unranked, so the row is not blank.
                              const games = r.statGames ?? r.games;
                              const per = games > 0 ? v / games : 0;
                              const short = games < minGames;
                              return (
                                <td
                                  class={`num${per && !short ? '' : ' is-dim'}`} key={k}
                                  title={short ? `Under ${minGames} games: not ranked per game` : undefined}
                                >
                                  {short ? <span class="muted">{fmtPerGame(per)}</span> : fmtPerGame(per)}
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
        </div>
      )}
    </div>
  );
}

/** The top three by SR, as cards: who is on top is the first thing anyone
 *  opens a leaderboard to see, so it gets faces and room rather than row one
 *  of a wide table. Ordered 1, 2, 3 left to right so it reads the same on a
 *  phone, where the cards stack. */
function Podium({ rows }: { rows: Row[] }) {
  // A placing player has no SR to show yet (Season 1 on), so only rows with
  // one can stand on it.
  const top = useMemo(
    () => rows.filter((r): r is Row & { sr: number } => r.sr !== null)
      .sort((a, b) => b.sr - a.sr || a.name.localeCompare(b.name)).slice(0, 3),
    [rows],
  );
  if (top.length === 0) return null;
  return (
    <ol class="lbpod" aria-label="Top rated">
      {top.map((r, i) => {
        const decided = r.wins + r.losses;
        return (
          <li key={r.steamid} class={`lbpod__card lbpod__card--${i + 1}`}>
            <span class="lbpod__place" aria-label={`Rank ${i + 1}`}>{i + 1}</span>
            {r.avatar
              ? <img class="lbpod__face" src={r.avatar} alt="" width={56} height={56} loading="lazy" />
              : <span class="lbpod__face lbpod__face--none" aria-hidden="true" data-initial={r.name.slice(0, 1).toUpperCase()} />}
            <div class="lbpod__who">
              <a class="lbpod__name" href={`/player/${r.steamid}`}>{r.name}</a>
              <TitleTag kind={r.title} />
              {r.rank && <RankBadge rank={r.rank} />}
            </div>
            <p class="lbpod__sr num">{r.sr.toLocaleString()}<span class="lbpod__unit">SR</span></p>
            <dl class="lbpod__stats">
              <div><dt>Record</dt><dd class="num">{r.wins}W {r.losses}L</dd></div>
              <div><dt>Win %</dt><dd class="num">{decided > 0 ? `${Math.round((r.wins / decided) * 100)}%` : 'n/a'}</dd></div>
              <div><dt>Games</dt><dd class="num">{r.games}</dd></div>
            </dl>
          </li>
        );
      })}
    </ol>
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
 *
 * `rows` is the RANKED players only (owner, 2026-10-23): a placing or
 * provisional player is not on the board yet, so not on a card either. The
 * cards read like the columns, per game (past the minimum) or as totals.
 */
function StatLeaders(
  { rows, mode, minGames, sortKey, onPick }: {
    rows: Row[];
    mode: StatMode;
    minGames: number;
    sortKey: string;
    onPick: (key: string) => void;
  },
) {
  const cards = useMemo(
    () => FEATURED_STAT_KEYS
      .map((key) => ({ key, leaders: statLeaders(rows, key, 3, (r) => statFigure(r, key, mode, minGames)) }))
      // A stat nobody has scored in yet gets no card, rather than a card
      // reading "nobody, 0". Keeps a fresh season honest.
      .filter((c) => c.leaders.length > 0),
    [rows, mode, minGames],
  );
  const fmt = (v: number) => (mode === 'avg' ? fmtPerGame(v) : v.toLocaleString());
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
            <span class="statleader__label eyebrow">{mode === 'avg' ? `${labelFor(key)} / game` : labelFor(key)}</span>
            <span class="statleader__name">{first.name}</span>
            <span class="statleader__value num">{fmt(first.value)}</span>
            {rest.length > 0 && (
              <span class="statleader__rest muted">
                {rest.map((r, i) => (
                  <span class="statleader__runner" key={r.steamid}>
                    <span class="statleader__pos">{i + 2}</span>
                    <span class="statleader__rname">{r.name}</span>
                    <span class="num">{fmt(r.value)}</span>
                  </span>
                ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
