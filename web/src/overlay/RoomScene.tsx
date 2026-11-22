import { campaignTint } from '../format';
import type { MatchRoomView, PlayEntry, RoomCampaign, RoomGame } from '../api';
import { PHASE_TEXT, holdText, logText, turnBanner } from '../routes/event/room/roomText';
import type { RoomPlanStep } from '../api';
import { seriesMath, seriesNeedsText } from '../routes/event/room/seriesMath';
import { Backdrop, fmtClock } from './pieces';
import type { StudioState } from '../../../src/cast/types';

/**
 * The tournament room scene (owner 2026-11-22, DT2: "a room scene where you
 * can see vetos and map selection and all that for obs for casters"): the
 * two teams and the series score with its math, the veto order and the
 * campaign pool as each step lands, the games with who picked them and who
 * chose sides, and whose turn it is on the room's clock. Everything is the
 * public room (src/cast/room.ts), read off the studio feed every second.
 */

type Side = 'a' | 'b';
const teamName = (v: MatchRoomView, s: Side): string => (s === 'a' ? v.a?.name : v.b?.name) ?? 'TBD';
const tagOf = (e: PlayEntry | null): string => (e?.tag || e?.name || '?').slice(0, 4).toUpperCase();

function RoomLogo({ entry, size, logoSrc }: { entry: PlayEntry | null; size: number; logoSrc: (file: string) => string }) {
  if (entry?.logoKey) return <img class="ov-logo" width={size} height={size} src={logoSrc(`${entry.logoKey}.png`)} alt="" />;
  return <span class="ov-logo ov-logo--tag" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.34)}px` }}>{tagOf(entry)}</span>;
}

/** One veto step as a short chip for the scene (the room page's planLine is
 *  a sentence, too long for a row of eight): "Ban 2 · SMA", "Pick G2 · SMB".
 *  A step whose team waits on the go-first choice reads 1st or 2nd. */
function stepChip(v: MatchRoomView, p: RoomPlanStep, banNo: number): string {
  const who = p.by === null ? '' : p.tentative && v.higher ? (p.by === v.higher ? '1st' : '2nd') : tagOf(p.by === 'a' ? v.a : v.b);
  switch (p.kind) {
    case 'order': return `Order · ${who}`;
    case 'ban': return `Ban ${banNo} · ${who}`;
    case 'pick': return `Pick G${p.game ?? 1} · ${who}`;
    case 'side': return `Sides G${p.game ?? 1} · ${who}`;
    case 'wait': return `G${p.game}: loser picks`;
  }
}

function tileText(v: MatchRoomView, c: RoomCampaign): string {
  const who = c.by === null ? '' : tagOf(c.by === 'a' ? v.a : v.b);
  if (c.state === 'banned') return `Banned · ${who}`;
  if (c.state === 'picked') return `Game ${c.game} · ${who} pick`;
  if (c.state === 'decider') return `Game ${c.game} · decider`;
  return 'Open';
}

function gameFacts(v: MatchRoomView, g: RoomGame): string[] {
  const out: string[] = [];
  if (g.pickedBy) out.push(`${teamName(v, g.pickedBy)} picked`);
  else if (g.state !== 'upcoming' || v.phase !== 'veto') out.push('Decider');
  if (g.firstSurvivors) out.push(`${teamName(v, g.firstSurvivors)} start survivors`);
  else if (g.sideBy) out.push(`${teamName(v, g.sideBy)} choose sides`);
  if (g.forfeit) out.push(`${teamName(v, g.forfeit)} forfeited`);
  return out;
}

/** The line under the pool: whose turn and the clock, else where the room is. */
function statusLine(v: MatchRoomView, now: number): { text: string; clock: string | null; tone: string } {
  const banner = turnBanner({ ...v, me: null });
  const left = v.deadline ? Math.max(0, Date.parse(v.deadline) - now) : null;
  if (banner) return { text: banner.title, clock: left !== null ? fmtClock(left) : null, tone: banner.tone };
  if (v.phase === 'hold') return { text: `On hold${v.holdReason && v.holdReason !== 'dispute' ? `: ${holdText(v.holdReason)}` : ''}`, clock: null, tone: 'hold' };
  if (v.phase === 'ready') {
    const waiting = (['a', 'b'] as const).filter((s) => !v.ready[s]).map((s) => teamName(v, s));
    return { text: waiting.length ? `Ready check: waiting for ${waiting.join(' and ')}` : 'Both teams ready', clock: left !== null ? fmtClock(left) : null, tone: 'ready' };
  }
  if (v.phase === 'lineup') {
    const open = (['a', 'b'] as const).filter((s) => !(s === 'a' ? v.lineups.aLocked : v.lineups.bLocked)).map((s) => teamName(v, s));
    return { text: open.length ? `Lineups: waiting for ${open.join(' and ')}` : 'Lineups locked', clock: left !== null ? fmtClock(left) : null, tone: 'lineup' };
  }
  return { text: PHASE_TEXT[v.phase], clock: null, tone: v.phase };
}

export function RoomScene({ studio, room: v, now, logoSrc }: { studio: StudioState; room: MatchRoomView | null; now: number; logoSrc: (file: string) => string }) {
  if (!v) {
    return (
      <div class="ov-full">
        <Backdrop />
        <header class="ov-title">
          <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
          <h1 class="ov-title__main">Tournament room</h1>
        </header>
      </div>
    );
  }
  const math = seriesMath(v);
  const status = statusLine(v, now);
  const plan = v.plan ?? [];
  let bans = 0;
  const score = (s: Side): string => (math ? String(s === 'a' ? math.a : math.b) : v.result ? String((s === 'a' ? v.result.scoreA : v.result.scoreB) ?? '') : '');
  const lastLog = v.log.length > 0 ? v.log[v.log.length - 1]! : null;
  const side = (s: Side) => {
    const e = s === 'a' ? v.a : v.b;
    const lead = math?.leader === s || (math?.over && math.winner === s);
    return (
      <div class={`ov-room__team ov-room__team--${s}${lead ? ' is-lead' : ''}`}>
        <RoomLogo entry={e} size={112} logoSrc={logoSrc} />
        <div class="ov-room__who">
          <span class="ov-room__name">{e?.name ?? 'TBD'}</span>
          <span class="ov-room__meta">
            {e?.seed != null ? `Seed ${e.seed}` : ''}
            {v.higher === s ? ' · Higher seed' : ''}
            {v.phase === 'ready' ? (v.ready[s] ? ' · Ready' : ' · Not ready') : ''}
          </span>
        </div>
      </div>
    );
  };
  return (
    <div class="ov-full ov-room" data-phase={v.phase}>
      <Backdrop art="survivor-hilltop" />
      <header class="ov-title">
        <p class="ov-title__eyebrow">{v.eventName}</p>
        <h1 class="ov-title__main">{v.roundLabel}</h1>
      </header>

      <section class="ov-room__band" aria-label="Teams">
        {side('a')}
        <div class="ov-room__mid">
          {math || v.result ? (
            <p class="ov-room__score"><span>{score('a')}</span><i>:</i><span>{score('b')}</span></p>
          ) : <p class="ov-room__vs">vs</p>}
          <p class="ov-room__format">
            {math ? (math.totalScore ? (math.liveIncluded ? 'Total score so far' : 'Total score') : `Best of ${math.bestOf}`) : v.vetoSummary.split(':')[0]}
          </p>
          {math && (math.games.some((g) => g.state !== 'upcoming') || math.over) && (
            <p class={`ov-room__needs${math.needs ? ' is-chase' : ''}`}>{seriesNeedsText(math, (s) => teamName(v, s))}</p>
          )}
        </div>
        {side('b')}
      </section>

      {plan.length > 0 && (
        <ol class="ov-room__plan" aria-label="Veto order">
          {plan.map((p, i) => {
            if (p.kind === 'ban') bans++;
            return <li key={i} class={`ov-room__step ov-room__step--${p.kind} is-${p.state}`}>{stepChip(v, p, bans)}</li>;
          })}
        </ol>
      )}

      {v.pool.length > 0 && (
        <ul class="ov-room__pool" style={{ '--n': String(Math.min(v.pool.length, 7)) } as Record<string, string>}>
          {v.pool.map((c, i) => (
            <li key={c.slug} class={`ov-room__tile is-${c.state}${c.by ? ` by-${c.by}` : ''}`} style={{ '--tint': campaignTint(c.slug), animationDelay: `${i * 50}ms` } as Record<string, string>}>
              <span class="ov-room__tilename">{c.name}</span>
              <span class="ov-room__tilestate">{tileText(v, c)}</span>
            </li>
          ))}
        </ul>
      )}

      {v.games.length > 0 && (
        <div class="ov-room__games">
          {v.games.map((g, i) => {
            const line = math?.games[i];
            const a = line?.a ?? (g.state === 'done' ? g.scoreA : null);
            const b = line?.b ?? (g.state === 'done' ? g.scoreB : null);
            const won = line?.winner ?? null;
            return (
              <article key={g.id} class={`ov-room__game is-${g.state}`} style={{ '--tint': campaignTint(g.campaign) } as Record<string, string>}>
                <header>
                  <span class="ov-room__gametitle">{line?.title ?? `Game ${g.game}`}</span>
                  <span class="ov-room__gamestate">{g.state === 'done' ? 'Final' : g.state === 'live' ? (g.live?.map ? `Live · ${g.live.map}` : 'Live') : 'Up next'}</span>
                </header>
                <h2 class="ov-room__campaign">{g.campaignName}</h2>
                <p class="ov-room__facts">{gameFacts(v, g).join(' · ')}</p>
                {a !== null && b !== null && (
                  <p class="ov-room__gamescore">
                    <span class={won === 'a' ? 'is-win' : ''}>{`${tagOf(v.a)} ${a}`}</span>
                    <span class={won === 'b' ? 'is-win' : ''}>{`${b} ${tagOf(v.b)}`}</span>
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      <footer class={`ov-room__status is-${status.tone}`}>
        <span class="ov-room__statustext">{status.text}</span>
        {status.clock && <span class="ov-room__clock">{status.clock}</span>}
        {lastLog && v.phase === 'veto' && <span class="ov-room__last">{`Last: ${logText(v, lastLog)}`}</span>}
      </footer>
    </div>
  );
}
