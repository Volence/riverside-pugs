/**
 * Caster studio shapes shared by the server and the browser. No imports, so
 * the web project can include this file as it is.
 */

export const SCENES = [
  'starting', 'casters', 'gameplay', 'mapintro', 'maps', 'lineups', 'stats', 'brb', 'winner', 'ending',
] as const;
export type SceneKey = (typeof SCENES)[number];

/** Layers: overlays that are never a scene of their own on the program feed,
 *  but can be added to any OBS scene. */
export const LAYERS = ['scorebug', 'roundhud', 'lowerthird'] as const;
export type LayerKey = (typeof LAYERS)[number];

export type OverlayKey = SceneKey | LayerKey | 'program';

export const SCENE_LABELS: Record<SceneKey | LayerKey, string> = {
  starting: 'Starting soon',
  casters: 'Casters',
  gameplay: 'Gameplay',
  mapintro: 'Map intro',
  maps: 'Chapter scores',
  lineups: 'Lineups',
  stats: 'Match stats',
  brb: 'Be right back',
  winner: 'Winner',
  ending: 'Ending',
  scorebug: 'Scorebug',
  roundhud: 'Round HUD',
  lowerthird: 'Lower third',
};

export const THEMES = ['riverside', 'safehouse', 'night', 'bile'] as const;
export type ThemeKey = (typeof THEMES)[number];

export interface CasterLine {
  name: string;
  /** A handle shown under the name, for example a Twitch or X handle. */
  handle: string;
  /** A browser-source URL for this caster's camera (VDO.Ninja and the like).
   *  Only the OBS scene collection uses it; overlays draw the frame. */
  camUrl: string;
}

export interface TeamOverride {
  name?: string;
  tag?: string;
  color?: string;
  /** Campaign score shown instead of the live one. */
  score?: number;
}

export interface StudioState {
  /** The match on air, or null. */
  matchId: number | null;
  /** A booking being followed: its newest game is shown as each one starts. */
  bookingId: number | null;
  scene: SceneKey;
  title: string;
  subtitle: string;
  lowerThird: { show: boolean; title: string; text: string };
  /** ISO time the countdown ends at, or null for none. */
  countdownTo: string | null;
  casters: CasterLine[];
  theme: ThemeKey;
  overrides: { a: TeamOverride; b: TeamOverride };
  /** Boss flow percentages for the map being played, typed by the producer:
   *  no plugin reports them yet. Null hides them. `map` is the map they were
   *  typed for: the overlay drops them once the match moves to another map,
   *  so last map's numbers never sit on the next one. */
  bosses: { tank: number | null; witch: number | null; map: string | null };
  /** Live elements on the gameplay scene, each on its own toggle (duplication
   *  audit in the plan): what the game's own HUD already draws while a
   *  caster spectates in first person defaults to off. */
  elements: LiveElements;
  /** Where the scorebug sits: top centre by default, bottom centre when a
   *  caster's own HUD puts something at the top. Scorebug style only. */
  scorebugAt: 'top' | 'bottom';
  /** The gameplay HUD: `bar`, the full-width broadcast bar across the top
   *  (both teams' players, scores, map progress), or `scorebug`, the compact
   *  top-centre bug with optional rows under it. */
  hudStyle: HudStyle;
  /** A highlight card fired by the producer, shown for CALLOUT_MS from `at`. */
  callout: Callout | null;
}

export const HUD_STYLES = ['bar', 'scorebug'] as const;
export type HudStyle = (typeof HUD_STYLES)[number];

export interface Callout {
  /** Short label, for example SKEET or TANK DOWN. */
  title: string;
  /** The line under it, for example a player's name and what they did. */
  text: string;
  /** Which team it is about, for the colour, or null. */
  team: 'a' | 'b' | null;
  at: string;
}

export const CALLOUT_MS = 8000;

export interface LiveElements {
  /** Survivor rows (health, status, items). Off by default: first-person
   *  spectating a survivor already shows every survivor's health, so the
   *  rows would show it twice. On for a clean-feed HUD, SourceTV or free cam. */
  survivors: boolean;
  /** Infected rows (class, spawning, dead, damage). Off by default for the
   *  same reason: spectating an infected shows the infected team's row. */
  infected: boolean;
  /** Tank health. On: L4D1 shows a tank's health only to the tank itself (and
   *  to whoever spectates the tank), never to survivors or other spectators. */
  tank: boolean;
  /** Tank and witch flow %. On: the game never shows them on screen. */
  bosses: boolean;
  /** The map progress strip under the bar (the furthest survivor's flow %,
   *  with the boss points on it). Needs pug-match 0.3.20's LIVEHUD line; the
   *  strip hides itself on a server that does not send it. */
  progress: boolean;
}

export function defaultElements(): LiveElements {
  return { survivors: false, infected: false, tank: true, bosses: true, progress: true };
}

export const MAX_CASTERS = 3;
export const TEXT_MAX = 80;

export function defaultStudioState(): StudioState {
  return {
    matchId: null,
    bookingId: null,
    scene: 'starting',
    title: 'Riverside PUGs',
    subtitle: '',
    lowerThird: { show: false, title: '', text: '' },
    countdownTo: null,
    casters: [],
    theme: 'riverside',
    overrides: { a: {}, b: {} },
    bosses: { tank: null, witch: null, map: null },
    elements: defaultElements(),
    scorebugAt: 'top',
    hudStyle: 'bar',
    callout: null,
  };
}

export type CastSide = 'survivor' | 'infected';

export interface CastPlayer {
  steamid: string;
  name: string;
  avatar: string | null;
  /** Live counters for this match (hp, ck, sidmg, sikill, ff, rev and the
   *  skill keys), empty until the first LIVESTAT. Final box score once the
   *  match has completed. */
  stats: Record<string, number>;
  /** Displayed SR, or null where SR is not shown (scrims, tournaments). */
  sr: number | null;
  /** Career PUG record, for the player card. */
  career: { matches: number; wins: number; losses: number; skeets: number; dpsLanded: number; tankDamage: number };
}

export interface CastTeam {
  key: 'a' | 'b';
  name: string;
  tag: string;
  color: string;
  logoUrl: string | null;
  score: number;
  /** Which fields came from a producer override. */
  overridden: (keyof TeamOverride)[];
  players: CastPlayer[];
  /** Side this half, or null between rounds before anyone knows. */
  side: CastSide | null;
}

export interface CastChapter {
  number: number;
  map: string;
  /** Each team's survivor score on this chapter, null when not played yet. */
  a: number | null;
  b: number | null;
  /** Which team was survivor in the first half, when known. */
  firstSurvivor: 'a' | 'b' | null;
  state: 'done' | 'playing' | 'next';
}

export interface CastMatchView {
  id: number;
  kind: 'pug' | 'scrim' | 'tournament';
  state: 'configuring' | 'live' | 'completed' | 'aborted';
  campaign: string;
  campaignName: string;
  currentMap: string | null;
  mapNumber: number;
  mapCount: number | null;
  half: number | null;
  phase: string | null;
  phaseSinceMs: number | null;
  winner: 'a' | 'b' | 'draw' | null;
  teams: { a: CastTeam; b: CastTeam };
  chapters: CastChapter[];
  /** Newest first. */
  events: { seq: number; kind: string; actor: string; actorTeam: 'a' | 'b' | null; target: string | null; value: number }[];
  /** For a followed booking: which game of how many. */
  game: { number: number; of: number } | null;
}

export interface CastSurvivor {
  slot: number;
  steamid: string;
  name: string;
  character: string;
  health: number;
  temp: number;
  alive: boolean;
  incap: boolean;
  ledge: boolean;
  pinned: boolean;
  biled: boolean;
  weapon: string;
  /** From LIVEHUD (see LiveHud), null when the server does not send it:
   *  this survivor's own map progress in %, held items (ITEM bits), and SI
   *  damage dealt this half. */
  flow: number | null;
  items: number | null;
  dmg: number | null;
}

/** LIVEHUD item bits, as plugin/pug-match.sp LiveHudItems sets them. */
export const ITEM = { KIT: 1, PILLS: 2, PIPE: 4, MOLOTOV: 8 } as const;

export interface CastInfected {
  slot: number;
  steamid: string;
  name: string;
  /** smoker, boomer, hunter, tank, or '' while dead with no class yet. */
  cls: string;
  ghost: boolean;
  alive: boolean;
  health: number;
  /** Damage dealt as SI this half, from LIVEHUD; null without it. */
  dmg: number | null;
}

/** The plugin's LIVEHUD line (pug-match 0.3.20), merged into the round. */
export interface LiveHud {
  /** The furthest survivor's flow %, or null when the server could not tell. */
  progress: number | null;
  /** This map's tank and witch flow % from l4d_boss_percent: null when that
   *  plugin is absent, 0 for no boss this map; witch -2 is a witch party. */
  tank: number | null;
  witch: number | null;
}

export interface CastLiveRound {
  ordinal: number;
  half: number;
  map: string;
  /** Milliseconds into the round the frame was taken at. */
  tMs: number;
  /** Age of the newest frame when the feed was built. */
  ageMs: number;
  survivors: CastSurvivor[];
  infected: CastInfected[];
  tank: { health: number; maxHealth: number; controller: string | null } | null;
  witches: number;
  /** Null on a server without pug-match 0.3.20, or when its last LIVEHUD is
   *  older than a few seconds. */
  hud: LiveHud | null;
}

export interface OverlayFeed {
  rev: number;
  serverNow: number;
  studio: StudioState;
  match: CastMatchView | null;
  live: CastLiveRound | null;
}
