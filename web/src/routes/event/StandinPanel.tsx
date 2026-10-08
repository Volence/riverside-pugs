import { useState } from 'preact/hooks';
import { ApiError, eventsApi, type StandinScope, type StandinStatus } from '../../api';
import { Panel } from '../../components/bits';
import { confirm } from '../../components/Confirm';
import { whenText } from '../../eventFormat';
import { useFetch } from '../../hooks/useFetch';

const SCOPE: Record<StandinScope, string> = { match: 'next match', event: 'rest of the event' };
const STATUS: Record<StandinStatus, string> = {
  open: 'Asking the bench', filled: 'Found', unfilled: 'Nobody took it; staff were told', cancelled: 'Cancelled', ended: 'Done',
};

/** Bench stand-ins on a draft event page (plan D3a): a bench player's open
 *  offer with Accept and Decline, and for a captain, asking the bench for a
 *  stand-in and the team's requests. Renders nothing for anyone else. */
export function StandinPanel({ slug }: { slug: string }) {
  const { data, reload } = useFetch((s) => eventsApi.standins(slug, s), [slug]);
  const [out, setOut] = useState('');
  const [scope, setScope] = useState<StandinScope>('match');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      reload();
    }
  };
  if (!data || (!data.offer && !data.captain)) return null;
  const { offer, captain } = data;
  const chosen = captain?.starters.find((s) => s.steamid === out) ?? null;
  const wanted: StandinScope = captain && !captain.canMatch ? 'event' : scope;
  const ask = async () => {
    if (!captain || !chosen) return;
    if (wanted === 'event' && !(await confirm({
      title: `${chosen.name} has left the team?`,
      body: `The bench is asked for a stand-in for the rest of the event. Whoever accepts takes ${chosen.name}'s place on ${captain.team}.`,
      confirmLabel: 'Ask the bench',
    }))) return;
    void run(() => eventsApi.requestStandin(slug, { entryId: captain.entryId, out: chosen.steamid, scope: wanted }));
  };
  return (
    <Panel class="entrypanel standinpanel">
      {offer && (
        <div class="draftoffer" role="group" aria-label="Stand-in offer">
          <p><strong>{offer.team} needs a stand-in for {offer.out} ({SCOPE[offer.scope]}). Accept by {whenText(offer.expiresAt)}?</strong></p>
          <div class="inlinerow">
            <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.answerStandin(slug, offer.offerId, true))}>Accept</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => eventsApi.answerStandin(slug, offer.offerId, false))}>Decline</button>
          </div>
        </div>
      )}
      {captain && (
        <>
          <h3>Stand-ins</h3>
          {captain.open ? (
            <div class="standinpanel__ask">
              {/* for/id, not a wrapping label: a wrapping label's text would include every option. */}
              <label for="standin-player">Player</label>
              <select id="standin-player" value={out} onChange={(e) => setOut((e.target as HTMLSelectElement).value)}>
                <option value="">Choose a player</option>
                {captain.starters.map((s) => <option key={s.steamid} value={s.steamid}>{s.name}{s.captain ? ' (you)' : ''}</option>)}
              </select>
              <fieldset>
                <legend class="sr-only">For how long</legend>
                <label><input type="radio" name="standin-scope" checked={wanted === 'match'} disabled={!captain.canMatch} onChange={() => setScope('match')} /> Next match</label>
                <label><input type="radio" name="standin-scope" checked={wanted === 'event'} onChange={() => setScope('event')} /> Rest of the event (they left)</label>
              </fieldset>
              <button class="btn" disabled={busy || !chosen} onClick={() => void ask()}>Ask the bench</button>
            </div>
          ) : <p class="muted">Stand-ins open once the teams are made and close when the event ends.</p>}
          {captain.requests.length > 0 && (
            <ul class="admin-list">
              {captain.requests.map((r) => (
                <li key={r.id} class="standinrow">
                  {r.out.name} · {SCOPE[r.scope]} · {r.status === 'filled' && r.standin ? `${r.standin} stands in` : STATUS[r.status]}{r.status === 'open' ? ` (${r.asked} asked)` : ''}
                  {r.status === 'open' && (
                    <button class="btn btn--ghost btn--sm" aria-label={`Cancel the stand-in for ${r.out.name}`} disabled={busy}
                      onClick={() => run(() => eventsApi.cancelStandin(slug, r.id))}>Cancel</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
