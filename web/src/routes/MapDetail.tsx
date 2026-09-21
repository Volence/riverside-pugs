import { api, type MapLeaderRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, deriveLiveStats, fmtClock, labelFor, mapName, orderLiveStatKeys, spreadNote, survivalLabel } from '../format';
import { useState } from 'preact/hooks';
import { Bars, BarRow, Empty, PageSkeleton, Panel, PlayerLink, Tabs } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';

export function MapDetail({ map }: { map: string }) {
  const { data, error } = useFetch((s) => api.map(map, s), [map]);
  const [tab, setTab] = useState('winrate');
  // Per map first: a total mostly reports who has played the most, while
  // what someone usually gets on a map is the number that compares. That
  // figure is a median over their playings, not a mean, so one exceptional
  // night does not become the number they are shown for the map.
  const [mode, setMode] = useState<'avg' | 'total'>('avg');

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Nobody has played that map yet.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const players: MapLeaderRow[] = data.players.map((p) => {
    const stats = deriveLiveStats(p.stats ?? {});
    // boomer_rate is a pooled ratio under both tabs. Deriving it from the
    // medians instead divides one median by another, which is not a rate the
    // player ever landed and can read above 100%: a median of 2 successes
    // over a median of 1 spawn is 200%. The pooled figure is the same rule
    // StatTable applies, and the same one the profile tile follows.
    const medianStats = { ...(p.medianStats ?? {}) };
    delete medianStats.boomer_rate;
    if (stats.boomer_rate !== undefined) medianStats.boomer_rate = stats.boomer_rate;
    return { ...p, stats, medianStats };
  });
  // The map's own baseline, pooled over EVERY player-map at once, so a player
  // row has something to be read against. Still a mean, deliberately: pooling
  // is what makes it the map's figure rather than an average of per-player
  // averages weighted by who turned up most.
  const baseline = deriveLiveStats(data.avgStats ?? {});
  const cellsOf = (p: MapLeaderRow) => (mode === 'avg' ? p.medianStats : p.stats);
  const spreadOf = (p: MapLeaderRow, k: string) =>
    (mode === 'avg' ? p.spread?.[k] : undefined);
  const cols = orderLiveStatKeys(
    Array.from(new Set(players.flatMap((p) => Object.keys(p.stats)))),
  );

  return (
    <div class="page page--list">
      <PageHeader eyebrow={data.campaign ? campaignName(data.campaign) : 'Map'} title={mapName(data.map)}>
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

      <Panel>
        <h3>Compare</h3>
        <Tabs
          active={tab}
          onSelect={setTab}
          tabs={[{ key: 'winrate', label: 'Win rate' }, ...cols.slice(0, 8).map((k) => ({ key: k, label: labelFor(k) }))]}
        />
        {(() => {
          if (tab === 'winrate') {
            const maxGames = Math.max(...players.map((p) => p.games));
            return (
              <Bars>
                {players.map((p) => {
                  const decided = p.wins + p.losses;
                  const wr = decided > 0 ? Math.round((p.wins / decided) * 100) : null;
                  return (
                    <BarRow
                      key={p.steamid}
                      name={p.name}
                      href={`/player/${encodeURIComponent(p.steamid)}`}
                      value={wr === null ? 'n/a' : `${wr}%`}
                      detail={`(${p.wins}W ${p.losses}L)`}
                      fraction={p.games / maxGames}
                      tone={wr === null ? 'neutral' : wr >= 50 ? 'good' : 'bad'}
                    />
                  );
                })}
              </Bars>
            );
          }
          // A stat tab: bar length is the value relative to the best, so the
          // comparison is legible whatever the units happen to be.
          const vals = players.map((p) => p.stats[tab] ?? 0);
          const max = Math.max(...vals, 1);
          const ranked = [...players].sort((a, b) => (b.stats[tab] ?? 0) - (a.stats[tab] ?? 0));
          return (
            <Bars>
              {ranked.map((p) => (
                <BarRow
                  key={p.steamid}
                  name={p.name}
                  href={`/player/${encodeURIComponent(p.steamid)}`}
                  value={p.stats[tab] === undefined ? 'n/a' : String(p.stats[tab])}
                  fraction={(p.stats[tab] ?? 0) / max}
                  tone="neutral"
                />
              ))}
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
                    <td class="lb__pcol pname"><PlayerLink steamid={p.steamid} name={p.name} /></td>
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
                      const q = spreadOf(p, k);
                      return (
                        <td
                          class={`num${v ? '' : ' is-dim'}`}
                          key={k}
                          // Spread on hover rather than in the cell: this table
                          // is already twenty-odd numeric columns wide.
                          title={q ? spreadNote(q, 'playing') : undefined}
                        >
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
