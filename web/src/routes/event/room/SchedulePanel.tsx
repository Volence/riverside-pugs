import { useState } from 'preact/hooks';
import type { MatchRoomView, RoomProposal } from '../../../api';
import { fromLocalInput, whenText } from '../../../eventFormat';

const STATUS_TEXT: Record<RoomProposal['status'], string> = {
  open: 'open', accepted: 'accepted', auto_accepted: 'locked with no answer', declined: 'declined', countered: 'countered', withdrawn: 'withdrawn', expired: 'expired',
};

/** The propose or counter form: a local-time input read in the viewer's zone, and a note. */
function TimeForm({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (time: string, note: string) => void; onCancel?: () => void }) {
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const iso = fromLocalInput(time);
  return (
    <form class="inlinerow" onSubmit={(e) => { e.preventDefault(); if (iso) onSubmit(iso, note.trim()); }}>
      <label>Proposed time <input type="datetime-local" aria-label="Proposed time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} /></label>
      <label>Note <input type="text" aria-label="Note" maxLength={300} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
      <button class="btn btn--sm" type="submit" disabled={busy || !iso}>{label}</button>
      {onCancel && <button class="btn btn--ghost btn--sm" type="button" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

/** A window-stage match's schedule (plan T4 Ruling 12): the locked time,
 *  the window, the open proposal and what the viewer may do, the log.
 *  Everything here is public like the veto log: outsiders see the open
 *  proposal and the log, just never a button (the can* flags gate those).
 *  Times are shown in the viewer's zone and entered in it. */
export function SchedulePanel({ v, busy, onPropose, onRespond, onCounter, onWithdraw }: {
  v: MatchRoomView; busy: boolean;
  onPropose: (time: string, note: string) => void; onRespond: (accept: boolean) => void;
  /** May return a success flag, so the counter form only closes once the request actually went through. */
  onCounter: (time: string, note: string) => void | Promise<boolean>; onWithdraw: () => void;
}) {
  const s = v.schedule;
  const [countering, setCountering] = useState(false);
  if (!s) return null;
  const team = (side: 'a' | 'b') => (side === 'a' ? v.a?.name ?? 'Team A' : v.b?.name ?? 'Team B');
  const p = s.proposal;
  const source = s.source === 'agreed' ? 'agreed by the captains' : s.source === 'staff' ? 'set by staff' : 'the round default';
  return (
    <div class="roomschedule">
      {s.scheduledAt
        ? <p><strong>{whenText(s.scheduledAt)}</strong> <span class="muted">({source}; the room opens {s.leadMinutes} minutes before)</span></p>
        : <p>No time is set yet.{s.windowEnd ? (s.canPropose ? ' A captain or co-captain proposes one below.' : '') : " Staff set the round's window first."}</p>}
      {s.windowStart && s.windowEnd && <p class="muted">{`Window: ${whenText(s.windowStart)} to ${whenText(s.windowEnd)}`}</p>}
      {p && (
        <div class="roomschedule__proposal">
          <p>{`${p.byName} (${team(p.side)}) proposes ${whenText(p.time)}${p.note ? ` ("${p.note}")` : ''}.`}
            {p.autoAcceptAt && <span class="muted">{` Unanswered, it locks on ${whenText(p.autoAcceptAt)}.`}</span>}
          </p>
          {s.canAnswer && !countering && (
            <div class="inlinerow">
              <button class="btn btn--sm" type="button" disabled={busy} onClick={() => onRespond(true)}>Accept</button>
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => onRespond(false)}>Decline</button>
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => setCountering(true)}>Counter</button>
            </div>
          )}
          {s.canAnswer && countering && (
            <TimeForm
              label="Counter with this time" busy={busy}
              onSubmit={(t, n) => {
                const result = onCounter(t, n);
                // A real caller returns a promise that resolves to whether the
                // request went through; the form stays open on a rejection or a
                // false so a captain's typed time and note are not lost. A bare
                // void return (no promise, as a test's plain mock gives back)
                // closes it at once, matching the old behaviour.
                if (result && typeof (result as Promise<boolean>).then === 'function') {
                  void (result as Promise<boolean>).then((ok) => { if (ok) setCountering(false); });
                } else {
                  setCountering(false);
                }
              }}
              onCancel={() => setCountering(false)}
            />
          )}
          {s.canWithdraw && <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={onWithdraw}>Withdraw</button>}
        </div>
      )}
      {s.canPropose && <TimeForm label="Propose this time" busy={busy} onSubmit={onPropose} />}
      {s.log.length > 0 && (
        <ol class="room__log">
          {s.log.map((l) => (
            <li key={l.id}>{`${l.byName} (${team(l.side)}) proposed ${whenText(l.time)}: ${STATUS_TEXT[l.status]}${l.respondedByName ? ` by ${l.respondedByName}` : ''}`}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
