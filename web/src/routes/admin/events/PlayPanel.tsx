import { useRef, useState } from 'preact/hooks';
import { adminApi, type PlayMatch, type RoomPhase, type StagePlayView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction, type Run } from '../useAction';
import { fromLocalInput, groupPrefix, playByText, whenText } from '../../../eventFormat';
import { PHASE_TEXT } from '../../event/room/roomText';

/** The real match.status values (src/events/play.ts MatchStatus) where a
 *  result may still be entered as a first result: before the room opens,
 *  and through every room status (play.ts ROOM_OPEN). A result entered while
 *  the booking runs (connect, live, confirming) ends the booking as a staff
 *  end (plan T3b). */
const OPEN = new Set(['waiting', 'veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold']);
/** Phases where the room is open and the desk offers Reset and Hold. */
const ROOM_LIVE = new Set<RoomPhase>(['ready', 'veto', 'lineup', 'server', 'connect', 'live', 'confirming', 'hold']);
/** Phases where the match holds a server booking, so a reset cancels it. */
const BOOKED = new Set<RoomPhase>(['connect', 'live', 'confirming']);
const CORRECTABLE = new Set(['done', 'forfeit']);
/** A match with a result: its technical pauses stay listed on the desk, but
 *  Warn and Forfeit the game are live tools only (final review ruling); a
 *  finished match is changed through the result tools instead. */
const FINISHED = new Set(['done', 'forfeit', 'bye']);
const finished = (m: PlayMatch): boolean => FINISHED.has(m.status) || m.phase === 'done';
/** T2's labels, kept for the statuses that predate rooms. Every other
 *  status (veto, lineup, booking, connect, live, confirming, admin_hold) reads
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

/** The desk's line under a match in a room phase (plan T3c Ruling 16). */
function DeskLine({ m }: { m: PlayMatch }) {
  const d = m.desk;
  if (!d) return null;
  const a = m.a?.name ?? 'TBD';
  const b = m.b?.name ?? 'TBD';
  const parts: string[] = [];
  if (d.holdReason !== null) parts.push(`On hold (${d.holdReason}${d.holdFrom ? `, from ${PHASE_TEXT[d.holdFrom === 'veto' ? 'veto' : d.holdFrom === 'booking' ? 'server' : d.holdFrom as RoomPhase] ?? d.holdFrom}` : ''})`);
  if (d.dispute) parts.push(`Disputed by ${d.dispute.byName} for ${d.dispute.side === 'a' ? a : b}: ${d.dispute.reason}`);
  if (d.frozen) parts.push('Frozen by staff');
  if (d.booking) parts.push(`Server: ${d.booking.serverName ?? 'none yet'}${d.booking.recovering ? ' (recovering)' : ''}`);
  if (d.subs.a + d.subs.b > 0) parts.push(`Subs: ${a} ${d.subs.a}, ${b} ${d.subs.b}`);
  if (m.scheduledAt) parts.push(`Time: ${whenText(m.scheduledAt)}${m.scheduleSource === 'agreed' ? ' (agreed)' : m.scheduleSource === 'staff' ? ' (staff)' : ''}`);
  if (d.schedule?.windowEnd) parts.push(playByText(d.schedule.windowEnd));
  if (d.schedule?.proposal) parts.push(`Proposal open: ${d.schedule.proposal.byName} (${d.schedule.proposal.side === 'a' ? a : b}) ${whenText(d.schedule.proposal.time)}${d.schedule.proposal.autoAcceptAt ? `, locks ${whenText(d.schedule.proposal.autoAcceptAt)}` : ''} · ${d.schedule.proposals} ${d.schedule.proposals === 1 ? 'proposal' : 'proposals'}`);
  if (parts.length === 0) return null;
  return <p class="muted desk-line">{parts.join(' · ')}</p>;
}

const STEP_ACTIONS = ['first', 'second', 'ban', 'pick', 'survivors', 'infected'] as const;
const FOUR_RE = /^\d{17}$/;
/** Holds over a game the box no longer runs: a release would be held again at once (plan T3c final review). */
const GAME_GONE = new Set(['game_aborted', 'game_lost']);

/** The staff tools (plan T3c Rulings 10 to 15 and 9), each behind a confirm. */
function DeskTools({ eventId, m, run, busy }: { eventId: number; m: PlayMatch; run: Run; busy: boolean }) {
  const [side, setSide] = useState<'a' | 'b'>('a');
  const [step, setStep] = useState('');
  const [action, setAction] = useState<(typeof STEP_ACTIONS)[number]>('ban');
  const [campaign, setCampaign] = useState('');
  const [four, setFour] = useState('');
  const [minutes, setMinutes] = useState('5');
  const [chapter, setChapter] = useState('');
  // The replay route answers before the box does (plan T3c final review): its outcome reaches the staff feed.
  const [replayNote, setReplayNote] = useState('');
  const [time, setTime] = useState('');
  const d = m.desk!;
  const names = `${m.a?.name ?? 'TBD'} vs ${m.b?.name ?? 'TBD'}`;
  const teamName = side === 'a' ? m.a?.name ?? 'team A' : m.b?.name ?? 'team B';
  const phase = m.phase;
  const canAct = phase === 'ready' || phase === 'veto' || phase === 'lineup' || phase === 'live';
  const canReopen = phase === 'ready' || phase === 'veto' || phase === 'lineup' || phase === 'server' || phase === 'hold';
  const canBox = phase === 'connect' || phase === 'live';
  /** Plan T4: a window-stage match still waiting for its room may have its
   *  time set outright, and so may one held at its window end (the server
   *  releases that hold with the time, final review). */
  const heldFromWaiting = phase === 'hold' && d.holdFrom === 'waiting';
  const canTime = (phase === 'waiting' || heldFromWaiting) && d.schedule !== null;
  /** Plan T5: the match's technical pauses, each with a Warn and, while its
   *  game is the one being played, a Forfeit the game. */
  const canTech = d.pauses.length > 0;
  const canRule = !finished(m);
  const chapters = d.liveGame?.chapters ?? [];
  const fourIds = four.split(/[\s,]+/).filter(Boolean);
  const chapterLabel = (c: { ordinal: number; map: string }) => `Chapter ${c.ordinal + 1}: ${c.map}`;
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [open, setOpen] = useState(false);
  // Only one match's tools stay open at a time: on a list of several rooms,
  // an admin opening a second row should not leave a stale first one's
  // buttons (acting on an already-handled match) reachable underneath. The
  // open state is read back from the element itself (not just toggled)
  // because the browser also closes OTHER <details> here when one opens.
  const onToggle = () => {
    const el = detailsRef.current;
    if (!el) return;
    setOpen(el.open);
    if (!el.open) return;
    // Scoped to this Play panel: another panel's open tools are not ours to close.
    const root: ParentNode = el.closest('.playpanel') ?? el.ownerDocument;
    root.querySelectorAll<HTMLDetailsElement>('details.desktools').forEach((other) => {
      if (other !== el) other.open = false;
    });
  };
  // A phase with no tool (confirming, for one) shows no empty disclosure.
  if (!canAct && !canReopen && !canBox && !canTime && !canTech) return null;
  return (
    <details class="desktools" ref={detailsRef} open={open} onToggle={onToggle}>
      <summary>{`Staff tools: ${names}`}</summary>
      {open && canAct && (
        <div class="desktools__group">
          <label>Act as
            <select aria-label="Act as" value={side} onChange={(e) => setSide((e.target as HTMLSelectElement).value as 'a' | 'b')}>
              <option value="a">{m.a?.name ?? 'Team A'}</option>
              <option value="b">{m.b?.name ?? 'Team B'}</option>
            </select>
          </label>
          {phase === 'ready' && (
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.actForTeam(eventId, m.id, { kind: 'ready', side }), { title: `Press Ready for ${teamName}?` })}>Press Ready</button>
          )}
          {(phase === 'veto' || phase === 'live') && (
            <div class="inlinerow">
              <input type="number" min={0} aria-label="Veto step" placeholder="step" value={step} onChange={(e) => setStep((e.target as HTMLInputElement).value)} />
              <select aria-label="Veto action" value={action} onChange={(e) => setAction((e.target as HTMLSelectElement).value as (typeof STEP_ACTIONS)[number])}>
                {STEP_ACTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input type="text" aria-label="Campaign" placeholder="campaign slug (ban or pick)" value={campaign} onInput={(e) => setCampaign((e.target as HTMLInputElement).value)} />
              <button class="btn btn--ghost btn--sm" disabled={busy || !/^\d+$/.test(step)} onClick={() => void run(
                () => adminApi.actForTeam(eventId, m.id, { kind: 'veto', side, step: Number(step), action, campaign: campaign.trim() === '' ? null : campaign.trim() }),
                { title: `Take step ${step} (${action}${campaign.trim() ? ` ${campaign.trim()}` : ''}) for ${teamName}?`, body: 'The room page shows the step number of the pending step.' },
              )}>Take the veto step</button>
            </div>
          )}
          {phase === 'lineup' && (
            <div class="inlinerow">
              <input type="text" aria-label="Four SteamID64s" placeholder="four SteamID64s, space or comma separated" value={four} onInput={(e) => setFour((e.target as HTMLInputElement).value)} />
              <button class="btn btn--ghost btn--sm" disabled={busy || fourIds.length !== 4 || !fourIds.every((x) => FOUR_RE.test(x))} onClick={() => void run(
                () => adminApi.actForTeam(eventId, m.id, { kind: 'lineup', side, steamids: fourIds }),
                { title: `Lock this lineup for ${teamName}?`, body: 'The four must be starters or subs of the entry.' },
              )}>Lock the lineup</button>
            </div>
          )}
        </div>
      )}
      {open && <div class="desktools__group">
        {canReopen && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.reopenEventVeto(eventId, m.id),
            { title: 'Reopen the veto?', body: 'The veto, games and lineups are cleared and the room starts again from the first step with both teams still ready. A booking made meanwhile is cancelled.' })}>Reopen veto</button>
        )}
        {phase === 'connect' && (
          <>
            <input type="number" min={1} max={60} aria-label="Minutes" value={minutes} onInput={(e) => setMinutes((e.target as HTMLInputElement).value)} />
            <button class="btn btn--ghost btn--sm" disabled={busy || !/^\d+$/.test(minutes)} onClick={() => void run(() => adminApi.extendEventGrace(eventId, m.id, Number(minutes)),
              { title: `Give both teams ${minutes} more minutes to connect?` })}>Extend grace</button>
          </>
        )}
        {phase === 'hold' && GAME_GONE.has(d.holdReason ?? '') && (
          <p class="muted">The game on the server was aborted or lost: enter the result, or reset the room. Releasing the hold would only hold it again.</p>
        )}
        {phase === 'hold' && !GAME_GONE.has(d.holdReason ?? '') && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.releaseEventHold(eventId, m.id),
            { title: 'Release the hold?', body: heldFromWaiting
              ? 'The match goes back to waiting. If its window has ended it keeps no window, so set a time for it here (Set time also releases the hold).'
              : `The match goes back to ${d.holdFrom ?? 'where it was'} with a fresh deadline. A dispute is cleared.` })}>Release hold</button>
        )}
        {canBox && (d.frozen
          ? <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.unfreezeEventMatch(eventId, m.id), { title: 'Unfreeze the game?' })}>Unfreeze</button>
          : <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.freezeEventMatch(eventId, m.id), { title: 'Freeze the game?', body: phase === 'connect'
            ? 'The teams are still in ready-up, so the pause lands when the next half goes live. Only staff can unpause it (here, or !lift in game).'
            : 'The game pauses and only staff can unpause it (here, or !lift in game).' })}>Freeze</button>)}
        {canBox && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.moveEventServer(eventId, m.id),
            { title: 'Move the match to another server?', body: 'The current server goes back to the pool. The match takes the first idle server in its region, is set up again and the live game is restored from the site\'s record; with no server free it waits, then is held.' })}>Move server</button>
        )}
        {phase === 'live' && chapters.length > 0 && (
          <div class="inlinerow">
            <select aria-label="Chapter to replay" value={chapter} onChange={(e) => setChapter((e.target as HTMLSelectElement).value)}>
              <option value="">Pick a chapter</option>
              {chapters.map((c) => <option key={c.ordinal} value={String(c.ordinal)}>{chapterLabel(c)}</option>)}
            </select>
            <button class="btn btn--ghost btn--sm" disabled={busy || chapter === ''} onClick={() => void run(async () => {
              setReplayNote('');
              await adminApi.replayEventChapter(eventId, m.id, Number(chapter));
              setReplayNote('Replay started; the result will appear in the staff feed.');
            },
              { title: `Replay ${chapterLabel(chapters.find((c) => String(c.ordinal) === chapter)!)} from its start?`, body: 'That chapter and anything after it are played again; earlier chapters keep their scores. The finale cannot be replayed.' })}>Replay chapter</button>
          </div>
        )}
        {replayNote && <p class="muted" role="status">{replayNote}</p>}
      </div>}
      {open && canTime && (
        <div class="desktools__group">
          <label>Match time <input type="datetime-local" aria-label="Match time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} /></label>
          <button class="btn btn--ghost btn--sm" disabled={busy || !fromLocalInput(time)} onClick={() => void run(async () => {
            await adminApi.setEventMatchTime(eventId, m.id, fromLocalInput(time)!);
            setTime('');
          }, { title: `Set ${names} for ${whenText(fromLocalInput(time)!)}?`, body: `Both rosters are told. An open proposal expires. The room opens before the time on its own.${heldFromWaiting ? ' The hold is released with it.' : ''}` })}>Set time</button>
        </div>
      )}
      {open && canTech && (
        <div class="desktools__group">
          <p class="muted">Technical pauses</p>
          <ul class="desktools__pauses">
            {d.pauses.map((p) => {
              const team = p.side === 'a' ? m.a?.name ?? 'Team A' : m.b?.name ?? 'Team B';
              const flag = p.flaggedBy ? `, flagged by ${p.flaggedBy}${p.flagNote ? ` ("${p.flagNote}")` : ''}` : '';
              return (
                <li key={p.id}>
                  {`Game ${p.game}${p.tiebreak ? ' tiebreak' : ''}, ${team}, ${p.cause === 'disconnect' ? 'disconnect' : 'technical'}${p.reason !== null ? `: "${p.reason}"` : ''}${p.byName ? ` by ${p.byName}` : ''}${flag}`}
                  {p.penalty !== null
                    ? ` (${p.penalty === 'warning' ? 'warned' : 'game forfeited'}${p.penaltyNote ? `: ${p.penaltyNote}` : ''})`
                    : canRule && (
                      <>
                        {' '}
                        <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.techPenaltyEventMatch(eventId, m.id, p.id, 'warning'),
                          { title: `Warn ${team} over this technical pause?`, body: 'Both teams get a DM, and it is kept on the match log.', confirmLabel: 'Warn' })}>Warn</button>
                        {p.live && (
                          <>
                            {' '}
                            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.techPenaltyEventMatch(eventId, m.id, p.id, 'forfeit'),
                              { title: `${team} forfeits this game?`, body: 'The server ends the game now as a forfeit by this team; the series records it like a !gg. Both teams get a DM.', confirmLabel: 'Forfeit the game', danger: true })}>Forfeit the game</button>
                          </>
                        )}
                      </>
                    )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </details>
  );
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
      <DeskLine m={m} />
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
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.resetEventRoom(eventId, m.id), BOOKED.has(m.phase)
            ? { title: 'Reset the room?', body: 'This cancels the match\'s server booking and aborts any game on it.' }
            : { title: 'Reset this match room?', body: 'Ready, veto and lineups are cleared and the room opens again.' })}>{`Reset room: ${names}`}</button>
          {m.phase !== 'hold' && !holding && (
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => setHolding(true)}>{`Hold: ${names}`}</button>
          )}
          {m.phase !== 'hold' && holding && (
            <HoldForm eventId={eventId} m={m} run={run} busy={busy} onDone={() => setHolding(false)} />
          )}
        </>
      )}
      {editable && m.desk && (ROOM_LIVE.has(m.phase) || m.phase === 'waiting' || (finished(m) && m.desk.pauses.length > 0)) && <DeskTools eventId={eventId} m={m} run={run} busy={busy} />}
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
    <Panel class="playpanel">
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
