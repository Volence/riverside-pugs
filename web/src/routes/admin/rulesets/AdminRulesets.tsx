import { useId, useState } from 'preact/hooks';
import { adminApi, type AdminRuleset } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction } from '../useAction';
import { FormRow } from '../events/FormRow';
import { RulesetForm } from './RulesetForm';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Not in use", or what still uses it: open bookings and unfinished events. */
export function inUseText(u: AdminRuleset['inUse']): string {
  if (u.bookings === 0 && u.events === 0) return 'Not in use';
  return `In use: ${[u.bookings > 0 ? plural(u.bookings, 'open booking') : '', u.events > 0 ? plural(u.events, 'event') : ''].filter(Boolean).join(', ')}`;
}

/** Setup > Rulesets (admins only): copy a ruleset, edit one, archive one.
 *  PUG is read only and the three built-ins cannot be archived; the server
 *  enforces both, the buttons only leave them out. */
export function AdminRulesets() {
  const { data, reload } = useFetch((s) => adminApi.rulesets(s), []);
  const { busy, error, run } = useAction(reload);
  const [editing, setEditing] = useState<number | null>(null);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [name, setName] = useState('');
  const uid = useId();
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const source = copyFrom ?? data.rulesets[0]?.id ?? null;

  const create = (e: Event) => {
    e.preventDefault();
    if (source === null) return;
    void run(async () => { await adminApi.createRuleset(source, name); setName(''); });
  };

  return (
    <div class="stack">
      {editing === null && error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <h3>Rulesets</h3>
        <p class="muted">Changes apply to new bookings and events; running and finished ones keep the rules they started with.</p>
        {data.rulesets.length === 0 ? <Empty>No rulesets.</Empty> : (
          <ul class="admin-list rulesetlist">
            {data.rulesets.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong>{' '}
                <span class="teamchip">{r.template ? 'Built-in' : r.basedOn ? `Copy of ${r.basedOn}` : 'Custom'}</span>{' '}
                {r.readOnly && <><span class="teamchip">Read only</span>{' '}</>}
                {r.archived && <><span class="teamchip teamchip--cancelled">Archived</span>{' '}</>}
                <span class="muted">· {inUseText(r.inUse)}</span>
                {r.summary && <p class="muted">{r.summary}</p>}
                {r.readOnly && <p class="muted">Mirrors the live PUG config, so it is changed in the server cfg, not here.</p>}
                <div class="inlinerow">
                  {!r.readOnly && r.rules && editing !== r.id && (
                    <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => setEditing(r.id)}>Edit</button>
                  )}
                  {!r.template && (r.archived
                    ? <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => void run(() => adminApi.unarchiveRuleset(r.id))}>Unarchive</button>
                    : <button class="btn btn--ghost btn--sm" type="button" disabled={busy}
                        onClick={() => void run(() => adminApi.archiveRuleset(r.id), {
                          title: `Archive ${r.name}?`, body: 'It leaves every picker. Bookings and events that already use it keep their rules.', confirmLabel: 'Archive',
                        })}>Archive</button>)}
                </div>
                {editing === r.id && r.rules && (
                  <RulesetForm ruleset={r} rules={r.rules} busy={busy} error={error} onCancel={() => setEditing(null)}
                    onSave={(n, rules) => void run(async () => { await adminApi.updateRuleset(r.id, n, rules); setEditing(null); })} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel>
        <h3>New ruleset</h3>
        <p class="muted">A new ruleset starts as a copy of another. Copies are never rated and never give PUG penalties.</p>
        <form class="eventform" onSubmit={create}>
          <FormRow label="Copy from" for={`${uid}-from`}>
            <select id={`${uid}-from`} aria-label="Copy from" value={source === null ? '' : String(source)}
              onChange={(e) => setCopyFrom(Number((e.target as HTMLSelectElement).value))}>
              {data.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}{r.archived ? ' (archived)' : ''}</option>)}
            </select>
          </FormRow>
          <FormRow label="Name" help="3 to 40 characters, not used by another ruleset." for={`${uid}-name`}>
            <input id={`${uid}-name`} aria-label="New ruleset name" value={name} maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </FormRow>
          <div class="eventform__actions">
            <button class="btn" type="submit" disabled={busy || name.trim().length < 3}>Create copy</button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
