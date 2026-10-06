import type { PlayEntry, PlayMatch, StagePlayView } from '../../api';
import { PHASE_TEXT } from './room/roomText';

/** One side of a match card: the team (or TBD / Bye) and its score. */
function Side({ e, score, won, forfeitLoss, bye }: { e: PlayEntry | null; score: number | null; won: boolean; forfeitLoss: boolean; bye: boolean }) {
  return (
    <div class={`matchcard__side${won ? ' matchcard__side--won' : ''}${e?.out ? ' muted' : ''}`}>
      <span class="matchcard__name">{e ? e.name : bye ? 'Bye' : 'TBD'}</span>
      <span class="matchcard__score">{forfeitLoss ? 'FF' : score !== null ? String(score) : ''}</span>
    </div>
  );
}

/** A match card. Linked to its room once both teams are known and it is
 *  not a bye (plan T3a); the phase chip only shows once the room has moved
 *  past waiting, since pending/waiting/done already read from the card. */
export function MatchCard({ m, slug }: { m: PlayMatch; slug: string }) {
  const body = (
    <>
      <Side e={m.a} score={m.scoreA} won={m.winner === 'a'} forfeitLoss={m.forfeit && m.winner === 'b'} bye={false} />
      <Side e={m.b} score={m.scoreB} won={m.winner === 'b'} forfeitLoss={m.forfeit && m.winner === 'a'} bye={m.bye} />
      {m.phase !== 'done' && m.phase !== 'pending' && m.phase !== 'waiting' && <span class="matchcard__phase">{PHASE_TEXT[m.phase]}</span>}
    </>
  );
  if (!m.a || !m.b || m.bye) return <div class={`matchcard matchcard--${m.status}`}>{body}</div>;
  return <a class={`matchcard matchcard--${m.status} matchcard--link`} href={`/event/${slug}/match/${m.id}`}>{body}</a>;
}

/** An elimination stage: per group, one column per round (plan T2 Ruling
 *  15: no connector lines in v1). The columns scroll inside the panel at
 *  phone width; the page itself never scrolls sideways. */
export function Bracket({ stage, slug }: { stage: StagePlayView; slug: string }) {
  return (
    <>
      {stage.groups.map((g) => (
        <section key={g.number} class="bracketgroup">
          {stage.groups.length > 1 && <h4>{g.label}</h4>}
          <div class="bracket">
            {stage.rounds.filter((r) => r.group === g.number).map((r) => (
              <div key={r.round} class="bracket__round">
                <span class="eyebrow">{r.label}</span>
                {r.matches.map((m) => <MatchCard key={m.id} m={m} slug={slug} />)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
