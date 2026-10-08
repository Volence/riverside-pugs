import { adminApi, type DraftTeamView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { DraftRoomControls } from './DraftRoomControls';
import { useHubEvent } from '../../../hooks/useHubEvent';
import { fmtTime, useAction } from '../useAction';

/** The Make teams section of a draft-kind event on the desk (drafts plan
 *  D2a): choose the method, balance by SR, swap players by hand, read the
 *  fairness numbers and publish. Staff only: none of this reaches a player.
 *  A mod (canEdit false) reads it with no control, and nobody gets one once
 *  the event is cancelled or finished. startsAt lets the publish confirm warn
 *  when the start time has already passed. */
export function DraftTeamsPanel({ eventId, slug = '', canEdit, status, startsAt, gen = 0, onChange }: {
  eventId: number; slug?: string; canEdit: boolean; status: string; startsAt: string; gen?: number; onChange?: () => void;
}) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.draftTeamsView(eventId, s), [eventId, gen]);
  const { busy, error, run } = useAction(() => { reload(); onChange?.(); });
  // The clock or a captain can make the last pick: show the teams without a page reload.
  useHubEvent([`draft:${eventId}`], reload);
  if (loadError) return <Panel><h3>Make teams</h3><p class="error">Could not load the teams.</p></Panel>;
  if (!data) return <Panel><h3>Make teams</h3></Panel>;
  const published = data.teamsMadeAt !== null;
  const over = status === 'cancelled' || status === 'finished';
  const write = canEdit && !over;
  const startPassed = Date.parse(startsAt) <= Date.now();
  const teams = data.teams;
  const fair = data.fairness;
  const allPlayers = (teams ?? []).flatMap((t, ti) => t.players.map((p) => ({ ...p, ti })));
  const avgOf = (t: DraftTeamView) => fair?.teams.find((f) => f.captain === t.captain.steamid)?.avgSr;

  return (
    <Panel class="maketeams">
      <h3>Make teams</h3>
      {published && <p>Teams published {fmtTime(data.teamsMadeAt)}</p>}
      {!canEdit && !published && <p class="muted">Read only: admins run events.</p>}
      {error && <p class="error" role="alert">{error}</p>}
      {!published && data.mode === null && write && (
        <div class="maketeams__modes">
          <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.draftMode(eventId, 'auto'))}>Auto-balance by SR</button>
          <button class="btn btn--ghost" disabled={busy} onClick={() => void run(() => adminApi.draftMode(eventId, 'live'))}>Let captains pick</button>
        </div>
      )}
      {!published && data.mode === 'live' && (
        <DraftRoomControls eventId={eventId} slug={slug} canEdit={write} onChange={() => { reload(); onChange?.(); }} />
      )}
      {!published && data.mode === 'auto' && write && (
        <div class="inlinerow">
          {teams === null
            ? <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.draftBalance(eventId))}>Balance teams</button>
            : <button class="btn btn--ghost" disabled={busy} onClick={() => void run(() => adminApi.draftBalance(eventId), 'Rebalance from scratch? Hand moves are lost.')}>Rebalance</button>}
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.draftMode(eventId, null), 'Change the method? The balanced teams are cleared.')}>Change method</button>
        </div>
      )}
      {teams !== null && teams.length === 0 && <Empty>No teams.</Empty>}
      {teams !== null && teams.length > 0 && (
        <div class="maketeams__teams">
          {teams.map((t, ti) => {
            const avg = avgOf(t);
            return (
              <div key={t.captain.steamid} class="maketeam">
                <h4>{t.captain.name} <span class="chip">Captain</span></h4>
                {avg !== undefined && <p class="muted">{`Average SR ${Math.round(avg)}`}</p>}
                <ul class="maketeam__players">
                  {t.players.map((p) => (
                    <li key={p.steamid}>
                      <span>{p.name}</span> <span class="muted">{Math.round(p.sr)}</span>
                      {write && !published && data.mode === 'auto' && (
                        <select aria-label={`Swap ${p.name} with`} disabled={busy} value=""
                          onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) void run(() => adminApi.draftMove(eventId, p.steamid, v)); }}>
                          <option value="">Swap with...</option>
                          {allPlayers.filter((o) => o.ti !== ti).map((o) => <option key={o.steamid} value={o.steamid}>{o.name}</option>)}
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
                {t.short && <p class="error">This team is short a player; publishing will be refused until it has 4.</p>}
              </div>
            );
          })}
        </div>
      )}
      {fair && (
        <div class="maketeams__fair">
          <p>{`Spread: ${Math.round(fair.spread)} SR between the strongest and weakest team`}</p>
          {fair.forecasts.length > 0 && (
            <table class="admin-table">
              <tbody>
                {fair.forecasts.map((f) => {
                  const pct = Math.round(f.winA * 100);
                  return <tr key={`${f.a}-${f.b}`}><td>{`${fair.teams[f.a]!.captainName} vs ${fair.teams[f.b]!.captainName}: ${pct}% / ${100 - pct}%`}</td></tr>;
                })}
              </tbody>
            </table>
          )}
          <p class="muted">Unrated players count at the default SR here; the win forecast treats them as an unknown rating, so the two can disagree.</p>
        </div>
      )}
      {!published && write && teams !== null && (
        <div class="inlinerow">
          <button class="btn" disabled={busy} onClick={() => void run(() => adminApi.draftPublishTeams(eventId), {
            title: 'Publish the teams?',
            body: 'Entries are created, every player gets a DM with their team, and captains can name their team until the event starts. Teams cannot be changed afterwards.'
              + (startPassed ? ' The start time has passed, so the event starts within a minute of publishing and team names lock then.' : ''),
          })}>Publish teams</button>
        </div>
      )}
    </Panel>
  );
}
