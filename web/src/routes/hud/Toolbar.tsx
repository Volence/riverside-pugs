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
import { useRef, useState } from 'preact/hooks';

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

/** What the Preset select can switch to: a built-in preset, or one of this browser's imports. */
export type PresetChoice = 'stock' | 'modern' | { id: string };

const presetValue = (d: HudDesign) => (d.preset === 'imported' && d.imported ? `imported:${d.imported.id}` : d.preset);

export interface ToolbarProps {
  design: HudDesign; side: Side; cardState: CardState; held: WeaponHeld; backdrop: Backdrop; shotError?: string;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  onSide: (s: Side) => void; onState: (s: CardState) => void; onHeld: (h: WeaponHeld) => void;
  onPreset: (p: PresetChoice) => void; onAspect: (a: Aspect) => void; onBackdrop: (b: Backdrop) => void;
  onShot: (e: Event) => void; onFont: (f: 'preset' | 'roboto') => void; onDownload: () => void;
  /** This browser's imports, for the Preset select. */
  imports: { id: string; name: string }[];
  /** The design's imported HUD is not loaded: only the Preset select and history stay live. */
  locked: boolean;
  onImportFile: (f: File) => void;
  onRemoveImport: (id: string) => void;
}

export function Toolbar(p: ToolbarProps) {
  const { design } = p;
  const fileRef = useRef<HTMLInputElement>(null);
  // The import picked in the remove row while it is open; null while it is closed.
  const [removing, setRemoving] = useState<string | null>(null);
  const value = presetValue(design);
  // A design on an import this browser does not have still shows which one.
  const unlisted = design.preset === 'imported' && design.imported && !p.imports.some((m) => m.id === design.imported!.id);
  /**
   * Import a HUD... and Remove an imported HUD... are actions, not presets:
   * the select goes straight back to the design's own value, and only
   * picking Stock, Modern or an import changes the design.
   */
  const onSelect = (e: Event) => {
    const el = e.target as HTMLSelectElement;
    const v = el.value;
    el.value = value;
    if (v === 'import') fileRef.current?.click();
    else if (v === 'remove') setRemoving(p.imports[0]?.id ?? null);
    else if (v === 'stock' || v === 'modern') p.onPreset(v);
    else if (v.startsWith('imported:')) p.onPreset({ id: v.slice('imported:'.length) });
  };
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
        <select value={value} onChange={onSelect}>
          <option value="stock">Stock</option>
          <option value="modern">Modern</option>
          {p.imports.map((m) => <option key={m.id} value={`imported:${m.id}`}>{`Imported: ${m.name}`}</option>)}
          {unlisted && <option value={value}>{`Imported: ${design.imported!.name} (not in this browser)`}</option>}
          <option value="import">Import a HUD...</option>
          {p.imports.length > 0 && <option value="remove">Remove an imported HUD...</option>}
        </select>
      </label>
      {/* No accept filter: a HUD kept as my_hud.vpk.orig or my_hud.zip.bak must still be pickable,
          and anything that is not a HUD gets the import's own one-line refusal. */}
      <input
        ref={fileRef} type="file" aria-label="Import a HUD file" style={{ display: 'none' }}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (f) p.onImportFile(f);
        }}
      />
      {removing !== null && (
        <span class="hud__removerow">
          <select aria-label="Imported HUD to remove" value={removing} onChange={(e) => setRemoving((e.target as HTMLSelectElement).value)}>
            {p.imports.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => { p.onRemoveImport(removing); setRemoving(null); }}>Remove</button>
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => setRemoving(null)}>Cancel</button>
        </span>
      )}
      <label>
        Aspect{' '}
        <select value={design.aspect} disabled={p.locked} onChange={(e) => p.onAspect((e.target as HTMLSelectElement).value as Aspect)}>
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
          value={design.font} disabled={design.preset !== 'stock' || p.locked}
          onChange={(e) => p.onFont((e.target as HTMLSelectElement).value as 'preset' | 'roboto')}
        >
          <option value="preset">Preset default</option>
          <option value="roboto">Roboto Condensed</option>
        </select>
      </label>
      {design.preset === 'modern' && <span class="muted hud__note">Modern already uses Roboto Condensed.</span>}
      {design.preset === 'imported' && <span class="muted hud__note">An imported HUD uses its own fonts.</span>}

      <button type="button" class="btn btn--sm hud__download" disabled={p.locked} onClick={p.onDownload}>
        {design.advanced ? 'Download .zip' : 'Download .vpk'}
      </button>
    </div>
  );
}
