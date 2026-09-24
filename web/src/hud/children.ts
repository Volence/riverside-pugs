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

/**
 * When game code shows a state piece: in a survivor state, or on a condition
 * of its own. 'ability' is the infected card's ability ring: code shows it on a spawned
 * Smoker, Boomer or Tank, never a Hunter or a ghost (client.dll 0x10248700).
 */
export type StateArt = 'down' | 'dead' | 'crouched' | 'talking' | 'ghost' | 'ability';

/**
 * A file key a control writes on a child (or on an element's own
 * hudlayout.res block). Every key is checked against the strings client.dll
 * really has (dllstrings.test.ts), because a registered key can still be one
 * the game never reads: the weapons work learned that the hard way.
 */
export interface KeyDef {
  key: string; label: string; type: 'colour' | 'int' | 'bool' | 'enum';
  range?: [number, number];
  /** For an enum key: the values the file may take, in the order the control lists them, and what each is called. */
  options?: { value: string; label: string }[];
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
  /** Hidden in those infected states (a dead infected card drops its icon and bar, probe Q19). */
  hideInInfected?: ('ghost' | 'dead')[];
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
  linked?: { file: string; rule: LinkRule }[];
  /**
   * The child whose x the game draws this panel's health bar at, instead of
   * the bar's own xpos, when the file has one. client.dll's player panel
   * update (1023f5df..1023f6da) sets Health's x to the Items child's x
   * whenever the down picture is hidden, from the first update of the map;
   * probe X15 (/home/volence/l4d/hud/probe-2f/x15/RESULTS.md) saw a card bar
   * dragged alone never move in game. design.ts's drawnBarX reads it for the
   * preview, the hit tests, the fit box and the X box. Your own panel has
   * none: its Items is the build's hidden anchor at the bar's own x.
   */
  barAnchor?: string;
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
 * The card revive trap (edit.ts LINKED_X): the game draws a card's health
 * bar at the item row's x, not at its own. Probe X15
 * (/home/volence/l4d/hud/probe-2f/x15/RESULTS.md): a bar dragged alone
 * never moved in game, from the first frame of the map and after a revive;
 * moved together with the row, it stayed put through an incap and a revive.
 */
const REVIVE_LINK = "The health bar and the item icons move sideways together: the game draws a teammate's bar at the item row's left edge (from the start of the map and again after every revive), so a bar moved alone would not move in game. While a teammate is down the game draws the bar at the Down picture's left edge.";

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
  barAnchor: 'Items',
  children: [
    // Colour: drawColor tints the portrait (probe B1 S-head,
    // /home/volence/l4d/hud/probe-phase2/b1/shots/crops/card1-a.png, pink portraits).
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: true,
      hideIn: ['down', 'dead'], note: 'The colour tints the portrait: white leaves it as the game draws it.' },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      hideIn: ['dead'],
      note: REVIVE_LINK,
      keys: healthKeys('Recolours the bar and the number on every card.',
        'client.dll HealthPanel run: m_inset|inset (one HealthPanel class with the own bar, where probe Q3 proved it; B13 shows the same default inset on cards)') },
    { name: 'Name', label: 'Name', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      addable: { template: HEALTH_NUMBER, after: 'Name' }, note: 'The game colours this by health.', hideIn: ['dead'] },
    // Colour: fgcolor_override colours the icons (probe B1 S-items, card1-a.png, yellow icons).
    { name: 'Items', label: 'Item icons', kind: 'label', role: 'content', box: 'none', move: true, font: true, colour: true,
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

/**
 * Your special infected health: hunterhealth.res, which the Hunter and the
 * Tank read (probe B11, /home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-l.png),
 * with smokerhealth.res (the same geometry) and boomerhealth.res (a smaller
 * bar) following every edit through `linked`. Framed by its hudlayout.res
 * block, HudZombieHealth. Probe answers,
 * /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md:
 * - Q11 the container clips its children (b10/shots/crops/br-bce.png).
 * - Q12 the frame takes a drawColor tint and a file image
 *   (b9/shots/crops/br-bcd.png); the stock frame art is black splatter, so a
 *   tint shows only on light art.
 * - Q13 the number keeps its fgcolor_override (b9-b, b9-g, b9-j, b9-l).
 * - Q8 (probe B1 b) proved the own panel's crouch icon, the same ImagePanel
 *   use, keeps a tint.
 * The bar colour is gated on Q24, which B14 passed: monochrome_color here
 * tints the bar alone, fill and outline, and leaves the number its own
 * colour (b14/crops/si-b-zoom.png), unlike the whole own panel Q1 found. The inset is the
 * HealthPanel class's one m_inset read, which Q3 proved on that class, so it
 * is offered ungated. ModBg (Modern's fill) stays unregistered, as on the
 * own panel. The zombiehealthleft_* files are never child-edited.
 */
export const SI_PANEL: PanelChildren = {
  panelId: 'siHealth',
  file: 'resource/ui/hud/hunterhealth.res',
  repeat: 'single',
  frame: 'hudlayout',
  linked: [{ file: 'resource/ui/hud/smokerhealth.res', rule: 'same' }, { file: 'resource/ui/hud/boomerhealth.res', rule: 'delta' }],
  children: [
    { name: 'BackgroundImage', label: 'Frame', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: true, fitPlace: 'keep',
      note: 'A tint shows only on light art: the stock frame is black.' },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      keys: [
        { key: 'monochrome_color', label: 'Bar colour', type: 'colour', gate: 'Q24', evidence: MONO_EVIDENCE,
          unsetLabel: 'Game colour (by health)' },
        { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], unset: String(STOCK_BAR_INSET),
          evidence: 'client.dll HealthPanel run: m_inset|inset; probe B1 Q3 on the same class' },
      ],
      note: 'The game fills the bar by health.' },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'DuckingIcon', label: 'Crouch icon', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: true,
      stateArt: 'crouched', fitPlace: 'keep', note: 'The game shows this while you crouch.' },
  ],
};

/**
 * The ability timer's pieces (abilitytimerhud.res), framed by its
 * hudlayout.res block, CHudAbilityTimer, which the element scales with them.
 * Probe answers, /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md:
 * - Q14: code sets the backdrop's art (HUD/PZ_charge_bg) over the file's
 *   image (b9/shots/crops/br-bcd.png): its place, size and visibility are
 *   still the file's, its picture is not.
 * - Q15: the element's state colours tint the icon and the backdrop (the
 *   meter's material draws no colour, B15 b15/shots/b15/b15-e.png), so no
 *   piece takes a colour of its own here.
 * - S-ring: Progress follows a square resize (b10, Progress 30 x 30), so
 *   every piece sizes square.
 * Code picks AbilityImage's icon by class (pz_charge_lunge, _smoker,
 * _boomer, _tank).
 */
export const ABILITY_PANEL: PanelChildren = {
  panelId: 'abilityRing',
  file: 'resource/ui/hud/abilitytimerhud.res',
  repeat: 'single',
  frame: 'hudlayout',
  children: [
    { name: 'BackgroundImage', label: 'Backdrop', kind: 'image', role: 'decor', box: 'square', move: true, font: false, colour: false,
      note: 'The game picks this picture; you can move, size or hide it.' },
    { name: 'AbilityImage', label: 'Class icon', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false,
      note: 'The game picks the icon by class.' },
    { name: 'Progress', label: 'Recharge meter', kind: 'other', role: 'content', box: 'square', move: true, font: false, colour: false,
      note: 'The game fills this as your ability recharges.' },
  ],
};

/**
 * The infected teammate card (zombieteamdisplayplayer.res): one file loaded
 * for each of the three cards code makes, framed by the file's own
 * ZombieTeamDisplayPlayer block, which clips the card (probe Q17,
 * /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/bl-abe.png).
 * Probe answers, RESULTS.md in that folder:
 * - Q18 the backdrop takes drawColor and the name fgcolor_override
 *   (b9/shots/crops/bl-abeg.png: red backdrop, green name).
 * - Q19 dead: Dead shows only when given a height (code toggles its
 *   visibility, never its size; stock 0 tall), the skull draws at
 *   SkullIconPlacement, PlayerImage and HealthPanel hide
 *   (b9/shots-v2/crops/dead-card-ij.png). SpawnTimeLabel shows while a
 *   teammate waits with a spawn time (dll 0x10248606); never on your own
 *   card, so the harness never saw it.
 * - Q20 ghost: the icon is the class's ghost texture tinted by code, the bar
 *   stays, no spawn time and no ability ring (bl-abeg.png a).
 * - the ring shows alive, not a ghost, not a Hunter (dll 0x10248700).
 * The backdrop is not a splatter entry: the splatter work does not restyle
 * it, so it has only its tint here. The bar colour (Q24, passed in B14) tints
 * the bar alone, never the name or the icon (b14/crops/card-b.png); the inset is the HealthPanel class's one read.
 */
export const ZCARD_PANEL: PanelChildren = {
  panelId: 'infectedRow',
  file: 'resource/ui/hud/zombieteamdisplayplayer.res',
  repeat: 'cards',
  frame: { file: 'resource/ui/hud/zombieteamdisplayplayer.res', block: 'ZombieTeamDisplayPlayer' },
  children: [
    { name: 'BackgroundImage', label: 'Backdrop', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: true, fitPlace: 'keep',
      note: 'The game tints the stock backdrop art by this colour.' },
    { name: 'PlayerImage', label: 'Class icon', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false,
      hideInInfected: ['dead'], note: "The game picks the icon by class; a ghost's is faint." },
    { name: 'HealthPanel', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      hideInInfected: ['dead'],
      keys: [
        { key: 'monochrome_color', label: 'Bar colour', type: 'colour', gate: 'Q24', evidence: MONO_EVIDENCE,
          unsetLabel: 'Game colour (by health)' },
        { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], unset: String(STOCK_BAR_INSET),
          evidence: 'client.dll HealthPanel run: m_inset|inset; probe B1 Q3 on the same class' },
      ],
      note: 'The game fills the bar by health.' },
    { name: 'NameLabel', label: 'Name', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'SpawnTimeLabel', label: 'Spawn time', kind: 'label', role: 'state', box: 'wh', move: true, font: true, colour: true,
      stateArt: 'dead', note: "Your teammates' respawn countdown. Your own card never shows it." },
    { name: 'AbilityProgress', label: 'Ability ring', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false,
      stateArt: 'ability', note: 'Shown on a spawned Smoker, Boomer or Tank; never on a Hunter or a ghost.' },
    { name: 'Dead', label: 'Dead picture', kind: 'image', role: 'state', box: 'wh', move: true, font: false, colour: false,
      stateArt: 'dead', note: 'The stock file gives this no height, so the game never shows it; give it a height to see it.' },
    { name: 'SkullIconPlacement', label: 'Skull', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false,
      stateArt: 'dead', note: 'The game draws a skull here while that player is dead.' },
    { name: 'Voice', label: 'Voice icon', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false,
      stateArt: 'talking', note: 'Shown while that teammate talks.' },
  ],
};

/** A block's rect, as a linked rule reads it from a base file. */
export interface LinkRect { x: number; y: number; w: number; h: number }
export type LinkRule = 'same' | 'delta';

/**
 * A stored value, kept in the panel file's frame (the Hunter's for your
 * infected health, spec 3.2), as a linked file takes it (plan decision 3).
 * 'same' copies it. 'delta' moves the block by the same amount from its own
 * place (x' = x - from.x + to.x) and sizes it in proportion to its own block
 * (w' = round(w * to.w / from.w)), the same for y and h; `from` and `to` are
 * that block's rect in the panel's base file and in the linked base file.
 * A size whose `from` has none to scale from (Modern's 0 x 0 frame) is
 * kept. Anything that is not a place or a size (visible, a colour, a font
 * size, typed keys) passes through for both rules.
 */
export function linkedValue<T>(rule: LinkRule, key: string, stored: T, from: LinkRect, to: LinkRect): T | number {
  return mapLinked(rule, key, stored, from, to);
}

/** linkedValue's inverse: a value seen in the linked file, back in the panel file's frame (a drag on the Boomer preview). */
export function unlinkedValue<T>(rule: LinkRule, key: string, seen: T, from: LinkRect, to: LinkRect): T | number {
  return mapLinked(rule, key, seen, to, from);
}

function mapLinked<T>(rule: LinkRule, key: string, v: T, a: LinkRect, b: LinkRect): T | number {
  if (rule === 'same' || typeof v !== 'number') return v;
  switch (key) {
    case 'x': return v - a.x + b.x;
    case 'y': return v - a.y + b.y;
    case 'w': return a.w > 0 ? Math.round(v * b.w / a.w) : v;
    case 'h': return a.h > 0 ? Math.round(v * b.h / a.h) : v;
    default: return v;
  }
}

export const PANEL_CHILDREN: PanelChildren[] = [TEAM_PANEL, OWN_PANEL, SI_PANEL, ABILITY_PANEL, ZCARD_PANEL];
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
