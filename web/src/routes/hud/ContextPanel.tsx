/**
 * The side panel's controls: what the selection can do. Built only from the
 * registries (elements.ts, children.ts), with every default read back from
 * the generator, so a freshly reset thing shows real numbers.
 */
import {
  clampOverride, clampChild, clampWeapon, WEAPON_KEYS, WEAPON_BOX_COLOUR,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
  type WeaponNumKey, type WeaponsOverride, type WeaponBoxStyle,
} from '../../hud/design';
import { weaponKey } from '../../hud/weapons';
import { fontFace } from '../../hud/render';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, cardChild, baseHasChild, isFreeTeam } from '../../hud/build';
import { teamChild } from '../../hud/children';
import {
  cardOffset, withTeamDir, freeInPlace, cardBoxes, placeCard, placeCards, alignCards, placeElement, patchChild, resetElement, resetChild,
  startsOf, placeChildren, alignChildren, alignElements, setChildrenVisible, resetChildren, setSelectionVisible, patchWeapons, ammoOnly,
  type Align,
} from '../../hud/edit';
import { unionBox } from '../../hud/guides';
import { CrosshairControls } from './CrosshairControls';
import { TEAMMATES, type Selection } from '../../hud/selection';
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
      {team.file ? (
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
      ) : (
        <label class="hud__row">
          <span>Spacing</span>
          <input
            type="number" value={t.spacing}
            onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))} {...endsOn(end)}
          />
          <span />
        </label>
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
        and the pistol always sits just under the main gun.
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
export function ElementControls(
  { design, edit, end, id }: { design: HudDesign; edit: Edit; end: () => void; id: string },
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
  // Anything else shows and patches what it stores.
  const team = !!el.team;
  const setPos = (key: 'x' | 'y', e: Event) => {
    if (!team) { patchNum(patch, e, key, (n) => ({ [key]: n })); return; }
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const r = elementRect(d, id, d.aspect);
      const s = d.elements[id] ?? {};
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

      {!el.move && (
        <p class="muted hud__note">The game places this one. It can be hidden but not moved.</p>
      )}

      {id === 'xhair' && <CrosshairControls design={design} edit={edit} end={end} full />}

      {id === 'siHealth' && (
        <p class="muted hud__note">Shown as the Hunter; the Tank uses the same file.</p>
      )}

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

      {id === 'weaponSelection' && <WeaponControls design={design} edit={edit} end={end} />}

      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>
    </Field>
  );
}

/**
 * The controls for one child of the teammate card, built only from its
 * registry entry. Numbers are unscaled units in the card file's own frame
 * (what a ChildOverride stores), read back through cardChild so a child
 * with no edits shows real numbers. Square art gets one Size; labels a text
 * size and, where the game honours it, a colour.
 */
export function ChildControls(
  { design, edit, end, name, onBack }: {
    design: HudDesign; edit: Edit; end: () => void; name: string; onBack: () => void;
  },
) {
  const def = teamChild(name);
  const info = cardChild(design, name);
  if (!def || !info) return null;
  const o = design.children.teamColumn?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>, mode: EditMode = 'step') => edit((d) => patchChild(d, name, p), mode);
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
  const reset = () => edit((d) => resetChild(d, name));

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
      {def.colour && (
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
      {def.note && <p class="muted hud__note">{def.note}</p>}
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
      {def.addable && !baseHasChild(design.preset, name) && (
        <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => patchChild(d, name, { on: false }))}>
          {`Remove the ${def.label.toLowerCase()}`}
        </button>
      )}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>Back to Teammates</button>
    </Field>
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
 * Several pieces of the teammate card: the group's X and Y (the box around
 * them, in the card file's frame, moving all of them), Align, Visible for
 * all and Reset all. Every edit is the one card file, so every card follows.
 */
export function PiecesControls({ design, edit, end, names }: { design: HudDesign; edit: Edit; end: () => void; names: string[] }) {
  const box = unionBox(Object.values(startsOf(design, names)));
  if (!box) return null;
  const allVisible = names.every((n) => cardChild(design, n)?.visible);
  const place = (key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const b = unionBox(Object.values(startsOf(d, names)));
      return b ? placeChildren(d, names, key === 'x' ? n : b.x, key === 'y' ? n : b.y) : d;
    }, 'gesture');
  };
  return (
    <Field legend={`${names.length} pieces in the teammate card`}>
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
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
      <AlignRow onAlign={(how) => edit((d) => alignChildren(d, names, how))} />
      <label class="hud__check">
        <input
          type="checkbox" checked={allVisible}
          onChange={(e) => { const v = (e.target as HTMLInputElement).checked; edit((d) => setChildrenVisible(d, names, v)); }}
        />
        <span>Visible</span>
      </label>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => resetChildren(d, names))}>Reset all</button>
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

/** The right-hand panel: only what the selection can do. */
export function ContextPanel(
  { design, sel, edit, end, onSelect, onWentFree }: {
    design: HudDesign; sel: Selection; edit: Edit; end: () => void; onSelect: (s: Selection) => void; onWentFree: () => void;
  },
) {
  switch (sel.kind) {
    case 'none':
      return (
        <>
          <p class="muted">Select an element on the canvas or in Layers. A click picks the piece under the pointer; a drag moves the card or element under it.</p>
          <CrosshairControls design={design} edit={edit} end={end} />
        </>
      );
    case 'elements':
      return sel.ids.length === 1
        ? <ElementControls design={design} edit={edit} end={end} id={sel.ids[0]} />
        : <ElementsControls design={design} edit={edit} ids={sel.ids} />;
    case 'cards':
      return sel.cards.length === 1
        ? <CardControls design={design} edit={edit} end={end} card={sel.cards[0]} onWentFree={onWentFree} />
        : <CardsControls design={design} edit={edit} end={end} cards={sel.cards} onWentFree={onWentFree} />;
    case 'children':
      return sel.names.length === 1
        ? <ChildControls design={design} edit={edit} end={end} name={sel.names[0]} onBack={() => onSelect(TEAMMATES)} />
        : <PiecesControls design={design} edit={edit} end={end} names={sel.names} />;
  }
}
