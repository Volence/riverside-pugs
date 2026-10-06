import { useState } from 'preact/hooks';
import { adminApi, type PlayMatch } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';

const OPEN = new Set(['waiting']);
const CORRECTABLE = new Set(['done', 'forfeit']);
const STATUS: Record<string, string> = { pending: 'Waiting for teams', waiting: 'To play', done: 'Done', forfeit: 'Forfeit', bye: 'Bye' };

/** A whole number 0 to 100000, with no stray characters: a blank or
 *  partly-typed score must never slip through as `Number('') === 0`. */
const SCORE_RE = /^\d+$/;
const validScore = (s: string): boolean => {
  const t = s.trim();
  return SCORE_RE.test(t) && Number(t) <= 100000;
};

/** One match's result form: its own state, so two rows never share inputs.
 *  `onSaved` fires only once the server actually took the result (it runs
 *  after `recordEventResult` resolves, inside the function `run` awaits, so
 *  a refused or failed save leaves the form open with what was typed). */
function ResultForm({ eventId, m, run, busy, correcting, onSaved }: { eventId: number; m: PlayMatch; run: Run; busy: boolean; correcting: boolean; onSaved?: () => void }) {
  const [winner, setWinner] = useState<'' | 'a' | 'b'>('');
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [forfeit, setForfeit] = useState(false);
  const a = m.a!.name;
  const b = m.b!.name;
  const canSave = winner !== '' && (forfeit || (validScore(scoreA) && validScore(scoreB)));
  const save = () => {
    if (!canSave) return;
    const body = forfeit ? { winner, forfeit: true } : { winner, scoreA: Number(scoreA), scoreB: Number(scoreB), forfeit: false };
    void run(async () => {
      await adminApi.recordEventResult(eventId, m.id, body);
      onSaved?.();
    }, correcting
      ? { title: `Change the result of ${a} vs ${b}?`, body: 'Later matches move with it. A result that later matches already depend on is refused.' }
      : undefined);
  };
  return (
    <div class="inlinerow">
      <label>Winner
        <select aria-label="Winner" value={winner} onChange={(e) => setWinner((e.target as HTMLSelectElement).value as '' | 'a' | 'b')}>
          <option value="">Pick</option>
          <option value="a">{a}</option>
          <option value="b">{b}</option>
        </select>
      </label>
      {!forfeit && (
        <>
          <input type="number" min={0} aria-label={`${a} score`} value={scoreA} onInput={(e) => setScoreA((e.target as HTMLInputElement).value)} />
          <input type="number" min={0} aria-label={`${b} score`} value={scoreB} onInput={(e) => setScoreB((e.target as HTMLInputElement).value)} />
        </>
      )}
      <label><input type="checkbox" aria-label="Forfeit" checked={forfeit} onChange={(e) => setForfeit((e.target as HTMLInputElement).checked)} /> Forfeit</label>
      <button class="btn btn--ghost" disabled={busy || !canSave} onClick={save}>Save result</button>
    </div>
  );
}

function MatchRow({ eventId, m, canEdit, live, run, busy }: { eventId: number; m: PlayMatch; canEdit: boolean; live: boolean; run: Run; busy: boolean }) {
  const [correcting, setCorrecting] = useState(false);
  const editable = canEdit && live && m.a !== null && m.b !== null;
  return (
    <li>
      <strong>{m.a?.name ?? 'TBD'}</strong> vs <strong>{m.bye ? 'Bye' : m.b?.name ?? 'TBD'}</strong>
      <span class="muted"> · {STATUS[m.status] ?? m.status}
        {m.forfeit ? ` · forfeit, ${(m.winner === 'a' ? m.a : m.b)?.name ?? ''} wins` : m.scoreA !== null && m.scoreB !== null ? ` · ${m.scoreA} : ${m.scoreB}` : ''}
      </span>
      {editable && OPEN.has(m.status) && <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting={false} />}
      {editable && CORRECTABLE.has(m.status) && !correcting && (
        <button class="btn btn--ghost" disabled={busy} onClick={() => setCorrecting(true)}>Correct</button>
      )}
      {editable && CORRECTABLE.has(m.status) && correcting && (
        <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting onSaved={() => setCorrecting(false)} />
      )}
    </li>
  );
}

/** The Play section of an event on the desk (plan T2 Ruling 17): Start once
 *  the list is final; each started stage's matches by round with a result
 *  form on open ones and Correct on finished ones while the stage is live. A
 *  mod (canEdit false) reads the same list with no control. */
export function PlayPanel({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventPlay(eventId, s), [eventId]);
  const { busy, error, run } = useAction(reload);
  if (loadError) return <Panel><h3>Play</h3><p class="error">Could not load the matches.</p></Panel>;
  if (!data) return <Panel><h3>Play</h3></Panel>;
  const before = data.status === 'registration' || data.status === 'checkin';
  return (
    <Panel>
      <h3>Play</h3>
      {before && data.lockedAt === null && <p class="muted">The event can start once the entry list is final. It starts by itself at the start time.</p>}
      {before && data.lockedAt !== null && (
        <>
          <p class="muted">{data.seeded} teams are seeded. The event starts by itself at the start time{data.seeded < 2 ? ' once it has 2 teams' : ''}.</p>
          {canEdit && data.seeded >= 2 && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.startEvent(eventId), {
              title: 'Start the event now?', body: 'Stage 1 is drawn from the current seeds, and seeds can no longer change.',
            })}>Start the event now</button>
          )}
        </>
      )}
      {error && <p class="error" role="alert">{error}</p>}
      {!before && data.stages.length === 0 && <Empty>No stage has started.</Empty>}
      {data.stages.map((s) => (
        <section key={s.ordinal}>
          <h4>Stage {s.ordinal}{s.status === 'finished' ? ' (finished)' : ''}</h4>
          {s.rounds.map((r) => (
            <div key={`${r.group}-${r.round}`}>
              <span class="eyebrow">{s.groups.length > 1 ? `${s.groups.find((g) => g.number === r.group)?.label}, ` : ''}{r.label}</span>
              <ul class="admin-list">
                {r.matches.map((m) => <MatchRow key={m.id} eventId={eventId} m={m} canEdit={canEdit} live={s.status === 'live'} run={run} busy={busy} />)}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </Panel>
  );
}
