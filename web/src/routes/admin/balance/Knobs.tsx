import { useLayoutEffect, useState } from 'preact/hooks';
import { adminApi, type KnobPreview, type KnobView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, useAction } from '../useAction';
import { serverStateText, snapKnob } from './knobs';

const patchLabel = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;
const RESTORE_NOTE = 'Only knob values change: plugins and files stay as they are now, so the result can be a new patch.';

/** The balance control panel: draft knob values, preview the predicted
 *  patch, apply to every server, and follow the rollout per server.
 *  docs/superpowers/specs/2026-09-24-balance-control-panel-design.md */
export function Knobs() {
  const st = useFetch((s) => adminApi.balanceKnobs(s), []);
  // useAction reloads after every run; preview and restore must not.
  const { busy, error, run } = useAction(() => {});
  const applyAction = useAction(st.reload);
  const [seeded, setSeeded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<KnobPreview | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [restoreId, setRestoreId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [patchNotes, setPatchNotes] = useState('');
  const [confirm, setConfirm] = useState('');

  const data = st.data;
  // The draft starts from the current values once, and again only after an
  // apply; a reload must never overwrite what the admin is editing.
  // useLayoutEffect, not useEffect: it must land in the same synchronous
  // commit as the data-loaded render, or a click between the two (the data
  // render is observable before a merely-scheduled effect runs) can seed the
  // draft over the top of what was just typed.
  useLayoutEffect(() => { if (data && !seeded) { setDraft({ ...data.current }); setSeeded(true); } }, [data, seeded]);
  useLayoutEffect(() => { if (data && restoreId === null && data.restorable[0]) setRestoreId(data.restorable[0].id); }, [data]);

  if (st.error) return <Empty>Could not load the knob panel.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;

  const edit = (next: Record<string, string>) => { setDraft(next); setPreview(null); setConfirm(''); };
  const groups = [...new Set(data.knobs.map((k) => k.group))];
  const existing = preview?.existingPatch ?? null;
  const expectedName = existing?.name ?? name.trim();
  const canApply = !!preview && preview.errors.length === 0 && preview.missing.length === 0 && preview.blocking.length === 0
    && (preview.diff.length > 0 || existing !== null) && expectedName !== '' && confirm.trim() === expectedName
    && (existing !== null || patchNotes.trim() !== '');

  const row = (k: KnobView) => (
    <div class="admin-form" key={k.cvar}>
      <label>
        <span>{k.label}{k.unit ? ` (${k.unit})` : ''}</span>
        <input type="number" aria-label={k.label} min={k.min} max={k.max} step={k.step} value={draft[k.cvar] ?? ''}
          onChange={(e) => edit({ ...draft, [k.cvar]: snapKnob(k, (e.target as HTMLInputElement).value) })} />
      </label>
      <span class="muted">now {data.current[k.cvar]}, baseline {k.baseline}, range {k.min} to {k.max}{k.note ? `. ${k.note}` : ''}</span>
    </div>
  );

  return (
    <div class="stack">
      <Panel>
        <h3>Servers</h3>
        {data.base ? <p class="muted">Predicting from patch #{data.base.number}, the latest queue match.</p>
          : <p class="error">No queue match has a fingerprint yet: nothing to predict from.</p>}
        {data.missing.length > 0 && <p class="error">Not reported by the servers: {data.missing.join(', ')}.</p>}
        {data.blocking.map((b) => (
          <p class="error" key={b.serverId}>{b.name} differs in more than knob values: {b.diff}. Disable it or fix it before applying.</p>
        ))}
        {data.active && (
          <div>
            <p>Rollout of patch #{data.active.patchNumber} {data.active.patchName ?? ''}, {fmtTime(data.active.createdAt)} by {data.active.createdByName ?? data.active.createdBy}</p>
            <ul class="admin-list">
              {data.active.servers.map((s) => <li key={s.serverId}>{s.name}: {serverStateText(s, data.active!.patchNumber)}</li>)}
            </ul>
          </div>
        )}
      </Panel>
      <Panel>
        <h3>Knobs</h3>
        {groups.map((g) => (
          <fieldset key={g}>
            <legend>{g}</legend>
            {data.knobs.filter((k) => k.group === g).map(row)}
          </fieldset>
        ))}
        <div class="admin-form">
          <button class="btn" type="button" onClick={() => { edit(Object.fromEntries(data.knobs.map((k) => [k.cvar, k.baseline]))); setNotes([]); }}>Reset to baseline</button>
          <select aria-label="Restore from patch" value={restoreId ?? ''} onChange={(e) => setRestoreId(Number((e.target as HTMLSelectElement).value))}>
            {data.restorable.map((p) => <option key={p.id} value={p.id}>#{p.number} {patchLabel(p)}</option>)}
          </select>
          <button class="btn" type="button" disabled={busy || restoreId === null} onClick={() => void run(async () => {
            const r = await adminApi.balanceKnobsRestore(restoreId!);
            edit(r.values);
            setNotes([...r.notes, RESTORE_NOTE]);
          })}>Restore</button>
          <button class="btn" type="button" disabled={busy} onClick={() => void run(async () => {
            const p = await adminApi.balanceKnobsPreview(draft);
            setPreview(p);
            setName(p.existingPatch?.name ?? '');
            setPatchNotes('');
            setConfirm('');
          })}>Preview</button>
        </div>
        {notes.map((n) => <p class="muted" key={n}>{n}</p>)}
        {error && <p class="error">{error}</p>}
      </Panel>
      {preview && (
        <Panel>
          <h3>Preview</h3>
          {preview.errors.map((e) => <p class="error" key={e}>{e}</p>)}
          {preview.diff.length === 0 ? <p class="muted">No knob changes from what the servers should be running now.</p> : (
            <table class="admin-table">
              <thead><tr><th>Knob</th><th>Now</th><th>New</th></tr></thead>
              <tbody>{preview.diff.map((d) => <tr key={d.cvar}><td>{d.label}</td><td>{d.from}</td><td>{d.to}</td></tr>)}</tbody>
            </table>
          )}
          {preview.groupsChanged.length > 1 && (
            <p class="admin-warn">This changes knobs in more than one group ({preview.groupsChanged.join(', ')}): their effects cannot be told apart.</p>
          )}
          {existing
            ? <p>Matches existing patch #{existing.number} {patchLabel(existing)}: applying restores it.</p>
            : preview.fingerprint && <p>New patch, fingerprint {preview.fingerprint}.</p>}
          <form class="admin-form" onSubmit={(e) => {
            e.preventDefault();
            if (!canApply) return;
            void applyAction.run(async () => {
              await adminApi.balanceKnobsApply({ values: preview.values, name: name.trim(), notes: patchNotes });
              setPreview(null);
              setConfirm('');
              setSeeded(false);
              setRestoreId(null);
            });
          }}>
            {(!existing || !existing.name) && (
              <input value={name} maxLength={60} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            )}
            {(!existing || !existing.notes) && (
              <textarea value={patchNotes} maxLength={2000} placeholder="What changed and why" aria-label="Patch notes"
                onInput={(e) => setPatchNotes((e.target as HTMLTextAreaElement).value)} />
            )}
            <p class="muted">Servers: {data.active?.servers.map((s) => s.name).join(', ') || 'every enabled server'}. Each gets the file between matches.</p>
            <input value={confirm} placeholder={expectedName || 'patch name'} aria-label="Type the patch name to confirm"
              onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
            <button class="btn" type="submit" disabled={busy || applyAction.busy || !canApply}>Apply to all servers</button>
            {applyAction.error && <p class="error">{applyAction.error}</p>}
          </form>
        </Panel>
      )}
    </div>
  );
}
