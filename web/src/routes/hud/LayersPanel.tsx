/**
 * The Layers list, left of the canvas: every element of the current side,
 * under a few headings (GROUPS), with an eye that shows or hides it, dimmed
 * while hidden. The Teammates expand to their cards (the three drawn, and in
 * Free the fourth, which shows only while spectating), the Infected
 * teammates to their three, and every element
 * with a child registry entry expands to its pieces (the teammate card's,
 * splatter included), which
 * makes this the one way to reach a hidden, tiny or state-only piece (the
 * splatter itself is also reachable on the canvas now, where no other piece
 * covers it; mock.ts's childAt). Click
 * selects and Shift+click adds, by the same rule as the canvas
 * (selection.ts's pick), and it takes the canvas's keys (arrows, Delete,
 * Escape, Ctrl+A) while a row has focus.
 *
 * The Tab screen is a group of its own on both sides: its elements and their
 * pieces are listed like the others, a row panel's pieces under In every row
 * (code places each row, so there is no row to pick on its own). Picking one
 * draws the Tab screen, as a picked occasional panel is drawn.
 */
import { useState } from 'preact/hooks';
import type { HudDesign } from '../../hud/design';
import { elementRect, panelChild } from '../../hud/build';
import { panelChildren, type StateArt } from '../../hud/children';
import { probe } from '../../hud/probes';
import { visibleElements, type Side } from '../../hud/mock';
import type { HudElement } from '../../hud/elements';
import { cardsOf, pickableCards, panelOf, type Selection } from '../../hud/selection';
import { hiddenWith } from '../../hud/edit';

/** State pieces the game shows only sometimes, and when: read from the registry's stateArt. */
const WHEN: Record<StateArt, string> = {
  down: 'shown when down', dead: 'shown when dead', talking: 'shown when talking', crouched: 'shown when crouched', ghost: 'shown as a ghost',
  ability: 'shown on a spawned Smoker, Boomer or Tank',
};

/**
 * The list's headings, in the order shown: what each group of elements is
 * for, so a long list reads as a few short ones. Only the list groups
 * this way; the registry order (elements.ts) still decides the canvas.
 * An element no group names falls into the last group.
 */
const TAB_IDS = ['tabBoard', 'tabVersus', 'tabSurvivors', 'tabInfected'];
const GROUPS: Record<Side, { title: string; ids: string[] }[]> = {
  survivor: [
    { title: 'You', ids: ['ownHealth', 'weaponSelection', 'progressBar', 'ownMic', 'xhair'] },
    { title: 'Team', ids: ['teamColumn', 'perilNotice', 'leavingArea'] },
    { title: 'Messages', ids: ['chat', 'killNotices', 'vote', 'voiceList'] },
    { title: 'Finales and Survival', ids: ['finaleMeter', 'holdoutTimer'] },
    { title: 'Tab screen', ids: TAB_IDS },
  ],
  infected: [
    { title: 'You', ids: ['siHealth', 'abilityRing', 'abilityMarker', 'tankPanel', 'ownMic', 'xhair'] },
    { title: 'Spawning', ids: ['ghostPanel', 'spawnCountdown', 'zombiePanel'] },
    { title: 'Team', ids: ['infectedRow', 'infectedVoice'] },
    { title: 'Messages', ids: ['chat', 'killNotices', 'vote', 'voiceList'] },
    { title: 'Tab screen', ids: TAB_IDS },
  ],
};

/** Whether a top row starts unfolded. Tests that reach pieces directly set it (their page predates folding). */
let foldDefaultOpen = false;
export function _setFoldDefault(open: boolean): void { foldDefaultOpen = open; }

/** Whether one row's target is part of the selection. */
function isIn(sel: Selection, target: Selection): boolean {
  if (sel.kind === 'elements' && target.kind === 'elements') return sel.ids.includes(target.ids[0]);
  if (sel.kind === 'cards' && target.kind === 'cards') return panelOf(sel) === panelOf(target) && sel.cards.includes(target.cards[0]);
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
  { label, depth, active, hidden, note, onPick, onEye, fold }: {
    label: string; depth: 0 | 1 | 2; active: boolean; hidden: boolean; note?: string;
    onPick: (shift: boolean) => void; onEye?: (visible: boolean) => void;
    /** A top row with pieces under it: whether they show, and the arrow that folds them. */
    fold?: { open: boolean; onToggle: () => void };
  },
) {
  return (
    <div class={`hud__layer hud__layer--d${depth}${active ? ' is-active' : ''}${hidden ? ' hud__layer--hidden' : ''}`}>
      {depth === 0 && (fold
        ? (
          <button
            type="button" class={`hud__fold${fold.open ? ' is-open' : ''}`} aria-expanded={fold.open}
            aria-label={`${fold.open ? 'Fold' : 'Unfold'} ${label}`} onClick={fold.onToggle}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </button>
        )
        : <span class="hud__fold" aria-hidden="true" />)}
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

/** The side's elements under GROUPS' headings, each group in registry order; empty groups dropped. */
function grouped(els: HudElement[], side: Side): { title: string; els: HudElement[] }[] {
  const groups = GROUPS[side];
  const out = groups.map((g) => ({ title: g.title, els: [] as HudElement[] }));
  for (const el of els) {
    const i = groups.findIndex((g) => g.ids.includes(el.id));
    out[i < 0 ? out.length - 1 : i].els.push(el);
  }
  return out.filter((g) => g.els.length > 0);
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
  // A piece picked here keeps the card the selection was in (of its own panel), for the handles and the breadcrumb.
  const cardIn = (panel: string) => (sel.kind === 'children' && panelOf(sel) === panel ? sel.card
    : sel.kind === 'cards' && panelOf(sel) === panel ? sel.cards[0] : 0);
  const cardsOfPanel = (panel: string) => Array.from({ length: pickableCards(design, panel) }, (_, i) => i);
  // A top row's pieces are folded away until opened, so the list fits a screen; the element being
  // edited (itself, a card or a piece of it) opens on its own. A click on the arrow overrides either way.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const holdsSelection = (id: string) => (sel.kind === 'elements' ? sel.ids.includes(id) : sel.kind !== 'none' && panelOf(sel) === id);
  const isOpen = (id: string) => folds[id] ?? (foldDefaultOpen || holdsSelection(id));
  return (
    <nav class="hud__layers" aria-label="Layers" onKeyDown={onKeyDown}>
      <p class="eyebrow">{side === 'survivor' ? 'Survivor HUD' : 'Infected HUD'}</p>
      {grouped(visibleElements(side, design), side).map(({ title, els }) => (
        <section key={title} class="hud__layergroup" aria-label={title}>
          <h3 class="hud__layergroup-title">{title}</h3>
          {els.map((el) => {
            const target: Selection = { kind: 'elements', ids: [el.id] };
            const reg = panelChildren(el.id);
            const foldable = !!reg && (reg.repeat === 'cards' || reg.children.length > 0);
            // A card level: the teammate and infected cards. The Tab rows repeat per player but code places each one.
            const cards = reg?.repeat === 'cards' && !el.tab;
            const open = foldable && isOpen(el.id);
            return (
              <div key={el.id} role="group" aria-label={`Layers: ${el.label}`}>
                <Row
                  label={el.label} depth={0} active={isIn(sel, target)} hidden={!elementRect(design, el.id, design.aspect).visible}
                  onPick={(shift) => onPick(target, shift)}
                  onEye={el.props.includes('visible') && (!el.hideGate || probe(el.hideGate)) ? (v) => onVisible(target, v) : undefined}
                  fold={foldable ? { open, onToggle: () => setFolds((f) => ({ ...f, [el.id]: !open })) } : undefined}
                />
                {open && cards && cardsOfPanel(el.id).map((i) => {
                  const t = cardsOf([i], el.id);
                  return <Row key={`card${i}`} label={`Card ${i + 1}`} depth={1} active={isIn(sel, t)} hidden={false} onPick={(shift) => onPick(t, shift)} />;
                })}
                {/* A card's pieces are one set every card shares: under their own heading, not after Card 3 as if its own. */}
                {open && reg?.repeat === 'cards' && <p class="hud__layer hud__layer--d1 hud__layersub">{cards ? 'In every card' : 'In every row'}</p>}
                {open && reg?.children.filter((def) => !def.gate || probe(def.gate)).map((def) => {
                  const depth = reg.repeat === 'cards' ? 2 : 1;
                  // A hide waiting on a probe (ChildDef.hideGate) offers no eye; nor does a piece
                  // pinned to a hidden one, which the game hides with it (shown by showing that one).
                  const head = hiddenWith(design, el.id, def.name);
                  const hides = (!def.hideGate || probe(def.hideGate)) && !head;
                  const info = panelChild(design, el.id, def.name);
                  if (!info) {
                    return def.addable ? (
                      <div key={def.name} class={`hud__layer hud__layer--d${depth}`}>
                        <button type="button" class="hud__layername hud__layeradd" onClick={() => onAdd(def.name, el.id)}>{`＋ ${def.label}`}</button>
                      </div>
                    ) : null;
                  }
                  const t: Selection = el.id === 'teamColumn'
                    ? { kind: 'children', names: [def.name], card: cardIn(el.id) }
                    : { kind: 'children', names: [def.name], card: cardIn(el.id), panel: el.id };
                  return (
                    <Row
                      key={def.name} label={def.label} depth={depth} active={isIn(sel, t)} hidden={!info.visible || !!head}
                      note={head ? `Hidden with ${head.label}` : def.stateArt && WHEN[def.stateArt]}
                      onPick={(shift) => onPick(t, shift)} onEye={hides ? (v) => onVisible(t, v) : undefined}
                    />
                  );
                })}
              </div>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
