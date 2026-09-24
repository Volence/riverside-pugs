/**
 * The child registry: which blocks inside a card file the editor lets a
 * player touch, and how.
 *
 * Phase 1 covers the survivor teammate card (teammatepanel.res). One file is
 * loaded for every teammate card, so an edit here edits all of them, and game
 * code decides which teammate lands in which card (audit C.1). Every name is
 * the real block name, pinned to both presets by children.test.ts, because a
 * typo here lands in a player's game.
 *
 * Data only: design.ts validates against it, build.ts writes with it, the
 * renderer and the page read it. It imports nothing but types.
 */
import type { KvNode } from './kv';
import type { ProbeId } from './probes';

/** The survivor states the preview can show a panel in. */
export type SurvivorState = 'healthy' | 'hurt' | 'down' | 'dead';

/** When game code shows a state piece: in a survivor state, or on a condition of its own. */
export type StateArt = 'down' | 'dead' | 'crouched' | 'talking' | 'ghost';

/**
 * A file key a control writes on a child (or on an element's own
 * hudlayout.res block). Every key is checked against the strings client.dll
 * really has (dllstrings.test.ts), because a registered key can still be one
 * the game never reads: the weapons work learned that the hard way.
 */
export interface KeyDef {
  key: string; label: string; type: 'colour' | 'int' | 'bool';
  range?: [number, number];
  /** Where the key is proven read: a dll string run or a stock file line. */
  evidence: string;
  /** The control waits for this probe to pass (probes.ts). */
  gate?: ProbeId;
  /** Shown under the control. */
  note?: string;
  /**
   * What the game uses when the file has no value, as the file's text: the
   * control shows it rather than a made-up default. A colour key has none:
   * unset means the game's own colour.
   */
  unset?: string;
  /** For a colour key: what the control says while the file leaves it unset. */
  unsetLabel?: string;
}

export type ChildKind = 'image' | 'label' | 'bar' | 'other';

export interface ChildDef {
  /** The block name in the file. */
  name: string;
  /** What the side panel calls it. */
  label: string;
  kind: ChildKind;
  /**
   * content: counts toward the fitted card. state: shown only when game code
   * says (down, dead, talking), never counted, squared by the fit rule.
   * decor: background, never counted, never a hit target on the canvas.
   */
  role: 'content' | 'state' | 'decor';
  /** Size controls: W and H, one Size for square art (aspect-locked), or none. */
  box: 'wh' | 'square' | 'none';
  /** X, Y and dragging. */
  move: boolean;
  /** Labels: a text size, written as a HudEd_<font>_t<size> copy of the label's font. */
  font: boolean;
  /**
   * A raw colour: fgcolor_override for a label (the name and status text),
   * drawColor for an image (an ImagePanel tint, the key the game already
   * honours on the stock infected card's frame). Which key a colour turns
   * into follows the child's own kind, so the registry only has to say
   * whether one applies at all.
   */
  colour: boolean;
  /**
   * An image whose own art is a flat colour (pure black, the splatter):
   * an RGB tint over it draws no visible difference, only its alpha does,
   * so the control is Opacity alone, no swatch, and colourKey still writes
   * drawColor "255 255 255 <alpha>". Ignored unless `colour` is also true.
   */
  opacityOnly?: boolean;
  /** A child some preset's file lacks: cloned from this template after `after` when turned on. */
  addable?: { template: KvNode; after: string };
  /** Shown under the child's controls. */
  note?: string;
  /** File keys this child's controls write, beyond the fixed ones above. */
  keys?: KeyDef[];
  /**
   * The splatter work restyles this piece's art (splatter.ts owns its image
   * and texture); everything else here only moves, sizes and hides it.
   */
  art?: 'splatter';
  /**
   * Shown only in that state. With hideIn, this replaces render.ts's
   * TEAM_HIDDEN and STATE_CHILDREN name lists for registered panels, so what
   * each state shows is said once, in data.
   */
  stateArt?: StateArt;
  /** Hidden in those survivor states (a down teammate's portrait gives way to the down art). */
  hideIn?: SurvivorState[];
  /**
   * State and decor pieces only. 'rule' (the default): the panel's fit rule
   * re-places the piece. 'keep': it keeps its place and counts toward the
   * fitted box, so turning fit on alone changes nothing on screen (the own
   * panel's scratches and crouch icon; plan decision 1).
   */
  fitPlace?: 'rule' | 'keep';
  /** The colour control waits for this probe, because code may repaint the piece. */
  colourGate?: ProbeId;
}

export interface PanelChildren {
  panelId: string; file: string; children: ChildDef[];
  /** 'cards': one file loaded per teammate, so an edit edits every card. 'single': one panel. */
  repeat: 'cards' | 'single';
  /**
   * The block that frames the children: one in the panel's own file, or the
   * element's hudlayout.res block. The teammate card has none of its own
   * (teamPass places each card inside CHudTeamDisplay).
   */
  frame?: { file: string; block: string } | 'hudlayout';
  /**
   * Other files that must follow this one's edits: 'same' copies an edit,
   * 'delta' applies the same move. Typed here, first written in slice 2.2
   * for the special infected health files.
   */
  linked?: { file: string; rule: 'same' | 'delta' }[];
}

const block = (key: string, pairs: [string, string][]): KvNode => ({ key, value: pairs.map(([k, v]) => ({ key: k, value: v })) });

/**
 * The Modern card's HealthNumber, placed right of the stock card's Name (x 13,
 * y 60, 120 wide), with a raw colour because a named scheme colour draws
 * nothing in some panels. The game recolours it by health anyway (probe T7).
 */
const HEALTH_NUMBER = block('HealthNumber', [
  ['ControlName', 'Label'], ['fieldName', 'HealthNumber'], ['xpos', '103'], ['ypos', '60'], ['wide', '30'], ['tall', '12'],
  ['visible', '1'], ['enabled', '1'], ['labelText', '%HealthNumber%'], ['textAlignment', 'east'],
  ['font', 'PlayerDisplayName'], ['zpos', '3'], ['fgcolor_override', '255 255 255 255'],
]);

/**
 * The card revive trap (edit.ts LINKED_X): after a revive the game puts a
 * card's health bar at the item row's x, so the two move sideways together.
 */
const REVIVE_LINK = "The health bar and the item icons move sideways together: after a revive the game puts a teammate's bar at the item row's left edge, so moving one alone would make the bar jump. While a teammate is down the game draws the bar at the Down picture's left edge.";

const STATE_NOTE = 'The game decides when this one shows. Pick Down or Dead above the canvas to see it.';

/**
 * monochrome_color and inset on a HealthPanel (the own bar and each card's).
 * Probe Q1 (/home/volence/l4d/hud/probe-phase2/RESULTS.md, B1 shots a and c,
 * b1v3 cards-hurt.png) showed monochrome_color is one colour for the whole
 * panel in every health state, down included: on the own panel the bar, its
 * outline, the number, the cross and the scratches, on a card the bar and the
 * number (plan decision 5). Q3 was proven on the own bar; the card's Health is
 * the same HealthPanel class with the one m_inset read, and B13 shows the same
 * default frame and inset on cards (plan decision 6).
 */
/** HealthPanel's inset when the file gives none: 2 units, 4 px at 1080p (b13/compare/stock-own.png, b1 Q3). */
export const STOCK_BAR_INSET = 2;

/**
 * The largest inset that leaves a unit of fill in a bar `tall` units high:
 * 2 * inset < tall (review L1, the same kind of rule as probe Q22's for the
 * use/heal bar). The stock card bar (7 tall) takes 3, Modern's own bar (6)
 * 2, the stock own bar (10) 4. Units in, units out.
 */
export const maxInset = (tall: number): number => Math.max(0, Math.floor((tall - 1) / 2));

const MONO_EVIDENCE = 'client.dll HealthPanel run: m_monochromeColor|monochrome_color';
const healthKeys = (note: string, insetEvidence: string): KeyDef[] => [
  { key: 'monochrome_color', label: 'Panel colour', type: 'colour', gate: 'Q1', evidence: MONO_EVIDENCE, note,
    unsetLabel: 'Game colour (by health)' },
  { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], gate: 'Q3', evidence: insetEvidence, unset: String(STOCK_BAR_INSET) },
];

export const TEAM_PANEL: PanelChildren = {
  panelId: 'teamColumn',
  file: 'resource/ui/hud/teammatepanel.res',
  repeat: 'cards',
  children: [
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false,
      hideIn: ['down', 'dead'] },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      hideIn: ['dead'],
      note: REVIVE_LINK,
      keys: healthKeys('Recolours the bar and the number on every card.',
        'client.dll HealthPanel run: m_inset|inset (one HealthPanel class with the own bar, where probe Q3 proved it; B13 shows the same default inset on cards)') },
    { name: 'Name', label: 'Name', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      addable: { template: HEALTH_NUMBER, after: 'Name' }, note: 'The game colours this by health.', hideIn: ['dead'] },
    { name: 'Items', label: 'Item icons', kind: 'label', role: 'content', box: 'none', move: true, font: true, colour: false,
      note: `The preview draws the game's own item icons, a full loadout; in game the row shows only what that teammate carries. ${REVIVE_LINK}`,
      hideIn: ['dead'] },
    { name: 'Status', label: 'Status text', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'BackgroundImage', label: 'Damage splatter', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: true,
      opacityOnly: true, art: 'splatter',
      note: 'Opacity fades whatever art the splatter shows. Change the art itself under Splatter, below the canvas: stock, none, a fade or your own picture.' },
    { name: 'Incapacitated', label: 'Down picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE,
      stateArt: 'down' },
    { name: 'Dead', label: 'Dead picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE,
      stateArt: 'dead' },
    { name: 'Voice', label: 'Voice icon', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE,
      stateArt: 'talking' },
  ],
};

const OWN_STATE = 'The game decides when this one shows. Pick it above the canvas to see it.';
const SCRATCH_NOTE = 'The game tints these by health, or the panel colour. Change their art under Splatter, below the canvas.';

/**
 * The player's own health panel (localplayerpanel.res), one panel framed by
 * localplayerdisplay.res's LocalPlayer. Probe batch B1 (2026-09-24,
 * /home/volence/l4d/hud/probe-phase2/RESULTS.md) answered the gated
 * controls; the gates in probes.ts still flip in their own tasks, so these
 * entries only say what the answers mean for each control:
 * - Q1 yes: monochrome_color tints the WHOLE panel (fill, number, cross and
 *   scratches), in every health state, so the control is a panel colour.
 * - Q3 yes: inset moves the fill inside the bar outline.
 * - Q5 no: the cross takes the panel's health colour whatever the file says,
 *   so it offers no colour at all (the gate is retired, slice 2.F G4).
 * - Q8 yes: the crouch icon keeps a file tint and shows only while crouched.
 * ModBg (Modern's fill) stays unregistered: the fit rule sizes it by name,
 * and ownBg is the player's background control.
 */
export const OWN_PANEL: PanelChildren = {
  panelId: 'ownHealth',
  file: 'resource/ui/hud/localplayerpanel.res',
  frame: { file: 'resource/ui/hud/localplayerdisplay.res', block: 'LocalPlayer' },
  repeat: 'single',
  children: [
    // Q9 is unasked: hiding the portrait when down is the teammate card's reading.
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false,
      hideIn: ['down'], note: 'The game picks the portrait by character.' },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      keys: healthKeys('Recolours the whole panel: bar, number, cross and scratches, in every health state.',
        'client.dll HealthPanel run: m_inset|inset'),
      note: "The game fills the bar by health. While you are down it draws the bar at the Down picture's left edge; the revive puts it back here." },
    { name: 'HealthIcon', label: 'Health cross', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      note: "The game colours this with the panel's health colour, or the Panel colour when one is set." },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      note: 'The game colours this by health.' },
    { name: 'HealthbarTextureTop', label: 'Scratches, top', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      art: 'splatter', fitPlace: 'keep', note: SCRATCH_NOTE },
    { name: 'HealthbarTextureBottom', label: 'Scratches, bottom', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      art: 'splatter', fitPlace: 'keep', note: SCRATCH_NOTE },
    { name: 'Incapacitated', label: 'Down picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false,
      stateArt: 'down', note: `${OWN_STATE} While it shows, the game moves the health bar to this picture's left edge.` },
    { name: 'DuckingIcon', label: 'Crouch icon', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: true,
      colourGate: 'Q8', stateArt: 'crouched', fitPlace: 'keep', note: OWN_STATE },
  ],
};

export const PANEL_CHILDREN: PanelChildren[] = [TEAM_PANEL, OWN_PANEL];
export const panelChildren = (panelId: string): PanelChildren | undefined => PANEL_CHILDREN.find((p) => p.panelId === panelId);
export const teamChild = (name: string): ChildDef | undefined => TEAM_PANEL.children.find((c) => c.name === name);

/** A panel's child by block name, whatever the case (KeyValues names are case-insensitive). */
export const childDef = (panelId: string, name: string): ChildDef | undefined => {
  const n = name.toLowerCase();
  return panelChildren(panelId)?.children.find((c) => c.name.toLowerCase() === n);
};

/** The registered panel whose children live in this file. */
export const panelOfFile = (file: string): PanelChildren | undefined => PANEL_CHILDREN.find((p) => p.file === file);

/** The children whose union is the fitted card. */
export const CONTENT_CHILDREN: string[] = TEAM_PANEL.children.filter((c) => c.role === 'content').map((c) => c.name);

/**
 * Square art whose base block is not square in some preset (Modern's
 * Incapacitated is 88 x 31, its Dead 120 x 31): fitPass squares these, so
 * the registry test accepts them as covered by the fit rule.
 */
export const FIT_SQUARED: readonly string[] = ['Incapacitated', 'Dead', 'Voice'];
