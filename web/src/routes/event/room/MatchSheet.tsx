import { useEffect, useState } from 'preact/hooks';
import { api, entryLogoUrl, type MatchDemo, type MatchPlayerStats, type MatchRoomView, type PlayEntry, type RoomGame, type RoomPlayer } from '../../../api';
import { campaignTint } from '../../../format';
import { gameTitle } from './roomText';

/**
 * The match page's scoreboard, game cards and lineup columns (owner,
 * 2026-10-23: "can we make it nicer looking", players must link to their
 * profiles). Pure views over MatchRoomView, plus the per-player numbers of
 * the finished games read from each game's own match page data.
 */

type Side = 'a' | 'b';
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
const teamName = (v: MatchRoomView, s: Side) => (s === 'a' ? v.a?.name : v.b?.name) ?? 'TBD';

function Logo({ entry, size }: { entry: PlayEntry | null; size: number }) {
  if (entry?.logoKey) return <img class="sheetlogo" src={entryLogoUrl(entry.logoKey)} alt="" width={size} height={size} />;
  const mark = (entry?.tag || entry?.name || '?').slice(0, 3).toUpperCase();
  return <span class="sheetlogo sheetlogo--none" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">{mark}</span>;
}

/** The series winner, or for a finished match without a series row (a
 *  forfeit before any game), the recorded result. */
function winnerOf(v: MatchRoomView): Side | null {
  return v.series?.winner ?? v.result?.winner ?? null;
}

/** Both teams, seeds and the big series score, with the winner lit. */
export function MatchHero({ v, when }: { v: MatchRoomView; when: string | null }) {
  const win = winnerOf(v);
  const s = v.series;
  const score = (side: Side): number | null => {
    if (s) return s.totalScore ? (side === 'a' ? s.totalA : s.totalB) : (side === 'a' ? s.winsA : s.winsB);
    if (v.result) return side === 'a' ? v.result.scoreA : v.result.scoreB;
    return null;
  };
  const a = score('a');
  const b = score('b');
  const side = (x: Side) => {
    const entry = x === 'a' ? v.a : v.b;
    return (
      <div class={`sheethero__side sheethero__side--${x}${win === x ? ' is-winner' : win ? ' is-loser' : ''}`}>
        <Logo entry={entry} size={64} />
        <div class="sheethero__who">
          <p class="sheethero__name">{entry?.name ?? 'TBD'}</p>
          <p class="sheethero__meta">
            {entry?.tag && <span class="sheethero__tag">{entry.tag}</span>}
            {entry?.seed != null && <span>Seed {entry.seed}</span>}
            {v.higher === x && <span>Higher seed</span>}
          </p>
          {win === x && <span class="teamchip sheethero__won">{v.result?.forfeit ? 'Wins by forfeit' : 'Winner'}</span>}
        </div>
      </div>
    );
  };
  return (
    <section class="sheethero" aria-label="Match result">
      {side('a')}
      <div class="sheethero__mid">
        {a !== null && b !== null ? (
          <p class="sheethero__score num">
            <span class={win === 'a' ? 'is-lead' : ''}>{a}</span>
            <span class="sheethero__colon">:</span>
            <span class={win === 'b' ? 'is-lead' : ''}>{b}</span>
          </p>
        ) : <p class="sheethero__vs">vs</p>}
        <p class="sheethero__format">
          {s ? (s.totalScore ? 'Two games, total score' : `Best of ${s.bestOf}`) : v.vetoSummary.split(':')[0]}
          {v.server?.name && <> · {v.server.name}</>}
        </p>
        {when && <p class="sheethero__when">{when}</p>}
      </div>
      {side('b')}
    </section>
  );
}

/** One card per game: campaign, both scores, who picked and who chose sides,
 *  and the way into the game's own stats page. */
export function GameCards({ v }: { v: MatchRoomView }) {
  if (v.games.length === 0) return null;
  return (
    <div class="sheetgames">
      {v.games.map((g) => <GameCard key={g.id} v={v} g={g} />)}
    </div>
  );
}

function GameCard({ v, g }: { v: MatchRoomView; g: RoomGame }) {
  const score = (s: Side): number | null => (g.state === 'live' && g.live ? (s === 'a' ? g.live.scoreA : g.live.scoreB) : s === 'a' ? g.scoreA : g.scoreB);
  const winner: Side | null = g.state === 'done' ? (g.forfeit ? other(g.forfeit) : g.winner) : null;
  const facts: string[] = [];
  if (g.pickedBy) facts.push(`Picked by ${teamName(v, g.pickedBy)}`);
  else if (g.state !== 'upcoming' || v.phase !== 'veto') facts.push('Decider');
  if (g.sideBy) facts.push(`${teamName(v, g.sideBy)} chose sides`);
  if (g.firstSurvivors) facts.push(`${teamName(v, g.firstSurvivors)} started on survivors`);
  if (g.forfeit) facts.push(`${teamName(v, g.forfeit)} forfeited with !gg`);
  const row = (s: Side) => {
    const n = score(s);
    return (
      <div class={`sheetgame__team${winner === s ? ' is-winner' : ''}`}>
        <Logo entry={s === 'a' ? v.a : v.b} size={24} />
        <span class="sheetgame__teamname">{teamName(v, s)}</span>
        <span class="sheetgame__score num">{n ?? '-'}</span>
      </div>
    );
  };
  return (
    <article class={`sheetgame sheetgame--${g.state}`} style={{ '--campaign': campaignTint(g.campaign) } as Record<string, string>}>
      <header class="sheetgame__head">
        <div>
          <p class="sheetgame__eyebrow">{gameTitle(g)}{g.tiebreak && g.map ? ` · ${g.map}` : ''}</p>
          <h4 class="sheetgame__campaign">{g.campaignName}</h4>
        </div>
        <span class={`teamchip sheetgame__state sheetgame__state--${g.state}`}>
          {g.state === 'done' ? 'Final' : g.state === 'live' ? (g.live?.map ? `Live on ${g.live.map}` : 'Live') : 'Up next'}
        </span>
      </header>
      <div class="sheetgame__teams">{row('a')}{row('b')}</div>
      {facts.length > 0 && <p class="sheetgame__facts">{facts.join(' · ')}</p>}
      {g.matchId !== null && g.state === 'done' && (
        <a class="btn btn--ghost btn--sm sheetgame__stats" href={`/match/${g.matchId}`}>Full stats and replay</a>
      )}
    </article>
  );
}

/** Per-player numbers summed over the finished games, keyed by SteamID. */
export type GameStats = Map<string, { siDamage: number; commonKills: number; siKills: number; damageAsSi: number; games: number }>;

/** One finished game's SourceTV demos, keyed to the pug match that holds them. */
export type GameDemos = { title: string; campaignName: string; matchId: number; demos: MatchDemo[] }[];

/** Reads each finished game's own match data once, for the per-player
 *  numbers and the demo list; a game the viewer may not open (or an error)
 *  just contributes nothing. */
export function useGameStats(v: MatchRoomView | null): { stats: GameStats | null; demos: GameDemos } {
  const games = v ? v.games.filter((g) => g.state === 'done' && g.matchId !== null) : [];
  const key = games.map((g) => g.matchId).join(',');
  const [stats, setStats] = useState<GameStats | null>(null);
  const [demos, setDemos] = useState<GameDemos>([]);
  useEffect(() => {
    if (games.length === 0) { setStats(null); setDemos([]); return undefined; }
    const ctl = new AbortController();
    const none = { players: [] as MatchPlayerStats[], demos: [] as MatchDemo[] };
    void Promise.all(games.map((g) => api.match(String(g.matchId), ctl.signal).then((r) => {
      if ('ongoing' in r && r.ongoing) return none;
      const d = r as { players: MatchPlayerStats[]; demos?: MatchDemo[] };
      return { players: d.players, demos: d.demos ?? [] };
    }, () => none)))
      .then((results) => {
        if (ctl.signal.aborted) return;
        const out: GameStats = new Map();
        for (const p of results.flatMap((r) => r.players)) {
          const cur = out.get(p.steamid) ?? { siDamage: 0, commonKills: 0, siKills: 0, damageAsSi: 0, games: 0 };
          cur.siDamage += p.siDamage;
          cur.commonKills += p.commonKills;
          cur.siKills += p.siKills;
          cur.damageAsSi += p.stats?.damage_as_si ?? 0;
          cur.games += 1;
          out.set(p.steamid, cur);
        }
        setStats(out.size > 0 ? out : null);
        setDemos(games.map((g, i) => ({ title: gameTitle(g), campaignName: g.campaignName, matchId: g.matchId!, demos: results[i].demos })).filter((g) => g.demos.length > 0));
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { stats, demos };
}

const ROLE_TEXT: Record<'captain' | 'sub' | 'standin', string> = { captain: 'Captain', sub: 'Sub', standin: 'Stand-in' };

function PlayerRow({ p, stats }: { p: RoomPlayer; stats: GameStats | null }) {
  const s = stats?.get(p.steamid);
  return (
    <li class="sheetplayer">
      {p.avatar ? <img class="sheetplayer__avatar" src={p.avatar} alt="" width={36} height={36} loading="lazy" />
        : <span class="sheetplayer__avatar sheetplayer__avatar--none" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>}
      <div class="sheetplayer__who">
        <span class="sheetplayer__nameline">
          <a class="sheetplayer__name" href={`/player/${encodeURIComponent(p.steamid)}`}>{p.name}</a>
          {p.role && <span class={`teamchip${p.role === 'captain' ? ' teamchip--captain' : ''}`}>{ROLE_TEXT[p.role]}</span>}
        </span>
        {s && (
          <span class="sheetplayer__stats num">
            <span title="Damage to special infected as a survivor">{s.siDamage.toLocaleString()} SI dmg</span>
            <span title="Common infected killed">{s.commonKills} commons</span>
            <span title="Damage dealt as special infected">{s.damageAsSi.toLocaleString()} as SI</span>
          </span>
        )}
      </div>
    </li>
  );
}

/** The two locked fours side by side, each name a link to the profile. */
export function LineupColumns({ v, stats }: { v: MatchRoomView; stats: GameStats | null }) {
  const col = (side: Side) => {
    const list = v.lineups[side];
    const entry = side === 'a' ? v.a : v.b;
    return (
      <div class={`sheetlineup sheetlineup--${side}`}>
        <h4 class="sheetlineup__team"><Logo entry={entry} size={28} /> <span>{entry?.name ?? 'TBD'}</span></h4>
        {list ? (
          <ul class="sheetlineup__players">{list.map((p) => <PlayerRow key={p.steamid} p={p} stats={stats} />)}</ul>
        ) : <p class="muted">{v.lineups[`${side}Locked`] ? 'Locked. Shown once both teams lock.' : 'Not locked yet.'}</p>}
      </div>
    );
  };
  return (
    <div class="sheetlineups">
      {col('a')}
      {col('b')}
      {stats && <p class="sheetlineups__note muted">Numbers are summed over the finished games of this match.</p>}
    </div>
  );
}
