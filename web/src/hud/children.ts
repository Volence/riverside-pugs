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
  /** For a colour key: unset, the game colours it by health (healthRgb), so the control shows the three bands. */
  byHealth?: true;
  /**
   * The key can also be taken out of the file, for what the game does
   * without it: stored as '' (never a value the key takes), which the build
   * turns into removing the line. `label` names that choice beside "as the
   * file has it" (nothing stored) and a value. Only for a key the base file
   * sets whose absence the game reads differently: the Tab rows' bar, Gray in
   * both presets, which colours by health without it (probe TL3).
   */
  clear?: { label: string; evidence: string };
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
  /**
   * The whole piece waits for this probe: while it is closed the page lists
   * no such piece, a click never picks it and validateDesign drops its
   * stored edits, so the build never writes them (the Tank offer's pieces,
   * which no probe has seen drawn).
   */
  gate?: ProbeId;
  /**
   * The hide waits on this probe: while it is closed the page offers no
   * Visible control for the piece and validateDesign drops a stored
   * `visible`, so the build never writes it (the Tab screen's pieces, TS7).
   */
  hideGate?: ProbeId;
  /**
   * Pieces the game takes away with this one when it is hidden, because
   * they are pinned to it (their pin_to_sibling names it), and whatever is
   * pinned to them in turn. The design stores no hide for them: the game
   * and the preview's layout take them away with this piece, and the page
   * reads this list to say so. Only the direct pins are listed; the test
   * checks the list against both presets' pin_to_sibling keys.
   */
  hidesWith?: string[];
  /**
   * Code shows the piece whatever the file's visible says (your own Tab row's
   * background, visible 0 in both presets): the page shows it visible unless
   * the player hid it, and only a hide is written.
   */
  codeShown?: true;
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
   * The pieces sit inside the frame block (a block of the panel's own file),
   * placed relative to it and named by their path, 'Block/Child'
   * (childPath): the too-far box. Otherwise they are the file's top-level
   * blocks and the frame, if any, is a sibling or another file's block.
   */
  inFrame?: boolean;
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
  /**
   * The children each carry an if_embedded block whose keys the game reads
   * over their plain keys when the panel is embedded in another (the versus
   * score panel inside the Tab screen, tab screen spec 1.6). The build writes
   * a key into if_embedded when that block already has it, and into the
   * plain block otherwise (spec 4.4); the preview reads the plain keys with
   * the if_embedded ones over them.
   */
  embedded?: true;
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
    unsetLabel: 'Game colour (by health)', byHealth: true },
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
    { name: 'Voice', label: 'Voice icon', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false,
      note: 'Shown when a teammate talks; not seen in our tests (needs a second player). Its picture can be uploaded on Your microphone.',
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
          unsetLabel: 'Game colour (by health)', byHealth: true },
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
          unsetLabel: 'Game colour (by health)', byHealth: true },
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

/**
 * The use / revive bar's pieces (progressbar.res; Modern ships none, so both
 * presets read the stock file), framed by its hudlayout.res block,
 * HudProgressBar, which the element scales with them. Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - P1, P2: BarLabel's fgcolor_override and font are honoured
 *   (r1/shots/crops/bar-e.png: magenta "HEALING YOURSELF" in DefaultLarge).
 * - P3: AwardIcon moves and sizes (r1/shots/crops/bar-e-icon.png: x 232,
 *   40 x 40); code picks its icon by action.
 * - Q22 (/home/volence/l4d/hud/probe-phase2/RESULTS.md, b1v2): every Bar key
 *   is honoured, and a border and gap that leave no room draw the border
 *   alone, so the editor keeps them inside progress.ts clampBarKeys.
 * - P4: a self heal leaves Subtext empty; V1a saw it while bots revived the
 *   player, its colour honoured (magenta "Your savior: Louis",
 *   /home/volence/l4d/hud/probe-phase2-rest/v1/crops/v1a-s-a-bar.png).
 */
const BAR_KEY = (key: string, label: string, type: 'colour' | 'int'): KeyDef => (type === 'colour'
  ? { key, label, type, unsetLabel: 'File colour', evidence: `client.dll progress bar run: ${key}; probe Q22 (probe-phase2/b1v2/shots/b1/b1-d.png)` }
  : { key, label, type, range: [0, 8], evidence: `client.dll progress bar run: ${key}; probe Q22 (probe-phase2/b1v2/shots/b1/b1-d.png)` });
export const PROGRESS_PANEL: PanelChildren = {
  panelId: 'progressBar',
  file: 'resource/ui/hud/progressbar.res',
  repeat: 'single',
  frame: 'hudlayout',
  children: [
    { name: 'BarLabel', label: 'Label', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      note: 'The game writes what you are doing here: healing, reviving, pouring.' },
    { name: 'Bar', label: 'Bar', kind: 'other', role: 'content', box: 'wh', move: true, font: false, colour: false,
      keys: [
        BAR_KEY('fill_color', 'Fill colour', 'colour'), BAR_KEY('empty_color', 'Empty colour', 'colour'),
        BAR_KEY('border_color', 'Border colour', 'colour'), BAR_KEY('shadow_color', 'Shadow colour', 'colour'),
        BAR_KEY('gap', 'Gap', 'int'), BAR_KEY('border_thickness', 'Border', 'int'), BAR_KEY('shadow_thickness', 'Shadow', 'int'),
      ],
      note: 'The game fills the bar as the action goes. A border and gap too thick for the bar are cut so a line of fill stays.' },
    { name: 'AwardIcon', label: 'Icon', kind: 'other', role: 'content', box: 'square', move: true, font: false, colour: false,
      note: 'The game picks healing or reviving.' },
    { name: 'Subtext', label: 'Subtext', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      note: 'Shows a name when someone heals or revives you, such as "Your savior: Louis".' },
  ],
};

/**
 * The spawn (ghost) panel's pieces (hudghostpanel.res; stock and Modern
 * each ship one), framed by its hudlayout.res block, HudGhostPanel, which
 * the element scales with them. Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - G1: the element's WhiteText and RedText colour the status lines
 *   (r3/shots/r3/r3-a.png: cyan class name and "Choose Spawn Location",
 *   yellow "Can't spawn here"), so those two keys are the colour controls
 *   (elements.ts ghostPanel).
 * - G2: a line's own fgcolor_override is ignored (r3-a: SelectSpawn stayed
 *   WhiteText), so no line offers a colour of its own (plan decision 7).
 * - G3: a line moves and takes a font (r3-a: ClassName at x 150 in
 *   DefaultLarge); G4: ClassImage moves and sizes (r3-a: 240, 20, 60 x 60).
 * - Q21 (/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md):
 *   Background's bgcolor_override is honoured.
 */
const GHOST_LINE = "Coloured by the panel's Text and Warning colours (select the panel itself); a colour of its own is ignored by the game.";
const ghostLine = (name: string, label: string, note: string): ChildDef =>
  ({ name, label, kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false, note: `${note} ${GHOST_LINE}` });
export const GHOST_PANEL: PanelChildren = {
  panelId: 'ghostPanel',
  file: 'resource/ui/hudghostpanel.res',
  repeat: 'single',
  frame: 'hudlayout',
  children: [
    { name: 'Background', label: 'Background', kind: 'other', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      keys: [{ key: 'bgcolor_override', label: 'Background colour', type: 'colour', unsetLabel: 'File colour',
        evidence: 'VGUI Panel key bgcolor_override (client.dll string run); probe Q21, probe-phase2-infected/RESULTS.md' }] },
    { name: 'ClassImage', label: 'Class picture', kind: 'other', role: 'content', box: 'square', move: true, font: false, colour: false,
      note: 'The game picks the picture by class.' },
    ghostLine('ClassName', 'Class name', 'The game writes the class you will spawn as.'),
    ghostLine('SelectSpawn', 'Title', 'Reads "Choose Spawn Location".'),
    ghostLine('Ready', 'Status', 'Ready to spawn, or why you cannot spawn here (in the Warning colour).'),
    ghostLine('Info', 'Detail', 'The reason under the status, in the Warning colour.'),
    ghostLine('SpawnLabel', 'Press to play', 'Shown once you can spawn, beside the button to press.'),
    { name: 'SpawnBind', label: 'Button', kind: 'other', role: 'content', box: 'none', move: true, font: false, colour: false,
      note: 'The key or mouse button to press; the game draws it.' },
  ],
};

/**
 * A child's path in its file. Pieces nested inside another block of the
 * file are named by the path, 'Block/Child' (zombiepanel.res holds its
 * too-far pieces inside TooFarFromSurvivors and the Tank offer's inside
 * TankTakeover, each with its own Background); every other name is one
 * top-level block.
 */
export const childPath = (name: string): string[] => name.split('/');

/**
 * The too-far and Tank offer panel's pieces (zombiepanel.res; stock and
 * Modern each ship one), framed by the too-far box inside it. Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, R6 (a spawned Smoker
 * culled far from the survivors, r6/shots/r6/r6-a.png):
 * - Z2: TooFarTitle's fgcolor_override is honoured (magenta).
 * - Z4: the too-far Background's bgcolor_override is honoured (navy).
 * - TooFarText has no xpos or wide: code draws it after the key (r6-a), so
 *   it offers a colour only. Its font, and the picture's place, are the
 *   plain Label and CIconPanel keys proven on the spawn panel (G3, G4).
 * - Z3: the Tank offer box was not seen in R3, R5, R6; V1b drew it on demand
 *   (debug_zombie_panel 1) with the title, text and box colours written
 *   (/home/volence/l4d/hud/probe-phase2-rest/v1/crops/v1b-tank-offer.png),
 *   so gate Z3 passed. The preview still draws the too-far box only.
 */
const TANK_OFFER = 'Shown when you are offered the Tank. The preview draws the too-far box only, so this shows in the game, not on the canvas.';
export const ZPANEL_PANEL: PanelChildren = {
  panelId: 'zombiePanel',
  file: 'resource/ui/zombiepanel.res',
  repeat: 'single',
  frame: { file: 'resource/ui/zombiepanel.res', block: 'TooFarFromSurvivors' },
  inFrame: true,
  children: [
    { name: 'TooFarFromSurvivors/TooFarTitle', label: 'Title', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      note: 'Reads "TOO FAR FROM THE SURVIVORS".' },
    { name: 'TooFarFromSurvivors/TooFarText', label: 'Line', kind: 'label', role: 'content', box: 'none', move: false, font: false, colour: true,
      note: 'The game places this line after the key to press.' },
    { name: 'TooFarFromSurvivors/SurvivorsImage', label: 'Picture', kind: 'other', role: 'content', box: 'square', move: true, font: false, colour: false,
      note: 'The game draws your class here.' },
    { name: 'TooFarFromSurvivors/Background', label: 'Background', kind: 'other', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      keys: [{ key: 'bgcolor_override', label: 'Background colour', type: 'colour', unsetLabel: 'File colour',
        evidence: 'VGUI Panel key bgcolor_override (client.dll string run); probe Z4, probe-phase2-rest/r6/shots/crops/toofar-a.png (navy)' }] },
    { name: 'TankTakeover/Title', label: 'Tank offer title', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      gate: 'Z3', note: TANK_OFFER },
    { name: 'TankTakeover/Text', label: 'Tank offer text', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      gate: 'Z3', note: TANK_OFFER },
    { name: 'TankTakeover/TankImage', label: 'Tank offer picture', kind: 'other', role: 'content', box: 'square', move: true, font: false, colour: false,
      gate: 'Z3', note: TANK_OFFER },
    { name: 'TankTakeover/Background', label: 'Tank offer background', kind: 'other', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      gate: 'Z3', note: TANK_OFFER,
      keys: [{ key: 'bgcolor_override', label: 'Background colour', type: 'colour', unsetLabel: 'File colour', gate: 'Z3',
        evidence: 'VGUI Panel key bgcolor_override (client.dll string run); the too-far box honours it (Z4); the Tank offer box was never seen' }] },
  ],
};

/**
 * The Tank frustration meter's pieces (frustrationmeter.res; Modern ships
 * none, so both presets read the stock file), framed by its hudlayout.res
 * block, HudFrustrationMeter. R3, R6 and probe-2f never saw it; V1d did,
 * with every key written honoured, east_aligned against the stock control
 * (/home/volence/l4d/hud/probe-phase2-rest/v1/crops/v1d-frustration-a.png,
 * v1d-frustration-d.png, v1f-frustration-stock-d.png), so gate T1 passed.
 */
const FRUST_LINE = (name: string, label: string): ChildDef =>
  ({ name, label, kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true, gate: 'T1' });
export const FRUST_PANEL: PanelChildren = {
  panelId: 'tankPanel',
  file: 'resource/ui/hud/frustrationmeter.res',
  repeat: 'single',
  frame: 'hudlayout',
  children: [
    FRUST_LINE('Countdown', 'Title'),
    FRUST_LINE('Warning', 'Warning'),
    FRUST_LINE('Warning2', 'Warning, second line'),
    { name: 'FrustrationBar', label: 'Bar', kind: 'other', role: 'content', box: 'wh', move: true, font: false, colour: false, gate: 'T1',
      keys: [{ key: 'east_aligned', label: 'Fill from the right', type: 'bool', gate: 'T1',
        evidence: 'client.dll CFrustrationMeterBarPanel run: east_aligned; stock frustrationmeter.res FrustrationBar "east_aligned" "1"' }] },
    FRUST_LINE('FrustrationLabel', 'Label'),
  ],
};

/**
 * The Tab screen's pieces: the scoreboard dialog, the versus score panel and
 * the two kinds of row, one panel each, the panelId being the element's
 * (elements.ts). The evidence is the tab screen spec
 * (docs/superpowers/specs/2026-09-25-hud-editor-tab-screen-design.md,
 * section 1), and the probe answers its section 7 and
 * /home/volence/l4d/hud/probe-tab/RESULTS.md (shots under tabN/runs/ there):
 * - Open on tonight's shots: the backdrop colour (Modern's 0 0 0 200 drew
 *   lighter; TAB-1 navy), your survivor row colour (stock's 140 0 0 read
 *   141 0 0; TAB-1 green), the versus label colours (Modern's ModText amounts
 *   read 236; TAB-1 yellow "Your Team", magenta "1%").
 * - TS1 the title colour, TS3 the row bars, TS5 your infected row, TS6 the
 *   infected names, TS7 the hides: passed. TS5b (the other infected rows)
 *   was never on screen and stays closed.
 * - Code colours the versus scores (TS2 failed: grey whatever the file says)
 *   and the survivor names (white whatever the file says), so neither
 *   offers a colour.
 * In v1 no piece moves, sizes or changes its text size (spec 2.1): every one
 * is move false, box none, font false, its hide behind TS7. The build must
 * find each block as the PC game does (kv.ts pcFind): scoreboard.res's
 * BackgroundImage [$X360] comes before the PC one.
 */
const TAB_HIDE = { move: false, box: 'none', font: false, hideGate: 'TS7' } as const;
const PANEL_BG = 'VGUI Panel key bgcolor_override (client.dll string run)';

export const TAB_BOARD: PanelChildren = {
  panelId: 'tabBoard',
  file: 'resource/ui/scoreboard.res',
  repeat: 'single',
  frame: 'hudlayout',
  children: [
    { name: 'BackgroundImage', label: 'Backdrop', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE,
      keys: [{ key: 'bgcolor_override', label: 'Backdrop colour', type: 'colour', unsetLabel: 'File colour',
        evidence: `${PANEL_BG}; Modern's 0 0 0 200 draws lighter than stock's 0 0 0 230 (tab screen spec 1.2); TAB-1 navy (probe-tab tab1/runs/tab-survivor/tab-a.png)` }],
      note: 'The dark panel behind the list. Opacity 0 leaves no backdrop; the game still draws the rows.' },
    { name: 'MissionTitle', label: 'Title', kind: 'label', role: 'content', colour: true, colourGate: 'TS1', ...TAB_HIDE,
      note: 'The game writes the campaign and the mode here, such as "No Mercy, Versus Mode".' },
  ],
};

const BOX_NOTE = 'The game draws this box from its picture and takes no tint, so its look is its style.';
const SCORE_NOTE = 'The game writes the score here and colours it itself: a file colour is ignored (probe TS2).';
export const TAB_VERSUS: PanelChildren = {
  panelId: 'tabVersus',
  file: 'resource/ui/versusmodescoreboard.res',
  repeat: 'single',
  frame: 'hudlayout',
  embedded: true,
  children: [
    { name: 'YourTeamHighlightImage', label: 'Team score box', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE,
      note: `${BOX_NOTE} The game shows one team's box at a time.` },
    { name: 'EnemyTeamHighlightImage', label: 'Enemy team box', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE,
      note: `${BOX_NOTE} It shares the team score box's style; the game shows it in place of yours.` },
    { name: 'StatBreakdownHighlightImage', label: 'Versus score box', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE, note: BOX_NOTE },
    { name: 'TeamYours', label: '"Your Team"', kind: 'label', role: 'content', colour: true, ...TAB_HIDE },
    { name: 'TeamEnemy', label: '"Enemy Team"', kind: 'label', role: 'content', colour: true, ...TAB_HIDE },
    { name: 'TeamYourScoreSurvivors', label: 'Your score', kind: 'label', role: 'content', colour: false, ...TAB_HIDE, note: SCORE_NOTE },
    { name: 'TeamEnemyScoreSurvivors', label: 'Enemy score', kind: 'label', role: 'content', colour: false, ...TAB_HIDE,
      note: `${SCORE_NOTE} "N/A" is a half not played yet.` },
    // The stat line is a pin chain (versusmodescoreboard.res pin_to_sibling,
    // stock and Modern alike): DistanceAmount is pinned to DistanceLabel,
    // HealthLabel to DistanceAmount, HealthAmount to HealthLabel, and
    // SurvivalMultAmount to SurvivalMultLabel. Hiding a piece hides every
    // piece pinned to it, directly or down the chain (hidesWith). Only the
    // HealthLabel link was seen in game (TS7, /home/volence/l4d/hud/probe-tab/RESULTS.md,
    // TAB-1 tab1/runs/tab-survivor/tab-a.png: the label hidden, HealthAmount
    // gone too); the other links follow from the same pin behaviour.
    { name: 'DistanceLabel', label: '"Average Distance:"', kind: 'label', role: 'content', colour: true, ...TAB_HIDE, hidesWith: ['DistanceAmount'],
      note: 'The rest of the line follows this label: the game places each piece after the one before it, so hiding it hides the whole line.' },
    { name: 'DistanceAmount', label: 'Distance', kind: 'label', role: 'content', colour: true, ...TAB_HIDE, hidesWith: ['HealthLabel'],
      note: 'Hiding it hides Health Bonus and its number too: the game places them after it.' },
    { name: 'HealthLabel', label: '"Health Bonus:"', kind: 'label', role: 'content', colour: true, ...TAB_HIDE, hidesWith: ['HealthAmount'],
      note: 'Hiding it hides its number too: the game places the number after it.' },
    { name: 'HealthAmount', label: 'Health bonus', kind: 'label', role: 'content', colour: true, ...TAB_HIDE },
    { name: 'SurvivalMultLabel', label: '"Survival Multiplier:"', kind: 'label', role: 'content', colour: true, ...TAB_HIDE, hidesWith: ['SurvivalMultAmount'],
      note: 'The game shows this line only later in a round. Hiding it hides its number too.' },
    { name: 'SurvivalMultAmount', label: 'Survival multiplier', kind: 'label', role: 'content', colour: true, ...TAB_HIDE,
      note: 'The game shows this line only later in a round.' },
  ],
};

const NAME_WHITE = 'The game draws the names white whatever the file says (probe TS6).';
export const TAB_SURVIVOR_ROW: PanelChildren = {
  panelId: 'tabSurvivors',
  file: 'resource/ui/scoreboardsurvivor.res',
  repeat: 'cards',
  children: [
    { name: 'PlayerBackground', label: 'Teammate row', kind: 'image', role: 'decor', colour: false, ...TAB_HIDE,
      note: "Your teammates' rows. Its look is its style: the stock fade, a flat colour or a picture." },
    { name: 'PlayerBackground_Selected', label: 'Your row', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE, codeShown: true,
      keys: [{ key: 'bgcolor_override', label: 'Your row colour', type: 'colour', unsetLabel: 'File colour',
        evidence: `${PANEL_BG}; stock's 140 0 0 255 reads 141 0 0 on your row (tab screen spec 1.5); TAB-1 green (probe-tab tab1/runs/tab-survivor/tab-a.png)` }],
      note: 'The game shows this on your own row only.' },
    { name: 'SurvivorStatsHealth', label: 'Health bar', kind: 'bar', role: 'content', colour: false, ...TAB_HIDE,
      keys: [{ key: 'monochrome_color', label: 'Row bars', type: 'colour', gate: 'TS3', byHealth: true,
        evidence: `${MONO_EVIDENCE}; probe TS3, probe-tab tab1/runs/tab-survivor/tab-a.png (every bar red, at full, at 40 and down)`,
        clear: { label: 'By health', evidence: 'probe TL3, probe-tab tab2/runs/tab-survivor/tab-a.png: without monochrome_color the bars are green at full, orange hurt, red down' },
        note: 'Grey as the file has it, the game\'s health colours, or one colour at every health.' }],
      note: 'The game fills the bar by health.' },
    { name: 'SurvivorStatsName', label: 'Your name', kind: 'label', role: 'content', colour: false, ...TAB_HIDE,
      note: `Shown on a player's row, beside the Steam picture. ${NAME_WHITE}` },
    { name: 'SurvivorStatsNoAvatarName', label: 'Bot name', kind: 'label', role: 'content', colour: false, ...TAB_HIDE,
      note: `Shown on a bot's row, which has no Steam picture. ${NAME_WHITE}` },
    { name: 'PingImage', label: 'Ping bars', kind: 'label', role: 'content', colour: false, ...TAB_HIDE,
      note: 'Shown for players only; the game draws the bars.' },
    { name: 'PingLabel', label: 'Ping', kind: 'label', role: 'content', colour: false, ...TAB_HIDE,
      note: 'Shown for players only; the game writes the number.' },
  ],
};

export const TAB_INFECTED_ROW: PanelChildren = {
  panelId: 'tabInfected',
  file: 'resource/ui/scoreboardinfectedplayer.res',
  repeat: 'cards',
  children: [
    { name: 'PlayerBackground', label: 'Other rows', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE,
      keys: [{ key: 'bgcolor_override', label: "Other rows' colour", type: 'colour', unsetLabel: 'File colour', gate: 'TS5b',
        evidence: `${PANEL_BG}; the other infected rows were never on screen (probe TS5b needs a second infected player)` }] },
    { name: 'PlayerBackground_Selected', label: 'Your row', kind: 'other', role: 'decor', colour: false, ...TAB_HIDE, codeShown: true,
      keys: [{ key: 'bgcolor_override', label: 'Your row colour', type: 'colour', unsetLabel: 'File colour', gate: 'TS5',
        evidence: `${PANEL_BG}; probe TS5, probe-tab tab1/runs/tab-infected/tab-c.png (your row yellow)` }],
      note: 'The game shows this on your own row only.' },
    { name: 'Name', label: 'Player name', kind: 'label', role: 'content', colour: true, colourGate: 'TS6', ...TAB_HIDE,
      note: "Shown on a player's row, beside the Steam picture." },
    { name: 'NoAvatarName', label: 'Bot name', kind: 'label', role: 'content', colour: true, colourGate: 'TS6', ...TAB_HIDE,
      note: "Shown on a bot's row, which has no Steam picture." },
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

/**
 * The Tab screen's files: the four panels' and scoreboard.res, which places
 * them. Every read and write of one finds its blocks as the PC game does
 * (kv.ts pcFind), since scoreboard.res puts console-only blocks first
 * (BackgroundImage [$X360] before the PC's [$WIN32]). Other files keep
 * kvFind (tab screen spec 4.4: switching every caller is its own change).
 */
export const TAB_FILES: ReadonlySet<string> = new Set(['resource/ui/scoreboard.res',
  ...[TAB_BOARD, TAB_VERSUS, TAB_SURVIVOR_ROW, TAB_INFECTED_ROW].map((p) => p.file)]);

export const PANEL_CHILDREN: PanelChildren[] = [TEAM_PANEL, OWN_PANEL, SI_PANEL, ABILITY_PANEL, ZCARD_PANEL, PROGRESS_PANEL, GHOST_PANEL, ZPANEL_PANEL, FRUST_PANEL,
  TAB_BOARD, TAB_VERSUS, TAB_SURVIVOR_ROW, TAB_INFECTED_ROW];
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
