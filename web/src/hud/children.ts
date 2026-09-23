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
 * renderer and the page read it. It imports nothing but a type.
 */
import type { KvNode } from './kv';

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
  /** A child some preset's file lacks: cloned from this template after `after` when turned on. */
  addable?: { template: KvNode; after: string };
  /** Shown under the child's controls. */
  note?: string;
}

export interface PanelChildren { panelId: string; file: string; children: ChildDef[] }

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

const STATE_NOTE = 'The game decides when this one shows. Pick Down or Dead above the canvas to see it.';

export const TEAM_PANEL: PanelChildren = {
  panelId: 'teamColumn',
  file: 'resource/ui/hud/teammatepanel.res',
  children: [
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false },
    { name: 'Name', label: 'Name', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      addable: { template: HEALTH_NUMBER, after: 'Name' }, note: 'The game colours this by health.' },
    { name: 'Items', label: 'Item icons', kind: 'label', role: 'content', box: 'none', move: true, font: true, colour: false,
      note: "The preview draws stand-in icons; the real ones are the game's." },
    { name: 'Status', label: 'Status text', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'BackgroundImage', label: 'Damage splatter', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: true },
    { name: 'Incapacitated', label: 'Down picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
    { name: 'Dead', label: 'Dead picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
    { name: 'Voice', label: 'Voice icon', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
  ],
};

export const PANEL_CHILDREN: PanelChildren[] = [TEAM_PANEL];
export const panelChildren = (panelId: string): PanelChildren | undefined => PANEL_CHILDREN.find((p) => p.panelId === panelId);
export const teamChild = (name: string): ChildDef | undefined => TEAM_PANEL.children.find((c) => c.name === name);

/** The children whose union is the fitted card. */
export const CONTENT_CHILDREN: string[] = TEAM_PANEL.children.filter((c) => c.role === 'content').map((c) => c.name);

/**
 * Square art whose base block is not square in some preset (Modern's
 * Incapacitated is 88 x 31, its Dead 120 x 31): fitPass squares these, so
 * the registry test accepts them as covered by the fit rule.
 */
export const FIT_SQUARED: readonly string[] = ['Incapacitated', 'Dead', 'Voice'];
