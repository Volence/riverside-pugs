/**
 * The one toolbar above the canvas: history, what is previewed (side, card
 * state, backdrop), what the design is built on (preset, aspect, font), and
 * Download on the right. The existing controls, gathered in one place.
 */
import { Tabs } from '../../components/bits';
import { GAME_BACKDROPS, type Backdrop, type GameBackdrop } from '../../crosshair/draw';
import type { HudDesign } from '../../hud/design';
import type { Aspect } from '../../hud/units';
import type { Side } from '../../hud/mock';
import type { PreviewState, SurvivorState } from '../../hud/render';
import type { WeaponHeld } from '../../hud/weapons';
import { useRef, useState } from 'preact/hooks';

/** Real in-game shots first (the default is the side's own, SIDE_BACKDROP), then the drawn and flat ones. */
const GAME: GameBackdrop[] = ['survivor-hilltop', 'survivor-subway', 'infected-hunter', 'infected-ghost'];
const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Drawn saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'], ['shot', 'My screenshot'],
];

const SURVIVOR_STATES: { key: SurvivorState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'hurt', label: 'Hurt' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];

/** The special infected the preview is: your infected health draws that class's file (the Tank reads the Hunter's). */
const SI_CLASSES: { key: PreviewState['siClass']; label: string }[] = [
  { key: 'hunter', label: 'Hunter' }, { key: 'smoker', label: 'Smoker' }, { key: 'boomer', label: 'Boomer' }, { key: 'tank', label: 'Tank' },
];

/** Whether the preview infected player is spawned, a ghost, or dead: game code shows different pieces in each. */
const INFECTED_STATES: { key: PreviewState['infected']; label: string }[] = [
  { key: 'alive', label: 'Alive' }, { key: 'ghost', label: 'Ghost' }, { key: 'dead', label: 'Dead' },
];

/**
 * The ability timer's states as the game shows them (probe Q15): Ready in the
 * ready colour with the meter whole, Not ready in the charging colour with
 * no meter (a standing Hunter), Recharging in the charging colour with the
 * meter refilling after an ability.
 */
const ABILITY_STATES: { key: PreviewState['ability']; label: string }[] = [
  { key: 'ready', label: 'Ready' }, { key: 'notReady', label: 'Not ready' }, { key: 'recharging', label: 'Recharging' },
];

/** What Show yourself is: a picture of a console setting, never written into the download. */
/** What the Occasional panels toggle shows. */
const OCCASIONAL_NOTE = 'Preview only: also draw the panels the game shows now and then, such as your microphone, a vote or the survival timer.';
const SHOW_SELF_NOTE = 'Preview only: the game shows your own card with the console setting hud_zombieteam_showself 1, which is not part of the HUD file.';

/** What the preview survivor holds: the game moves the weapon numbers when this changes. */
const HELD: { key: WeaponHeld; label: string }[] = [
  { key: 'primary', label: 'Gun' }, { key: 'pistol', label: 'Pistol' }, { key: 'item', label: 'Item' },
];

/** What the Preset select can switch to: a built-in preset, or one of this browser's imports. */
export type PresetChoice = 'stock' | 'modern' | { id: string };

const presetValue = (d: HudDesign) => (d.preset === 'imported' && d.imported ? `imported:${d.imported.id}` : d.preset);

export interface ToolbarProps {
  design: HudDesign; side: Side; preview: PreviewState; held: WeaponHeld; backdrop: Backdrop; shotError?: string;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  onSide: (s: Side) => void; onPreview: (s: PreviewState) => void; onHeld: (h: WeaponHeld) => void;
  onPreset: (p: PresetChoice) => void; onAspect: (a: Aspect) => void; onBackdrop: (b: Backdrop) => void;
  onShot: (e: Event) => void; onFont: (f: 'preset' | 'roboto') => void; onDownload: () => void;
  /** This browser's imports, for the Preset select. */
  imports: { id: string; name: string }[];
  /** The design's imported HUD is not loaded: only the Preset select and history stay live. */
  locked: boolean;
  onImportFile: (f: File) => void;
  onRemoveImport: (id: string) => void;
  /** Open the Share to community dialog. */
  onShare: () => void;
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
        <Tabs
          tabs={SURVIVOR_STATES.map((s) => ({ key: s.key, label: s.label }))} active={p.preview.survivor}
          onSelect={(k) => p.onPreview({ ...p.preview, survivor: k as SurvivorState })}
        />
      )}
      {p.side === 'infected' && (
        <Tabs
          label="Special infected" tabs={SI_CLASSES} active={p.preview.siClass}
          onSelect={(k) => p.onPreview({ ...p.preview, siClass: k as PreviewState['siClass'] })}
        />
      )}
      {p.side === 'infected' && (
        <Tabs
          label="Infected state" tabs={INFECTED_STATES} active={p.preview.infected}
          onSelect={(k) => p.onPreview({ ...p.preview, infected: k as PreviewState['infected'] })}
        />
      )}
      {p.side === 'infected' && (
        <Tabs
          label="Ability" tabs={ABILITY_STATES} active={p.preview.ability}
          onSelect={(k) => p.onPreview({ ...p.preview, ability: k as PreviewState['ability'] })}
        />
      )}
      {/* Crouching is shown alongside any state: the game draws the crouch icon whatever the health, on both sides. */}
      <button
        type="button" class="btn btn--ghost btn--sm" aria-pressed={p.preview.crouched}
        onClick={() => p.onPreview({ ...p.preview, crouched: !p.preview.crouched })}
      >
        Crouched
      </button>
      {p.side === 'survivor' && (
        <Tabs label="Holding" tabs={HELD} active={p.held} onSelect={(k) => p.onHeld(k as WeaponHeld)} />
      )}
      {/* Your own infected card: client.dll counts the local player among the cards only with this console setting. */}
      {p.side === 'infected' && (
        <button
          type="button" class="btn btn--ghost btn--sm" aria-pressed={!!p.preview.showSelf} title={SHOW_SELF_NOTE}
          onClick={() => p.onPreview({ ...p.preview, showSelf: !p.preview.showSelf })}
        >
          Show yourself
        </button>
      )}
      {/* Panels the game shows now and then (HudElement.occasional): off by default so they do not cover the everyday HUD. */}
      <button
        type="button" class="btn btn--ghost btn--sm" aria-pressed={!!p.preview.occasional} title={OCCASIONAL_NOTE}
        onClick={() => p.onPreview({ ...p.preview, occasional: !p.preview.occasional })}
      >
        Occasional panels
      </button>
      <span class="hud__tbsep" aria-hidden="true" />

      <label>
        Preset{' '}
        <select value={value} onChange={onSelect}>
          <option value="stock">Stock</option>
          <option value="modern">Riverside Modern</option>
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
          <optgroup label="In game">
            {GAME.map((v) => <option key={v} value={v}>{GAME_BACKDROPS[v].label}</option>)}
          </optgroup>
          <optgroup label="Plain">
            {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </optgroup>
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
      {design.preset === 'modern' && <span class="muted hud__note">Riverside Modern already uses Roboto Condensed.</span>}
      {design.preset === 'imported' && <span class="muted hud__note">An imported HUD uses its own fonts.</span>}

      {/* A locked design cannot be shared: its import is missing or cannot be shown. */}
      <button type="button" class="btn btn--ghost btn--sm hud__share" disabled={p.locked} onClick={p.onShare}>
        Share to community...
      </button>
      <button type="button" class="btn btn--sm hud__download" disabled={p.locked} onClick={p.onDownload}>
        {design.advanced ? 'Download .zip' : 'Download .vpk'}
      </button>
    </div>
  );
}
