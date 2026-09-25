/**
 * The Tab screen's layout step (tab screen spec 3.2, task 12): where each
 * block of a Tab file sits, as VGUI lays the panel out, in HUD units inside
 * its parent. Three things the other panels never needed:
 *
 * - **if_embedded.** The versus score panel is embedded in the scoreboard,
 *   and every child's `if_embedded` sub-block overrides its plain keys there
 *   (spec 1.6: TeamYours' xpos 20, not 25, puts Modern's red box's left edge
 *   at 78 px; StatBreakdownHighlightImage's wide 320 spans 33 to 753 px).
 *   TS8 (/home/volence/l4d/hud/probe-tab/RESULTS.md, TAB-2) showed a key
 *   stock does not put there works too, so every key is laid over.
 * - **auto_wide_tocontents.** A Label so marked is as wide as its text
 *   (VGUI Label::GetContentSize with no text inset): "Average Distance:"
 *   ends where its glyphs do, and the amount pinned to it starts 10 units on.
 * - **pin_to_sibling.** A pinned block's corner (pin_corner_to_sibling) is
 *   put on its sibling's corner (pin_to_sibling_corner), offset by its own
 *   xpos and ypos. Corners are VGUI's: 0 top-left, 1 top-right, 2
 *   bottom-left, 3 bottom-right. A block pinned to a hidden one is hidden:
 *   TAB-1 hid HealthLabel alone and HealthAmount went with it (TS7).
 *
 * Pure: it reads a tree and measures text through the caller, so the
 * painter (tabscreen.ts) and a hit test can share it.
 */
import { pcApplies, pcBlocks, pcFind, kvGet, type KvNode } from './kv';
import { parsePos, parseSize } from './units';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A block as the embedded panel reads it: its value lines the PC keeps
 * (conditionals dropped once they hold), with its if_embedded block's lines
 * over them, a key the plain block lacks added. Sub-blocks other than
 * if_embedded are kept as they are. A block with no if_embedded reads as its
 * PC lines alone.
 */
export function embeddedView(block: KvNode): KvNode {
  if (typeof block.value === 'string') return block;
  const lines = block.value.filter((c) => typeof c.value === 'string' && pcApplies(c.cond)).map((c) => ({ key: c.key, value: c.value }));
  const emb = pcFind(block.value, ['if_embedded']);
  if (emb && typeof emb.value !== 'string') {
    for (const c of emb.value) {
      if (typeof c.value !== 'string' || !pcApplies(c.cond)) continue;
      const at = lines.find((l) => same(l.key, c.key));
      if (at) at.value = c.value; else lines.push({ key: c.key, value: c.value });
    }
  }
  const blocks = block.value.filter((c) => typeof c.value !== 'string' && !same(c.key, 'if_embedded'));
  return { key: block.key, value: [...lines, ...blocks] };
}

/** A block laid out: its view (embeddedView's when the panel is embedded), its rect in units inside the parent, and whether it shows. */
export interface LaidBlock { name: string; node: KvNode; x: number; y: number; w: number; h: number; visible: boolean }

export interface LayoutOpts {
  /** The parent's size in units: what r, c and f measure from. */
  w: number; h: number;
  /** Read each child through its if_embedded block (PanelChildren.embedded: the versus panel). */
  embedded?: boolean;
  /** What a label shows, for auto_wide_tocontents; '' when it shows nothing. */
  textOf: (n: KvNode) => string;
  /** Its width in units, in the label's own font. */
  measure: (n: KvNode, text: string) => number;
}

/** A corner of a rect, numbered as VGUI numbers them. */
export function cornerOf(r: { x: number; y: number; w: number; h: number }, corner: number): { x: number; y: number } {
  return { x: r.x + (corner === 1 || corner === 3 ? r.w : 0), y: r.y + (corner === 2 || corner === 3 ? r.h : 0) };
}

const num = (v: string | undefined) => { const f = parseFloat(v ?? ''); return Number.isFinite(f) ? f : 0; };

/**
 * Every block of a panel the PC game keeps (kv.ts pcBlocks: no console-only
 * block), in file order, laid out: place and size from the file (through
 * if_embedded when `embedded`), an auto_wide_tocontents label as wide as its
 * text, and a pinned block placed from its sibling, down the chain. A pin
 * loop or a missing sibling leaves the block where its own keys put it.
 */
export function layoutBlocks(nodes: KvNode[], opts: LayoutOpts): LaidBlock[] {
  const blocks = pcBlocks(nodes);
  const own = blocks.map((b) => {
    const node = opts.embedded ? embeddedView(b) : embeddedPlain(b);
    const get = (k: string) => kvGet(node, k);
    let w = parseSize(get('wide') ?? '0', opts.w);
    if (get('auto_wide_tocontents') === '1') w = opts.measure(node, opts.textOf(node));
    return {
      name: b.key, node, x: parsePos(get('xpos') ?? '0', opts.w), y: parsePos(get('ypos') ?? '0', opts.h),
      w, h: parseSize(get('tall') ?? '0', opts.h), visible: (get('visible') ?? '1') !== '0',
    };
  });
  const done = new Map<LaidBlock, LaidBlock>();
  const busy = new Set<LaidBlock>();
  const resolve = (b: LaidBlock): LaidBlock => {
    const hit = done.get(b);
    if (hit) return hit;
    const pin = kvGet(b.node, 'pin_to_sibling');
    const sib = pin ? own.find((s) => same(s.name, pin)) : undefined;
    if (!sib || busy.has(sib) || sib === b) { done.set(b, b); return b; }
    busy.add(b);
    const s = resolve(sib);
    busy.delete(b);
    const at = cornerOf(s, num(kvGet(b.node, 'pin_to_sibling_corner')));
    const self = cornerOf({ x: 0, y: 0, w: b.w, h: b.h }, num(kvGet(b.node, 'pin_corner_to_sibling')));
    // The block's own xpos and ypos are the offset from the sibling's corner.
    const out = { ...b, x: at.x - self.x + num(kvGet(b.node, 'xpos')), y: at.y - self.y + num(kvGet(b.node, 'ypos')), visible: b.visible && s.visible };
    done.set(b, out);
    return out;
  };
  return own.map(resolve);
}

/** A block's PC lines alone, for a panel that is not embedded: the same view with no if_embedded laid over. */
function embeddedPlain(block: KvNode): KvNode {
  if (typeof block.value === 'string') return block;
  const kept = block.value.filter((c) => !same(c.key, 'if_embedded'));
  return embeddedView({ key: block.key, value: kept });
}
