import { useState } from 'preact/hooks';
import { adminApi, type PatchDetail, type PatchSummary } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

const label = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;

/** Server drift, the patch list (with an "approximate" tag for a patch
 *  reconstructed from history rather than fingerprinted live) and a detail
 *  panel to rename a patch and mark it reviewed.
 *
 *  "approximate" reuses .admin-tag and the unreviewed-row highlight reuses
 *  .admin-warn: the brief's own badge/unreviewed classes do not exist in
 *  app.css, and these are the closest existing ones doing the same job
 *  elsewhere in the admin pages (see AdminCampaigns' "draft" tag and
 *  SteamAccountPanel's warning text). */
export function AdminPatches() {
  const patches = useFetch((s) => adminApi.balancePatches(s), []);
  const drift = useFetch((s) => adminApi.balanceDrift(s), []);
  const [open, setOpen] = useState<PatchDetail | null>(null);
  const { busy, error, run } = useAction(patches.reload);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const differing = (drift.data?.servers ?? []).flatMap((s) =>
    s.differsFrom.map((d) => `${s.name} differs from ${d.name}: ${d.diff}`));

  const openDetail = (p: PatchSummary) => {
    setName(p.name ?? '');
    setNotes(p.notes ?? '');
    void run(() => adminApi.balancePatch(p.id).then(setOpen));
  };

  return (
    <div class="stack">
      <Panel>
        <h3>Server drift</h3>
        {drift.error && <Empty>Could not load server drift.</Empty>}
        {!drift.error && (differing.length === 0
          ? <p class="muted">All servers are running the same balance config.</p>
          : <ul class="admin-list">{differing.map((t) => <li key={t}>{t}</li>)}</ul>)}
      </Panel>
      <Panel class="panel--table">
        <h3>Patches</h3>
        {error && <p class="error">{error}</p>}
        {patches.error && <Empty>Could not load the patch list.</Empty>}
        {!patches.error && (
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>#</th><th>Name</th><th>Source</th><th>Since</th><th>Rounds</th><th>Servers</th><th /></tr></thead>
              <tbody>
                {(patches.data?.patches ?? []).map((p) => (
                  <tr key={p.id} class={!p.reviewed && p.source === 'detected' ? 'admin-warn' : ''}>
                    <td>{p.number}</td>
                    <td>{label(p)}</td>
                    <td>{p.source === 'historical' ? <span class="admin-tag">approximate</span> : p.source}</td>
                    <td>{fmtTime(p.firstSeenAt)}</td>
                    <td>{p.source === 'announced' && p.rounds === 0 ? 'never played' : p.rounds}</td>
                    <td>{p.servers.map((s) => s.name).join(', ')}</td>
                    <td><button class="btn" type="button" disabled={busy} onClick={() => openDetail(p)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {open && (
        <Panel>
          <h3>{label(open)}</h3>
          <form class="admin-form" onSubmit={(e) => {
            e.preventDefault();
            void run(() => adminApi.editBalancePatch(open.id, { name: name.trim() || null, notes, reviewed: true })).then(() => setOpen(null));
          }}>
            <input value={name} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <textarea
              value={notes}
              maxLength={2000}
              placeholder="Notes"
              aria-label="Patch notes"
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
            />
            <button class="btn" type="submit" disabled={busy}>Save and mark reviewed</button>
          </form>
          {open.diffVsPrevious
            ? <ul class="admin-list">
              {open.diffVsPrevious.added.map((k) => <li key={`a${k}`}>added {k}</li>)}
              {open.diffVsPrevious.removed.map((k) => <li key={`r${k}`}>removed {k}</li>)}
              {open.diffVsPrevious.changed.map((c) => <li key={`c${c.key}`}>{c.key}: {c.from} to {c.to}</li>)}
            </ul>
            : <p class="muted">No recorded inventory to compare (historical or first patch).</p>}
        </Panel>
      )}
    </div>
  );
}
