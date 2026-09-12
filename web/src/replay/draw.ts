import { worldToImage, type MapTransform } from '../../../src/mapTransform';
import { ENTITY_KIND, STATE, type EntitySample, type PlayerSample } from '../../../src/replayFormat';

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

export function teamColor(p: PlayerSample): string {
  if (!isSurvivor(p)) return '#d9534f';
  return '#6fb1e0';
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
}

export interface DrawArgs {
  transform: MapTransform;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  players: PlayerSample[];
  entities: EntitySample[];
  show: ShowFlags;
  width: number;
  height: number;
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
    ctx.drawImage(a.backdrop, 0, 0, a.width, a.height);
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
    const first = worldToImage(a.transform, a.trail[0].x, a.trail[0].y);
    ctx.moveTo(first.px, first.py);
    for (let i = 1; i < a.trail.length; i++) {
      const p = worldToImage(a.transform, a.trail[i].x, a.trail[i].y);
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
    const p = worldToImage(a.transform, e.x, e.y);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(p.px, p.py, style.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const median = medianHeight(a.players);
  for (const pl of a.players) {
    if ((pl.state & STATE.PRESENT) === 0) continue;
    const alive = (pl.state & STATE.ALIVE) !== 0;
    const p = worldToImage(a.transform, pl.x, pl.y);
    const r = avatarRadius(pl.z, median);

    ctx.save();
    // A ghost is an infected that has not spawned. It is drawn hollow so it
    // reads as "not really there yet". The ten second server-side delay is
    // what makes showing it safe at all; nothing here may be relaxed into
    // showing a ghost sooner.
    const ghost = (pl.state & STATE.GHOST) !== 0;
    ctx.globalAlpha = alive ? (ghost ? 0.35 : 1) : 0.3;

    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    if (ghost) {
      ctx.strokeStyle = teamColor(pl);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = teamColor(pl);
      ctx.fill();
    }

    if (alive) {
      // Yaw is degrees with 0 along +x, and canvas y grows downward, so the
      // sine is negated to keep the arrow pointing where the player looks.
      const rad = (pl.yaw * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.px + Math.cos(rad) * r * 2.2, p.py - Math.sin(rad) * r * 2.2);
      ctx.strokeStyle = teamColor(pl);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if ((pl.state & STATE.INCAP) !== 0 || (pl.state & STATE.PINNED) !== 0) {
      ctx.beginPath();
      ctx.arc(p.px, p.py, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8b04b';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }
}
