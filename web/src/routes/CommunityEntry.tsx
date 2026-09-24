import { communityApi, ApiError } from '../api';
import type { Session } from '../hooks/useLiveState';
import { useFetch } from '../hooks/useFetch';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { HudTabs } from '../components/HudTabs';
import { CommunityCard } from '../components/CommunityCard';

const ID = /^[1-9][0-9]{0,15}$/;

/**
 * /community/<id>: one shared entry, the link Discord and a ticket point at.
 * A removed or deleted one reads as removed to everyone but staff, who see it
 * with the removal, since a report about it needs the evidence.
 */
export function CommunityEntry({ id, session }: { id: string; session: Session }) {
  const valid = ID.test(id);
  const { data, error } = useFetch(
    (s) => (valid ? communityApi.get(Number(id), s) : Promise.reject(new ApiError(404, 'no such entry'))),
    [id],
  );

  // A shared entry sits under the Community tab of the HUD section.
  const header = (
    <>
      <HudTabs active="community" />
      <PageHeader title={data ? (data.kind === 'hud' ? 'Shared HUD' : 'Shared crosshair') : 'Shared entry'} />
    </>
  );
  if (error) {
    return (
      <div class="page page--wide community">
        {header}
        <Panel>
          <p class="muted">
            {error instanceof ApiError && error.status === 404 ? 'This entry was removed.' : 'Could not load this entry. Try again in a moment.'}
          </p>
          <p><a class="chip" href="/community">Back to the community page</a></p>
        </Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--wide community">{header}<p class="muted" role="status">Loading</p></div>;

  const removed = data.removed;
  return (
    <div class="page page--wide community">
      {header}
      {removed && (
        <p class="community__removed" role="note">
          {removed.by === data.author.steamid
            ? 'Deleted by its author.'
            : <>Removed by <a href={`/player/${encodeURIComponent(removed.by ?? '')}`}>{removed.byName || removed.by || 'staff'}</a>: {removed.reason ?? 'no reason given'}</>}
        </p>
      )}
      {/* A removed entry is shown to staff as evidence, without the actions a
          live one has: nothing is left to like, remove, open or download
          (CommunityCard leaves those off a removed entry). */}
      {removed
        ? <CommunityCard entry={data} session={{ kind: 'anonymous' }} size="large" />
        : <CommunityCard entry={data} session={session} size="large" />}
      <p><a class="chip" href={data.kind === 'hud' ? '/community' : '/community?kind=crosshair'}>All shared {data.kind === 'hud' ? 'HUDs' : 'crosshairs'}</a></p>
    </div>
  );
}

export default CommunityEntry;
