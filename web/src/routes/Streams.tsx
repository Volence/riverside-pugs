import { useEffect, useState } from 'preact/hooks';
import { api, type OfflineCard, type StreamCard, type StreamsView } from '../api';
import { campaignName, mapName } from '../format';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** Matches the server's poll interval. Polling faster shows nothing newer,
 *  because the cache it reads is only refreshed once a minute. */
const POLL_MS = 60_000;

/**
 * Twitch hands back a template with {width} and {height} in it. Substituting
 * here rather than server-side means one stored value serves any size, and the
 * cache buster is what stops their CDN handing back a frame from twenty
 * minutes ago. The buster changes once per poll interval, not per render, so
 * it does not refetch the image on every tick of the clock.
 */
function thumb(card: StreamCard, w: number, h: number): string {
  if (!card.thumbnail) return '';
  const url = card.thumbnail.replace('{width}', String(w)).replace('{height}', String(h));
  return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / POLL_MS)}`;
}

function uptime(startedAt: string | null): string {
  if (!startedAt) return '';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function lastLive(iso: string | null): string {
  if (!iso) return 'never seen live';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return 'never seen live';
  if (days <= 0) return 'live earlier today';
  if (days === 1) return 'live yesterday';
  return `last live ${days} days ago`;
}

function channelUrl(login: string): string {
  return `https://www.twitch.tv/${encodeURIComponent(login)}`;
}

function StreamTile({ card, big }: { card: StreamCard; big: boolean }) {
  return (
    <a
      class={`streamtile${big ? ' streamtile--big' : ''}`}
      href={channelUrl(card.twitchName)}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div class="streamtile__shot">
        {card.thumbnail
          ? <img src={thumb(card, big ? 440 : 320, big ? 248 : 180)} alt="" loading="lazy" />
          : <div class="streamtile__noshot" />}
        <span class="streamtile__badge">LIVE</span>
        <span class="streamtile__viewers">{card.viewers.toLocaleString()} watching</span>
        {card.startedAt && <span class="streamtile__uptime">{uptime(card.startedAt)}</span>}
      </div>
      <div class="streamtile__body">
        {card.match && (
          <span class="streamtile__match">
            PUG #{card.match.id} · {campaignName(card.match.campaign)}
            {card.match.map ? ` · ${mapName(card.match.map)}` : ''}
          </span>
        )}
        <div class="streamtile__who">
          {card.avatar
            ? <img class="streamtile__avatar" src={card.avatar} alt="" />
            : <span class="streamtile__avatar streamtile__avatar--blank" />}
          <div>
            <div class="streamtile__name">{card.name}</div>
            <div class="streamtile__channel">{card.twitchName}</div>
          </div>
        </div>
        {card.title && <p class="streamtile__title">{card.title}</p>}
      </div>
    </a>
  );
}

function OfflineTile({ card }: { card: OfflineCard }) {
  return (
    <a
      class="offlinetile"
      href={channelUrl(card.twitchName)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {card.avatar
        ? <img class="offlinetile__avatar" src={card.avatar} alt="" loading="lazy" />
        : <div class="offlinetile__avatar offlinetile__avatar--blank" />}
      <div class="offlinetile__name">{card.name}</div>
      <div class="offlinetile__when">{lastLive(card.lastLiveAt)}</div>
    </a>
  );
}

export function Streams() {
  const [view, setView] = useState<StreamsView | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.streams(all);
        if (!cancelled) setView(res);
      } catch {
        // Keep the last good render rather than blanking the page on a blip,
        // the same choice Live makes.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [all]);

  if (view === null) return <div class="page page--list" />;

  const nothing = !view.inPug.length && !view.live.length && !view.offline.length;

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Riverside" title="Streams" />

      {view.stale && !nothing && (
        <Panel>
          <Empty>Twitch status is unavailable right now, so nobody is shown as live.</Empty>
        </Panel>
      )}

      {view.inPug.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Live in a PUG</h2>
          <div class="streamgrid streamgrid--big">
            {view.inPug.map((c) => <StreamTile key={c.steamid} card={c} big />)}
          </div>
        </section>
      )}

      {view.live.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Live</h2>
          <div class="streamgrid">
            {view.live.map((c) => <StreamTile key={c.steamid} card={c} big={false} />)}
          </div>
        </section>
      )}

      {view.offline.length > 0 && (
        <section class="streamsec">
          <h2 class="streamsec__head">Offline</h2>
          <div class="offlinegrid">
            {view.offline.map((c) => <OfflineTile key={c.steamid} card={c} />)}
          </div>
          {!all && view.offlineTotal > view.offline.length && (
            <button class="btn btn--ghost streamsec__more" onClick={() => setAll(true)}>
              Show all {view.offlineTotal}
            </button>
          )}
        </section>
      )}

      {nothing && (
        <Panel>
          <Empty>
            Nobody has linked a Twitch channel yet. Connect yours from your profile and you
            will show up here.
          </Empty>
        </Panel>
      )}
    </div>
  );
}
