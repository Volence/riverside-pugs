/**
 * Replay drills: turn one moment of a recorded round into a drill spec.
 *
 * A drill is "put everyone back where they stood": the site picks a frame out
 * of a replay, and the practice plugin (l4d_practice.smx) fetches the result
 * as JSON by a short code and rebuilds the situation on whatever practice
 * server the player typed `!drill <code>` in. The JSON shape is the contract
 * between the two, and it is written down in l4d/practice/DESIGN.md. Change a
 * field here and the plugin has to change with it, so every field is spelled
 * out in `DrillSpec` below rather than left to whatever an object literal
 * happens to hold.
 *
 * Deliberately pure, like replayFormat.ts: a parsed replay in, an object out,
 * no database and no filesystem. That is what lets the fiddly parts (which
 * frame, which side, the temp health estimate, the survivor characters a bot
 * gets) be tested in milliseconds against hand-built replays, and it is why
 * the roster names and the map label arrive as arguments rather than being
 * looked up here.
 *
 * What the replay can and cannot tell us is set out in section 3 of
 * docs/superpowers/plans/2026-09-26-practice-mode.md. The short version: the
 * eight rostered players carry position, angles, health, temp, class, active
 * weapon and ammo; everything else (survivor bots, AI specials, the AI tank,
 * the witch) is a 12 byte entity record with a position and health and
 * nothing more. Velocity and the rest of a survivor's inventory are not
 * recorded at all and are estimated from neighbouring frames below.
 */
import {
  ENTITY_KIND, STATE, SURVIVOR_CHARACTERS, ZOMBIE_CLASSES, slotInfected,
  type EntitySample, type Frame, type PlayerSample, type Replay,
} from './replayFormat.js';

/** The spec version the plugin checks. Bump only with the plugin. */
export const DRILL_SPEC_VERSION = 1;

export type DrillSide = 'survivor' | 'infected';

export interface DrillActor {
  side: DrillSide;
  /** Survivor: bill, zoey, francis or louis. Infected: smoker, boomer,
   *  hunter or tank. Never empty in a finished spec: a survivor whose
   *  character the file does not know is given a free one. */
  cls: string;
  /** The recorded player's persona name, display only. '' for a bot. */
  name: string;
  /** World units, feet (GetClientAbsOrigin), as recorded. */
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  /** Units per second, from the neighbouring frames. 0 when unknown. */
  vx: number; vy: number; vz: number;
  health: number;
  /** Estimated real temp health, not the raw recorded value. See `estimateTemp`. */
  temp: number;
  /** Always true: dead players are left out of a spec entirely. Kept in the
   *  shape because the plugin reads it and a later version may want it. */
  alive: boolean;
  ghost: boolean;
  incap: boolean;
  /** weapon_<name> classname suffix of the active weapon, '' when unknown. */
  weapon: string;
  clip: number; reserve: number;
  /** A lookback guess at what else the survivor carried: the most recent
   *  weapon seen active in each other inventory slot this life. */
  items: string[];
}

export type DrillEntityKind = 'witch' | 'tank' | 'hunter' | 'smoker' | 'boomer';

export interface DrillEntity {
  kind: DrillEntityKind;
  x: number; y: number; z: number;
  health: number;
}

export interface DrillSource {
  /** Null only for a drill built by hand from a loose file (scripts/make-drill.ts). */
  matchId: number | null;
  ordinal: number;
  half: number;
  /** The frame the spec was built from, which is at or before the moment asked for. */
  tMs: number;
}

export interface DrillSpec {
  code: string;
  version: number;
  map: string;
  title: string;
  source: DrillSource;
  actors: DrillActor[];
  entities: DrillEntity[];
}

/** Everything but the code, which only exists once the drill is stored. */
export type DrillBody = Omit<DrillSpec, 'code'>;

/** Weapon id (replayFormat WEAPON_NAMES, the plugin's RplWeaponId) to the
 *  weapon_<name> classname suffix the plugin gives with GivePlayerItem. A
 *  separate table from WEAPON_NAMES because that one is for people to read
 *  ("Auto Shotgun") and this one is for the engine ("autoshotgun"). */
export const WEAPON_CLASSNAMES: Record<number, string> = {
  1: 'pistol',
  2: 'smg',
  3: 'pumpshotgun',
  4: 'autoshotgun',
  5: 'rifle',
  6: 'hunting_rifle',
  7: 'pipe_bomb',
  8: 'molotov',
  9: 'first_aid_kit',
  10: 'pain_pills',
};

/** Which inventory slot each weapon id lives in. A survivor holds at most one
 *  thing per slot, so the item lookback keeps the most recent per slot: a
 *  player who swapped an SMG for a rifle carries the rifle, not both. */
const WEAPON_SLOT: Record<number, number> = {
  2: 0, 3: 0, 4: 0, 5: 0, 6: 0,
  1: 1,
  7: 2, 8: 2,
  9: 3,
  10: 4,
};

/** The infected classes a drill can recreate for a player. A witch is never a
 *  player; anything else in `cls` is a class this spec has no word for. */
const PLAYABLE_INFECTED = new Set(['smoker', 'boomer', 'hunter', 'tank']);

const AI_KINDS: Record<number, DrillEntityKind> = {
  [ENTITY_KIND.WITCH]: 'witch',
  [ENTITY_KIND.TANK_AI]: 'tank',
  [ENTITY_KIND.HUNTER_AI]: 'hunter',
  [ENTITY_KIND.SMOKER_AI]: 'smoker',
  [ENTITY_KIND.BOOMER_AI]: 'boomer',
};

/** Kinds sampled at the entity rate rather than every frame. The plugin
 *  writes bots (survivor bots, AI specials, the AI tank) on every frame, but
 *  world entities (the witch, commons, rocks) only on one frame in
 *  playerHz / entityHz. */
const WORLD_KINDS = new Set<number>([ENTITY_KIND.WITCH, ENTITY_KIND.COMMON, ENTITY_KIND.TANK_ROCK]);

/** pain_pills_decay_rate on every server, temp health lost per second. */
export const TEMP_DECAY_PER_SEC = 0.25;

/** A derived speed above this is a teleport, a respawn or a recording gap,
 *  never real movement: a pouncing hunter peaks well under 1000 u/s. */
export const MAX_PLAUSIBLE_SPEED = 2000;

/** Neighbours further apart than this are not neighbours: a pause or a
 *  dropped stretch of frames sits between them. */
const MAX_VELOCITY_GAP_MS = 500;

const MAX_SURVIVORS = 4;

function alive(state: number): boolean {
  return (state & STATE.PRESENT) !== 0 && (state & STATE.ALIVE) !== 0;
}

/** Index of the last frame at or before `tMs`, or of the first frame when
 *  `tMs` is before the round started. -1 only for a replay with no frames. */
export function frameIndexAt(frames: Frame[], tMs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0, hi = frames.length - 1;
  if (frames[0].tMs > tMs) return 0;
  // Binary search: a round is thousands of frames and they are in time order.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].tMs <= tMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The recorder writes 1 for a survivor with no temp health at all (see
 *  memory l4d1-replay-temp-health), so 1 and 0 are the same thing. */
function realTemp(raw: number): number {
  return raw <= 1 ? 0 : raw;
}

/**
 * Real temp health at frame `i`, estimated from the raw recorded value.
 *
 * The recorder stores m_healthBuffer, which the engine never decays in place:
 * the true value is m_healthBuffer - (now - m_healthBufferTime) * decay rate,
 * and m_healthBufferTime is not recorded. So a survivor who took pills 150 s
 * before the drill moment reads about 50 in the file when about 12 is real.
 *
 * The estimate walks back through this life to the frame where the raw value
 * last changed, which is when the engine last wrote the buffer and therefore
 * the timestamp we are missing, and decays from there. A change rather than
 * only an increase: taking damage also rewrites the buffer (as the decayed
 * value less the damage) and restarts its clock, so the value after a hit is
 * already correct at that moment. With no change in the whole life the
 * earliest frame of it is used, which errs towards more decay.
 */
export function estimateTemp(frames: Frame[], i: number, slot: number): number {
  const now = frames[i].players[slot];
  const raw = realTemp(now.temp);
  if (raw === 0) return 0;
  let since = frames[i].tMs;
  for (let j = i - 1; j >= 0; j--) {
    const p = frames[j].players[slot];
    if (!p || !alive(p.state)) break;
    if (realTemp(p.temp) !== raw) break;
    since = frames[j].tMs;
  }
  const decayed = raw - ((frames[i].tMs - since) / 1000) * TEMP_DECAY_PER_SEC;
  return Math.max(0, Math.floor(decayed));
}

type Vec = { vx: number; vy: number; vz: number };
const STILL: Vec = { vx: 0, vy: 0, vz: 0 };

/** Velocity from two positions `dtMs` apart, or STILL when the pair cannot be
 *  movement (no time between them, too long a gap, or a teleport's speed). */
function velocityBetween(
  a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, dtMs: number,
): Vec {
  if (dtMs <= 0 || dtMs > MAX_VELOCITY_GAP_MS * 2) return STILL;
  const s = 1000 / dtMs;
  const v = { vx: (b.x - a.x) * s, vy: (b.y - a.y) * s, vz: (b.z - a.z) * s };
  if (Math.hypot(v.vx, v.vy, v.vz) > MAX_PLAUSIBLE_SPEED) return STILL;
  return { vx: Math.round(v.vx), vy: Math.round(v.vy), vz: Math.round(v.vz) };
}

/**
 * Velocity of one thing at frame `i`, from its neighbours on either side.
 *
 * `at(frame)` returns the thing's position in a frame, or null when it is not
 * there (dead, gone, a different life). A central difference over i-1 and
 * i+1 when both exist, which is centred on the moment itself; one-sided when
 * only one does, e.g. the last frame of a round.
 */
function velocityAt(
  frames: Frame[], i: number,
  at: (f: Frame) => { x: number; y: number; z: number } | null,
): Vec {
  const here = at(frames[i]);
  if (!here) return STILL;
  const near = (j: number) => (
    j >= 0 && j < frames.length && Math.abs(frames[j].tMs - frames[i].tMs) <= MAX_VELOCITY_GAP_MS ? at(frames[j]) : null
  );
  const prev = near(i - 1);
  const next = near(i + 1);
  if (prev && next) return velocityBetween(prev, next, frames[i + 1].tMs - frames[i - 1].tMs);
  if (next) return velocityBetween(here, next, frames[i + 1].tMs - frames[i].tMs);
  if (prev) return velocityBetween(prev, here, frames[i].tMs - frames[i - 1].tMs);
  return STILL;
}

/**
 * What else this survivor probably carries: the most recent weapon seen
 * active in each inventory slot since their last death or spawn, excluding
 * the slot of the weapon in hand. Only what they switched to during this
 * life is visible, so a molotov nobody drew is invisible; it is a guess and
 * the spec says so.
 *
 * Ordered by inventory slot (primary, pistol, throwable, kit, pills), which is
 * the order the plugin gives them in.
 */
export function lookbackItems(frames: Frame[], i: number, slot: number): string[] {
  const current = frames[i].players[slot].weapon;
  const heldSlot = WEAPON_SLOT[current];
  const bySlot = new Map<number, number>();
  for (let j = i; j >= 0; j--) {
    const p = frames[j].players[slot];
    if (!p || !alive(p.state)) break;
    const s = WEAPON_SLOT[p.weapon];
    if (s === undefined || s === heldSlot || bySlot.has(s)) continue;
    bySlot.set(s, p.weapon);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => WEAPON_CLASSNAMES[id]);
}

function survivorCharacter(version: number, cls: number): string {
  // Version 1 files wrote 0 for every survivor, which would read as "bill"
  // for all four. Unknown is honest; assignment fills it later.
  if (version < 2) return '';
  return SURVIVOR_CHARACTERS[cls] ?? '';
}

/**
 * Give every survivor a character, and no character to two survivors.
 *
 * A survivor's own recorded character is kept when it is known and not yet
 * taken; everyone else (version 1 files, survivor bots, a duplicate) gets the
 * first free one in the engine's order. Survivors come in actor order, which
 * puts rostered humans ahead of bots, so a human keeps their character over a
 * bot that somehow claims the same one.
 */
export function assignCharacters(survivors: DrillActor[]): void {
  const taken = new Set<string>();
  const needs: DrillActor[] = [];
  for (const a of survivors) {
    if (a.cls && !taken.has(a.cls)) taken.add(a.cls);
    else needs.push(a);
  }
  const free = SURVIVOR_CHARACTERS.filter((c) => !taken.has(c));
  for (const a of needs) a.cls = free.shift() ?? '';
}

function playerActor(
  replay: Replay, i: number, p: PlayerSample, names: Record<string, string>,
): DrillActor | null {
  const { header, frames } = replay;
  const steamid = header.slots[p.slot];
  if (!steamid || !alive(p.state)) return null;
  const infected = p.infected ?? slotInfected(header, p.slot);
  let cls: string;
  if (infected) {
    cls = ZOMBIE_CLASSES[p.cls] ?? '';
    if (!PLAYABLE_INFECTED.has(cls)) return null;
  } else {
    cls = survivorCharacter(header.version, p.cls);
  }
  const v = velocityAt(frames, i, (f) => {
    const q = f.players[p.slot];
    return q && alive(q.state) ? q : null;
  });
  return {
    side: infected ? 'infected' : 'survivor',
    cls,
    name: names[steamid] ?? '',
    x: p.x, y: p.y, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    ...v,
    health: p.health,
    temp: infected ? 0 : estimateTemp(frames, i, p.slot),
    alive: true,
    ghost: (p.state & STATE.GHOST) !== 0,
    incap: (p.state & STATE.INCAP) !== 0,
    weapon: WEAPON_CLASSNAMES[p.weapon] ?? '',
    clip: p.clip, reserve: p.reserve,
    items: infected ? [] : lookbackItems(frames, i, p.slot),
  };
}

/** A survivor bot as an actor. An entity record has no angles, temp health,
 *  weapon or character, so those are left for the plugin's defaults and the
 *  character is assigned with the humans'. */
function botActor(frames: Frame[], i: number, e: EntitySample): DrillActor {
  const v = velocityAt(frames, i, (f) => f.entities.find(
    (o) => o.ref === e.ref && o.kind === ENTITY_KIND.SURVIVOR_BOT && alive(o.state),
  ) ?? null);
  return {
    side: 'survivor', cls: '', name: '',
    x: e.x, y: e.y, z: e.z, yaw: 0, pitch: 0,
    ...v,
    health: e.health, temp: 0,
    alive: true, ghost: false, incap: (e.state & STATE.INCAP) !== 0,
    weapon: '', clip: 0, reserve: 0, items: [],
  };
}

/** The frame world entities are read from. With the entity rate below the
 *  player rate most frames carry bots only, so walk back to the last frame
 *  that sampled world entities; never further than one sampling interval. */
function worldFrame(replay: Replay, i: number): Frame {
  const { header, frames } = replay;
  const every = header.entityHz > 0 && header.entityHz < header.playerHz
    ? Math.round(header.playerHz / header.entityHz) : 1;
  for (let j = i; j >= 0 && j > i - every; j--) {
    if (frames[j].entities.some((e) => WORLD_KINDS.has(e.kind))) return frames[j];
  }
  return frames[i];
}

export interface BuildDrillOptions {
  /** SteamID64 to persona name for the rostered players. */
  names: Record<string, string>;
  matchId: number | null;
  /** How the map reads to a person, e.g. "No Mercy 3". The raw map name when omitted. */
  mapLabel?: string;
  /** The site's own map ordinal and half for this round. The header's copy
   *  is the plugin's file ordinal, which can run behind the site's after a
   *  lost MAP_RESULT (see servesCurrentRound in routes/replays.ts), so a
   *  caller that addressed the file by the site's numbers passes them here
   *  and the spec's `source` points back at the round the player opened. */
  ordinal?: number;
  half?: number;
}

/** Round clock as m:ss, the same reading the replay viewer's scrub bar shows
 *  (web/src/replay/ReplayControls.tsx formatTime), so a title matches what
 *  the player was looking at when they pressed the button. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function drillTitle(matchId: number | null, mapLabel: string, half: number, tMs: number): string {
  const where = `${mapLabel}, round ${half} at ${formatClock(tMs)}`;
  return matchId === null ? where : `Match ${matchId}, ${where}`;
}

/**
 * Build a drill from the moment `tMs` of a parsed replay. Null when the
 * replay has no frames at all, which is the only thing that makes a moment
 * impossible to describe; a moment with nobody alive is still a (useless)
 * valid spec and the caller may decide what to do with it.
 *
 * Actors: rostered players who are present and alive at the frame, then
 * survivor bots, with at most four survivors in total. Entities: AI specials,
 * the AI tank and the witch, alive at the frame. Commons are not included.
 */
export function buildDrill(replay: Replay, tMs: number, opts: BuildDrillOptions): DrillBody | null {
  const { header, frames } = replay;
  const i = frameIndexAt(frames, tMs);
  if (i < 0) return null;
  const frame = frames[i];

  const players = frame.players
    .map((p) => playerActor(replay, i, p, opts.names))
    .filter((a): a is DrillActor => a !== null);
  const bots = frame.entities
    .filter((e) => e.kind === ENTITY_KIND.SURVIVOR_BOT && alive(e.state))
    .map((e) => botActor(frames, i, e));
  const survivors = [...players.filter((a) => a.side === 'survivor'), ...bots].slice(0, MAX_SURVIVORS);
  assignCharacters(survivors);
  const infected = players.filter((a) => a.side === 'infected');

  const entities: DrillEntity[] = [];
  const bySource = [
    ...frame.entities.filter((e) => !WORLD_KINDS.has(e.kind)),
    ...worldFrame(replay, i).entities.filter((e) => WORLD_KINDS.has(e.kind)),
  ];
  for (const e of bySource) {
    const kind = AI_KINDS[e.kind];
    if (!kind || !alive(e.state)) continue;
    entities.push({ kind, x: e.x, y: e.y, z: e.z, health: e.health });
  }

  const ordinal = opts.ordinal ?? header.ordinal;
  const half = opts.half ?? header.half;
  return {
    version: DRILL_SPEC_VERSION,
    map: header.map,
    title: drillTitle(opts.matchId, opts.mapLabel || header.map, half, frame.tMs),
    source: { matchId: opts.matchId, ordinal, half, tMs: frame.tMs },
    actors: [...survivors, ...infected],
    entities,
  };
}
