/**
 * CIELAB distance and dichromat simulation, for the palette tests.
 *
 * This exists so the slot palette's colour-blind safety is an ASSERTION rather
 * than a claim in a comment. A palette is easy to break by eye: a later edit
 * that nudges one hex "to match the rest" can collapse two slots to within a
 * couple of dE under deuteranopia without looking any different to the person
 * making the change. The numbers below are what catch that.
 *
 * The simulation is Vienot, Brettel and Mollon 1999, which is the standard
 * single-plane approximation for protanopia and deuteranopia (it is NOT valid
 * for tritanopia, so tritanopia is deliberately absent here rather than
 * silently wrong). Distances are dE76, the plain Euclidean CIELAB distance:
 * dE2000 is more faithful for near-threshold pairs, but dE76 is what the
 * review's own numbers were computed in and every threshold in the palette
 * test is far enough above threshold that the two agree about pass and fail.
 */

const D65 = { x: 0.95047, y: 1, z: 1.08883 };

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function fromLinear(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function parseHex(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

type Matrix = readonly (readonly [number, number, number])[];

function apply(m: Matrix, v: readonly number[]): number[] {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

const RGB_TO_LMS: Matrix = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];
const LMS_TO_RGB: Matrix = [
  [0.080944447, -0.130504409, 0.116721066],
  [-0.010248533, 0.054019327, -0.113614708],
  [-0.000365297, -0.004121615, 0.693511405],
];
/** Protanopia: the L cone is missing, so its response is reconstructed from
 *  the other two. */
const PROTAN: Matrix = [[0, 2.02344, -2.52581], [0, 1, 0], [0, 0, 1]];
/** Deuteranopia: the M cone is missing. */
const DEUTAN: Matrix = [[1, 0, 0], [0.494207, 0, 1.24827], [0, 0, 1]];

export type Vision = 'normal' | 'protanopia' | 'deuteranopia';

/** What a colour looks like to a dichromat, as a hex string. */
export function simulate(hex: string, vision: Vision): string {
  if (vision === 'normal') return hex;
  const lms = apply(RGB_TO_LMS, parseHex(hex).map(toLinear));
  const seen = apply(vision === 'protanopia' ? PROTAN : DEUTAN, lms);
  const rgb = apply(LMS_TO_RGB, seen).map(fromLinear);
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** CIELAB L*, a*, b* under a D65 white. */
export function toLab(hex: string): [number, number, number] {
  const [r, g, b] = parseHex(hex).map(toLinear);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / D65.x);
  const fy = f(y / D65.y);
  const fz = f(z / D65.z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** dE76 between two colours, optionally as a given dichromat sees them. */
export function distance(a: string, b: string, vision: Vision = 'normal'): number {
  const [l1, a1, b1] = toLab(simulate(a, vision));
  const [l2, a2, b2] = toLab(simulate(b, vision));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** WCAG relative luminance. Used for the digit's contrast against its dot. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
