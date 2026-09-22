import { useEffect, useState } from 'preact/hooks';
import { api, type MapIndexRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, chapterName, fmtClock, mapName, survivalLabel } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { CampaignTiles } from '../components/CampaignTiles';

/** The id of a campaign's table, which its tile links to. */
export const campaignAnchor = (slug: string): string => `campaign-${slug}`;

export function Maps() {
  const { data, error } = useFetch((s) => api.maps(s), []);
  const [showRest, setShowRest] = useState(false);
  // Scroll only once the table is on the page: a tile for a hidden campaign
  // opens the rest first, and the table appears on the next render.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(campaignAnchor(scrollTo))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    setScrollTo(null);
  }, [scrollTo, showRest]);

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
  // been played, then the never-played. With 27 campaigns the page became a
  // wall, so (owner, 2026-09-22) the ones not in the vote fold away behind one
  // button, tiles and tables alike, and open exactly as before. Folded, not
  // dropped: a favourite campaign's history is one click away, never gone.
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

  // With nothing in the vote there is nothing to fold behind.
  const inVote = ordered.filter(([slug]) => pool.has(slug));
  const rest = ordered.filter(([slug]) => !pool.has(slug));
  const folding = inVote.length > 0 && rest.length > 0;
  const shown = folding && !showRest ? inVote : ordered;
  const restCampaigns = rest.filter(([slug]) => slug !== 'other').length;

  const tile = ([slug, rows]: [string, MapIndexRow[]]) => {
    const played = playedIn(rows);
    return {
      slug,
      sub: played === 0 ? 'Unplayed' : `${rows.length} map${rows.length === 1 ? '' : 's'} · ${played} played`,
      muted: played === 0,
      badge: pool.has(slug) ? 'In the vote' : undefined,
      href: `#${campaignAnchor(slug)}`,
    };
  };
  const follow = (slug: string, e: MouseEvent) => {
    // Handled here rather than left to the browser: the router treats a link
    // click as navigation, and a smooth scroll reads better than a jump.
    e.preventDefault();
    if (!pool.has(slug)) setShowRest(true);
    setScrollTo(slug);
    try { history.replaceState(null, '', `#${campaignAnchor(slug)}`); } catch { /* cosmetic */ }
  };

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
              sub={(() => {
                const top = maps.reduce((a, b) => (b.played > a.played ? b : a));
                return chapterName(top.display ?? null, mapName(top.map));
              })()}
            />
          </Figures>
        )}
      </PageHeader>

      {maps.length === 0 ? (
        <Panel><Empty>No maps played yet.</Empty></Panel>
      ) : (
        <>
          <CampaignTiles items={shown.filter(([slug]) => slug !== 'other').map(tile)} onFollow={follow} />
          {folding && (
            <p class="campaigns-more">
              <button class="chip" type="button" aria-expanded={showRest} onClick={() => setShowRest(!showRest)}>
                {showRest
                  ? 'Hide the campaigns not in the vote'
                  : restCampaigns === 0
                    ? 'Show the other maps'
                    : `Show ${restCampaigns} more campaign${restCampaigns === 1 ? '' : 's'} not in the vote`}
              </button>
            </p>
          )}

          <div class="stack">
            {shown.map(([campaign, rows]) => (
              <Panel class="panel--table campaign-table" key={campaign} id={campaignAnchor(campaign)}>
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
                          <td><a href={`/map/${encodeURIComponent(m.map)}`}>{chapterName(m.display ?? null, mapName(m.map))}</a></td>
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
