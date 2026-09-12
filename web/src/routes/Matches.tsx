import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, campaignTint, fmtDate, winnerLabel } from '../format';
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
        const campaigns = new Set(data.matches.map((m) => m.campaign));
        // Deliberately not "Team A wins". a and b are labels reassigned every
        // match, so a win rate under them aggregates different people each time
        // and describes nobody. Margin is a property of the match itself, so it
        // stays true however the sides were labelled.
        const margin = (m: typeof data.matches[number]) => Math.abs(m.teamAScore - m.teamBScore);
        const avgMargin = Math.round(data.matches.reduce((sum, m) => sum + margin(m), 0) / n);
        const closest = data.matches.reduce((best, m) => (margin(m) < margin(best) ? m : best));
        const widest = data.matches.reduce((best, m) => (margin(m) > margin(best) ? m : best));
        return (
          <Tiles>
            <Tile label="Matches" value={n} />
            <Tile label="Campaigns" value={campaigns.size} />
            <Tile label="Avg margin" value={avgMargin} />
            <Tile
              label="Closest"
              value={`${closest.teamAScore} - ${closest.teamBScore}`}
              sub={campaignName(closest.campaign)}
            />
            <Tile
              label="Widest"
              value={`${widest.teamAScore} - ${widest.teamBScore}`}
              sub={campaignName(widest.campaign)}
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
                  <tr key={m.id} style={{ '--campaign': campaignTint(m.campaign) } as Record<string, string>}>
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
