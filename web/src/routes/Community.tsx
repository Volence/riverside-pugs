import { useState } from 'preact/hooks';
import { communityApi, type CommunityKind } from '../api';
import type { Session } from '../hooks/useLiveState';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { HudTabs } from '../components/HudTabs';
import { CommunityCard } from '../components/CommunityCard';

/** Every share, the viewer's own, or the ones they liked. */
type Show = 'all' | 'yours' | 'liked';

/**
 * /community: the HUDs and crosshairs players shared from the HUD editor and
 * the crosshair maker. Two tabs, New or Top, 24 a page, and for a signed-in
 * viewer All, Yours or Liked.
 *
 * The tab starts from ?kind=crosshair when a link asks for it (a profile's
 * crosshair, say); after that the page keeps its own state and leaves the
 * URL alone, as the leaderboard's season picker does.
 */
export function Community({ session }: { session: Session }) {
  const [kind, setKind] = useState<CommunityKind>(() =>
    new URLSearchParams(location.search).get('kind') === 'crosshair' ? 'crosshair' : 'hud');
  const [sort, setSort] = useState<'new' | 'top'>('new');
  const [page, setPage] = useState(0);
  // Yours and Liked need someone signed in; a signed-out viewer sees All alone.
  const viewer = session.kind === 'active' || session.kind === 'pending' ? session.me.steamid : null;
  const [show, setShow] = useState<Show>('all');
  const scope = viewer ? show : 'all';
  const { data, error } = useFetch(
    (s) => communityApi.list({ kind, sort, page, ...(scope === 'yours' ? { author: viewer! } : scope === 'liked' ? { liked: true } : {}) }, s),
    [kind, sort, page, scope],
  );

  const pick = (k: CommunityKind) => { setKind(k); setPage(0); };
  const order = (o: 'new' | 'top') => { setSort(o); setPage(0); };
  const filter = (f: Show) => { setShow(f); setPage(0); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const noun = kind === 'hud' ? 'HUDs' : 'crosshairs';
  const none = scope === 'yours'
    ? `You have not shared any ${noun} yet. Share one with Share to community in the ${kind === 'hud' ? 'HUD editor' : 'crosshair maker'}.`
    : scope === 'liked' ? `You have not liked any ${noun} yet.` : `No ${noun} shared yet. Be the first.`;

  return (
    <div class="page page--wide community">
      <HudTabs active="community" />
      <PageHeader title="Shared HUDs and crosshairs" />
      <p class="muted community__lede">
        Made in the <a href="/hud">HUD editor</a> and the <a href="/crosshair">crosshair maker</a>. Share your own with
        Share to community in either one. Every download is built in your browser from the design, so a shared HUD can
        only ever carry HUD files.
      </p>

      <div class="community__bar">
        <Tabs label="What to show" active={kind} onSelect={(k) => pick(k as CommunityKind)}
          tabs={[{ key: 'hud', label: 'HUDs' }, { key: 'crosshair', label: 'Crosshairs' }]} />
        <Tabs label="Order" active={sort} onSelect={(o) => order(o as 'new' | 'top')}
          tabs={[{ key: 'new', label: 'New' }, { key: 'top', label: 'Top' }]} />
        {viewer && (
          <Tabs label="Whose" active={scope} onSelect={(f) => filter(f as Show)}
            tabs={[{ key: 'all', label: 'All' }, { key: 'yours', label: 'Yours' }, { key: 'liked', label: 'Liked' }]} />
        )}
      </div>

      {error && <Panel><p class="error">Could not load the community page. Try again in a moment.</p></Panel>}
      {!error && !data && <p class="muted" role="status">Loading</p>}
      {data && data.entries.length === 0 && (
        <Panel><Empty>{page > 0 ? `No more ${noun} here.` : none}</Empty></Panel>
      )}
      {data && data.entries.length > 0 && (
        <div class="ccards">
          {data.entries.map((e) => <CommunityCard key={`${e.kind}-${e.id}`} entry={e} session={session} />)}
        </div>
      )}

      {data && (page > 0 || pages > 1) && (
        <nav class="community__pager" aria-label="Pages">
          <button class="chip" type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</button>
          <span class="muted">Page {page + 1} of {pages}</span>
          <button class="chip" type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}

export default Community;
