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

import type { KeyDef } from './children';

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
  mockSize?: Partial<Record<'stock' | 'modern', { w: number; h: number }>>;
  /** Elements the game places itself (move: false): where the preview draws them, as position tokens. */
  mockPos?: { x: string; y: string };
  props: Prop[];
  /** Keys of the element's own hudlayout.res block the game reads (slice 2.3 fills them). */
  keys?: KeyDef[];
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
  /**
   * The game's real kill/incap feed: CHudPZDamageRecordPanel, whose
   * hudlayout panel is HudPZDamageRecord (stock and Modern share the same
   * numbers: xpos 10, ypos 170, wide f20, tall 75). Its rows
   * (recordlabel0..4 in resource/ui/hud/pzdamagerecordpanel.res) are filled
   * in by game code, not by any base file, so it carries no children entry
   * here; mock.ts reads that file's own numbers straight through buildTrees
   * for the preview instead.
   */
  { id: 'killNotices', label: 'Kill / incap notices', side: 'both', key: 'HudPZDamageRecord', move: true, resize: 'free',
    children: [], props: ['visible'] },
  { id: 'xhair', label: 'Custom crosshair', side: 'both', key: 'xHair', move: false, resize: 'none', children: [], props: [] },
  { id: 'infectedRow', label: 'Infected teammates', side: 'infected', key: 'CHudZombieTeamDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/zombieteamdisplayplayer.res'],
    team: { file: null, dirs: ['row'], spacingKey: 'HorizPanelSpacing' },
    mockSize: { stock: { w: 430, h: 75 }, modern: { w: 380, h: 31 } }, props: ['visible'] },
  { id: 'siHealth', label: 'Your infected health', side: 'infected', key: 'HudZombieHealth', move: true, resize: 'scale',
    children: SI_HEALTH, props: ['visible'] },
  /**
   * The ability timer. A scale reaches its three pieces (abilitytimerhud.res),
   * and its 80 x 70 block keeps clipping the 80 x 80 backdrop's bottom 10
   * units, as the game does. Its three state colours tint the icon and the
   * backdrop (probe Q15, /home/volence/l4d/hud/probe-phase2-infected/b9/shots/crops/br-bcd.png);
   * the meter's material draws no colour (B15, b15/shots/b15/b15-e.png). The
   * suppressed one was never seen drawn.
   */
  { id: 'abilityRing', label: 'Ability timer', side: 'infected', key: 'CHudAbilityTimer', move: true, resize: 'scale',
    children: ['resource/ui/hud/abilitytimerhud.res'], props: ['visible'],
    keys: [
      { key: 'ability_ready_color', label: 'Ready colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudAbilityTimer run: ability_ready_color; b10/shots/crops/ring-all.png, b9/shots/crops/br-bcd.png (magenta when ready)' },
      { key: 'ability_charging_color', label: 'Charging colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudAbilityTimer run: ability_charging_color; b10/shots/crops/ring-all.png, b9/shots/crops/br-bcd.png (cyan while charging)',
        note: 'Shown while the ability is not ready (a standing Hunter) and while the meter refills. The meter itself keeps its own red.' },
      { key: 'ability_surpressed_color', label: 'Suppressed colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudAbilityTimer run: ability_surpressed_color (the game\'s spelling)',
        note: 'Rarely shown: no probe produced the suppressed state.' },
    ] },
  /**
   * The ring round the infected crosshair: HudCrosshair's own child
   * AbilityProgress, a CircularProgressBar code gives HUD/PZ_charge_crosshair
   * (client.dll 0x10240e55). Probe Q16a
   * (/home/volence/l4d/hud/probe-phase2-infected/b9/shots-v2/crops/centre-af.png):
   * its size and colours are HudCrosshair's ability keys, ability_size is
   * plain screen pixels (the dll reads it as int, not proportional_int), and
   * it draws only with the crosshair cvar on. The game centres it, so it
   * does not move; hiding it writes a 0 size and clear colours, never a hard
   * hide of HudCrosshair, which would remove the crosshair too (build.ts
   * markerHide). The attack colours need a survivor in reach and the
   * suppressed one was never produced; the dll proves each is read.
   */
  { id: 'abilityMarker', label: 'Ability marker', side: 'infected', key: 'HudCrosshair', move: false, resize: 'none',
    children: [], mockPos: { x: 'c', y: 'c' }, props: ['visible'],
    keys: [
      { key: 'ability_size', label: 'Size (pixels)', type: 'int', range: [4, 64],
        evidence: 'client.dll CHudTerrorCrosshair run: m_abilitySize|ability_size (int); b9/shots-v2/crops/centre-af.png (size 40: a 72 px ring)' },
      { key: 'ability_ready_color', label: 'Ready colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudTerrorCrosshair run: ability_ready_color; b9/shots-v2/crops/centre-af.png (green when ready)' },
      { key: 'ability_charging_color', label: 'Charging colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudTerrorCrosshair run: ability_charging_color' },
      { key: 'ability_surpressed_color', label: 'Suppressed colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudTerrorCrosshair run: ability_surpressed_color (the game\'s spelling)',
        note: 'Rarely shown: no probe produced the suppressed state.' },
      { key: 'ability_attack_color', label: 'Attack colour', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudTerrorCrosshair run: m_abilityShouldAttack|ability_attack_color',
        note: 'Shown when a survivor is in reach.' },
      { key: 'ability_attack_color_colorblind', label: 'Attack colour (colour-blind mode)', type: 'colour', unsetLabel: 'Game colour',
        evidence: 'client.dll CHudTerrorCrosshair run: m_abilityShouldAttack_ColorBlind|ability_attack_color_colorblind',
        note: 'The colour-blind variant of the attack colour.' },
    ] },
  { id: 'ghostPanel', label: 'Spawn / ghost panel', side: 'infected', key: 'HudGhostPanel', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'tankPanel', label: 'Tank frustration', side: 'infected', key: 'HudFrustrationMeter', move: true, resize: 'none',
    children: [], props: ['visible'] },
];
export const elementById = (id: string) => ELEMENTS.find((e) => e.id === id);
