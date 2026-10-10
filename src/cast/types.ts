/**
 * Caster studio shapes shared by the server and the browser. No imports, so
 * the web project can include this file as it is.
 */

export const SCENES = [
  'starting', 'casters', 'gameplay', 'mapintro', 'maps', 'lineups', 'stats', 'brb', 'winner', 'ending', 'results',
  // Drafts plan D2b2: appended, so the run-of-show keys never move.
  'draftboard', 'draftclock',
] as const;
export type SceneKey = (typeof SCENES)[number];

/** Scenes with a letter instead of a number: added after the run of show. */
const LETTER_KEYS: Partial<Record<SceneKey, string>> = { results: 'R', draftboard: 'B', draftclock: 'C' };

/** The panel's hotkey for each scene: 1-9 and 0 in order (the run of show
 *  casters learned), then letters for scenes added later. */
export const SCENE_HOTKEYS: Record<SceneKey, string> = Object.fromEntries(
  SCENES.map((s, i) => [s, LETTER_KEYS[s] ?? (i === 9 ? '0' : String(i + 1))]),
) as Record<SceneKey, string>;

/** The live draft scenes (drafts plan D2b2): the pick reveal card fires over
 *  these by itself, and the Program strip never does. */
export const DRAFT_SCENES: readonly SceneKey[] = ['draftboard', 'draftclock'];

/** Layers: overlays that are never a scene of their own on the program feed,
 *  but can be added to any OBS scene. */
export const LAYERS = ['scorebug', 'roundhud', 'lowerthird', 'draftreveal'] as const;
export type LayerKey = (typeof LAYERS)[number];

export type OverlayKey = SceneKey | LayerKey | 'program';

export const SCENE_LABELS: Record<SceneKey | LayerKey, string> = {
  starting: 'Starting soon',
  casters: 'Casters',
  gameplay: 'Gameplay',
  mapintro: 'Map intro',
  results: 'Round results',
  maps: 'Chapter scores',
  lineups: 'Lineups',
  stats: 'Match stats',
  brb: 'Be right back',
  winner: 'Winner',
  ending: 'Ending',
  scorebug: 'Scorebug',
  roundhud: 'Round HUD',
  lowerthird: 'Lower third',
  draftboard: 'Draft board',
  draftclock: 'On the clock',
  draftreveal: 'Pick reveal',
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
  /** The producer adds this caster's camera to OBS by hand (a local webcam
   *  source): keep the cam window open though there is no cam link. Without
   *  either, the Casters scene shows the no-camera tile (avatar and name). */
  ownCam: boolean;
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
  /** A live draft being followed (drafts plan D2b2 Ruling 1), or null.
   *  Independent of the match: a show can cut between the draft and a game. */
  draftEventId: number | null;
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
  /** The gameplay HUD look (plan ruling 23): `plate`, a centre score plate
   *  with the progress strip and the players as medallion stacks down the
   *  screen sides; `corners`, a team plate in each top corner with its
   *  players hanging under it; `rail`, one board down the left edge with the
   *  scores, a vertical progress gauge and both teams' players; `frame`,
   *  holes framed for the game's own team panels (a caster HUD moves them
   *  there) with the centre plate between; or `scorebug`, the original
   *  compact top-centre bug. */
  hudStyle: HudStyle;
  /** Frame mode's holes. */
  frame: FrameRects;
  /** A highlight card fired by the producer, shown for CALLOUT_MS from `at`. */
  callout: Callout | null;
  /** Highlight cards the overlay fires by itself from the live event feed.
   *  Off until the producer turns it on; `kinds` are event kinds
   *  (CALLOUT_KIND_LABELS). A card the producer fires by hand goes first. */
  autoCallouts: { on: boolean; kinds: string[] };
  /** The on-screen highlight card: `compact` (the default) is a slim
   *  one-line card, `normal` the original big stencil card. */
  calloutSize: 'compact' | 'normal';
  /** On the Program link, a pick reveal strip over scenes that are not draft
   *  scenes (Ruling 4). The draft scenes always reveal with their own card. */
  draftStrip: boolean;
}

export const HUD_STYLES = ['plate', 'corners', 'rail', 'frame', 'scorebug'] as const;

/** A rect on the 1920x1080 overlay, in pixels. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Frame mode: where the game draws its own team panels, so the overlay
 *  can frame them (ruling 30). A stock spectator sees the four survivor cards
 *  in the bottom band (x 60-1290, band y 962-1080) and no infected panel at
 *  all, so the survivor hole defaults to that and the infected hole is off
 *  (null) unless a caster HUD adds one. */
export interface FrameRects { survivor: Rect; infected: Rect | null }
export function defaultFrameRects(): FrameRects {
  return { survivor: { x: 40, y: 966, w: 1270, h: 110 }, infected: null };
}
/** Where an infected hole goes when the producer adds one. */
export const DEFAULT_INFECTED_RECT: Rect = { x: 1340, y: 20, w: 560, h: 150 };
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

/** Event kinds a highlight card can be made from, in the panel's order. */
export const CALLOUT_KIND_LABELS: Record<string, string> = {
  skeet: 'Skeets',
  dp: 'DPs',
  boom: 'Biles',
  tank_spawn: 'Tank spawns',
  tank_death: 'Tank down',
  witch_aggro: 'Witch startled',
  witch_killed: 'Witch down',
  death: 'Survivor deaths',
  incap: 'Incaps',
  car_alarm: 'Car alarms',
};

/** Auto-fire's starting set: the plays, not the everyday incaps, and not
 *  who finished the tank (owner: not worth seeing; the tank damage card
 *  covers a tank's death). */
export const DEFAULT_AUTO_KINDS = ['skeet', 'dp', 'boom', 'tank_spawn', 'witch_killed', 'death', 'car_alarm'];

export interface LiveElements {
  /** Survivor rows (health, status, items). Off by default: a spectator
   *  always has the four survivor cards in the game's bottom band (spectator
   *  probe 2026-10-02, ruling 30), so the rows would show them twice. */
  survivors: boolean;
  /** Infected rows (class, spawning, dead, damage). On by default: the probe
   *  found a spectator never sees infected state, classes or SI health. */
  infected: boolean;
  /** Tank health. On: a spectator never sees a tank HP bar (probe). */
  tank: boolean;
  /** Tank and witch flow %. On: the game never shows them on screen. */
  bosses: boolean;
  /** The map progress strip under the bar (the furthest survivor's flow %,
   *  with the boss points on it). Needs pug-match 0.3.20's LIVEHUD line; the
   *  strip hides itself on a server that does not send it. */
  progress: boolean;
  /** The tank damage card for a few seconds after a tank dies. */
  tankRecap: boolean;
  /** The witch card: each survivor's damage to her, crown or not, who startled her. */
  witchRecap: boolean;
  /** On the progress strip in the second half: how far the other team got
   *  on this map in the first half. */
  rival: boolean;
  /** On the progress strip: each survivor's own progress as a small face,
   *  showing who is rushing ahead or lagging. */
  dots: boolean;
}

export function defaultElements(): LiveElements {
  return { survivors: false, infected: true, tank: true, bosses: true, progress: true, tankRecap: true, witchRecap: true, rival: true, dots: true };
}

export const MAX_CASTERS = 3;
export const TEXT_MAX = 80;

export function defaultStudioState(): StudioState {
  return {
    matchId: null,
    bookingId: null,
    draftEventId: null,
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
    hudStyle: 'plate',
    frame: defaultFrameRects(),
    callout: null,
    autoCallouts: { on: false, kinds: [...DEFAULT_AUTO_KINDS] },
    calloutSize: 'compact',
    draftStrip: true,
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
  /** Career PUG record, for the player card: PUGs only, null on a scrim or
   *  tournament match (their lineups show the roster, not PUG numbers). */
  career: CastCareer | null;
  /** Role on the team side of a booked game (team captain, co-captain,
   *  member, or a pickup side's captain); null on a PUG. */
  role: CastRole | null;
}

export type CastRole = 'captain' | 'cocaptain' | 'member';

/** Career PUG numbers for the lineup cards (completed, unvoided PUGs),
 *  from the owner's stat set (2026-10-02): skeets, DPs, boomer %. */
export interface CastCareer {
  matches: number; wins: number; losses: number;
  /** skeets + team_skeets: every skeet, all weapons, counted once. */
  skeets: number;
  /** dps_landed: damage pounces. */
  dps: number;
  /** boom_successes / boomer_spawns in whole percent, null with no spawns. */
  boomerRate: number | null;
}

/** The skeet total the overlays show: solo plus team skeets. The weapon
 *  subsets are breakdowns of these two and are never added on top (see the
 *  skeet ruleset in src/statKeys.ts). */
export function skeetTotal(stats: Record<string, number>): number | null {
  if (stats.skeets === undefined && stats.team_skeets === undefined) return null;
  return (stats.skeets ?? 0) + (stats.team_skeets ?? 0);
}

/** Boomer % as the site computes it (src/standings.ts): booms landed per
 *  boomer life, null when there were no boomers, never 0% from 0/0. */
export function boomerRate(stats: Record<string, number>): number | null {
  const spawns = stats.boomer_spawns ?? 0;
  return spawns > 0 ? Math.round(((stats.boom_successes ?? 0) / spawns) * 100) : null;
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

/** The newest finished round, for the Round results scene: after a first
 *  half, that half and the score to beat; after a second half, the map. */
export interface CastRoundResult {
  /** 1-based chapter number and its map. */
  mapNumber: number;
  map: string;
  /** The half that just ended: 1, or 2 (the map is done). */
  half: 1 | 2;
  /** Each half of that map played so far, in order. `alive` is how many
   *  survivors made it, `seconds` the round's length, null when unknown. */
  halves: { half: 1 | 2; survTeam: 'a' | 'b'; score: number; alive: number | null; seconds: number | null }[];
  /** Each player's stats in the half that just ended (match_round_stats). */
  players: { steamid: string; name: string; team: 'a' | 'b'; stats: Record<string, number> }[];
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

/** One live event for the producer's highlight list. */
export interface CastEvent {
  seq: number; kind: string; actor: string; actorTeam: 'a' | 'b' | null; target: string | null; value: number;
  /** A skeet run (src/skeetStreaks.ts rules: one player, one map half, each
   *  skeet within STREAK_WINDOW_MS of the run's first): how many skeets it
   *  holds so far and who they were on. The list carries one entry per run,
   *  its newest skeet, so a double upgrades the single instead of stacking. */
  streak?: { count: number; targets: string[] };
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
  events: CastEvent[];
  /** The newest finished round, or null before the first one ends. */
  lastRound: CastRoundResult | null;
  /** For a followed booking: which game of how many. */
  game: { number: number; of: number } | null;
  /** Team A's chance of winning right now from the scoreboard and the maps
   *  left (src/winProb.ts). Null when it cannot be priced, when the match is
   *  not live, or when a producer override changed a score, since the odds
   *  would then disagree with the score on screen. */
  winChanceA?: number | null;
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
  /** Second half: the furthest the other team got on this map in the first
   *  half (the opponent's mark), or null when not known. */
  rivalReach: number | null;
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

export interface TankRecap {
  /** Milliseconds since it died, for the card's own timing. */
  agoMs: number;
  aliveS: number;
  controller: string | null;
  dealt: number;
  /** More than 1: overlapping tanks in one combined recap. */
  tanks: number;
  passes: number;
  /** dead, or the round ended with it up: wipe (every survivor down) or safe. */
  end: 'dead' | 'wipe' | 'safe';
  /** Highest first; share is of the survivors' total damage to this tank. */
  players: { name: string; dmg: number; share: number }[];
}

export interface WitchRecap {
  agoMs: number;
  /** Seconds from the startle to her death, null when never startled. */
  aliveS: number | null;
  startled: string | null;
  killer: string | null;
  crown: boolean;
  incaps: number;
  /** Highest first; share is of the survivors' total damage to her. */
  players: { name: string; dmg: number; share: number }[];
}

/** A live draft as the overlays get it (drafts plan D2b2 Ruling 3): the
 *  public room only, built by src/cast/draftView.ts from a whitelist. Never a
 *  note, a pick list, chemistry or the fairness readout. */
export type DraftStatus = 'ready' | 'running' | 'paused' | 'done';
export interface CastDraftPlayer { steamid: string; name: string; avatar: string | null; sr: number }
export interface CastDraftCard extends CastDraftPlayer {
  /** Completed PUGs played. */
  pugs: number;
  /** Newest first, up to 10. */
  form: ('W' | 'L' | 'D')[];
  /** Per completed PUG, one decimal. */
  survivor: { siDamage: number; commonKills: number };
  infected: { damageAsSi: number; dpsLanded: number };
  bestClass: 'hunter' | 'smoker' | 'boomer' | 'tank' | null;
}
export interface CastDraftPick { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
export interface CastDraftTeam {
  captain: CastDraftPlayer;
  /** In pick order, so players[r] is the round r + 1 pick. */
  players: CastDraftPlayer[];
  /** This team's pick number in each round once the room has started; empty before Start. */
  slots: number[];
}
export interface CastDraftView {
  eventId: number;
  eventName: string;
  status: DraftStatus;
  /** Server time the running pick ends, or null when not running. */
  deadlineAt: string | null;
  /** Time left on the clock while paused, or null. */
  pausedLeftMs: number | null;
  pickSeconds: number;
  totalPicks: number;
  rounds: number;
  onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
  /** Round 1 order. */
  teams: CastDraftTeam[];
  /** Live picks, in pick order. */
  picks: CastDraftPick[];
  /** A card for every picked player, for the reveal. */
  cards: Record<string, CastDraftCard>;
  /** The best free players by SR, highest first. */
  best: CastDraftCard[];
  poolLeft: number;
}
export const BEST_AVAILABLE = 3;

export interface OverlayFeed {
  rev: number;
  serverNow: number;
  studio: StudioState;
  match: CastMatchView | null;
  live: CastLiveRound | null;
  /** For a few seconds after a tank's window closes (pug-match TANKDONE):
   *  each survivor's damage to it, exact, and the tank's own line. On the
   *  feed, not the live round, because a wipe ends the round it belongs to. */
  tankRecap: TankRecap | null;
  /** For a few seconds after a witch dies (pug-match 0.3.21 WITCHDONE). */
  witchRecap: WitchRecap | null;
  /** One per studio.casters line: the matched site account's avatar for the
   *  no-camera tile, or null (src/cast/casterAvatars.ts). */
  casterAvatars: (string | null)[];
  /** The draft the studio follows, when the caster may still follow it (drafts plan D2b2). */
  draft: CastDraftView | null;
}
