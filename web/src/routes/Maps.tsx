import { api, type MapIndexRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName } from '../format';
import { Empty, Panel, Tile, Tiles } from '../components/bits';

export function Maps() {
  const { data, error } = useFetch((s) => api.maps(s), []);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load maps.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--list" />;

  const maps = data.maps;

  // Grouped by campaign because that is how people actually refer to them
  // ("Dead Air"), while the pages themselves are keyed by the engine map name.
  // Unknown campaigns collect under a single heading rather than vanishing.
  const groups = new Map<string, MapIndexRow[]>();
  for (const m of maps) {
    const key = m.campaign ?? 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return (
    <div class="page page--list">
      <div class="page__head"><h2>Maps</h2></div>

      {maps.length === 0 ? (
        <Panel><Empty>No maps played yet.</Empty></Panel>
      ) : (
        <>
          <Tiles>
            <Tile label="Maps played" value={maps.length} />
            <Tile label="Campaigns" value={groups.size} />
            <Tile
              label="Most played"
              value={maps.reduce((a, b) => (b.played > a.played ? b : a)).played}
              sub={maps.reduce((a, b) => (b.played > a.played ? b : a)).map}
            />
          </Tiles>

          <div class="stack">
            {[...groups.entries()].map(([campaign, rows]) => (
              <Panel class="panel--table" key={campaign}>
                <h3>{campaign === 'other' ? 'Other' : campaignName(campaign)}</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Map</th>
                        <th class="num">Played</th>
                        <th class="num">Avg A</th>
                        <th class="num">Avg B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.map}>
                          <td><a href={`/map/${encodeURIComponent(m.map)}`}>{m.map}</a></td>
                          <td class="num">{m.played}</td>
                          <td class="num">{m.avgTeamA}</td>
                          <td class="num">{m.avgTeamB}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
