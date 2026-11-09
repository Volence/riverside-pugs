import { useState } from 'preact/hooks';
import { adminApi, ApiError, CutChangedError, peopleApi, type CutProblem, type SignupFacts } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, useAction, type Run } from '../useAction';

const PREF: Record<SignupFacts['captainPref'], string> = { want: 'Wants', willing: 'Willing', no: 'No' };
const ROLE: Record<string, string> = { captain: 'Captain', pool: 'Pool', bench: 'Bench' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Draft tourney 2 plan (owner, 10-24 night): staff add someone who missed
 *  the close, found by name (the People desk's search), onto the bench while
 *  the cut is unpublished. The server checks eligibility; its reasons show
 *  under the form. */
function LateSignup({ eventId, signedUp, busy, run }: { eventId: number; signedUp: Set<string>; busy: boolean; run: Run }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const [searchError, setSearchError] = useState('');
  const [problems, setProblems] = useState<{ steamid: string; name: string; problems: string[] }[]>([]);
  const chosen = found?.find((p) => p.steamid === pick);
  const search = async () => {
    setSearchError('');
    try {
      const r = await peopleApi.people(q.trim());
      setFound(r.players.filter((p) => !signedUp.has(p.steamid)).slice(0, 10).map((p) => ({ steamid: p.steamid, name: p.name })));
      setPick('');
    } catch {
      setSearchError('Could not search players.');
    }
  };
  return (
    <div class="replaceform" role="group" aria-label="Add a late signup">
      <form class="inlinerow" onSubmit={(ev) => { ev.preventDefault(); void search(); }}>
        <input type="search" aria-label="Find a player to add" placeholder="Add a late signup: name or SteamID" value={q} onInput={(ev) => setQ((ev.target as HTMLInputElement).value)} />
        <button class="btn btn--ghost btn--sm" type="submit" disabled={q.trim() === ''}>Search</button>
      </form>
      {searchError && <p class="error">{searchError}</p>}
      {found && found.length === 0 && <p class="muted">No players match who are not signed up already.</p>}
      {found && found.length > 0 && (
        <div class="inlinerow">
          <select aria-label="Player to add" value={pick} onChange={(ev) => setPick((ev.target as HTMLSelectElement).value)}>
            <option value="">Choose the player</option>
            {found.map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
          </select>
          <button class="btn btn--sm" disabled={busy || !chosen} onClick={() => chosen && void run(async () => {
            setProblems([]);
            try {
              await adminApi.draftLateSignup(eventId, chosen.steamid);
            } catch (err) {
              if (err instanceof ApiError && err.problems) setProblems(err.problems);
              throw err;
            }
            setFound(null); setQ(''); setPick('');
          }, { title: `Add ${chosen.name} after the close?`, body: 'They go on the bench at the end of the signup order. Swap them into the pool by hand if a team needs them.', confirmLabel: 'Add' })}>Add to the bench</button>
        </div>
      )}
      {problems.length > 0 && (
        <ul class="replaceform__problems" role="alert">
          {problems.map((p) => <li key={p.steamid}><strong>{p.name}</strong>: {p.problems.join(' ')}</li>)}
        </ul>
      )}
    </div>
  );
}

/** One sentence per CutProblem code. The counts the codes do not carry come
 *  in `o`: from the table for the live list, from the server's own `cut`
 *  for a refused publish (the table may be stale by then). */
function problemText(code: CutProblem, o: { teams: number | null; maxTeams: number; captains: number; ineligible: number; active: number }): string {
  const teams = o.teams ?? 0;
  switch (code) {
    // Fewer than 8 signups: no team count can fix it, so the event is cancelled.
    case 'too_few_teams': return o.maxTeams < 2
      ? `A draft needs at least 8 signups; this one has ${o.active}. Cancel the event.`
      : 'Set at least 2 teams.';
    case 'too_many_teams': return `There are too many teams for the signups (most ${o.maxTeams}).`;
    case 'too_few_captains': return `Choose ${plural(Math.max(teams - o.captains, 0), 'more captain', 'more captains')}.`;
    case 'too_many_captains': return `There are ${plural(Math.max(o.captains - teams, 0), 'captain', 'captains')} too many. Remove ${o.captains - teams === 1 ? 'one' : 'some'}.`;
    case 'pool_size': return `The pool must be exactly ${teams * 3}.`;
    case 'unassigned': return 'Some signups have no role yet.';
    case 'ineligible': return `${plural(o.ineligible, 'signup is', 'signups are')} not eligible; remove ${o.ineligible === 1 ? 'it' : 'them'}.`;
  }
}

/** One signup's row. Its own component so the swap pick and the removal
 *  reason are this row's state alone. */
function SignupRow({ s, canAct, busy, others, onCaptain, onSwap, onRemove }: {
  s: SignupFacts; canAct: boolean; busy: boolean; others: SignupFacts[];
  onCaptain: (s: SignupFacts, captain: boolean) => void; onSwap: (s: SignupFacts, other: string) => void;
  onRemove: (s: SignupFacts, reason: 'removed' | 'ineligible') => void;
}) {
  const [reason, setReason] = useState<'removed' | 'ineligible'>('removed');
  const quiet = s.abandons30d === 0 && s.noShows30d === 0;
  return (
    <tr>
      <td>
        {s.name}
        {s.problems.map((p) => <div key={p} class="rosterpick__why">{p}</div>)}
      </td>
      <td>{s.sr}</td>
      <td>{PREF[s.captainPref]}</td>
      <td>{s.note ?? ''}</td>
      <td>{fmtTime(s.signedUpAt)}{s.checkedIn && <span class="muted"> · checked in</span>}</td>
      <td class={quiet ? 'muted' : ''}>{s.abandons30d} abandons, {s.noShows30d} no-shows (30 d)</td>
      <td>
        {s.role && <span class="teamchip">{ROLE[s.role]}</span>}
        {s.manual && <span class="muted"> (moved by hand)</span>}
        {s.role === 'captain' && s.captainPref !== 'want' && <span class="muted"> (did not volunteer)</span>}
      </td>
      {canAct && (
        <td class="evdesk__acts">
          <div class="inlinerow">
            {s.role === 'captain'
              ? <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onCaptain(s, false)}>Remove captain</button>
              : <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onCaptain(s, true)}>Make captain</button>}
            {(s.role === 'pool' || s.role === 'bench') && others.length > 0 && (
              <select aria-label={`Swap ${s.name} with`} disabled={busy} value=""
                onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) onSwap(s, v); }}>
                <option value="">Swap with...</option>
                {others.map((o) => <option key={o.steamid} value={o.steamid}>{o.name}</option>)}
              </select>
            )}
            <select aria-label={`Reason for removing ${s.name}`} value={reason} onChange={(e) => setReason((e.target as HTMLSelectElement).value as 'removed' | 'ineligible')}>
              <option value="removed">Removed by an organizer</option>
              <option value="ineligible">Not eligible</option>
            </select>
            <button class="btn btn--ghost btn--sm" aria-label={`Remove signup ${s.name}`} disabled={busy} onClick={() => onRemove(s, reason)}>Remove signup</button>
          </div>
        </td>
      )}
    </tr>
  );
}

/** The Draft section of a draft-kind event on the desk (drafts plan D1): the
 *  signups, the cut, captaincy offers and Publish. A mod (canEdit false)
 *  reads everything and has no control. */
export function DraftPanel({ eventId, canEdit, signupsCloseAt = null, gen = 0, onChange }: {
  eventId: number; canEdit: boolean; signupsCloseAt?: string | null; gen?: number; onChange?: () => void;
}) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventDraft(eventId, s), [eventId, gen]);
  const { busy, error, run } = useAction(() => { reload(); onChange?.(); });
  const [teams, setTeams] = useState('');
  const [refused, setRefused] = useState<string[]>([]);
  if (loadError) return <Panel class="evdesk__panel" id="evdesk-draft"><h3>Draft</h3><p class="error">Could not load the draft.</p></Panel>;
  if (!data) return <Panel class="evdesk__panel" id="evdesk-draft"><h3>Draft</h3></Panel>;
  const locked = data.lockedAt !== null;
  const published = data.cutAt !== null;
  const n = data.signups.length;
  const captains = data.signups.filter((s) => s.role === 'captain').length;
  const ineligible = data.signups.filter((s) => s.problems.length > 0).length;
  const sentence = (c: CutProblem) => problemText(c, { teams: data.teams, maxTeams: data.maxTeams, captains, ineligible, active: n });
  const short = locked && !published ? Math.max((data.teams ?? 0) - captains, 0) : 0;
  const canAct = canEdit && !published;
  const teamValue = teams !== '' ? teams : String(data.teams ?? data.maxTeams);

  const header = published ? `Cut published ${fmtTime(data.cutAt)}`
    : locked ? `${plural(n, 'signup', 'signups')} · ${data.teams ?? 0} teams (most ${data.maxTeams})`
      : `Signups open${signupsCloseAt ? ` until ${fmtTime(signupsCloseAt)}` : ''}: ${n} signed up`;

  const publish = () => run(async () => {
    setRefused([]);
    try {
      await adminApi.draftPublish(eventId);
    } catch (err) {
      if (!(err instanceof CutChangedError)) throw err;
      const b = err.cutBody;
      const ine = b.ineligible.length;
      setRefused(b.problems.map((c) => problemText(c, { teams: b.cut.teams, maxTeams: b.cut.maxTeams, captains: b.cut.captains, ineligible: ine, active: b.cut.active })));
    }
  }, {
    title: 'Publish the cut?',
    body: 'Captains, pool and bench appear on the event page and every signup gets a DM with their role and the draft time. The cut cannot be changed afterwards.',
  });

  return (
    <Panel class="evdesk__panel" id="evdesk-draft">
      <h3>Draft</h3>
      <p class="evdesk__help">Close signups, pick the captains and publish the cut. Everyone gets their role by DM when the cut goes out.</p>
      <p>{header}</p>
      {canEdit && !locked && (
        <div class="inlinerow">
          <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.closeSignups(eventId), {
            title: 'Close signups now?', body: 'Nobody can sign up or withdraw after this. Staff can still remove a signup.',
          })}>Close signups</button>
        </div>
      )}
      {locked && !published && canEdit && data.maxTeams >= 2 && (
        <div class="inlinerow">
          <input type="number" aria-label="Team count" min={2} max={Math.max(data.maxTeams, 2)} value={teamValue}
            onInput={(e) => setTeams((e.target as HTMLInputElement).value)} />
          <button class="btn btn--ghost" disabled={busy || teamValue === ''} onClick={() => run(async () => { await adminApi.draftTeams(eventId, Number(teamValue)); setTeams(''); })}>Set</button>
        </div>
      )}
      {!canEdit && <p class="muted">Read only: admins run events.</p>}
      {error && <p class="error" role="alert">{error}</p>}
      {locked && !published && data.problems.some((c) => !(c === 'too_few_captains' && short > 0)) && (
        <ul class="muted">{data.problems.filter((c) => !(c === 'too_few_captains' && short > 0)).map((c) => <li key={c}>{sentence(c)}</li>)}</ul>
      )}
      {refused.length > 0 && (
        <div class="error" role="alert">
          <p>The cut was not published:</p>
          <ul>{refused.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}
      {locked && !published && (
        <>
          {canEdit && (
            <div class="inlinerow">
              <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.draftPickCaptains(eventId), {
                title: 'Pick captains?',
                body: `The highest-SR signups who want to or will captain become the ${data.teams ?? 0} captains. This replaces the current captains and resets the pool and bench.`,
              })}>Pick captains</button>
            </div>
          )}
          {short > 0 && <p>{short} more {short === 1 ? 'captain' : 'captains'} needed. Offer captaincy to willing signups, or make someone captain by hand.</p>}
          {canEdit && (
            <div class="inlinerow">
              <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.draftOffers(eventId, !data.offersOn))}>
                {data.offersOn ? 'Stop offers' : 'Offer captaincy to willing signups'}
              </button>
            </div>
          )}
          {data.openOffer && <p>Offered to {data.openOffer.name}, answer by {fmtTime(data.openOffer.expiresAt)}</p>}
        </>
      )}
      {data.checkin && !published && (
        <p class="muted">Check-in {fmtTime(data.checkin.opensAt)} to {fmtTime(data.checkin.closesAt)}: {data.signups.filter((s) => s.checkedIn).length} of {n} checked in. Whoever has not checked in when it closes is removed.</p>
      )}
      {n === 0 ? <Empty>Nobody has signed up yet.</Empty> : (
        <div class="table-wrap">
          <table class="admin-table evdesk__signups">
            <thead>
              <tr>
                <th>Name</th><th>SR</th><th>Captain</th><th>Note</th><th>Signed up</th><th>Reliability</th><th>Role</th>{canAct && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {data.signups.map((s) => (
                <SignupRow key={s.steamid} s={s} canAct={canAct} busy={busy}
                  others={data.signups.filter((o) => o.role === (s.role === 'pool' ? 'bench' : 'pool') && (s.role === 'pool' || s.role === 'bench'))}
                  onCaptain={(x, c) => void run(() => adminApi.draftCaptain(eventId, x.steamid, c))}
                  onSwap={(x, other) => void run(() => (x.role === 'pool' ? adminApi.draftSwap(eventId, x.steamid, other) : adminApi.draftSwap(eventId, other, x.steamid)))}
                  onRemove={(x, reason) => void run(() => adminApi.removeSignup(eventId, x.steamid, reason), `Remove ${x.name}'s signup?`)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {locked && !published && canEdit && (
        <LateSignup eventId={eventId} signedUp={new Set(data.signups.map((s) => s.steamid))} busy={busy} run={run} />
      )}
      {locked && !published && canEdit && (
        <div class="inlinerow">
          <button class="btn" disabled={busy || data.problems.length > 0} onClick={publish}>Publish the cut</button>
        </div>
      )}
    </Panel>
  );
}
