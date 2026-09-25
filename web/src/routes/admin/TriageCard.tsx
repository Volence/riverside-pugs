import { useState } from 'preact/hooks';
import { adminApi, type PatchSummary } from '../../api';
import { Panel } from '../../components/bits';
import type { Run } from './useAction';

const label = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;

/** One pending patch: what changed in plain words, which servers run it, and
 *  the three decisions. No default: every button is an explicit choice. The
 *  ignore button shows only while the chosen target is the card's base,
 *  because the plugin-only check and the plugin list are worked out against
 *  that base (the server checks again). */
export function TriageCard({ patch, targets, run, busy }: {
  patch: PatchSummary;
  /** Balance patches it can be folded into, newest first. */
  targets: PatchSummary[];
  run: Run;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const base = patch.triageBase ?? null;
  // Only a balance patch can be folded into; the server picks the base from those.
  const [into, setInto] = useState<number | null>(
    base && targets.some((t) => t.id === base.id) ? base.id : targets[0]?.id ?? null);
  const changes = patch.changes ?? [];
  const options = targets;
  return (
    <Panel>
      <h3>Needs triage: {label(patch)}</h3>
      <p class="muted">
        Compared with {base ? label(base) : 'no earlier patch'}
        {base?.needsTriage && ' (not triaged yet, so nothing can be folded into it: triage that one first)'}
        {patch.servers.length > 0 && <>; running on {patch.servers.map((s) => s.name).join(', ')}</>}.
      </p>
      {patch.releaseId != null && <p class="muted">From release {patch.releaseId}.</p>}
      {changes.length > 0
        ? <ul class="admin-list">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
        : <p class="muted">No recorded differences to show.</p>}
      {patch.onlyPluginsChanged && (
        <p class="balance-banner">Only plugins changed. Probably not a balance change, but plugin updates can be (sky pounce 0.4.0 was).</p>
      )}
      <form class="admin-form admin-form--stack" onSubmit={(e) => {
        e.preventDefault();
        void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'balance', name: name.trim(), notes }));
      }}>
        <input value={name} maxLength={60} placeholder="Patch name" aria-label={`Name for patch ${patch.number}`}
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <textarea value={notes} maxLength={2000} placeholder="Notes" aria-label={`Notes for patch ${patch.number}`}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
        <button class="btn" type="submit" disabled={busy || name.trim() === ''}>Balance patch</button>
      </form>
      <div class="admin-form">
        <label>Fold into{' '}
          <select value={into ?? ''} aria-label={`Fold target for patch ${patch.number}`}
            onChange={(e) => setInto(Number((e.target as HTMLSelectElement).value))}>
            {options.map((t) => <option key={t.id} value={t.id}>#{t.number} {label(t)}</option>)}
          </select>
        </label>
        <button class="btn" type="button" disabled={busy || into === null}
          onClick={() => void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'fold', into: into! }))}>
          Not balance, fold just this once
        </button>
        {patch.onlyPluginsChanged && into !== null && into === base?.id && (
          <button class="btn" type="button" disabled={busy}
            onClick={() => void run(() => adminApi.triageBalancePatch(patch.id, { decision: 'ignore', into, plugins: patch.plugins ?? [] }))}>
            Not balance, ignore these plugins from now on
          </button>
        )}
      </div>
    </Panel>
  );
}
