/**
 * The side panel's controls: what the selection can do. Built only from the
 * registries (elements.ts, children.ts), with every default read back from
 * the generator, so a freshly reset thing shows real numbers.
 */
import {
  clampOverride, clampChild, type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../../hud/design';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, cardChild, baseHasChild } from '../../hud/build';
import { TEAM_PANEL, teamChild } from '../../hud/children';
import { cardOffset, withTeamDir, placeCard, patchChild, resetElement, resetChild } from '../../hud/edit';
import { Slider, Field, patchNum, hexOf, alphaPct, withHex, withAlphaPct, type Patch, type SetDesign } from './controls';

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
  { design, setDesign, el, o, patch, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: SetDesign; el: HudElement; o: ElementOverride;
    patch: Patch; selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  if (!el.team) return null;
  const team = el.team;
  const t = teamLayout(design, el);
  const options = team.file ? (['row', 'column', 'free'] as const) : team.dirs;
  const onLayoutChange = (e: Event) => {
    const dir = (e.target as HTMLSelectElement).value as TeamDir;
    if (team.file) { onPickCard(null); setDesign((d) => withTeamDir(d, dir)); }
    else patch({ dir: dir as 'row' | 'column' });
  };
  // The boxes show and take where the card is drawn, the slot plus the fit offset.
  const off = cardOffset(design);
  const setSlot = (i: number, key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    setDesign((d) => {
      const cur = d.elements.teamColumn?.slots?.[i];
      if (!cur) return d;
      const o2 = cardOffset(d);
      return placeCard(d, i, key === 'x' ? n : cur.x + o2.x, key === 'y' ? n : cur.y + o2.y);
    });
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
              onInput={(gap) => patch({ gap: clampOverride('gap', gap) })}
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
              {selectedCard !== null && <p class="hud__note">{`Teammate card ${selectedCard + 1}`}</p>}
              {o.slots.map((s, i) => (
                <div class="hud__row2" key={i}>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} X`}</span>
                    <input type="number" value={Math.round(s.x + off.x)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'x', e)} />
                  </label>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} Y`}</span>
                    <input type="number" value={Math.round(s.y + off.y)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'y', e)} />
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
            onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))}
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
  { design, setDesign, id, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: SetDesign; id: string;
    selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  // In Free each card places itself, so the element's own X and Y would move nothing.
  const free = !!el.team?.file && teamLayout(design, el).dir === 'free';
  const patch: Patch = (p) => setDesign((d) => (
    { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), ...p } } }
  ));
  const reset = () => setDesign((d) => resetElement(d, id));

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

      {id === 'xhair' && (
        <>
          <label class="hud__check">
            <input
              type="checkbox" checked={design.hideGameCrosshair === true}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setDesign((d) => {
                  const next = { ...d };
                  if (on) next.hideGameCrosshair = true; else delete next.hideGameCrosshair;
                  return next;
                });
              }}
            />
            <span>Hide the game's crosshair</span>
          </label>
          <p class="muted hud__note">Hides the game's own crosshair so an image crosshair can replace it.</p>
        </>
      )}

      {id === 'siHealth' && (
        <p class="muted hud__note">Shown as the Hunter; the Tank uses the same file.</p>
      )}

      {el.move && !free && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(o.x ?? rect.x)} onInput={(e) => patchNum(patch, e, 'x', (x) => ({ x }))} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(o.y ?? rect.y)} onInput={(e) => patchNum(patch, e, 'y', (y) => ({ y }))} />
          </label>
        </div>
      )}

      {el.resize === 'free' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input
              type="number" min={20} value={Math.round(o.w ?? rect.w)}
              onInput={(e) => patchNum(patch, e, 'w', (n) => ({ w: Math.max(20, n) }))}
            />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input
              type="number" min={20} value={Math.round(o.h ?? rect.h)}
              onInput={(e) => patchNum(patch, e, 'h', (n) => ({ h: Math.max(20, n) }))}
            />
          </label>
        </div>
      )}

      {el.resize === 'scale' && (
        <Slider label="Scale" value={o.scale ?? 1} min={0.5} max={2} step={0.05} onInput={(scale) => patch({ scale })} />
      )}

      <TeamControls design={design} setDesign={setDesign} el={el} o={o} patch={patch} selectedCard={selectedCard} onPickCard={onPickCard} />

      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>
    </Field>
  );
}

/**
 * The teammate card's insides: one pill per registry child, struck through
 * when hidden, and the only way to reach a hidden or tiny one, as the
 * element list is for elements. A child the preset's file lacks (the stock
 * health number) is a checkbox that adds it; once added it gets a pill too.
 */
export function ChildList(
  { design, setDesign, selectedChild, onPick }: {
    design: HudDesign; setDesign: SetDesign;
    selectedChild: string | null; onPick: (name: string) => void;
  },
) {
  return (
    <Field legend="Inside the card">
      <div class="hud__list">
        {TEAM_PANEL.children.map((def) => {
          const info = cardChild(design, def.name);
          if (!info) return null;                              // an addable child that is off: its checkbox is below
          return (
            <button
              key={def.name} type="button"
              class={`hud__pill${def.name === selectedChild ? ' is-active' : ''}${info.visible ? '' : ' hud__pill--hidden'}`}
              onClick={() => onPick(def.name)}
            >
              {def.label}
            </button>
          );
        })}
      </div>
      {TEAM_PANEL.children.filter((def) => def.addable && !baseHasChild(design.preset, def.name)).map((def) => (
        <label key={def.name} class="hud__check">
          <input
            type="checkbox" checked={design.children.teamColumn?.[def.name]?.on === true}
            onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setDesign((d) => patchChild(d, def.name, { on })); }}
          />
          <span>{def.label}</span>
        </label>
      ))}
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
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
  { design, setDesign, name, onBack }: {
    design: HudDesign; setDesign: SetDesign; name: string; onBack: () => void;
  },
) {
  const def = teamChild(name);
  const info = cardChild(design, name);
  if (!def || !info) return null;
  const o = design.children.teamColumn?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>) => setDesign((d) => patchChild(d, name, p));
  // The same guard and clamp as patchNum, through the child table.
  const num = (e: Event, key: ChildRangeKey, to: (n: number) => Partial<ChildOverride>) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) patch(to(clampChild(key, n)));
  };
  const colour = o.color ?? info.color ?? '255 255 255 255';
  const reset = () => setDesign((d) => resetChild(d, name));

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
            <input type="number" value={Math.round(info.x)} onInput={(e) => num(e, 'x', (x) => ({ x }))} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(info.y)} onInput={(e) => num(e, 'y', (y) => ({ y }))} />
          </label>
        </div>
      )}
      {def.box === 'wh' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (w) => ({ w }))} />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input type="number" value={Math.round(info.h)} onInput={(e) => num(e, 'h', (h) => ({ h }))} />
          </label>
        </div>
      )}
      {def.box === 'square' && (
        <label class="hud__row">
          <span>Size</span>
          <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (s) => ({ w: s, h: s }))} />
          <span />
        </label>
      )}
      {def.font && (
        <label class="hud__row">
          <span>{def.box === 'none' ? 'Icon size' : 'Text size'}</span>
          <input type="number" min={6} max={64} value={o.fontSize ?? info.fontTall ?? 12} onInput={(e) => num(e, 'fontSize', (fontSize) => ({ fontSize }))} />
          <span />
        </label>
      )}
      {def.colour && (
        <div class="hud__stylerow">
          <span class="hud__stylerow-label">Colour</span>
          <input
            type="color" aria-label={`${def.label} colour`} value={hexOf(colour)}
            onInput={(e) => patch({ color: withHex(colour, (e.target as HTMLInputElement).value) })}
          />
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(colour)}
            onInput={(e) => patch({ color: withAlphaPct(colour, parseFloat((e.target as HTMLInputElement).value)) })}
          />
        </div>
      )}
      {def.note && <p class="muted hud__note">{def.note}</p>}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>Back to Teammates</button>
    </Field>
  );
}
