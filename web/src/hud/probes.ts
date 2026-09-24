/**
 * The probe gates: one entry per in-game question whose answer decides
 * whether an editor control does anything in the real game.
 *
 * A control whose effect is still unproven ships hidden behind its gate. The
 * page reads the gate to show the control, validateDesign reads it to drop a
 * stored value for a closed gate (so a gate that flips back off clears them),
 * the build writes a gated key only while its gate is open, and the preview
 * draws the "code decides" default until then. The questions and the probe
 * shots that answer them are in section 4 of
 * docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md.
 *
 * Flipping a gate is a planned task of its own, never an edit hidden inside
 * another: it also updates the tests that pin the control as hidden. A
 * question the game answered NO is retired, not kept as a closed gate, so
 * this stays a list of open or passed questions: Q5 (the health cross keeps
 * a file colour) failed in B1 and its control is gone (slice 2.F G4).
 *
 * A leaf: imports nothing.
 */

export type ProbeId = 'Q1' | 'Q2' | 'Q3' | 'Q8';

export const PROBES: Readonly<Record<ProbeId, { passed: boolean; batch: string; question: string }>> = {
  Q1: { passed: true, batch: 'B1 (a), (c)', question: 'monochrome_color on a HealthPanel recolours the whole panel (fill, outline, number, cross, scratches) in every state' },
  Q2: { passed: false, batch: 'B1 (a)', question: 'LocalPlayer clips its children and does not paint its own image' },
  Q3: { passed: true, batch: 'B1 (a)', question: 'inset draws the fill inset inside an outline' },
  Q8: { passed: true, batch: 'B1 (b)', question: 'the crouch icon keeps a file drawColor and shows only while crouched' },
};

/** Test overrides, read before PROBES. */
const forced = new Map<ProbeId, boolean>();

export function probe(id: ProbeId): boolean {
  return forced.get(id) ?? PROBES[id].passed;
}

/** Tests only: force a gate, or null to go back to PROBES. */
export function _setProbe(id: ProbeId, value: boolean | null): void {
  if (value === null) forced.delete(id); else forced.set(id, value);
}
