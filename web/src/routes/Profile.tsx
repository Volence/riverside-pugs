import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import type { Profile as ProfileData, Quantiles, Standing } from '../api';
import { campaignName, campaignTint, DEAD_STAT_KEYS, deriveLiveStats, fmtDate, labelFor, mapName, orderLiveStatKeys, qualifiedMapName, spreadNote, STANDING_TOP, survivalNote, sortMapRows, type MapSort } from '../format';
import { useState } from 'preact/hooks';
import { Bars, BarRow, Empty, PageSkeleton, Panel, ResultChip, Sparkline, SrDelta, Tabs } from '../components/bits';
import { Headliner } from '../components/Headliner';
import { Figures, Figure, RankBadge } from '../components/PageHeader';
import { DiscordLinkCard } from '../components/DiscordLink';
import type { Session } from '../hooks/useLiveState';

export function Profile(
  { steamid, session, refresh }: { steamid: string; session?: Session; refresh?: () => void },
) {
  const { data, error } = useFetch((s) => api.profile(steamid, s), [steamid]);
  // Per map by default: a career total on the per-map table mostly reports
  // which maps come up most in the rotation, not how the player does on them.
  const [mapMode, setMapMode] = useState<'avg' | 'total'>('avg');

  if (error) {
    return (
      <div class="page page--profile">
        <Panel><Empty>Player not found.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="profile" panels={3} />;

  const byMap = data.byMap ?? [];
  // Which measure orders the bars. Both answer "what should I work on", and
  // they genuinely disagree: a map you win while dying constantly looks fine
  // on one and terrible on the other.
  const [mapSort, setMapSort] = useState<MapSort>('winrate');
  const sortedMaps = sortMapRows(byMap, mapSort);
  // Only the stats that actually occur on some map, so a server without
  // skill_detect shows no permanently empty columns.
  const mapCols = orderLiveStatKeys(
    Array.from(new Set(byMap.flatMap((r) => Object.keys(r.stats)))),
  );

  const { player, rating, totals, matches, history, privateStatTotals, statTotals } = data;

  // Filtered here rather than at the render site so the panel itself can be
  // dropped when nothing survives: a heading promising private numbers over an
  // empty table is worse than no panel. times_deadstopped is the whole reason
  // this is not just `privateStatTotals &&` -- it is permanently 0 on L4D1 and
  // was, until now, the only row most players ever saw here.
  const privateRows = Object.entries(privateStatTotals ?? {})
    .filter(([k]) => !DEAD_STAT_KEYS.has(k));

  const peak = history.length ? Math.max(...history.map((h) => h.sr)) : null;
  const lastDelta = matches.length ? matches[0].srDelta : null;

  return (
    <div class="page page--profile">
      <div class="stack">
        <Headliner
          eyebrow={`Joined ${fmtDate(player.createdAt)}`}
          name={player.name}
          avatar={player.avatar}
          rating={rating ? rating.sr : null}
          delta={lastDelta}
          stats={rating ? [
            { label: 'Record', value: `${rating.wins}W ${rating.losses}L` },
            { label: 'Peak', value: peak ?? 'n/a' },
            { label: 'Matches', value: totals.games },
          ] : []}
        />

        {session && (session.kind === 'active' || session.kind === 'pending') && session.me.steamid === steamid && (
          <Panel><DiscordLinkCard me={session.me} onChange={refresh} /></Panel>
        )}

        <Panel>
          <h3>Rating over time</h3>
          <Sparkline values={history.map((h) => h.sr)} />
        </Panel>

        <ProfileFigures
          totals={totals} statTotals={statTotals} rating={rating}
          standings={data.standings ?? {}} statDefs={data.statDefs}
          statQuantiles={data.statQuantiles ?? {}}
        />

        <div class="profile-grid">
          <Panel>
            <h3>Lifetime</h3>
            <dl class="totals">
              <div><dt>Games</dt><dd class="num">{totals.games}</dd></div>
              <div><dt>SI damage</dt><dd class="num">{totals.siDamage}</dd></div>
              <div><dt>SI kills</dt><dd class="num">{totals.siKills}</dd></div>
              <div><dt>Commons</dt><dd class="num">{totals.commonKills}</dd></div>
              <div><dt>Friendly fire</dt><dd class="num">{totals.ffDealt}</dd></div>
              <div><dt>Revives</dt><dd class="num">{totals.revives}</dd></div>
            </dl>
          </Panel>

          <Panel class="panel--table">
            <h3>Recent matches</h3>
            {matches.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>Campaign</th>
                      <th class="num">Score</th>
                      <th class="num">SR</th>
                      <th class="num">Ended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => (
                      <tr key={m.id} style={{ '--campaign': campaignTint(m.campaign) } as Record<string, string>}>
                        <td><ResultChip result={m.result} /></td>
                        <td class="campaign-cell"><a href={`/match/${m.id}`}>{campaignName(m.campaign)}</a></td>
                        <td class="num">{m.teamAScore} - {m.teamBScore}</td>
                        <td class="num"><SrDelta value={m.srDelta} /></td>
                        <td class="num muted">{fmtDate(m.endedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        {byMap.length > 0 && (
          <Panel class="panel--table">
            <h3>By map</h3>
            <p class="muted">
              How you do on each map, across every match. A map you win inside a
              match you lost still counts as a map win.
            </p>

            {/* Ordered weakest first by the server: the reason to read this is
                to find the maps you lose on, so they belong at the top rather
                than buried in a list ordered by how often you drew each map.
                Bar length is still how often you played it, colour whether you
                tend to win it. */}
            <Tabs
              active={mapSort}
              onSelect={(k) => setMapSort(k as MapSort)}
              tabs={[{ key: 'winrate', label: 'Win rate' }, { key: 'survival', label: 'Survival' }]}
            />
            <Bars label={mapSort === 'survival' ? 'Maps you die on most' : 'Maps you lose most'}>
              {sortedMaps.map((r) => {
                const decided = r.wins + r.losses;
                const wr = decided > 0 ? Math.round((r.wins / decided) * 100) : null;
                const maxGames = Math.max(...byMap.map((x) => x.games));
                const sMeasured = r.survivalMeasured ?? 0;
                const sPct = sMeasured > 0 ? Math.round(((r.survived ?? 0) / sMeasured) * 100) : null;
                const lead = mapSort === 'survival' ? sPct : wr;
                return (
                  <BarRow
                    key={r.map}
                    name={qualifiedMapName(r.map, r.campaignName ?? null)}
                    href={`/map/${encodeURIComponent(r.map)}`}
                    value={lead === null ? 'n/a' : `${lead}%`}
                    detail={mapSort === 'survival'
                      ? `(survived ${r.survived ?? 0} of ${sMeasured})  ${wr === null ? 'n/a' : `${wr}%`} win rate`
                      : `(${r.wins}W ${r.losses}L)${survivalNote(r)}`}
                    fraction={r.games / maxGames}
                    tone={lead === null ? 'neutral' : lead >= 50 ? 'good' : 'bad'}
                  />
                );
              })}
            </Bars>

            <Tabs
              active={mapMode}
              onSelect={(k) => setMapMode(k as 'avg' | 'total')}
              tabs={[{ key: 'avg', label: 'Per map' }, { key: 'total', label: 'Totals' }]}
            />
            <div class="table-wrap lb lb--norank">
              <table>
                <thead>
                  <tr>
                    <th class="lb__pcol">Map</th>
                    <th class="num">Played</th>
                    <th class="num">W</th>
                    <th class="num">L</th>
                    {mapCols.map((k) => <th class="num" key={k}>{labelFor(k)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {byMap.map((r) => (
                    <tr key={r.map}>
                      <td class="lb__pcol pname">
                        <a href={`/map/${encodeURIComponent(r.map)}`}>{mapName(r.map)}</a>
                      </td>
                      <td class="num">{r.games}</td>
                      <td class="num">{r.wins}</td>
                      <td class="num">{r.losses}</td>
                      {mapCols.map((k) => {
                        const v = (mapMode === 'avg' ? r.medianStats : r.stats)[k];
                        const q = r.spread?.[k];
                        return (
                          <td
                            class={`num${v ? '' : ' is-dim'}`}
                            key={k}
                            // The spread goes in the title, not the cell. This
                            // table is already twenty-odd numeric columns wide
                            // and a range in every cell would make it
                            // unreadable, which was the original complaint.
                            title={q && mapMode === 'avg' ? spreadNote(q) : undefined}
                          >
                            {v ?? <span class="muted">n/a</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {privateRows.length > 0 && (
          <Panel>
            <h3>Only you can see this</h3>
            <p class="muted">
              Shown to you alone. Nobody else sees these numbers and they never appear on a leaderboard.
            </p>
            <table>
              <tbody>
                {privateRows.map(([k, v]) => (
                  <tr key={k}><td>{labelFor(k)}</td><td class="num">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * Headline numbers as figures.
 *
 * Rates rather than raw totals wherever one exists: a raw count flatters
 * whoever has played the most games, which makes it useless for comparing
 * players. A figure is omitted entirely when its denominator is zero, so
 * "never played boomer" reads as absent rather than as 0%.
 *
 * The rate is a MEDIAN over matches, not a career total divided by games. The
 * mean was moved by exactly the nights it should have been resistant to: a
 * player with one 40-skeet game and eleven quiet ones was shown a per-match
 * figure they had never once scored. Each tile carries its own quartiles and
 * sample size underneath, so a steady player and a streaky one on the same
 * median do not read identically.
 *
 * Win rate and boomer % stay POOLED ratios. A median of per-match rates would
 * weigh a one-boomer night the same as a four-boomer night, which is the same
 * reason StatTable re-derives boomer_rate rather than averaging it.
 */
function ProfileFigures(
  { totals, statTotals, rating, standings, statDefs, statQuantiles }: {
    totals: ProfileData['totals'];
    statTotals: ProfileData['statTotals'];
    rating: ProfileData['rating'];
    standings: Record<string, Standing>;
    statDefs: ProfileData['statDefs'];
    statQuantiles: Record<string, Quantiles>;
  },
) {
  const games = totals.games || 0;
  // Defaulted once, here: a player with no skill stats at all has no
  // statTotals object to read through.
  const st = statTotals ?? {};
  const derived = deriveLiveStats(st);

  /** A per-match tile for one key, or null when nothing was ever measured for
   *  it. Null rather than a zero tile: absent means not measured, and a 0 here
   *  would read as "does none of this". */
  const medianTile = (key: string, label: string) => {
    const q = statQuantiles[key];
    if (!q) return null;
    return { key, label, value: q.p50.toLocaleString(), sub: spreadNote(q) };
  };

  // `key` names the standing the tile shows a badge for, so a tile and its
  // badge always measure the same thing: a per-match tile, a per-match rank.
  const tiles: { key?: string; label: string; value: string | number; sub?: string }[] = [];
  if (rating) {
    const decided = rating.wins + rating.losses;
    tiles.push({
      key: 'winrate',
      label: 'Win rate',
      value: decided > 0 ? `${Math.round((rating.wins / decided) * 100)}%` : 'n/a',
      sub: `${rating.wins}W ${rating.losses}L`,
    });
  }
  tiles.push({ label: 'Matches', value: games });
  for (const t of [
    medianTile('sidmg', 'SI dmg / match'),
    medianTile('ck', 'Commons / match'),
  ]) if (t) tiles.push(t);
  if (derived.boomer_rate !== undefined) {
    tiles.push({
      key: 'boomer_rate',
      label: 'Boomer %',
      value: `${derived.boomer_rate}%`,
      sub: `${st.boom_successes ?? 0}/${st.boomer_spawns ?? 0}`,
    });
  }
  // Per match, like the tiles before them, so the rank badge beside them is
  // for the number actually shown. Gated on the career total as well as on the
  // quantiles, so a player who has genuinely never done either gets no tile
  // rather than a tile reading 0.
  for (const t of [
    st.tank_damage ? medianTile('tank_damage', 'Tank dmg / match') : null,
    st.skeets ? medianTile('skeets', 'Skeets / match') : null,
  ]) if (t) tiles.push(t);

  // Every other top-five place, best first, so a #1 in crowns is not lost
  // just because crowns has no tile.
  //
  // `rank <= STANDING_TOP` is now this side's job. playerStandings used to
  // truncate to the top five and this list took whatever it returned; it now
  // returns every metric the player has scored in, so without the filter this
  // row would list all twenty-odd of them and stop meaning anything. The
  // heading still says "top five places" and this is what keeps it true.
  const onTiles = new Set(tiles.map((t) => t.key));
  const labelOf = (k: string) =>
    STANDING_LABELS[k] ?? statDefs.find((d) => d.key === k)?.label ?? labelFor(k);
  const others = Object.entries(standings)
    .filter(([k, sd]) => sd.rank <= STANDING_TOP && !onTiles.has(k) && !DEAD_STAT_KEYS.has(k))
    .sort(([ka, a], [kb, b]) => a.rank - b.rank || labelOf(ka).localeCompare(labelOf(kb)));

  return (
    <Panel>
      <Figures>
        {tiles.map((t) => (
          <Figure
            key={t.label} label={t.label} value={t.value} sub={t.sub}
            standing={t.key ? standings[t.key] : undefined}
          />
        ))}
      </Figures>
      {others.length > 0 && (
        <div class="standings" aria-label="Other top five places this season">
          {others.map(([k, sd]) => (
            <span class="standings__item" key={k}>
              <RankBadge standing={sd} what={`${labelOf(k).toLowerCase()} per match`} />
              {labelOf(k)} / match
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Labels for the standings that are not registry stats. */
const STANDING_LABELS: Record<string, string> = {
  sidmg: 'SI damage', sikill: 'SI kills', ck: 'Commons', rev: 'Revives',
};
