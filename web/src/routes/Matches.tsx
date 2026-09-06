import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtDate, winnerLabel } from '../format';
import { Empty, Panel } from '../components/bits';

export function Matches() {
  const { data, error } = useFetch((s) => api.matches(s), []);

  return (
    <div class="page page--list">
      <div class="page__head"><h2>Recent matches</h2></div>
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
