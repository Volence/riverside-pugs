import { useState } from 'preact/hooks';
import { adminApi, type PlayMatch, type RoomPhase, type StagePlayView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';
import { groupPrefix } from '../../../eventFormat';
import { PHASE_TEXT } from '../../event/room/roomText';

/** The real match.status values (src/events/play.ts MatchStatus) where a
 *  result may still be entered as a first result: before the room opens,
 *  and through every room status up to admin_hold. 'connect', 'live' and
 *  'confirming' (phase 'server') are left out: by then staff reports from
 *  the room, not the desk. */
const OPEN = new Set(['waiting', 'veto', 'lineup', 'booking', 'admin_hold']);
/** Phases where the room is open and the desk offers Reset and Hold. */
const ROOM_LIVE = new Set<RoomPhase>(['ready', 'veto', 'lineup', 'server', 'hold']);
const CORRECTABLE = new Set(['done', 'forfeit']);
/** T2's labels, kept for the statuses that predate rooms. Every other
 *  status (veto, lineup, booking/connect/live/confirming, admin_hold) reads
 *  its label from the match's room phase through PHASE_TEXT instead. */
const STATUS: Record<string, string> = { pending: 'Waiting for teams', waiting: 'To play', done: 'Done', forfeit: 'Forfeit', bye: 'Bye' };
const matchLabel = (m: PlayMatch): string => STATUS[m.status] ?? PHASE_TEXT[m.phase];

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
    const title = `${winner === 'a' ? a : b} wins ${forfeit ? 'by forfeit' : `${Number(scoreA)} : ${Number(scoreB)}`}?`;
    void run(async () => {
      await adminApi.recordEventResult(eventId, m.id, body);
      onSaved?.();
    }, correcting
      ? { title, body: `This changes the result of ${a} vs ${b}. Later matches move with it. A result that later matches already depend on is refused.` }
      : { title });
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
          <input type="number" min={0} aria-label={`${a} score`} placeholder={a} value={scoreA} onInput={(e) => setScoreA((e.target as HTMLInputElement).value)} />
          <input type="number" min={0} aria-label={`${b} score`} placeholder={b} value={scoreB} onInput={(e) => setScoreB((e.target as HTMLInputElement).value)} />
        </>
      )}
      <label><input type="checkbox" aria-label="Forfeit" checked={forfeit} onChange={(e) => setForfeit((e.target as HTMLInputElement).checked)} /> Forfeit</label>
      <button class="btn btn--ghost" disabled={busy || !canSave} onClick={save}>Save result</button>
    </div>
  );
}

/** The one-line reason box behind the "Hold: A vs B" button, opened in
 *  place rather than firing right away since staff should say why. */
function HoldForm({ eventId, m, run, busy, onDone }: { eventId: number; m: PlayMatch; run: Run; busy: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const put = () => {
    void run(async () => {
      await adminApi.holdEventMatch(eventId, m.id, reason);
      onDone();
    });
  };
  return (
    <div class="inlinerow">
      <label>Hold reason
        <input type="text" aria-label="Hold reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      </label>
      <button class="btn btn--ghost btn--sm" disabled={busy} onClick={put}>Put on hold</button>
    </div>
  );
}

/** Where the server refuses a correction anyway (play.ts recordResult), so
 *  Correct is not offered: a match of a stage that pairs as it goes once a
 *  later round exists, and a forfeit whose loser is out of the event while
 *  the winner is still in (the out team could never be made the winner). */
function correctionRefused(s: StagePlayView, m: PlayMatch): boolean {
  if (s.layout === 'table' && s.pairsAsItGoes && s.rounds.some((r) => r.round > m.round)) return true;
  const loser = m.winner === 'a' ? m.b : m.a;
  const winner = m.winner === 'a' ? m.a : m.b;
  return m.forfeit && loser !== null && loser.out && winner !== null && !winner.out;
}

function MatchRow({ eventId, s, m, canEdit, run, busy, slug }: { eventId: number; s: StagePlayView; m: PlayMatch; canEdit: boolean; run: Run; busy: boolean; slug?: string }) {
  const [correcting, setCorrecting] = useState(false);
  const [holding, setHolding] = useState(false);
  const editable = canEdit && s.status === 'live' && m.a !== null && m.b !== null;
  const correctable = editable && CORRECTABLE.has(m.status) && !correctionRefused(s, m);
  const names = m.a && m.b ? `${m.a.name} vs ${m.b.name}` : '';
  return (
    <li>
      <strong>{m.a?.name ?? 'TBD'}</strong> vs <strong>{m.bye ? 'Bye' : m.b?.name ?? 'TBD'}</strong>
      <span class="muted"> · {matchLabel(m)}
        {m.forfeit ? ` · forfeit, ${(m.winner === 'a' ? m.a : m.b)?.name ?? ''} wins` : m.scoreA !== null && m.scoreB !== null ? ` · ${m.scoreA} : ${m.scoreB}` : ''}
      </span>
      {m.a && m.b && slug && <a class="btn btn--sm" href={`/event/${slug}/match/${m.id}`}>Open the room</a>}
      {editable && OPEN.has(m.status) && <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting={false} />}
      {correctable && !correcting && (
        <button class="btn btn--ghost" disabled={busy} onClick={() => setCorrecting(true)}>Correct</button>
      )}
      {correctable && correcting && (
        <ResultForm eventId={eventId} m={m} run={run} busy={busy} correcting onSaved={() => setCorrecting(false)} />
      )}
      {editable && m.phase === 'waiting' && m.a && m.b && (
        <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.openEventRoom(eventId, m.id))}>{`Open room: ${names}`}</button>
      )}
      {editable && ROOM_LIVE.has(m.phase) && (
        <>
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.resetEventRoom(eventId, m.id), {
            title: 'Reset this match room?', body: 'Ready, veto and lineups are cleared and the room opens again.',
          })}>{`Reset room: ${names}`}</button>
          {m.phase !== 'hold' && !holding && (
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => setHolding(true)}>{`Hold: ${names}`}</button>
          )}
          {m.phase !== 'hold' && holding && (
            <HoldForm eventId={eventId} m={m} run={run} busy={busy} onDone={() => setHolding(false)} />
          )}
        </>
      )}
    </li>
  );
}

/** The Play section of an event on the desk (plan T2 Ruling 17): Start once
 *  the list is final; each started stage's matches by round with a result
 *  form on open ones and Correct on finished ones while the stage is live. A
 *  mod (canEdit false) reads the same list with no control. */
export function PlayPanel({ eventId, canEdit, gen = 0, onChange, slug }: { eventId: number; canEdit: boolean; gen?: number; onChange?: () => void; slug?: string }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventPlay(eventId, s), [eventId, gen]);
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
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(async () => { await adminApi.startEvent(eventId); onChange?.(); }, {
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
              <span class="eyebrow">{groupPrefix(s, r)}{r.label}</span>
              <ul class="admin-list">
                {r.matches.map((m) => <MatchRow key={m.id} eventId={eventId} s={s} m={m} canEdit={canEdit} run={run} busy={busy} slug={slug} />)}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </Panel>
  );
}
