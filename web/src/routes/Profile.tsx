import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import type { Profile as ProfileData } from '../api';
import { campaignName, deriveLiveStats, fmtDate, labelFor, orderLiveStatKeys } from '../format';
import { useState } from 'preact/hooks';
import { Bars, BarRow, Empty, Panel, ResultChip, Sparkline, SrDelta, Tabs, Tile, Tiles } from '../components/bits';

export function Profile({ steamid }: { steamid: string }) {
  const { data, error } = useFetch((s) => api.profile(steamid, s), [steamid]);

  if (error) {
    return (
      <div class="page page--profile">
        <Panel><Empty>Player not found.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--profile" />;

  const byMap = data.byMap ?? [];
  // Only the stats that actually occur on some map, so a server without
  // skill_detect shows no permanently empty columns.
  const mapCols = orderLiveStatKeys(
    Array.from(new Set(byMap.flatMap((r) => Object.keys(r.stats)))),
  );

  const { player, rating, totals, matches, history, privateStatTotals, statTotals } = data;
  const peak = history.length ? Math.max(...history.map((h) => h.sr)) : null;
  const lastDelta = matches.length ? matches[0].srDelta : null;

  return (
    <div class="page page--profile">
      <div class="stack">
        <Panel class="profile-head">
          {player.avatar
            ? <img class="avatar" src={player.avatar} alt="" />
            : <div class="avatar avatar--blank" aria-hidden="true" />}
          <div class="profile-head__id">
            <h2>{player.name}</h2>
            <p class="muted">Joined {fmtDate(player.createdAt)}</p>
          </div>
          <div class="profile-head__rating">
            <p class="eyebrow">Rating</p>
            {rating ? (
              <>
                <div class="rating-line">
                  <span class="hero hero--rating">{rating.sr}</span>
                  {lastDelta !== null && <SrDelta value={lastDelta} />}
                </div>
                <p class="muted">
                  {rating.wins}W - {rating.losses}L
                  {peak !== null && <> · peak {peak}</>}
                </p>
              </>
            ) : (
              <Empty>Unrated this season.</Empty>
            )}
          </div>
        </Panel>

        <Panel>
          <h3>Rating over time</h3>
          <Sparkline values={history.map((h) => h.sr)} />
        </Panel>

        <ProfileTiles totals={totals} statTotals={statTotals} rating={rating} />

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
                      <tr key={m.id} data-campaign={m.campaign}>
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

            {/* Bar length is how often you have played the map, colour is
                whether you tend to win it. The table below carries the exact
                numbers; this is for seeing the shape at a glance. */}
            <Bars label="Win rate by map">
              {byMap.map((r) => {
                const decided = r.wins + r.losses;
                const wr = decided > 0 ? Math.round((r.wins / decided) * 100) : null;
                const maxGames = Math.max(...byMap.map((x) => x.games));
                return (
                  <BarRow
                    key={r.map}
                    name={r.map}
                    href={`/map/${encodeURIComponent(r.map)}`}
                    value={wr === null ? 'n/a' : `${wr}%`}
                    detail={`(${r.wins}W ${r.losses}L)`}
                    fraction={r.games / maxGames}
                    tone={wr === null ? 'neutral' : wr >= 50 ? 'good' : 'bad'}
                  />
                );
              })}
            </Bars>

            <div class="table-wrap lb">
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
                        <a href={`/map/${encodeURIComponent(r.map)}`}>{r.map}</a>
                      </td>
                      <td class="num">{r.games}</td>
                      <td class="num">{r.wins}</td>
                      <td class="num">{r.losses}</td>
                      {mapCols.map((k) => (
                        <td class={`num${r.stats[k] ? '' : ' is-dim'}`} key={k}>
                          {r.stats[k] ?? <span class="muted">n/a</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {privateStatTotals && (
          <Panel>
            <h3>Only you can see this</h3>
            <p class="muted">
              Shown to you alone. Nobody else sees these numbers and they never appear on a leaderboard.
            </p>
            <table>
              <tbody>
                {Object.entries(privateStatTotals).map(([k, v]) => (
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
 * Headline numbers as tiles.
 *
 * Rates rather than raw totals wherever one exists: a raw count flatters
 * whoever has played the most games, which makes it useless for comparing
 * players. A tile is omitted entirely when its denominator is zero, so
 * "never played boomer" reads as absent rather than as 0%.
 */
function ProfileTiles(
  { totals, statTotals, rating }: {
    totals: ProfileData['totals'];
    statTotals: ProfileData['statTotals'];
    rating: ProfileData['rating'];
  },
) {
  const games = totals.games || 0;
  const per = (n: number) => (games > 0 ? Math.round(n / games) : null);
  // Defaulted once, here: a player with no skill stats at all has no
  // statTotals object to read through.
  const st = statTotals ?? {};
  const derived = deriveLiveStats(st);

  const tiles: { label: string; value: string | number; sub?: string }[] = [];
  if (rating) {
    const decided = rating.wins + rating.losses;
    tiles.push({
      label: 'Win rate',
      value: decided > 0 ? `${Math.round((rating.wins / decided) * 100)}%` : 'n/a',
      sub: `${rating.wins}W ${rating.losses}L`,
    });
  }
  tiles.push({ label: 'Matches', value: games });
  const sid = per(totals.siDamage);
  if (sid !== null) tiles.push({ label: 'SI dmg / match', value: sid });
  const ck = per(totals.commonKills);
  if (ck !== null) tiles.push({ label: 'Commons / match', value: ck });
  if (derived.boomer_rate !== undefined) {
    tiles.push({
      label: 'Boomer %',
      value: `${derived.boomer_rate}%`,
      sub: `${st.boom_successes ?? 0}/${st.boomer_spawns ?? 0}`,
    });
  }
  if (st.tank_damage) tiles.push({ label: 'Tank damage', value: st.tank_damage });
  if (st.skeets) tiles.push({ label: 'Skeets', value: st.skeets });

  return (
    <Tiles>
      {tiles.map((t) => <Tile key={t.label} label={t.label} value={t.value} sub={t.sub} />)}
    </Tiles>
  );
}
