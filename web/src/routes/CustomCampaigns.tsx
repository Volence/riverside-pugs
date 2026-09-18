import { api, type CustomCampaignRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignTint } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** 300 MB, not 314572800. Nobody installing a campaign cares about bytes. */
function fileSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * How to install the campaigns this server runs beyond the stock four.
 *
 * Separate from /maps, which is stats about maps that have been played. This
 * page exists to answer one question: I could not join, what do I need? So the
 * instructions come first and the download is the most prominent control.
 */
export function CustomCampaigns() {
  const { data, error } = useFetch((s) => api.customCampaigns(s), []);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load custom campaigns.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const campaigns = data.campaigns;

  return (
    <div class="page page--list">
      <PageHeader title="Custom campaigns" />

      <Panel>
        <h3>Installing one</h3>
        <ol class="steps">
          <li>Download the <code>.vpk</code> below.</li>
          <li>
            Find your game folder: right click <strong>Left 4 Dead</strong> in your Steam library,
            then <strong>Manage</strong>, then <strong>Browse local files</strong>. That opens the
            folder Steam actually installed it to, which beats guessing the path.
          </li>
          <li>
            From there, open <code>left4dead</code>, then <code>addons</code>, and put the
            <code>.vpk</code> in it. Make the <code>addons</code> folder if it is not there.
          </li>
          <li>Restart Left 4 Dead. The campaign loads when a match starts on it.</li>
        </ol>
        <p class="muted">
          Everyone in the match needs the same file, and so does the server. If you join a match
          and the map never loads, this is almost always why.
        </p>
        <p class="muted">
          Anything marked <span class="ccamp__pool">In the vote</span> can come up in a real
          match, so install those first. The rest are here to play with and cannot be voted for.
        </p>
      </Panel>

      {campaigns.length === 0 ? (
        <Panel><Empty>No custom campaigns are installed yet.</Empty></Panel>
      ) : (
        <div class="stack">
          {campaigns.map((c: CustomCampaignRow) => (
            // Panel doesn't forward a style prop onto its <section>, so the
            // tint variable is set on this wrapper instead; .ccamp__head still
            // reads it, since a custom property inherits to any descendant.
            <div key={c.slug} style={{ '--campaign': campaignTint(c.slug) } as Record<string, string>}>
              <Panel>
                <div class="ccamp__head">
                  <h3>
                    {c.name}
                    {c.inPool && <span class="ccamp__pool">In the vote</span>}
                  </h3>
                  <a class="btn" href={`/download/campaign/${encodeURIComponent(c.slug)}`}
                     target="_blank" rel="noopener">
                    Download {fileSize(c.sizeBytes)}
                  </a>
                </div>
                <ol class="ccamp__chapters">
                  {c.chapters.filter((ch) => ch.included).map((ch) => (
                    <li key={ch.map}>{ch.display ?? ch.map}</li>
                  ))}
                </ol>
                {c.notes && <p>{c.notes}</p>}
                <p class="muted mono ccamp__hash">{c.filename} · sha256 {c.sha256.slice(0, 16)}...</p>
              </Panel>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
