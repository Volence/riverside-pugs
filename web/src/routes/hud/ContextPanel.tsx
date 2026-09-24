/**
 * The side panel's controls: what the selection can do. Built only from the
 * registries (elements.ts, children.ts), with every default read back from
 * the generator, so a freshly reset thing shows real numbers.
 */
import { Fragment } from 'preact';
import {
  clampOverride, clampChild, clampWeapon, WEAPON_KEYS, WEAPON_BOX_COLOUR,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
  type WeaponNumKey, type WeaponsOverride, type WeaponBoxStyle,
} from '../../hud/design';
import { weaponKey } from '../../hud/weapons';
import { fontFace, shownKey, healthRgb, panelFile, DEFAULT_PREVIEW, type PreviewState } from '../../hud/render';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, panelChild, baseHasChild, isFreeTeam, buildTrees, pcGet } from '../../hud/build';
import { kvFind } from '../../hud/kv';
import { baseOf } from '../../hud/base';
import { childDef, panelChildren, maxInset, type KeyDef } from '../../hud/children';
import { probe } from '../../hud/probes';
import {
  cardOffset, withTeamDir, freeInPlace, cardBoxes, placeCard, placeCards, alignCards, placeElement, patchChild, resetElement, resetChild, resetChildKey, rowGapSlider, setRowGap,
  startsOf, placeChildren, alignChildren, alignElements, setChildrenVisible, resetChildren, setSelectionVisible, patchWeapons, ammoOnly, setFit,
  resetElementKey,
  type Align,
} from '../../hud/edit';
import { unionBox } from '../../hud/guides';
import { CrosshairControls } from './CrosshairControls';
import { TEAMMATES, panelOf, type Selection } from '../../hud/selection';
import {
  Slider, SliderNum, Field, patchNum, endsOn, hexOf, alphaPct, withHex, withAlphaPct, type Edit, type EditMode, type Patch,
} from './controls';

const LAYOUT_LABELS: Record<TeamDir, string> = { row: 'Row', column: 'Column', free: 'Free' };

/**
 * Layout controls for a team element. One Layout select serves both: the
 * survivor team offers Row, Column and Free, the infected row (whose cards
 * the game places itself) only what its registry entry lists, and only the
 * onChange branches, not the select itself. The survivor team's cards step
 * by the Gap between them (0 to 200, units at scale 1) outside Free, plus
 * Fit, and in Free one X and Y per card, card 4 included, since it shows
 * only while spectating a full team and is otherwise unreachable. The
 * infected row keeps its single spacing number.
 */
export function TeamControls(
  { design, edit, end, el, o, patch }: {
    design: HudDesign; edit: Edit; end: () => void; el: HudElement; o: ElementOverride; patch: Patch;
  },
) {
  if (!el.team) return null;
  const team = el.team;
  const t = teamLayout(design, el);
  const rowGap = rowGapSlider(design);
  const options = team.file ? (['row', 'column', 'free'] as const) : team.dirs;
  const onLayoutChange = (e: Event) => {
    const dir = (e.target as HTMLSelectElement).value as TeamDir;
    if (team.file) edit((d) => withTeamDir(d, dir));
    else patch({ dir: dir as 'row' | 'column' });
  };
  // The boxes show and take where the card is drawn, the slot plus the fit offset.
  const off = cardOffset(design);
  const setSlot = (i: number, key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const cur = d.elements.teamColumn?.slots?.[i];
      if (!cur) return d;
      const o2 = cardOffset(d);
      return placeCard(d, i, key === 'x' ? n : cur.x + o2.x, key === 'y' ? n : cur.y + o2.y);
    }, 'gesture');
  };
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select value={t.dir} onChange={onLayoutChange}>
          {options.map((d) => <option key={d} value={d}>{LAYOUT_LABELS[d]}</option>)}
        </select>
        <span />
      </label>
      {/* The infected row: code places card i at i x HorizPanelSpacing, so its pitch is the card plus the gap (build.ts rowLayout). */}
      {!team.file && (
        <>
          {/* Negative while cards overlap: the stock card is -116 (edit.ts rowGapSlider). */}
          <Slider
            label="Gap" value={rowGap.value} min={rowGap.min} max={rowGap.max} step={1}
            onInput={(gap) => edit((d) => setRowGap(d, gap), 'gesture')}
            onEnd={end}
          />
          <label class="hud__check">
            <input
              type="checkbox" checked={o.fit === true}
              onChange={(e) => patch({ fit: (e.target as HTMLInputElement).checked })}
            />
            <span>Fit the card to its contents</span>
          </label>
          {/* client.dll 0x10247a70 places card i at (i x HorizPanelSpacing, 0) and reads no vertical key;
              0x10247b70 skips every fake player, and makes exactly three card panels (probe RESULTS.md). */}
          <p class="muted hud__note">The game lays infected cards in a row; a column is impossible.</p>
          <p class="muted hud__note">The game shows only human teammates here, at most 3 cards; bots never get one.</p>
        </>
      )}
      {team.file && (
        <>
          {t.dir !== 'free' && (
            <Slider
              label="Gap" value={Math.max(0, Math.round(t.gap ?? 0))} min={0} max={200} step={1}
              onInput={(gap) => patch({ gap: clampOverride('gap', gap) }, 'gesture')} onEnd={end}
            />
          )}
          <label class="hud__check">
            <input
              type="checkbox" checked={o.fit === true}
              onChange={(e) => patch({ fit: (e.target as HTMLInputElement).checked })}
            />
            <span>Fit the card to its contents</span>
          </label>
          {t.dir === 'free' && o.slots && (
            <>
              <p class="muted hud__note">
                Drag each card on the canvas, or type its position. Card 4 shows only while you spectate a full team.
              </p>
              {o.slots.map((s, i) => (
                <div class="hud__row2" key={i}>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} X`}</span>
                    <input type="number" value={Math.round(s.x + off.x)} onInput={(e) => setSlot(i, 'x', e)} {...endsOn(end)} />
                  </label>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} Y`}</span>
                    <input type="number" value={Math.round(s.y + off.y)} onInput={(e) => setSlot(i, 'y', e)} {...endsOn(end)} />
                  </label>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

/** The weapon number rows: which field, its label, and the slider's range (the clamp's own, or a narrower useful one). */
const WEAPON_ROWS: { group: string; rows: { field: WeaponNumKey | 'clipFont' | 'pistolFont'; label: string; min: number; max: number }[] }[] = [
  { group: 'Position', rows: [
    { field: 'indent', label: 'Inset from right', min: -200, max: 200 },
    { field: 'primaryY', label: 'Start height', min: -200, max: 200 },
  ] },
  { group: 'Sizes', rows: [
    { field: 'primaryBoxW', label: 'Gun box W', min: 0, max: 200 },
    { field: 'primaryBoxH', label: 'Gun box H', min: 0, max: 200 },
    { field: 'pistolBoxW', label: 'Pistol box W', min: 0, max: 200 },
    { field: 'pistolBoxH', label: 'Pistol box H', min: -40, max: 200 },
    { field: 'iconTall', label: 'Gun picture height', min: 0, max: 200 },
    { field: 'itemSize', label: 'Item size', min: 0, max: 200 },
  ] },
  { group: 'Ammo numbers', rows: [
    { field: 'ammoX', label: 'Numbers in from box edge', min: -200, max: 200 },
    { field: 'reserveY', label: 'Reserve lower by', min: -200, max: 200 },
    { field: 'clipFont', label: 'Clip text size', min: 6, max: 64 },
    { field: 'pistolFont', label: 'Reserve and pistol text size', min: 6, max: 64 },
  ] },
];

const BOX_KINDS: { kind: 'stock' | WeaponBoxStyle['kind']; label: string }[] = [
  { kind: 'stock', label: 'Game' }, { kind: 'hidden', label: 'Hidden' }, { kind: 'flat', label: 'Flat colour' }, { kind: 'rounded', label: 'Rounded colour' },
];

/** A colour swatch and an opacity slider over one raw "r g b a" value, as a child's colour row has. */
function ColourRow({ label, value, onPick, end }: { label: string; value: string; onPick: (c: string) => void; end: () => void }) {
  return (
    <div class="hud__stylerow">
      <span class="hud__stylerow-label">{label}</span>
      <input
        type="color" aria-label={`${label} colour`} value={hexOf(value)}
        onInput={(e) => onPick(withHex(value, (e.target as HTMLInputElement).value))} onChange={end}
      />
      <input
        type="range" min={0} max={100} step={1} aria-label={`${label} opacity`} value={alphaPct(value)}
        onInput={(e) => onPick(withAlphaPct(value, parseFloat((e.target as HTMLInputElement).value)))} onChange={end}
      />
    </div>
  );
}

/**
 * The weapon selection's own controls: the HudWeaponSelection keys the game
 * reads (weapons.ts's header), the two box styles, the picture switches and
 * the Ammo only preset. Every value shown is read back from the generated
 * file (weaponKey, fontFace), so an untouched design shows the preset's
 * numbers. The box sizes are sliders with number boxes rather than canvas
 * handles in this phase; the element's own handles are unchanged.
 */
function WeaponControls({ design, edit, end }: { design: HudDesign; edit: Edit; end: () => void }) {
  const w = design.weapons ?? {};
  const patch = (p: Partial<WeaponsOverride>, mode: EditMode = 'gesture') => edit((d) => patchWeapons(d, p), mode);
  const value = (field: WeaponNumKey | 'clipFont' | 'pistolFont') => {
    if (field === 'clipFont') return fontFace(design, weaponKey(design, 'PrimaryAmmoFont')).tall;
    if (field === 'pistolFont') return fontFace(design, weaponKey(design, 'PistolAmmoFont')).tall;
    const n = (f: WeaponNumKey) => Math.round(parseFloat(weaponKey(design, WEAPON_KEYS[f].key)) || 0);
    // The game measures PrimaryWeaponAmmoX from the panel's right edge and the
    // boxes from RightSideIndent, so a bare AmmoX leaves the numbers behind
    // when the inset moves the boxes (the owner's in-game test, 2026-09-23).
    // The box shows the numbers' distance in from the boxes' edge instead.
    return field === 'ammoX' ? n('ammoX') - n('indent') : n(field);
  };
  /**
   * One row's change. The inset carries the ammo numbers with it, and the
   * numbers' row counts from the inset, so the numbers stay where the player
   * put them against the boxes; the file still gets the game's own keys.
   */
  const setRow = (field: WeaponNumKey | 'clipFont' | 'pistolFont', v: number) => {
    if (field === 'indent') {
      const indent = clampWeapon('indent', v);
      patch({ indent, ammoX: clampWeapon('ammoX', value('ammoX') + indent) });
    } else if (field === 'ammoX') patch({ ammoX: clampWeapon('ammoX', v + value('indent')) });
    else patch({ [field]: clampWeapon(field, v) });
  };
  const boxRow = (box: 'boxActive' | 'boxInactive', label: string) => {
    const s = w[box];
    const colour = s?.color ?? WEAPON_BOX_COLOUR[box];
    const onKind = (e: Event) => {
      const kind = (e.target as HTMLSelectElement).value as 'stock' | WeaponBoxStyle['kind'];
      patch({ [box]: kind === 'stock' ? undefined : { kind, ...(kind !== 'hidden' && s?.color ? { color: s.color } : {}) } }, 'step');
    };
    return (
      <>
        <label class="hud__row">
          <span>{label}</span>
          <select aria-label={label} value={s?.kind ?? 'stock'} onChange={onKind}>
            {BOX_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          <span />
        </label>
        {s && s.kind !== 'hidden' && (
          <ColourRow label={label} value={colour} end={end} onPick={(c) => patch({ [box]: { kind: s.kind, color: c } })} />
        )}
      </>
    );
  };
  return (
    <>
      <button type="button" class="btn btn--sm hud__reset" onClick={() => edit(ammoOnly)}>Ammo only</button>
      <p class="muted hud__note">Only the ammo numbers, on one line just right of the crosshair: no boxes, no pictures, no item slots.</p>
      {WEAPON_ROWS.map((g) => (
        <div key={g.group}>
          <p class="eyebrow hud__note">{g.group}</p>
          {g.rows.map((r) => (
            <SliderNum
              key={r.field} label={r.label} value={value(r.field)} min={r.min} max={r.max} onEnd={end}
              onInput={(n) => setRow(r.field, n)}
            />
          ))}
          {g.group === 'Sizes' && <p class="muted hud__note">Item size 0 hides the three item slots. A pistol box below 0 lifts the pistol row: with hidden boxes, about -5 puts its number on the gun's line.</p>}
        </div>
      ))}
      <ColourRow label="Reserve number" value={w.reserveColor ?? weaponKey(design, 'ReserveAmmoColor')} end={end} onPick={(c) => patch({ reserveColor: c })} />
      <ColourRow label="Empty item slot" value={w.inactiveColor ?? weaponKey(design, 'InactiveItemColor')} end={end} onPick={(c) => patch({ inactiveColor: c })} />
      <p class="eyebrow hud__note">Boxes</p>
      {boxRow('boxActive', 'Active box')}
      {boxRow('boxInactive', 'Other boxes')}
      <label class="hud__check">
        <input
          type="checkbox" checked={w.weaponIcons !== false}
          onChange={(e) => patch({ weaponIcons: (e.target as HTMLInputElement).checked ? undefined : false }, 'step')}
        />
        <span>Weapon pictures</span>
      </label>
      <label class="hud__check">
        <input
          type="checkbox" checked={w.itemIcons !== false}
          onChange={(e) => patch({ itemIcons: (e.target as HTMLInputElement).checked ? undefined : false }, 'step')}
        />
        <span>Item pictures</span>
      </label>
      <p class="muted hud__note">
        The game fixes the rest: clip numbers are always white, the slot order and the gap between slots cannot change,
        and the pistol always sits just under the main gun. While the gun is held, the game nudges its numbers a little
        left and grows its box; switch Holding above the preview to see each.
      </p>
    </>
  );
}

/**
 * The controls for whichever element is selected, built only from what its
 * registry entry allows. `elementRect` supplies every default shown when the
 * design has no override yet, so a freshly reset element shows real numbers
 * rather than blanks.
 */
/** The class names the notes use. */
const SI_NAME: Record<PreviewState['siClass'], string> = { hunter: 'Hunter', smoker: 'Smoker', boomer: 'Boomer', tank: 'Tank' };

/**
 * Your infected health's note, for the class shown. The hide is game code:
 * the panel is gone while you pin a survivor or throw a rock
 * (/home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-d.png, b9-h, b9-m).
 */
export const siHealthNote = (c: PreviewState['siClass']): string =>
  `Shown as the ${SI_NAME[c]}. Edits apply to every special infected; the Boomer's smaller bar moves the same and sizes in proportion. The game hides this panel while you pin a survivor or throw a rock.`;

export function ElementControls(
  { design, edit, end, id, preview = DEFAULT_PREVIEW }: { design: HudDesign; edit: Edit; end: () => void; id: string; preview?: PreviewState },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  // In Free each card places itself, so the element's own X and Y would move nothing.
  const free = !!el.team?.file && teamLayout(design, el).dir === 'free';
  const patch: Patch = (p, mode: EditMode = 'step') => edit((d) => (
    { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), ...p } } }
  ), mode);
  const reset = () => edit((d) => resetElement(d, id));
  // A team's on-screen clamp can draw it away from its stored X and Y (a
  // team moved past the right edge, or scaled up there), so its boxes show
  // where it is drawn, and a typed value is placed as a drag would place it:
  // placeElement, then the clamp. The other axis keeps what it stores (read
  // from where it is drawn only when nothing is stored), so typing one box
  // never shifts the other by the half unit a right-anchored token rounds to.
  // Anything else shows and patches what it stores, except a fitted panel
  // framed by its own hudlayout.res block (your infected health): fit moves
  // that container by the fit offset, so its boxes show where it is drawn
  // and place through placeElement too, or ticking Fit would make the
  // stored X jump by the offset (250 units on stock).
  // The fitted panel's other axis is passed where it is drawn: its stored
  // number is the unfitted container's, which placeElement would take as a
  // drawn one and move by the fit offset.
  const fitted = o.fit === true && panelChildren(id)?.frame === 'hudlayout';
  const team = !!el.team || fitted;
  const setPos = (key: 'x' | 'y', e: Event) => {
    if (!team) { patchNum(patch, e, key, (n) => ({ [key]: n })); return; }
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const r = elementRect(d, id, d.aspect);
      const s = fitted ? {} : d.elements[id] ?? {};
      return placeElement(d, id, key === 'x' ? n : s.x ?? r.x, key === 'y' ? n : s.y ?? r.y);
    }, 'gesture');
  };

  return (
    <Field legend={el.label}>
      {el.props.includes('visible') && (
        <label class="hud__check">
          <input
            type="checkbox" checked={o.visible ?? rect.visible}
            onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })}
          />
          <span>Visible</span>
        </label>
      )}

      {/* The crosshair is the one element the game places itself; its note is the first line of its own controls. */}
      {id === 'xhair' && <CrosshairControls design={design} edit={edit} selected />}

      {id === 'siHealth' && <p class="muted hud__note">{siHealthNote(preview.siClass)}</p>}
      {/* Probe Q15 (/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md): the Smoker, Boomer and Tank spawn ready. */}
      {/* Probe Q16a (/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md): the marker draws only with the crosshair cvar on, at ability_size screen pixels. */}
      {id === 'abilityMarker' && (
        <p class="muted hud__note">Shown only with the game's crosshair on (crosshair 1). Sized in screen pixels: smaller on a bigger screen. The attack colours show when a survivor is in reach.</p>
      )}
      {id === 'abilityRing' && <p class="muted hud__note">Hunter: not ready while standing (no meter), ready while crouched. After any ability the icon takes the charging colour while the meter refills.</p>}

      {el.move && !free && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(team ? rect.x : o.x ?? rect.x)} onInput={(e) => setPos('x', e)} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(team ? rect.y : o.y ?? rect.y)} onInput={(e) => setPos('y', e)} {...endsOn(end)} />
          </label>
        </div>
      )}

      {el.resize === 'free' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input
              type="number" min={20} value={Math.round(o.w ?? rect.w)}
              onInput={(e) => patchNum(patch, e, 'w', (n) => ({ w: Math.max(20, n) }))} {...endsOn(end)}
            />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input
              type="number" min={20} value={Math.round(o.h ?? rect.h)}
              onInput={(e) => patchNum(patch, e, 'h', (n) => ({ h: Math.max(20, n) }))} {...endsOn(end)}
            />
          </label>
        </div>
      )}

      {el.resize === 'scale' && (
        <Slider label="Scale" value={o.scale ?? 1} min={0.5} max={2} step={0.05} onInput={(scale) => patch({ scale }, 'gesture')} onEnd={end} />
      )}

      <TeamControls design={design} edit={edit} end={end} el={el} o={o} patch={patch} />

      {/* Fit re-places LocalPlayer to what it shows; it waits for probe Q2 (does LocalPlayer clip and paint nothing?), as validateDesign does. */}
      {/* Your infected health's fit rests on probe Q11 (the container clips), which passed; it is opt-in (build.ts fitSi). */}
      {((id === 'ownHealth' && probe('Q2')) || id === 'siHealth') && (
        <label class="hud__check">
          <input
            type="checkbox" checked={o.fit === true}
            onChange={(e) => edit((d) => setFit(d, id, (e.target as HTMLInputElement).checked))}
          />
          <span>Fit the panel to its contents</span>
        </label>
      )}

      {/* The element block's own keys (the ability timer's state colours), shown as the file has them. */}
      {el.keys?.filter((k) => !k.gate || probe(k.gate)).map((k) => (
        <Fragment key={k.key}>
          <KeyControl
            def={k} end={end}
            value={shownKey(design, k, o.keys?.[k.key] ?? elementKey(design, el.key, k.key))}
            onValue={(v, mode) => patch({ keys: { ...o.keys, [k.key]: v } }, mode)}
          />
          {k.note && <p class="muted hud__note">{k.note}</p>}
          {o.keys?.[k.key] !== undefined && (
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label={`${k.label}: use the file's value`}
              onClick={() => edit((d) => resetElementKey(d, id, k.key))}
            >
              Use the file's value
            </button>
          )}
        </Fragment>
      ))}

      {id === 'weaponSelection' && <WeaponControls design={design} edit={edit} end={end} />}

      {/* The crosshair has no element settings of its own to reset: its choice and art are undone like any edit. */}
      {id !== 'xhair' && <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>}
    </Field>
  );
}

/** An element key as the base file has it (the design's own edit is left out): what "Use the file's value" goes back to. */
function elementKey(design: HudDesign, block: string, key: string): string | undefined {
  const n = kvFind(buildTrees({ ...design, elements: {} })('scripts/hudlayout.res'), [block]);
  return n ? pcGet(n, key) : undefined;
}

/** Said under a teammate piece's controls: one file is loaded for every card. */
const EVERY_CARD = "Edits inside a card apply to every teammate's card.";
/** Whether a panel's file is loaded once per teammate card. */
const repeatsCards = (panel: string): boolean => panelChildren(panel)?.repeat === 'cards';

/**
 * The controls for one child of a registered panel (the teammate card by
 * default), built only from its registry entry. Numbers are unscaled units
 * in the panel file's own frame (what a ChildOverride stores), read back
 * through panelChild so a child with no edits shows real numbers. Square art gets one Size; labels a text
 * size and, where the game honours it, a colour.
 */
export function ChildControls(
  { design, edit, end, name, onBack, panel = 'teamColumn', preview }: {
    design: HudDesign; edit: Edit; end: () => void; name: string; onBack: () => void; panel?: string; preview?: PreviewState;
  },
) {
  const def = childDef(panel, name);
  // The numbers of the class shown (your infected health on the Boomer: the Boomer file's), stored back in the panel file's frame.
  const file = panelFile(panel, preview);
  const info = panelChild(design, panel, name, file);
  if (!def || !info) return null;
  const o = design.children[panel]?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>, mode: EditMode = 'step') => edit((d) => patchChild(d, name, p, panel, file), mode);
  // The same guard and clamp as patchNum, through the child table.
  const num = (e: Event, key: ChildRangeKey, to: (n: number) => Partial<ChildOverride>) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) patch(to(clampChild(key, n)), 'gesture');
  };
  const colour = o.color ?? info.color ?? '255 255 255 255';
  // A label's colour is its text colour; an image's is a tint over its texture (the splatter, so far),
  // so the one shared control calls itself by what it means for this child's kind. An opacity-only
  // image (a flat-colour texture, where an RGB tint would draw no visible difference) drops the word
  // entirely for just "Opacity", since there is no swatch to name.
  const colourWord = def.opacityOnly ? 'Opacity' : def.kind === 'image' ? 'Tint' : 'Colour';
  const reset = () => edit((d) => resetChild(d, name, panel));

  return (
    <Field legend={def.label}>
      <label class="hud__check">
        <input type="checkbox" checked={o.visible ?? info.visible} onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })} />
        <span>Visible</span>
      </label>
      {def.move && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(info.x)} onInput={(e) => num(e, 'x', (x) => ({ x }))} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(info.y)} onInput={(e) => num(e, 'y', (y) => ({ y }))} {...endsOn(end)} />
          </label>
        </div>
      )}
      {def.box === 'wh' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (w) => ({ w }))} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input type="number" value={Math.round(info.h)} onInput={(e) => num(e, 'h', (h) => ({ h }))} {...endsOn(end)} />
          </label>
        </div>
      )}
      {def.box === 'square' && (
        <label class="hud__row">
          <span>Size</span>
          <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (s) => ({ w: s, h: s }))} {...endsOn(end)} />
          <span />
        </label>
      )}
      {def.font && (
        <label class="hud__row">
          <span>{def.box === 'none' ? 'Icon size' : 'Text size'}</span>
          <input type="number" min={6} max={64} value={o.fontSize ?? info.fontTall ?? 12} onInput={(e) => num(e, 'fontSize', (fontSize) => ({ fontSize }))} {...endsOn(end)} />
          <span />
        </label>
      )}
      {/* A colour the game may repaint waits for its probe, as validateDesign does (probes.ts). */}
      {def.colour && (!def.colourGate || probe(def.colourGate)) && (
        <div class="hud__stylerow">
          <span class="hud__stylerow-label">{colourWord}</span>
          {!def.opacityOnly && (
            <input
              type="color" aria-label={`${def.label} ${colourWord.toLowerCase()}`} value={hexOf(colour)}
              onInput={(e) => patch({ color: withHex(colour, (e.target as HTMLInputElement).value) }, 'gesture')}
              onChange={end}
            />
          )}
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(colour)}
            onInput={(e) => patch({ color: withAlphaPct(colour, parseFloat((e.target as HTMLInputElement).value)) }, 'gesture')}
            onChange={end}
          />
        </div>
      )}
      {def.keys?.filter((k) => !k.gate || probe(k.gate)).map((k) => (
        <Fragment key={k.key}>
          <KeyControl
            def={k} end={end} max={def.kind === 'bar' && k.key === 'inset' ? maxInset(info.h) : undefined}
            value={shownKey(design, k, o.keys?.[k.key] ?? info.keys?.[k.key])}
            onValue={(v, mode) => patch({ keys: { ...o.keys, [k.key]: v } }, mode)}
          />
          {k.note && <p class="muted hud__note">{k.note}</p>}
          {o.keys?.[k.key] !== undefined && (
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label={`${k.label}: use the file's value`}
              onClick={() => edit((d) => resetChildKey(d, name, k.key, panel))}
            >
              Use the file's value
            </button>
          )}
        </Fragment>
      ))}
      {def.note && <p class="muted hud__note">{def.note}</p>}
      {repeatsCards(panel) && <p class="muted hud__note">{EVERY_CARD}</p>}
      {def.addable && !baseHasChild(baseOf(design), name, panel) && (
        <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => patchChild(d, name, { on: false }, panel))}>
          {`Remove the ${def.label.toLowerCase()}`}
        </button>
      )}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>{`Back to ${elementById(panel)?.label ?? 'Teammates'}`}</button>
    </Field>
  );
}

/**
 * One typed file key of a child (a KeyDef): a colour as a swatch and an
 * opacity, a number within its range, or a checkbox. Only keys whose probe
 * gate has passed reach here; the value is the file's text, as the
 * generator writes it.
 */
function KeyControl({ def, value, onValue, end, max }: {
  def: KeyDef; value: string | undefined; onValue: (v: string, mode?: EditMode) => void; end: () => void;
  /** A tighter top than the range: a bar's inset stops where one unit of fill is left (maxInset). */
  max?: number;
}) {
  if (def.type === 'colour' && value === undefined) {
    // Unset: the game's own colour, the health colour for a Panel colour.
    // No opacity here, so touching it cannot write white over the whole
    // panel; the key is written only when a colour is picked.
    const [r, g, b] = healthRgb(100, 100, false);
    return (
      <div class="hud__stylerow">
        <span class="hud__stylerow-label">{`${def.label}: ${def.unsetLabel ?? 'Game colour'}`}</span>
        <input
          type="color" aria-label={`${def.label} colour`} value={hexOf(`${r} ${g} ${b} 255`)}
          onInput={(e) => onValue(withHex('0 0 0 255', (e.target as HTMLInputElement).value), 'gesture')} onChange={end}
        />
      </div>
    );
  }
  if (def.type === 'colour') return <ColourRow label={def.label} value={value!} end={end} onPick={(c) => onValue(c, 'gesture')} />;
  const text = value ?? '0';
  if (def.type === 'bool') {
    return (
      <label class="hud__check">
        <input type="checkbox" checked={text !== '0'} onChange={(e) => onValue((e.target as HTMLInputElement).checked ? '1' : '0')} />
        <span>{def.label}</span>
      </label>
    );
  }
  const [lo, top] = def.range ?? [-Infinity, Infinity];
  const hi = max === undefined ? top : Math.min(top, max);
  return (
    <label class="hud__row">
      <span>{def.label}</span>
      <input
        type="number" min={def.range?.[0]} max={Number.isFinite(hi) ? hi : undefined} value={text}
        onInput={(e) => {
          const n = parseInt((e.target as HTMLInputElement).value, 10);
          if (Number.isFinite(n)) onValue(String(Math.min(hi, Math.max(lo, n))), 'gesture');
        }}
        {...endsOn(end)}
      />
      <span />
    </label>
  );
}

const ALIGNS: { how: Align; label: string }[] = [
  { how: 'left', label: 'Left' }, { how: 'centre', label: 'Centre' }, { how: 'right', label: 'Right' },
  { how: 'top', label: 'Top' }, { how: 'middle', label: 'Middle' }, { how: 'bottom', label: 'Bottom' },
];

/** Six buttons that line a group up against the box around it. */
function AlignRow({ onAlign }: { onAlign: (how: Align) => void }) {
  return (
    <div class="hud__align" role="group" aria-label="Align">
      {ALIGNS.map((a) => (
        <button
          key={a.how} type="button" class="btn btn--ghost btn--sm" aria-label={`Align ${a.label.toLowerCase()}`}
          onClick={() => onAlign(a.how)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Several pieces of one panel (the teammate card by default): the group's X
 * and Y (the box around them, in the panel file's frame, moving all of
 * them), Align, Visible for all and Reset all. On the teammate card every
 * edit is the one card file, so every card follows.
 */
export function PiecesControls(
  { design, edit, end, names, panel = 'teamColumn', preview }: {
    design: HudDesign; edit: Edit; end: () => void; names: string[]; panel?: string; preview?: PreviewState;
  },
) {
  const file = panelFile(panel, preview);
  const box = unionBox(Object.values(startsOf(design, names, panel, file)));
  if (!box) return null;
  const allVisible = names.every((n) => panelChild(design, panel, n)?.visible);
  const place = (key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const b = unionBox(Object.values(startsOf(d, names, panel, file)));
      return b ? placeChildren(d, names, key === 'x' ? n : b.x, key === 'y' ? n : b.y, panel, file) : d;
    }, 'gesture');
  };
  const where = panel === 'teamColumn' ? 'the teammate card' : (elementById(panel)?.label ?? panel);
  return (
    <Field legend={`${names.length} pieces in ${where}`}>
      {repeatsCards(panel) && <p class="muted hud__note">{EVERY_CARD}</p>}
      <div class="hud__row2">
        <label class="hud__field">
          <span>X</span>
          <input type="number" value={Math.round(box.x)} onInput={(e) => place('x', e)} {...endsOn(end)} />
        </label>
        <label class="hud__field">
          <span>Y</span>
          <input type="number" value={Math.round(box.y)} onInput={(e) => place('y', e)} {...endsOn(end)} />
        </label>
      </div>
      <AlignRow onAlign={(how) => edit((d) => alignChildren(d, names, how, panel, file))} />
      <label class="hud__check">
        <input
          type="checkbox" checked={allVisible}
          onChange={(e) => { const v = (e.target as HTMLInputElement).checked; edit((d) => setChildrenVisible(d, names, v, panel)); }}
        />
        <span>Visible</span>
      </label>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => resetChildren(d, names, panel))}>Reset all</button>
    </Field>
  );
}

/** Several elements of the side: Align against their box, and Visible for all of those that can hide. */
export function ElementsControls({ design, edit, ids }: { design: HudDesign; edit: Edit; ids: string[] }) {
  const hideable = ids.filter((id) => elementById(id)?.props.includes('visible'));
  const allVisible = hideable.every((id) => elementRect(design, id, design.aspect).visible);
  return (
    <Field legend={`${ids.length} elements`}>
      <AlignRow onAlign={(how) => edit((d) => alignElements(d, ids, how))} />
      {hideable.length > 0 && (
        <label class="hud__check">
          <input
            type="checkbox" checked={allVisible}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              edit((d) => setSelectionVisible(d, { kind: 'elements', ids: hideable }, v));
            }}
          />
          <span>Visible</span>
        </label>
      )}
    </Field>
  );
}

/** The X and Y boxes of one card or a group of cards, showing `box` and handing a typed number to `place`. */
function CardXY({ box, end, place }: { box: { x: number; y: number }; end: () => void; place: (key: 'x' | 'y', n: number) => void }) {
  const typed = (key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) place(key, n);
  };
  return (
    <div class="hud__row2">
      <label class="hud__field">
        <span>X</span>
        <input type="number" value={Math.round(box.x)} onInput={(e) => typed('x', e)} {...endsOn(end)} />
      </label>
      <label class="hud__field">
        <span>Y</span>
        <input type="number" value={Math.round(box.y)} onInput={(e) => typed('y', e)} {...endsOn(end)} />
      </label>
    </div>
  );
}

/**
 * One teammate card, in any layout: where it is drawn, as X and Y. The
 * boxes read and write the stored slot plus the fit offset (edit.ts's
 * cardBoxes), the same as the Teammates' per-card list (TeamControls'
 * setSlot): teamCardRects' centre-anchor rounding would show a value like
 * 294 for a stored 293 and drift while typing, so the slot is the source of
 * truth here too. In Row or Column a typed value first makes the team Free
 * with every card where it was (freeInPlace), within the same step, and
 * `onWentFree` says so. The cards share one size (the Teammates' Scale), so
 * there is no size here.
 */
export function CardControls(
  { design, edit, end, card, onWentFree }: { design: HudDesign; edit: Edit; end: () => void; card: number; onWentFree: () => void },
) {
  const box = cardBoxes(design)[card];
  if (!box) return null;
  const place = (key: 'x' | 'y', n: number) => {
    if (!isFreeTeam(design)) onWentFree();
    edit((d) => {
      const f = freeInPlace(d);
      const cur = cardBoxes(f)[card];
      return placeCard(f, card, key === 'x' ? n : cur.x, key === 'y' ? n : cur.y);
    }, 'gesture');
  };
  return (
    <Field legend={`Teammate card ${card + 1}`}>
      {card === 3 && <p class="muted hud__note">Card 4 shows only while you spectate a full team.</p>}
      <CardXY box={box} end={end} place={place} />
      <p class="muted hud__note">The cards share one size: scale them from the Teammates.</p>
    </Field>
  );
}

/**
 * Several teammate cards: the group's X and Y (the box around them, moving
 * all of them) and Align against that box. Like one card, a Row or Column
 * team goes Free first. No size and no Visible: the cards share the
 * Teammates' Scale, and a card cannot be hidden alone.
 */
export function CardsControls(
  { design, edit, end, cards, onWentFree }: { design: HudDesign; edit: Edit; end: () => void; cards: number[]; onWentFree: () => void },
) {
  const boxes = cardBoxes(design);
  const box = unionBox(cards.map((c) => boxes[c]).filter(Boolean));
  if (!box) return null;
  const going = () => { if (!isFreeTeam(design)) onWentFree(); };
  const place = (key: 'x' | 'y', n: number) => {
    going();
    edit((d) => {
      const all = cardBoxes(d);
      const b = unionBox(cards.map((c) => all[c]))!;
      return placeCards(d, cards, key === 'x' ? n : b.x, key === 'y' ? n : b.y);
    }, 'gesture');
  };
  return (
    <Field legend={`${cards.length} cards`}>
      <CardXY box={box} end={end} place={place} />
      <AlignRow onAlign={(how) => { going(); edit((d) => alignCards(d, cards, how)); }} />
      <p class="muted hud__note">The cards share one size: scale them from the Teammates.</p>
    </Field>
  );
}

/**
 * An infected card: nothing of its own to edit. The game places card i at
 * i x HorizPanelSpacing inside the row (client.dll 0x10247a70), so a card
 * cannot move alone; moving it moves the row, and its pieces are edited in
 * every card at once.
 */
function InfectedCardControls({ cards, onRow, rowLabel }: { cards: number[]; onRow: () => void; rowLabel: string }) {
  return (
    <Field legend={cards.length === 1 ? `Infected card ${cards[0] + 1}` : `${cards.length} infected cards`}>
      <p class="muted hud__note">
        The game places every infected card itself, side by side in the row: drag or nudge a card to move the whole row, and pick a piece to edit it in every card.
      </p>
      <button type="button" class="btn btn--ghost btn--sm" onClick={onRow}>{`Select ${rowLabel}`}</button>
    </Field>
  );
}

/** The right-hand panel: only what the selection can do. */
export function ContextPanel(
  { design, sel, edit, end, onSelect, onWentFree, preview = DEFAULT_PREVIEW }: {
    design: HudDesign; sel: Selection; edit: Edit; end: () => void; onSelect: (s: Selection) => void; onWentFree: () => void;
    /** What the canvas shows: the notes name the class, and a piece's numbers are the class file's. */
    preview?: PreviewState;
  },
) {
  switch (sel.kind) {
    case 'none':
      return (
        <>
          <p class="muted">Select an element on the canvas or in Layers. A click picks the piece under the pointer; a drag moves the card or element under it.</p>
          <CrosshairControls design={design} edit={edit} />
        </>
      );
    case 'elements':
      return sel.ids.length === 1
        ? <ElementControls design={design} edit={edit} end={end} id={sel.ids[0]} preview={preview} />
        : <ElementsControls design={design} edit={edit} ids={sel.ids} />;
    case 'cards':
      if (panelOf(sel) !== 'teamColumn') {
        const row = panelOf(sel);
        return <InfectedCardControls cards={sel.cards} rowLabel={elementById(row)!.label} onRow={() => onSelect({ kind: 'elements', ids: [row] })} />;
      }
      return sel.cards.length === 1
        ? <CardControls design={design} edit={edit} end={end} card={sel.cards[0]} onWentFree={onWentFree} />
        : <CardsControls design={design} edit={edit} end={end} cards={sel.cards} onWentFree={onWentFree} />;
    case 'children':
      return sel.names.length === 1
        ? (
          <ChildControls
            design={design} edit={edit} end={end} name={sel.names[0]} panel={panelOf(sel)} preview={preview}
            onBack={() => onSelect(panelOf(sel) === 'teamColumn' ? TEAMMATES : { kind: 'elements', ids: [panelOf(sel)] })}
          />
        )
        : <PiecesControls design={design} edit={edit} end={end} names={sel.names} panel={panelOf(sel)} preview={preview} />;
  }
}
