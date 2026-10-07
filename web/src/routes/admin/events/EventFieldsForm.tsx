import { useId, useState } from 'preact/hooks';
import type { EntryKind, EventFields, EventStatus, RosterLock } from '../../../api';
import { fromLocalInput, toLocalInput } from '../../../eventFormat';
import { RichText } from '../../../components/RichText';
import { readWhole } from './wholeNumber';
import { FormGroup, FormRow, ToggleRow } from './FormRow';

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
  const [closeAt, setCloseAt] = useState(fields.draft ? toLocalInput(fields.draft.signupsCloseAt) : '');
  const [draftAt, setDraftAt] = useState(fields.draft ? toLocalInput(fields.draft.draftAt) : '');
  const [typed, setTyped] = useState<Record<NumKey, string>>(() => typedOf(fields));
  const typeInto = (k: NumKey) => (e: Event) => { const v = val(e); setTyped((x) => ({ ...x, [k]: v })); };
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
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
    // The two draft times follow the same untouched-input rule as startsAt.
    let draft: EventFields['draft'] = null;
    if (f.entryKind === 'draft') {
      const close = fields.draft && closeAt === toLocalInput(fields.draft.signupsCloseAt) ? fields.draft.signupsCloseAt : fromLocalInput(closeAt);
      const night = fields.draft && draftAt === toLocalInput(fields.draft.draftAt) ? fields.draft.draftAt : fromLocalInput(draftAt);
      if (!close) { setProblem('Pick when signups close.'); return; }
      if (!night) { setProblem('Pick the draft night.'); return; }
      draft = { signupsCloseAt: close, draftAt: night };
    }
    const used: NumKey[] = [...(f.entryKind === 'draft' ? [] : ['teamCap' as const]), 'minPugs', 'srFloor', 'srCeiling', 'maxSubs', 'maxAdditions',
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
      ...f, startsAt, draft, teamCap: n.teamCap ?? null,
      eligibility: { ...f.eligibility, minPugs: whole('minPugs'), srFloor: n.srFloor ?? null, srCeiling: n.srCeiling ?? null },
      checkin: f.checkin.enabled ? { ...f.checkin, opensMinutes: whole('opensMinutes'), closesMinutes: whole('closesMinutes') } : f.checkin,
      roster: { ...f.roster, maxSubs: whole('maxSubs'), maxAdditions: n.maxAdditions ?? null, lock: rosterLock },
    });
  };

  return (
    <form class="eventform" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <FormRow label="Name" help="Shown on /events and the event page." for={id('name')}>
        <input id={id('name')} aria-label="Name" value={f.name} maxLength={60} onInput={(e) => set({ name: val(e) })} />
      </FormRow>
      <FormRow label="Starts at" help="In your own time zone." for={id('start')}>
        <input id={id('start')} aria-label="Starts at" type="datetime-local" value={start} onInput={(e) => setStart(val(e))} />
      </FormRow>
      <FormRow label="Entries" help={status === 'draft' ? 'Teams sign up as rosters, or players sign up alone for a draft.' : 'Fixed once the event is published.'} for={id('kind')}>
        <select id={id('kind')} aria-label="Entry kind" value={f.entryKind} disabled={status !== 'draft'} onChange={(e) => set({ entryKind: (e.target as HTMLSelectElement).value as EntryKind })}>
          <option value="team">Teams register</option>
          <option value="draft">Draft (individual signups)</option>
        </select>
      </FormRow>
      {f.entryKind === 'draft' && (
        <>
          <FormRow label="Signups close" help="When signups close and staff can run the cut." for={id('close')}>
            <input id={id('close')} aria-label="Signups close" type="datetime-local" value={closeAt} onInput={(e) => setCloseAt(val(e))} />
          </FormRow>
          <FormRow label="Draft night" help="When teams are made, by SR balance or a live captains' draft. Everyone gets this time in their role DM." for={id('draftat')}>
            <input id={id('draftat')} aria-label="Draft night" type="datetime-local" value={draftAt} onInput={(e) => setDraftAt(val(e))} />
          </FormRow>
        </>
      )}
      <ToggleRow label="Official event" help="A Riverside event, not a community one." checked={f.official} onChange={() => set({ official: !f.official })} />
      {f.entryKind !== 'draft' && (
        <FormRow label="Team cap" help="Most teams that can register. Blank for no cap." for={id('cap')}>
          <input id={id('cap')} aria-label="Team cap" type="number" min={2} max={256} value={typed.teamCap} onInput={typeInto('teamCap')} />
        </FormRow>
      )}
      <FormGroup title="Description">
        <FormRow wide label="Event page text" help="# heading, **bold**, *italic*, - list, [text](https://...)" for={id('desc')}
          aside={<button type="button" class="btn btn--ghost btn--sm" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>}>
          {preview
            ? <div class="eventdesc-preview"><RichText text={f.description} /></div>
            : <textarea id={id('desc')} aria-label="Description" maxLength={4000} value={f.description} onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} />}
        </FormRow>
      </FormGroup>
      <FormGroup title="Eligibility">
        <FormRow label="Minimum completed PUGs" help="Ranked PUGs a player must have finished to sign up." for={id('minpugs')}>
          <input id={id('minpugs')} aria-label="Minimum completed PUGs" type="number" min={0} max={1000} value={typed.minPugs} onInput={typeInto('minPugs')} />
        </FormRow>
        <ToggleRow label="Discord linked" help="Players need a linked Discord account." checked={f.eligibility.requireDiscord} onChange={() => elig({ requireDiscord: !f.eligibility.requireDiscord })} />
        <FormRow label="SR floor" help="Lowest SR that can sign up. Blank for none." for={id('floor')}>
          <input id={id('floor')} aria-label="SR floor" type="number" min={0} value={typed.srFloor} onInput={typeInto('srFloor')} />
        </FormRow>
        <FormRow label="SR ceiling" help="Highest SR that can sign up. Blank for none." for={id('ceiling')}>
          <input id={id('ceiling')} aria-label="SR ceiling" type="number" min={0} value={typed.srCeiling} onInput={typeInto('srCeiling')} />
        </FormRow>
      </FormGroup>
      <FormGroup title="Check-in">
        <ToggleRow label="Check-in" help="Entries confirm they are present before the start." ariaLabel="Check-in on" checked={f.checkin.enabled} onChange={() => checkin({ enabled: !f.checkin.enabled })} />
        {f.checkin.enabled && (
          <>
            <FormRow label="Opens" help="Minutes before the start. (10 to 1440)" for={id('opens')}>
              <input id={id('opens')} aria-label="Check-in opens" type="number" min={10} max={1440} value={typed.opensMinutes} onInput={typeInto('opensMinutes')} />
            </FormRow>
            <FormRow label="Closes" help="Minutes before the start. (0 to 1435)" for={id('closes')}>
              <input id={id('closes')} aria-label="Check-in closes" type="number" min={0} max={1435} value={typed.closesMinutes} onInput={typeInto('closesMinutes')} />
            </FormRow>
          </>
        )}
      </FormGroup>
      <FormGroup title="Rosters">
        <FormRow label="Max subs" help="Substitutes on top of the 4 starters. (0 to 4)" for={id('subs')}>
          <input id={id('subs')} aria-label="Max subs" type="number" min={0} max={4} value={typed.maxSubs} onInput={typeInto('maxSubs')} />
        </FormRow>
        <FormRow label="Roster lock" help="When teams can no longer change their rosters." for={id('lock')}>
          <select id={id('lock')} aria-label="Roster lock" value={lock.kind} onChange={(e) => setLockKind((e.target as HTMLSelectElement).value as RosterLock['kind'])}>
            <option value="none">No lock</option>
            <option value="at">At a time</option>
            <option value="after_round">After a round</option>
          </select>
        </FormRow>
        {lock.kind === 'at' && (
          <FormRow label="Lock at" help="In your own time zone." for={id('lockat')}>
            <input id={id('lockat')} aria-label="Lock at" type="datetime-local" value={lockAt} onInput={(e) => setLockAt(val(e))} />
          </FormRow>
        )}
        {lock.kind === 'after_round' && (
          <>
            <FormRow label="After stage" help="The stage whose round locks the rosters. (1 to 5)" for={id('lstage')}>
              <input id={id('lstage')} aria-label="Lock after stage" type="number" min={1} max={5} value={typed.lockStage} onInput={typeInto('lockStage')} />
            </FormRow>
            <FormRow label="Round" help="Rosters lock once this round is over. (1 to 20)" for={id('lround')}>
              <input id={id('lround')} aria-label="Lock after round" type="number" min={1} max={20} value={typed.lockRound} onInput={typeInto('lockRound')} />
            </FormRow>
          </>
        )}
        <FormRow label="Max roster additions" help="Players a team can add before the lock. Blank for no limit." for={id('adds')}>
          <input id={id('adds')} aria-label="Max roster additions" type="number" min={0} max={20} value={typed.maxAdditions} onInput={typeInto('maxAdditions')} />
        </FormRow>
      </FormGroup>
      <div class="eventform__actions">
        <button class="btn" type="submit" disabled={busy}>Save event</button>
      </div>
    </form>
  );
}
