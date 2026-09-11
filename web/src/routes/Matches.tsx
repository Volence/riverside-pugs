import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtDate, winnerLabel } from '../format';
import { Empty, Panel, Tile, Tiles } from '../components/bits';

export function Matches() {
  const { data, error } = useFetch((s) => api.matches(s), []);

  return (
    <div class="page page--list">
      <div class="page__head"><h2>Recent matches</h2></div>

      {/* Same tile language as the profile and live pages. Derived from the
          list already fetched, so it costs no extra request. */}
      {data && data.matches.length > 0 && (() => {
        const n = data.matches.length;
        const aWins = data.matches.filter((m) => m.winner === 'a').length;
        const bWins = data.matches.filter((m) => m.winner === 'b').length;
        const campaigns = new Set(data.matches.map((m) => m.campaign));
        const closest = data.matches.reduce((best, m) =>
          Math.abs(m.teamAScore - m.teamBScore) < Math.abs(best.teamAScore - best.teamBScore) ? m : best);
        return (
          <Tiles>
            <Tile label="Matches" value={n} />
            <Tile label="Team A wins" value={aWins} sub={`${Math.round((aWins / n) * 100)}%`} />
            <Tile label="Team B wins" value={bWins} sub={`${Math.round((bWins / n) * 100)}%`} />
            <Tile label="Campaigns" value={campaigns.size} />
            <Tile
              label="Closest"
              value={`${closest.teamAScore} - ${closest.teamBScore}`}
              sub={campaignName(closest.campaign)}
            />
          </Tiles>
        );
      })()}

      <Panel class="panel--table">
        {error ? (
          <Empty>Couldn't load matches.</Empty>
        ) : !data ? (
          <Empty>Loading…</Empty>
        ) : data.matches.length === 0 ? (
          <Empty>No completed matches yet.</Empty>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th class="num">Score</th>
                  <th>Winner</th>
                  <th class="num">Ended</th>
                </tr>
              </thead>
              <tbody>
                {data.matches.map((m) => (
                  <tr key={m.id} data-campaign={m.campaign}>
                    <td class="campaign-cell">
                      <a href={`/match/${m.id}`}>{campaignName(m.campaign)}</a>
                      <span class="muted match-id"> #{m.id}</span>
                    </td>
                    <td class="num">{m.teamAScore} - {m.teamBScore}</td>
                    <td>{winnerLabel(m.winner)}</td>
                    <td class="num muted">{fmtDate(m.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
