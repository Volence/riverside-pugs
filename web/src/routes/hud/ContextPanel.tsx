/**
 * The side panel's controls: what the selection can do. Built only from the
 * registries (elements.ts, children.ts), with every default read back from
 * the generator, so a freshly reset thing shows real numbers.
 */
import {
  clampOverride, clampChild, type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../../hud/design';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, cardChild, baseHasChild, isFreeTeam } from '../../hud/build';
import { teamChild } from '../../hud/children';
import {
  cardOffset, withTeamDir, freeInPlace, cardBoxes, placeCard, placeCards, alignCards, placeElement, patchChild, resetElement, resetChild,
  startsOf, placeChildren, alignChildren, alignElements, setChildrenVisible, resetChildren, setSelectionVisible, type Align,
} from '../../hud/edit';
import { unionBox } from '../../hud/guides';
import type { CrosshairState } from '../../crosshair/draw';
import { CrosshairControls } from './CrosshairControls';
import { TEAMMATES, type Selection } from '../../hud/selection';
import {
  Slider, Field, patchNum, endsOn, hexOf, alphaPct, withHex, withAlphaPct, type Edit, type EditMode, type Patch,
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

/**
 * The controls for whichever element is selected, built only from what its
 * registry entry allows. `elementRect` supplies every default shown when the
 * design has no override yet, so a freshly reset element shows real numbers
 * rather than blanks.
 */
export function ElementControls(
  { design, edit, end, id, crosshair = null }: { design: HudDesign; edit: Edit; end: () => void; id: string; crosshair?: CrosshairState | null },
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

      {id === 'xhair' && <CrosshairControls design={design} edit={edit} crosshair={crosshair} />}

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
  { design, sel, edit, end, onSelect, onWentFree, crosshair }: {
    design: HudDesign; sel: Selection; edit: Edit; end: () => void; onSelect: (s: Selection) => void; onWentFree: () => void;
    /** The crosshair saved on the Crosshair page, or null: what a 'bundle' ships. */
    crosshair: CrosshairState | null;
  },
) {
  switch (sel.kind) {
    case 'none':
      return (
        <>
          <p class="muted">Select an element on the canvas or in Layers. A click picks the piece under the pointer; a drag moves the card or element under it.</p>
          <CrosshairControls design={design} edit={edit} crosshair={crosshair} />
        </>
      );
    case 'elements':
      return sel.ids.length === 1
        ? <ElementControls design={design} edit={edit} end={end} id={sel.ids[0]} crosshair={crosshair} />
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
