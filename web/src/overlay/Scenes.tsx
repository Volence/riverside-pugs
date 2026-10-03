import { campaignTint, mapName } from '../format';
import { useRef } from 'preact/hooks';
import { camSlots } from '../../../src/cast/layout';
import { emptyQueue, stepAuto, type AutoCard } from './callouts';
import {
  boomerRate, CALLOUT_MS, ITEM, skeetTotal, type CastChapter, type TankRecap, type CastInfected, type CastLiveRound, type CastMatchView, type CastPlayer,
  type CastSurvivor, type CastTeam, type OverlayFeed, type OverlayKey, type StudioState,
} from '../../../src/cast/types';

/**
 * Every caster studio scene and layer (plan: Scenes). One component tree for
 * both ways of running OBS: a fixed scene per browser source, or `program`,
 * which follows the producer.
 *
 * The look is the site's poster style with L4D touches (plan ruling 16):
 * stencil lettering, the safe room arrow, thin accent rules,
 * campaign tints. Gameplay layers keep to the screen regions the game HUD
 * leaves free (plan ruling 15).
 */

interface Props { which: OverlayKey; feed: OverlayFeed; now: number }

export function Overlay({ which, feed, now }: Props) {
  const { studio, match } = feed;
  const auto = useAutoCallout(studio, match, now);
  const scene: OverlayKey = which === 'program' ? studio.scene : which;
  const tint = match ? campaignTint(match.campaign) : 'var(--c-blood-harvest)';
  const style = {
    '--team-a': match?.teams.a.color ?? '#5b8fd9',
    '--team-b': match?.teams.b.color ?? '#d9913f',
    '--tint': tint,
  } as Record<string, string>;
  return (
    <div class={`ov ov--${scene} theme--${studio.theme}`} style={style} data-scene={scene}>
      {/* Keyed on the scene and match so entrance animations replay on a cut. */}
      <div class="ov__scene" key={`${scene}:${match?.id ?? 0}`}>
        <SceneBody scene={scene} feed={feed} now={now} auto={auto} />
      </div>
      {which === 'program' && studio.lowerThird.show && <LowerThird studio={studio} />}
    </div>
  );
}

/** Auto-fire (studio.autoCallouts): this overlay's own queue of highlight
 *  cards from the live events. Held here, above the scene, so a cut between
 *  scenes keeps its place; every overlay runs the same queue off the same
 *  feed, so OBS sources agree. */
function useAutoCallout(studio: StudioState, match: CastMatchView | null, now: number): AutoCard | null {
  const q = useRef(emptyQueue());
  const manualUntil = studio.callout ? Date.parse(studio.callout.at) + CALLOUT_MS : 0;
  q.current = stepAuto(q.current, {
    matchId: match?.id ?? null, events: match?.events ?? [], on: studio.autoCallouts.on, kinds: studio.autoCallouts.kinds,
    manualUntil, now,
  });
  return q.current.showing;
}

function SceneBody({ scene, feed, now, auto }: { scene: OverlayKey; feed: OverlayFeed; now: number; auto: AutoCard | null }) {
  const { studio, match, live } = feed;
  switch (scene) {
    case 'starting': return <Starting studio={studio} match={match} now={now} />;
    case 'casters': return <Casters studio={studio} match={match} />;
    case 'gameplay': return <Gameplay studio={studio} match={match} live={live} now={now} auto={auto} />;
    case 'scorebug': return match ? <Scorebug studio={studio} match={match} live={live} /> : null;
    case 'roundhud': return <RoundHud studio={studio} match={match} live={live} force />;
    case 'lowerthird': return studio.lowerThird.show ? <LowerThird studio={studio} /> : null;
    case 'mapintro': return <MapIntro studio={studio} match={match} />;
    case 'maps': return <Chapters studio={studio} match={match} />;
    case 'lineups': return <Lineups studio={studio} match={match} />;
    case 'stats': return <Stats studio={studio} match={match} />;
    case 'brb': return <Brb studio={studio} match={match} now={now} />;
    case 'winner': return <Winner studio={studio} match={match} />;
    case 'ending': return <Ending studio={studio} match={match} />;
    case 'program': return null;
  }
}

/* ---------- shared pieces ---------- */

/** The full-frame backdrop: page black, grain, the campaign's tint and a
 *  survivor or infected still, darkened. */
function Backdrop({ art = 'survivor-hilltop' }: { art?: string }) {
  return (
    <div class="ov-bg" aria-hidden="true">
      <div class="ov-bg__art" style={{ backgroundImage: `url(/hud-backdrops/${art}.jpg)` }} />
      <div class="ov-bg__tint" />
      <div class="ov-bg__grain" />
    </div>
  );
}

/** The spray-painted safe room arrow. */
function SafeArrow({ class: cls = '' }: { class?: string }) {
  return (
    <svg class={`ov-arrow ${cls}`} viewBox="0 0 200 80" aria-hidden="true">
      <path d="M6 30 L120 30 L120 8 L194 40 L120 72 L120 50 L6 50 Z" />
      <path class="ov-arrow__drip" d="M40 50 L42 66 L44 50 Z M96 50 L97.5 60 L99 50 Z M150 62 L151.5 76 L153 60 Z" />
    </svg>
  );
}

/** The overlay key, for logo URLs: the OBS page sets it from ?k=, the
 *  producer panel's inline preview from its own key. */
let overlayKey = '';
export function setOverlayKey(k: string): void { overlayKey = k; }

function Logo({ team, size }: { team: CastTeam; size: number }) {
  const k = overlayKey;
  if (team.logoUrl) {
    return <img class="ov-logo" width={size} height={size} src={`/api/overlay/logo/${team.logoUrl}?k=${encodeURIComponent(k)}`} alt="" />;
  }
  return <span class="ov-logo ov-logo--tag" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` }}>{team.tag}</span>;
}

function SideChip({ side }: { side: CastTeam['side'] }) {
  if (!side) return null;
  return <span class={`ov-side ov-side--${side}`}>{side === 'survivor' ? 'Survivors' : 'Infected'}</span>;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Countdown({ to, now, label }: { to: string | null; now: number; label: string }) {
  if (!to) return <p class="ov-count ov-count--idle">{label}</p>;
  const left = Date.parse(to) - now;
  return (
    <div class="ov-count">
      <span class="ov-count__label">{left > 0 ? label : 'Any moment now'}</span>
      {left > 0 && <span class="ov-count__clock">{fmtClock(left)}</span>}
    </div>
  );
}

function Versus({ match, big = false }: { match: CastMatchView; big?: boolean }) {
  const { a, b } = match.teams;
  return (
    <div class={`ov-vs${big ? ' ov-vs--big' : ''}`}>
      <div class="ov-vs__team ov-vs__team--a">
        <Logo team={a} size={big ? 132 : 72} />
        <span class="ov-vs__name">{a.name}</span>
      </div>
      <span class="ov-vs__mid">vs</span>
      <div class="ov-vs__team ov-vs__team--b">
        <span class="ov-vs__name">{b.name}</span>
        <Logo team={b} size={big ? 132 : 72} />
      </div>
    </div>
  );
}

/** A thin band with the match-up, campaign and score, for full-frame scenes. */
function MatchRibbon({ match }: { match: CastMatchView }) {
  const { a, b } = match.teams;
  return (
    <div class="ov-ribbon">
      <span class="ov-ribbon__team" style={{ '--c': 'var(--team-a)' } as Record<string, string>}>{a.tag}</span>
      <span class="ov-ribbon__score">{a.score}</span>
      <span class="ov-ribbon__mid">
        {match.campaignName}
        {match.mapCount ? ` · Map ${match.mapNumber} of ${match.mapCount}` : ''}
      </span>
      <span class="ov-ribbon__score">{b.score}</span>
      <span class="ov-ribbon__team" style={{ '--c': 'var(--team-b)' } as Record<string, string>}>{b.tag}</span>
    </div>
  );
}

function Title({ studio, fallback }: { studio: StudioState; fallback: string }) {
  return (
    <header class="ov-title">
      <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
      <h1 class="ov-title__main">{fallback}</h1>
      {studio.subtitle && <p class="ov-title__sub">{studio.subtitle}</p>}
    </header>
  );
}

/* ---------- full-frame scenes ---------- */

function Starting({ studio, match, now }: { studio: StudioState; match: CastMatchView | null; now: number }) {
  return (
    <div class="ov-full">
      <Backdrop art="survivor-subway" />
      <div class="ov-starting">
        <p class="ov-starting__eyebrow">{studio.subtitle || 'Left 4 Dead Versus'}</p>
        <h1 class="ov-stencil ov-starting__title">{studio.title || 'Riverside PUGs'}</h1>
        <SafeArrow class="ov-starting__arrow" />
        {match && <Versus match={match} />}
        {match && <p class="ov-starting__campaign">{match.campaignName}</p>}
        <Countdown to={studio.countdownTo} now={now} label="Starting soon" />
      </div>
    </div>
  );
}

function Casters({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  const people = studio.casters.filter((c) => c.name);
  const slots = camSlots(Math.max(people.length, 1));
  return (
    <div class="ov-full ov-full--holes">
      {/* The backdrop with each cam frame cut out, so the cam sources OBS
          places under this overlay show through (plan ruling 11). */}
      <svg class="ov-holes" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true">
        <defs>
          <mask id="ov-holes-mask">
            <rect width="1920" height="1080" fill="white" />
            {slots.map((s, i) => <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill="black" />)}
          </mask>
          <radialGradient id="ov-holes-wash" cx="50%" cy="0%" r="70%">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
          </radialGradient>
        </defs>
        <g mask="url(#ov-holes-mask)">
          <rect width="1920" height="1080" fill="var(--base)" />
          <rect width="1920" height="1080" fill="url(#ov-holes-wash)" />
        </g>
      </svg>
      <div class="ov-casters__top">
        <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
        <h1 class="ov-stencil ov-casters__title">On the mic</h1>
      </div>
      {slots.map((s, i) => {
        const c = people[i];
        return (
          <div class="ov-cam" key={i} style={{ left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` }}>
            <div class="ov-cam__plate">
              <span class="ov-cam__name">{c?.name ?? 'Caster'}</span>
              {c?.handle && <span class="ov-cam__handle">{c.handle}</span>}
            </div>
          </div>
        );
      })}
      {match && <div class="ov-casters__bottom"><MatchRibbon match={match} /></div>}
    </div>
  );
}

function MapIntro({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Next map" /></div>;
  const ch = match.chapters[match.mapNumber - 1];
  const map = ch?.map ?? match.currentMap ?? '';
  const first = ch?.firstSurvivor ?? null;
  return (
    <div class="ov-full">
      <Backdrop art="survivor-hilltop" />
      <div class="ov-intro">
        <p class="ov-intro__eyebrow">{match.campaignName}</p>
        <p class="ov-intro__chapter">Chapter {match.mapNumber}{match.mapCount ? ` of ${match.mapCount}` : ''}</p>
        <h1 class="ov-stencil ov-intro__map">{mapName(map) || 'Next map'}</h1>
        <SafeArrow class="ov-intro__arrow" />
        <div class="ov-intro__sides">
          {first ? (
            <>
              <span class="ov-side ov-side--survivor">Survivors first</span>
              <span class="ov-intro__team" style={{ color: `var(--team-${first})` }}>{match.teams[first].name}</span>
            </>
          ) : <span class="ov-intro__team ov-intro__team--muted">Sides set in game</span>}
        </div>
      </div>
      <div class="ov-full__foot"><MatchRibbon match={match} /></div>
    </div>
  );
}

function Chapters({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Chapter scores" /></div>;
  const rows: CastTeam[] = [match.teams.a, match.teams.b];
  const cell = (c: CastChapter, t: 'a' | 'b') => c[t];
  return (
    <div class="ov-full">
      <Backdrop art="survivor-subway" />
      <Title studio={studio} fallback={match.campaignName} />
      <table class="ov-table ov-chapters">
        <thead>
          <tr>
            <th />
            {match.chapters.map((c) => (
              <th key={c.number} class={c.state === 'playing' ? 'is-now' : ''}>
                <span class="ov-chapters__n">{c.number}</span>
                <span class="ov-chapters__map">{mapName(c.map)}</span>
              </th>
            ))}
            <th class="ov-chapters__total">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.key} style={{ '--c': `var(--team-${t.key})` } as Record<string, string>}>
              <th class="ov-chapters__team"><Logo team={t} size={56} /><span>{t.name}</span></th>
              {match.chapters.map((c) => {
                const v = cell(c, t.key);
                return (
                  <td key={c.number} class={c.state === 'playing' ? 'is-now' : ''}>
                    {v === null ? <span class="ov-dim">{c.state === 'playing' ? 'Live' : ''}</span> : v}
                    {c.firstSurvivor === t.key && <span class="ov-chapters__first" title="Survivors first">S</span>}
                  </td>
                );
              })}
              <td class="ov-chapters__total">{t.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="ov-foot-note"><span class="ov-chapters__first">S</span> played survivors first on that chapter</p>
    </div>
  );
}

function Avatar({ p }: { p: CastPlayer }) {
  // The Steam avatar we keep for every player; a letter only when there is none.
  return p.avatar
    ? <img class="ov-card__avatar" src={p.avatar} alt="" referrerpolicy="no-referrer" />
    : <span class="ov-card__avatar ov-card__avatar--none">{[...p.name][0]?.toUpperCase() ?? '?'}</span>;
}

const ROLE_LABEL: Record<NonNullable<CastPlayer['role']>, string | null> = { captain: 'Captain', cocaptain: 'Co-captain', member: null };

/** A PUG lineup card: SR and the career PUG numbers (owner's stat set). */
function PugCard({ p, team, delay }: { p: CastPlayer; team: CastTeam; delay: number }) {
  const c = p.career!;
  const winPct = c.wins + c.losses > 0 ? Math.round((c.wins / (c.wins + c.losses)) * 100) : null;
  return (
    <div class="ov-card" style={{ animationDelay: `${delay}ms`, '--c': `var(--team-${team.key})` } as Record<string, string>}>
      <Avatar p={p} />
      <div class="ov-card__body">
        <span class="ov-card__name">{p.name}</span>
        <span class="ov-card__line">
          {p.sr !== null && <b>{p.sr} SR</b>}
          {c.matches} PUGs{winPct !== null ? ` · ${winPct}% won` : ''}
        </span>
      </div>
      <dl class="ov-card__stats">
        <div><dt>Skeets</dt><dd>{c.skeets}</dd></div>
        {/* Not upper-cased: "DPS" reads as damage per second. */}
        <div><dt class="ov-keepcase">DPs</dt><dd>{c.dps}</dd></div>
        <div><dt>Boomer %</dt><dd>{c.boomerRate === null ? '-' : `${c.boomerRate}%`}</dd></div>
      </dl>
    </div>
  );
}

/** A scrim or tournament lineup card: the team's roster, never PUG numbers
 *  (owner, 2026-10-02). The right-hand slot is where event or team stats go
 *  once they exist; it stays empty rather than inventing any. */
function RosterCard({ p, team, delay }: { p: CastPlayer; team: CastTeam; delay: number }) {
  const role = p.role ? ROLE_LABEL[p.role] : null;
  return (
    <div class="ov-card ov-card--roster" style={{ animationDelay: `${delay}ms`, '--c': `var(--team-${team.key})` } as Record<string, string>}>
      <Avatar p={p} />
      <div class="ov-card__body">
        <span class="ov-card__name">{p.name}</span>
        <span class="ov-card__line">
          <b class="ov-card__tag">{team.tag}</b>
          {role && <span class="ov-card__role">{role}</span>}
        </span>
      </div>
      <div class="ov-card__slot" aria-hidden="true" />
    </div>
  );
}

function Lineups({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Lineups" /></div>;
  const pug = match.kind === 'pug';
  // Captain first on a team roster; a PUG keeps its order.
  const order = (ps: CastPlayer[]) => pug ? ps : [...ps].sort((x, y) => rank(x) - rank(y));
  const rank = (p: CastPlayer) => (p.role === 'captain' ? 0 : p.role === 'cocaptain' ? 1 : 2);
  return (
    <div class="ov-full">
      <Backdrop art="infected-hunter" />
      <Title studio={studio} fallback="Lineups" />
      <div class="ov-lineups">
        {[match.teams.a, match.teams.b].map((t) => (
          <section key={t.key} class={`ov-lineups__team ov-lineups__team--${t.key}`} style={{ '--c': `var(--team-${t.key})` } as Record<string, string>}>
            <header class="ov-lineups__head"><Logo team={t} size={64} /><h2>{t.name}</h2></header>
            {order(t.players).map((p, i) => {
              const delay = 200 + i * 90 + (t.key === 'b' ? 45 : 0);
              return pug && p.career ? <PugCard key={p.steamid} p={p} team={t} delay={delay} /> : <RosterCard key={p.steamid} p={p} team={t} delay={delay} />;
            })}
          </section>
        ))}
      </div>
      <p class="ov-foot-note">{pug ? 'Career PUG numbers from riversidepug.com' : 'Rosters from riversidepug.com'}</p>
    </div>
  );
}

/** The owner's stat set (2026-10-02), survivor columns then infected. Every
 *  one is in the 10 s LIVESTAT line and in the final box score. Skeets is
 *  solo plus team skeets, counted once; Boomer % is booms landed per boomer
 *  life, absent (shown "-") with no boomers. */
const STAT_COLS: { key: string; label: string; side: 'survivor' | 'infected'; get: (s: Record<string, number>) => number | null; pct?: boolean }[] = [
  { key: 'sidmg', label: 'SI dmg', side: 'survivor', get: (s) => s.sidmg ?? null },
  { key: 'sikill', label: 'SI kills', side: 'survivor', get: (s) => s.sikill ?? null },
  { key: 'ck', label: 'Commons', side: 'survivor', get: (s) => s.ck ?? null },
  { key: 'skeets', label: 'Skeets', side: 'survivor', get: skeetTotal },
  { key: 'tank_damage', label: 'Tank dmg', side: 'survivor', get: (s) => s.tank_damage ?? null },
  { key: 'dps_landed', label: 'DPs', side: 'infected', get: (s) => s.dps_landed ?? null },
  { key: 'boomer_rate', label: 'Boomer %', side: 'infected', get: boomerRate, pct: true },
];

function Stats({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Match stats" /></div>;
  const best = new Map<string, number>();
  for (const c of STAT_COLS) {
    best.set(c.key, Math.max(0, ...[...match.teams.a.players, ...match.teams.b.players].map((p) => c.get(p.stats) ?? 0)));
  }
  const nSurv = STAT_COLS.filter((c) => c.side === 'survivor').length;
  return (
    <div class="ov-full">
      <Backdrop art="infected-ghost" />
      <Title studio={studio} fallback={match.state === 'completed' ? 'Final stats' : 'Match stats'} />
      <table class="ov-table ov-stats">
        <thead>
          <tr class="ov-stats__sides">
            <th />
            <th colSpan={nSurv} class="ov-stats__side ov-stats__side--survivor">As survivors</th>
            <th colSpan={STAT_COLS.length - nSurv} class="ov-stats__side ov-stats__side--infected">As infected</th>
          </tr>
          <tr>
            <th />
            {STAT_COLS.map((c, i) => <th key={c.key} class={[i === nSurv ? 'ov-stats__split' : '', c.key === 'dps_landed' ? 'ov-keepcase' : ''].filter(Boolean).join(' ')}>{c.label}</th>)}
          </tr>
        </thead>
        {[match.teams.a, match.teams.b].map((t) => (
          <tbody key={t.key} style={{ '--c': `var(--team-${t.key})` } as Record<string, string>}>
            <tr class="ov-stats__team"><th colSpan={STAT_COLS.length + 1}>{t.name} <span class="ov-stats__score">{t.score}</span></th></tr>
            {t.players.map((p) => (
              <tr key={p.steamid}>
                <th class="ov-stats__name">{p.name}</th>
                {STAT_COLS.map((c, i) => {
                  const v = c.get(p.stats);
                  const top = v !== null && v > 0 && v === best.get(c.key);
                  const cls = [top ? 'is-top' : '', i === nSurv ? 'ov-stats__split' : ''].filter(Boolean).join(' ');
                  return <td key={c.key} class={cls}>{v === null ? <span class="ov-dim">-</span> : c.pct ? `${v}%` : v.toLocaleString('en-US')}</td>;
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <p class="ov-foot-note">Gold marks the best in the match{match.state === 'completed' ? '' : ' so far'}</p>
    </div>
  );
}

function Brb({ studio, match, now }: { studio: StudioState; match: CastMatchView | null; now: number }) {
  return (
    <div class="ov-full">
      <Backdrop art="infected-ghost" />
      <div class="ov-brb">
        <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
        <h1 class="ov-stencil ov-brb__title">Be right back</h1>
        <p class="ov-brb__sub">{studio.subtitle || 'Hold the door. We will be right back.'}</p>
        {studio.countdownTo && <Countdown to={studio.countdownTo} now={now} label="Back in" />}
      </div>
      {match && <div class="ov-full__foot"><MatchRibbon match={match} /></div>}
    </div>
  );
}

function Winner({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="GG" /></div>;
  const { a, b } = match.teams;
  // The recorded winner once the match has completed; before that, whoever leads.
  const w = match.winner ?? (a.score === b.score ? 'draw' : a.score > b.score ? 'a' : 'b');
  const team = w === 'draw' ? null : match.teams[w];
  return (
    <div class="ov-full">
      <Backdrop art="survivor-hilltop" />
      <div class="ov-winner" style={{ '--c': team ? `var(--team-${team.key})` : 'var(--bone)' } as Record<string, string>}>
        <p class="ov-title__eyebrow">{match.campaignName}{match.state !== 'completed' ? ' · Not final' : ''}</p>
        {team ? (
          <>
            <Logo team={team} size={180} />
            <h1 class="ov-stencil ov-winner__name">{team.name}</h1>
            <p class="ov-winner__wins">{match.state === 'completed' ? 'Made it to the safe room' : 'In the lead'}</p>
          </>
        ) : <h1 class="ov-stencil ov-winner__name">Draw</h1>}
        <div class="ov-winner__score">
          <span style={{ color: 'var(--team-a)' }}>{a.tag} {a.score}</span>
          <span class="ov-dim">-</span>
          <span style={{ color: 'var(--team-b)' }}>{b.score} {b.tag}</span>
        </div>
      </div>
    </div>
  );
}

function Ending({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  const people = studio.casters.filter((c) => c.name);
  return (
    <div class="ov-full">
      <Backdrop art="survivor-subway" />
      <div class="ov-ending">
        <h1 class="ov-stencil ov-ending__title">Thanks for watching</h1>
        <SafeArrow class="ov-ending__arrow" />
        {people.length > 0 && (
          <p class="ov-ending__casters">
            {people.map((c, i) => <span key={i}>{c.name}{c.handle ? <em> {c.handle}</em> : null}</span>)}
          </p>
        )}
        <p class="ov-ending__site">Play with us at <b>riversidepug.com</b></p>
      </div>
      {match && <div class="ov-full__foot"><MatchRibbon match={match} /></div>}
    </div>
  );
}

function LowerThird({ studio }: { studio: StudioState }) {
  const lt = studio.lowerThird;
  if (!lt.title && !lt.text) return null;
  return (
    <div class="ov-lt" key={`${lt.title}|${lt.text}`}>
      {lt.title && <span class="ov-lt__title">{lt.title}</span>}
      {lt.text && <span class="ov-lt__text">{lt.text}</span>}
    </div>
  );
}

/* ---------- gameplay ---------- */

function Gameplay({ studio, match, live, now, auto }: {
  studio: StudioState; match: CastMatchView | null; live: CastLiveRound | null; now: number; auto: AutoCard | null;
}) {
  // Nothing on air: OBS gets a transparent frame, never a placeholder on
  // stream (the producer panel's preview shows a labelled sample instead).
  if (!match) return null;
  if (studio.hudStyle !== 'scorebug') {
    const Hud = studio.hudStyle === 'corners' ? CornersHud : studio.hudStyle === 'rail' ? RailHud : studio.hudStyle === 'frame' ? FrameHud : PlateHud;
    const rows = studio.elements.survivors || studio.elements.infected;
    return (
      <div class={`ov-game ov-game--${studio.hudStyle}${rows ? ' has-rows' : ''}`}>
        <Hud studio={studio} match={match} live={live} />
        {studio.elements.tankRecap && live?.tankRecap && <TankRecapCard r={live.tankRecap} />}
        <Callout studio={studio} match={match} now={now} auto={auto} />
      </div>
    );
  }
  return (
    <div class={`ov-game ov-game--${studio.scorebugAt}`}>
      <div class="ov-game__col">
        <Scorebug studio={studio} match={match} live={live} />
        <RoundHud studio={studio} match={match} live={live} />
      </div>
      {studio.elements.tankRecap && live?.tankRecap && <TankRecapCard r={live.tankRecap} />}
      <Callout studio={studio} match={match} now={now} auto={auto} />
    </div>
  );
}

function Scorebug({ studio, match, live }: { studio: StudioState; match: CastMatchView; live: CastLiveRound | null }) {
  const { a, b } = match.teams;
  const chapter = match.chapters[match.mapNumber - 1];
  // Typed for this map, else from the server (bossFlows). 0 is "no boss".
  const flows = bossFlows(studio, match, live);
  const tankPct = flows.tank !== null && flows.tank > 0 ? flows.tank : null;
  const witchPct = flows.witch !== null && flows.witch > 0 ? flows.witch : null;
  const bosses = studio.elements.bosses && (tankPct !== null || witchPct !== null || flows.witch === -2);
  const status = match.phase === 'paused' ? 'Paused' : match.phase === 'readyup' ? 'Ready-up' : match.half ? `Round ${match.half}` : null;
  return (
    <div class={`ov-bug ov-bug--${studio.scorebugAt}`}>
      <div class="ov-bug__row">
        <BugTeam team={a} />
        <div class="ov-bug__mid">
          <span class="ov-bug__map">
            {match.mapCount ? `Map ${match.mapNumber}/${match.mapCount}` : `Map ${match.mapNumber}`}
            {match.game ? ` · Game ${match.game.number}` : ''}
          </span>
          <span class="ov-bug__chapter">{chapter ? mapName(chapter.map) : match.campaignName}</span>
          {status && <span class={`ov-bug__status${match.phase === 'paused' ? ' is-paused' : ''}`}>{status}</span>}
        </div>
        <BugTeam team={b} right />
      </div>
      {bosses && (
        <div class="ov-bug__bosses">
          {tankPct !== null && <span><b>Tank</b> {tankPct}%</span>}
          {witchPct !== null ? <span><b>Witch</b> {witchPct}%</span> : flows.witch === -2 ? <span><b>Witch</b> party</span> : null}
        </div>
      )}
    </div>
  );
}

function BugTeam({ team, right = false }: { team: CastTeam; right?: boolean }) {
  return (
    <div class={`ov-bug__team${right ? ' ov-bug__team--r' : ''}`} style={{ '--c': `var(--team-${team.key})` } as Record<string, string>}>
      <span class="ov-bug__stripe" />
      <span class="ov-bug__ident">
        <span class="ov-bug__tag">{team.tag}</span>
        <span class={`ov-bug__side ov-bug__side--${team.side ?? 'none'}`}>{team.side === 'survivor' ? 'Surv' : team.side === 'infected' ? 'Inf' : ''}</span>
      </span>
      <span class="ov-bug__score">{team.score}</span>
    </div>
  );
}

function RoundHud({ studio, match, live, force = false }: {
  studio: StudioState; match: CastMatchView | null; live: CastLiveRound | null; force?: boolean;
}) {
  if (!match || !live) return null;
  const el = force ? { survivors: true, infected: true, tank: true } : studio.elements;
  const survTeam = match.teams.a.side === 'survivor' ? match.teams.a : match.teams.b.side === 'survivor' ? match.teams.b : null;
  const infTeam = survTeam ? (survTeam.key === 'a' ? match.teams.b : match.teams.a) : null;
  return (
    <div class="ov-round">
      {el.tank && live.tank && <TankBar tank={live.tank} team={infTeam} />}
      {el.survivors && live.survivors.length > 0 && (
        <div class="ov-round__row" style={{ '--c': survTeam ? `var(--team-${survTeam.key})` : 'var(--win)' } as Record<string, string>}>
          {live.survivors.map((s, i) => <SurvivorCard key={`${s.slot}:${i}`} s={s} />)}
        </div>
      )}
      {el.infected && live.infected.length > 0 && (
        <div class="ov-round__row" style={{ '--c': infTeam ? `var(--team-${infTeam.key})` : 'var(--loss)' } as Record<string, string>}>
          {live.infected.map((i) => <InfectedCard key={i.slot} i={i} />)}
        </div>
      )}
    </div>
  );
}

function TankBar({ tank, team }: { tank: NonNullable<CastLiveRound['tank']>; team: CastTeam | null }) {
  const frac = tank.maxHealth > 0 ? Math.max(0, Math.min(1, tank.health / tank.maxHealth)) : 0;
  return (
    <div class="ov-tank">
      <span class="ov-tank__label"><ClassIcon cls="tank" /> Tank</span>
      <span class="ov-tank__who">{tank.controller ?? 'AI'}{team ? ` · ${team.tag}` : ''}</span>
      <span class="ov-tank__bar"><span class="ov-tank__fill" style={{ width: `${frac * 100}%` }} /></span>
      <span class="ov-tank__hp">{tank.health.toLocaleString('en-US')}</span>
    </div>
  );
}

/** Weapon names short enough for a 150px card. */
const SHORT_WEAPON: Record<string, string> = {
  'Pump Shotgun': 'Pump', 'Auto Shotgun': 'Auto', 'Assault Rifle': 'Rifle', 'Hunting Rifle': 'Hunting', 'SMG': 'SMG', 'Pistol': 'Pistol',
  'Pipe Bomb': 'Pipe', 'Molotov': 'Molotov', 'First Aid Kit': 'Kit', 'Pain Pills': 'Pills',
};

function SurvivorCard({ s }: { s: CastSurvivor }) {
  const max = s.incap ? 300 : 100;
  const perm = Math.max(0, Math.min(1, s.health / max));
  const temp = s.incap ? 0 : Math.max(0, Math.min(1 - perm, s.temp / 100));
  const state = !s.alive ? 'Dead' : s.ledge ? 'Ledge' : s.incap ? 'Down' : s.pinned ? 'Pinned' : null;
  const tone = !s.alive ? 'dead' : s.incap || s.ledge ? 'down' : s.health + s.temp < 40 ? 'low' : 'ok';
  return (
    <div class={`ov-surv ov-surv--${tone}`}>
      <SurvivorFace s={s} class="ov-surv__face" />
      <div class="ov-surv__body">
        <span class="ov-surv__name">{s.name}</span>
        <span class="ov-surv__bar">
          <span class="ov-surv__perm" style={{ width: `${perm * 100}%` }} />
          <span class="ov-surv__temp" style={{ left: `${perm * 100}%`, width: `${temp * 100}%` }} />
        </span>
        <span class="ov-surv__line">{state ?? `${s.health + s.temp} HP`}{s.alive && s.weapon ? <em> {SHORT_WEAPON[s.weapon] ?? s.weapon}</em> : null}</span>
      </div>
    </div>
  );
}

/** The game's own art (scripts/export-cast-art.py): the released
 *  character-select faces, the HUD's infected team icons, the witch from the
 *  achievement art, and the inventory glyphs. */
const SI_CLASSES = new Set(['hunter', 'smoker', 'boomer', 'tank']);
function ClassIcon({ cls, class: extra = '' }: { cls: string; class?: string }) {
  const src = SI_CLASSES.has(cls) ? `/cast-art/si-${cls}.png` : cls === 'witch' ? '/cast-art/witch.png' : null;
  if (!src) return <span class={`ov-ci ov-ci--none ${extra}`} />;
  return <img class={`ov-ci ov-ci--${cls} ${extra}`} src={src} alt={cls} />;
}

function SurvivorFace({ s, class: cls = '' }: { s: CastSurvivor; class?: string }) {
  const known = ['bill', 'zoey', 'francis', 'louis'].includes(s.character);
  if (!known) return <span class={`ov-face ov-face--none ${cls}`} />;
  return <img class={`ov-face${s.alive ? '' : ' is-dead'} ${cls}`} src={`/cast-art/survivor-${s.character}.png`} alt={s.character} />;
}

function ItemIcon({ kind }: { kind: 'kit' | 'pills' | 'pipe' | 'molotov' }) {
  const label = { kit: 'First aid kit', pills: 'Pain pills', pipe: 'Pipe bomb', molotov: 'Molotov' }[kind];
  return <img class={`ov-item ov-item--${kind}`} src={`/cast-art/item-${kind}.png`} alt={label} />;
}

function Items({ items }: { items: number | null }) {
  if (!items) return null;
  return (
    <span class="ov-items">
      {items & ITEM.KIT ? <ItemIcon kind="kit" /> : null}
      {items & ITEM.PILLS ? <ItemIcon kind="pills" /> : null}
      {items & ITEM.MOLOTOV ? <ItemIcon kind="molotov" /> : items & ITEM.PIPE ? <ItemIcon kind="pipe" /> : null}
    </span>
  );
}

function InfectedCard({ i }: { i: CastInfected }) {
  const cls = i.cls ? `${i.cls[0]!.toUpperCase()}${i.cls.slice(1)}` : '';
  const label = !i.alive ? (cls ? `${cls} · Dead` : 'Dead') : i.ghost ? `${cls || 'Spawning'} · Ghost` : `${cls} · ${i.health} HP`;
  return (
    <div class={`ov-inf${!i.alive ? ' ov-inf--dead' : i.ghost ? ' ov-inf--ghost' : ''}`}>
      <ClassIcon cls={i.cls} class="ov-inf__icon" />
      <div class="ov-inf__body">
        <span class="ov-inf__name">{i.name}</span>
        <span class="ov-inf__line">{label}</span>
      </div>
    </div>
  );
}

/** The highlight card: the producer's own while it is up, else auto-fire's. */
function Callout({ studio, match, now, auto }: { studio: StudioState; match: CastMatchView; now: number; auto: AutoCard | null }) {
  const m = studio.callout;
  const age = m ? now - Date.parse(m.at) : -1;
  const c = m && age >= 0 && age <= CALLOUT_MS ? { ...m, key: m.at } : auto;
  if (!c) return null;
  const team = c.team ? match.teams[c.team] : null;
  return (
    <div class={`ov-callout ov-callout--${studio.calloutSize}`} key={c.key} style={{ '--c': team ? `var(--team-${team.key})` : 'var(--accent)' } as Record<string, string>}>
      <span class="ov-callout__rule" />
      <span class="ov-callout__title">{c.title}</span>
      {c.text && <span class="ov-callout__text">{c.text}</span>}
      {team && <span class="ov-callout__team">{team.name}</span>}
    </div>
  );
}

/* ---------- gameplay: the three broadcast looks (plan ruling 23) ---------- */

/** Boss flow % for the map being played: what the producer typed for this
 *  map wins (an override, like the team fields), else what the server sends. */
function bossFlows(studio: StudioState, match: CastMatchView, live: CastLiveRound | null): { tank: number | null; witch: number | null } {
  const sameMap = studio.bosses.map === null || match.currentMap === null || studio.bosses.map === match.currentMap;
  const typedTank = sameMap ? studio.bosses.tank : null;
  const typedWitch = sameMap ? studio.bosses.witch : null;
  return {
    tank: typedTank ?? (live?.hud?.tank ?? null),
    witch: typedWitch ?? (live?.hud?.witch ?? null),
  };
}

interface HudProps { studio: StudioState; match: CastMatchView; live: CastLiveRound | null }

/** What every look needs, worked out once. */
function hudData({ studio, match, live }: HudProps) {
  const { a, b } = match.teams;
  const el = studio.elements;
  const bosses = el.bosses ? bossFlows(studio, match, live) : { tank: null, witch: null };
  const progress = live?.hud?.progress ?? null;
  const strip = el.progress && live !== null && (progress !== null || bosses.tank !== null || bosses.witch !== null);
  const survTeam = a.side === 'survivor' ? a : b.side === 'survivor' ? b : null;
  const infTeam = survTeam ? (survTeam.key === 'a' ? b : a) : null;
  const chapter = match.chapters[match.mapNumber - 1];
  const mapLabel = chapter ? mapName(chapter.map) : match.campaignName;
  const paused = match.phase === 'paused';
  const meta = [
    match.mapCount ? `Map ${match.mapNumber} of ${match.mapCount}` : `Map ${match.mapNumber}`,
    paused ? null : match.phase === 'readyup' ? 'Ready-up' : match.half ? `Round ${match.half}` : null,
    match.game ? `Game ${match.game.number} of ${match.game.of}` : null,
  ].filter(Boolean).join(' · ');
  const tank = el.tank && live?.tank ? live.tank : null;
  const reach = live?.hud?.rivalReach ?? null;
  const rival = el.rival && reach !== null && infTeam ? { team: infTeam, reach } : null;
  const dots = el.dots && live ? live.survivors.filter((s) => s.flow !== null && s.alive) : [];
  return { a, b, el, bosses, progress, strip, survTeam, infTeam, mapLabel, paused, meta, tank, rival, dots };
}

const teamVar = (t: CastTeam | null, fallback: string) =>
  ({ '--c': t ? `var(--team-${t.key})` : fallback } as Record<string, string>);

function SideWord({ team }: { team: CastTeam }) {
  return <span class={`ov-sideword ov-sideword--${team.side ?? 'none'}`}>{team.side === 'survivor' ? 'Survivors' : team.side === 'infected' ? 'Infected' : 'Campaign'}</span>;
}

/** Health ring in the medallion: permanent health, then temp health in a
 *  lighter tone, on a 64-unit circle starting at the top. */
const RING_R = 29;
const RING_C = 2 * Math.PI * RING_R;
function Ring({ perm, temp, tone }: { perm: number; temp: number; tone: string }) {
  return (
    <svg class={`ov-ring ov-ring--${tone}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle class="ov-ring__track" cx="32" cy="32" r={RING_R} />
      {temp > 0 && <circle class="ov-ring__temp" cx="32" cy="32" r={RING_R} stroke-dasharray={`${temp * RING_C} ${RING_C}`} stroke-dashoffset={-perm * RING_C} />}
      {perm > 0 && <circle class="ov-ring__perm" cx="32" cy="32" r={RING_R} stroke-dasharray={`${perm * RING_C} ${RING_C}`} />}
    </svg>
  );
}

/** A survivor medallion and its words: the released portrait in a ring of
 *  health (temp health lighter), the state colour from the replay viewer's
 *  state ring (down red, pinned gold, biled purple), held items. */
function SurvivorRow({ s, layout }: { s: CastSurvivor; layout: 'row' | 'chip' }) {
  const max = s.incap || s.ledge ? 300 : 100;
  const perm = s.alive ? Math.max(0, Math.min(1, s.health / max)) : 0;
  const temp = s.alive && !s.incap && !s.ledge ? Math.max(0, Math.min(1 - perm, s.temp / 100)) : 0;
  const state = !s.alive ? 'Dead' : s.ledge ? 'Ledge' : s.incap ? 'Down' : s.pinned ? 'Pinned' : s.biled ? 'Biled' : null;
  const tone = !s.alive ? 'dead' : s.incap || s.ledge ? 'down' : s.pinned ? 'pinned' : s.biled ? 'biled' : s.health + s.temp < 40 ? 'low' : 'ok';
  const hp = s.alive ? (s.incap || s.ledge ? s.health : s.health + s.temp) : null;
  return (
    <div class={`ov-mrow ov-mrow--${layout} is-${tone}`}>
      <span class="ov-med">
        <SurvivorFace s={s} class="ov-med__img" />
        <Ring perm={perm} temp={temp} tone={tone} />
      </span>
      <span class="ov-mrow__text">
        <span class="ov-mrow__name">{s.name}</span>
        <span class="ov-mrow__line">
          {state ? <b class="ov-mrow__state">{state}</b> : null}
          {hp !== null && <span class="ov-mrow__hp">{hp}</span>}
          {s.alive && !state ? <Items items={s.items} /> : null}
        </span>
      </span>
    </div>
  );
}

/** Spawn health by class for an SI ring (L4D1 versus defaults; a glance,
 *  not a number, so a config tweak is harmless). */
const SI_MAX: Record<string, number> = { smoker: 250, boomer: 50, hunter: 250 };

function InfectedRow({ i, tankMax, layout }: { i: CastInfected; tankMax: number; layout: 'row' | 'chip' }) {
  const cls = i.cls ? i.cls[0]!.toUpperCase() + i.cls.slice(1) : '';
  const max = i.cls === 'tank' ? tankMax || i.health : SI_MAX[i.cls] ?? 0;
  const frac = i.alive && !i.ghost && max > 0 ? Math.max(0, Math.min(1, i.health / max)) : 0;
  const status = !i.alive ? 'Dead' : i.ghost ? 'Spawning' : cls;
  const tone = !i.alive ? 'dead' : i.ghost ? 'ghost' : i.cls === 'tank' ? 'tank' : 'up';
  return (
    <div class={`ov-mrow ov-mrow--${layout} ov-mrow--inf is-${tone}`}>
      <span class="ov-med ov-med--inf">
        {i.alive ? <ClassIcon cls={i.cls} class="ov-med__img" /> : <span class="ov-med__img ov-med__img--empty" />}
        <Ring perm={frac} temp={0} tone={tone} />
      </span>
      <span class="ov-mrow__text">
        <span class="ov-mrow__name">{i.name}</span>
        <span class="ov-mrow__line">
          <b class="ov-mrow__state">{status}</b>
          {i.dmg !== null && <span class="ov-mrow__dmg"><em>Dmg</em> {i.dmg}</span>}
        </span>
      </span>
    </div>
  );
}

/** One team's players for the side it is playing, as medallions; nothing
 *  while no round is running or when that side's switch is off. */
function TeamMedallions({ team, live, el, layout, tankMax }: {
  team: CastTeam; live: CastLiveRound | null; el: StudioState['elements']; layout: 'row' | 'chip'; tankMax: number;
}) {
  if (!live || !team.side) return null;
  if (team.side === 'survivor') {
    if (!el.survivors) return null;
    return <>{live.survivors.slice(0, 4).map((s, k) => <SurvivorRow key={`${s.slot}:${k}`} s={s} layout={layout} />)}</>;
  }
  if (!el.infected) return null;
  return <>{live.infected.slice(0, 4).map((i) => <InfectedRow key={i.slot} i={i} tankMax={tankMax} layout={layout} />)}</>;
}

/** Map progress: the furthest survivor's flow, ten ticks, and the tank and
 *  witch spawn points pinned on it as the game's own icons. Every look keeps
 *  it (owner, 2026-10-02). */
function Progress({ progress, bosses, team, rival, dots }: {
  progress: number | null; bosses: { tank: number | null; witch: number | null }; team: CastTeam | null;
  /** The opponent's mark: the other team and how far it got here. */
  rival: { team: CastTeam; reach: number } | null;
  /** Survivors with a known flow, for the dots. */
  dots: CastSurvivor[];
}) {
  const at = (pct: number) => ({ left: `${pct}%` });
  const pin = (pct: number, kind: 'tank' | 'witch') => (
    <span class={`ov-pg__pin ov-pg__pin--${kind}${progress !== null && progress >= pct ? ' is-passed' : ''}`} style={at(pct)}>
      <ClassIcon cls={kind} /><b>{pct}%</b>
    </span>
  );
  return (
    <div class="ov-pg" style={teamVar(team, 'var(--win)')}>
      <span class="ov-pg__label">Progress</span>
      <span class="ov-pg__track">
        {progress !== null && <span class="ov-pg__fill" style={{ width: `${progress}%` }} />}
        {Array.from({ length: 9 }, (_, k) => <span key={k} class="ov-pg__tick" style={at((k + 1) * 10)} />)}
        {rival && (
          <span class="ov-pg__rival" style={{ left: `${rival.reach}%`, ...teamVar(rival.team, '') }}>
            <b>{rival.team.tag} {rival.reach}%</b>
          </span>
        )}
        {dots.map((s, k) => (
          <span key={k} class={`ov-pg__dot${s.alive ? '' : ' is-dead'}`} style={{ left: `${s.flow}%` }} title={s.name}>
            <SurvivorFace s={s} />
          </span>
        ))}
        {bosses.tank !== null && bosses.tank > 0 && pin(bosses.tank, 'tank')}
        {bosses.witch !== null && bosses.witch > 0 && pin(bosses.witch, 'witch')}
      </span>
      <span class="ov-pg__pct">{progress !== null ? `${progress}%` : ''}</span>
      {bosses.witch === -2 && <span class="ov-pg__note">Witch party</span>}
    </div>
  );
}

function TankCard({ tank, team }: { tank: NonNullable<CastLiveRound['tank']>; team: CastTeam | null }) {
  const frac = tank.maxHealth > 0 ? Math.max(0, Math.min(1, tank.health / tank.maxHealth)) : 0;
  return (
    <div class="ov-tc" style={teamVar(team, 'var(--loss)')}>
      <ClassIcon cls="tank" class="ov-tc__icon" />
      <span class="ov-tc__words">
        <b>Tank</b>
        <span>{tank.controller ?? 'AI'}{team ? ` · ${team.tag}` : ''}</span>
      </span>
      <span class="ov-tc__bar"><span class="ov-tc__fill" style={{ width: `${frac * 100}%` }} /></span>
      <span class="ov-tc__hp">{tank.health.toLocaleString('en-US')}</span>
    </div>
  );
}

/**
 * PLATE. A poster plate at top centre: each team's tag and score either side
 * of the map in stencil type, cut at an angle, with the progress strip as
 * its bottom rail. Rows on: each team's players as medallions stacked down
 * its own side of the screen, mid height, clear of the game's corners.
 */
function PlateHud(props: HudProps & { noStacks?: boolean }) {
  const d = hudData(props);
  const tankMax = props.live?.tank?.maxHealth ?? 0;
  const side = (t: CastTeam, right: boolean) => (
    <div class={`ov-plate__team${right ? ' ov-plate__team--r' : ''}`} style={teamVar(t, '')}>
      {t.logoUrl && <Logo team={t} size={52} />}
      <span class="ov-plate__ident">
        <span class="ov-plate__name">{t.name}</span>
        <SideWord team={t} />
      </span>
      <span class="ov-plate__pts">{t.score}</span>
    </div>
  );
  return (
    <>
      <div class="ov-plate">
        <div class="ov-plate__main">
          {side(d.a, false)}
          <div class="ov-plate__mid">
            <span class="ov-plate__event">{props.studio.title || 'Riverside PUGs'}</span>
            <span class="ov-plate__map">{d.mapLabel}</span>
            <span class="ov-plate__meta">{d.paused ? <b class="ov-paused">Paused</b> : null}{d.meta}</span>
          </div>
          {side(d.b, true)}
        </div>
        {d.strip && <Progress progress={d.progress} bosses={d.bosses} team={d.survTeam} rival={d.rival} dots={d.dots} />}
        {d.tank && <div class="ov-plate__tank"><TankCard tank={d.tank} team={d.infTeam} /></div>}
      </div>
      {!props.noStacks && <div class="ov-stack ov-stack--l" style={teamVar(d.a, '')}><TeamMedallions team={d.a} live={props.live} el={d.el} layout="row" tankMax={tankMax} /></div>}
      {!props.noStacks && <div class="ov-stack ov-stack--r" style={teamVar(d.b, '')}><TeamMedallions team={d.b} live={props.live} el={d.el} layout="row" tankMax={tankMax} /></div>}
    </>
  );
}

/**
 * CORNERS. A plate in each top corner, like a team's sign hung on the wall:
 * name, side and score, with its players hanging under it as a row of
 * medallion chips when rows are on. The map and progress sit in a small tag
 * at top centre.
 */
function CornersHud(props: HudProps) {
  const d = hudData(props);
  const tankMax = props.live?.tank?.maxHealth ?? 0;
  const corner = (t: CastTeam, right: boolean) => (
    <div class={`ov-corner${right ? ' ov-corner--r' : ''}`} style={teamVar(t, '')}>
      <div class="ov-corner__plate">
        {t.logoUrl && <Logo team={t} size={60} />}
        <span class="ov-corner__ident">
          <span class="ov-corner__name">{t.name}</span>
          <SideWord team={t} />
        </span>
        <span class="ov-corner__pts">{t.score}</span>
      </div>
      <div class="ov-corner__chips"><TeamMedallions team={t} live={props.live} el={d.el} layout="chip" tankMax={tankMax} /></div>
    </div>
  );
  return (
    <>
      {corner(d.a, false)}
      <div class="ov-ctag">
        <span class="ov-ctag__map">{d.mapLabel}</span>
        <span class="ov-ctag__meta">{d.paused ? <b class="ov-paused">Paused</b> : null}{d.meta}</span>
        {d.strip && <Progress progress={d.progress} bosses={d.bosses} team={d.survTeam} rival={d.rival} dots={d.dots} />}
        {d.tank && <TankCard tank={d.tank} team={d.infTeam} />}
      </div>
      {corner(d.b, true)}
    </>
  );
}

/**
 * RAIL. One board down the left edge, like the tally chalked by a safe room
 * door: the map and the progress strip at the top, both teams with their
 * scores, each team's players under its name when rows are on, the tank
 * under that. The rest of the screen stays clean.
 */
function RailHud(props: HudProps) {
  const d = hudData(props);
  const tankMax = props.live?.tank?.maxHealth ?? 0;
  const team = (t: CastTeam) => (
    <div class="ov-rail__team" style={teamVar(t, '')}>
      <div class="ov-rail__head">
        {t.logoUrl && <Logo team={t} size={40} />}
        <span class="ov-rail__ident">
          <span class="ov-rail__name">{t.name}</span>
          <SideWord team={t} />
        </span>
        <span class="ov-rail__pts">{t.score}</span>
      </div>
      <div class="ov-rail__rows"><TeamMedallions team={t} live={props.live} el={d.el} layout="row" tankMax={tankMax} /></div>
    </div>
  );
  return (
    <div class="ov-rail">
      <div class="ov-rail__board">
        <div class="ov-rail__top">
          <span class="ov-rail__event">{props.studio.title || 'Riverside PUGs'}</span>
          <span class="ov-rail__map">{d.mapLabel}</span>
          <span class="ov-rail__meta">{d.paused ? <b class="ov-paused">Paused</b> : null}{d.meta}</span>
        </div>
        {d.strip && <Progress progress={d.progress} bosses={d.bosses} team={d.survTeam} rival={d.rival} dots={d.dots} />}
        {team(d.a)}
        {team(d.b)}
        {d.tank && <TankCard tank={d.tank} team={d.infTeam} />}
      </div>
    </div>
  );
}

/**
 * FRAME. The game draws its own survivor cards in the spectator's bottom band
 * (ruling 30); the overlay frames that hole, tabs it with the team on
 * survivors this half, and fills the band's free right part with the
 * infected, which a spectator never sees: one card per player in the game
 * cards' own shape, so the band reads as one strip half drawn by the game and
 * half by us. An infected hole (for a caster HUD that shows one) is optional.
 */
function FrameHud(props: HudProps) {
  const d = hudData(props);
  const f = props.studio.frame;
  const hole = (r: NonNullable<typeof f.infected>, team: CastTeam | null, side: 'survivor' | 'infected') => {
    const right = r.x + r.w / 2 > 960;
    const low = r.y + r.h / 2 > 540;
    return (
      <div class={`ov-frame ov-frame--${right ? 'r' : 'l'}${low ? ' ov-frame--low' : ''}`} data-side={side}
        style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, ...teamVar(team, side === 'survivor' ? 'var(--win)' : 'var(--loss)') }}>
        <span class="ov-frame__hole" />
        <span class="ov-frame__tab">
          <span class={`ov-sideword ov-sideword--${side}`}>{side === 'survivor' ? 'Survivors' : 'Infected'}</span>
          {team && <span class="ov-frame__name">{team.name}</span>}
          {team && <span class="ov-frame__pts">{team.score}</span>}
        </span>
      </div>
    );
  };
  const sv = f.survivor;
  const bandLeft = sv.x + sv.w + 30;
  const infected = d.el.infected && props.live && d.infTeam && 1880 - bandLeft >= 300 ? props.live.infected.slice(0, 4) : [];
  const tankMax = props.live?.tank?.maxHealth ?? 0;
  return (
    <>
      {hole(sv, d.survTeam, 'survivor')}
      {f.infected && hole(f.infected, d.infTeam, 'infected')}
      {infected.length > 0 && (
        <div class="ov-band" style={{ left: `${bandLeft}px`, top: `${sv.y}px`, width: `${1880 - bandLeft}px`, height: `${sv.h}px`, ...teamVar(d.infTeam, 'var(--loss)') }}>
          <span class="ov-band__tab">
            <span class="ov-sideword ov-sideword--infected">Infected</span>
            <span class="ov-frame__name">{d.infTeam!.name}</span>
            <span class="ov-frame__pts">{d.infTeam!.score}</span>
          </span>
          {infected.map((i) => <BandCard key={i.slot} i={i} tankMax={tankMax} />)}
        </div>
      )}
      <PlateHud {...props} noStacks />
    </>
  );
}

/** An infected player in the shape of the game's own survivor card: icon
 *  and state over a slim bar, the name under it with damage this round. */
function BandCard({ i, tankMax }: { i: CastInfected; tankMax: number }) {
  const cls = i.cls ? i.cls[0]!.toUpperCase() + i.cls.slice(1) : '';
  const max = i.cls === 'tank' ? tankMax || i.health : SI_MAX[i.cls] ?? 0;
  const frac = i.alive && !i.ghost && max > 0 ? Math.max(0, Math.min(1, i.health / max)) : 0;
  const status = !i.alive ? 'Dead' : i.ghost ? 'Spawning' : cls;
  const tone = !i.alive ? 'dead' : i.ghost ? 'ghost' : i.cls === 'tank' ? 'tank' : 'up';
  return (
    <div class={`ov-bc is-${tone}`}>
      <span class="ov-bc__top">
        <span class="ov-bc__icon">{i.alive ? <ClassIcon cls={i.cls} /> : null}</span>
        <b class="ov-bc__state">{status}</b>
      </span>
      <span class="ov-bc__bar"><span style={{ width: `${frac * 100}%` }} /></span>
      <span class="ov-bc__bottom">
        <span class="ov-bc__name">{i.name}</span>
        {i.dmg !== null && <span class="ov-bc__dmg" title="Damage this round">{i.dmg}</span>}
      </span>
    </div>
  );
}

const fmtAlive = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * After a tank dies: each survivor's damage to it and their share, like the
 * tank damage plugins print in chat, plus the tank's own line (who played
 * it, how long it lived, what it dealt). The numbers are pug-match's own
 * hook totals between the tank's spawn and its death, so they are exact.
 */
function TankRecapCard({ r }: { r: TankRecap }) {
  return (
    <div class="ov-recap" key={`${r.aliveS}:${r.dealt}`}>
      <div class="ov-recap__head">
        <ClassIcon cls="tank" class="ov-recap__icon" />
        <span class="ov-recap__title">{r.tanks > 1 ? 'Tanks down' : 'Tank down'}</span>
        <span class="ov-recap__who">{r.tanks > 1 ? `${r.tanks} tanks, combined` : r.controller ?? 'AI tank'}</span>
      </div>
      <div class="ov-recap__facts">
        <span><em>Alive</em> {fmtAlive(r.aliveS)}</span>
        <span><em>Dealt</em> {r.dealt}</span>
        {r.passes > 0 && <span><em>Passed</em> {r.passes === 1 ? 'once' : `${r.passes} times`}</span>}
      </div>
      <ol class="ov-recap__rows">
        {r.players.map((p) => (
          <li key={p.name}>
            <span class="ov-recap__name">{p.name}</span>
            <span class="ov-recap__bar"><span style={{ width: `${p.share}%` }} /></span>
            <span class="ov-recap__dmg">{p.dmg.toLocaleString('en-US')}</span>
            <span class="ov-recap__pct">{p.share}%</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
