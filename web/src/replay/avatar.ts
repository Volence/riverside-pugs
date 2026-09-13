import { pictogramPath, PICTOGRAM_BOX } from './pictograms';
import { TEMP_HEALTH_COLOR } from './hud';

/** Base radii, CSS pixels, fixed at every zoom. */
export const AVATAR_BASE_R = 11;
export const TANK_BASE_R = 15;
export const ENTITY_MEDAL_R = 9;
export const RIM_W = 2.5;
/** A 1px near-black edge outside the rim so a cyan rim survives pale map. */
export const RIM_EDGE_W = 1;
export const STATE_RING_W = 3;
/** The rim is stroked at radius r with width RIM_W + 2*RIM_EDGE_W = 4.5, so
 *  it covers r-2.25..r+2.25. The state ring (width STATE_RING_W = 3) must
 *  sit flush outside that band, r+2.25..r+5.25, so its centre radius is
 *  r + 3.75. */
export const STATE_RING_GAP = 3.75;
export const ARC_W = 2;
/** The arc sits just outside the state ring's outer edge, r+5.25..r+7.25 is
 *  taken, so the arc (width ARC_W = 2) sits r+5.5..r+7.5 at centre r + 6.5. */
export const ARC_GAP = 6.5;
export const FOLLOW_RING_GAP = 10;
export const FOLLOW_RING_WIDTH = 2;
export const BADGE_R = 4.5;
export const BADGE_FONT_PX = 7;
export const WEDGE_LEN = 5;
export const WEDGE_HALF_W = 3.2;
export const DISC_COLOR = '#14110f';
export const HALO = 'rgba(0,0,0,0.85)';

export interface MedallionSpec {
  x: number; y: number; r: number;
  rim: string;
  face?: HTMLImageElement | null;
  pictogram?: string | null;
  badge?: { text: string; ink: string } | null;
  yaw?: number | null;
  ring?: string | null;
  arc?: { perm: number; temp: number; color: string } | null;
  dead?: boolean;
  hollow?: boolean;
  alpha?: number;
  follow?: boolean;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/**
 * One medallion: state ring, rim edge, rim, disc, face or pictogram, wedge,
 * badge, arc, follow ring, in that order so each sits over the last.
 *
 * A hollow spec (a ghost) is one stroked circle and returns early: the
 * anti-ghosting rule is enforced here, structurally, rather than by every
 * caller remembering to leave fields blank.
 */
export function drawMedallion(ctx: CanvasRenderingContext2D, s: MedallionSpec): void {
  const { x, y, r } = s;
  ctx.save();
  ctx.globalAlpha = s.alpha ?? 1;

  if (s.hollow) {
    circle(ctx, x, y, r);
    ctx.strokeStyle = s.rim;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (s.ring) {
    circle(ctx, x, y, r + STATE_RING_GAP);
    ctx.strokeStyle = s.ring;
    ctx.lineWidth = STATE_RING_W;
    ctx.stroke();
  }

  // Rim: dark edge first, colour on top, so the colour keeps its full width.
  circle(ctx, x, y, r);
  ctx.strokeStyle = HALO;
  ctx.lineWidth = RIM_W + RIM_EDGE_W * 2;
  ctx.stroke();
  circle(ctx, x, y, r);
  ctx.strokeStyle = s.rim;
  ctx.lineWidth = RIM_W;
  ctx.stroke();

  // Disc, then the face clipped to it or the pictogram over it.
  const inner = r - RIM_W / 2;
  circle(ctx, x, y, inner);
  ctx.fillStyle = DISC_COLOR;
  ctx.fill();
  if (s.face) {
    ctx.save();
    circle(ctx, x, y, inner);
    ctx.clip();
    if (s.dead) ctx.filter = 'grayscale(1) brightness(0.55)';
    ctx.drawImage(s.face, x - r, y - r, r * 2, r * 2);
    ctx.restore();
  } else if (s.pictogram) {
    const path = pictogramPath(s.pictogram);
    if (path) {
      ctx.save();
      const scale = (inner * 2 * 0.72) / PICTOGRAM_BOX;
      ctx.translate(x - (PICTOGRAM_BOX * scale) / 2, y - (PICTOGRAM_BOX * scale) / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = s.dead ? '#8a8a8a' : '#ffffff';
      ctx.fill(path);
      ctx.restore();
    }
  }

  if (s.dead) {
    ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = HALO;
    ctx.strokeText('†', x, y + 1);
    ctx.fillStyle = '#c9c9c9';
    ctx.fillText('†', x, y + 1);
  } else {
    if (typeof s.yaw === 'number') {
      // Yaw is degrees with 0 along +x and canvas y grows down, so the sine
      // is negated (same convention the old arrow used).
      const a = (s.yaw * Math.PI) / 180;
      const dx = Math.cos(a); const dy = -Math.sin(a);
      const bx = x + dx * r; const by = y + dy * r;        // base centre, on the rim
      const ax = x + dx * (r + WEDGE_LEN); const ay = y + dy * (r + WEDGE_LEN);
      const px = -dy; const py = dx;                       // perpendicular
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx + px * WEDGE_HALF_W, by + py * WEDGE_HALF_W);
      ctx.lineTo(bx - px * WEDGE_HALF_W, by - py * WEDGE_HALF_W);
      ctx.closePath();
      ctx.fillStyle = s.rim;
      ctx.fill();
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (s.badge) {
      const bx = x + r * Math.SQRT1_2; const by = y + r * Math.SQRT1_2;
      circle(ctx, bx, by, BADGE_R);
      ctx.fillStyle = s.rim;
      ctx.fill();
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `bold ${BADGE_FONT_PX}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = s.badge.ink;
      ctx.fillText(s.badge.text, bx, by + 0.5);
    }
    if (s.arc) {
      const R = r + ARC_GAP;
      const start = -Math.PI / 2;
      const mid = start + s.arc.perm * Math.PI * 2;
      ctx.lineWidth = ARC_W;
      ctx.beginPath();
      ctx.arc(x, y, R, start, mid);
      ctx.strokeStyle = s.arc.color;
      ctx.stroke();
      // Always issued, even at zero temp, so the two arcs are one shape to
      // test against; a zero-length arc paints nothing.
      ctx.beginPath();
      ctx.arc(x, y, R, mid, mid + s.arc.temp * Math.PI * 2);
      ctx.strokeStyle = TEMP_HEALTH_COLOR;
      ctx.stroke();
    }
  }

  if (s.follow) {
    circle(ctx, x, y, r + FOLLOW_RING_GAP);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = FOLLOW_RING_WIDTH + 2;
    ctx.stroke();
    circle(ctx, x, y, r + FOLLOW_RING_GAP);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = FOLLOW_RING_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
}
