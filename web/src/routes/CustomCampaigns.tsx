import { api, type CustomCampaignRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignTint, chapterName } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { Figure, Figures, PageHeader } from '../components/PageHeader';
import { DocLayout, type DocSection } from '../components/DocLayout';
import { L4D2Pack, L4D2_PACK_SIZE } from './L4D2Pack';

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
  const campaigns = data?.campaigns ?? null;

  // The L4D2 pack section needs no data, so it renders at once and a
  // /custom-campaigns#l4d2-pack link lands on it before the list has loaded.
  return (
    <div class="page page--list">
      <PageHeader eyebrow="Downloads" title="Custom campaigns">
        <Figures>
          <Figure label="L4D2 campaigns" value={L4D2_PACK_SIZE} sub="every one, in one download" />
          {campaigns && <Figure label="Custom campaigns" value={campaigns.length} sub="beyond the stock four" />}
          {campaigns && <Figure label="In the match vote" value={campaigns.filter((c) => c.inPool).length} sub="can come up in a match" />}
        </Figures>
      </PageHeader>
      <DocLayout sections={SECTIONS}>
        <L4D2Pack />
        <CampaignList data={data} error={error} />
      </DocLayout>
    </div>
  );
}

const SECTIONS: DocSection[] = [
  { id: 'l4d2-pack', label: 'The L4D2 campaigns' },
  { id: 'installing', label: 'Installing one' },
  { id: 'campaigns', label: 'The campaigns' },
];

function CampaignList({ data, error }: { data: { campaigns: CustomCampaignRow[] } | null | undefined; error: unknown }) {
  if (error) return <Panel><Empty>Couldn't load custom campaigns.</Empty></Panel>;
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const campaigns = data.campaigns;
  // The vote ones first: they are the ones a player can be dropped into.
  const groups = [
    { key: 'vote', title: 'In the match vote', list: campaigns.filter((c) => c.inPool) },
    { key: 'rest', title: 'To play with', list: campaigns.filter((c) => !c.inPool) },
  ].filter((g) => g.list.length > 0);

  return (
    <>
      <Panel id="installing">
        <h3>Installing one</h3>
        <ol class="steps">
          <li>
            Download it below and unzip it. Inside is one <code>.vpk</code> file, the campaign
            itself.
          </li>
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

      <Panel id="campaigns">
        <h3>The campaigns</h3>
        {campaigns.length === 0 ? (
          <Empty>No custom campaigns are installed yet.</Empty>
        ) : groups.map((g) => (
          <section key={g.key} class="ccgroup">
            <h4 class="ccgroup__title">{g.title} <span class="ccgroup__count">{g.list.length}</span></h4>
            <ul class="ccgrid">
              {g.list.map((c) => <CampaignCard key={c.slug} c={c} />)}
            </ul>
          </section>
        ))}
      </Panel>
    </>
  );
}

function CampaignCard({ c }: { c: CustomCampaignRow }) {
  const chapters = c.chapters.filter((ch) => ch.included);
  return (
    <li class="cccard" style={{ '--campaign': campaignTint(c.slug) } as Record<string, string>}>
      <div class="cccard__head">
        <h5 class="cccard__name">{c.name}</h5>
        <div class="cccard__chips">
          {c.inPool && <span class="ccamp__pool">In the vote</span>}
          {c.practiceOnly && <span class="ccamp__pool">Practice map</span>}
          {c.needsL4d2Pack && <span class="ccamp__pool ccamp__pool--needs">Needs L4D2 pack</span>}
        </div>
      </div>
      <ol class="cccard__chapters">
        {chapters.map((ch) => <li key={ch.map}>{chapterName(ch.display, ch.map)}</li>)}
      </ol>
      {c.needsL4d2Pack && (
        <p class="ccamp__needs">
          Also needs the <a href="#l4d2-pack">L4D2 campaigns pack</a> above. This one
          was converted from L4D2 and uses its models and textures from the pack, so
          without it you will see missing textures and error models.
        </p>
      )}
      {c.notes && <p class="cccard__notes">{c.notes}</p>}
      <div class="cccard__foot">
        <a class="btn cccard__get" href={`/download/campaign/${encodeURIComponent(c.slug)}`}
           target="_blank" rel="noopener">
          Download {fileSize(c.zipBytes ?? c.sizeBytes)}
        </a>
        <p class="muted mono ccamp__hash">{c.filename}{c.zipBytes != null && ' (zipped)'} · sha256 {c.sha256.slice(0, 16)}...</p>
      </div>
    </li>
  );
}
