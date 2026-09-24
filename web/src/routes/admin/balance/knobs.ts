import type { KnobView, RolloutServer } from '../../../api';

export function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Same string the server writes (src/balanceKnobs.ts formatKnobValue). */
export function formatKnob(k: Pick<KnobView, 'type' | 'step'>, n: number): string {
  return k.type === 'int' ? String(Math.round(n)) : n.toFixed(stepDecimals(k.step));
}

/** An input value clamped to the range and rounded to the step grid. */
export function snapKnob(k: KnobView, raw: string): string {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return k.baseline;
  const clamped = Math.min(k.max, Math.max(k.min, n));
  return formatKnob(k, k.min + Math.round((clamped - k.min) / k.step) * k.step);
}

export function serverStateText(s: RolloutServer, expectedNumber: number): string {
  if (s.mismatch && s.seen) return `expected #${expectedNumber}, saw #${s.seen.number}: ${s.mismatch}`;
  if (s.state === 'pending') return 'waiting for the server to be free';
  if (s.state === 'failed') return `write failed: ${s.lastError ?? 'unknown error'}, retrying`;
  if (s.state === 'written') return 'written, awaiting first match';
  return `confirmed ${s.confirmedAt ?? ''}`.trim();
}
