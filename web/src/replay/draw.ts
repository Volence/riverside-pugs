import { boxSpan, projectView, type MapTransform, type View } from '../../../src/mapTransform';
import { ENTITY_KIND, STATE, type EntitySample, type PlayerSample } from '../../../src/replayFormat';
import { relativeLuminance } from './colorDistance';
import { healthBar, TEMP_HEALTH_COLOR } from './hud';

/** Roster slots 0-3 are the survivor team for this half and 4-7 are the
 *  infected. The player record carries no team field because the slot already
 *  is one. */
export function isSurvivor(p: PlayerSample): boolean {
  return p.slot < 4;
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

export function avatarRadius(z: number, medianZ: number, base = 7): number {
  const d = Math.max(-1, Math.min(1, (z - medianZ) / HEIGHT_SPAN));
  return base * (1 + d * HEIGHT_SCALE);
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

export function slotColor(slot: number): string {
  return SLOT_COLORS[slot] ?? '#ffffff';
}

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
  return relativeLuminance(color) > 0.19 ? '#11130f' : '#ffffff';
}

/** Font size for the digit inside the avatar. At the base radius of 7 the dot
 *  is 14px across and its inscribed square is 9.9px, which a 9px digit (about
 *  6.4px of cap height and 5px wide) fits inside with room to spare. */
const SLOT_NUMBER_PX = 9;

/**
 * The one status marker worth showing on the map, checked in priority order.
 *
 * At 5-8 world units per pixel a survivor is only 4-6 pixels across, so
 * several stacked markers would just be a smudge. Pinned wins ties because
 * that is the state someone watching needs to see soonest: it is the one
 * where a teammate is seconds from being carried off.
 */
export function statusGlyph(state: number): string {
  if ((state & STATE.PINNED) !== 0) return 'P';
  if ((state & STATE.INCAP) !== 0) return 'X';
  if ((state & STATE.LEDGED) !== 0) return 'L';
  if ((state & STATE.BURNING) !== 0) return 'F';
  if ((state & STATE.BILED) !== 0) return 'B';
  return '';
}

/**
 * A large coloured ring for the two states someone watching needs to see
 * soonest, or null for everything else.
 *
 * This is the ring the slot-colour change removed. It was replaced by a
 * letter roughly seven CSS pixels tall, and a seven pixel letter is not
 * findable in peripheral vision while scanning a map, where a large coloured
 * ring is. `statusGlyph` is now the refinement that says WHICH of the two it
 * is, on top of a signal that gets the eye there in the first place.
 *
 * The priority order is deliberately identical to `statusGlyph`'s, so on a
 * player who is both pinned and down the ring's colour and the letter can
 * never disagree about which state won.
 */
export function alertColor(state: number): string | null {
  // The amber the ring that was removed used, and the same amber the HUD
  // panel sets its status flags in.
  if ((state & STATE.PINNED) !== 0) return '#e8b04b';
  if ((state & (STATE.INCAP | STATE.LEDGED)) !== 0) return '#d9534f';
  return null;
}

const ENTITY_STYLES: Record<number, { color: string; radius: number }> = {
  [ENTITY_KIND.COMMON]: { color: '#6b6f57', radius: 2 },
  [ENTITY_KIND.WITCH]: { color: '#e8e8e8', radius: 5 },
  [ENTITY_KIND.TANK_ROCK]: { color: '#b07a3c', radius: 3 },
  [ENTITY_KIND.TANK_AI]: { color: '#c0563a', radius: 9 },
  [ENTITY_KIND.SURVIVOR_BOT]: { color: '#4d7d9e', radius: 6 },
  [ENTITY_KIND.SMOKER_AI]: { color: '#7aa65f', radius: 5 },
  [ENTITY_KIND.BOOMER_AI]: { color: '#9e8a3f', radius: 6 },
  [ENTITY_KIND.HUNTER_AI]: { color: '#8d6bb0', radius: 5 },
};

export function entityStyle(kind: number): { color: string; radius: number } | null {
  return ENTITY_STYLES[kind] ?? null;
}

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
  show: ShowFlags;
  width: number;
  height: number;
  /** SteamID64 to display name, the same lookup the HUD strip uses. */
  names: Record<string, string>;
  /** Slot index to SteamID64, from the replay header. A standalone `!mix`
   *  session has no roster, so this is often all blanks. */
  slots: string[];
  followSlot: number | null;
}

/**
 * Screen-space gaps between an avatar's edge and its chrome, in the same
 * screen units as `avatarRadius`. None of these are multiplied by the view's
 * scale anywhere they are used below: they are icons over a map that softens
 * as it scales, not scale models that should soften with it.
 */
const HEALTH_RING_GAP = 3;
const HEALTH_RING_WIDTH = 2;
/** The alert ring shares the health ring's radius and is drawn under it, so a
 *  four pixel width puts two pixels of colour proud on each side of the two
 *  pixel health arc and the alert signal costs the avatar no extra footprint
 *  at all. At the base radius of 7 that is a ring spanning r + 1 to r + 5,
 *  that is 8 to 12 pixels from the centre, around a 14 pixel dot. */
const ALERT_RING_WIDTH = 4;
const FOLLOW_RING_GAP = 8;
export const FOLLOW_RING_WIDTH = 2;
/** How far the glyph's baseline sits above the avatar's top edge.
 *
 *  The outermost thing an avatar ever draws is the follow ring's dark halo
 *  pass, whose outer edge is r + FOLLOW_RING_GAP + FOLLOW_RING_WIDTH, that is
 *  r + 10. The glyph is drawn on an alphabetic baseline, so its ink grows
 *  UPWARD from the y it is given and that y is its lowest point: a gap of 11
 *  puts the bottom of the glyph one pixel clear of the halo. Both terms carry
 *  the same r, so the clearance holds at every avatar size. */
const GLYPH_GAP = 11;

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
 *  it, so the plate's left edge is at r + LABEL_GAP - LABEL_PAD_X = r + 11,
 *  one pixel clear of the follow halo's r + 10. */
const LABEL_GAP = 14;

/** A label queued for the de-confliction pass. */
interface LabelJob {
  /** Where the avatar is, so the leader line knows what to point back at. */
  ax: number;
  ay: number;
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
 * takes to clear the one above it. A label never moves up, so the topmost of
 * a cluster always keeps its true position and the stack grows downward from
 * a correct anchor.
 */
export function stackLabels<T extends { py: number }>(
  jobs: readonly T[], lineH: number = LABEL_LINE_H,
): (T & { ly: number })[] {
  const sorted = [...jobs].sort((a, b) => a.py - b.py);
  const out: (T & { ly: number })[] = [];
  let prev = -Infinity;
  for (const j of sorted) {
    const ly = Math.max(j.py, prev + lineH);
    out.push({ ...j, ly });
    prev = ly;
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
  for (const j of stackLabels(jobs)) {
    const w = ctx.measureText(j.text).width;
    const plateX = j.px - LABEL_PAD_X;
    const plateY = j.ly - LABEL_PLATE_H / 2;
    const plateW = w + LABEL_PAD_X * 2 + LABEL_TICK_W;

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

    ctx.fillStyle = 'rgba(8,10,7,0.78)';
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
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
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
  ctx.fillStyle = '#11130f';
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

  for (const e of a.entities) {
    const style = entityStyle(e.kind);
    if (!style) continue;
    const isCommon = e.kind === ENTITY_KIND.COMMON;
    if (isCommon && !a.show.ci) continue;
    if (!isCommon && !a.show.entities) continue;
    const p = projectView(a.transform, a.view, e.x, e.y);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(p.px, p.py, style.radius, 0, Math.PI * 2);
    ctx.fill();
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
    const r = avatarRadius(pl.z, median);
    const color = slotColor(pl.slot);

    ctx.save();
    // A ghost is an infected that has not spawned. It is drawn hollow so it
    // reads as "not really there yet". The ten second server-side delay is
    // what makes showing it safe at all; nothing here may be relaxed into
    // showing a ghost sooner, and none of the new chrome below (health ring,
    // status glyph, name label, follow highlight) may be given to one
    // either: every one of those would make an unspawned infected easier to
    // read, which is the opposite of the point.
    const ghost = (pl.state & STATE.GHOST) !== 0;
    ctx.globalAlpha = alive ? (ghost ? 0.35 : 1) : 0.3;

    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    if (ghost) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (alive) {
      // Yaw is degrees with 0 along +x, and canvas y grows downward, so the
      // sine is negated to keep the arrow pointing where the player looks.
      const rad = (pl.yaw * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = -Math.sin(rad);
      ctx.beginPath();
      // Starts at the avatar's EDGE, not its centre. The slot number lives
      // inside the dot now, and an arrow drawn from the centre outward would
      // strike straight through the digit at four yaws out of every turn.
      ctx.moveTo(p.px + dx * r, p.py + dy * r);
      ctx.lineTo(p.px + dx * r * 2.2, p.py + dy * r * 2.2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // The slot number, inside the dot, on top of the arrow's root. This is
    // what actually tells two teammates apart: see `slotNumber`.
    if (!ghost && alive) {
      ctx.font = `bold ${SLOT_NUMBER_PX}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = numberInk(color);
      ctx.fillText(slotNumber(pl.slot), p.px, p.py);
    }

    if (!ghost) {
      // Health ring: a living survivor's own health as a fraction of a full
      // circle, in the HUD panel's own colour ramp, starting at 12 o'clock
      // and sweeping clockwise. Full health closes the ring; a sliver is the
      // same warning a nearly-empty HUD bar gives, without looking away from
      // the map to see it. Restricted to survivors because a tank's health
      // is not a 0-100 scale and an infected player record has no bar to
      // echo in the first place.
      if (alive && isSurvivor(pl)) {
        const ringR = r + HEALTH_RING_GAP;

        // The alert ring, under the health arc and sharing its radius: a
        // closed circle of colour wide enough to catch the eye from across
        // the map. Drawn first so the health arc rides on top of it.
        const alert = alertColor(pl.state);
        if (alert) {
          ctx.beginPath();
          ctx.arc(p.px, p.py, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = alert;
          ctx.lineWidth = ALERT_RING_WIDTH;
          ctx.stroke();
        }

        // The same reading the panel's bar draws, from the same function, so
        // the map and the panel cannot disagree. Permanent health first from
        // 12 o'clock, then temporary health continuing from where it ends:
        // the two-part treatment the panel has always used, which the ring
        // used to leave out entirely. A survivor on 20 permanent and 70
        // temporary drew a red sliver here and a nearly full bar down there.
        const bar = healthBar(pl.health, pl.temp, 100, pl.state);
        const start = -Math.PI / 2;
        const mid = start + bar.perm * Math.PI * 2;
        ctx.lineWidth = HEALTH_RING_WIDTH;
        ctx.beginPath();
        ctx.arc(p.px, p.py, ringR, start, mid);
        ctx.strokeStyle = bar.color;
        ctx.stroke();
        if (bar.temp > 0) {
          ctx.beginPath();
          ctx.arc(p.px, p.py, ringR, mid, mid + bar.temp * Math.PI * 2);
          ctx.strokeStyle = TEMP_HEALTH_COLOR;
          ctx.stroke();
        }
      }

      // Status glyph: one marker, not a stack, drawn above the avatar with a
      // dark outline so it reads over both bright and dark map art.
      const glyph = statusGlyph(pl.state);
      if (glyph) {
        const gy = p.py - r - GLYPH_GAP;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(glyph, p.px, gy);
        ctx.fillStyle = '#e8b04b';
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
          text: name, color,
        });
      }

      // Follow highlight: a wider ring outside the health ring so the
      // followed player is findable at a glance, on either team. A plain
      // white stroke would wash out over the map's own near-white patches,
      // so it gets the same dark halo as the text below: a wider dark pass
      // first, then the bright ring on top of it.
      if (a.followSlot === pl.slot) {
        const followR = r + FOLLOW_RING_GAP;
        ctx.beginPath();
        ctx.arc(p.px, p.py, followR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = FOLLOW_RING_WIDTH + 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.px, p.py, followR, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = FOLLOW_RING_WIDTH;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawLabels(ctx, labels);
}
