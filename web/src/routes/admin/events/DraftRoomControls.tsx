import { useState } from 'preact/hooks';
import { adminApi, type DraftFirstPick, type DraftRoomView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { useHubEvent } from '../../../hooks/useHubEvent';
import { useAction } from '../useAction';

const FIRST_PICK_TEXT: Record<DraftFirstPick, string> = {
  lowest_sr: 'Lowest SR captain first', highest_sr: 'Highest SR captain first', random: 'Random order',
};

/** One line on where the room is. */
export function statusLine(v: DraftRoomView): string {
  if (v.status === 'ready') return 'Ready: captains are building their pick lists.';
  if (v.status === 'paused') return `Paused at pick ${v.picks.length + 1} of ${v.totalPicks}.`;
  if (v.status === 'done') return 'The draft is over. Check the teams below and publish them.';
  if (v.status === 'running' && v.onClock) {
    return `Pick ${v.onClock.pickNo} of ${v.totalPicks}: ${v.order.find((o) => o.steamid === v.onClock!.captain)?.name ?? ''} is on the clock.`;
  }
  return '';
}

/** The live draft room on the desk (drafts plan D2b1 Rulings 5, 6, 13):
 *  settings and Start before the draft, then pause, resume, undo, hand-over
 *  and reset. Admins act (canEdit); a mod reads. Refreshes on draft:<id>. */
export function DraftRoomControls({ eventId, slug, canEdit, onChange }: { eventId: number; slug: string; canEdit: boolean; onChange?: () => void }) {
  const { data: v, error: loadError, reload } = useFetch((s) => adminApi.draftRoom(eventId, s), [eventId]);
  useHubEvent([`draft:${eventId}`], reload);
  const { busy, error, run } = useAction(() => { reload(); onChange?.(); });
  const [firstPick, setFirstPick] = useState<DraftFirstPick | null>(null);
  const [secs, setSecs] = useState<string | null>(null);
  if (loadError) return <p class="error">Could not load the draft room.</p>;
  if (!v) return null;
  const fp = firstPick ?? v.settings.firstPick;
  const sec = secs ?? String(v.settings.pickSeconds);
  const act = (a: 'start' | 'pause' | 'resume' | 'undo' | 'reset', ask?: Parameters<typeof run>[1]) => void run(() => adminApi.draftRoomAct(eventId, a), ask);
  const started = v.status === 'running' || v.status === 'paused' || v.status === 'done';

  return (
    <div class="draftcontrols">
      <p><a href={`/event/${slug}/draft`}>Open the draft room</a></p>
      {error && <p class="error" role="alert">{error}</p>}
      <p>{statusLine(v)}</p>
      {v.status === 'ready' && canEdit && (
        <>
          <div class="inlinerow">
            <label>
              First pick{' '}
              <select value={fp} onChange={(e) => setFirstPick((e.target as HTMLSelectElement).value as DraftFirstPick)}>
                {(Object.keys(FIRST_PICK_TEXT) as DraftFirstPick[]).map((k) => <option key={k} value={k}>{FIRST_PICK_TEXT[k]}</option>)}
              </select>
            </label>
            <label>
              Pick clock (seconds){' '}
              <input type="number" min={30} max={300} value={sec} onInput={(e) => setSecs((e.target as HTMLInputElement).value)} />
            </label>
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.draftRoomSettings(eventId, fp, Number(sec)))}>Save settings</button>
          </div>
          <div class="inlinerow">
            <button class="btn" disabled={busy} onClick={() => act('start', {
              title: 'Start the live draft?',
              body: 'Every captain gets a DM with the room link and the first clock starts now. A captain who is not in the room is picked for after 5 seconds.',
            })}>Start draft</button>
            <button class="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => void run(() => adminApi.draftMode(eventId, null), 'Change the method? The live draft has not started, so nothing is lost.')}>Change method</button>
          </div>
        </>
      )}
      {started && canEdit && (
        <>
          <div class="inlinerow">
            {v.status === 'running' && <button class="btn" disabled={busy} onClick={() => act('pause')}>Pause</button>}
            {v.status === 'paused' && <button class="btn" disabled={busy} onClick={() => act('resume')}>Resume</button>}
            <button class="btn btn--ghost" disabled={busy || v.picks.length === 0}
              onClick={() => act('undo', 'Undo the last pick? The player goes back to the pool and that pick gets a full clock.')}>Undo last pick</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act('reset', {
              title: 'Reset the draft room?', body: 'Every pick is taken back and the room goes back to Ready. The undone picks stay in the event log.',
            })}>Reset room</button>
          </div>
          {v.status !== 'done' && (
            <ul class="draftcontrols__delegates">
              {v.teams.map((t) => {
                const first = t.players[0];
                if (v.delegates[t.captain.steamid]) {
                  return (
                    <li key={t.captain.steamid}>
                      <button class="btn btn--ghost btn--sm" disabled={busy}
                        onClick={() => void run(() => adminApi.draftRoomDelegate(eventId, t.captain.steamid, false))}>{`Give picking back to ${t.captain.name}`}</button>
                    </li>
                  );
                }
                return first ? (
                  <li key={t.captain.steamid}>
                    <button class="btn btn--ghost btn--sm" disabled={busy}
                      onClick={() => void run(() => adminApi.draftRoomDelegate(eventId, t.captain.steamid, true), `Hand ${t.captain.name}'s picking to ${first.name}?`)}>
                      {`Hand ${t.captain.name}'s picking to ${first.name}`}
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
