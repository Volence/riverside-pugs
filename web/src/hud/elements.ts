/**
 * The HUD element registry.
 *
 * One table drives three things at once: the canvas preview draws each
 * element where its `mockPos`/`mockSize` or the real .res file puts it, the
 * side panel builds its controls from `props`, `move` and `resize`, and the
 * generator rewrites `key` (and every file in `children`) to match. Getting
 * an entry wrong here means a typo lands in a player's game, not just this
 * editor, so `elements.test.ts` checks every `key` and `children` path
 * against the real base files.
 */
import type { Preset } from './base';

/**
 * Only 'visible' is live in v1. 'color', 'bg' and 'fontSize' are the reserved
 * ElementOverride fields design.ts validates: every entry below lists
 * ['visible'] or [], no pass in build.ts reads them, and the side panel
 * therefore offers nothing but the Visible checkbox.
 */
export type Prop = 'visible' | 'color' | 'bg' | 'fontSize';

export interface HudElement {
  id: string; label: string;
  side: 'survivor' | 'infected' | 'both';
  /** The hudlayout.res panel that places it. */
  key: string;
  move: boolean;
  resize: 'free' | 'scale' | 'none';
  /** resource/ui files whose contents scale with it. */
  children: string[];
  /** Team displays: how teammate panels are laid out. */
  team?: { file: string | null; dirs: ('row' | 'column')[]; spacingKey?: string };
  /** Size used for hit-testing and the mock when the container is bigger than what it shows. */
  mockSize?: Partial<Record<Preset, { w: number; h: number }>>;
  /** Elements the game places itself (move: false): where the preview draws them, as position tokens. */
  mockPos?: { x: string; y: string };
  props: Prop[];
}

/**
 * The special infected health files the game reads. The Tank reads
 * hunterhealth.res (probe T1), so tankhealth.res is never loaded and is not
 * listed: scaling it only shipped a file the game ignores.
 */
const SI_HEALTH = ['boomerhealth', 'hunterhealth', 'smokerhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']
  .map((n) => `resource/ui/hud/${n}.res`);

export const ELEMENTS: HudElement[] = [
  { id: 'ownHealth', label: 'Your health', side: 'survivor', key: 'CHudLocalPlayerDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/localplayerdisplay.res', 'resource/ui/hud/localplayerpanel.res'],
    mockSize: { stock: { w: 125, h: 91 } }, props: ['visible'] },
  { id: 'teamColumn', label: 'Teammates', side: 'survivor', key: 'CHudTeamDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/teammatepanel.res'],
    team: { file: 'resource/ui/hud/teamdisplayhud.res', dirs: ['row', 'column'] },
    mockSize: { stock: { w: 430, h: 75 }, modern: { w: 120, h: 100 } }, props: ['visible'] },
  { id: 'weaponSelection', label: 'Weapons', side: 'survivor', key: 'HudWeaponSelection', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'chat', label: 'Chat', side: 'both', key: 'HudChat', move: true, resize: 'free', children: [], props: ['visible'] },
  { id: 'progressBar', label: 'Use / revive bar', side: 'both', key: 'HudProgressBar', move: true, resize: 'none',
    children: [], mockSize: { stock: { w: 228, h: 24 }, modern: { w: 228, h: 24 } }, props: ['visible'] },
  { id: 'xhair', label: 'Custom crosshair', side: 'both', key: 'xHair', move: false, resize: 'none', children: [], props: [] },
  { id: 'infectedRow', label: 'Infected teammates', side: 'infected', key: 'CHudZombieTeamDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/zombieteamdisplayplayer.res'],
    team: { file: null, dirs: ['row'], spacingKey: 'HorizPanelSpacing' },
    mockSize: { stock: { w: 430, h: 75 }, modern: { w: 380, h: 31 } }, props: ['visible'] },
  { id: 'siHealth', label: 'Your infected health', side: 'infected', key: 'HudZombieHealth', move: true, resize: 'scale',
    children: SI_HEALTH, props: ['visible'] },
  { id: 'abilityRing', label: 'Ability timer', side: 'infected', key: 'CHudAbilityTimer', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'ghostPanel', label: 'Spawn / ghost panel', side: 'infected', key: 'HudGhostPanel', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'tankPanel', label: 'Tank frustration', side: 'infected', key: 'HudFrustrationMeter', move: true, resize: 'none',
    children: [], props: ['visible'] },
];
export const elementById = (id: string) => ELEMENTS.find((e) => e.id === id);
