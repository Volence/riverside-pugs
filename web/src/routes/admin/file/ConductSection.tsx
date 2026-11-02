import type { ConductSection as Conduct, PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtClock } from '../../../format';
import { fmtTime } from '../useAction';

const where = (mapOrdinal: number, half: number | null) =>
  `map ${mapOrdinal + 1}${half ? `, round ${half}` : ''}`;

/** One figure beside the league's, as a stat: the label above, the number
 *  large, the league's below it in muted. */
function Stat({ label, mine, league }: { label: string; mine: string; league: string | null }) {
  return (
    <div class="file-stat">
      <span class="file-stat__label">{label}</span>
      <span class="file-stat__n">{mine}</span>
      {league !== null && <span class="file-stat__vs">league {league}</span>}
    </div>
  );
}

function Readyups({ r }: { r: Conduct['readyups'] }) {
  if (r.count === 0) return <p class="muted">No finished ready-ups on record.</p>;
  const leagueLast = r.leagueLastShare === null ? null
    : `about 1 in ${Math.max(1, Math.round(1 / Math.max(r.leagueLastShare, 0.01)))}`;
  return (
    <>
      <div class="file-stats">
        <Stat label="Average time not ready" mine={fmtClock(r.avgSeconds ?? 0)}
          league={r.leagueAvgSeconds === null ? null : fmtClock(r.leagueAvgSeconds)} />
        <Stat label="Last to ready" mine={`${r.timesLast} of ${r.count}`} league={leagueLast} />
      </div>
      {r.slowest.length > 0 && (
        <>
          <p class="file-help">Slowest ready-ups</p>
          <ul class="file-rows">
            {r.slowest.map((s) => (
              <li key={`${s.matchId}-${s.mapOrdinal}-${s.half}`} class="file-row file-row--line">
                <a href={`/match/${s.matchId}`}>#{s.matchId}</a>
                <span class="muted">{where(s.mapOrdinal, s.half)}</span>
                <span class="file-row__fig">{fmtClock(s.seconds)} not ready</span>
                {s.wasLast && <span class="file-pill file-pill--warn">last</span>}
              </li>
            ))}
          </ul>
        </>
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
      <div class="file-stats">
        <Stat label="Pauses called" mine={String(p.called)} league={null} />
        <Stat label="Time paused in all" mine={fmtClock(p.totalSeconds)} league={null} />
      </div>
      <p class="file-help">
        {p.called} pause{p.called === 1 ? '' : 's'} called in {p.matchesSince} match{p.matchesSince === 1 ? '' : 'es'}
        {' · '}tracked since {fmtTime(p.trackedSince)}
      </p>
      {p.recent.length > 0 && (
        <ul class="file-rows">
          {p.recent.map((x) => (
            <li key={`${x.matchId}-${x.startedAt}`} class="file-row file-row--line">
              <a href={`/match/${x.matchId}`}>#{x.matchId}</a>
              <span class="muted">{where(x.mapOrdinal, x.half)}</span>
              <span class="file-row__fig">{x.seconds === null ? 'no end recorded' : fmtClock(x.seconds)}</span>
              <span class="muted file-row__when">{fmtTime(x.startedAt)}</span>
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
    <Panel class="file-section" id="conduct">
      <h3>Conduct</h3>
      <div class="file-split">
        <div>
          <h4>Ready-ups</h4>
          <Readyups r={c.readyups} />
        </div>
        <div>
          <h4>Pauses</h4>
          <Pauses p={c.pauses} />
        </div>
      </div>
    </Panel>
  );
}
