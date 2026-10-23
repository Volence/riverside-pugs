import { api, type MapLeaderRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, campaignTint, chapterName, deriveLiveStats, fmtClock, labelFor, mapName, orderLiveStatKeys, survivalLabel } from '../format';
import { useState } from 'preact/hooks';
import { Bars, BarRow, Empty, PageSkeleton, Panel, PlayerLink, Tabs } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';

/** Games on a map before a win rate is worth drawing as a bar. */
const MIN_GAMES = 5;

export function MapDetail({ map }: { map: string }) {
  const { data, error } = useFetch((s) => api.map(map, s), [map]);
  const [tab, setTab] = useState('winrate');
  // Averages first: a total mostly reports who has played the most, while
  // what someone usually gets on a map is the number that compares.
  const [mode, setMode] = useState<'avg' | 'total'>('avg');
  const [showAll, setShowAll] = useState(false);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Nobody has played that map yet.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const players: MapLeaderRow[] = data.players.map((p) => ({
    ...p,
    stats: deriveLiveStats(p.stats ?? {}),
    avgStats: deriveLiveStats(p.avgStats ?? {}),
  }));
  // The map's own baseline, pooled over everyone, so a player row has
  // something to be read against.
  const baseline = deriveLiveStats(data.avgStats ?? {});
  const cellsOf = (p: MapLeaderRow) => (mode === 'avg' ? p.avgStats : p.stats);
  const cols = orderLiveStatKeys(
    Array.from(new Set(players.flatMap((p) => Object.keys(p.stats)))),
  );

  // Where this chapter sits in its campaign: "Death Toll · Chapter 2 of 5".
  const chapters = data.chapters ?? [];
  const at = chapters.findIndex((c) => c.map.toLowerCase() === data.map.toLowerCase());
  const eyebrow = data.campaign
    ? `${campaignName(data.campaign)}${at >= 0 ? ` · Chapter ${at + 1} of ${chapters.length}` : ''}`
    : 'Map';
  const face = (p: MapLeaderRow, cls: string) => (p.avatar
    ? <img class={cls} src={p.avatar} alt="" width={20} height={20} loading="lazy" />
    : <span class={`${cls} ${cls}--none`} aria-hidden="true" data-initial={p.name.slice(0, 1).toUpperCase()} />);
  // The bars list everyone with enough games to read a rate from, the most
  // played first; the rest fold away, as on the profile's by-map bars.
  const LIST = 15;

  return (
    <div class="page page--list mapdetail" style={data.campaign ? { '--campaign': campaignTint(data.campaign) } as Record<string, string> : undefined}>
      <PageHeader eyebrow={eyebrow} title={chapterName(data.display ?? null, mapName(data.map))}>
        <Figures>
          <Figure label="Played" value={data.played} />
          {/* Null when no playing of this map has a real score: say so
              rather than average zeros that were never results. */}
          <Figure
            label="Avg score"
            value={data.avgScore === null ? 'not recorded' : data.avgScore}
            sub="per team"
          />
          <Figure label="Players" value={players.length} />
          {/* n/a, not 0%, when no round here was measured: survival only
              started being recorded when the plugin began reporting it. The
              sub-label used to read `attempts`, which counts rounds with a
              usable clock and is several times larger than the survival
              sample, so this figure claimed far more measurements than it had. */}
          {(() => {
            const s = survivalLabel(data.rounds.survivalPct, data.rounds.measured);
            return <Figure label="Survived" value={s.value} sub={s.sub} />;
          })()}
          <Figure
            label="Avg round"
            value={data.rounds.avgSec === null ? 'n/a' : fmtClock(data.rounds.avgSec)}
            sub={data.rounds.fastestSec !== null && data.rounds.slowestSec !== null
              ? `${fmtClock(data.rounds.fastestSec)} to ${fmtClock(data.rounds.slowestSec)}`
              : undefined}
          />
        </Figures>
      </PageHeader>

      {chapters.length > 1 && (
        <nav class="mapchips" aria-label="Chapters in this campaign">
          {chapters.map((c, i) => (
            <a
              key={c.map}
              class={`mapchip${i === at ? ' is-current' : ''}`}
              href={`/map/${encodeURIComponent(c.map)}`}
              aria-current={i === at ? 'page' : undefined}
            >
              <span class="mapchip__n">{i + 1}</span>
              {chapterName(c.display, mapName(c.map))}
            </a>
          ))}
        </nav>
      )}

      <Panel>
        <h3>Compare</h3>
        <Tabs
          active={tab}
          onSelect={setTab}
          tabs={[{ key: 'winrate', label: 'Win rate' }, ...cols.slice(0, 8).map((k) => ({ key: k, label: labelFor(k) }))]}
        />
        {(() => {
          if (tab === 'winrate') {
            // Bar length is the win rate with a line at 50%, so length and
            // colour say the same thing. Players with only a few games here
            // would put 0% and 100% rows everywhere, so they fold away.
            const rated = players.filter((p) => p.wins + p.losses >= MIN_GAMES)
              .sort((a, b) => b.games - a.games || b.wins - a.wins);
            const few = players.length - rated.length;
            const list = showAll ? rated : rated.slice(0, LIST);
            return (
              <Bars label={`Win rate here, most played first${few > 0 ? ` (${few} with fewer than ${MIN_GAMES} games not shown)` : ''}`}>
                {list.map((p) => {
                  const wr = Math.round((p.wins / (p.wins + p.losses)) * 100);
                  return (
                    <BarRow
                      key={p.steamid}
                      icon={face(p, 'mapface')}
                      name={p.name}
                      href={`/player/${encodeURIComponent(p.steamid)}`}
                      value={`${wr}%`}
                      detail={`(${p.wins}W ${p.losses}L)`}
                      fraction={wr / 100}
                      mark={0.5}
                      tone={wr >= 50 ? 'good' : 'bad'}
                    />
                  );
                })}
                {rated.length === 0 && <p class="muted">Nobody has {MIN_GAMES} games here yet.</p>}
                {rated.length > LIST && (
                  <button class="chip mapmore" type="button" onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Show fewer' : `Show all ${rated.length}`}
                  </button>
                )}
              </Bars>
            );
          }
          // A stat tab: bar length is the value relative to the best, so the
          // comparison is legible whatever the units happen to be.
          const vals = players.map((p) => p.stats[tab] ?? 0);
          const max = Math.max(...vals, 1);
          const ranked = [...players].sort((a, b) => (b.stats[tab] ?? 0) - (a.stats[tab] ?? 0));
          const shownRanked = showAll ? ranked : ranked.slice(0, LIST);
          return (
            <Bars label={`${labelFor(tab)} here, total`}>
              {shownRanked.map((p) => (
                <BarRow
                  key={p.steamid}
                  icon={face(p, 'mapface')}
                  name={p.name}
                  href={`/player/${encodeURIComponent(p.steamid)}`}
                  value={p.stats[tab] === undefined ? 'n/a' : String(p.stats[tab])}
                  fraction={(p.stats[tab] ?? 0) / max}
                  tone="neutral"
                />
              ))}
              {ranked.length > LIST && (
                <button class="chip mapmore" type="button" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show fewer' : `Show all ${ranked.length}`}
                </button>
              )}
            </Bars>
          );
        })()}
      </Panel>

      <Panel class="panel--table">
        <h3>Records on this map</h3>
        <p class="muted">
          Every completed match, both teams. A map won inside a match lost
          overall still counts here.
        </p>
        <Tabs
          active={mode}
          onSelect={(k) => setMode(k as 'avg' | 'total')}
          tabs={[{ key: 'avg', label: 'Per map' }, { key: 'total', label: 'Totals' }]}
        />
        <div class="table-wrap lb lb--norank">
          <table>
            <thead>
              <tr>
                <th class="lb__pcol">Player</th>
                <th class="num">Played</th>
                <th class="num">W</th>
                <th class="num">L</th>
                <th class="num">Win %</th>
                {cols.map((k) => <th class="num" key={k}>{labelFor(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const decided = p.wins + p.losses;
                return (
                  <tr key={p.steamid}>
                    <td class="lb__pcol">
                      <span class="lbname">{face(p, 'lbname__face')}<PlayerLink steamid={p.steamid} name={p.name} /></span>
                    </td>
                    <td class="num">{p.games}</td>
                    <td class="num">{p.wins}</td>
                    <td class="num">{p.losses}</td>
                    <td class="num">
                      {/* Absent, not 0%, when every map was drawn. */}
                      {decided > 0
                        ? `${Math.round((p.wins / decided) * 100)}%`
                        : <span class="muted">n/a</span>}
                    </td>
                    {cols.map((k) => {
                      const v = cellsOf(p)[k];
                      return (
                        <td class={`num${v ? '' : ' is-dim'}`} key={k}>
                          {v ?? <span class="muted">n/a</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            {/* Only under Per map. A pooled TOTAL would just be the sum of the
                column above it, which says nothing a reader cannot see. */}
            {mode === 'avg' && (
              <tfoot>
                <tr>
                  <td class="lb__pcol">Map average</td>
                  <td class="num">{data.played}</td>
                  <td class="num" colSpan={3} />
                  {cols.map((k) => (
                    <td class={`num${baseline[k] ? '' : ' is-dim'}`} key={k}>
                      {baseline[k] ?? <span class="muted">n/a</span>}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Panel>
    </div>
  );
}
