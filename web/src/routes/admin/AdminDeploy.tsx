import { useState } from 'preact/hooks';
import { adminApi, type ReleaseReviewView, type ReleaseSummaryView } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction, type Run } from './useAction';

const STATE_LABEL: Record<string, string> = {
  staged: 'staged', pending: 'queued', waiting: 'waiting for the match to end', writing: 'writing', written: 'written',
  restarted: 'restarted', confirmed: 'confirmed', failed: 'failed', skipped: 'not targeted', undone: 'undone',
};

/** Admin > Setup > Deploy: commits of the deploy repo, the review of one
 *  against what each box has, the deploy form, and the history with undo. */
export function AdminDeploy() {
  const data = useFetch((s) => adminApi.releases(s), []);
  const [reviewId, setReviewId] = useState<number | null>(null);
  const review = useFetch((s) => (reviewId === null ? Promise.resolve(null) : adminApi.release(reviewId, s)), [reviewId]);
  const { busy, error, run } = useAction(() => { data.reload(); review.reload(); });
  if (data.error) return <Empty>Could not load the deploy page.</Empty>;
  const d = data.data;
  if (!d) return <p class="muted">Loading...</p>;

  const stage = (hash: string) => void run(async () => { const r = await adminApi.releaseStage(hash); setReviewId(r.id); });

  return (
    <div class="stack">
      {d.devMode && <p class="balance-banner">Deploys are disabled in dev mode. You can stage and review, but nothing is sent to a server.</p>}
      {error && <p class="error">{error}</p>}
      <Panel>
        <h3>Commits</h3>
        {d.fetchError && <p class="error">Could not fetch the deploy repo: {d.fetchError}</p>}
        <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => void run(() => adminApi.releasesRefresh())}>Refresh</button>
        <ul class="admin-list">
          {d.commits.map((c) => (
            <li key={c.hash} class="deploy-commit">
              <span><code>{c.short}</code> {c.subject} <span class="muted">{c.author}, {fmtTime(c.at)}</span></span>
              <button class="btn btn--sm" type="button" disabled={busy} aria-label={`Review ${c.short}`} onClick={() => stage(c.hash)}>Review</button>
            </li>
          ))}
        </ul>
      </Panel>
      {review.data && <ReviewPanel r={review.data} busy={busy} devMode={d.devMode} inFlight={d.inFlight} run={run} />}
      <Panel>
        <h3>History</h3>
        {d.releases.length === 0 ? <p class="muted">No releases yet.</p> : d.releases.map((r) => <HistoryRow key={r.id} r={r} busy={busy} run={run} />)}
      </Panel>
    </div>
  );
}

function ReviewPanel({ r, busy, devMode, inFlight, run }: { r: ReleaseReviewView; busy: boolean; devMode: boolean; inFlight: number | null; run: Run }) {
  const deployable = r.perBox.filter((b) => b.deployable);
  const [targets, setTargets] = useState<number[]>(deployable.map((b) => b.serverId));
  const [canaryOn, setCanaryOn] = useState(false);
  const [canary, setCanary] = useState<number | null>(deployable[0]?.serverId ?? null);
  const [decision, setDecision] = useState<'balance' | 'not_balance' | 'later' | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const toggle = (id: number) => setTargets(targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id]);
  const ready = r.state === 'staged' && !devMode && inFlight === null && targets.length > 0 && decision !== null && (decision !== 'balance' || name.trim() !== '');
  return (
    <Panel>
      <h3>Release {r.id}: <code>{r.short}</code> {r.subject}</h3>
      {r.github && <p><a href={r.github} target="_blank" rel="noreferrer">Diff on GitHub</a></p>}
      {r.invalid.length > 0 && <div class="balance-banner"><strong>Cannot be deployed:</strong><ul>{r.invalid.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      {r.groups.map((g) => (
        <div key={g.servers.join()} class="deploy-group">
          <h4>{g.servers.join(', ')}</h4>
          <ul class="admin-list">{g.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      ))}
      {r.perBox.flatMap((b) => b.warnings.map((w) => <p key={`${b.serverId}${w}`} class="balance-banner">{b.name}: {w}</p>))}
      {r.state === 'staged' && (
        <form class="admin-form admin-form--stack" onSubmit={(e) => {
          e.preventDefault();
          const names = deployable.filter((b) => targets.includes(b.serverId)).map((b) => b.name).join(', ');
          void run(() => adminApi.releaseDeploy(r.id, { targets, canary: canaryOn ? canary : null,
            balance: decision === 'balance' ? { decision, name: name.trim(), notes } : { decision: decision! } }),
          `Deploy release ${r.id} (${r.short}) to ${names}?`);
        }}>
          <fieldset><legend>Send to</legend>
            {deployable.map((b) => <label key={b.serverId}><input type="checkbox" checked={targets.includes(b.serverId)} onChange={() => toggle(b.serverId)} /> {b.name}</label>)}
          </fieldset>
          <label><input type="checkbox" checked={canaryOn} onChange={() => setCanaryOn(!canaryOn)} /> Canary first</label>
          {canaryOn && (
            <select aria-label="Canary box" value={canary ?? ''} onChange={(e) => setCanary(Number((e.target as HTMLSelectElement).value))}>
              {deployable.filter((b) => targets.includes(b.serverId)).map((b) => <option key={b.serverId} value={b.serverId}>{b.name}</option>)}
            </select>
          )}
          <fieldset><legend>Balance</legend>
            <p class="muted">Suggestion: {r.suggestion === 'not_balance' ? 'probably not a balance change' : 'possibly a balance change'}.</p>
            {(['balance', 'not_balance', 'later'] as const).map((k) => (
              <label key={k}><input type="radio" name="decision" checked={decision === k} onChange={() => setDecision(k)} />
                {' '}{k === 'balance' ? 'Balance patch' : k === 'not_balance' ? 'Not balance' : 'Decide later'}</label>
            ))}
          </fieldset>
          {decision === 'balance' && <>
            <input value={name} maxLength={60} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <textarea value={notes} maxLength={2000} placeholder="Notes" aria-label="Patch notes" onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
          </>}
          <button class="btn" type="submit" disabled={busy || !ready}>Deploy</button>
        </form>
      )}
    </Panel>
  );
}

function HistoryRow({ r, busy, run }: { r: ReleaseSummaryView; busy: boolean; run: Run }) {
  const reached = r.boxes.filter((b) => ['written', 'restarted', 'confirmed'].includes(b.state));
  return (
    <div class="deploy-history">
      <p>
        <strong>{r.kind === 'undo' ? `Undo of release ${r.undoOf}` : `Release ${r.id}`}</strong> <code>{r.short}</code> · {r.state}
        {r.deployedAt && <span class="muted"> · {fmtTime(r.deployedAt)}</span>}
        {r.balance && <span class="muted"> · {r.balance.decision === 'balance' ? `balance: ${r.balance.name}` : r.balance.decision === 'not_balance' ? 'not balance' : 'balance: decide later'}</span>}
      </p>
      <ul class="admin-list">
        {r.boxes.map((b) => (
          <li key={b.serverId} class={b.state === 'failed' ? 'admin-warn' : ''}>
            {b.name}: {STATE_LABEL[b.state] ?? b.state}{b.error && <span class="error"> ({b.error})</span>}
            {r.kind === 'deploy' && !r.backupsExpired && reached.some((x) => x.serverId === b.serverId) && (
              <> <button class="btn btn--ghost btn--sm" type="button" disabled={busy} aria-label={`Undo release ${r.id} on ${b.name}`}
                onClick={() => void run(() => adminApi.releaseUndo(r.id, [b.serverId]), `Undo release ${r.id} on ${b.name}?`)}>Undo</button></>
            )}
          </li>
        ))}
      </ul>
      {r.state === 'canary_wait' && <button class="btn" type="button" disabled={busy} onClick={() => void run(() => adminApi.releaseContinue(r.id))}>Continue to the rest</button>}
      {r.kind === 'deploy' && r.backupsExpired && <p class="muted">Backups expired.</p>}
    </div>
  );
}
