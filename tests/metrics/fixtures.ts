import { ENTITY_KIND, STATE, type EntitySample, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import type { RoundCtx, RoundEvent, RoundInput, RoundReplay } from '../../src/metrics/types.js';

export const SURV = ['s1', 's2', 's3', 's4'];
export const INF = ['i1', 'i2', 'i3', 'i4'];

const idle = (slot: number): PlayerSample => ({
  slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
});

export interface FrameSpec {
  tMs: number;
  /** survivors 0-3: [x, y, weapon] alive and standing unless state given */
  surv?: { x: number; y: number; weapon?: number; state?: number }[];
  /** infected slots 4-7 */
  inf?: { cls: number; state?: number; health?: number }[];
  witch?: { x: number; y: number }[];
  tankAi?: boolean;
}

export function frame(s: FrameSpec): Frame {
  const players = Array.from({ length: 8 }, (_, i) => idle(i));
  (s.surv ?? []).forEach((p, i) => {
    players[i] = { ...idle(i), x: p.x, y: p.y, weapon: p.weapon ?? 1, health: 100,
      state: p.state ?? (STATE.PRESENT | STATE.ALIVE), infected: false };
  });
  for (let i = 0; i < 4; i++) players[i].infected = false;
  (s.inf ?? []).forEach((p, i) => {
    players[4 + i] = { ...idle(4 + i), cls: p.cls, health: p.health ?? 250,
      state: p.state ?? (STATE.PRESENT | STATE.ALIVE), infected: true };
  });
  for (let i = 4; i < 8; i++) players[i].infected = true;
  const entities: EntitySample[] = [];
  (s.witch ?? []).forEach((w, i) => entities.push({ ref: 100 + i, kind: ENTITY_KIND.WITCH, state: 2, x: w.x, y: w.y, z: 0, health: 1000 }));
  if (s.tankAi) entities.push({ ref: 200, kind: ENTITY_KIND.TANK_AI, state: STATE.PRESENT | STATE.ALIVE, x: 0, y: 0, z: 0, health: 6000 });
  return { tMs: s.tMs, players, entities, offset: 0 };
}

/** Frames every 100 ms from `from` to `to` (exclusive) built by `spec(t)`. */
export function frames(from: number, to: number, spec: (t: number) => Omit<FrameSpec, 'tMs'>): Frame[] {
  const out: Frame[] = [];
  for (let t = from; t < to; t += 100) out.push(frame({ tMs: t, ...spec(t) }));
  return out;
}

export function replayOf(fs: Frame[]): RoundReplay {
  let d = 0;
  for (let i = 0; i + 1 < fs.length; i++) d += Math.min(fs[i + 1].tMs - fs[i].tMs, 1000);
  return { frames: fs, durationMs: d + 100 };
}

export const standing4 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }];

export function input(over: Partial<RoundInput> = {}): RoundInput {
  const teamOf = new Map<string, 'a' | 'b'>();
  SURV.forEach((p) => teamOf.set(p, 'a'));
  INF.forEach((p) => teamOf.set(p, 'b'));
  return {
    key: { matchId: 1, ordinal: 0, half: 1 }, survTeam: 'a', reliable: true, ended: true,
    score: 400, survivorsAlive: 2, events: [], marks: [], stats: new Map(), hasStats: false,
    skillDetect: false, teamOf, replay: null, ...over,
  };
}

export function ev(kind: string, actor: string, tMs: number, target: string | null = null, value = 0): RoundEvent {
  return { kind, actor, target, value, tMs };
}

export function stats(rows: [player: string, stat: string, value: number][]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const [p, s, v] of rows) { if (!m.has(p)) m.set(p, new Map()); m.get(p)!.set(s, v); }
  return m;
}

export type { RoundCtx };
