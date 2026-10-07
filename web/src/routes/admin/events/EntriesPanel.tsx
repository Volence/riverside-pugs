import { useState } from 'preact/hooks';
import { adminApi, ApiError, peopleApi, type AdminEntryView, type ReplaceReason } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fileUrl } from '../adminRoutes';
import { useAction, type Run } from '../useAction';

const DROP: Record<string, string> = {
  withdrawn: 'withdrawn', no_checkin: 'did not check in', over_cap: 'over the cap', incomplete: 'short of 4 starters', team_disbanded: 'team disbanded',
};
const ROLE: Record<string, string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach' };

function statusText(e: AdminEntryView, draft: boolean): string {
  if (e.status === 'dropped') return `Dropped (${DROP[e.dropReason ?? ''] ?? 'dropped'})`;
  if (e.status === 'disqualified') return 'Disqualified';
  // A draft's entries are created as checked_in; a draft has no check-in step.
  if (e.status === 'checked_in' && !draft) return 'Checked in';
  return e.waitlist !== null ? `Waitlist ${e.waitlist}` : 'Registered';
}

const REASONS: [ReplaceReason, string][] = [['conduct', 'Conduct'], ['cheating', 'Cheating'], ['no_show', 'No-show'], ['left', 'Left the event'], ['other', 'Other']];
/** As src/events/entries.ts REPLACE_NOTE_MAX. */
const NOTE_MAX = 200;
type Person = { steamid: string; name: string };

/** Plan D2c Ruling 4: staff take one starter off a draft entry and put a
 *  replacement in, from the bench first or any other player found by name
 *  (the People desk's search; the server checks eligibility and that they
 *  hold no other place). A reason is required; the note stays with staff. */
function ReplaceForm({ eventId, e, out, bench, busy, run, onClose }: {
  eventId: number; e: AdminEntryView; out: Person; bench: Person[]; busy: boolean; run: Run; onClose: () => void;
}) {
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState<ReplaceReason | ''>('');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[] | null>(null);
  const [searchError, setSearchError] = useState('');
  /** Why the server refused the last try, player by player (the server's reason, the entry rules missed, another roster). */
  const [problems, setProblems] = useState<{ steamid: string; name: string; problems: string[] }[]>([]);
  const known = [...bench, ...(found ?? []).filter((p) => !bench.some((b) => b.steamid === p.steamid))];
  const chosen = known.find((p) => p.steamid === pick);
  const search = async () => {
    setSearchError('');
    try {
      const r = await peopleApi.people(q.trim());
      setFound(r.players.filter((p) => !e.roster.some((x) => x.steamid === p.steamid)).slice(0, 10).map((p) => ({ steamid: p.steamid, name: p.name })));
    } catch {
      setSearchError('Could not search players.');
    }
  };
  const submit = () => {
    if (!chosen || !reason) return;
    void run(async () => {
      setProblems([]);
      try {
        await adminApi.replaceEntryPlayer(eventId, e.id, { out: out.steamid, in: chosen.steamid, reason, note: note.trim() === '' ? null : note.trim() });
      } catch (err) {
        // The details stay under the form; run still shows the sentence.
        if (err instanceof ApiError && err.problems) setProblems(err.problems);
        throw err;
      }
      onClose();
    }, {
      title: `Replace ${out.name} with ${chosen.name}?`,
      body: `${out.name} loses their place on ${e.name}. This is not a ban; use the ban tools for that.`,
      confirmLabel: 'Replace', danger: true,
    });
  };
  return (
    <div class="replaceform" role="group" aria-label={`Replace ${out.name}`}>
      <div class="inlinerow">
        <select aria-label="Replacement" value={pick} onChange={(ev) => setPick((ev.target as HTMLSelectElement).value)}>
          <option value="">Choose the replacement</option>
          {bench.length > 0 && <optgroup label="Bench">{bench.map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}</optgroup>}
          {found && found.length > 0 && (
            <optgroup label="Found">{known.filter((p) => !bench.includes(p)).map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}</optgroup>
          )}
        </select>
      </div>
      <form class="inlinerow" onSubmit={(ev) => { ev.preventDefault(); void search(); }}>
        <input type="search" aria-label="Find another player" placeholder="Another player: name or SteamID" value={q} onInput={(ev) => setQ((ev.target as HTMLInputElement).value)} />
        <button class="btn btn--ghost btn--sm" type="submit" disabled={q.trim() === ''}>Search</button>
      </form>
      {searchError && <p class="error">{searchError}</p>}
      {found && found.length === 0 && <p class="muted">No other players match.</p>}
      <div class="inlinerow">
        <select aria-label="Reason" value={reason} onChange={(ev) => setReason((ev.target as HTMLSelectElement).value as ReplaceReason | '')}>
          <option value="">Choose a reason</option>
          {REASONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input type="text" aria-label="Staff note" placeholder="Note for staff (optional)" maxLength={NOTE_MAX} value={note} onInput={(ev) => setNote((ev.target as HTMLInputElement).value)} />
      </div>
      {problems.length > 0 && (
        <ul class="replaceform__problems" role="alert">
          {problems.map((p) => <li key={p.steamid}><strong>{p.name}</strong>: {p.problems.join(' ')}</li>)}
        </ul>
      )}
      <p class="muted">The note stays with staff and is never sent to the player. This is not a ban: <a href={fileUrl(out.steamid)}>open {out.name}'s file</a> for the ban tools.</p>
      <div class="inlinerow">
        <button class="btn btn--sm" disabled={busy || !chosen || !reason} onClick={submit}>Replace</button>
        <button class="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** The event is past seeding entirely once it is live, finished or
 *  cancelled; the server's reorderSeeds already refuses those with
 *  `seeds_locked`, so the Up/Down controls are not offered then either. */
const SEEDS_CLOSED: readonly string[] = ['live', 'finished', 'cancelled'];

/** One entry's row. Its own component so the Disqualify reason box is this
 *  row's state alone, never shared with any other row's box or send. */
function EntryRow({ e, draft, canRename, canEdit, locked, showMove, canRestore, busy, active, onMove, onDisqualify, onRestore, onRename, replace }: {
  e: AdminEntryView; draft: boolean; canRename: boolean; onRename: (id: number, name: string) => void; canEdit: boolean; locked: boolean; showMove: boolean; canRestore: boolean; busy: boolean; active: boolean;
  onMove: (id: number, by: -1 | 1) => void; onDisqualify: (id: number, name: string, reason: string) => void; onRestore: (id: number, name: string) => void;
  /** Plan D2c: Replace on a draft entry's non-captain starters, while the server would take it. */
  replace: { eventId: number; bench: Person[]; run: Run } | null;
}) {
  const [reason, setReason] = useState('');
  const [name, setName] = useState(e.name);
  const [replacing, setReplacing] = useState<Person | null>(null);
  /** D2c addendum: the same gate as Replace player; the old captain stays a starter. */
  const makeCaptain = (r: NonNullable<typeof replace>, p: Person) => {
    const old = e.roster.find((x) => x.steamid === e.captainSteamid)?.name ?? 'The old captain';
    void r.run(() => adminApi.setEntryCaptain(r.eventId, e.id, p.steamid), {
      title: `Make ${p.name} captain of ${e.name}?`,
      body: `They take over the match room, prep and the team name. ${old} stays on the team as a player.`,
      confirmLabel: 'Make captain',
    });
  };
  const canReplace = (p: AdminEntryView['roster'][number]) =>
    replace !== null && canEdit && draft && active && p.role === 'starter' && e.captainSteamid !== null && p.steamid !== e.captainSteamid;
  return (
    <li class={active ? '' : 'muted'}>
      <strong>{e.seed !== null && active ? `#${e.seed} ` : ''}{e.name}</strong> <span class="muted">[{e.tag}]</span>
      {' '}· {statusText(e, draft)} · SR {e.sr} · by {e.registeredByName}
      <ul class="entrypanel__roster">
        {e.roster.map((p) => (
          <li key={p.steamid}>
            <span class="chip">{ROLE[p.role]}</span> {p.name}{p.steamid === e.captainSteamid && <span class="muted"> (captain)</span>}
            {p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}
            {canReplace(p) && replacing?.steamid !== p.steamid && (
              <button class="btn btn--ghost btn--sm" aria-label={`Replace player ${p.name}`} disabled={busy} onClick={() => setReplacing({ steamid: p.steamid, name: p.name })}>Replace player</button>
            )}
            {canReplace(p) && replace && (
              <button class="btn btn--ghost btn--sm" aria-label={`Make ${p.name} captain`} disabled={busy} onClick={() => makeCaptain(replace, p)}>Make captain</button>
            )}
          </li>
        ))}
      </ul>
      {replace && replacing && e.roster.some((p) => p.steamid === replacing.steamid) && (
        <ReplaceForm eventId={replace.eventId} e={e} out={replacing} bench={replace.bench} busy={busy} run={replace.run} onClose={() => setReplacing(null)} />
      )}
      {canEdit && canRename && active && (
        <div class="inlinerow">
          <input type="text" aria-label={`Team name for ${e.name}`} maxLength={24} value={name} onInput={(ev) => setName((ev.target as HTMLInputElement).value)} />
          <button class="btn btn--ghost btn--sm" aria-label={`Save name for ${e.name}`} disabled={busy || name === e.name} onClick={() => onRename(e.id, name)}>Save name</button>
        </div>
      )}
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
export function EntriesPanel({ eventId, status, checkin, canEdit, draft = false, gen = 0, onChange }: {
  eventId: number; status: string; checkin: boolean; canEdit: boolean; draft?: boolean; gen?: number; onChange?: () => void;
}) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventEntries(eventId, s), [eventId, gen]);
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
  const rename = (id: number, name: string) => void run(() => adminApi.setEntryIdentity(eventId, id, { name }));
  const canRename = draft && !SEEDS_CLOSED.includes(status);
  // Plan D2c Ruling 4: from teams made (the entries exist) until the event finishes.
  const replace = draft && canEdit && status !== 'finished' && status !== 'cancelled' ? { eventId, bench: data.bench ?? [], run } : null;
  const active = (e: AdminEntryView) => e.status !== 'dropped' && e.status !== 'disqualified';
  return (
    <Panel>
      <h3>Entries</h3>
      {canEdit && !locked && (
        <div class="inlinerow">
          {canOpenCheckin && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(async () => { await adminApi.openEventCheckin(eventId); onChange?.(); }, 'Open check-in now?')}>Open check-in now</button>
          )}
          {canClose && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(async () => { await adminApi.lockEventEntries(eventId); onChange?.(); }, {
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
            <EntryRow key={e.id} e={e} draft={draft} canRename={canRename} onRename={rename} canEdit={canEdit} locked={locked} showMove={showMove} canRestore={canRestore} busy={busy} active={active(e)}
              onMove={move} onDisqualify={disqualify} onRestore={restore} replace={replace} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
