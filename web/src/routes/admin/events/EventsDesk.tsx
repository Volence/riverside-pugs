import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, type EntryKind } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { STATUS_LABEL, fromLocalInput, whenText } from '../../../eventFormat';
import { useAction } from '../useAction';
import { eventAdminUrl } from '../adminRoutes';

/** The Events desk front page: a new draft (admins), and every event so far.
 *  A mod reads the list only (Ruling 2). */
export function EventsDesk({ canEdit }: { canEdit: boolean }) {
  const { route } = useLocation();
  const { data, reload } = useFetch((s) => adminApi.events(s), []);
  const { busy, error, run } = useAction(reload);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [kind, setKind] = useState<EntryKind>('team');
  const [problem, setProblem] = useState<string | null>(null);

  const create = (e: Event) => {
    e.preventDefault();
    const startsAt = fromLocalInput(start);
    if (!startsAt) { setProblem('Pick a start time.'); return; }
    setProblem(null);
    void run(async () => {
      const r = await adminApi.createEvent({ name, startsAt, entryKind: kind });
      route(eventAdminUrl(r.id));
    });
  };

  return (
    <div class="stack">
      {canEdit && (
      <Panel>
        <h3>New event</h3>
        <p class="muted">It starts as a draft only admins can see. Add its stages, then publish it.</p>
        {(problem ?? error) && <p class="error" role="alert">{problem ?? error}</p>}
        <form class="admin-form admin-form--stack" onSubmit={create}>
          <label class="teamfield">Name
            <input aria-label="Name" value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <label class="teamfield">Starts at (your time)
            <input aria-label="Starts at" type="datetime-local" value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
          </label>
          <label class="teamfield">Entries
            <select aria-label="Entry kind" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as EntryKind)}>
              <option value="team">Teams register</option>
              <option value="draft">Draft (individual signups)</option>
            </select>
          </label>
          <button class="btn" type="submit" disabled={busy || !name.trim()}>Create draft</button>
        </form>
      </Panel>
      )}
      <Panel>
        <h3>All events</h3>
        {!data ? <p class="muted">Loading...</p> : data.events.length === 0 ? <Empty>No events yet.</Empty> : (
          <ul class="admin-list">
            {data.events.map((ev) => (
              <li key={ev.id}>
                <a href={eventAdminUrl(ev.id)}><strong>{ev.name}</strong></a>{' '}
                <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>{' '}
                <span class="muted">· {whenText(ev.startsAt)} · {ev.stages} stage{ev.stages === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
