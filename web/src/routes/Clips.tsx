import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, type ClipCard } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { fmtAgo } from '../format';

/** "Double skeet", "Triple skeet", "Quad skeet", then "<n>-skeet streak":
 *  the same words as the Discord post (src/clips.ts burstName). */
export function burstLabel(count: number): string {
  if (count === 2) return 'Double skeet';
  if (count === 3) return 'Triple skeet';
  if (count === 4) return 'Quad skeet';
  return `${count}-skeet streak`;
}

/** The /clips page narrowed to one player (a quad counts for all four cappers). */
export const clipsOf = (steamid: string) => `/clips?player=${steamid}`;

/** One clip: the video (nothing downloads until play, the poster frame
 *  shows meanwhile), who, what, where, and a link to the moment in the
 *  match's replay. */
export function ClipTile({ clip, showPlayer = true }: { clip: ClipCard; showPlayer?: boolean }) {
  const secs = (clip.spanMs / 1000).toFixed(1);
  const quad = clip.kind === 'quad';
  const replay = `/match/${clip.matchId}?ordinal=${clip.ordinal}&half=${clip.half}&t=${clip.tMs}`;
  return (
    <div class={`cliptile${quad || clip.count >= 3 ? ' cliptile--big' : ''}`}>
      <video class="cliptile__video" src={clip.video} poster={clip.thumb ?? undefined} controls preload="none" playsInline />
      <div class="cliptile__body">
        <span class="cliptile__what">
          {quad ? `Quad cap · 4 pins in ${secs} s` : `${burstLabel(clip.count)} · ${clip.count} hunters in ${secs} s`}
        </span>
        {quad && (
          <div class="cliptile__crew">
            {clip.people.map((p, i) => <>{i > 0 && ', '}<a href={clipsOf(p.steamid)} title={`${p.name}'s clips`}>{p.name}</a></>)}
          </div>
        )}
        {showPlayer && !quad && (
          <div class="cliptile__who">
            <a href={`/player/${clip.player.steamid}`} title={`${clip.player.name}'s profile`}>
              {clip.player.avatar
                ? <img class="cliptile__avatar" src={clip.player.avatar} alt="" loading="lazy" />
                : <span class="cliptile__avatar cliptile__avatar--blank" />}
            </a>
            <a class="cliptile__name" href={clipsOf(clip.player.steamid)} title={`${clip.player.name}'s clips`}>{clip.player.name}</a>
          </div>
        )}
        <div class="cliptile__where">
          <a href={replay}>Match {clip.matchId}</a> · {clip.campaign}, map {clip.ordinal + 1} · {fmtAgo(clip.doneAt)}
        </div>
      </div>
    </div>
  );
}

/** A finished tournament's highlight reel at the top of its page: nothing at
 *  all until one has been uploaded. */
export function EventReel({ slug }: { slug: string }) {
  const [reel, setReel] = useState<{ video: string; thumb: string | null } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setReel(null);
    api.eventReel(slug, ac.signal).then(setReel).catch(() => {});
    return () => ac.abort();
  }, [slug]);
  if (!reel) return null;
  return (
    <Panel class="evreel">
      <h3>Highlights</h3>
      <video class="evreel__video" src={reel.video} poster={reel.thumb ?? undefined} controls preload="none" playsInline />
    </Panel>
  );
}

const PAGE = 24;

/** A grid of clips with "Show more"; player narrows it to one person's. */
export function ClipGrid({ player, min, kind, empty }: { player?: string; min?: number; kind?: 'skeet' | 'quad'; empty: string }) {
  const [clips, setClips] = useState<ClipCard[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setClips(null);
    api.clips({ player, min, kind, limit: PAGE }, ac.signal)
      .then((r) => { setClips(r.clips); setMore(r.clips.length === PAGE); })
      .catch(() => { if (!ac.signal.aborted) setClips([]); });
    return () => ac.abort();
  }, [player, min, kind]);

  const loadMore = async () => {
    if (!clips || !clips.length || busy) return;
    setBusy(true);
    try {
      const r = await api.clips({ player, min, kind, limit: PAGE, before: clips[clips.length - 1]!.id });
      setClips([...clips, ...r.clips]);
      setMore(r.clips.length === PAGE);
    } finally {
      setBusy(false);
    }
  };

  if (clips === null) return null;
  if (!clips.length) return <Panel><Empty>{empty}</Empty></Panel>;
  return (
    <>
      <div class="clipgrid">
        {clips.map((c) => <ClipTile key={c.id} clip={c} showPlayer={!player} />)}
      </div>
      {more && <div class="clipmore"><button type="button" class="btn btn--ghost" onClick={loadMore} disabled={busy}>Show more</button></div>}
    </>
  );
}

/** The profile's clips: the newest few, nothing at all for a player without
 *  any (no empty box on most profiles). */
export function ProfileClips({ steamid }: { steamid: string }) {
  const [clips, setClips] = useState<ClipCard[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    setClips([]);
    api.clips({ player: steamid, limit: 6 }, ac.signal).then((r) => setClips(r.clips)).catch(() => {});
    return () => ac.abort();
  }, [steamid]);
  if (!clips.length) return null;
  return (
    <Panel class="prof__clips">
      <div class="prof__clipshead"><h3>Clips</h3><a href={clipsOf(steamid)}>See all</a></div>
      <div class="clipgrid clipgrid--small">
        {clips.map((c) => <ClipTile key={c.id} clip={c} showPlayer={false} />)}
      </div>
    </Panel>
  );
}

/** Pick a player by name from everyone with a clip; the choice lives in the
 *  page address (?player=) so a player's clips can be linked. */
function PlayerFilter({ player, onPick }: { player: string | undefined; onPick: (steamid: string | undefined) => void }) {
  const [players, setPlayers] = useState<{ steamid: string; name: string; count: number }[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    api.clipPlayers(ac.signal).then((r) => setPlayers(r.players)).catch(() => {});
    return () => ac.abort();
  }, []);
  const chosen = players.find((p) => p.steamid === player);
  if (player) {
    return (
      <button type="button" class="chip is-on clipfilter__who" onClick={() => { setText(''); onPick(undefined); }} title="Show everyone's clips">
        {chosen?.name ?? 'One player'} ×
      </button>
    );
  }
  const pick = (v: string) => {
    setText(v);
    const want = v.trim().toLowerCase();
    const hit = players.find((p) => p.name.toLowerCase() === want);
    if (hit) onPick(hit.steamid);
  };
  return (
    <>
      <input class="field__input clipfilter__search" type="search" list="clipplayers" placeholder="Find a player" aria-label="Find a player"
        value={text} onInput={(e) => pick((e.target as HTMLInputElement).value)} />
      <datalist id="clipplayers">
        {players.map((p) => <option key={p.steamid} value={p.name}>{p.count === 1 ? '1 clip' : `${p.count} clips`}</option>)}
      </datalist>
    </>
  );
}

export function Clips() {
  const { query, route } = useLocation();
  const player = /^\d{17}$/.test(query.player ?? '') ? query.player : undefined;
  const [show, setShow] = useState<'all' | 'triples' | 'quads'>('all');
  const pick = (v: typeof show, label: string) => (
    <button type="button" class={`chip${show === v ? ' is-on' : ''}`} aria-pressed={show === v} onClick={() => setShow(v)}>{label}</button>
  );
  return (
    <div class="page page--list">
      <PageHeader eyebrow="Riverside" title="Clips" />
      <p class="clipintro">
        Every double and triple skeet, filmed from the skeeter's eyes, and every quad cap, from the infected who landed the fourth pin.
        New ones show up a little while after the match ends.
      </p>
      <div class="clipfilter">
        {pick('all', 'All')}{pick('triples', 'Triple skeets')}{pick('quads', 'Quad caps')}
        <PlayerFilter player={player} onPick={(id) => route(id ? clipsOf(id) : '/clips', true)} />
      </div>
      <ClipGrid
        player={player}
        min={show === 'triples' ? 3 : undefined} kind={show === 'quads' ? 'quad' : show === 'triples' ? 'skeet' : undefined}
        empty={player
          ? 'No clips like that for this player yet.'
          : 'No clips here yet. They show up a little while after a match with a double or triple skeet or a quad cap.'}
      />
    </div>
  );
}
