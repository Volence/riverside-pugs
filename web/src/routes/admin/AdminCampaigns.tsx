import { useState } from 'preact/hooks';
import { adminApi, type AdminCampaign, type AdminChapter, type AdminInstall } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { useAction } from './useAction';

/** These are hundreds-of-megabytes VPKs; nobody sizing free disk against an
 *  upload wants to read it in bytes. */
function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Every enabled server must have the VPK before a campaign can be voted for.
 *  The orchestrator re-checks this at match start too, because this answer can
 *  go stale, but refusing here is what keeps it out of the vote in the first
 *  place. */
function installedEverywhere(c: AdminCampaign, serverIds: number[]): boolean {
  const ok = new Set(c.installs.filter((i) => i.state === 'installed').map((i) => i.server_id));
  return serverIds.length > 0 && serverIds.every((id) => ok.has(id));
}

type Run = (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;

function ChapterList({ chapters }: { chapters: AdminChapter[] }) {
  const included = chapters.filter((ch) => ch.included === 1);
  if (included.length === 0) return <p class="muted">No chapters parsed.</p>;
  return (
    <ol class="admin-list">
      {included.map((ch) => (
        <li key={ch.slug}>
          {ch.display ?? ch.map}
          {ch.is_finale === 1 && <span class="admin-tag">finale</span>}
        </li>
      ))}
    </ol>
  );
}

/** One row per server this campaign has an install record for. A campaign
 *  with no install rows at all (freshly published, before the orchestrator
 *  has pushed it anywhere) renders nothing here; the pool gate below still
 *  refuses it, since an empty install list satisfies no server. */
function InstallList({ installs, serverNames }: { installs: AdminInstall[]; serverNames: Map<number, string> }) {
  if (installs.length === 0) return <p class="muted">Not installed on any server yet.</p>;
  const tone = (state: AdminInstall['state']) => (state === 'installed' ? 'active' : state === 'failed' ? 'banned' : 'invited');
  return (
    <ul class="admin-list">
      {installs.map((i) => (
        <li key={i.server_id}>
          <span class={`admin-status admin-status--${tone(i.state)}`}>
            {serverNames.get(i.server_id) ?? `Server ${i.server_id}`}: {i.state}
          </span>
          {i.error && <p class="error">{i.error}</p>}
        </li>
      ))}
    </ul>
  );
}

/** A parsed-but-unpublished upload. The name comes back from the VPK's own
 *  mission data and is usually fine, but it is the one thing an admin cannot
 *  fix by re-uploading, so it is editable here before it goes live. */
function DraftCard({ c, busy, run }: { c: AdminCampaign; busy: boolean; run: Run }) {
  const [name, setName] = useState(c.name);
  return (
    <Panel>
      <h3>{c.name} <span class="admin-tag">draft</span></h3>
      <ChapterList chapters={c.chapters} />
      <div class="admin-form">
        <input value={name} aria-label="Campaign name" placeholder="Campaign name"
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <button class="btn" disabled={busy || !name.trim()}
          onClick={() => run(() => adminApi.publishCampaign(c.slug, name.trim()))}>
          Publish
        </button>
      </div>
    </Panel>
  );
}

function PublishedCard(
  { c, busy, run, serverIds, serverNames }: {
    c: AdminCampaign; busy: boolean; run: Run; serverIds: number[]; serverNames: Map<number, string>;
  },
) {
  const ok = installedEverywhere(c, serverIds);
  return (
    <Panel>
      <div class="admin-row">
        <h3>{c.name}</h3>
        <span class="muted">{gb(c.size_bytes)}</span>
      </div>
      <ChapterList chapters={c.chapters} />
      <InstallList installs={c.installs} serverNames={serverNames} />
      <div class="admin-row">
        <label>
          <input
            type="checkbox"
            aria-label="In the pool"
            checked={c.enabled === 1}
            disabled={!ok}
            onChange={(e) => run(() => adminApi.setCampaignEnabled(c.slug, (e.target as HTMLInputElement).checked))}
          />
          In the pool
        </label>
        <button class="chip" disabled={busy} onClick={() => run(() => adminApi.reinstallCampaign(c.slug))}>
          Reinstall
        </button>
        <button class="chip" disabled={busy}
          onClick={() => run(
            () => adminApi.deleteCampaign(c.slug),
            `Delete ${c.name}? This removes the VPK from every server that has it.`,
          )}>
          Delete
        </button>
      </div>
      {!ok && <p class="muted">Not on every server yet, so it cannot be voted for.</p>}
    </Panel>
  );
}

/**
 * Upload, publish, watch install, and pool a custom campaign.
 *
 * `serverIds` (the enabled servers, from the admin overview the Matches tab
 * already fetches) decides which installs the pool gate checks. Uploading
 * these files is a few hundred megabytes over HTTP, so the input disables
 * itself for the duration rather than risk a double submit.
 */
export function AdminCampaigns() {
  const { data, reload } = useFetch((s) => adminApi.campaigns(s), []);
  const overview = useFetch((s) => adminApi.overview(s), []);
  const { busy, error, run } = useAction(reload);

  const servers = overview.data?.servers ?? [];
  const serverIds = servers.filter((s) => s.enabled === 1).map((s) => s.id);
  const serverNames = new Map(servers.map((s) => [s.id, s.name]));

  const onUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared immediately, not just on success: a rejected upload (409, 413,
    // 507, 400) must not leave the same file sitting in the control looking
    // like it is still queued.
    input.value = '';
    if (!file) return;
    await run(() => adminApi.uploadCampaign(file));
  };

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  const drafts = data.campaigns.filter((c) => c.state === 'draft');
  const published = data.campaigns.filter((c) => c.state === 'published');

  return (
    <div class="stack">
      <Panel>
        <div class="admin-row">
          <span class="muted">
            {data.free === null ? 'Free disk space unknown.' : `${gb(data.free)} free`}
          </span>
          <input type="file" accept=".vpk" aria-label="Upload campaign" disabled={busy} onChange={onUpload} />
        </div>
        {error && <p class="error">{error}</p>}
      </Panel>

      {data.campaigns.length === 0 && <Panel><Empty>No custom campaigns uploaded yet.</Empty></Panel>}

      {drafts.map((c) => <DraftCard key={c.slug} c={c} busy={busy} run={run} />)}
      {published.map((c) => (
        <PublishedCard key={c.slug} c={c} busy={busy} run={run} serverIds={serverIds} serverNames={serverNames} />
      ))}
    </div>
  );
}
