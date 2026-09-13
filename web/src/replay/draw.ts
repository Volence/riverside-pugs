import { boxSpan, projectView, type MapTransform, type View } from '../../../src/mapTransform';
import { ENTITY_KIND, STATE, ZOMBIE_CLASSES, type EntitySample, type PlayerSample } from '../../../src/replayFormat';
import { relativeLuminance } from './colorDistance';
import {
  AVATAR_BASE_R, TANK_BASE_R, ENTITY_MEDAL_R, FOLLOW_RING_GAP, FOLLOW_RING_WIDTH, drawMedallion,
} from './avatar';
import { DEAD_COLOR, stateRingColor, statusGlyph } from './stateRing';
import { pictogramFor } from './pictograms';
import { healthBar, portraitFor } from './hud';

export { statusGlyph, stateRingColor, DEAD_COLOR, FOLLOW_RING_WIDTH };

/** Roster slots 0-3 are the survivor team for this half and 4-7 are the
 *  infected. The player record carries no team field because the slot already
 *  is one. */
/** Which side a player is on this round.
 *
 *  Decoded frames carry `infected` from the file header's side mask (format
 *  version 3, or stamped by the serving route for older files of a known
 *  match). The slot-order fallback is for hand-built samples and for old
 *  standalone files, and it is exactly the assumption that put survivors in
 *  the infected column for every second half and every join-ordered roster. */
export function isSurvivor(p: PlayerSample): boolean {
  return p.infected === undefined ? p.slot < 4 : !p.infected;
}

export function medianHeight(players: PlayerSample[]): number {
  const alive = players
    .filter((p) => (p.state & STATE.ALIVE) !== 0)
    .map((p) => p.z)
    .sort((a, b) => a - b);
  if (alive.length === 0) return 0;
  return alive[Math.floor(alive.length / 2)];
}

/** How far above or below the team an avatar may be scaled. Twenty percent is
 *  enough to read as "that one is upstairs" and small enough that it never
 *  looks like a different kind of thing. */
const HEIGHT_SCALE = 0.2;
/** The height difference at which the scaling is fully applied. Roughly two
 *  storeys, so a normal slope does almost nothing and a floor above does all
 *  of it. */
const HEIGHT_SPAN = 400;

export function avatarRadius(z: number, medianZ: number, base = AVATAR_BASE_R): number {
  const d = Math.max(-1, Math.min(1, (z - medianZ) / HEIGHT_SPAN));
  return base * (1 + d * HEIGHT_SCALE);
}

/** Is this a player-controlled tank: an infected slot whose class is the
 *  tank in `m_zombieClass`. The one place that test is written, so
 *  `playerBaseRadius`, `maxHealthOf` and the map's arc gate cannot drift
 *  apart from each other or from HudStrip's panel. */
export function isPlayerTank(p: PlayerSample): boolean {
  return !isSurvivor(p) && ZOMBIE_CLASSES[p.cls] === 'tank';
}

/** A player tank is drawn at the AI tank's size: the biggest thing on the
 *  field is the biggest thing on the map. */
export function playerBaseRadius(p: PlayerSample): number {
  return isPlayerTank(p) ? TANK_BASE_R : AVATAR_BASE_R;
}

/** The health pool a player's arc is drawn over. */
export function maxHealthOf(p: PlayerSample): number {
  return isPlayerTank(p) ? 8000 : 100;
}

/**
 * Eight per-slot colours: cool for the four survivor slots, warm for the four
 * infected slots, so team identity survives at a glance even though every
 * slot within a team is individually distinguishable.
 *
 * Retuned against measured CIELAB distance, under normal vision and under
 * simulated protanopia and deuteranopia, because the first cut of this
 * palette failed three ways at once (`colorDistance.ts` is the arithmetic,
 * and the palette tests are where the numbers below are actually enforced).
 *
 * Within a team it was useless to a dichromat: indigo and violet measured 2.8
 * dE apart under protanopia and 8.2 under deuteranopia, and three of the four
 * infected flattened to about 13 under deuteranopia. The worst within-team
 * pair is now 18.1, and it is 18.4 for survivors.
 *
 * It also collided with the world entities, which the single-colour scheme
 * never did: a survivor sat 21.4 from the AI hunter, so a SURVIVOR read as a
 * hunter with entities shown. Every slot is now at least 24 from every entity
 * colour, and no survivor is within 27 of the hunter. The old team red was
 * the worst offender of all at 13.8 from the AI tank, which predates the
 * slot colours entirely; it is now 26.
 *
 * What did NOT change is the split itself, which is the one thing the old
 * palette got right: the nearest cross-team pair is 29.2 under protanopia and
 * 37.0 under deuteranopia, comfortably further than any two slots inside a
 * team, so warm versus cool still reads as friend versus enemy first.
 *
 * Hue alone still cannot carry slot identity on a dot this small, under any
 * vision. That is `slotNumber`'s job; this palette is the redundant channel,
 * not the load-bearing one.
 *
 * The four survivors deliberately sit in cyan through blue with no violet at
 * all. Violet is where the AI hunter lives, and the collision is structural
 * rather than a matter of tuning: keeping survivors out of that arc is what
 * removes it for good. Slots 0 and 3 end up within a point of each other in
 * lightness and are separated by hue instead (267 against 230); under
 * deuteranopia they simulate to two blues of visibly different saturation,
 * which is 18.4 apart and is the pair the survivor floor above is measuring.
 */
export const SLOT_COLORS: readonly string[] = [
  '#57a7f1', // survivor 0: sky blue,   L* 66.5, hue 267
  '#29f2ef', // survivor 1: cyan,       L* 87.1, hue 194
  '#3073d0', // survivor 2: royal blue, L* 48.8, hue 282
  '#2cb2d5', // survivor 3: azure,      L* 67.4, hue 230
  '#cc4760', // infected 4: crimson,    L* 49.7, hue 15
  '#f19776', // infected 5: salmon,     L* 71.0, hue 46
  '#eed06a', // infected 6: gold,       L* 84.1, hue 92
  '#ea8d92', // infected 7: rose,       L* 68.5, hue 19
];

/**
 * The player the follow camera should centre on, or null to stay free.
 *
 * A slot index alone is not enough. `players` is indexed by slot and always
 * carries eight records, and an unoccupied slot is an ALL-ZERO record rather
 * than a missing one, so following it would centre the camera on world
 * (0, 0), which on most maps is somewhere off in the void. That was latent
 * while the follow row skipped slots with no roster entry; it stops being
 * latent the moment every slot gets a button, which is what the standalone
 * route needed.
 */
export function followTarget(
  players: PlayerSample[], slot: number | null,
): PlayerSample | null {
  if (slot === null) return null;
  const p = players[slot];
  if (!p || (p.state & STATE.PRESENT) === 0) return null;
  return p;
}

export function slotColor(slot: number): string {
  return SLOT_COLORS[slot] ?? '#ffffff';
}

/**
 * The one colour every ghost is drawn in, whatever slot it belongs to.
 *
 * A ghost is an infected that has not spawned, and its position is exactly
 * what the ten second server-side delay exists to blunt on the public live
 * page. Drawing it in its own slot colour made it individually identifiable
 * by slot, where before it was not, and it varied how visible one was: at the
 * same 0.35 alpha a gold ghost is over three times as luminous as the single
 * red every ghost used to be. That is inside the letter of the anti-ghosting
 * rule, which is about rings, labels and highlights, but it is movement in
 * the wrong direction and nobody decided it.
 *
 * A muted brick, below the old red's own luminance, so no ghost is now more
 * visible than any ghost was before, and far enough from all eight slot
 * colours that it cannot be read as a spawned one. Per-slot identity is for
 * spawned infected only.
 */
export const GHOST_COLOR = '#9c5f5a';

/**
 * The slot's number within its own team, drawn inside the avatar.
 *
 * This is the second channel Finding 4 asked for, and it is the one that
 * actually carries slot identity. Hue on a five pixel dot cannot: within a
 * team the old palette measured 2.8 dE apart under protanopia, which is
 * roughly 6 to 8 percent of male viewers getting nothing from per-slot colour
 * at all. A digit is robust to every colour vision deficiency there is, and
 * it doubles as the answer to Finding 12, since a viewer who can read "3" off
 * the dot can match it to the third follow button whether or not a name ever
 * resolved.
 *
 * It counts within a team rather than across all eight because within a team
 * is where the colours failed; warm against cool already answers which team,
 * and a two character label would not fit inside the dot.
 */
export function slotNumber(slot: number): string {
  return String((slot % 4) + 1);
}

/** The short, roster-free name for a slot: S1 to S4 and I1 to I4.
 *
 *  On the by-filename viewer route `Viewer` defaults `names` to an empty
 *  object, so nothing ever resolved and the Names toggle was a silent no-op.
 *  Standalone `!mix` sessions are the common case for that route. This is
 *  useful and leaks no SteamID64, which is the one thing that may never be
 *  printed on the map. */
export function slotLabel(slot: number): string {
  return `${slot < 4 ? 'S' : 'I'}${slotNumber(slot)}`;
}

/**
 * Which ink the slot number is drawn in, chosen per colour.
 *
 * The eight dots run from L* 48.8 to L* 87.1, so no single ink clears 4.5:1
 * against all of them. The crossover between the page's near-black and white
 * sits at a relative luminance of about 0.19; every slot is tested against
 * its own ink rather than trusting that threshold.
 */
export function numberInk(color: string): string {
  return relativeLuminance(color) > 0.19 ? '#0b0908' : '#ffffff';
}

/** Darken a hex colour by a factor; the common's head against its body. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * f).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

export type EntityShape = 'figure' | 'medallion' | 'rock' | 'dot';
export interface EntityStyle { color: string; radius: number; shape: EntityShape; pictogram?: string }

/** Colours are unchanged from the dot era, because the slot palette's tests
 *  measure against them. Sizes and shapes are the spec's "medium" scale:
 *  next to a 22px medallion a 4px common was gravel and a 6px rock a crumb. */
const ENTITY_STYLES: Record<number, EntityStyle> = {
  [ENTITY_KIND.COMMON]: { color: '#6b6f57', radius: 3.5, shape: 'figure' },
  [ENTITY_KIND.WITCH]: { color: '#e8e8e8', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'witch' },
  [ENTITY_KIND.TANK_ROCK]: { color: '#b07a3c', radius: 5, shape: 'rock' },
  [ENTITY_KIND.TANK_AI]: { color: '#c0563a', radius: TANK_BASE_R, shape: 'medallion', pictogram: 'tank' },
  [ENTITY_KIND.SURVIVOR_BOT]: { color: '#4d7d9e', radius: ENTITY_MEDAL_R, shape: 'medallion' },
  [ENTITY_KIND.SMOKER_AI]: { color: '#7aa65f', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'smoker' },
  [ENTITY_KIND.BOOMER_AI]: { color: '#9e8a3f', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'boomer' },
  [ENTITY_KIND.HUNTER_AI]: { color: '#8d6bb0', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'hunter' },
};

export function entityStyle(kind: number): EntityStyle | null {
  return ENTITY_STYLES[kind] ?? null;
}

/** How long the rock's motion streak is, in CSS pixels. */
export const ROCK_STREAK_PX = 12;
/** Witch rim once startled: the alert red, until witch_killed. */
export const WITCH_STARTLED_COLOR = '#de4e40';

export interface ShowFlags {
  ci: boolean;
  entities: boolean;
  names: boolean;
}

export interface SceneCounts { survivors: number; commons: number; specials: number }

/**
 * What the status line reports.
 *
 * Specials counts both halves of the picture: rostered infected players who
 * are alive, and AI specials, which arrive as entities rather than player
 * records because the player block is the roster and a bot never joins it.
 * Counting only one of the two would read as zero on a mix night and as
 * nearly zero in a ranked match with an AI tank on the field.
 */
export function sceneCounts(players: PlayerSample[], entities: EntitySample[]): SceneCounts {
  let survivors = 0;
  let specials = 0;
  for (const p of players) {
    if ((p.state & STATE.ALIVE) === 0) continue;
    if (isSurvivor(p)) survivors++;
    // A ghost has not spawned, so it is not on the field to be counted.
    else if ((p.state & STATE.GHOST) === 0) specials++;
  }

  let commons = 0;
  for (const e of entities) {
    if (e.kind === ENTITY_KIND.COMMON) commons++;
    else if (
      e.kind === ENTITY_KIND.SMOKER_AI || e.kind === ENTITY_KIND.BOOMER_AI ||
      e.kind === ENTITY_KIND.HUNTER_AI || e.kind === ENTITY_KIND.TANK_AI
    ) {
      // Same ghost exclusion as the player branch above, and for the same
      // reason: an AI special can be in GHOST state exactly like a rostered
      // one can (the recorder derives both from the same RplIsGhost call),
      // and a ghost has not spawned yet. This narrows only the count. The
      // draw loop below is untouched and keeps painting a ghost solid,
      // because undercounting is safe in every world but a wrongly-hollow
      // tank marker is not, if the ghost bit ever turns out to be a stale
      // read rather than a true pre-spawn phase.
      if ((e.state & STATE.GHOST) === 0) specials++;
    }
  }
  return { survivors, commons, specials };
}

export interface DrawArgs {
  transform: MapTransform;
  view: View;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  players: PlayerSample[];
  entities: EntitySample[];
  /** The earlier of the two frames the scene was interpolated between, for
   *  motion (the rock streak). Matched by `ref`. */
  entitiesPrev: EntitySample[];
  /** A witch_aggro has happened with no witch_killed after it. */
  witchStartled: boolean;
  show: ShowFlags;
  width: number;
  height: number;
  /** SteamID64 to display name, the same lookup the HUD strip uses. */
  names: Record<string, string>;
  /** Slot index to SteamID64, from the replay header. A standalone `!mix`
   *  session has no roster, so this is often all blanks. */
  slots: string[];
  followSlot: number | null;
  /** Decoded portrait images by URL (the string `portraitFor` returns). An
   *  image not yet loaded is simply absent and the disc draws without it. */
  portraits: Record<string, HTMLImageElement>;
  /** Replay format version, for `portraitFor`'s "is the character byte
   *  real" check. */
  version: number;
}

/**
 * Screen-space gaps between an avatar's edge and its chrome, in the same
 * screen units as `avatarRadius`. None of these are multiplied by the view's
 * scale anywhere they are used below: they are icons over a map that softens
 * as it scales, not scale models that should soften with it.
 */
/** How far the glyph's baseline sits above the avatar's top edge.
 *
 *  The outermost thing an avatar ever draws (short of the follow ring) is
 *  the follow halo pass, whose outer edge is r + FOLLOW_RING_GAP + 2. The
 *  glyph is drawn on an alphabetic baseline, so its ink grows UPWARD from the
 *  y it is given and that y is its lowest point: a gap of FOLLOW_RING_GAP + 3
 *  puts the bottom of the glyph clear of the halo whether or not this
 *  particular player is being followed. Both terms carry the same r, so the
 *  clearance holds at every avatar size. */
const GLYPH_GAP = FOLLOW_RING_GAP + 3;

/** Label chrome, all in the same screen units (CSS pixels, since wave one
 *  made the backing store follow `clientWidth * devicePixelRatio`). */
const LABEL_FONT_PX = 10;
/** One line height for the de-confliction walk. Ten point text needs about
 *  1.2 line height to stop consecutive rows touching. */
export const LABEL_LINE_H = 12;
/** The plate is a pixel taller than the line height it reserves, so two
 *  plates pushed to exactly one line apart still show a seam between them. */
const LABEL_PLATE_H = 13;
export const LABEL_PAD_X = 3;
/** A bar of the slot's own colour down the plate's left edge. The text itself
 *  stays white, because the slot colours run from L* 51 to L* 82 and the
 *  darkest of them on a near-black plate is only about 3.9:1, which is not a
 *  contrast to set 10px text at. The bar carries the colour instead, at a
 *  size where colour is all it has to carry. */
export const LABEL_TICK_W = 2;
/** How far the plate's LEFT EDGE sits right of the avatar's right edge.
 *  The text starts at r + LABEL_GAP and the plate begins LABEL_PAD_X before
 *  it, so the plate's left edge is at r + LABEL_GAP - LABEL_PAD_X, which with
 *  FOLLOW_RING_GAP at 10 is r + 14: clear of the follow halo at r + 12
 *  (FOLLOW_RING_GAP + FOLLOW_RING_WIDTH). */
const LABEL_GAP = FOLLOW_RING_GAP + LABEL_PAD_X + 4;

/** A label queued for the de-confliction pass. */
interface LabelJob {
  /** Where the avatar is, so the leader line knows what to point back at. */
  ax: number;
  ay: number;
  /** Where the text starts. The plate's own width is not known until
   *  `drawLabels` has set the font and measured, and the layout needs it,
   *  because two labels only collide if their plates overlap horizontally. */
  px: number;
  py: number;
  text: string;
  color: string;
}

/**
 * Push overlapping labels apart, in screen order.
 *
 * Every label used to be drawn at a fixed offset from its own avatar and
 * vertically centred on it, with no de-confliction at all. Four survivors
 * standing together, which is their normal state, sit inside about eleven
 * canvas pixels, so four names roughly ten pixels tall landed on baselines
 * eleven pixels apart: mush. Worse, the survivor group was walked in slot
 * order rather than screen order, so which name ended up on top was arbitrary
 * and flickered as slots crossed each other.
 *
 * Sorting by `py` first fixes both: the walk is deterministic in the only
 * ordering a viewer can see, and each label is pushed down only as far as it
 * takes to clear the ones already placed. A label never moves up, so the
 * topmost of a cluster always keeps its true position and the stack grows
 * downward from a correct anchor.
 *
 * A label is only pushed by another whose PLATE IT WOULD ACTUALLY TOUCH, so
 * the horizontal extent matters as much as the vertical one. Comparing y
 * alone turns a row of players spread right across the map, which is what a
 * team on the move looks like, into a diagonal cascade of labels trailing
 * further and further below their own avatars, all to resolve collisions that
 * were never going to happen. Each label is compared against every one
 * already placed rather than only the last, because pushing down past one
 * plate can slide it into a different plate's column.
 */
export function stackLabels<T extends { px: number; py: number; w: number }>(
  jobs: readonly T[], lineH: number = LABEL_LINE_H,
): (T & { ly: number })[] {
  const sorted = [...jobs].sort((a, b) => a.py - b.py);
  const out: (T & { ly: number })[] = [];
  for (const j of sorted) {
    let ly = j.py;
    // This settles because every move puts `ly` STRICTLY further down, and it
    // can only ever land on one of the finitely many `o.ly + lineH` values.
    // The strictness is checked rather than assumed: in floating point,
    // `(o.ly + lineH) - o.ly` can come out a hair under `lineH` (12 became
    // 11.999999999999993 on a real spawn cluster), so a label already sitting
    // on `o.ly + lineH` still read as overlapping `o` and was "pushed" to the
    // same value forever. That spun the main thread and made the whole page
    // uninteractable. A push that would not move the label down is not a
    // push; the rounding hair it leaves is far below a pixel.
    for (let moved = true; moved;) {
      moved = false;
      for (const o of out) {
        const overlapsX = j.px < o.px + o.w && o.px < j.px + j.w;
        if (overlapsX && Math.abs(ly - o.ly) < lineH && o.ly + lineH > ly) {
          ly = o.ly + lineH;
          moved = true;
        }
      }
    }
    out.push({ ...j, ly });
  }
  return out;
}

/**
 * Draw the de-conflicted labels.
 *
 * A filled plate rather than only a stroke, for two reasons. Where two labels
 * do still overlap, two opaque plates read as two labels; two stroked strings
 * read as noise. And `strokeText` centres its stroke on the glyph outline, so
 * the old three pixel stroke put one and a half pixels INWARD, which at a ten
 * pixel font closes the counters of e, a and o entirely. The fill cannot
 * reopen them, because a counter is not part of the glyph's ink, so over a
 * light patch of map those letters came out as black blobs. The plate does
 * the stroke's job properly, so there is no stroke here at all.
 */
function drawLabels(ctx: CanvasRenderingContext2D, jobs: readonly LabelJob[]): void {
  if (jobs.length === 0) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `${LABEL_FONT_PX}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Measured before the layout, because the layout needs to know which plates
  // could touch. The font is set above, so every measurement is in the font
  // the text is actually drawn in.
  const measured = jobs.map((j) => ({
    ...j,
    w: ctx.measureText(j.text).width + LABEL_PAD_X * 2 + LABEL_TICK_W,
  }));
  for (const j of stackLabels(measured)) {
    const plateX = j.px - LABEL_PAD_X;
    const plateY = j.ly - LABEL_PLATE_H / 2;
    const plateW = j.w;

    // A label pushed clear of a crowd can end up well below its own avatar,
    // so a hairline leads back to it. Skipped when the label did not move,
    // where it would just be a dash hanging off the dot.
    if (j.ly - j.py > 1) {
      ctx.beginPath();
      ctx.moveTo(j.ax, j.ay);
      ctx.lineTo(plateX, j.ly);
      ctx.strokeStyle = j.color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = 'rgba(5,4,3,0.78)';
    ctx.fillRect(plateX, plateY, plateW, LABEL_PLATE_H);
    ctx.fillStyle = j.color;
    ctx.fillRect(plateX, plateY, LABEL_TICK_W, LABEL_PLATE_H);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(j.text, j.px + LABEL_TICK_W, j.ly);
  }
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(217,203,176,0.06)';
  ctx.lineWidth = 1;
  const step = 64;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw one frame.
 *
 * Order matters and is the whole readability of the view: backdrop, then the
 * route trail, then commons, then world entities, then players on top. A
 * common drawn over a survivor makes a horde look like it has already won.
 */
export function drawScene(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  ctx.clearRect(0, 0, a.width, a.height);
  ctx.fillStyle = '#0b0908';
  ctx.fillRect(0, 0, a.width, a.height);

  if (a.backdrop) {
    // Only the cropped region (the map's content box) is drawn, scaled and
    // offset by the view, so the void the capture wastes never reaches the
    // canvas. The span comes from `boxSpan`, the same helper the view's scale
    // was computed from: reading `b.x1 - b.x0` here instead would hand
    // `drawImage` a zero-width source rect on a degenerate box, which throws
    // IndexSizeError, while the scale beside it had silently used one pixel.
    const b = a.view.box;
    const span = boxSpan(b);
    ctx.drawImage(
      a.backdrop,
      b.x0, b.y0, span.w, span.h,
      a.view.offsetX, a.view.offsetY,
      span.w * a.view.scale, span.h * a.view.scale,
    );
  } else {
    // No art for this map. The grid gives the eye a scale reference and the
    // trail below turns the route itself into the map.
    drawGrid(ctx, a.width, a.height);
  }

  if (a.trail.length > 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(111,177,224,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const first = projectView(a.transform, a.view, a.trail[0].x, a.trail[0].y);
    ctx.moveTo(first.px, first.py);
    for (let i = 1; i < a.trail.length; i++) {
      const p = projectView(a.transform, a.view, a.trail[i].x, a.trail[i].y);
      ctx.lineTo(p.px, p.py);
    }
    ctx.stroke();
    ctx.restore();
  }

  const prevByRef = new Map<number, EntitySample>();
  for (const e of a.entitiesPrev) prevByRef.set(e.ref, e);

  for (const e of a.entities) {
    const style = entityStyle(e.kind);
    if (!style) continue;
    const isCommon = e.kind === ENTITY_KIND.COMMON;
    if (isCommon && !a.show.ci) continue;
    if (!isCommon && !a.show.entities) continue;
    const p = projectView(a.transform, a.view, e.x, e.y);
    ctx.save();
    switch (style.shape) {
      case 'figure': {
        // Head and shoulders: a horde reads as bodies rather than gravel.
        const r = style.radius;
        ctx.fillStyle = style.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(p.px, p.py + r * 0.15, r, r * 0.72, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = shade(style.color, 0.6);
        ctx.beginPath();
        ctx.arc(p.px, p.py, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'medallion': {
        const startled = e.kind === ENTITY_KIND.WITCH && a.witchStartled;
        drawMedallion(ctx, {
          x: p.px, y: p.py, r: style.radius,
          rim: startled ? WITCH_STARTLED_COLOR : style.color,
          pictogram: style.pictogram ?? null,
          face: style.pictogram ? null : a.portraits['/portraits/unknown.png'] ?? null,
        });
        break;
      }
      case 'rock': {
        // Six-point rock, drawn first so the streak, if any, sits on top of
        // it: a moving rock reads as trailing over its own edge.
        const r = style.radius;
        const pts = [[-0.6, 0.4], [-0.4, -0.7], [0.2, -0.9], [0.8, -0.2], [0.6, 0.6], [-0.1, 0.9]];
        ctx.beginPath();
        pts.forEach(([ux, uy], i) => {
          const x = p.px + ux * r; const y = p.py + uy * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const prev = prevByRef.get(e.ref);
        if (prev && prev.kind === e.kind) {
          const q = projectView(a.transform, a.view, prev.x, prev.y);
          const dx = p.px - q.px; const dy = p.py - q.py;
          const len = Math.hypot(dx, dy);
          if (len > 0.5) {
            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(p.px - (dx / len) * ROCK_STREAK_PX, p.py - (dy / len) * ROCK_STREAK_PX);
            ctx.strokeStyle = style.color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.6;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        break;
      }
      default: {
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(p.px, p.py, style.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  const median = medianHeight(a.players);
  // Infected first, survivors last. Both halves already draw over commons
  // and world entities; this just reorders the two player groups within
  // that same top layer so a survivor's label or ring is never the thing
  // sitting underneath an enemy dot.
  const infected = a.players.filter((pl) => !isSurvivor(pl));
  const survivors = a.players.filter(isSurvivor);
  const labels: LabelJob[] = [];
  for (const pl of [...infected, ...survivors]) {
    if ((pl.state & STATE.PRESENT) === 0) continue;
    const alive = (pl.state & STATE.ALIVE) !== 0;
    const p = projectView(a.transform, a.view, pl.x, pl.y);

    ctx.save();
    // A ghost is an infected that has not spawned. It is drawn hollow so it
    // reads as "not really there yet". The ten second server-side delay is
    // what makes showing it safe at all; nothing here may be relaxed into
    // showing a ghost sooner, and none of the chrome below (health arc,
    // state ring, status glyph, name label, badge, follow highlight) may be
    // given to one either: every one of those would make an unspawned
    // infected easier to read, which is the opposite of the point.
    const ghost = (pl.state & STATE.GHOST) !== 0;

    const r = avatarRadius(pl.z, median, playerBaseRadius(pl));
    const color = slotColor(pl.slot);
    const survivor = isSurvivor(pl);

    if (ghost) {
      // The whole anti-ghosting contract in one call: hollow, muted, no
      // chrome. drawMedallion ignores every other field when `hollow` is
      // set.
      drawMedallion(ctx, { x: p.px, y: p.py, r, rim: GHOST_COLOR, hollow: true, alpha: 0.35 });
      ctx.restore();
      continue;
    }

    const faceUrl = survivor ? portraitFor(pl.cls, a.version, true) : null;
    const face = faceUrl ? a.portraits[faceUrl] ?? null : null;
    const pictogram = survivor ? null : pictogramFor(pl.cls);
    const bar = alive ? healthBar(pl.health, pl.temp, maxHealthOf(pl), pl.state) : null;
    // Survivors always carry an arc; among infected only the tank has a pool
    // worth reading (HudStrip draws the same two cases).
    const arc = bar && (survivor || isPlayerTank(pl))
      ? { perm: bar.perm, temp: bar.temp, color: bar.color } : null;

    drawMedallion(ctx, {
      x: p.px, y: p.py, r,
      rim: alive ? color : DEAD_COLOR,
      face,
      pictogram,
      badge: alive ? { text: slotNumber(pl.slot), ink: numberInk(color) } : null,
      yaw: alive ? pl.yaw : null,
      ring: alive ? stateRingColor(pl.state) : null,
      arc,
      dead: !alive,
      alpha: alive ? 1 : 0.7,
      follow: a.followSlot === pl.slot,
    });

    // Status glyph above the medallion: the colour-blind channel for the
    // ring, from the same table, so the two cannot disagree.
    const glyph = alive ? statusGlyph(pl.state) : '';
    if (glyph) {
      const gy = p.py - r - GLYPH_GAP;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(glyph, p.px, gy);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(glyph, p.px, gy);
    }

    // Name label: resolved through the roster, never the raw SteamID64.
    // A standalone `!mix` session has no roster at all, and that is the
    // common case on the by-filename route, so an unresolved name falls
    // back to the slot's own short label rather than to the seventeen-digit
    // id, which would be worse than no label, or to nothing, which is what
    // made the Names toggle a silent no-op on that route.
    //
    // Queued rather than drawn. Labels cannot be laid out one avatar at a
    // time: whether this one has to move depends on every other label on
    // screen, so the whole set is de-conflicted in one pass after the loop.
    // Drawing them last also puts every label above every avatar, instead
    // of leaving the ones drawn early to be painted over.
    if (a.show.names) {
      const name = a.names[a.slots[pl.slot]] || slotLabel(pl.slot);
      labels.push({
        ax: p.px + r, ay: p.py,
        px: p.px + r + LABEL_GAP, py: p.py,
        text: name, color: alive ? color : DEAD_COLOR,
      });
    }
    ctx.restore();
  }

  drawLabels(ctx, labels);
}
