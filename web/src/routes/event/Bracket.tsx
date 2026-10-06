import type { PlayEntry, PlayMatch, StagePlayView } from '../../api';

/** One side of a match card: the team (or TBD / Bye) and its score. */
function Side({ e, score, won, forfeitLoss, bye }: { e: PlayEntry | null; score: number | null; won: boolean; forfeitLoss: boolean; bye: boolean }) {
  return (
    <div class={`matchcard__side${won ? ' matchcard__side--won' : ''}${e?.out ? ' muted' : ''}`}>
      <span class="matchcard__name">{e ? e.name : bye ? 'Bye' : 'TBD'}</span>
      <span class="matchcard__score">{forfeitLoss ? 'FF' : score !== null ? String(score) : ''}</span>
    </div>
  );
}

export function MatchCard({ m }: { m: PlayMatch }) {
  return (
    <div class={`matchcard matchcard--${m.status}`}>
      <Side e={m.a} score={m.scoreA} won={m.winner === 'a'} forfeitLoss={m.forfeit && m.winner === 'b'} bye={false} />
      <Side e={m.b} score={m.scoreB} won={m.winner === 'b'} forfeitLoss={m.forfeit && m.winner === 'a'} bye={m.bye} />
    </div>
  );
}

/** An elimination stage: per group, one column per round (plan T2 Ruling
 *  15: no connector lines in v1). The columns scroll inside the panel at
 *  phone width; the page itself never scrolls sideways. */
export function Bracket({ stage }: { stage: StagePlayView }) {
  return (
    <>
      {stage.groups.map((g) => (
        <section key={g.number} class="bracketgroup">
          {stage.groups.length > 1 && <h4>{g.label}</h4>}
          <div class="bracket">
            {stage.rounds.filter((r) => r.group === g.number).map((r) => (
              <div key={r.round} class="bracket__round">
                <span class="eyebrow">{r.label}</span>
                {r.matches.map((m) => <MatchCard key={m.id} m={m} />)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
