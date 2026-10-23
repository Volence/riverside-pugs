import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { adminApi, api, ApiError, type WrappedCommunity, type WrappedPlayer } from '../api';
import { useFetch } from '../hooks/useFetch';
import type { Session } from '../hooks/useLiveState';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { campaignName, sparklinePoints } from '../format';
import { ENDORSE_LABEL } from '../endorse';
import {
  bestMapPick, buildDeck, DAY_NAMES, endorseTotal, fmtBig, fmtDay, fmtNum, fmtPerMatch, groupAwards, hourLabel,
  leaderPairs, ordinal, rotateHours, seasonMidpoint, sidesVerdict, standingBeat, topPct, totalChips, whenYouPlay,
  wrappedMapName, zoneName, zoneShiftHours, type CardKey,
} from '../wrapped';

/**
 * Season Wrapped: a story deck of a player's season, then the community's.
 *
 *   /wrapped                          the newest frozen season: your deck (or a sign-in card), then everyone's
 *   /wrapped/:season                  the same for an older season
 *   /wrapped/:season/:steamid         someone's shared deck
 *   /wrapped/preview/:season/:steamid staff preview, computed now (the open season too)
 *
 * The deck wears Season 0's red and bone whatever the site theme is, and the
 * last card tears into Season 1's cyan.
 */

type Loaded =
  | { kind: 'closed' }
  | { kind: 'deck'; community: WrappedCommunity; player: WrappedPlayer | null; loggedIn: boolean; shared: boolean; preview: boolean };

async function load(p: { season?: string; steamid?: string; preview: boolean }, signal: AbortSignal): Promise<Loaded> {
  if (p.preview && p.season && p.steamid) {
    const r = await adminApi.wrappedPreview(Number(p.season), p.steamid, signal);
    return { kind: 'deck', community: r.community, player: r.player, loggedIn: true, shared: true, preview: true };
  }
  if (p.season && p.steamid) {
    const r = await api.wrappedPlayer(Number(p.season), p.steamid, signal);
    return { kind: 'deck', community: r.community, player: r.player, loggedIn: false, shared: true, preview: false };
  }
  let season = p.season ? Number(p.season) : null;
  if (season === null) {
    const { seasons } = await api.wrappedSeasons(signal);
    if (seasons.length === 0) return { kind: 'closed' };
    season = seasons[0].id;
  }
  const r = await api.wrapped(season, signal);
  return { kind: 'deck', community: r.community, player: r.me, loggedIn: r.loggedIn, shared: false, preview: false };
}

export function Wrapped({ season, steamid, preview = false }: { season?: string; steamid?: string; preview?: boolean; session?: Session }) {
  const { data, error } = useFetch((s) => load({ season, steamid, preview }, s), [season, steamid, preview]);
  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <div class="page page--list">
        <PageHeader eyebrow="Riverside" title="Wrapped" />
        <Panel>
          <Empty>
            {status === 401 || status === 403 ? 'Staff only.'
              : status === 404 ? (preview ? 'That player has no Wrapped for this season.' : 'No Wrapped here. It may not exist, or that player sat the season out.')
                : 'Could not load Wrapped.'}
          </Empty>
        </Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--list" aria-busy="true"><p class="muted">Loading...</p></div>;
  if (data.kind === 'closed') {
    return (
      <div class="page page--list">
        <PageHeader eyebrow="Riverside" title="Wrapped" />
        <Panel><Empty>Wrapped opens when the season ends: your season as a story, then everyone's.</Empty></Panel>
      </div>
    );
  }
  const name = data.community.season.name;
  const shareFor = data.player ? `/wrapped/${data.community.season.id}/${data.player.steamid}` : '/wrapped';
  return (
    <div class="page page--list wrapped-page">
      <PageHeader
        eyebrow="Riverside"
        title={`${name} Wrapped`}
        aside={data.preview ? <span class="chip wrapped-preview-chip">Preview, not frozen</span> : undefined}
      />
      <Deck
        community={data.community} player={data.player}
        cards={buildDeck(data.player, data.community, { loggedIn: data.loggedIn, shared: data.shared })}
        sharePath={data.preview ? null : shareFor}
      />
    </div>
  );
}
export default Wrapped;

// ---------- The deck ----------

const reducedMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function Deck({ cards, community, player, sharePath }: {
  cards: CardKey[]; community: WrappedCommunity; player: WrappedPlayer | null; sharePath: string | null;
}) {
  const [idx, setIdx] = useState(0);
  const [tearing, setTearing] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const last = cards.length - 1;
  const at = Math.min(idx, last);

  const go = (to: number) => {
    const next = Math.max(0, Math.min(last, to));
    if (next === last && at !== last && !reducedMotion()) setTearing(true);
    setIdx(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        // Space on a focused button or link is that control's own press.
        if (e.key === ' ' && t && /^(BUTTON|A)$/.test(t.tagName)) return;
        e.preventDefault(); go(at + 1);
      } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Tap: the left third goes back, the rest goes on. Links and buttons on a
  // card keep their own click.
  const onCardClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (box.width > 0 && e.clientX - box.left < box.width / 3) go(at - 1); else go(at + 1);
  };
  const onTouchStart = (e: TouchEvent) => { const t = e.touches[0]; touch.current = t ? { x: t.clientX, y: t.clientY } : null; };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touch.current; touch.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(t.clientY - start.y)) { e.preventDefault(); go(dx < 0 ? at + 1 : at - 1); }
  };

  const key = cards[at];
  const cyan = key === 'next';
  return (
    <div class="wrapped">
      <div
        class={`wrapped-phone${cyan ? ' is-cyan' : ''}${tearing ? ' is-tearing' : ''}`}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) setTearing(false); }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      >
        <div class="wrapped-phone__bars" aria-hidden="true">
          {cards.map((c, i) => <i key={`${c}-${i}`} class={i <= at ? 'on' : ''} />)}
        </div>
        <div class="wrapped-card" aria-live="polite" aria-roledescription="story card" data-card={key} onClick={onCardClick}>
          <CardBody k={key} community={community} player={player} />
        </div>
        <div class="wrapped-phone__nav">
          <button type="button" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous card">Back</button>
          <span>{`${at + 1} / ${cards.length}`}</span>
          <button type="button" onClick={() => go(at + 1)} disabled={at === last} aria-label="Next card">Next</button>
        </div>
      </div>
      {sharePath && <ShareButton path={sharePath} />}
    </div>
  );
}

function ShareButton({ path }: { path: string }) {
  const [note, setNote] = useState<string | null>(null);
  const url = `${location.origin}${path}`;
  const share = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setNote('Link copied.');
    } catch {
      // No clipboard (http, or permission refused): show the link to copy by hand.
      setNote(url);
    }
  };
  return (
    <div class="wrapped-share">
      <button class="btn btn--ghost" type="button" onClick={() => void share()}>Share this Wrapped</button>
      {note && <span class="muted wrapped-share__note" role="status">{note}</span>}
    </div>
  );
}

// ---------- Cards ----------

const K = ({ children }: { children: ComponentChildren }) => <p class="k">{children}</p>;
const MatchLink = ({ id, children }: { id: number; children: ComponentChildren }) => <a href={`/match/${id}`}>{children}</a>;
const PlayerName = ({ p }: { p: { steamid: string; name: string } }) => <a href={`/player/${p.steamid}`}>{p.name}</a>;
const record = (wins: number, games: number) => `${wins}-${games - wins}`;
const pct = (wins: number, games: number) => Math.round((wins / Math.max(1, games)) * 100);

function CardBody({ k, community: c, player: p }: { k: CardKey; community: WrappedCommunity; player: WrappedPlayer | null }) {
  const season = c.season.name;
  if (!p || ['login', 'nodeck', 'c_numbers', 'c_standings', 'c_leaders', 'c_moments', 'next'].includes(k)) return <CommunityCard k={k} c={c} />;
  switch (k) {
    case 'intro': {
      const end = c.season.endedAt ?? c.overview.last;
      return (
        <>
          <K>{`${season} · Wrapped`}</K>
          <p class="big">{p.name}</p>
          <p class="line">{`${fmtDay(c.season.startedAt)} to ${end ? fmtDay(end) : 'now'}. Here's your season.`}</p>
        </>
      );
    }
    case 'numbers': {
      const n = p.numbers;
      return (
        <>
          <K>Your season in numbers</K>
          <p class="big">{fmtNum(n.matches)}</p>
          <p class="mid">{n.matches === 1 ? 'match' : 'matches'}</p>
          <div class="rows">
            <div><span>Record</span><b>{`${n.wins}-${n.losses} (${pct(n.wins, n.matches)}%)`}</b></div>
            <div><span>Hours played</span><b>{fmtNum(Math.round(n.hours))}</b></div>
            <div><span>Nights you showed up</span><b>{fmtNum(n.nights)}</b></div>
          </div>
          <p class="small">
            {`${n.gamesRank === 1 ? 'The most' : `${ordinal(n.gamesRank)} most`} matches of ${fmtNum(n.ofPlayers)} players.`}
            {n.longestNight && n.longestNight.matches > 1 && ` Longest night: ${fmtDay(n.longestNight.date)}, ${n.longestNight.matches} matches.`}
          </p>
        </>
      );
    }
    case 'standing': return <StandingCard p={p} c={c} />;
    case 'streak':
      return (
        <>
          <K>On a roll</K>
          <p class="big">{p.streaks.win}</p>
          <p class="mid">wins in a row</p>
          <p class="small">
            {p.streaks.loss >= 3
              ? `Your longest streak. The longest losing run was ${p.streaks.loss}, but we don't talk about that.`
              : 'Your longest streak.'}
          </p>
        </>
      );
    case 'campaign': {
      const { best, most } = p.campaigns;
      const { best: map, worst } = p.maps;
      return (
        <>
          {best && (
            <>
              <K>Your campaign</K>
              <p class="mid">{campaignName(best.campaign)}</p>
              <p class="line">{`${record(best.wins, best.games)}, a ${pct(best.wins, best.games)}% win rate over ${best.games} matches.`}</p>
              {most && most.campaign !== best.campaign && (
                <p class="small">{`Most played: ${campaignName(most.campaign)}, ${most.games} matches (${record(most.wins, most.games)}).`}</p>
              )}
            </>
          )}
          {map && (
            <>
              <K>Your map</K>
              <p class="mid">{wrappedMapName(map.map)}</p>
              <p class="line">
                {`${record(map.wins, map.games)}, ${map.avgMargin >= 0 ? 'winning' : 'losing'} by ${Math.abs(Math.round(map.avgMargin))} on average.`}
              </p>
              {worst && worst.map !== map.map && (
                <p class="small">{`Toughest: ${wrappedMapName(worst.map)}, ${record(worst.wins, worst.games)}.`}</p>
              )}
            </>
          )}
        </>
      );
    }
    case 'people': {
      const { mostWith, bestDuo, teammates } = p.people;
      const duo = p.tier === 'full' ? bestDuo : null;
      return (
        <>
          <K>Your people</K>
          {mostWith && (
            <>
              <p class="line">Most played with</p>
              <p class="mid"><PlayerName p={mostWith} />{` · ${mostWith.games} ${mostWith.games === 1 ? 'game' : 'games'}`}</p>
            </>
          )}
          {duo && (
            <>
              <p class="line">Best duo</p>
              <p class="mid gold"><PlayerName p={duo} />{` · ${record(duo.wins, duo.games)}`}</p>
            </>
          )}
          {teammates > 0 && <p class="small">{`${teammates} different teammates this season.`}</p>}
        </>
      );
    }
    case 'rivals': {
      const { nemesis, favourite } = p.rivals;
      if (!nemesis && favourite) {
        return (
          <>
            <K>Your favourite opponent</K>
            <p class="big gold"><PlayerName p={favourite} /></p>
            <p class="mid">{record(favourite.wins, favourite.games)}</p>
          </>
        );
      }
      return (
        <>
          <K>Your nemesis</K>
          {nemesis && <p class="big red"><PlayerName p={nemesis} /></p>}
          {nemesis && <p class="mid">{record(nemesis.wins, nemesis.games)}</p>}
          {favourite && <p class="line">Favourite opponent: <PlayerName p={favourite} />{`, ${record(favourite.wins, favourite.games)}.`}</p>}
          <p class="small">Your worst record against anyone you faced 5 or more times.</p>
        </>
      );
    }
    case 'signature': return <SignatureCard p={p} />;
    case 'bestMap': {
      const best = bestMapPick(p)!;
      const skeets = p.bestMatchSkeets;
      return (
        <>
          <K>Your best map</K>
          <p class="big">{fmtNum(best.value)}</p>
          <p class="mid">{best.label}</p>
          <p class="line">{best.map ? `${wrappedMapName(best.map)}, ` : ''}<MatchLink id={best.matchId}>{`match ${best.matchId}`}</MatchLink>.</p>
          {skeets && skeets.value >= 2 && (
            <p class="small">Most skeets in one match: {skeets.value} (<MatchLink id={skeets.matchId}>{`match ${skeets.matchId}`}</MatchLink>).</p>
          )}
        </>
      );
    }
    case 'sides': {
      const v = sidesVerdict(p.sides)!;
      const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
      return (
        <>
          <K>Survivor or infected?</K>
          <div class="rows">
            <div><span>Your team as survivors</span><b>{`${sign(v.surv)} vs average`}</b></div>
            <div><span>Your team as infected</span><b>{`${sign(v.inf)} vs average`}</b></div>
          </div>
          <p class="mid">{v.verdict}</p>
          <p class="small">
            {`When you are survivor, your team scores ${Math.round(p.sides.survivorAvg!)} a half; when you are infected, it holds them to ${Math.round(p.sides.concededAvg!)}. The average half is ${p.sides.communityAvg}.`}
          </p>
        </>
      );
    }
    case 'endorsed': {
      const e = p.endorsements;
      return (
        <>
          <K>Endorsed</K>
          <p class="big gold">{endorseTotal(p)}</p>
          <p class="line">
            {`endorsements from ${e.givers} different ${e.givers === 1 ? 'person' : 'people'}.`}
            {e.title && <>{' Title: '}<b>{ENDORSE_LABEL[e.title]}</b>.</>}
          </p>
          {e.mostEndorsedRank === 1 && <p class="small">{`The most endorsed player of ${season}.`}</p>}
          {e.given > 0 && <p class="small">{`You gave ${e.given}.`}</p>}
        </>
      );
    }
    case 'trophies': {
      const groups = groupAwards(p.trophies.weekly);
      const chips = totalChips(p.trophies.totals);
      return (
        <>
          <K>Trophy shelf</K>
          {p.trophies.weekly.length > 0 && (
            <>
              <p class="big gold">{p.trophies.weekly.length}</p>
              <p class="mid">{p.trophies.weekly.length === 1 ? 'weekly award' : 'weekly awards'}</p>
              <ul class="wrapped-chips">
                {groups.slice(0, 6).map((g) => <li key={g.label}>{g.count > 1 ? `${g.label} x${g.count}` : g.label}</li>)}
              </ul>
            </>
          )}
          {p.trophies.skeetTriples > 0 && (
            <p class="line">{`${p.trophies.skeetTriples} skeet ${p.trophies.skeetTriples === 1 ? 'triple' : 'triples'}: three skeets inside 5 seconds, team skeets included.`}</p>
          )}
          {chips.length > 0 && (
            <ul class="wrapped-chips wrapped-chips--quiet" aria-label="Season totals">
              {chips.map((t) => <li key={t.label}>{`${fmtNum(t.value)} ${t.label}`}</li>)}
            </ul>
          )}
        </>
      );
    }
    case 'when': return <WhenCard p={p} c={c} />;
    case 'started': {
      const f = p.first;
      return (
        <>
          <K>Where it started</K>
          <p class="mid"><MatchLink id={f.matchId}>{`Match ${f.matchId}`}</MatchLink>{` · ${campaignName(f.campaign)}`}</p>
          <p class="line">
            {f.firstEver
              ? `${fmtDay(f.startedAt)}: the first ranked PUG ever played on Riverside. You ${f.won ? 'won' : 'lost'} it.`
              : `${fmtDay(f.startedAt)}. You ${f.won ? 'won' : 'lost'} it.`}
          </p>
        </>
      );
    }
    case 'closer':
      return (
        <>
          <K>Next</K>
          <p class="mid">Season 1 is yours</p>
          <p class="line">Play more and next season's Wrapped is the full deck: streaks, rivals, your signature stat.</p>
        </>
      );
    case 'dropin': {
      const f = p.first;
      const n = p.numbers;
      return (
        <>
          <K>{`${season} · Your first match`}</K>
          <p class="mid"><MatchLink id={f.matchId}>{`Match ${f.matchId}`}</MatchLink>{` · ${campaignName(f.campaign)}`}</p>
          <p class="line">{`${fmtDay(f.startedAt)}. ${f.won ? 'A win' : 'A loss'}${f.firstPartner ? ', with ' : '.'}`}{f.firstPartner && <><PlayerName p={f.firstPartner} />.</>}</p>
          <p class="small">
            {n.matches > 1 ? `${n.matches} matches, ${n.hours} hours in all.` : `${n.hours} ${n.hours === 1 ? 'hour' : 'hours'} on the server.`}
            {' Season 1 is yours.'}
          </p>
        </>
      );
    }
    default: return null;
  }
}

function StandingCard({ p, c }: { p: WrappedPlayer; c: WrappedCommunity }) {
  const s = p.standing!;
  const beat = standingBeat(s);
  const topOfAll = c.peakSr?.steamid === p.steamid;
  return (
    <>
      <K>Where you finished</K>
      {s.finalRank !== null
        ? (
          <>
            <p class="big gold">{`#${s.finalRank}`}</p>
            <p class="line">of {s.ofRanked} ranked players, at <b>{`${s.sr} SR`}</b>.</p>
          </>
        )
        : (
          <>
            <p class="big">{s.sr}</p>
            <p class="line">{`SR. ${s.finalMinGames} matches are needed for a final place; you played ${s.games}.`}</p>
          </>
        )}
      {beat.kind === 'peak' && (
        <>
          <p class="mid">{`Peak ${s.peakSr}`}</p>
          {s.peakAt && (
            <p class="small">
              {'On '}
              {s.peakMatchId ? <MatchLink id={s.peakMatchId}>{fmtDay(s.peakAt)}</MatchLink> : fmtDay(s.peakAt)}
              {topOfAll ? ', the highest anyone reached all season.' : '.'}
            </p>
          )}
        </>
      )}
      {beat.kind === 'climb' && (
        <>
          <p class="mid">{`${beat.from} to ${beat.to}, climbing`}</p>
          <Spark values={s.spark} />
        </>
      )}
    </>
  );
}

function Spark({ values }: { values: number[] }) {
  const points = sparklinePoints(values, 300, 60);
  if (!points) return null;
  return (
    <svg class="wrapped-spark" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="SR over the season">
      <polyline points={points} />
    </svg>
  );
}

function SignatureCard({ p }: { p: WrappedPlayer }) {
  const [top, ...rest] = p.signature!;
  const value = (s: { key: string; perMatch: number }) =>
    s.key === 'winrate' ? `${Math.round(s.perMatch * 100)}% of matches won` : `${fmtPerMatch(s.perMatch)} per match`;
  const next = rest.slice(0, 2);
  const pcts = next.map((s) => topPct(s.rank, s.of));
  const also = next.length === 0 ? null
    : pcts.every((x) => x === pcts[0])
      ? `Also top ${pcts[0]}% in ${next.map((s) => s.label).join(' and ')}.`
      : `Also ${next.map((s, i) => `top ${pcts[i]}% in ${s.label}`).join(' and ')}.`;
  return (
    <>
      <K>Your signature</K>
      <p class="mid">{top.label}</p>
      <p class="big gold">{`Top ${topPct(top.rank, top.of)}%`}</p>
      <p class="line">{`${value(top)}, #${top.rank} of ${top.of} regulars.`}</p>
      {also && <p class="small">{also}</p>}
    </>
  );
}

function WhenCard({ p, c }: { p: WrappedPlayer; c: WrappedCommunity }) {
  const at = seasonMidpoint(c);
  const w = whenYouPlay(rotateHours(p.hours, zoneShiftHours(at)));
  if (!w) return null;
  return (
    <>
      <K>When you play</K>
      <p class="big">{hourLabel(w.peakHour)}</p>
      <p class="line">{`Your peak hour (${zoneName(at)}).`}</p>
      {w.afterMidnight >= 10 && <p class="mid">{`${w.afterMidnight}% after midnight`}</p>}
      <p class="small">{`${DAY_NAMES[w.topDay]}s most of all.`}</p>
    </>
  );
}

function CommunityCard({ k, c }: { k: CardKey; c: WrappedCommunity }) {
  const season = c.season.name;
  switch (k) {
    case 'login':
      return (
        <>
          <K>{`${season} · Wrapped`}</K>
          <p class="mid">Log in to see yours</p>
          <p class="line">{`Sign in and the deck starts with your own ${season}: your numbers, your people, your nemesis.`}</p>
          {/* target _top: /auth/steam is a backend route. */}
          <p><a class="btn" href={`/auth/steam?next=${encodeURIComponent('/wrapped')}`} target="_top" rel="noopener">Sign in through Steam</a></p>
          <p class="small">Or read on for everyone's season.</p>
        </>
      );
    case 'nodeck':
      return (
        <>
          <K>{`${season} · Wrapped`}</K>
          <p class="mid">You sat this one out</p>
          <p class="line">{`No completed PUGs for you in ${season}. Here is how everyone else did.`}</p>
        </>
      );
    case 'c_numbers': {
      const t = c.totals;
      return (
        <>
          <K>{`${season}, all of us`}</K>
          <div class="rows">
            <div><span>Matches</span><b>{fmtNum(c.overview.matches)}</b></div>
            <div><span>Match hours</span><b>{fmtNum(Math.round(c.overview.matchHours))}</b></div>
            <div><span>Players</span><b>{fmtNum(c.overview.players)}</b></div>
            {(t.skeets ?? 0) > 0 && <div><span>Skeets</span><b>{fmtNum(t.skeets)}</b></div>}
            {(t.quad_caps ?? 0) > 0 && <div><span>Quad caps</span><b>{fmtNum(t.quad_caps)}</b></div>}
            {(t.ck ?? 0) > 0 && <div><span>Common infected</span><b>{fmtNum(t.ck)}</b></div>}
          </div>
          {c.busiestNight && <p class="small">{`Busiest night: ${fmtDay(c.busiestNight.date)}, ${c.busiestNight.matches} matches.`}</p>}
        </>
      );
    }
    case 'c_standings':
      return (
        <>
          <K>Final standings</K>
          <div class="rows">
            {c.top10.map((r) => (
              <div key={r.steamid}><span>{`${r.rank} · `}<PlayerName p={r} /></span><b>{r.sr}</b></div>
            ))}
          </div>
          <p class="small">{`${c.finalMinGames} matches needed for a final place.`}</p>
        </>
      );
    case 'c_leaders':
      return (
        <>
          <K>Season leaders</K>
          <div class="rows rows--stacked">
            {leaderPairs(c).map((l) => (
              <div key={l.label}>
                <span>{l.label}</span>
                <b>
                  <PlayerName p={l.total} />{` ${fmtBig(l.total.value)}`}
                  {l.perMatch && <small>{'per match: '}<PlayerName p={l.perMatch} />{` ${fmtPerMatch(l.perMatch.value)}`}</small>}
                </b>
              </div>
            ))}
          </div>
        </>
      );
    case 'c_moments': {
      const m = c.moments;
      const closest = m.closest[0];
      const margin = closest ? Math.abs(closest.a - closest.b) : 0;
      const single = [['sidmg', 'SI damage'], ['skeets', 'skeets'], ['damage_as_si', 'damage as SI']] as const;
      return (
        <>
          <K>Moments</K>
          <div class="rows rows--stacked">
            {closest && (
              <div>
                <span>Closest finish</span>
                <b>
                  {`${margin} ${margin === 1 ? 'point' : 'points'}`}
                  <small>
                    {m.closest.filter((x) => Math.abs(x.a - x.b) === margin).slice(0, 3).map((x, i) => (
                      <span key={x.matchId}>{i > 0 && ', '}<MatchLink id={x.matchId}>{`match ${x.matchId}`}</MatchLink></span>
                    ))}
                  </small>
                </b>
              </div>
            )}
            {m.blowout && (
              <div>
                <span>Biggest blowout</span>
                <b>
                  {`${Math.min(m.blowout.a, m.blowout.b)} to ${Math.max(m.blowout.a, m.blowout.b)}`}
                  <small><MatchLink id={m.blowout.matchId}>{`match ${m.blowout.matchId}`}</MatchLink>{`, ${campaignName(m.blowout.campaign)}`}</small>
                </b>
              </div>
            )}
            {single.map(([key, label]) => {
              const r = m.bestSingleMap[key];
              if (!r) return null;
              return (
                <div key={key}>
                  <span>{`Best map, ${label}`}</span>
                  <b>
                    <PlayerName p={r} />{` ${fmtNum(r.value)}`}
                    <small>{r.map ? `${wrappedMapName(r.map)}, ` : ''}<MatchLink id={r.matchId}>{`match ${r.matchId}`}</MatchLink></small>
                  </b>
                </div>
              );
            })}
          </div>
          {m.skeetTriples > 0 && <p class="small">{`${m.skeetTriples} skeet triples all season.`}</p>}
        </>
      );
    }
    case 'next':
      if (c.season.id !== 1) {
        return (
          <>
            <K>Next</K>
            <p class="big red">Next season</p>
            <p class="line">See you on the server.</p>
          </>
        );
      }
      return (
        <>
          <K>Next</K>
          <p class="big red">Season 1</p>
          <p class="mid">Wrong Way</p>
          <p class="line">Soft reset, 5 placement games, Bronze to Master. Nov 3.</p>
        </>
      );
    default: return null;
  }
}
