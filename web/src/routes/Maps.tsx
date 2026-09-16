import { api, type MapIndexRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtClock } from '../format';
import { Empty, Panel } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { CampaignTiles } from '../components/CampaignTiles';

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
      <PageHeader title="Campaigns">
        {maps.length > 0 && (
          <Figures>
            <Figure label="Maps played" value={maps.length} />
            <Figure label="Campaigns" value={[...groups.keys()].filter((k) => k !== 'other').length} />
            <Figure
              label="Most played"
              value={maps.reduce((a, b) => (b.played > a.played ? b : a)).played}
              sub={maps.reduce((a, b) => (b.played > a.played ? b : a)).map}
            />
          </Figures>
        )}
      </PageHeader>

      {maps.length === 0 ? (
        <Panel><Empty>No maps played yet.</Empty></Panel>
      ) : (
        <>
          {maps.length > 0 && (
            <CampaignTiles
              items={[...groups.entries()]
                .filter(([slug]) => slug !== 'other')
                .map(([slug, rows]) => {
                  const played = rows.reduce((n, m) => n + m.played, 0);
                  return {
                    slug,
                    sub: played === 0 ? 'Unplayed' : `${rows.length} map${rows.length === 1 ? '' : 's'} · ${played} played`,
                    muted: played === 0,
                  };
                })}
            />
          )}

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
                        <th class="num">Avg score</th>
                        <th class="num">Survived</th>
                        <th class="num">Fastest</th>
                        <th class="num">Average</th>
                        <th class="num">Slowest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.map}>
                          <td><a href={`/map/${encodeURIComponent(m.map)}`}>{m.map}</a></td>
                          <td class="num">{m.played}</td>
                          {m.avgScore === null
                            ? <td class="num muted">not recorded</td>
                            : <td class="num">{m.avgScore}</td>}
                          {/* Survival is null for every round played before
                              the plugin reported it, which is not the same as
                              nobody surviving. Say so rather than print 0%. */}
                          <td class={`num${m.rounds.survivalPct === null ? ' muted' : ''}`}>
                            {m.rounds.survivalPct === null ? 'n/a' : `${m.rounds.survivalPct}%`}
                          </td>
                          <RoundTime sec={m.rounds.fastestSec} />
                          <RoundTime sec={m.rounds.avgSec} />
                          <RoundTime sec={m.rounds.slowestSec} />
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

/** A round duration as mm:ss, or a muted dash when no round was timed. */
function RoundTime({ sec }: { sec: number | null }) {
  if (sec === null) return <td class="num muted">n/a</td>;
  return <td class="num">{fmtClock(sec)}</td>;
}
