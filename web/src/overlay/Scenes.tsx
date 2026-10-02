import { campaignTint, mapName } from '../format';
import { PICTOGRAMS, type PictogramName } from '../replay/pictograms';
import { camSlots } from '../../../src/cast/layout';
import {
  CALLOUT_MS, type CastChapter, type CastInfected, type CastLiveRound, type CastMatchView, type CastPlayer,
  type CastSurvivor, type CastTeam, type OverlayFeed, type OverlayKey, type StudioState,
} from '../../../src/cast/types';

/**
 * Every caster studio scene and layer (plan: Scenes). One component tree for
 * both ways of running OBS: a fixed scene per browser source, or `program`,
 * which follows the producer.
 *
 * The look is the site's poster style with L4D touches (plan ruling 16):
 * stencil lettering, the safe room arrow, hazard tape for infected moments,
 * campaign tints. Gameplay layers keep to the screen regions the game HUD
 * leaves free (plan ruling 15).
 */

interface Props { which: OverlayKey; feed: OverlayFeed; now: number }

export function Overlay({ which, feed, now }: Props) {
  const { studio, match } = feed;
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
        <SceneBody scene={scene} feed={feed} now={now} />
      </div>
      {which === 'program' && studio.lowerThird.show && <LowerThird studio={studio} />}
    </div>
  );
}

function SceneBody({ scene, feed, now }: { scene: OverlayKey; feed: OverlayFeed; now: number }) {
  const { studio, match, live } = feed;
  switch (scene) {
    case 'starting': return <Starting studio={studio} match={match} now={now} />;
    case 'casters': return <Casters studio={studio} match={match} />;
    case 'gameplay': return <Gameplay studio={studio} match={match} live={live} now={now} />;
    case 'scorebug': return match ? <Scorebug studio={studio} match={match} /> : null;
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

function Logo({ team, size }: { team: CastTeam; size: number }) {
  const k = new URLSearchParams(location.search).get('k') ?? '';
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

function PlayerCard({ p, team, delay }: { p: CastPlayer; team: CastTeam; delay: number }) {
  const winPct = p.career.wins + p.career.losses > 0 ? Math.round((p.career.wins / (p.career.wins + p.career.losses)) * 100) : null;
  return (
    <div class="ov-card" style={{ animationDelay: `${delay}ms`, '--c': `var(--team-${team.key})` } as Record<string, string>}>
      {p.avatar ? <img class="ov-card__avatar" src={p.avatar} alt="" /> : <span class="ov-card__avatar ov-card__avatar--none">{[...p.name][0]?.toUpperCase() ?? '?'}</span>}
      <div class="ov-card__body">
        <span class="ov-card__name">{p.name}</span>
        <span class="ov-card__line">
          {p.sr !== null && <b>{p.sr} SR</b>}
          {p.career.matches} PUGs{winPct !== null ? ` · ${winPct}% won` : ''}
        </span>
      </div>
      <dl class="ov-card__stats">
        <div><dt>Skeets</dt><dd>{p.career.skeets}</dd></div>
        <div><dt>DPs</dt><dd>{p.career.dpsLanded}</dd></div>
        <div><dt>Tank dmg</dt><dd>{p.career.tankDamage >= 10000 ? `${Math.round(p.career.tankDamage / 1000)}k` : p.career.tankDamage}</dd></div>
      </dl>
    </div>
  );
}

function Lineups({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Lineups" /></div>;
  return (
    <div class="ov-full">
      <Backdrop art="infected-hunter" />
      <Title studio={studio} fallback="Lineups" />
      <div class="ov-lineups">
        {[match.teams.a, match.teams.b].map((t) => (
          <section key={t.key} class={`ov-lineups__team ov-lineups__team--${t.key}`} style={{ '--c': `var(--team-${t.key})` } as Record<string, string>}>
            <header class="ov-lineups__head"><Logo team={t} size={64} /><h2>{t.name}</h2></header>
            {t.players.map((p, i) => <PlayerCard key={p.steamid} p={p} team={t} delay={200 + i * 90 + (t.key === 'b' ? 45 : 0)} />)}
          </section>
        ))}
      </div>
      <p class="ov-foot-note">Career PUG numbers from riversidepug.com</p>
    </div>
  );
}

const STAT_COLS: { key: string; label: string }[] = [
  { key: 'sidmg', label: 'SI dmg' },
  { key: 'sikill', label: 'SI kills' },
  { key: 'ck', label: 'Commons' },
  { key: 'skeets', label: 'Skeets' },
  { key: 'deadstops', label: 'Deadstops' },
  { key: 'damage_as_si', label: 'Dmg as SI' },
  { key: 'dps_landed', label: 'DPs' },
  { key: 'tank_damage', label: 'Tank dmg' },
];

function Stats({ studio, match }: { studio: StudioState; match: CastMatchView | null }) {
  if (!match) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Match stats" /></div>;
  const best = new Map<string, number>();
  for (const c of STAT_COLS) {
    best.set(c.key, Math.max(0, ...[...match.teams.a.players, ...match.teams.b.players].map((p) => p.stats[c.key] ?? 0)));
  }
  return (
    <div class="ov-full">
      <Backdrop art="infected-ghost" />
      <Title studio={studio} fallback={match.state === 'completed' ? 'Final stats' : 'Match stats'} />
      <table class="ov-table ov-stats">
        <thead>
          <tr><th />{STAT_COLS.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        {[match.teams.a, match.teams.b].map((t) => (
          <tbody key={t.key} style={{ '--c': `var(--team-${t.key})` } as Record<string, string>}>
            <tr class="ov-stats__team"><th colSpan={STAT_COLS.length + 1}>{t.name} <span class="ov-stats__score">{t.score}</span></th></tr>
            {t.players.map((p) => (
              <tr key={p.steamid}>
                <th class="ov-stats__name">{p.name}</th>
                {STAT_COLS.map((c) => {
                  const v = p.stats[c.key];
                  const top = v !== undefined && v > 0 && v === best.get(c.key);
                  return <td key={c.key} class={top ? 'is-top' : ''}>{v ?? <span class="ov-dim">-</span>}</td>;
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

function Gameplay({ studio, match, live, now }: { studio: StudioState; match: CastMatchView | null; live: CastLiveRound | null; now: number }) {
  if (!match) return null;
  return (
    <div class={`ov-game ov-game--${studio.scorebugAt}`}>
      <div class="ov-game__col">
        <Scorebug studio={studio} match={match} />
        <RoundHud studio={studio} match={match} live={live} />
      </div>
      <Callout studio={studio} match={match} now={now} />
    </div>
  );
}

function Scorebug({ studio, match }: { studio: StudioState; match: CastMatchView }) {
  const { a, b } = match.teams;
  const chapter = match.chapters[match.mapNumber - 1];
  const bosses = studio.elements.bosses && (studio.bosses.tank !== null || studio.bosses.witch !== null);
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
          {studio.bosses.tank !== null && <span><b>Tank</b> {studio.bosses.tank}%</span>}
          {studio.bosses.witch !== null && <span><b>Witch</b> {studio.bosses.witch}%</span>}
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
          {live.survivors.map((s) => <SurvivorCard key={s.slot} s={s} />)}
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
      <span class="ov-tank__label"><Picto name="tank" /> Tank</span>
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
      <img class="ov-surv__face" src={`/portraits/${s.alive ? (s.character || 'unknown') : 'dead'}.png`} alt="" />
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

function Picto({ name }: { name: string }) {
  const d = (PICTOGRAMS as Record<string, string>)[name as PictogramName];
  if (!d) return <span class="ov-picto ov-picto--none" />;
  return <svg class="ov-picto" viewBox="0 0 20 20" aria-hidden="true"><path d={d} /></svg>;
}

function InfectedCard({ i }: { i: CastInfected }) {
  const cls = i.cls ? `${i.cls[0]!.toUpperCase()}${i.cls.slice(1)}` : '';
  const label = !i.alive ? (cls ? `${cls} · Dead` : 'Dead') : i.ghost ? `${cls || 'Spawning'} · Ghost` : `${cls} · ${i.health} HP`;
  return (
    <div class={`ov-inf${!i.alive ? ' ov-inf--dead' : i.ghost ? ' ov-inf--ghost' : ''}`}>
      <Picto name={i.cls} />
      <div class="ov-inf__body">
        <span class="ov-inf__name">{i.name}</span>
        <span class="ov-inf__line">{label}</span>
      </div>
    </div>
  );
}

function Callout({ studio, match, now }: { studio: StudioState; match: CastMatchView; now: number }) {
  const c = studio.callout;
  if (!c) return null;
  const age = now - Date.parse(c.at);
  if (age < 0 || age > CALLOUT_MS) return null;
  const team = c.team ? match.teams[c.team] : null;
  return (
    <div class="ov-callout" key={c.at} style={{ '--c': team ? `var(--team-${team.key})` : 'var(--accent)' } as Record<string, string>}>
      <span class="ov-callout__tape" />
      <span class="ov-callout__title">{c.title}</span>
      {c.text && <span class="ov-callout__text">{c.text}</span>}
      {team && <span class="ov-callout__team">{team.name}</span>}
    </div>
  );
}
