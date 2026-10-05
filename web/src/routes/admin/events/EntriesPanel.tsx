import { useState } from 'preact/hooks';
import { adminApi, type AdminEntryView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction } from '../useAction';

const DROP: Record<string, string> = {
  withdrawn: 'withdrawn', no_checkin: 'did not check in', over_cap: 'over the cap', incomplete: 'short of 4 starters', team_disbanded: 'team disbanded',
};
const ROLE: Record<string, string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach' };

function statusText(e: AdminEntryView): string {
  if (e.status === 'dropped') return `Dropped (${DROP[e.dropReason ?? ''] ?? 'dropped'})`;
  if (e.status === 'disqualified') return 'Disqualified';
  if (e.status === 'checked_in') return 'Checked in';
  return e.waitlist !== null ? `Waitlist ${e.waitlist}` : 'Registered';
}

/** The event is past seeding entirely once it is live, finished or
 *  cancelled; the server's reorderSeeds already refuses those with
 *  `seeds_locked`, so the Up/Down controls are not offered then either. */
const SEEDS_CLOSED: readonly string[] = ['live', 'finished', 'cancelled'];

/** One entry's row. Its own component so the Disqualify reason box is this
 *  row's state alone, never shared with any other row's box or send. */
function EntryRow({ e, canEdit, locked, showMove, canRestore, busy, active, onMove, onDisqualify, onRestore }: {
  e: AdminEntryView; canEdit: boolean; locked: boolean; showMove: boolean; canRestore: boolean; busy: boolean; active: boolean;
  onMove: (id: number, by: -1 | 1) => void; onDisqualify: (id: number, name: string, reason: string) => void; onRestore: (id: number, name: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <li class={active ? '' : 'muted'}>
      <strong>{e.seed !== null && active ? `#${e.seed} ` : ''}{e.name}</strong> <span class="muted">[{e.tag}]</span>
      {' '}· {statusText(e)} · SR {e.sr} · by {e.registeredByName}
      <ul class="entrypanel__roster">
        {e.roster.map((p) => (
          <li key={p.steamid}><span class="chip">{ROLE[p.role]}</span> {p.name}{p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}</li>
        ))}
      </ul>
      {canEdit && (
        <div class="inlinerow">
          {showMove && locked && active && e.seed !== null && (
            <>
              <button class="btn btn--ghost" aria-label={`Move ${e.name} up`} disabled={busy} onClick={() => onMove(e.id, -1)}>Up</button>
              <button class="btn btn--ghost" aria-label={`Move ${e.name} down`} disabled={busy} onClick={() => onMove(e.id, 1)}>Down</button>
            </>
          )}
          {active && (
            <>
              <input type="text" placeholder="Reason" value={reason} onInput={(ev) => setReason((ev.target as HTMLInputElement).value)} />
              <button class="btn btn--ghost" disabled={busy} onClick={() => onDisqualify(e.id, e.name, reason)}>Disqualify</button>
            </>
          )}
          {!active && canRestore && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => onRestore(e.id, e.name)}>Restore</button>
          )}
        </div>
      )}
    </li>
  );
}

/** The Entries section of an event on the desk (plan T1b Ruling 10). A mod
 *  (canEdit false) reads the same list with no control. Each button shows
 *  only where the server would take it: Open check-in in registration with
 *  check-in on; Close the list in the phase the clock would close it from
 *  (check-in, or registration with check-in off); Restore before the list is
 *  final in registration or check-in. */
export function EntriesPanel({ eventId, status, checkin, canEdit }: { eventId: number; status: string; checkin: boolean; canEdit: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventEntries(eventId, s), [eventId]);
  const { busy, error, run } = useAction(reload);
  if (loadError) return <Panel><h3>Entries</h3><p class="error">Could not load the entries.</p></Panel>;
  if (!data) return <Panel><h3>Entries</h3></Panel>;
  const locked = data.lockedAt !== null;
  const showMove = !SEEDS_CLOSED.includes(status);
  const canOpenCheckin = checkin && status === 'registration';
  const canClose = status === (checkin ? 'checkin' : 'registration');
  const canRestore = !locked && (status === 'registration' || status === 'checkin');
  const seeded = data.entries.filter((e) => e.seed !== null && (e.status === 'registered' || e.status === 'checked_in'))
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
  const move = (id: number, by: -1 | 1) => {
    const order = seeded.map((e) => e.id);
    const i = order.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(() => adminApi.reorderEventSeeds(eventId, order));
  };
  const disqualify = (id: number, name: string, reason: string) => void run(() => adminApi.disqualifyEventEntry(eventId, id, reason), `Disqualify ${name}?`);
  const restore = (id: number, name: string) => void run(() => adminApi.restoreEventEntry(eventId, id), `Restore ${name}?`);
  const active = (e: AdminEntryView) => e.status !== 'dropped' && e.status !== 'disqualified';
  return (
    <Panel>
      <h3>Entries</h3>
      {canEdit && !locked && (
        <div class="inlinerow">
          {canOpenCheckin && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.openEventCheckin(eventId), 'Open check-in now?')}>Open check-in now</button>
          )}
          {canClose && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.lockEventEntries(eventId), {
              title: 'Close the entry list now?', body: 'Entries that are not ready are dropped, the waitlist is cut at the cap, and seeds are set by SR.',
            })}>Close the entry list now</button>
          )}
        </div>
      )}
      {locked && <p class="muted">The entry list is final. Seeds can be reordered until the event goes live.</p>}
      {error && <p class="error" role="alert">{error}</p>}
      {data.entries.length === 0 ? <Empty>No entries yet.</Empty> : (
        <ul class="admin-list">
          {data.entries.map((e) => (
            <EntryRow key={e.id} e={e} canEdit={canEdit} locked={locked} showMove={showMove} canRestore={canRestore} busy={busy} active={active(e)}
              onMove={move} onDisqualify={disqualify} onRestore={restore} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
