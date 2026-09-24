/**
 * The Layers list, left of the canvas: every element of the current side in
 * registry order, with an eye that shows or hides it, struck through while
 * hidden. The Teammates expand to their cards (the three drawn, and in
 * Free the fourth, which shows only while spectating), and every element
 * with a child registry entry expands to its pieces (the teammate card's,
 * splatter included), which
 * makes this the one way to reach a hidden, tiny or state-only piece (the
 * splatter itself is also reachable on the canvas now, where no other piece
 * covers it; mock.ts's childAt). Click
 * selects and Shift+click adds, by the same rule as the canvas
 * (selection.ts's pick), and it takes the canvas's keys (arrows, Delete,
 * Escape, Ctrl+A) while a row has focus.
 */
import type { HudDesign } from '../../hud/design';
import { elementRect, panelChild } from '../../hud/build';
import { panelChildren, type StateArt } from '../../hud/children';
import { visibleElements, type Side } from '../../hud/mock';
import { cardsOf, pickableCards, panelOf, type Selection } from '../../hud/selection';

/** State pieces the game shows only sometimes, and when: read from the registry's stateArt. */
const WHEN: Record<StateArt, string> = {
  down: 'shown when down', dead: 'shown when dead', talking: 'shown when talking', crouched: 'shown when crouched', ghost: 'shown as a ghost',
};

/** Whether one row's target is part of the selection. */
function isIn(sel: Selection, target: Selection): boolean {
  if (sel.kind === 'elements' && target.kind === 'elements') return sel.ids.includes(target.ids[0]);
  if (sel.kind === 'cards' && target.kind === 'cards') return sel.cards.includes(target.cards[0]);
  if (sel.kind === 'children' && target.kind === 'children') return panelOf(sel) === panelOf(target) && sel.names.includes(target.names[0]);
  return false;
}

function Eye({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {hidden && <path d="M2 14L14 2" stroke="currentColor" stroke-width="1.5" />}
    </svg>
  );
}

/**
 * One row: the name, and under it on its own line when the game shows a
 * state piece. The 190px column cannot fit both on one line, and the name
 * is what the row is for, so it wraps rather than being cut short.
 */
function Row(
  { label, depth, active, hidden, note, onPick, onEye }: {
    label: string; depth: 0 | 1; active: boolean; hidden: boolean; note?: string;
    onPick: (shift: boolean) => void; onEye?: (visible: boolean) => void;
  },
) {
  return (
    <div class={`hud__layer hud__layer--d${depth}${active ? ' is-active' : ''}${hidden ? ' hud__layer--hidden' : ''}`}>
      <span class="hud__layertext">
        <button type="button" class="hud__layername" onClick={(e) => onPick(e.shiftKey)}>{label}</button>
        {note && <span class="hud__layernote">{note}</span>}
      </span>
      {onEye && (
        <button type="button" class="hud__eye" aria-label={`${hidden ? 'Show' : 'Hide'} ${label}`} onClick={() => onEye(hidden)}>
          <Eye hidden={hidden} />
        </button>
      )}
    </div>
  );
}

export function LayersPanel(
  { design, side, sel, onPick, onVisible, onAdd, onKeyDown }: {
    design: HudDesign; side: Side; sel: Selection;
    onPick: (target: Selection, shift: boolean) => void;
    onVisible: (target: Selection, visible: boolean) => void;
    onAdd: (name: string, panel: string) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  },
) {
  // A piece picked here keeps the teammate card the selection was in, for the handles and the breadcrumb.
  const card = sel.kind === 'children' && panelOf(sel) === 'teamColumn' ? sel.card : sel.kind === 'cards' ? sel.cards[0] : 0;
  const cards = Array.from({ length: pickableCards(design) }, (_, i) => i);
  return (
    <nav class="hud__layers" aria-label="Layers" onKeyDown={onKeyDown}>
      <p class="eyebrow">{side === 'survivor' ? 'Survivor HUD' : 'Infected HUD'}</p>
      {visibleElements(side, design).map((el) => {
        const target: Selection = { kind: 'elements', ids: [el.id] };
        const reg = panelChildren(el.id);
        return (
          <div key={el.id} role="group" aria-label={`Layers: ${el.label}`}>
            <Row
              label={el.label} depth={0} active={isIn(sel, target)} hidden={!elementRect(design, el.id, design.aspect).visible}
              onPick={(shift) => onPick(target, shift)}
              onEye={el.props.includes('visible') ? (v) => onVisible(target, v) : undefined}
            />
            {el.id === 'teamColumn' && cards.map((i) => {
              const t = cardsOf([i]);
              return <Row key={`card${i}`} label={`Card ${i + 1}`} depth={1} active={isIn(sel, t)} hidden={false} onPick={(shift) => onPick(t, shift)} />;
            })}
            {reg?.children.map((def) => {
              const info = panelChild(design, el.id, def.name);
              if (!info) {
                return def.addable ? (
                  <div key={def.name} class="hud__layer hud__layer--d1">
                    <button type="button" class="hud__layername hud__layeradd" onClick={() => onAdd(def.name, el.id)}>{`＋ ${def.label}`}</button>
                  </div>
                ) : null;
              }
              const t: Selection = el.id === 'teamColumn'
                ? { kind: 'children', names: [def.name], card }
                : { kind: 'children', names: [def.name], card: 0, panel: el.id };
              return (
                <Row
                  key={def.name} label={def.label} depth={1} active={isIn(sel, t)} hidden={!info.visible} note={def.stateArt && WHEN[def.stateArt]}
                  onPick={(shift) => onPick(t, shift)} onEye={(v) => onVisible(t, v)}
                />
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
