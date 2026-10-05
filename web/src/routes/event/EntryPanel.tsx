import { useState } from 'preact/hooks';
import { ApiError, eventsApi, type EntryRoster, type MyEntryView, type MyEventView, type RegisterOptionView } from '../../api';
import { Panel } from '../../components/bits';
import { confirm } from '../../components/Confirm';
import { RosterPicker, defaultRoster } from './RosterPicker';

const ROLE: Record<string, string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach' };

/** The server's sentence, then one line per named player (Task 6). */
function errorLines(err: unknown): string[] {
  if (!(err instanceof ApiError)) return ['Something went wrong.'];
  return [err.message, ...(err.problems ?? []).map((p) => `${p.name}: ${p.problems.join(', ')}`)];
}

function useSubmit(onChange: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError([]);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorLines(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Errors({ lines }: { lines: string[] }) {
  return lines.length ? <div class="error" role="alert">{lines.map((l) => <p key={l}>{l}</p>)}</div> : null;
}

function Register({ slug, team, maxSubs, onChange }: { slug: string; team: RegisterOptionView; maxSubs: number; onChange: () => void }) {
  const [roster, setRoster] = useState<EntryRoster>(() => defaultRoster(team.members));
  const { busy, error, run } = useSubmit(onChange);
  return (
    <div class="entrypanel__team">
      <h4>{team.name} <span class="muted">[{team.tag}]</span></h4>
      <RosterPicker members={team.members} roster={roster} maxSubs={maxSubs} onChange={setRoster} />
      <Errors lines={error} />
      <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.register(slug, team.teamId, roster))}>Register {team.name}</button>
    </div>
  );
}

function statusLine(e: MyEntryView): string {
  if (e.status === 'checked_in') return 'Checked in';
  if (e.waitlist !== null) return `Waitlist, number ${e.waitlist}`;
  if (e.seed !== null) return `Seed ${e.seed}`;
  return 'Registered';
}

function MyEntry({ slug, entry, maxSubs, onChange }: { slug: string; entry: MyEntryView; maxSubs: number; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [roster, setRoster] = useState<EntryRoster>(() => ({
    starters: entry.roster.filter((p) => p.role === 'starter').map((p) => p.steamid),
    subs: entry.roster.filter((p) => p.role === 'sub').map((p) => p.steamid),
    coach: entry.roster.find((p) => p.role === 'coach')?.steamid ?? null,
  }));
  const { busy, error, run } = useSubmit(() => { setEditing(false); onChange(); });
  return (
    <div class="entrypanel__team">
      <h4>{entry.name} <span class="muted">[{entry.tag}]</span> <span class="teamchip">{statusLine(entry)}</span></h4>
      {editing ? (
        <RosterPicker members={entry.members} roster={roster} maxSubs={maxSubs} onChange={setRoster} />
      ) : (
        <ul class="entrypanel__roster">
          {entry.roster.map((p) => (
            <li key={p.steamid}>
              <span class="chip">{ROLE[p.role]}</span> {p.name}
              {p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}
            </li>
          ))}
        </ul>
      )}
      {entry.rosterLocked && <p class="muted">Rosters are locked; staff can still change yours.</p>}
      {entry.additionsLeft !== null && <p class="muted">{entry.additionsLeft} roster addition{entry.additionsLeft === 1 ? '' : 's'} left.</p>}
      <Errors lines={error} />
      <div class="inlinerow">
        {entry.canCheckIn && <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.checkIn(slug, entry.id))}>Check in</button>}
        {entry.canEditRoster && !editing && <button class="btn btn--ghost" onClick={() => setEditing(true)}>Edit roster</button>}
        {editing && <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.setRoster(slug, entry.id, roster))}>Save roster</button>}
        {editing && <button class="btn btn--ghost" onClick={() => setEditing(false)}>Cancel</button>}
        {entry.canLeave && !editing && (
          <button class="btn btn--ghost" disabled={busy} onClick={async () => {
            if (await confirm({ title: 'Leave this roster?', body: `You will no longer play for ${entry.name} in this event.`, confirmLabel: 'Leave roster' })) {
              void run(() => eventsApi.leave(slug, entry.id));
            }
          }}>Leave roster</button>
        )}
        {entry.canWithdraw && !editing && (
          <button class="btn btn--ghost" disabled={busy} onClick={async () => {
            if (await confirm({ title: `Withdraw ${entry.name}?`, body: 'The team leaves the event. You can register again while registration is open, at the back of the list.', confirmLabel: 'Withdraw' })) {
              void run(() => eventsApi.withdraw(slug, entry.id));
            }
          }}>Withdraw</button>
        )}
      </div>
    </div>
  );
}

/** The viewer's part of the event page (plan T1b): their entries, then the
 *  teams they could register. Nothing at all when there is neither. */
export function EntryPanel({ slug, view, maxSubs, onChange }: { slug: string; view: MyEventView; maxSubs: number; onChange: () => void }) {
  if (view.entries.length === 0 && view.register.length === 0) return null;
  return (
    <Panel class="entrypanel">
      <h3>{view.entries.length ? 'Your entry' : 'Register your team'}</h3>
      {view.entries.map((e) => <MyEntry key={e.id} slug={slug} entry={e} maxSubs={maxSubs} onChange={onChange} />)}
      {view.register.map((t) => <Register key={t.teamId} slug={slug} team={t} maxSubs={maxSubs} onChange={onChange} />)}
    </Panel>
  );
}
