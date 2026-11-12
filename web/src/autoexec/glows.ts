/**
 * The glow colours a player can set from an autoexec, and nothing else.
 *
 * Only cvars a retail L4D1 client accepts are listed: every cl_glow_*_r/_g/_b
 * triple below is FCVAR_RELEASE (settable, not archived, so it has to be
 * re-applied from autoexec.cfg on every launch). The other glow cvars are
 * left out on purpose: cl_glow_brightness, cl_glow_blur_scale, cl_glow_force,
 * cl_glow_noise and cl_glow_los_* are cheat cvars, and cl_glow_infected /
 * cl_glow_infected_ghosts are development-only, so a retail client ignores
 * them (client RE 2026-10-23, ~/l4d/hud/re-2026-10-23/hidden-knobs.md).
 *
 * Each channel is a float from 0 to 1. The page only ever writes values in
 * that range, at three decimals, from a colour picker or a hex code.
 */

export type Rgb = readonly [number, number, number];
export type Side = 'survivor' | 'infected';

export interface GlowCvar {
  /** The cvar stem: cl_glow_<id>_r/_g/_b. */
  id: string;
  label: string;
  /** Who sees it. */
  side: Side;
  hint: string;
  /** The game's own default (the cvar's registered value). */
  def: Rgb;
  /** Set only for the cl_colorblind 2 variants. */
  colorblind?: boolean;
}

export const GLOWS: readonly GlowCvar[] = [
  { id: 'survivor', side: 'survivor', label: 'Teammate', hint: 'A teammate out of sight, through walls.', def: [0.3, 0.4, 1.0] },
  { id: 'survivor_hurt', side: 'survivor', label: 'Incapped teammate', hint: 'A teammate who is down or hanging.', def: [1.0, 0.4, 0.0] },
  { id: 'survivor_vomit', side: 'survivor', label: 'Boomed teammate', hint: 'A teammate covered in Boomer bile.', def: [1.0, 0.4, 0.0] },
  { id: 'item', side: 'survivor', label: 'Item in reach', hint: 'The item under your crosshair, close enough to pick up.', def: [0.7, 0.7, 1.0] },
  { id: 'item_far', side: 'survivor', label: 'Item out of reach', hint: 'The item under your crosshair, too far away to pick up yet.', def: [0.3, 0.4, 1.0] },
  { id: 'thirdstrike_item', side: 'survivor', label: 'Item on last life', hint: 'Replaces the item colours while you are black and white.', def: [1.0, 0.0, 0.0] },
  { id: 'survivor_health_high', side: 'infected', label: 'Survivor, high health', hint: 'How you see survivors as infected.', def: [0.039, 0.69, 0.196] },
  { id: 'survivor_health_med', side: 'infected', label: 'Survivor, medium health', hint: 'How you see survivors as infected.', def: [0.59, 0.4, 0.032] },
  { id: 'survivor_health_low', side: 'infected', label: 'Survivor, low health', hint: 'How you see survivors as infected.', def: [0.63, 0.098, 0.098] },
  { id: 'infected_vomit', side: 'infected', label: 'Boomed survivor', hint: 'A survivor covered in bile, as infected see them.', def: [0.79, 0.07, 0.72] },
  { id: 'infected', side: 'infected', label: 'Infected teammate', hint: 'Your spawned infected teammates.', def: [0.3, 0.4, 1.0] },
  { id: 'ghost_infected', side: 'infected', label: 'Ghost teammate', hint: 'Infected teammates still in ghost form.', def: [0.3, 0.4, 1.0] },
  { id: 'ability', side: 'infected', label: 'Ability', hint: 'The game calls it "ability glow". Red by default.', def: [1.0, 0.0, 0.0] },
  // cl_colorblind 2 swaps these in for their plain versions.
  { id: 'survivor_health_high_colorblind', side: 'infected', colorblind: true, label: 'Survivor, high health', hint: 'Colour-blind set.', def: [0.047, 0.694, 0.392] },
  { id: 'survivor_health_med_colorblind', side: 'infected', colorblind: true, label: 'Survivor, medium health', hint: 'Colour-blind set.', def: [0.694, 0.573, 0.098] },
  { id: 'survivor_health_low_colorblind', side: 'infected', colorblind: true, label: 'Survivor, low health', hint: 'Colour-blind set.', def: [0.047, 0.807, 0.807] },
  { id: 'ability_colorblind', side: 'infected', colorblind: true, label: 'Ability', hint: 'Colour-blind set.', def: [0.3, 1.0, 1.0] },
  { id: 'thirdstrike_item_colorblind', side: 'survivor', colorblind: true, label: 'Item on last life', hint: 'Colour-blind set.', def: [0.3, 1.0, 1.0] },
];

const BY_ID = new Map(GLOWS.map((g) => [g.id, g]));

/** The plain cvar a colour-blind variant stands in for. */
export const plainOf = (id: string) => id.replace(/_colorblind$/, '');

export type GlowSet = Record<string, Rgb>;

export const gameDefaults = (): GlowSet => Object.fromEntries(GLOWS.map((g) => [g.id, g.def]));

/** cl_colorblind: leave the player's own setting alone, or set one of the three legal values. */
export type ColorblindChoice = 'keep' | '0' | '1' | '2';

export interface AutoexecState {
  glows: GlowSet;
  colorblind: ColorblindChoice;
}

export const DEFAULT_STATE: AutoexecState = { glows: gameDefaults(), colorblind: 'keep' };

/** A channel as the game takes it: a float in [0, 1], rounded to 3 places. */
export function legalChannel(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
}

const hex2 = (v: number) => Math.round(legalChannel(v) * 255).toString(16).padStart(2, '0');

export const toHex = (c: Rgb) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

/** '#rrggbb' or 'rrggbb' (or the 3-digit forms) to a colour, null when it is not one. */
export function fromHex(s: string): Rgb | null {
  let h = s.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = (i: number) => legalChannel(parseInt(h.slice(i, i + 2), 16) / 255);
  return [n(0), n(2), n(4)];
}

/** Same colour once both are shown as #rrggbb (what the picker can tell apart). */
export const sameColour = (a: Rgb, b: Rgb) => toHex(a) === toHex(b);

const fmt = (v: number) => String(legalChannel(v));

/**
 * The cfg text. Every glow is written, so the file fully decides the colours
 * whatever an older autoexec set; cl_colorblind only when the player chose one.
 */
export function buildCfg(state: AutoexecState): string {
  const lines = [
    '// Glow colours, made with the Riverside autoexec builder (riversidepug.com/autoexec).',
    '// Put this file in left4dead/cfg/ and add this line to your autoexec.cfg:',
    '//   exec glows',
    '// Or paste these lines into autoexec.cfg itself, at the end.',
    '',
  ];
  if (state.colorblind !== 'keep') {
    lines.push(`cl_colorblind "${state.colorblind}"`, '');
  }
  let lastSide: Side | null = null;
  let lastCb = false;
  for (const g of GLOWS) {
    if (g.side !== lastSide || !!g.colorblind !== lastCb) {
      if (lastSide !== null) lines.push('');
      lines.push(`// ${g.colorblind ? 'Colour-blind set (cl_colorblind 2)' : g.side === 'survivor' ? 'Seen as a survivor' : 'Seen as infected'}`);
      lastSide = g.side;
      lastCb = !!g.colorblind;
    }
    const c = state.glows[g.id] ?? g.def;
    lines.push(`cl_glow_${g.id}_r "${fmt(c[0])}"`, `cl_glow_${g.id}_g "${fmt(c[1])}"`, `cl_glow_${g.id}_b "${fmt(c[2])}"`);
  }
  return lines.join('\n') + '\n';
}

export interface ParseResult {
  state: AutoexecState;
  /** How many known settings were read. */
  read: number;
  /** Lines that named a glow cvar this page does not offer (cheat or dev-only ones). */
  ignored: string[];
}

/**
 * Read glow lines out of any cfg text (an autoexec, a pasted snippet). Only
 * the cvars in GLOWS and cl_colorblind are taken; values are clamped to the
 * legal range. Everything else in the file is left alone.
 */
export function parseCfg(text: string, base: AutoexecState = DEFAULT_STATE): ParseResult {
  const glows: Record<string, [number, number, number]> = {};
  for (const [id, c] of Object.entries(base.glows)) glows[id] = [c[0], c[1], c[2]];
  let colorblind = base.colorblind;
  let read = 0;
  const ignored: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // A cfg line can hold several commands; comments start at //.
    for (const cmd of raw.replace(/\/\/.*$/, '').split(';')) {
      const m = /^\s*"?([a-z0-9_]+)"?\s+"?\s*([-+0-9.eE]+)\s*"?\s*$/i.exec(cmd);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const value = Number(m[2]);
      if (name === 'cl_colorblind') {
        if (value === 0 || value === 1 || value === 2) { colorblind = String(value) as ColorblindChoice; read++; }
        continue;
      }
      const g = /^cl_glow_(.+)_([rgb])$/.exec(name);
      if (g && BY_ID.has(g[1]) && Number.isFinite(value)) {
        glows[g[1]][('rgb').indexOf(g[2])] = legalChannel(value);
        read++;
      } else if (name.startsWith('cl_glow_')) {
        ignored.push(name);
      }
    }
  }
  return { state: { glows, colorblind }, read, ignored: [...new Set(ignored)] };
}

/** A stored state, checked: unknown keys dropped, every channel made legal. */
export function readState(raw: unknown): AutoexecState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_STATE;
  const r = raw as { glows?: unknown; colorblind?: unknown };
  const glows = gameDefaults();
  if (typeof r.glows === 'object' && r.glows !== null) {
    for (const [id, c] of Object.entries(r.glows as Record<string, unknown>)) {
      if (BY_ID.has(id) && Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number')) {
        glows[id] = [legalChannel(c[0]), legalChannel(c[1]), legalChannel(c[2])];
      }
    }
  }
  const colorblind = (['keep', '0', '1', '2'] as const).find((v) => v === r.colorblind) ?? 'keep';
  return { glows, colorblind };
}

/** The glow colours in the site's own autoexec.cfg (web/public/autoexec.cfg). */
export const RIVERSIDE_GLOWS: GlowSet = {
  ability: [1, 0, 0],
  ability_colorblind: [1, 0, 0],
  ghost_infected: [0.8, 0.8, 0.8],
  infected: [0, 0.498, 1],
  infected_vomit: [0.761, 0.043, 0.686],
  item: [0.357, 0.961, 0.824],
  item_far: [0.349, 0.961, 0.824],
  survivor: [0, 0.498, 1],
  survivor_health_high: [0.035, 0.686, 0.192],
  survivor_health_high_colorblind: [0.035, 0.686, 0.192],
  survivor_health_med: [0.588, 0.478, 0.031],
  survivor_health_med_colorblind: [0.588, 0.478, 0.031],
  survivor_health_low: [0.627, 0.094, 0.094],
  survivor_health_low_colorblind: [0.698, 0.247, 0],
  survivor_hurt: [0.973, 0.435, 0.094],
  survivor_vomit: [0.765, 0.012, 0.69],
  thirdstrike_item: [1, 0, 0],
  thirdstrike_item_colorblind: [1, 0, 0],
};
