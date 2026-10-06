import type { PlayStanding, StagePlayView } from '../../api';
import { Panel } from '../../components/bits';
import { weekRangeText } from '../../eventFormat';
import { Bracket, MatchCard } from './Bracket';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Standings({ rows, swiss }: { rows: PlayStanding[]; swiss: boolean }) {
  return (
    <div class="table-wrap">
      <table class="playtable">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>W-L</th>
            {swiss && <th>Pts</th>}
            {swiss && <th>Buchholz</th>}
            <th>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entry.id} class={r.entry.out ? 'muted' : ''}>
              <td>{r.groupRank}</td>
              <td>{r.entry.name}{r.entry.out && <span class="chip chip--bad">Disqualified</span>}</td>
              <td>{r.wins}-{r.losses}</td>
              {swiss && <td>{r.points}</td>}
              {swiss && <td>{r.buchholz}</td>}
              <td>{signed(r.scoreDiff)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One started stage on the event page (plan T2): an elimination bracket, or
 *  standings (one table per group) followed by the rounds. */
export function StagePlay({ stage }: { stage: StagePlayView }) {
  const swiss = stage.type === 'swiss';
  return (
    <Panel>
      <h3>Stage {stage.ordinal}: {stage.layout === 'bracket' ? 'bracket' : 'standings'}{stage.status === 'finished' ? ' (finished)' : ''}</h3>
      {stage.layout === 'bracket' ? <Bracket stage={stage} /> : (
        <>
          {stage.advanceCount !== null && <p class="muted">{`Top ${stage.advanceCount} advance`}</p>}
          {stage.groups.map((g) => (
            <section key={g.number}>
              {stage.groups.length > 1 && <h4>{g.label}</h4>}
              <Standings rows={stage.standings.filter((r) => r.group === g.number)} swiss={swiss} />
            </section>
          ))}
          {stage.rounds.slice().reverse().map((r) => (
            <section key={`${r.group}-${r.round}`} class="playround">
              <span class="eyebrow">
                {`${stage.groups.length > 1 ? `${stage.groups.find((g) => g.number === r.group)?.label}, ` : ''}${r.label}${r.dates ? ` · ${weekRangeText(r.dates.from, r.dates.to)}` : ''}`}
              </span>
              <div class="playround__matches">{r.matches.map((m) => <MatchCard key={m.id} m={m} />)}</div>
            </section>
          ))}
        </>
      )}
    </Panel>
  );
}
