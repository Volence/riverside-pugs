import type { PlayEntry, PlayMatch, PlayRound, StagePlayView } from '../../api';
import { roundWhenText, whenText } from '../../eventFormat';
import { PHASE_TEXT } from './room/roomText';

/** One side of a match card: the team (or TBD / Bye) and its score. */
function Side({ e, score, won, forfeitLoss, bye }: { e: PlayEntry | null; score: number | null; won: boolean; forfeitLoss: boolean; bye: boolean }) {
  return (
    <div class={`matchcard__side${won ? ' matchcard__side--won' : ''}${e?.out ? ' muted' : ''}`}>
      <span class="matchcard__name">
        {e && e.seed !== null && <span class="matchcard__seed">{e.seed}</span>}
        {e ? e.name : bye ? 'Bye' : 'TBD'}
      </span>
      <span class="matchcard__score">{forfeitLoss ? 'FF' : score !== null ? String(score) : ''}</span>
    </div>
  );
}

/** The bracket's chip while a result waits out its confirm window: the result
 *  already stands unless a captain disputes it, so it reads as a result. */
export const CONFIRMING_TEXT = 'Result in, open to dispute';

/** Teams that start in a later round because the first round gave them a bye:
 *  the bracket library leaves bye matches out, so the first column would
 *  otherwise never show the top seed. Read off the teams of the round after
 *  that no first-round match names. */
export function byeTeams(rounds: PlayRound[]): PlayEntry[] {
  const first = rounds.find((r) => r.round === 1);
  const second = rounds.find((r) => r.round === 2);
  if (!first || !second) return [];
  const seen = new Set(first.matches.flatMap((m) => [m.a?.id, m.b?.id]).filter((x): x is number => x !== undefined));
  const out: PlayEntry[] = [];
  for (const m of second.matches) for (const e of [m.a, m.b]) if (e && !seen.has(e.id) && !out.some((x) => x.id === e.id)) out.push(e);
  return out.sort((x, y) => (x.seed ?? 999) - (y.seed ?? 999));
}

/** A card for a team that skips the first round. */
function ByeCard({ e }: { e: PlayEntry }) {
  return (
    <div class="matchcard matchcard--bye">
      <Side e={e} score={null} won={false} forfeitLoss={false} bye={false} />
      <Side e={null} score={null} won={false} forfeitLoss={false} bye />
    </div>
  );
}

/** A match card. Linked to its room once both teams are known and it is
 *  not a bye (plan T3a); the phase chip only shows once the room has moved
 *  past waiting, since pending/waiting/done already read from the card. */
export function MatchCard({ m, slug, roundDefault = null }: { m: PlayMatch; slug: string; roundDefault?: string | null }) {
  const body = (
    <>
      <Side e={m.a} score={m.scoreA} won={m.winner === 'a'} forfeitLoss={m.forfeit && m.winner === 'b'} bye={false} />
      <Side e={m.b} score={m.scoreB} won={m.winner === 'b'} forfeitLoss={m.forfeit && m.winner === 'a'} bye={m.bye} />
      {m.scheduledAt && m.scheduledAt !== roundDefault && <span class="matchcard__when">{whenText(m.scheduledAt)}</span>}
      {m.phase !== 'done' && m.phase !== 'pending' && m.phase !== 'waiting' && <span class="matchcard__phase">{m.phase === 'confirming' ? CONFIRMING_TEXT : PHASE_TEXT[m.phase]}</span>}
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
      {stage.groups.map((g) => {
        const rounds = stage.rounds.filter((r) => r.group === g.number);
        // The main bracket's heading repeats the panel title, and a one-round
        // group (the third-place match) already names itself in its column.
        const head = stage.groups.length > 1 && !(g.number === 1 && g.label === 'Bracket') && !(rounds.length === 1 && rounds[0]!.label === g.label);
        const byes = g.number === 1 ? byeTeams(rounds) : [];
        return (
          <section key={g.number} class="bracketgroup">
            {head && <h4>{g.label}</h4>}
            <div class="bracket">
              {rounds.map((r) => (
                <div key={r.round} class="bracket__round">
                  <span class="eyebrow">{`${r.label}${r.defaultAt ? ` · ${roundWhenText(r.defaultAt)}` : ''}`}</span>
                  {r.round === 1 && byes.map((e) => <ByeCard key={`bye-${e.id}`} e={e} />)}
                  {r.matches.map((m) => <MatchCard key={m.id} m={m} slug={slug} roundDefault={r.defaultAt} />)}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
