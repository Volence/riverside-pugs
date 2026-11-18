import { useState } from 'preact/hooks';
import { adminApi, type AltReportHalf, type AltReportMatch } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';
import { campaignName, fmtDate, mapName } from '../../../format';
import { pct } from './TeamBalance';

const TANK_BY: Record<string, string> = { surv: 'survivors killed it', other: 'died another way', gone: 'tank left the game' };

/** The winner column: same or different winner, incomplete, or a dash while undecided. */
export function winnerMark(m: AltReportMatch): string {
  if (!m.complete) return 'incomplete';
  if (m.differs === null) return '-';
  return m.differs ? 'different' : 'same';
}

function tankEnd(h: AltReportHalf): string {
  if (h.tankPct === null) return '-';
  const by = h.tankBy ? TANK_BY[h.tankBy] ?? h.tankBy : null;
  return by ? `${h.tankPct}% (${by})` : `${h.tankPct}%`;
}

function Halves({ m }: { m: AltReportMatch }) {
  return (
    <table class="admin-table" data-testid={`alt-halves-${m.id}`}>
      <thead>
        <tr>
          <th>Map</th><th>Half</th><th>Survivors</th><th>Real</th><th>Walking</th><th>Tank</th><th>Saferoom</th><th>Alt total</th>
          <th>Team health % when the tank fight ended</th><th>Survivors in saferoom</th>
        </tr>
      </thead>
      <tbody>
        {m.halves.map((h) => (
          <tr key={`${h.ordinal}-${h.half}`}>
            <td>{h.map ? mapName(h.map) : '-'}</td>
            <td class="num">{h.half}</td>
            <td>Team {h.survTeam.toUpperCase()}</td>
            <td class="num">{h.real === null ? '-' : h.real}</td>
            <td class="num">{h.walk}</td>
            <td class="num">{h.tank}</td>
            <td class="num">{h.door}</td>
            <td class="num">
              {h.total}
              {h.mismatch && <span class="error"> mismatch</span>}
            </td>
            <td>{tankEnd(h)}</td>
            <td class="num">{h.survivorsIn}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Health-run scoring in shadow mode (src/altScoringReport.ts): each match's
 *  alt score beside its real one, and per-map walking for tuning the walk
 *  multipliers. Nothing on this page changes a real score. */
export function AltScoring() {
  const { data, error } = useFetch((s) => adminApi.altScoring(s), []);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Empty>Could not load the alt scoring report.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;
  const { summary, maps, matches } = data;
  const intro = <p class="balance-banner">Health-run scoring, computed in the background. Real scores are not affected.</p>;
  if (summary.matchesWithData === 0) {
    return (
      <div class="stack">
        {intro}
        <Empty>No match has reported alt scores yet. They start once the servers run the new scoring plugin.</Empty>
      </div>
    );
  }
  const { share } = summary;
  return (
    <div class="stack">
      {intro}
      <p class="muted">
        The alt score is what a match would have scored under the new health-run scoring. It splits each half into
        three parts: walking (700 points, for ground covered while healthy), tank (300, for health left when the tank
        dies or leaves the game, if a survivor is still standing) and saferoom (500, for survivors who make it in
        healthy). Walking and saferoom are then scaled per map.
      </p>
      <p class="muted">
        The list shows the most recent 100 matches. The totals count only ranked PUGs that finished, were not voided and
        have an alt score for every half, so "0 of 0" is expected at first.
      </p>
      <table class="admin-table" data-testid="alt-summary">
        <tbody>
          <tr><th>Matches with data</th><td class="num">{summary.matchesWithData}</td></tr>
          <tr><th>Complete matches counted</th><td class="num">{summary.complete}</td></tr>
          <tr><th>Different winner</th><td class="num">{summary.differentWinner} of {summary.complete}</td></tr>
          <tr><th>Share of points</th><td>Walking {pct(share.walk)}, tank {pct(share.tank)}, saferoom {pct(share.door)}</td></tr>
        </tbody>
      </table>
      {summary.mismatchedHalves > 0 && (
        <p class="error" data-testid="alt-mismatch">
          {summary.mismatchedHalves === 1
            ? '1 half has a stored score that does not match its own breakdown.'
            : `${summary.mismatchedHalves} halves have a stored score that does not match their own breakdown.`}{' '}
          That points at a bug in the game server's scoring, not in the match.
        </p>
      )}

      <h3>Walking by map</h3>
      <p class="muted">
        Average walking points per half in counted matches, before any map multiplier, and the walk multiplier that
        would bring the map to the average of all maps. A dash means the map does not have enough halves yet.
      </p>
      <div class="table-wrap">
        <table class="admin-table" data-testid="alt-maps">
          <thead><tr><th>Map</th><th>Halves</th><th>Avg walking</th><th>Suggested walk multiplier</th></tr></thead>
          <tbody>
            {maps.map((r) => (
              <tr key={r.map}>
                <td>{mapName(r.map)} <span class="muted">{r.map}</span></td>
                <td class="num">{r.halves}</td>
                <td class="num">{Math.round(r.avgWalkRaw)}</td>
                <td class="num">{r.suggestedWalkMult === null ? '-' : r.suggestedWalkMult.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Matches</h3>
      <p class="muted">Click a match to see its halves.</p>
      <div class="table-wrap">
        <table class="admin-table" data-testid="alt-matches">
          <thead>
            <tr><th>Match</th><th>Ended (UTC)</th><th>Campaign</th><th>Real (A - B)</th><th>Alt (A - B)</th><th>Winner</th></tr>
          </thead>
          <tbody>
            {matches.flatMap((m) => {
              const toggle = () => setOpen(open === m.id ? null : m.id);
              const row = (
                <tr
                  key={m.id}
                  class="is-clickable"
                  tabIndex={0}
                  aria-expanded={open === m.id}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      if (e.key === ' ') e.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <td><a href={`/match/${m.id}`} onClick={(e) => e.stopPropagation()}>#{m.id}</a></td>
                  <td>{fmtDate(m.endedAt) || '-'}</td>
                  <td>{campaignName(m.campaign)}</td>
                  <td class="num">{m.realA} - {m.realB}</td>
                  <td class="num">{m.altA} - {m.altB}</td>
                  <td>
                    {winnerMark(m)}
                    {m.complete && !m.counted && <span class="muted"> (not counted)</span>}
                  </td>
                </tr>
              );
              return open === m.id
                ? [row, <tr key={`${m.id}-halves`}><td colSpan={6}><Halves m={m} /></td></tr>]
                : [row];
            })}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Incomplete: some halves of the match have a real score but no alt score (for example a forfeit, or a server that
        was not running the new scoring yet), so it is left out of the totals above. Not counted: not a ranked PUG,
        voided, or not finished yet.
      </p>
    </div>
  );
}
