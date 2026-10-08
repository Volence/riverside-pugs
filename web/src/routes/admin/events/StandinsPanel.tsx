import { useState } from 'preact/hooks';
import { adminApi, type StandinScope, type StandinStatus } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, useAction } from '../useAction';

const SCOPE: Record<StandinScope, string> = { match: 'next match', event: 'rest of the event' };
const STATUS: Record<StandinStatus, string> = { open: 'Asking', filled: 'Found', unfilled: 'Nobody took it', cancelled: 'Cancelled', ended: 'Done' };
const ANSWER: Record<string, string> = { accept: 'Accepted', decline: 'Declined', expired: 'Ran out', stopped: 'Stopped', failed: 'Could not be placed' };

/** Bench stand-ins on the Events desk (plan D3a): the event's SR margin,
 *  every request with each offer (SR and answer, staff only), and for admins:
 *  ask the bench for any team, lift the SR limit on a request, cancel one. */
export function StandinsPanel({ eventId, canEdit, gen = 0 }: { eventId: number; canEdit: boolean; gen?: number }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventStandins(eventId, s), [eventId, gen]);
  const { busy, error, run } = useAction(reload);
  const [margin, setMargin] = useState<string | null>(null);
  const [team, setTeam] = useState('');
  const [out, setOut] = useState('');
  const [scope, setScope] = useState<StandinScope>('match');
  if (loadError) return <Panel><h3>Stand-ins</h3><p class="error">Could not load the stand-ins.</p></Panel>;
  if (!data) return <Panel><h3>Stand-ins</h3></Panel>;
  const starters = data.teams.find((t) => String(t.entryId) === team)?.starters ?? [];
  return (
    <Panel>
      <h3>Stand-ins</h3>
      {error && <p class="error" role="alert">{error}</p>}
      {canEdit ? (
        <div class="inlinerow">
          <label>SR margin <input type="number" min={0} max={2000} step={1} value={margin ?? String(data.margin)} onInput={(e) => setMargin((e.target as HTMLInputElement).value)} /></label>
          <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.setStandinMargin(eventId, Number(margin ?? data.margin)))}>Save margin</button>
        </div>
      ) : <p class="muted">SR margin: {data.margin} above the missing player.</p>}
      {canEdit && data.open && (
        <div class="standinpanel__ask">
          <label for="desk-standin-team">Team</label>
          <select id="desk-standin-team" value={team} onChange={(e) => { setTeam((e.target as HTMLSelectElement).value); setOut(''); }}>
            <option value="">Choose a team</option>
            {data.teams.map((t) => <option key={t.entryId} value={String(t.entryId)}>{t.name}</option>)}
          </select>
          <label for="desk-standin-player">Player</label>
          <select id="desk-standin-player" value={out} onChange={(e) => setOut((e.target as HTMLSelectElement).value)}>
            <option value="">Choose a player</option>
            {starters.map((s) => <option key={s.steamid} value={s.steamid}>{s.name}</option>)}
          </select>
          <fieldset>
            <label><input type="radio" name="desk-standin-scope" checked={scope === 'match'} onChange={() => setScope('match')} /> Next match</label>
            <label><input type="radio" name="desk-standin-scope" checked={scope === 'event'} onChange={() => setScope('event')} /> Rest of the event</label>
          </fieldset>
          <button class="btn" disabled={busy || team === '' || out === ''} onClick={() => run(() => adminApi.requestStandinFor(eventId, { entryId: Number(team), out, scope }))}>Ask the bench</button>
        </div>
      )}
      {data.requests.length === 0 ? <Empty>No stand-in requests yet.</Empty> : (
        <ul class="admin-list">
          {data.requests.map((r) => (
            <li key={r.id} class="standinrow">
              <span>{r.team} · {r.out.name} · {SCOPE[r.scope]} · {r.status === 'filled' && r.standin ? `${r.standin} stands in` : STATUS[r.status]} · {r.marginOff ? 'no SR limit' : `up to ${r.margin} SR above`}</span>
              {r.offers.length > 0 && (
                <ul class="standinoffers">
                  {r.offers.map((o) => <li key={`${o.steamid}-${o.offeredAt}`}>{o.name} · SR {o.sr} · {o.answer ? ANSWER[o.answer] ?? o.answer : `open until ${fmtTime(o.expiresAt)}`}</li>)}
                </ul>
              )}
              {canEdit && (r.status === 'open' || r.status === 'unfilled') && !r.marginOff && (
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => run(() => adminApi.standinMarginOff(eventId, r.id))}>Offer without the SR limit</button>
              )}
              {canEdit && r.status === 'open' && (
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => run(() => adminApi.cancelStandinFor(eventId, r.id), `Cancel the stand-in for ${r.out.name}?`)}>Cancel</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
