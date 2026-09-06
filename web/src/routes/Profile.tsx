import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtDate } from '../format';
import { Empty, Panel, ResultChip, Sparkline, SrDelta } from '../components/bits';

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

  const { player, rating, totals, matches, history } = data;
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
      </div>
    </div>
  );
}
