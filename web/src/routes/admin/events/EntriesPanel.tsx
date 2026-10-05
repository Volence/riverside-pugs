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

/** The Entries section of an event on the desk (plan T1b Ruling 10). A mod
 *  (canEdit false) reads the same list with no control. */
export function EntriesPanel({ eventId, status, canEdit }: { eventId: number; status: string; canEdit: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventEntries(eventId, s), [eventId]);
  const { busy, error, run } = useAction(reload);
  const [reason, setReason] = useState('');
  if (loadError) return <Panel><h3>Entries</h3><p class="error">Could not load the entries.</p></Panel>;
  if (!data) return <Panel><h3>Entries</h3></Panel>;
  const locked = data.lockedAt !== null;
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
  const active = (e: AdminEntryView) => e.status !== 'dropped' && e.status !== 'disqualified';
  return (
    <Panel>
      <h3>Entries</h3>
      {canEdit && !locked && (
        <div class="inlinerow">
          {status === 'registration' && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.openEventCheckin(eventId), 'Open check-in now?')}>Open check-in now</button>
          )}
          {(status === 'registration' || status === 'checkin') && (
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
            <li key={e.id} class={active(e) ? '' : 'muted'}>
              <strong>{e.seed !== null && active(e) ? `#${e.seed} ` : ''}{e.name}</strong> <span class="muted">[{e.tag}]</span>
              {' '}· {statusText(e)} · SR {e.sr} · by {e.registeredByName}
              <ul class="entrypanel__roster">
                {e.roster.map((p) => (
                  <li key={p.steamid}><span class="chip">{ROLE[p.role]}</span> {p.name}{p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}</li>
                ))}
              </ul>
              {canEdit && (
                <div class="inlinerow">
                  {locked && active(e) && e.seed !== null && (
                    <>
                      <button class="btn btn--ghost" aria-label={`Move ${e.name} up`} disabled={busy} onClick={() => move(e.id, -1)}>Up</button>
                      <button class="btn btn--ghost" aria-label={`Move ${e.name} down`} disabled={busy} onClick={() => move(e.id, 1)}>Down</button>
                    </>
                  )}
                  {active(e) && (
                    <>
                      <input type="text" placeholder="Reason" value={reason} onInput={(ev) => setReason((ev.target as HTMLInputElement).value)} />
                      <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.disqualifyEventEntry(eventId, e.id, reason), `Disqualify ${e.name}?`)}>Disqualify</button>
                    </>
                  )}
                  {!active(e) && !locked && (
                    <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.restoreEventEntry(eventId, e.id), `Restore ${e.name}?`)}>Restore</button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
