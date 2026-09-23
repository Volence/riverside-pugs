/**
 * The one toolbar above the canvas: history, what is previewed (side, card
 * state, backdrop), what the design is built on (preset, aspect, font), and
 * Download on the right. The existing controls, gathered in one place.
 */
import { Tabs } from '../../components/bits';
import type { Backdrop } from '../../crosshair/draw';
import type { HudDesign } from '../../hud/design';
import type { Aspect } from '../../hud/units';
import type { Side } from '../../hud/mock';
import type { CardState } from '../../hud/render';
import type { WeaponHeld } from '../../hud/weapons';
import type { Preset } from '../../hud/base';

const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'], ['shot', 'My screenshot'],
];

const CARD_STATES: { key: CardState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];

/** What the preview survivor holds: the game moves the weapon numbers when this changes. */
const HELD: { key: WeaponHeld; label: string }[] = [
  { key: 'primary', label: 'Gun' }, { key: 'pistol', label: 'Pistol' }, { key: 'item', label: 'Item' },
];

export interface ToolbarProps {
  design: HudDesign; side: Side; cardState: CardState; held: WeaponHeld; backdrop: Backdrop; shotError?: string;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  onSide: (s: Side) => void; onState: (s: CardState) => void; onHeld: (h: WeaponHeld) => void;
  onPreset: (p: Preset) => void; onAspect: (a: Aspect) => void; onBackdrop: (b: Backdrop) => void;
  onShot: (e: Event) => void; onFont: (f: 'preset' | 'roboto') => void; onDownload: () => void;
}

export function Toolbar(p: ToolbarProps) {
  const { design } = p;
  return (
    <div class="hud__toolbar">
      <button type="button" class="btn btn--ghost btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}>
        ↶ Undo
      </button>
      <button type="button" class="btn btn--ghost btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!p.canRedo} onClick={p.onRedo}>
        ↷ Redo
      </button>
      <span class="hud__tbsep" aria-hidden="true" />

      <Tabs
        tabs={[{ key: 'survivor', label: 'Survivor' }, { key: 'infected', label: 'Infected' }]}
        active={p.side} onSelect={(k) => p.onSide(k as Side)}
      />
      {p.side === 'survivor' && (
        <Tabs tabs={CARD_STATES.map((s) => ({ key: s.key, label: s.label }))} active={p.cardState} onSelect={(k) => p.onState(k as CardState)} />
      )}
      {p.side === 'survivor' && (
        <Tabs label="Holding" tabs={HELD} active={p.held} onSelect={(k) => p.onHeld(k as WeaponHeld)} />
      )}
      <span class="hud__tbsep" aria-hidden="true" />

      <label>
        Preset{' '}
        <select value={design.preset} onChange={(e) => p.onPreset((e.target as HTMLSelectElement).value as Preset)}>
          <option value="stock">Stock</option>
          <option value="modern">Modern</option>
        </select>
      </label>
      <label>
        Aspect{' '}
        <select value={design.aspect} onChange={(e) => p.onAspect((e.target as HTMLSelectElement).value as Aspect)}>
          <option value="16:9">16:9</option>
          <option value="16:10">16:10</option>
          <option value="4:3">4:3</option>
        </select>
      </label>
      <label>
        Backdrop{' '}
        <select value={p.backdrop} onChange={(e) => p.onBackdrop((e.target as HTMLSelectElement).value as Backdrop)}>
          {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {p.backdrop === 'shot' && (
        <label class="hud__file hud__file--inline">
          <span class="btn btn--ghost btn--sm">Load screenshot</span>
          <input type="file" accept="image/*" aria-label="Load a screenshot for the backdrop" onChange={p.onShot} />
        </label>
      )}
      {p.backdrop === 'shot' && p.shotError && <span class="error">{p.shotError}</span>}
      <label>
        Font{' '}
        <select
          value={design.font} disabled={design.preset === 'modern'}
          onChange={(e) => p.onFont((e.target as HTMLSelectElement).value as 'preset' | 'roboto')}
        >
          <option value="preset">Preset default</option>
          <option value="roboto">Roboto Condensed</option>
        </select>
      </label>
      {design.preset === 'modern' && <span class="muted hud__note">Modern already uses Roboto Condensed.</span>}

      <button type="button" class="btn btn--sm hud__download" onClick={p.onDownload}>
        {design.advanced ? 'Download .zip' : 'Download .vpk'}
      </button>
    </div>
  );
}
