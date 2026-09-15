import { api, type MapLeaderRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { deriveLiveStats, labelFor, orderLiveStatKeys } from '../format';
import { useState } from 'preact/hooks';
import { Bars, BarRow, Empty, Panel, PlayerLink, Tabs } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';

export function MapDetail({ map }: { map: string }) {
  const { data, error } = useFetch((s) => api.map(map, s), [map]);
  const [tab, setTab] = useState('winrate');

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Nobody has played that map yet.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--list" />;

  const players: MapLeaderRow[] = data.players.map((p) => ({
    ...p,
    stats: deriveLiveStats(p.stats ?? {}),
  }));
  const cols = orderLiveStatKeys(
    Array.from(new Set(players.flatMap((p) => Object.keys(p.stats)))),
  );

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Map" title={data.map}>
        <Figures>
          <Figure label="Played" value={data.played} />
          {/* Null when no playing of this map has a real score: say so
              rather than average zeros that were never results. */}
          <Figure
            label="Avg score"
            value={data.avgTeamA === null || data.avgTeamB === null ? 'not recorded' : `${data.avgTeamA} - ${data.avgTeamB}`}
            sub="A vs B"
          />
          <Figure label="Players" value={players.length} />
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
        <div class="table-wrap lb">
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
                    {cols.map((k) => (
                      <td class={`num${p.stats[k] ? '' : ' is-dim'}`} key={k}>
                        {p.stats[k] ?? <span class="muted">n/a</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
