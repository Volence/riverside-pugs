import { useEffect, useState } from 'preact/hooks';
import { ApiError, studioApi } from '../api';
import { mapName } from '../format';
import { CALLOUT_KINDS, sideOfEvent } from '../overlay/callouts';
import { sampleFeed } from '../overlay/sample';
import {
  boomerRate, defaultStudioState, ITEM, soloSkeets,
  type CastInfected, type CastLiveRound, type CastMatchView, type CastSurvivor, type CastTeam, type OverlayFeed,
} from '../../../src/cast/types';
import './castDesk.css';

/**
 * Caster desk (/cast/desk): a stats screen for a caster's second monitor.
 * The game shows them the play; this shows what the game cannot: every
 * player's HP as numbers on both sides, damage this half, items and flow,
 * the match box score, map scores and a play-by-play. It reads the same
 * caster-gated feed as the studio panel, so it follows whatever match the
 * studio has on air. ?sample shows the studio's sample match.
 */

const POLL_MS = 1500;

export default function CastDesk() {
  const sample = new URLSearchParams(location.search).has('sample');
  const [feed, setFeed] = useState<OverlayFeed | null>(sample ? sampleFeed(defaultStudioState(), Date.now()) : null);
  const [denied, setDenied] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (sample) return;
    let alive = true;
    const tick = async () => {
      try {
        const f = await studioApi.feed();
        if (!alive) return;
        setFeed(f); setStale(false); setDenied(false);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setDenied(true);
        else setStale(true);
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [sample]);

  if (denied) {
    return (
      <div class="desk desk--empty">
        <h1>Caster desk</h1>
        <p>This page is for casters. Sign in with a caster account, or ask an admin.</p>
      </div>
    );
  }
  const match = feed?.match ?? null;
  if (!feed || !match) {
    return (
      <div class="desk desk--empty">
        <h1>Caster desk</h1>
        <p>{feed ? 'Nothing on air. Pick a match in the caster studio and it shows up here.' : 'Loading...'}</p>
        <p><a href="/cast/studio">Open the caster studio</a></p>
      </div>
    );
  }
  return (
    <div class="desk">
      <Scoreline match={match} live={feed.live} stale={stale} />
      <div class="desk__grid">
        <section class="desk__panel desk__live">
          <LiveRound match={match} live={feed.live} />
        </section>
        <section class="desk__panel desk__feed">
          <h2>Play by play</h2>
          <Recaps feed={feed} />
          <PlayFeed match={match} />
        </section>
        <section class="desk__panel desk__box">
          <BoxScore match={match} />
        </section>
        <section class="desk__panel desk__maps">
          <Maps match={match} />
        </section>
      </div>
    </div>
  );
}

const teamStyle = (t: CastTeam | null) => ({ '--c': t ? `var(--team-${t.key}, ${t.color})` : 'var(--text-muted)' } as Record<string, string>);
const num = (v: number) => v.toLocaleString('en-US');

function Scoreline({ match, live, stale }: { match: CastMatchView; live: CastLiveRound | null; stale: boolean }) {
  const { a, b } = match.teams;
  const hud = live?.hud ?? null;
  const chance = match.winChanceA;
  const side = (t: CastTeam, right: boolean) => (
    <div class={`desk__team${right ? ' desk__team--r' : ''}`} style={teamStyle(t)}>
      <span class="desk__teamname">{t.name}</span>
      <span class={`desk__side desk__side--${t.side ?? 'none'}`}>{t.side === 'survivor' ? 'Survivors' : t.side === 'infected' ? 'Infected' : ''}</span>
      <span class="desk__score">{num(t.score)}</span>
    </div>
  );
  const boss = (v: number | null | undefined, label: string) =>
    v === null || v === undefined ? null : <span class="desk__chip">{label} {v === 0 ? 'none' : v === -2 ? 'party' : `${v}%`}</span>;
  return (
    <header class="desk__top">
      {side(a, false)}
      <div class="desk__mid">
        <span class="desk__map">{match.currentMap ? mapName(match.currentMap) : match.campaignName}</span>
        <span class="desk__meta">
          {match.mapCount ? `Map ${match.mapNumber} of ${match.mapCount}` : `Map ${match.mapNumber}`}
          {match.half ? ` · Round ${match.half}` : ''}
          {match.phase === 'paused' ? ' · PAUSED' : match.phase === 'readyup' ? ' · Ready-up' : ''}
          {live ? ` · ${clock(live.tMs)}` : ''}
        </span>
        <span class="desk__chips">
          {hud?.progress != null && <span class="desk__chip desk__chip--on">Progress {hud.progress}%</span>}
          {hud?.rivalReach != null && <span class="desk__chip">Rival reach {hud.rivalReach}%</span>}
          {boss(hud?.tank, 'Tank')}
          {boss(hud?.witch, 'Witch')}
          {chance != null && <span class="desk__chip" title="Team A's chance to win from the score and maps left">{a.tag} win {Math.round(chance * 100)}%</span>}
          {stale && <span class="desk__chip desk__chip--warn">Reconnecting</span>}
        </span>
      </div>
      {side(b, true)}
    </header>
  );
}

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const ITEM_NAMES: [number, string][] = [[ITEM.KIT, 'Kit'], [ITEM.PILLS, 'Pills'], [ITEM.PIPE, 'Pipe'], [ITEM.MOLOTOV, 'Molly']];
const SHORT_WEAPON: Record<string, string> = {
  'Pump Shotgun': 'Pump', 'Auto Shotgun': 'Auto', 'Assault Rifle': 'Rifle', 'Hunting Rifle': 'Hunting', 'SMG': 'Uzi', 'Pistol': 'Pistols',
  'Pipe Bomb': 'Pipe', 'Molotov': 'Molly', 'First Aid Kit': 'Kit', 'Pain Pills': 'Pills',
};
const SI_MAX: Record<string, number> = { smoker: 250, boomer: 50, hunter: 250 };

function LiveRound({ match, live }: { match: CastMatchView; live: CastLiveRound | null }) {
  const { a, b } = match.teams;
  const surv = a.side === 'survivor' ? a : b.side === 'survivor' ? b : null;
  const inf = surv ? (surv.key === 'a' ? b : a) : null;
  if (!live) {
    return (
      <>
        <h2>This round</h2>
        <p class="desk__note">No round running right now. Live HP, items and flow show here once a round is under way.</p>
      </>
    );
  }
  const teamHp = live.survivors.reduce((n, s) => n + (s.alive ? s.health + (s.incap || s.ledge ? 0 : s.temp) : 0), 0);
  return (
    <>
      <h2>This round <span class="desk__h2note">survivors {teamHp} HP total</span></h2>
      <table class="desk__table desk__surv" style={teamStyle(surv)}>
        <thead><tr><th>{surv?.name ?? 'Survivors'}</th><th>HP</th><th>Temp</th><th>State</th><th>Gun</th><th>Items</th><th>Flow</th><th title="SI damage this half">SI dmg</th></tr></thead>
        <tbody>{live.survivors.map((s, k) => <SurvivorLine key={`${s.slot}:${k}`} s={s} />)}</tbody>
      </table>
      <table class="desk__table desk__inf" style={teamStyle(inf)}>
        <thead><tr><th>{inf?.name ?? 'Infected'}</th><th>HP</th><th>Max</th><th>State</th><th colSpan={3} /><th title="Damage as SI this half, including to incapped survivors">Dmg</th></tr></thead>
        <tbody>
          {live.infected.length === 0 && <tr><td colSpan={8} class="desk__dim">No human infected</td></tr>}
          {live.infected.map((i) => <InfectedLine key={i.slot} i={i} tankMax={live.tank?.maxHealth ?? 0} />)}
        </tbody>
      </table>
      {live.tank && (
        <div class="desk__tank">
          <b>Tank</b>
          <span>{live.tank.controller ?? 'AI'}</span>
          <span class="desk__bar"><span style={{ width: `${live.tank.maxHealth ? Math.min(100, (live.tank.health / live.tank.maxHealth) * 100) : 0}%` }} /></span>
          <span class="desk__big">{num(live.tank.health)}</span>
          <span class="desk__dim">/ {num(live.tank.maxHealth)} ({live.tank.maxHealth ? Math.round((live.tank.health / live.tank.maxHealth) * 100) : 0}%)</span>
        </div>
      )}
      {live.witches > 0 && <p class="desk__note">{live.witches === 1 ? '1 witch' : `${live.witches} witches`} on the map</p>}
    </>
  );
}

function SurvivorLine({ s }: { s: CastSurvivor }) {
  const down = s.incap || s.ledge;
  const state = !s.alive ? 'Dead' : s.ledge ? 'Ledge' : s.incap ? 'Down' : s.pinned ? 'Pinned' : s.biled ? 'Biled' : '';
  const hp = s.alive ? s.health : 0;
  const total = s.alive && !down ? s.health + s.temp : hp;
  const tone = !s.alive ? 'dead' : down ? 'down' : total > 50 ? 'hi' : total > 15 ? 'mid' : 'lo';
  const items = s.items ? ITEM_NAMES.filter(([bit]) => s.items! & bit).map(([, n]) => n).join(' ') : '';
  return (
    <tr class={`is-${tone}`}>
      <th>{s.name}</th>
      <td class="desk__hp">{s.alive ? (down ? hp : total) : '-'}</td>
      <td>{s.alive && !down && s.temp > 0 ? `+${s.temp}` : ''}</td>
      <td class="desk__state">{state}</td>
      <td>{s.alive ? SHORT_WEAPON[s.weapon] ?? s.weapon : ''}</td>
      <td>{items}</td>
      <td>{s.flow !== null ? `${s.flow}%` : ''}</td>
      <td>{s.dmg !== null ? num(s.dmg) : ''}</td>
    </tr>
  );
}

function InfectedLine({ i, tankMax }: { i: CastInfected; tankMax: number }) {
  const cls = i.cls ? i.cls[0]!.toUpperCase() + i.cls.slice(1) : '';
  const up = i.alive && !i.ghost;
  const max = i.cls === 'tank' ? tankMax || i.health : SI_MAX[i.cls] ?? 0;
  const state = !i.alive ? 'Dead' : i.ghost ? `${cls || 'Ghost'} (spawning)` : cls;
  return (
    <tr class={`is-${!i.alive ? 'dead' : i.ghost ? 'ghost' : i.cls === 'tank' ? 'tank' : 'up'}`}>
      <th>{i.name}</th>
      <td class="desk__hp">{up ? num(i.health) : '-'}</td>
      <td class="desk__dim">{up && max ? num(max) : ''}</td>
      <td class="desk__state">{state}</td>
      <td colSpan={3} />
      <td>{i.dmg !== null ? num(i.dmg) : ''}</td>
    </tr>
  );
}

function Recaps({ feed }: { feed: OverlayFeed }) {
  const t = feed.tankRecap;
  const w = feed.witchRecap;
  return (
    <>
      {t && (
        <div class="desk__recap">
          <b>{t.end === 'dead' ? 'Tank down' : t.end === 'wipe' ? 'Tank wiped them' : 'Tank survived to the saferoom'}</b>
          <span class="desk__dim"> {t.controller ?? 'AI'} · {t.aliveS}s · dealt {num(t.dealt)}{t.passes ? ` · ${t.passes} pass${t.passes > 1 ? 'es' : ''}` : ''}</span>
          <ul>{t.players.map((p) => <li key={p.name}><span>{p.name}</span><span>{num(p.dmg)}</span><span class="desk__dim">{p.share}%</span></li>)}</ul>
        </div>
      )}
      {w && (
        <div class="desk__recap">
          <b>{w.crown ? 'Witch crowned' : 'Witch down'}</b>
          <span class="desk__dim"> {w.killer ? `by ${w.killer}` : ''}{w.startled ? ` · startled by ${w.startled}` : ''}{w.incaps ? ` · ${w.incaps} incap${w.incaps > 1 ? 's' : ''}` : ''}</span>
        </div>
      )}
    </>
  );
}

function PlayFeed({ match }: { match: CastMatchView }) {
  const events = match.events.slice(0, 40);
  if (events.length === 0) return <p class="desk__note">Skeets, DPs, biles, tanks, witches, incaps and deaths land here as they happen.</p>;
  return (
    <ol class="desk__events">
      {events.map((e) => {
        const card = CALLOUT_KINDS[e.kind]?.(e);
        const team = e.actorTeam ? match.teams[e.actorTeam] : null;
        return (
          <li key={e.seq} class={`desk__ev desk__ev--${sideOfEvent(e.kind)}`} style={teamStyle(team)}>
            <b>{card?.title ?? e.kind}</b>
            <span>{card?.text ?? `${e.actor}${e.target ? ` on ${e.target}` : ''}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

type Col = { key: string; label: string; title?: string; get: (s: Record<string, number>) => number | null; pct?: boolean; best?: boolean };
const v = (k: string) => (s: Record<string, number>) => s[k] ?? null;
const SURV_COLS: Col[] = [
  { key: 'sidmg', label: 'SI dmg', get: v('sidmg'), best: true },
  { key: 'sikill', label: 'Kills', title: 'SI kills', get: v('sikill'), best: true },
  { key: 'ck', label: 'CI', title: 'Common kills', get: v('ck'), best: true },
  { key: 'skeets', label: 'Skeets', title: 'Solo skeets', get: soloSkeets, best: true },
  { key: 'team_skeets', label: 'Team sk', title: 'Team skeets', get: v('team_skeets') },
  { key: 'deadstops', label: 'DS', title: 'Deadstops', get: v('deadstops'), best: true },
  { key: 'crowns', label: 'Crowns', get: (s) => (s.crowns === undefined && s.draw_crowns === undefined ? null : (s.crowns ?? 0) + (s.draw_crowns ?? 0)), best: true },
  { key: 'tongue_cuts', label: 'Cuts', title: 'Tongue cuts', get: v('tongue_cuts') },
  { key: 'clears', label: 'Clears', get: v('clears') },
  { key: 'tank_damage', label: 'Tank dmg', get: v('tank_damage'), best: true },
  { key: 'rev', label: 'Revives', get: v('rev') },
  { key: 'ff', label: 'FF', title: 'Friendly fire dealt', get: v('ff') },
];
const INF_COLS: Col[] = [
  { key: 'damage_as_si', label: 'Dmg as SI', get: v('damage_as_si'), best: true },
  { key: 'dps_landed', label: 'DPs', get: v('dps_landed'), best: true },
  { key: 'boomer_rate', label: 'Boom %', title: 'Booms landed per boomer spawned', get: boomerRate, pct: true, best: true },
  { key: 'survivors_biled', label: 'Biled', title: 'Survivors biled', get: v('survivors_biled') },
  { key: 'tank_rocks_landed', label: 'Rocks', title: 'Tank rocks landed', get: v('tank_rocks_landed') },
  { key: 'tank_punches', label: 'Punches', title: 'Tank punches', get: v('tank_punches') },
  { key: 'times_skeeted', label: 'Skeeted', title: 'Times skeeted', get: v('times_skeeted') },
];

function BoxScore({ match }: { match: CastMatchView }) {
  const all = [...match.teams.a.players, ...match.teams.b.players];
  const cols = [...SURV_COLS, ...INF_COLS];
  const best = new Map(cols.filter((c) => c.best).map((c) => [c.key, Math.max(0, ...all.map((p) => c.get(p.stats) ?? 0))]));
  return (
    <>
      <h2>Box score <span class="desk__h2note">{match.state === 'completed' ? 'final' : 'this match so far'} · gold = best</span></h2>
      <div class="desk__scroll">
        <table class="desk__table desk__boxtable">
          <thead>
            <tr class="desk__groups"><th /><th colSpan={SURV_COLS.length}>As survivors</th><th colSpan={INF_COLS.length} class="desk__split">As infected</th></tr>
            <tr><th />{cols.map((c, k) => <th key={c.key} title={c.title ?? c.label} class={k === SURV_COLS.length ? 'desk__split' : ''}>{c.label}</th>)}</tr>
          </thead>
          {[match.teams.a, match.teams.b].map((t) => (
            <tbody key={t.key} style={teamStyle(t)}>
              <tr class="desk__teamrow"><th colSpan={cols.length + 1}>{t.name} <span>{num(t.score)}</span></th></tr>
              {t.players.map((p) => (
                <tr key={p.steamid}>
                  <th>{p.name}</th>
                  {cols.map((c, k) => {
                    const val = c.get(p.stats);
                    const top = c.best && val !== null && val > 0 && val === best.get(c.key);
                    return <td key={c.key} class={[top ? 'is-top' : '', k === SURV_COLS.length ? 'desk__split' : ''].join(' ')}>{val === null ? <span class="desk__dim">-</span> : c.pct ? `${val}%` : num(val)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}

function Maps({ match }: { match: CastMatchView }) {
  const { a, b } = match.teams;
  const last = match.lastRound;
  return (
    <>
      <h2>Maps</h2>
      <table class="desk__table desk__maptable">
        <thead><tr><th>#</th><th>Map</th><th style={teamStyle(a)}>{a.tag}</th><th style={teamStyle(b)}>{b.tag}</th></tr></thead>
        <tbody>
          {match.chapters.map((c) => (
            <tr key={c.number} class={`is-${c.state}`}>
              <td>{c.number}</td>
              <th>{mapName(c.map)}{c.state === 'playing' ? ' (now)' : ''}</th>
              <td>{c.a ?? ''}</td>
              <td>{c.b ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {last && (
        <p class="desk__note">
          Last round, map {last.mapNumber} half {last.half}: {last.halves.map((h) => `${match.teams[h.survTeam].tag} ${h.score}${h.alive !== null ? ` (${h.alive} alive${h.seconds !== null ? `, ${clock(h.seconds * 1000)}` : ''})` : ''}`).join(' · ')}
        </p>
      )}
    </>
  );
}
