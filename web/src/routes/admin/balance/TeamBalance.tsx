import { adminApi, type TeamBalanceBucket, type TeamBalanceRow } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';

/** A share as a whole percentage, or a dash with nothing to show. */
export const pct = (x: number | null): string => (x === null ? '-' : `${Math.round(x * 100)}%`);

/** Team A odds as "favourite side and its odds", e.g. "B 63%". */
export function favLabel(pA: number): string {
  return pA >= 0.5 ? `A ${pct(pA)}` : `B ${pct(1 - pA)}`;
}

/** Whether the stat favourite of the teams that played won: null until decided. */
export function statFavWon(r: TeamBalanceRow): boolean | null {
  if (r.winner !== 'a' && r.winner !== 'b') return null;
  return r.winner === (r.chosenStatA >= 0.5 ? 'a' : 'b');
}

/** The Gate column: holdout, fired, over the gate with the switch off, or nothing. */
export function gateLabel(r: TeamBalanceRow): string {
  if (r.holdout) return 'holdout';
  if (r.gateFired) return 'fired';
  return r.overGate ? 'over' : '-';
}

function bucketLine(b: TeamBalanceBucket): string {
  if (b.matches === 0) return 'none yet';
  return `${b.matches} matches, predicted ${pct(b.predicted)}, won ${pct(b.favWon)} of ${b.decided} decided`;
}

/** Stat-aware team balance (src/statBalance.ts): is the switch on, how often
 *  the tie-break runs, and whether it brings the stat favourite's win rate
 *  down toward 50%. Approved by the owner 2026-10-23 for the Season 1 flip. */
export function TeamBalance() {
  const { data, error } = useFetch((s) => adminApi.teamBalance(s), []);
  if (error) return <Empty>Could not load the team balance log.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;
  const { config, summary, rows } = data;
  return (
    <div class="stack">
      <p class="balance-banner">
        Stat-aware team balance is <strong>{config.enabled ? 'ON' : 'OFF'}</strong> (gate {pct(config.gate)}, tolerance{' '}
        {Math.round(config.tolerance * 100)} points, holdout {config.holdoutEvery > 0 ? `match ids divisible by ${config.holdoutEvery}` : 'off'};
        Setup &gt; Settings &gt; Queue). Every queue match is logged here either
        way. When the rating-best teams' stat favourite (by past SI damage per game, players with 3+ PUGs) is at or above
        the gate, the balancer picks the split closest to 50% by stats among those within the tolerance by rating.
        Target: the stat favourite of the teams that played should win close to 50%, and no more than about 55%.
        Holdout matches are ones where the gate fired but the rating-best teams played anyway: compare the two
        "Gate fired" lines for the honest A/B.
      </p>
      <table class="admin-table">
        <tbody>
          <tr><th>Matches logged</th><td>{summary.logged} ({summary.enabledMatches} with the switch on)</td></tr>
          <tr><th>Gate fire rate (switch on)</th><td>{pct(summary.gateFireRate)}</td></tr>
          <tr><th>Gate fired, tie-break: stat favourite of the chosen teams</th><td>{bucketLine(summary.firedChosen)}</td></tr>
          <tr><th>Gate fired, holdout: stat favourite of the rating-best teams</th><td>{bucketLine(summary.holdout)}</td></tr>
          <tr><th>Tie-break matches: rating-best teams' stat favourite</th><td>predicted {pct(summary.firedRatingBestPredicted)} (those teams never played)</td></tr>
          <tr><th>Switch off, over the gate (control)</th><td>{bucketLine(summary.offOverGate)}</td></tr>
          <tr><th>All logged: stat favourite of the teams that played</th><td>{bucketLine(summary.allChosen)}</td></tr>
        </tbody>
      </table>
      {rows.length === 0 ? <Empty>No queue match has been logged yet.</Empty> : (
        <table class="admin-table">
          <thead>
            <tr>
              <th>Match</th><th>Logged (UTC)</th><th>Switch</th><th>Gate</th><th>Moved</th>
              <th>Rating-best: rating</th><th>Rating-best: stats</th><th>Played: rating</th><th>Played: stats</th><th>Stat fav won</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const won = statFavWon(r);
              return (
                <tr key={r.matchId}>
                  <td><a href={`/match/${r.matchId}`}>#{r.matchId}</a></td>
                  <td>{r.createdAt}</td>
                  <td>{r.enabled ? 'on' : 'off'}</td>
                  <td>{gateLabel(r)}</td>
                  <td class="num">{r.moved}</td>
                  <td class="num">{favLabel(r.bestRatingA)}</td>
                  <td class="num">{favLabel(r.bestStatA)}</td>
                  <td class="num">{favLabel(r.chosenRatingA)}</td>
                  <td class="num">{favLabel(r.chosenStatA)}</td>
                  <td>{won === null ? (r.winner === 'draw' ? 'draw' : r.state) : won ? 'yes' : 'no'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
