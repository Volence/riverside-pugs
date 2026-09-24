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

export type ProbeId = 'Q1' | 'Q2' | 'Q3' | 'Q8' | 'Q24' | 'K5' | 'C2' | 'Z3' | 'T1';

export const PROBES: Readonly<Record<ProbeId, { passed: boolean; batch: string; question: string }>> = {
  Q1: { passed: true, batch: 'B1 (a), (c)', question: 'monochrome_color on a HealthPanel recolours the whole panel (fill, outline, number, cross, scratches) in every state' },
  Q2: { passed: true, batch: 'B1 (a)', question: 'LocalPlayer clips its children and does not paint its own image' },
  Q3: { passed: true, batch: 'B1 (a)', question: 'inset draws the fill inset inside an outline' },
  Q8: { passed: true, batch: 'B1 (b)', question: 'the crouch icon keeps a file drawColor and shows only while crouched' },
  // /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md, B14: b14/crops/si-b-zoom.png and card-b.png (b), b14b-a (the Boomer).
  Q24: { passed: true, batch: 'B14 (b, and b14b-a)', question: 'monochrome_color on the SI Health and the card HealthPanel recolours the bar (fill and outline) only, not the number, name or icon' },
  // /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, V1: the editor's own build with the gate forced open drew
  // the notices at size 24 (v1/crops/v1a-k-b-notice.png, v1a-s-b-notice.png). R4's notice had never fired.
  K5: { passed: true, batch: 'V1a (k-b, s-b)', question: "recordlabel0's font sets the kill notice's text size" },
  // Same file, C2 and V1: the chat opens only on a key bound to messagemode (client.dll 0x100b49e0), never from
  // the console, and synthetic X keys were ignored (v1/shots-v1a, v1/shots-v1e); the closed chat draws no box.
  C2: { passed: false, batch: 'R4 (i), R1 (n), V1a (c2), V1e (c2)', question: "basechat.res HudChat bgcolor_override colours the open chat's box" },
  // Same file, V1: debug_zombie_panel 1 drew the Tank offer box with the title, text and box colours written
  // (v1/crops/v1b-tank-offer.png).
  Z3: { passed: true, batch: 'V1b (zp-tank1)', question: "zombiepanel.res TankTakeover's title, text, picture and box keys are honoured" },
  // Same file, V1: a human Tank with the survivors in the rescue closets drew the meter with every key written
  // (v1/crops/v1d-frustration-a.png, v1d-frustration-d.png; east_aligned against the stock control v1f-frustration-stock-d.png).
  T1: { passed: true, batch: 'V1d (t-a, t-d), V1f (t-d)', question: 'frustrationmeter.res keys (east_aligned, label colours, fonts, moves) are honoured' },
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
