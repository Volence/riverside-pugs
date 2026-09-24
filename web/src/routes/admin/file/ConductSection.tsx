import type { ConductSection as Conduct, PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtClock } from '../../../format';
import { fmtTime } from '../useAction';

const where = (mapOrdinal: number, half: number | null) =>
  `map ${mapOrdinal + 1}${half ? `, round ${half}` : ''}`;

/** A number beside the league's, with the unit once. */
function versus(mine: string, league: string | null) {
  return (
    <>
      <strong>{mine}</strong>
      {league !== null && <span class="muted"> (league {league})</span>}
    </>
  );
}

function Readyups({ r }: { r: Conduct['readyups'] }) {
  if (r.count === 0) return <p class="muted">No finished ready-ups on record.</p>;
  const leagueLast = r.leagueLastShare === null ? null
    : `about 1 in ${Math.max(1, Math.round(1 / Math.max(r.leagueLastShare, 0.01)))}`;
  return (
    <>
      <p>
        Average time not ready:{' '}
        {versus(fmtClock(r.avgSeconds ?? 0), r.leagueAvgSeconds === null ? null : fmtClock(r.leagueAvgSeconds))}
        {' · '}Last to ready in {versus(`${r.timesLast} of ${r.count}`, leagueLast)}
      </p>
      {r.slowest.length > 0 && (
        <ul class="admin-list">
          {r.slowest.map((s) => (
            <li key={`${s.matchId}-${s.mapOrdinal}-${s.half}`}>
              <a href={`/match/${s.matchId}`}>#{s.matchId}</a> {where(s.mapOrdinal, s.half)}
              {' · '}{fmtClock(s.seconds)} not ready{s.wasLast && <span class="admin-warn"> · last</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Pauses({ p }: { p: Conduct['pauses'] }) {
  if (p.trackedSince === null) {
    return (
      <p class="muted">
        Not tracked yet. Pauses are named once the servers run pug-match 0.3.5; older ones only
        record the team, and are never pinned on a person.
      </p>
    );
  }
  return (
    <>
      <p>
        <strong>{p.called}</strong> pause{p.called === 1 ? '' : 's'} called in {p.matchesSince} match
        {p.matchesSince === 1 ? '' : 'es'}, {fmtClock(p.totalSeconds)} paused in all
        <span class="muted"> · tracked since {fmtTime(p.trackedSince)}</span>
      </p>
      {p.recent.length > 0 && (
        <ul class="admin-list">
          {p.recent.map((x) => (
            <li key={`${x.matchId}-${x.startedAt}`}>
              <a href={`/match/${x.matchId}`}>#{x.matchId}</a> {where(x.mapOrdinal, x.half)}
              {' · '}{x.seconds === null ? 'no end recorded' : fmtClock(x.seconds)}
              <span class="muted"> · {fmtTime(x.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Ready-ups and pauses. Behaviour worth a word, never evidence: nothing
 *  here puts anyone on Needs a look. What they said is on each match's chat
 *  log, linked from Recent matches. */
export function ConductSection({ d }: { d: PlayerFileData }) {
  const c = d.sections.conduct;
  if (!c) return null;
  return (
    <Panel class="file-section">
      <h3>Conduct</h3>
      <h4>Ready-ups</h4>
      <Readyups r={c.readyups} />
      <h4>Pauses</h4>
      <Pauses p={c.pauses} />
    </Panel>
  );
}
