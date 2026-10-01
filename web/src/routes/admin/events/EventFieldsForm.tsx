import { useState } from 'preact/hooks';
import type { EntryKind, EventFields, EventStatus, RosterLock } from '../../../api';
import { fromLocalInput, toLocalInput } from '../../../eventFormat';
import { RichText } from '../../../components/RichText';
import { readWhole } from './wholeNumber';

const val = (e: Event): string => (e.target as HTMLInputElement).value;

/** The number fields, kept as typed and read only at Save (wholeNumber.ts).
 *  Blank means "not set" for the four whose null means that. */
type NumKey = 'teamCap' | 'minPugs' | 'srFloor' | 'srCeiling' | 'opensMinutes' | 'closesMinutes' | 'maxSubs' | 'lockStage' | 'lockRound' | 'maxAdditions';
const NUM_LABEL: Record<NumKey, string> = {
  teamCap: 'Team cap', minPugs: 'Minimum completed PUGs', srFloor: 'SR floor', srCeiling: 'SR ceiling',
  opensMinutes: 'Check-in opens', closesMinutes: 'Check-in closes', maxSubs: 'Max subs',
  lockStage: 'Lock after stage', lockRound: 'Lock after round', maxAdditions: 'Max roster additions',
};
const BLANK_IS_NONE: ReadonlySet<NumKey> = new Set<NumKey>(['teamCap', 'srFloor', 'srCeiling', 'maxAdditions']);
const str = (n: number | null): string => (n === null ? '' : String(n));
function typedOf(f: EventFields): Record<NumKey, string> {
  const lock = f.roster.lock;
  return {
    teamCap: str(f.teamCap), minPugs: str(f.eligibility.minPugs), srFloor: str(f.eligibility.srFloor), srCeiling: str(f.eligibility.srCeiling),
    opensMinutes: str(f.checkin.opensMinutes), closesMinutes: str(f.checkin.closesMinutes), maxSubs: str(f.roster.maxSubs),
    lockStage: lock.kind === 'after_round' ? String(lock.stage) : '1', lockRound: lock.kind === 'after_round' ? String(lock.round) : '1',
    maxAdditions: str(f.roster.maxAdditions),
  };
}

/** The event's own settings. Times are typed in the admin's zone and sent as
 *  UTC (Ruling 11); the server checks every range. The editor keys it by the
 *  event id and remounts it only after its own successful save, so a banner
 *  upload or a stage change that reloads the event keeps unsaved typing. */
export function EventFieldsForm({ fields, status, busy, onSave }: {
  fields: EventFields; status: EventStatus; busy: boolean; onSave: (f: EventFields) => void;
}) {
  const [f, setF] = useState<EventFields>(fields);
  const [start, setStart] = useState(toLocalInput(fields.startsAt));
  const [lockAt, setLockAt] = useState(fields.roster.lock.kind === 'at' ? toLocalInput(fields.roster.lock.at) : '');
  /** The instant the lock input was filled from, and how it read then: an
   *  untouched input sends that instant back, not a DST round-trip of it. */
  const [lockFrom, setLockFrom] = useState(fields.roster.lock.kind === 'at'
    ? { local: toLocalInput(fields.roster.lock.at), iso: fields.roster.lock.at } : null);
  const [typed, setTyped] = useState<Record<NumKey, string>>(() => typedOf(fields));
  const typeInto = (k: NumKey) => (e: Event) => { const v = val(e); setTyped((x) => ({ ...x, [k]: v })); };
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const set = (patch: Partial<EventFields>) => setF((x) => ({ ...x, ...patch }));
  const elig = (patch: Partial<EventFields['eligibility']>) => set({ eligibility: { ...f.eligibility, ...patch } });
  const checkin = (patch: Partial<EventFields['checkin']>) => set({ checkin: { ...f.checkin, ...patch } });
  const roster = (patch: Partial<EventFields['roster']>) => set({ roster: { ...f.roster, ...patch } });
  const lock = f.roster.lock;
  const setLockKind = (kind: RosterLock['kind']) => {
    if (kind === 'at' && !lockAt) {
      setLockAt(toLocalInput(f.startsAt));
      setLockFrom({ local: toLocalInput(f.startsAt), iso: f.startsAt });
    }
    roster({ lock: kind === 'none' ? { kind } : kind === 'at' ? { kind, at: f.startsAt } : { kind, stage: 1, round: 1 } });
  };

  const submit = (e: Event) => {
    e.preventDefault();
    // Only re-derive startsAt from the input when it was actually touched.
    // fromLocalInput(toLocalInput(x)) is not always x: a stored time that
    // falls in a DST fall-back repeated hour round-trips to the EARLIER of
    // the two instants, so re-sending it on every unrelated save would walk
    // the event's start back an hour each time. Untouched, the stored ISO is
    // sent back exactly as it came.
    const startsAt = start === toLocalInput(fields.startsAt) ? fields.startsAt : fromLocalInput(start);
    if (!startsAt) { setProblem('Pick a start time.'); return; }
    const used: NumKey[] = ['teamCap', 'minPugs', 'srFloor', 'srCeiling', 'maxSubs', 'maxAdditions',
      ...(f.checkin.enabled ? ['opensMinutes' as const, 'closesMinutes' as const] : []),
      ...(lock.kind === 'after_round' ? ['lockStage' as const, 'lockRound' as const] : [])];
    const n: Partial<Record<NumKey, number | null>> = {};
    for (const k of used) {
      const r = readWhole(typed[k], NUM_LABEL[k], BLANK_IS_NONE.has(k));
      if (!r.ok) { setProblem(r.error); return; }
      n[k] = r.value;
    }
    const whole = (k: NumKey): number => n[k] as number;
    let rosterLock: RosterLock = lock;
    if (lock.kind === 'at') {
      // Same rule as the start time, for the same DST reason.
      const at = lockFrom && lockAt === lockFrom.local ? lockFrom.iso : fromLocalInput(lockAt);
      if (!at) { setProblem('Pick when the rosters lock.'); return; }
      rosterLock = { kind: 'at', at };
    } else if (lock.kind === 'after_round') {
      rosterLock = { kind: 'after_round', stage: whole('lockStage'), round: whole('lockRound') };
    }
    setProblem(null);
    onSave({
      ...f, startsAt, teamCap: n.teamCap ?? null,
      eligibility: { ...f.eligibility, minPugs: whole('minPugs'), srFloor: n.srFloor ?? null, srCeiling: n.srCeiling ?? null },
      checkin: f.checkin.enabled ? { ...f.checkin, opensMinutes: whole('opensMinutes'), closesMinutes: whole('closesMinutes') } : f.checkin,
      roster: { ...f.roster, maxSubs: whole('maxSubs'), maxAdditions: n.maxAdditions ?? null, lock: rosterLock },
    });
  };

  return (
    <form class="admin-form admin-form--stack" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <label class="teamfield">Name<input aria-label="Name" value={f.name} maxLength={60} onInput={(e) => set({ name: val(e) })} /></label>
      <label class="teamfield">Starts at (your time)<input aria-label="Starts at" type="datetime-local" value={start} onInput={(e) => setStart(val(e))} /></label>
      <label class="teamfield">Entries
        <select aria-label="Entry kind" value={f.entryKind} disabled={status !== 'draft'} onChange={(e) => set({ entryKind: (e.target as HTMLSelectElement).value as EntryKind })}>
          <option value="team">Teams register</option>
          <option value="draft">Draft (individual signups)</option>
        </select>
      </label>
      <label><input type="checkbox" aria-label="Official event" checked={f.official} onChange={() => set({ official: !f.official })} /> Official event</label>
      <label class="teamfield">Team cap (blank for none)
        <input aria-label="Team cap" type="number" min={2} max={256} value={typed.teamCap} onInput={typeInto('teamCap')} />
      </label>
      <div class="teamfield">
        <span class="inlinerow">
          Description (# heading, **bold**, *italic*, - list, [text](https://...))
          <button type="button" class="btn btn--ghost btn--sm" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
        </span>
        {preview
          ? <div class="eventdesc-preview"><RichText text={f.description} /></div>
          : <textarea aria-label="Description" maxLength={4000} value={f.description} onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} />}
      </div>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Eligibility</legend>
        <label class="teamfield">Minimum completed PUGs
          <input aria-label="Minimum completed PUGs" type="number" min={0} max={1000} value={typed.minPugs} onInput={typeInto('minPugs')} />
        </label>
        <label><input type="checkbox" aria-label="Discord linked" checked={f.eligibility.requireDiscord} onChange={() => elig({ requireDiscord: !f.eligibility.requireDiscord })} /> Discord linked</label>
        <label class="teamfield">SR floor (blank for none)
          <input aria-label="SR floor" type="number" min={0} value={typed.srFloor} onInput={typeInto('srFloor')} />
        </label>
        <label class="teamfield">SR ceiling (blank for none)
          <input aria-label="SR ceiling" type="number" min={0} value={typed.srCeiling} onInput={typeInto('srCeiling')} />
        </label>
      </fieldset>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Check-in</legend>
        <label><input type="checkbox" aria-label="Check-in on" checked={f.checkin.enabled} onChange={() => checkin({ enabled: !f.checkin.enabled })} /> Check-in on</label>
        {f.checkin.enabled && (
          <>
            <label class="teamfield">Opens (minutes before the start)
              <input aria-label="Check-in opens" type="number" min={10} max={1440} value={typed.opensMinutes} onInput={typeInto('opensMinutes')} />
            </label>
            <label class="teamfield">Closes (minutes before the start)
              <input aria-label="Check-in closes" type="number" min={0} max={1435} value={typed.closesMinutes} onInput={typeInto('closesMinutes')} />
            </label>
          </>
        )}
      </fieldset>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Rosters (4 starters)</legend>
        <label class="teamfield">Max subs
          <input aria-label="Max subs" type="number" min={0} max={4} value={typed.maxSubs} onInput={typeInto('maxSubs')} />
        </label>
        <label class="teamfield">Roster lock
          <select aria-label="Roster lock" value={lock.kind} onChange={(e) => setLockKind((e.target as HTMLSelectElement).value as RosterLock['kind'])}>
            <option value="none">No lock</option>
            <option value="at">At a time</option>
            <option value="after_round">After a round</option>
          </select>
        </label>
        {lock.kind === 'at' && (
          <label class="teamfield">Lock at (your time)<input aria-label="Lock at" type="datetime-local" value={lockAt} onInput={(e) => setLockAt(val(e))} /></label>
        )}
        {lock.kind === 'after_round' && (
          <>
            <label class="teamfield">After stage
              <input aria-label="Lock after stage" type="number" min={1} max={5} value={typed.lockStage} onInput={typeInto('lockStage')} />
            </label>
            <label class="teamfield">Round
              <input aria-label="Lock after round" type="number" min={1} max={20} value={typed.lockRound} onInput={typeInto('lockRound')} />
            </label>
          </>
        )}
        <label class="teamfield">Max roster additions before the lock (blank for no limit)
          <input aria-label="Max roster additions" type="number" min={0} max={20} value={typed.maxAdditions} onInput={typeInto('maxAdditions')} />
        </label>
      </fieldset>
      <button class="btn" type="submit" disabled={busy}>Save event</button>
    </form>
  );
}
