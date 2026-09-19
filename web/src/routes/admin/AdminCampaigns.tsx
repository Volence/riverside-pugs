import { useState } from 'preact/hooks';
import { adminApi, type AdminCampaign, type AdminChapter, type AdminInstall } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { chapterName } from '../../format';
import { useAction } from './useAction';

/** These are hundreds-of-megabytes VPKs; nobody sizing free disk against an
 *  upload wants to read it in bytes. */
function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Every enabled server must have the VPK before a campaign is eligible to
 *  enter the pool at all: GET /api/admin/settings (src/routes/admin.ts) only
 *  offers a custom campaign as a pool candidate once this and `enabled` both
 *  hold, and validateSetting enforces the same rule against a direct PUT.
 *  This is the eligibility check, not the pool itself; a campaign that was
 *  already pooled and later fails this stays selectable there rather than
 *  disappearing (see poolableCampaigns's alsoAllow). */
function installedEverywhere(c: AdminCampaign, serverIds: number[]): boolean {
  const ok = new Set(c.installs.filter((i) => i.state === 'installed').map((i) => i.server_id));
  return serverIds.length > 0 && serverIds.every((id) => ok.has(id));
}

type Run = (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;

/** `playCount` dims the chapters a stop-point rule drops, so the chapter list
 *  and the MapsToPlay control right below it visibly agree about which
 *  chapters are actually going to be played. Omitted entirely (drafts) means
 *  nothing is dimmed. */
function ChapterList({ chapters, playCount }: { chapters: AdminChapter[]; playCount?: number }) {
  const included = chapters.filter((ch) => ch.included === 1);
  if (included.length === 0) return <p class="muted">No chapters parsed.</p>;
  return (
    <ol class="admin-list">
      {included.map((ch, i) => (
        // Every chapter of a campaign shares its slug; ordinal is what is
        // actually unique per chapter.
        <li key={ch.ordinal} class={playCount !== undefined && i >= playCount ? 'muted' : undefined}>
          {chapterName(ch.display, ch.map)}
          {ch.is_finale === 1 && <span class="admin-tag">finale</span>}
        </li>
      ))}
    </ol>
  );
}

/** How many maps this campaign plays. The empty value is the default, which is
 *  every chapter but the last: the same thing the plugin does unprompted, so an
 *  unconfigured campaign and a campaign explicitly set to its default behave
 *  identically rather than taking different code paths. */
function MapsToPlay(
  { c, busy, run }: { c: AdminCampaign; busy: boolean; run: Run },
) {
  if (c.maps.length === 0) {
    return <p class="muted">Chapters unknown, so this campaign plays its default.</p>;
  }
  return (
    <label>
      Plays{' '}
      <select
        aria-label="Maps to play"
        disabled={busy}
        value={c.mapsToPlay === null ? '' : String(c.mapsToPlay)}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          run(() => adminApi.setMapsToPlay(c.slug, v === '' ? null : Number(v)));
        }}
      >
        <option value="">Default ({Math.max(c.maps.length - 1, 1)} maps, no finale)</option>
        {c.maps.map((_m, i) => (
          <option key={i} value={String(i + 1)}>
            {i + 1} map{i === 0 ? '' : 's'}{i + 1 === c.maps.length ? ' (includes the finale)' : ''}
          </option>
        ))}
      </select>
      {' '}
      <span class="muted">Takes effect next match. Nothing is reinstalled.</span>
    </label>
  );
}

/** How many maps a mapsToPlay-less card should treat as played, for dimming
 *  purposes: the same default the plugin and stopAfterMap fall back to. */
function playCountOf(c: AdminCampaign): number {
  return c.mapsToPlay ?? Math.max(c.maps.length - 1, 1);
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
      <ChapterList chapters={c.chapters} playCount={playCountOf(c)} />
      <MapsToPlay c={c} busy={busy} run={run} />
      <InstallList installs={c.installs} serverNames={serverNames} />
      <div class="admin-row">
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
      {/* Being installed everywhere is the only precondition now. There used to
          be a checkbox here as well, but once downloads stopped depending on it
          its only job was permitting the Settings tab to offer the campaign,
          which cost a click and read as if it did the pooling itself. */}
      {!ok
        ? <p class="muted">Not on every server yet, so it cannot be added to the vote. Players can still download it.</p>
        : <p class="muted">Installed everywhere and downloadable. Add it to the vote on the Settings tab.</p>}
    </Panel>
  );
}

/** One of the stock four: no VPK, so no upload, install state, reinstall or
 *  delete. Still gets a stop-point control, because an admin wants to drop
 *  a stock finale for exactly the reason they'd drop a custom one. */
function StockCard({ c, busy, run }: { c: AdminCampaign; busy: boolean; run: Run }) {
  return (
    <Panel>
      <h3>{c.name} <span class="admin-tag">stock</span></h3>
      <MapsToPlay c={c} busy={busy} run={run} />
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

  // null when no upload is in flight; a 0..1 fraction while one is, or -1 when
  // the browser will not say how large the body is.
  const [progress, setProgress] = useState<number | null>(null);

  const onUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared immediately, not just on success: a rejected upload (409, 413,
    // 507, 400) must not leave the same file sitting in the control looking
    // like it is still queued.
    input.value = '';
    if (!file) return;
    setProgress(0);
    try {
      await run(() => adminApi.uploadCampaign(file, (f) => setProgress(f ?? -1)));
    } finally {
      // Cleared on every path. A failed upload that left the bar on screen
      // would read as still running, which is the confusion this whole control
      // exists to remove.
      setProgress(null);
    }
  };

  const uploading = progress !== null;

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  const drafts = data.campaigns.filter((c) => c.state === 'draft');
  const published = data.campaigns.filter((c) => c.state === 'published' && !c.stock);
  const stock = data.campaigns.filter((c) => c.stock);

  return (
    <div class="stack">
      <Panel>
        <div class="admin-row">
          <span class="muted">
            {data.free === null ? 'Free disk space unknown.' : `${gb(data.free)} free`}
          </span>
          <input type="file" accept=".vpk" aria-label="Upload campaign" disabled={busy} onChange={onUpload} />
        </div>
        {uploading && (
          <div class="upprog" role="status" aria-live="polite">
            <div class="upprog__bar">
              <div
                class={`upprog__fill${progress === -1 ? ' is-indeterminate' : ''}`}
                style={progress !== null && progress >= 0 ? { width: `${Math.round(progress * 100)}%` } : undefined}
              />
            </div>
            <span class="muted">
              {progress === -1
                ? 'Uploading...'
                : `Uploading ${Math.round((progress ?? 0) * 100)}%`}
              {' '}Large campaigns take a few minutes. Do not close this tab.
            </span>
          </div>
        )}
        {error && <p class="error">{error}</p>}
      </Panel>

      {/* The stock four always have a row (they need no upload to exist), so
          this is keyed on custom campaigns specifically, not the raw list. */}
      {drafts.length === 0 && published.length === 0
        && <Panel><Empty>No custom campaigns uploaded yet.</Empty></Panel>}

      {drafts.map((c) => <DraftCard key={c.slug} c={c} busy={busy} run={run} />)}
      {published.map((c) => (
        <PublishedCard key={c.slug} c={c} busy={busy} run={run} serverIds={serverIds} serverNames={serverNames} />
      ))}
      {stock.map((c) => <StockCard key={c.slug} c={c} busy={busy} run={run} />)}
    </div>
  );
}
