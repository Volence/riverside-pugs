import { api, type MapIndexRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtClock, mapName, survivalLabel } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
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
  if (!data) return <PageSkeleton variant="list" panels={2} />;

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

  // In the current vote rotation first, then everything else by how much it has
  // been played, then the never-played. Sorted rather than split under a "not
  // in rotation" heading: pool four campaigns out of twenty and such a heading
  // turns sixteen of them into a reject pile, when the honest reading is only
  // that they are not up tonight. Out of rotation keeps every stat and stays
  // one click from its map pages, because losing a favourite map's history to
  // a rotation change is a worse outcome than a longer page.
  // Defaulted, not assumed: a page that throws because one field is absent
  // is a worse failure than one that shows nothing in rotation.
  const pool = new Set(data.pool ?? []);
  const playedIn = (rows: MapIndexRow[]) => rows.reduce((n, m) => n + m.played, 0);
  const ordered = [...groups.entries()].sort(([aSlug, aRows], [bSlug, bRows]) => {
    const aPool = pool.has(aSlug) ? 1 : 0;
    const bPool = pool.has(bSlug) ? 1 : 0;
    if (aPool !== bPool) return bPool - aPool;
    // 'other' is the catch-all for maps no campaign claims, so it sinks.
    if ((aSlug === 'other') !== (bSlug === 'other')) return aSlug === 'other' ? 1 : -1;
    return playedIn(bRows) - playedIn(aRows);
  });

  return (
    <div class="page page--list">
      <PageHeader title="Campaigns">
        {maps.length > 0 && (
          <Figures>
            <Figure label="Maps played" value={maps.filter((m) => m.played > 0).length} />
            <Figure label="Campaigns" value={[...groups.keys()].filter((k) => k !== 'other').length} />
            <Figure
              label="Most played"
              value={maps.reduce((a, b) => (b.played > a.played ? b : a)).played}
              sub={mapName(maps.reduce((a, b) => (b.played > a.played ? b : a)).map)}
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
              items={ordered
                .filter(([slug]) => slug !== 'other')
                .map(([slug, rows]) => {
                  const played = playedIn(rows);
                  return {
                    slug,
                    sub: played === 0 ? 'Unplayed' : `${rows.length} map${rows.length === 1 ? '' : 's'} · ${played} played`,
                    muted: played === 0,
                    badge: pool.has(slug) ? 'In the vote' : undefined,
                  };
                })}
            />
          )}

          <div class="stack">
            {ordered.map(([campaign, rows]) => (
              <Panel class="panel--table" key={campaign}>
                <h3>
                  {campaign === 'other' ? 'Other' : campaignName(campaign)}
                  {pool.has(campaign) && <span class="ccamp__pool">In the vote</span>}
                </h3>
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
                          <td><a href={`/map/${encodeURIComponent(m.map)}`}>{mapName(m.map)}</a></td>
                          <td class="num">{m.played}</td>
                          {m.avgScore === null
                            ? <td class="num muted">not recorded</td>
                            : <td class="num">{m.avgScore}</td>}
                          {/* Survival is null for every round played before
                              the plugin reported it, which is not the same as
                              nobody surviving. Say so rather than print 0%,
                              and dim a sample too thin to state as a rate. */}
                          {/* The sample size is PRINTED, not just a hover
                              title. This column and "Played" have different
                              denominators (played counts rounds with a usable
                              clock, this counts rounds with a survival
                              reading, and the second is much the smaller), so
                              a bare percentage next to a bare count reads as
                              a fraction of that count. It is not. */}
                          {(() => {
                            const s = survivalLabel(m.rounds.survivalPct, m.rounds.measured);
                            return (
                              <td class={`num${s.thin ? ' muted' : ''}`}>
                                {s.value}
                                {s.sub && <span class="map-survived__sub">{s.sub}</span>}
                              </td>
                            );
                          })()}
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
