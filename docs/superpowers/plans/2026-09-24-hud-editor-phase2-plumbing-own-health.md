# HUD Editor Phase 2, slices 2.0 and 2.1: shared plumbing and own health insides, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Hand an implementer one or two tasks at a time, in order.

> **Runs AFTER the custom splatter plan lands.** `docs/superpowers/plans/2026-09-24-hud-editor-custom-splatter.md` is being implemented in this same worktree and touches `build.ts`, `render.ts`, `design.ts`, `textures.ts`, `edit.ts`, `children.ts`, `Hud.tsx` and adds `splatter.ts`. Do not start Task 0 until its Task 7 commit ("Check a splatter download with the independent VPK and VTF readers") is on the branch (`git log --oneline | grep -i "splatter download"`). Its Task 8 (the in-game check) may still be pending: it only edits the splatter spec. Every line number below is from 1886f03 and will have moved: find code by the names given, never by line.

**Goal:** Slice 2.0 turns the teammate-card-only machinery (child registry, childPass, fitPass, hidePass, selection levels, Layers, ContextPanel, the preview state) into per-panel machinery with typed file keys, an honest-registry check against client.dll, a single preview state and zpos, with every existing download byte-identical. Slice 2.1 then registers the player's own health panel on it: every piece movable, sizable and hideable, a fitted panel, a "Your health background" style, and Healthy / Hurt / Down / Crouched previews. Controls whose effect is still unproven in game ship hidden behind probe flags kept in one file.

**Architecture:** `children.ts` stays a data-only leaf and gains per-panel fields (`repeat`, `frame`, `linked`), per-child fields (`keys`, `art`, `stateArt`, `hideIn`, `fitPlace`, `colourGate`) and a `KeyDef` type. A new leaf `probes.ts` holds every probe gate. `build.ts` replaces `cardWork`/`cardFrame`/`cardChild` with `panelWork`/`panelFrame`/`panelChild` keyed by panel (the old names stay as thin wrappers), makes `fitPass` loop over per-panel fit rules, and writes typed keys with `pcSet`. `render.ts` gains `PreviewState` and reads each child's `stateArt`/`hideIn` instead of name lists. `selection.ts`, `edit.ts`, `mock.ts` and the page take a panel id wherever they took "the teammate card". Slice 2.1 is then a registry entry, one fit rule, one style slot, two exported textures and the preview states.

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md`, sections 0.1, 1.1, 3.0, 3.1, 4 (B1, B8) and 5. Read them first. Phase 1 background: `docs/superpowers/specs/2026-09-22-hud-editor-teammate-cards-design.md` and the Phase 1 plan `docs/superpowers/plans/2026-09-22-hud-editor-teammate-cards.md`. Splatter boundaries: `docs/superpowers/specs/2026-09-24-hud-editor-custom-splatter-design.md`. Project history and in-game traps: `/home/volence/.claude/projects/-home-volence-l4d/memory/pug-hud-editor.md`.

---

## Probe dependencies (flip these when the probe batch results come in)

Every gate lives in `web/src/hud/probes.ts` (Task 1), one entry per question, all `passed: false` when this plan is written. Flipping a gate is its own small task at the end of this plan (Tasks F1 to F5), never an edit hidden inside another task. Until a gate passes, its control is not shown, `validateDesign` drops any stored value for it, and the preview draws the "code decides" default.

| Probe | Batch, shot (spec section 4) | What the answer decides | Gate in `probes.ts` | Tasks that read the gate | On pass | On fail |
|---|---|---|---|---|---|---|
| **Q1** | B1 (a), (c): own `Health` + `monochrome_color "255 0 255 255"` | Whether a HUD bar's fill takes one flat file colour | `Q1` | 10 (registry key), 15 (preview flat fill), 16 (control) | Task F1 | Leave off. Record in the spec; remove the KeyDef in a 2.F cleanup |
| **Q2** | B1 (a): `LocalPlayer` `image` magenta and `wide 100` | Whether `LocalPlayer` clips its children and whether its own `image` is painted; the own-panel Fit rests on both | `Q2` | 13 (fit kept by validateDesign), 16 (Fit checkbox) | Task F2 (also turns fit on for new designs) | Leave off. If the image is painted, a 2.F item decides whether fit may resize `LocalPlayer` at all |
| **Q3** | B1 (a): own `Health` + `inset "3"`, `tall "16"` | Whether `inset` insets the fill inside `s_healthbar_outline` | `Q3` | 10, 15, 16 | Task F3 | Leave off, as Q1 |
| **Q5** | B1 (a): `HealthIcon` + `fgcolor_override "0 0 255 255"` | Whether the file's colour on the health cross survives code's health colour | `Q5` | 10 (`colourGate`), 16 | Task F4 | Leave off; the note "The game colours this by health" stays |
| **Q8** | B1 (b): `DuckingIcon` + `drawColor "255 0 255 255"`, crouched | Whether the crouch icon keeps a file tint, and that it shows only while crouched | `Q8` | 10 (`colourGate`), 16 | Task F5 | Leave off |
| Q4 | B1 (a) | Whether code's health tint beats a file `drawColor` on the scratches, and whether code re-shows a hidden scratch | none | none: no scratch tint is offered (the splatter owns the art), and the hard hide (size 0) works either way | nothing to flip | if code re-shows a 0x0 piece, a 2.F item |
| Q9 | B8 | The own Down look: `Head` hidden or not, incap art at 96x96, number 299 red | none (preview default) | 10 (`hideIn`), 15 | If `Head` stays, remove `'down'` from its `hideIn` | nothing to gate |
| S-hurt | B1 (c) | How a 40-health bar looks (fill 40 percent orange, empty part undrawn) | none (preview default) | 15 | adjust `drawBar` in 2.F | nothing to gate |

Slice 2.0 depends on no probe. Nothing in 2.0 or 2.1 depends on Q10 to Q23 or S1 to S13.

---

## Global Constraints

- FIRST RULE: never run `git stash` in any form. Never checkout, switch, reset or rebase, never move HEAD. Commit only your own files, by explicit path (`git add <path>`, never `-A` or `.`). If `.git/index.lock` blocks you, wait a few seconds and retry: another agent may be committing in the same worktree.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). No push, no deploy, no ssh, no rcon.
- Commands run from the worktree root. Tests: `npx vitest run --project web <paths>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes (or en dashes) anywhere: code, comments, UI copy, test names, commit messages. Use commas, colons or separate sentences.
- Match the surrounding comment style: block comments that say why, as in `web/src/hud/build.ts`.
- Preview equals file: the canvas draws and hit-tests only from the generator's own trees (`buildTrees`, `panelChild`, `childRects`, `elementRect`, `panelBoxes`). Nothing computes a piece's position on its own.
- **Slice 2.0 promise:** downloads of every design that exists today are byte-identical. `download.golden.test.ts` (with the cases Task 0 adds) passes unchanged through Tasks 1 to 9. Every existing test passes unchanged, with exactly one deliberate exception named in Task 8.
- **Slice 2.1 promise:** a saved design with no `ownHealth` child edits, no `ownHealth.fit` and no `ownBg` style builds the same bytes as before. The golden cases stay green through Tasks 10 to 17. Only Task F2 changes a golden hash, on purpose.
- The splatter work owns the scratch art: `HealthbarTextureTop`/`Bottom`'s `image` key, their textures, `splatterPass`, `splatter.ts`. This plan touches their position, size and hide only, plus the one seam in Task 12.
- Valve's stock art (`web/src/hud/art/`) stays preview-only: nothing `build.ts` reaches may import it (`art.test.ts`). `children.ts` and `probes.ts` import nothing but types.
- TDD: write the test, run it and capture the RED output in the task report, implement, then GREEN. Then run the whole suite and report the count.
- Small plain-English commits, at least one per task.
- When a step appends tests to an existing file, merge imports into its existing import block (one import per module).
- The local test server `/home/volence/l4d1-ds` and the owner's game are shared: never kill a srcds or game process you did not start.

## Decisions this plan locks in (made overnight, for owner review)

1. **Own fit keeps what already shows.** The spec's content box (Head, Health, HealthIcon, HealthNumber: 122x31 at (0,48) on stock) would cut the bottom scratches to one row and half the crouch icon, so "fit alone changes nothing on screen" would break. The fitted box is the union of the visible content and every visible `fitPlace: 'keep'` piece (both scratches and `DuckingIcon`), the keep pieces cut to the file's own `LocalPlayer` rect first, so a decoration never grows the panel past what the game showed before. Stock fits to **(0,32) 130x53**; with the scratches hidden, 122x47; with the crouch icon hidden too, the spec's 122x31. Modern fits to (3,3) 114x28.
2. **Fit re-places `LocalPlayer` inside an unchanged container**, the way `teamPass` places cards inside an unchanged `CHudTeamDisplay`: `localplayerdisplay.res` `LocalPlayer` gets `xpos/ypos` = the box's top-left and `wide/tall` = the box, and `hudlayout.res` `CHudLocalPlayerDisplay` is not touched by fit. The spec wrote the container instead; that would make a stored element position mean different things with fit on and off, and editing one piece would shift a moved panel. `elementRect` stays the container (what a move stores), and `elementFrame`, `hitTest` and `sectionRects` use the fitted panel's box (`panelBoxes`) so the outline hugs what is drawn, the teammate precedent.
3. **`ModBg` stays unregistered** on the own panel, as on the teammate card: the fit rule resizes it to the panel by name. The new `ownBg` style is the player's background control.
4. **One hide for the scratches.** Their splatter "None" becomes the child hide (`children.ownHealth.<block>.visible = false`), as the teammate splatter's None already is, and a stored scratch `'none'` is migrated to that on load. The download bytes are the same (both paths end in `hardHide`); Layers and the Splatter row can then never disagree.
5. **zpos is "Bring to front" / "Send to back"** (one above the highest, one below the lowest zpos in the panel's file), not a one-step forward/back: a single step is ambiguous where several pieces share a zpos. Stored as `ChildOverride.z`, clamped to -50..50.
6. **`Selection` children get an optional `panel`**; absent means `teamColumn`, so every existing selection literal and test stays valid. A single panel's pieces use `card: 0`.
7. **Child edit helpers take a trailing `panel = 'teamColumn'`** argument for the same reason.
8. **`linked` and `frame: 'hudlayout'` are typed in 2.0 but written in 2.2**, where their first user (the SI health files) and real tests arrive. 2.0 has no panel to test a link rule against.
9. **The piece clamp box** for a single panel is the union of its frame block's base rect and every child's base rect (stock own panel: 0..146 x 0..113), so a scratch that already runs past `LocalPlayer` is not yanked inside on its first nudge.
10. **Gated values are dropped on load** while their gate is off, and the build writes only keys the registry declares. A flag that flips back off therefore clears them.
11. **`ownBg` is not gated on Q2:** it is a child the panel draws (Modern's `ModBg` proves the pattern) whatever `LocalPlayer`'s own image does.
12. **Hurt** is 40 of 100 health: number "40", health colour orange (`healthRgb(40, 100, false)`), the bar filled 40 percent from the left in `healthbar_orange` and nothing drawn in the rest. It applies to teammate cards too.
13. **The honest registry file** is `strings -a -n 3 client.dll | grep -i -C 30 -E '<anchors>'` (1,327 lines, 13.6 KB at the current dll). The test demands a dll line for every `KeyDef.key` and every addable child, not for every child name: `Head`, `Dead` and `Name` are pooled literals that never appear as whole lines near the HUD code, and the stock files already prove those.

## File Structure

```
web/src/hud/probes.ts                     NEW  every probe gate, probe(), _setProbe()
web/src/hud/probes.test.ts                NEW
web/src/hud/children.ts                   KeyDef, StateArt, SurvivorState; ChildDef keys/art/stateArt/hideIn/fitPlace/colourGate;
                                               PanelChildren repeat/frame/linked; childDef, panelOfFile; OWN_PANEL (2.1)
web/src/hud/children.test.ts              + per-panel registry tests, splatter seam, own panel (2.1)
web/src/hud/dll-hud-strings.txt           NEW  the dll's HUD string runs, md5 header
scripts/dll-hud-strings.sh                NEW  regenerates it
web/src/hud/dllstrings.test.ts            NEW  honest registry
web/src/hud/elements.ts                   HudElement.keys
web/src/hud/design.ts                     ChildOverride.keys/z, ElementOverride.keys, validKeys, per-panel children, ownHealth fit (2.1), scratch none migration (2.1)
web/src/hud/design.test.ts
web/src/hud/build.ts                      panelWork/panelFrame/panelChild, fit rules, keys and zpos writes, element keys, own fit, ownBg
web/src/hud/build.test.ts
web/src/hud/slots.ts                      ownBg (2.1)
web/src/hud/upload.ts                     SHAPES from the registry
web/src/hud/render.ts                     SurvivorState, PreviewState, previewOf, hiddenInState from the registry, hurt/down/crouched (2.1), gated bar
web/src/hud/render.test.ts
web/src/hud/mock.ts                       panelBoxes, childAt per panel, paintOwnHealth through panelBoxes and the state
web/src/hud/mock.test.ts
web/src/hud/selection.ts                  panel-aware children level, zpos menu actions
web/src/hud/selection.test.ts
web/src/hud/edit.ts                       panel-aware child helpers, raiseChild, setFit (2.1), scratch None as the child hide (2.1)
web/src/hud/edit.test.ts
web/src/hud/art.ts, scripts/export-hud-art.py, web/src/hud/art/*   crouch_survivor, s_healthbar_outline (2.1)
web/src/routes/Hud.tsx                    panel-aware drags and wiring, PreviewState (2.1)
web/src/routes/hud/LayersPanel.tsx        every registered panel's pieces
web/src/routes/hud/ContextPanel.tsx       ChildControls per panel, KeyControls, Fit for own health (2.1)
web/src/routes/hud/Toolbar.tsx            Hurt tab, Crouched toggle (2.1)
web/src/routes/Hud.test.tsx
web/src/hud/download.golden.test.ts       + Phase 1 rich cases (Task 0)
web/src/hud/sample.vpkcheck.test.ts, scripts/check-hud-vpk.sh   + sample o (2.1)
```

---

# Slice 2.0: shared plumbing

### Task 0: Preconditions and a wide golden

**Files:**
- Modify: `web/src/hud/download.golden.test.ts`

- [ ] **Step 1: Preconditions.** Confirm the splatter plan's Task 7 commit is on the branch (see the header). Run `npx vitest run` and record the counts as this plan's **baseline** in the task report (the splatter plan will have raised them above its own 4179). If anything fails, stop and report: do not build on a red suite.

- [ ] **Step 2: Add the rich cases.** Today's golden cases all start from `DEFAULT_DESIGN`, so they cannot see a regression in child edits, Free, Modern children, weapons, splatters or an import. Append a second `describe` that pins saved designs as `validateDesign` returns them (the load path players really take). Merge imports (`validateDesign`, `registerImport`, `unregisterImport`, `sampleHud`).

```ts
describe('saved Phase 1 designs download the same bytes', () => {
  const ID = '9'.repeat(64);
  afterAll(() => { unregisterImport(ID); });
  const cases: [string, () => HudDesign, string][] = [
    ['fitted teammates with inside edits, a card background, a scaled column and a moved own panel', () => validateDesign({
      v: 1,
      elements: { teamColumn: { fit: true, dir: 'column', gap: 4, scale: 1.25 }, ownHealth: { x: 20, y: 380, scale: 1.5 }, chat: { x: 500, y: 20, w: 300, h: 150 } },
      styles: { panelBg: { kind: 'rounded', color: '10 20 30 200' } },
      children: { teamColumn: {
        Head: { x: 20, y: 40, w: 30, h: 30 }, HealthNumber: { on: true, fontSize: 14 }, Name: { color: '255 200 0 255' },
        BackgroundImage: { color: '255 255 255 90' }, Items: { visible: false },
      } },
    }), 'PIN'],
    ['a Free team', () => validateDesign({ v: 1, elements: { teamColumn: { fit: true, dir: 'free',
      slots: [{ x: 10, y: 300 }, { x: 200, y: 300 }, { x: 400, y: 300 }, { x: 600, y: 300 }] } } }), 'PIN'],
    ['Modern with inside edits and scaled infected panels', () => validateDesign({
      v: 1, preset: 'modern',
      elements: { teamColumn: { fit: true }, siHealth: { scale: 1.5 }, infectedRow: { scale: 2 } },
      children: { teamColumn: { Status: { visible: false }, Head: { w: 20, h: 20 } } },
    }), 'PIN'],
    ['hidden chat and notices, the game crosshair hidden, weapons edited', () => validateDesign({
      v: 1, crosshair: 'none', hideGameCrosshair: true,
      elements: { chat: { visible: false }, killNotices: { visible: false } },
      weapons: { indent: 10, boxActive: { kind: 'flat', color: '255 0 0 128' } },
    }), 'PIN'],
    ['damage splatters', () => validateDesign({ v: 1, splatters: {
      splatTeam: { kind: 'fade', color: '200 0 0 255' }, splatTop: { kind: 'fade' }, splatBottom: { kind: 'none' },
    } }), 'PIN'],
    ['an imported HUD with edits', () => {
      registerImport(ID, sampleHud());
      return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' },
        elements: { ownHealth: { x: 30, y: 400 } }, children: { teamColumn: { Head: { x: 30 } } } });
    }, 'PIN'],
  ];
  for (const [name, make, hash] of cases) {
    it(`${name} packs to the same bytes`, () => { expect(download(make())).toBe(hash); });
  }
});
```

If `validateDesign` drops any field above (check each case by printing `JSON.stringify(make())` once), fix the case so every field survives; the point is to exercise each feature. If `packHud` needs pixels for a case (it should not: Fade is generated), say so and drop that field.

- [ ] **Step 3: Pin.** Run `npx vitest run --project web web/src/hud/download.golden.test.ts`, copy each actual hash from the failure output into its `'PIN'`, run again: GREEN. Put one line in the describe's comment: "Pinned at <short sha> (after the splatter plan, before Phase 2)".

- [ ] **Step 4:** Full suite, typecheck. Commit `web/src/hud/download.golden.test.ts`: "Pin the downloads of saved Phase 1 designs before Phase 2 touches the generator".

---

### Task 1: The per-panel registry shape and the probe gates

**Files:**
- Create: `web/src/hud/probes.ts`, `web/src/hud/probes.test.ts`
- Modify: `web/src/hud/children.ts`, `web/src/hud/children.test.ts`, `web/src/hud/elements.ts`

**Interfaces produced:**

```ts
// probes.ts (imports nothing)
export type ProbeId = 'Q1' | 'Q2' | 'Q3' | 'Q5' | 'Q8';
export const PROBES: Readonly<Record<ProbeId, { passed: boolean; batch: string; question: string }>>;
export function probe(id: ProbeId): boolean;
/** Tests only: force a gate, or null to go back to PROBES. */
export function _setProbe(id: ProbeId, value: boolean | null): void;

// children.ts (imports only types)
export type SurvivorState = 'healthy' | 'hurt' | 'down' | 'dead';
export type StateArt = 'down' | 'dead' | 'crouched' | 'talking' | 'ghost';
export interface KeyDef {
  key: string; label: string; type: 'colour' | 'int' | 'bool';
  range?: [number, number];
  /** Where the key is proven read: a dll string run or a stock file line. */
  evidence: string;
  gate?: ProbeId;
}
// ChildDef gains:
//   keys?: KeyDef[];
//   art?: 'splatter';              the splatter work's seam (spec section 5)
//   stateArt?: StateArt;           shown only in that state
//   hideIn?: SurvivorState[];      hidden in those survivor states
//   fitPlace?: 'rule' | 'keep';    state/decor only: the panel's fit rule re-places it (default), or it keeps its place and counts toward the fit
//   colourGate?: ProbeId;          the colour control waits for this probe
// PanelChildren gains:
//   repeat: 'cards' | 'single';
//   frame?: { file: string; block: string } | 'hudlayout';
//   linked?: { file: string; rule: 'same' | 'delta' }[];   typed now, written in slice 2.2
export function childDef(panelId: string, name: string): ChildDef | undefined;   // case-insensitive name
export function panelOfFile(file: string): PanelChildren | undefined;

// elements.ts: HudElement gains keys?: KeyDef[] (import type from './children')
```

- [ ] **Step 1: Write the failing tests.** Create `web/src/hud/probes.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { PROBES, probe, _setProbe, type ProbeId } from './probes';

describe('the probe gates', () => {
  afterEach(() => { for (const id of Object.keys(PROBES) as ProbeId[]) _setProbe(id, null); });
  it('lists every gate this phase uses, none passed yet, each naming its batch', () => {
    expect(Object.keys(PROBES).sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q5', 'Q8']);
    for (const [id, p] of Object.entries(PROBES)) {
      expect(p.passed, id).toBe(false);
      expect(p.batch, id).toMatch(/^B\d+ \(/);
      expect(p.question.length, id).toBeGreaterThan(10);
    }
  });
  it('can be forced in a test and put back', () => {
    expect(probe('Q1')).toBe(false);
    _setProbe('Q1', true);
    expect(probe('Q1')).toBe(true);
    _setProbe('Q1', null);
    expect(probe('Q1')).toBe(false);
  });
});
```

Append to `web/src/hud/children.test.ts` (existing tests stay exactly as they are):

```ts
describe('the per-panel registry', () => {
  it('repeats the teammate card per teammate and gives it no frame block of its own', () => {
    expect(TEAM_PANEL.repeat).toBe('cards');
    expect(TEAM_PANEL.frame).toBeUndefined();
  });

  it('says in data what the preview used to hard-code for each teammate state', () => {
    const by = (n: string) => TEAM_PANEL.children.find((c) => c.name === n)!;
    expect([by('Incapacitated').stateArt, by('Dead').stateArt, by('Voice').stateArt]).toEqual(['down', 'dead', 'talking']);
    expect(by('Head').hideIn).toEqual(['down', 'dead']);
    for (const n of ['Health', 'HealthNumber', 'Items']) expect(by(n).hideIn, n).toEqual(['dead']);
  });

  it('finds a child by panel and name, whatever the case, and a panel by its file', () => {
    expect(childDef('teamColumn', 'healthnumber')?.name).toBe('HealthNumber');
    expect(childDef('teamColumn', 'Nope')).toBeUndefined();
    expect(childDef('nope', 'Head')).toBeUndefined();
    expect(panelOfFile('resource/ui/hud/teammatepanel.res')?.panelId).toBe('teamColumn');
  });

  it('marks exactly the pieces the splatter work restyles, and each is a splatter entry', () => {
    const marked = PANEL_CHILDREN.flatMap((p) => p.children.filter((c) => c.art === 'splatter').map((c) => `${p.file}#${c.name}`));
    for (const m of marked) expect(SPLATTERS.map((s) => `${s.file}#${s.block}`), m).toContain(m);
  });

  it('keeps stateArt and fitPlace on pieces that are not content, and gates only real controls', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children) {
      if (c.stateArt) expect(c.role, c.name).toBe('state');
      if (c.fitPlace) expect(c.role, c.name).not.toBe('content');
      if (c.colourGate) expect(c.colour, c.name).toBe(true);
    }
  });
});
```

Import `SPLATTERS` from `./splatter` in the test only (children.ts itself must not import it).

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/probes.test.ts web/src/hud/children.test.ts`: RED.

- [ ] **Step 3: Implement.**
  - `probes.ts`, with a header comment: what a gate is, that the page, validateDesign, the build's key writes and the preview read it, and that flipping one is a planned task that also updates the tests pinning "hidden". Entries (batch and question in plain words, taken from the spec's section 4 B1 table):
    - `Q1`: `B1 (a), (c)`, "monochrome_color on a HudHealth bar draws the fill in that one colour"
    - `Q2`: `B1 (a)`, "LocalPlayer clips its children and does not paint its own image"
    - `Q3`: `B1 (a)`, "inset draws the fill inset inside an outline"
    - `Q5`: `B1 (a)`, "the health cross keeps a file fgcolor_override"
    - `Q8`: `B1 (b)`, "the crouch icon keeps a file drawColor and shows only while crouched"
    - `probe(id)` reads a module `Map` of overrides first, then `PROBES[id].passed`.
  - `children.ts`: add the types above with doc comments that say why (for `fitPlace`, cite decision 1; for `hideIn`/`stateArt`, that they replace `render.ts`'s `TEAM_HIDDEN`/`STATE_CHILDREN` name lists for registered panels). Fill `TEAM_PANEL`: `repeat: 'cards'`, `art: 'splatter'` on `BackgroundImage`, `stateArt` and `hideIn` exactly as the test says. Leave every existing field and note exactly as the splatter work left them. Add `childDef` and `panelOfFile`. `teamChild` becomes `(name) => childDef('teamColumn', name)` only if that keeps its exact-case behaviour for existing callers; otherwise leave it as it is.
  - `elements.ts`: `keys?: KeyDef[]` on `HudElement`, documented as "keys of the element's own hudlayout.res block the game reads (slice 2.3 fills them)". No element gets any in this plan.

- [ ] **Step 4: GREEN**, full suite (count = baseline + new), typecheck. Commit the five files: "Give the child registry per-panel fields and keep every probe gate in one file".

---

### Task 2: The honest registry against client.dll

**Files:**
- Create: `scripts/dll-hud-strings.sh`, `web/src/hud/dll-hud-strings.txt`, `web/src/hud/dllstrings.test.ts`

- [ ] **Step 1: The script.** `scripts/dll-hud-strings.sh` (bash, `set -euo pipefail`), with a comment block explaining the audit's "honest registry" item and the weapons lesson (a registered key can still be unread):

```bash
DLL="${1:-$HOME/.steam/steam/steamapps/common/left 4 dead/left4dead/bin/client.dll}"
OUT="$(dirname "$0")/../web/src/hud/dll-hud-strings.txt"
ANCHORS='resource/ui/hud/|LocalPlayerPanel|TeammatePanel|HealthPanel|CircularProgressBar|CHudAbilityTimer|CHudTerrorCrosshair|ZombieTeamDisplay|FrustrationBar'
{
  echo "# client.dll md5 $(md5sum "$DLL" | cut -d' ' -f1)"
  echo "# strings -a -n 3 client.dll | grep -i -C 30 -E '$ANCHORS'"
  strings -a -n 3 "$DLL" | grep -i -C 30 -E "$ANCHORS"
} > "$OUT"
```

Run it. Expect about 1,330 lines and the md5 `9be2860914a3e33cce82b91473148459`. If the md5 differs, the game updated: stop and report, because the spec's evidence was read from that dll.

- [ ] **Step 2: Write the test** `web/src/hud/dllstrings.test.ts` (`// @vitest-environment node`; read the file with `node:fs` beside `import.meta.url`):

```ts
describe('the registry offers only what client.dll can read', () => {
  const lines = readFileSync(`${here}dll-hud-strings.txt`, 'latin1').split(/\r?\n/);
  const has = new Set(lines.filter((l) => !l.startsWith('# ')));
  it('was read from the dll the spec was written against', () => {
    expect(lines[0]).toBe('# client.dll md5 9be2860914a3e33cce82b91473148459');
  });
  it('names every file key a control writes', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children) for (const k of c.keys ?? []) expect(has.has(k.key), `${p.panelId} ${c.name} ${k.key}`).toBe(true);
    for (const el of ELEMENTS) for (const k of el.keys ?? []) expect(has.has(k.key), `${el.id} ${k.key}`).toBe(true);
  });
  it('names every child the editor can add, since only a looked-up child is live', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children.filter((x) => x.addable)) expect(has.has(c.name), `${p.panelId} ${c.name}`).toBe(true);
  });
  it('would catch a key the dll never names', () => {
    expect(has.has('monochrome_color')).toBe(true);
    expect(has.has('HudEdNotAKey')).toBe(false);
  });
});
```

Header comment: why whole lines only (MSVC pools literals, so a bare `Head` or `Dead` proves nothing; spec section 0), why state and content names are not demanded (the stock files already prove them), how to regenerate (`bash scripts/dll-hud-strings.sh`).

- [ ] **Step 3: Run** the test: GREEN on the first run is expected here (the data is new, not the code); prove the test bites by temporarily adding `{ key: 'HudEdNotAKey', ... }` to one child in a scratch copy, seeing RED, and reverting. Report that RED output.

- [ ] **Step 4:** Full suite. Commit the three files: "Check every registry key against the strings client.dll really has".

---

### Task 3: Typed keys and zpos in the design

**Files:**
- Modify: `web/src/hud/design.ts`, `web/src/hud/design.test.ts`

**Interfaces produced:**

```ts
// ChildOverride gains:  keys?: Record<string, string>;  z?: number;
// ElementOverride gains: keys?: Record<string, string>;
/** The keys of `raw` that `defs` declares, as the text the file takes; gated keys only when their probe passed. Undefined when none survive. */
export function validKeys(defs: readonly KeyDef[] | undefined, raw: unknown): Record<string, string> | undefined;
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/design.test.ts`:

```ts
describe('typed keys', () => {
  const defs: KeyDef[] = [
    { key: 'fill_color', label: 'Fill', type: 'colour', evidence: 't' },
    { key: 'gap', label: 'Gap', type: 'int', range: [0, 8], evidence: 't' },
    { key: 'east_aligned', label: 'East', type: 'bool', evidence: 't' },
    { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], evidence: 't', gate: 'Q3' },
  ];
  afterEach(() => { _setProbe('Q3', null); });

  it('keeps each declared key as the text the file takes, clamped and rounded', () => {
    expect(validKeys(defs, { fill_color: '1 2 3 4', gap: 9.6, east_aligned: true })).toEqual({ fill_color: '1 2 3 4', gap: '8', east_aligned: '1' });
    expect(validKeys(defs, { gap: '3', east_aligned: '0' })).toEqual({ gap: '3', east_aligned: '0' });
  });
  it('drops undeclared keys, bad values, and a gated key until its probe passes', () => {
    expect(validKeys(defs, { nope: '1', fill_color: 'red', gap: 'x', inset: 2 })).toBeUndefined();
    _setProbe('Q3', true);
    expect(validKeys(defs, { inset: 2 })).toEqual({ inset: '2' });
  });
  it('has nothing to keep without definitions', () => {
    expect(validKeys(undefined, { gap: 1 })).toBeUndefined();
  });
});

describe('children of every registered panel', () => {
  it('validates the teammate card as before, and drops a panel the registry does not have', () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { Head: { x: 3 } }, nopePanel: { Head: { x: 3 } } } });
    expect(d.children).toEqual({ teamColumn: { Head: { x: 3 } } });
  });
  it('keeps a zpos as a whole number in -50..50, and never keys a child does not declare', () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { Head: { z: 99.4 }, Name: { z: -3, keys: { font: 'x' } } } } });
    expect(d.children.teamColumn).toEqual({ Head: { z: 50 }, Name: { z: -3 } });
  });
  it('drops element keys no element declares yet', () => {
    expect(validateDesign({ v: 1, elements: { chat: { x: 5, keys: { foo: '1' } } } }).elements.chat).toEqual({ x: 5 });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/design.test.ts`: RED.

- [ ] **Step 3: Implement.**
  - `validKeys`: colour through the existing `colour()`; int: a finite number or numeric string, `Math.round`, clamped to `range` when given, as `String`; bool: `true`/`false`/`'1'`/`'0'`/`1`/`0` to `'1'`/`'0'`; skip a def with `gate` unless `probe(gate)`. Undefined when empty.
  - `childOverride(def, raw)`: `keys` through `validKeys(def.keys, raw.keys)`; `z`: finite number, `Math.round`, clamp -50..50 (add `z: [-50, 50]` to `CHILD_RANGES` so `clampChild('z', ...)` exists for the page); colour only when `def.colour && (!def.colourGate || probe(def.colourGate))`.
  - `validateDesign`: replace the `TEAM_PANEL`-only block with a loop over `PANEL_CHILDREN`, same rules per panel. `element()`: `const keys = validKeys(elementById(id)?.keys, raw.keys); if (keys) out.keys = keys;`.
  - `contentBox(nodes, names: readonly string[] = CONTENT_CHILDREN)`: the name list becomes a parameter; `baseContent` and the migration keep calling it with the default.
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Validate typed file keys and a zpos for any registered panel's children".

---

### Task 4: The generator, per panel

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/build.test.ts`, `web/src/hud/upload.ts`

**Interfaces produced (build.ts):**

```ts
export interface PanelFrame { shift: { x: number; y: number }; k: number }
export type CardFrame = PanelFrame;
export interface PanelChild extends CardChild { keys?: Record<string, string>; z?: number }
export function panelFrame(design: HudDesign, panelId: string): PanelFrame;
export function panelChild(design: HudDesign, panelId: string, name: string): PanelChild | null;
export function baseHasChild(key: BaseKey, name: string, panelId?: string): boolean;   // default 'teamColumn'
// cardFrame(design) === panelFrame(design, 'teamColumn'); cardChild(design, n) === panelChild(design, 'teamColumn', n)
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/build.test.ts` (reuse its `design`, `tree`, `layoutOf` helpers):

```ts
describe('the generator, per panel', () => {
  it('reads a teammate child the same through the panel names as through the card names', () => {
    const d = design({ elements: { teamColumn: { fit: true, scale: 1.5 } }, children: { teamColumn: { Head: { x: 20, y: 30 } } } });
    for (const n of ['Head', 'Health', 'Name', 'Incapacitated', 'BackgroundImage']) {
      const { keys: _k, z: _z, ...plain } = panelChild(d, 'teamColumn', n)!;
      expect(plain, n).toEqual(cardChild(d, n));
    }
    expect(panelFrame(d, 'teamColumn')).toEqual(cardFrame(d));
  });

  it('writes a child zpos and reports it back', () => {
    const d = design({ children: { teamColumn: { Head: { z: 7 } } } });
    expect(kvGet(kvFind(tree(buildHud(d), CARD), ['Head'])!, 'zpos')).toBe('7');
    expect(panelChild(d, 'teamColumn', 'Head')!.z).toBe(7);
  });

  it('refuses a key the child does not declare, naming the file and the child', () => {
    const d = design({ children: { teamColumn: { Head: { keys: { monochrome_color: '1 2 3 4' } } } } });
    expect(() => buildHud(d)).toThrow('resource/ui/hud/teammatepanel.res: Head takes no key monochrome_color');
  });

  it('refuses an element key the element does not declare', () => {
    expect(() => buildHud(design({ elements: { chat: { keys: { foo: '1' } } } }))).toThrow('scripts/hudlayout.res: HudChat takes no key foo');
  });
});
```

(`CARD` is the teammate file constant the file already uses; if the test file has no such constant, add `const CARD = 'resource/ui/hud/teammatepanel.res'`.)

A declared key's write cannot be tested through a real registry entry until Task 10. Test `applyChild`'s key write now through an exported pure helper instead: export `writeKeys(block: KvNode, keys: Record<string, string>)` (it is `pcSet` per key) and test it on a block holding `"xpos" "39" [$OSX]` / `"xpos" "36" [$WINDOWS]`: `writeKeys(b, { xpos: '10' })` sets the `[$WINDOWS]` line to `10`, keeps the `[$OSX]` line at `39`, and adds no third line.

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/build.test.ts`: RED.

- [ ] **Step 3: Implement.**
  - `panelWork(design)`: one scratch `Work` per design (WeakMap as now): `childPass`, then the fit box of every panel that has a fit rule (a `Record<panelId, Box | null>`, today only `teamColumn`, from `contentBox(work.tree(file))`), then `fitPass`. `cardWork` and `cardFit` read it.
  - `panelFrame(design, panelId)`: shift = the panel's box when `design.elements[panelId]?.fit`, else 0; k = the element's scale. `panelChild`: `cardChild`'s body with the panel's file and `childDef(panelId, name)`, plus `keys` (for each of the def's `keys`, the block's PC value via `kvGet` when present) and `z` (the block's `zpos` when numeric). `cardFrame`, `cardChild` become one-line wrappers; their doc comments move to the new functions.
  - `applyChild`: after the colour and font writes, `if (o.z !== undefined) kvSet(block, 'zpos', String(o.z))`, then `keys`: each key must be declared by `def.keys` or throw `${file}: ${def.name} takes no key ${key}`; write through `writeKeys`. Comment: `pcSet` replaces a `[$WIN32]` value instead of adding a second line the game would never read.
  - `fitPass`: move the teammate-specific body into a `FIT_RULES` record keyed by panel id, one entry today (`teamColumn`: its base size from `baseTeam`, `fitStateArt`, the `panelBg` card background as `HudEdCardBg` at zpos -2), and loop over it. Output must not change by a byte: the Task 0 golden and every Phase 1 build test are the check.
  - `layoutPass`: for each element with `o.keys`, before the moved/sized early `continue`, check each key against `el.keys` (throw as above with the element's `key` as the block name) and `pcSet` it on the element's hudlayout block.
  - `hidePass` and `childPass` already loop over `design.children`; confirm they need nothing.
  - `baseHasChild(key, name, panelId = 'teamColumn')` reads that panel's file.
  - `upload.ts` `SHAPES`: replace the `TEAM_PANEL` line with one line per `PANEL_CHILDREN` entry (its file, its child names), plus, for a panel with a `frame` block, that file and block. Same result today.
- [ ] **Step 4: GREEN**, then `npx vitest run --project web web/src/hud/download.golden.test.ts` (unchanged, every hash), full suite, typecheck. Commit `build.ts`, `build.test.ts`, `upload.ts`: "Key the generator's card work, fit rules and child reads by panel, and write typed keys and zpos".

---

### Task 5: One preview state, read from the registry

**Files:**
- Modify: `web/src/hud/render.ts`, `web/src/hud/render.test.ts`, `web/src/hud/mock.ts` (types only)

**Interfaces produced (render.ts):**

```ts
export type { SurvivorState } from './children';
export type CardState = SurvivorState;             // kept: the page, importCheck and tests import it
export interface PreviewState {
  survivor: SurvivorState;
  crouched: boolean;
  infected: 'alive' | 'ghost' | 'dead';
  siClass: 'hunter' | 'smoker' | 'boomer' | 'tank';
  ability: 'ready' | 'charging';
}
export const DEFAULT_PREVIEW: PreviewState;          // healthy, not crouched, alive, hunter, ready
export function previewOf(s?: SurvivorState | PreviewState): PreviewState;
// DrawOpts.state?: SurvivorState | PreviewState
// hiddenInState(panelId: string, name: string, state: SurvivorState | PreviewState): boolean
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/render.test.ts`:

```ts
describe('the preview state', () => {
  // The table the registry replaced, copied here so the change is provably the same picture.
  const OLD: Record<'healthy' | 'down' | 'dead', string[]> = {
    healthy: ['incapacitated', 'dead', 'voice'],
    down: ['head', 'dead', 'voice'],
    dead: ['head', 'incapacitated', 'voice', 'health', 'healthnumber', 'items'],
  };
  it('hides exactly what the old teammate table hid, in every state', () => {
    for (const state of ['healthy', 'down', 'dead'] as const) {
      for (const def of TEAM_PANEL.children) {
        expect(hiddenInState('teamColumn', def.name, state), `${state} ${def.name}`).toBe(OLD[state].includes(def.name.toLowerCase()));
      }
    }
  });
  it('takes a whole preview state as well as a survivor state', () => {
    expect(hiddenInState('teamColumn', 'Head', { ...DEFAULT_PREVIEW, survivor: 'down' })).toBe(true);
    expect(previewOf('dead')).toEqual({ ...DEFAULT_PREVIEW, survivor: 'dead' });
    expect(previewOf()).toEqual(DEFAULT_PREVIEW);
  });
  it('shows Hurt as Healthy shows it, piece for piece', () => {
    for (const def of TEAM_PANEL.children) expect(hiddenInState('teamColumn', def.name, 'hurt'), def.name).toBe(hiddenInState('teamColumn', def.name, 'healthy'));
  });
  it('keeps the old always-hidden list for panels the registry does not have yet', () => {
    for (const n of ['DuckingIcon', 'Incapacitated', 'SpawnTimeLabel', 'SkullIconPlacement']) expect(hiddenInState('ownHealth', n, 'healthy'), n).toBe(true);
    expect(hiddenInState('ownHealth', 'Head', 'down')).toBe(false);
  });
  it('leaves an unregistered piece of a registered panel alone (the card background, the splatter stand-in)', () => {
    expect(hiddenInState('teamColumn', 'HudEdCardBg', 'dead')).toBe(false);
  });
});
```

(The fourth test pins today's own-health behaviour; Task 10 changes it on purpose when the own panel is registered, and says so.)

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/render.test.ts`: RED.

- [ ] **Step 3: Implement.** `hiddenInState`: `const v = previewOf(state)`; when `panelChildren(panelId)` exists and `childDef(panelId, name)` finds the piece: a `stateArt` piece shows only in its state (`down`: `v.survivor === 'down'`; `dead`: `v.survivor === 'dead'` on a survivor element, `v.infected === 'dead'` on an infected one, by `elementById(panelId)?.side`; `crouched`: `v.crouched`; `ghost`: `v.infected === 'ghost'`; `talking`: never); a `hideIn` piece hides when `hideIn.includes(v.survivor)`. A registered panel's unregistered piece is never hidden. An unregistered panel keeps `STATE_CHILDREN`. Delete `TEAM_HIDDEN`. `drawPanel` normalises once (`const view = previewOf(opts.state)`) and every helper that compared `opts.state === 'down'` (`sampleHealthRgb`, `sampleText`, `drawBar`, the dead name alpha) reads `view.survivor`; `'hurt'` draws exactly as `'healthy'` in this task (Task 15 gives it its look). `mock.ts`: `HudView.state?: SurvivorState | PreviewState`, passed through unchanged. Update the module comment ("The teammate card is the exception...") to say the states come from the registry.
- [ ] **Step 4: GREEN**, full suite (every existing render, mock and page test unchanged), typecheck. Commit: "Draw the preview states from the registry through one PreviewState".

---

### Task 6: Selection and hit testing, per panel

**Files:**
- Modify: `web/src/hud/mock.ts`, `web/src/hud/mock.test.ts`, `web/src/hud/selection.ts`, `web/src/hud/selection.test.ts`

**Interfaces produced:**

```ts
// mock.ts
/** The screen boxes a panel's file is drawn in, HUD units: the three drawn teammate cards, or a single panel's frame. */
export function panelBoxes(design: HudDesign, panelId: string): Box[];
export function childAt(design: HudDesign, state: SurvivorState | PreviewState, ux: number, uy: number, panel?: string): { name: string; card: number } | null;

// selection.ts
export type Selection = ... | { kind: 'children'; names: string[]; card: number; panel?: string };   // panel absent: 'teamColumn'
export const panelOf: (sel: { panel?: string }) => string;
export function drawnPieces(design: HudDesign, state: SurvivorState | PreviewState, panel?: string): string[];
export function pieceTargets(design: HudDesign, state: SurvivorState | PreviewState, moving: string[], panel?: string): Box[];
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/selection.test.ts`:

```ts
describe('the children level names its panel', () => {
  it('leaves the panel out for the teammate card, so old selections still compare equal', () => {
    const d = design({});
    const [c] = panelBoxes(d, 'teamColumn');
    const hit = hitAt(d, 'survivor', 'healthy', c.x + 1, c.y + 1);
    const t = targetOf(d, hit);
    if (t.kind === 'children') expect('panel' in t).toBe(false);
    expect(panelOf({})).toBe('teamColumn');
  });
  it('never mixes pieces of two panels in a Shift pick', () => {
    const a: Selection = { kind: 'children', names: ['Head'], card: 0 };
    const b: Selection = { kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' };
    expect(pick(a, b, true)).toEqual(b);
  });
  it('climbs from a single panel\'s pieces straight to its element', () => {
    expect(climb({ kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' })).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    expect(selectedIds({ kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' })).toEqual(['ownHealth']);
  });
});
```

Append to `web/src/hud/mock.test.ts`: `panelBoxes(d, 'teamColumn')` equals `teamCardRects(d, d.aspect).slice(0, TEAM_CARDS)` (plain boxes) for a Row, a Column and a Free design; `panelBoxes(d, 'chat')` is `[]` (no registry entry).

- [ ] **Step 2: Run** both files: RED.

- [ ] **Step 3: Implement.**
  - `panelBoxes`: `teamColumn` gives the drawn cards as now; a registered `single` panel with a `{ file, block }` frame gives `[{ x: rect.x + xpos, y: rect.y + ypos, w: wide, h: tall }]` from that block in `buildTrees(design)` (numbers are already scaled; `rect` is `elementRect`), which is exactly `paintOwnHealth`'s `local` rect; anything else `[]`. Refactor `paintOwnHealth` to take its inner clip from `parentPanel` as now (it moves to `panelBoxes` in Task 13, when the own panel is registered).
  - `childAt(design, state, ux, uy, panel = 'teamColumn')`: loop over `panelBoxes(design, panel)` instead of the teammate cards, `childDef(panel, r.name)` instead of `teamChild`, `hiddenInState(panel, ...)`, `labelDrawsNothing(design, panel, ...)`; the container check uses the panel's element.
  - `hitAt`: after `hitTest`, if the element has a registry entry, `childAt(..., element)`; the `card` level stays teamColumn-only. `targetOf` builds a children target with `panel` only when it is not `teamColumn`. `pick`: Shift toggles pieces only within the same `panelOf`. `boxSelect`: started inside any box of `panelBoxes` for a registered panel on this side, picks that panel's drawn pieces. `selectAll`, `sanitize` (through `panelChild`), `breadcrumb` (a single panel: `[element, piece]`; the teammate crumbs unchanged), `climb` (single: to its element), `selectedIds`, `pieceFrame`, `selectionFrames`, `selectionBox` (`panelBoxes(...)[sel.card]`), `handlesFor` (`childDef(panelOf(sel), ...)`), `drawnPieces` and `pieceTargets` (their clamp box is the panel's, see Task 7's `panelClamp`; for the teammate card it stays the base card) all take the panel from the selection or a trailing parameter defaulting to `teamColumn`.
  - `isPicked`, `dragIntent` and every other helper that reads `sel.names` also compare `panelOf(sel)`.
- [ ] **Step 4: GREEN**, full suite (all existing selection and mock tests unchanged), typecheck. Commit: "Hit-test, select and frame the pieces of any registered panel".

---

### Task 7: Child edits, per panel, and zpos

**Files:**
- Modify: `web/src/hud/edit.ts`, `web/src/hud/edit.test.ts`

**Interfaces produced:**

```ts
export function panelClamp(design: HudDesign, panel: string): { w: number; h: number };
// trailing `panel = 'teamColumn'` on: patchChild, placeChild, nudgeChild, resizeChild, resetChild, startsOf,
// moveChildren, placeChildren, scaleChildren, alignChildren, setChildrenVisible, resetChildren
export function raiseChild(design: HudDesign, names: string[], to: 'front' | 'back', panel?: string): HudDesign;
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/edit.test.ts`:

```ts
describe('child edits name their panel', () => {
  it('stores an edit under the panel it was made in', () => {
    const d = patchChild(structuredClone(DEFAULT_DESIGN), 'Head', { x: 4 }, 'teamColumn');
    expect(d.children.teamColumn?.Head).toEqual({ x: 4 });
    expect(patchChild(structuredClone(DEFAULT_DESIGN), 'Head', { x: 4 })).toEqual(d);
  });
  it('clamps teammate pieces inside the unfitted card, as before', () => {
    expect(panelClamp(structuredClone(DEFAULT_DESIGN), 'teamColumn')).toEqual(baseTeam('stock').card);
  });
  it('brings pieces to the front and sends them to the back of their file', () => {
    // Stock teammatepanel.res: Voice, Name and Status at zpos 3 are the highest, BackgroundImage at -1 the lowest; Head has none (0).
    const d = structuredClone(DEFAULT_DESIGN);
    expect(raiseChild(d, ['Head'], 'front').children.teamColumn?.Head?.z).toBe(4);
    const back = raiseChild(d, ['Head', 'Name'], 'back');
    expect([back.children.teamColumn?.Head?.z, back.children.teamColumn?.Name?.z]).toEqual([-2, -2]);
    // A card background the build injected counts too: it sits at -2, so Send to back goes below it.
    const withBg = { ...d, styles: { panelBg: { kind: 'flat' as const } } };
    expect(raiseChild(withBg, ['Head'], 'back').children.teamColumn?.Head?.z).toBe(-3);
  });
});
```

The highest and lowest zpos are read from every block of the panel's file as `buildTrees` has it (so the injected `HudEdCardBg` and `HudEdSplatter` count), excluding the pieces being moved, a block with no zpos counting as 0. Clamp through `clampChild('z', ...)`.

- [ ] **Step 2: Run**: RED.

- [ ] **Step 3: Implement.** Thread the trailing `panel` through every listed helper; every `design.children.teamColumn` read becomes `design.children[panel]`, `teamChild` becomes `childDef(panel, ...)`, `cardChild` becomes `panelChild(design, panel, ...)`. `panelClamp`: `teamColumn` is `baseTeam(baseOf(design)).card`; a single panel is the union of its frame block's base rect and every child's base rect (decision 9), read from `baseTree(baseOf(design), file)`. `raiseChild` as described. The selection-level helpers (`nudgeSelection`, `setSelectionVisible`, `hideSelection`, `resetSelection`) pass `panelOf(sel)`.
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Make every child edit panel-aware, and add bring to front and send to back".

---

### Task 8: The page, per panel, and the zpos menu

**Files:**
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/hud/LayersPanel.tsx`, `web/src/routes/hud/ContextPanel.tsx`, `web/src/hud/selection.ts` (`menuActions` only), `web/src/hud/selection.test.ts` (one line), `web/src/routes/Hud.test.tsx`

**What changes:** nothing a player sees on the teammate card except two menu items.
- `LayersPanel`: for each visible element with a registry entry, its pieces (the teammate code, generalised): `panelChild` instead of `cardChild`, `childDef` instead of `TEAM_PANEL`, a target `{ kind: 'children', names, card, ...(panelId === 'teamColumn' ? {} : { panel: panelId }) }`; `isIn` also compares `panelOf`. `WHEN` becomes a lookup from `stateArt` (`down`: "shown when down", `dead`: "shown when dead", `talking`: "shown when talking", `crouched`: "shown when crouched", `ghost`: "shown as a ghost"), which gives the teammate rows the same texts as now. The card rows stay teamColumn-only.
- `ContextPanel.ChildControls` takes `panel`; every read and `patchChild`/`resetChild` call passes it. The line "Edits inside a card apply to every teammate's card." shows only for `repeat: 'cards'`. "Back to Teammates" becomes `Back to ${elementById(panel)!.label}` (the same text for the teammates). `PiecesControls` takes `panel` too.
- `Hud.tsx`: the `children`, `resizePiece` and `scalePieces` drags carry `panel`; `cardFrame(cur)` becomes `panelFrame(cur, panel)`, `teamCardRects(cur, cur.aspect)[d.card]` becomes `panelBoxes(cur, panel)[d.card]`, `pieceTargets(..., panel)`. `startsOf`, `moveChildren`, `resizeChild`, `scaleChildren` get the panel.
- `menuActions`: `children` gives `['hide', 'reset', 'front', 'back', 'selectCard', 'selectTeam']` for the teammate card and `['hide', 'reset', 'front', 'back', 'selectTeam']` for a single panel (no card level). This is **the one deliberate change to an existing test**: update the `menuActions` line in `selection.test.ts` to the new list, and say so in the commit. `MENU_LABELS`: `front: 'Bring to front'`, `back: 'Send to back'`; `runMenu` calls `raiseChild(d, s.names, a === 'front' ? 'front' : 'back', panelOf(s))`. For a single panel, `selectTeam` selects its element and is labelled by `MENU_LABELS` as today ("Select ...": if the label text says "Teammates", make it `Select ${label}` per panel).

- [ ] **Step 1: Write the failing tests** in `web/src/routes/Hud.test.tsx`, beside the existing Layers and context-menu tests, reusing their render and pointer helpers:
  1. Right-clicking the teammate portrait offers "Bring to front" and "Send to back"; choosing "Send to back" saves `children.teamColumn.Head.z` equal to the lowest zpos in the card file minus 1.
  2. The Layers list for the survivor side is unchanged: the same rows, labels and notes in the same order as before this task (write the expected list out from the current page before changing it).
  3. The teammate child controls still say "Edits inside a card apply to every teammate's card." and "Back to Teammates".
- [ ] **Step 2: Run**: RED (1 fails; 2 and 3 pass, which is their job).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: GREEN**, full suite, typecheck, `npm run build`. Commit: "Drive Layers, the child controls and piece drags by panel, and put zpos in the piece menu".

---

### Task 9: Slice 2.0 verification

**Files:** none (report only), unless a check fails.

- [ ] **Step 1: The whole chain**, real output in the report:

```
npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh && HUD_SAMPLE=w bash scripts/check-hud-vpk.sh && HUD_SAMPLE=i bash scripts/check-hud-vpk.sh && HUD_SAMPLE=s bash scripts/check-hud-vpk.sh
```

- [ ] **Step 2:** `git diff <Task 0 commit> -- web/src/hud/download.golden.test.ts` is empty: no golden hash moved in slice 2.0.
- [ ] **Step 3: Headless look.** Vite on `:5199` from this worktree (start it with `setsid nohup npx vite --port 5199 --strictPort --host 127.0.0.1 >/dev/null 2>&1 &` if it is not running; drive Chrome over CDP as `scripts/shoot-pages.mjs` does; read the canvas with `canvas.toDataURL()`, never a CDP screenshot, which shifts the page 7 px). On a fresh stock design, save the preview at Healthy, Down and Dead and compare pixel for pixel with the same three shots taken at the Task 0 commit (build that commit's page in a temporary `git worktree add` under the scratchpad, never by moving HEAD here; remove the temporary worktree afterwards). Any difference is a bug in this slice.
- [ ] **Step 4:** Report the counts, the chain's output and the comparison. No commit unless a fix was needed (then a normal fix commit with its test).

---

# Slice 2.1: own health insides

### Task 10: Register the own health panel

**Files:**
- Modify: `web/src/hud/children.ts`, `web/src/hud/children.test.ts`, `web/src/hud/render.test.ts` (the Task 5 "not registered yet" test)

**Registry entry** (`OWN_PANEL`, appended to `PANEL_CHILDREN`):

```ts
const OWN_STATE = 'The game decides when this one shows. Pick it above the canvas to see it.';
export const OWN_PANEL: PanelChildren = {
  panelId: 'ownHealth',
  file: 'resource/ui/hud/localplayerpanel.res',
  frame: { file: 'resource/ui/hud/localplayerdisplay.res', block: 'LocalPlayer' },
  repeat: 'single',
  children: [
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false,
      hideIn: ['down'], note: 'The game picks the portrait by character.' },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      keys: [
        { key: 'monochrome_color', label: 'Bar colour', type: 'colour', gate: 'Q1',
          evidence: 'client.dll HealthPanel run: m_monochromeColor|monochrome_color' },
        { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], gate: 'Q3', evidence: 'client.dll HealthPanel run: m_inset|inset' },
      ],
      note: 'The game fills the bar by health.' },
    { name: 'HealthIcon', label: 'Health cross', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true,
      colourGate: 'Q5', note: 'The game colours this by health.' },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      note: 'The game colours this by health.' },
    { name: 'HealthbarTextureTop', label: 'Scratches, top', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      art: 'splatter', fitPlace: 'keep', note: 'The game tints these by health. Change their art under Splatter, below the canvas.' },
    { name: 'HealthbarTextureBottom', label: 'Scratches, bottom', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: false,
      art: 'splatter', fitPlace: 'keep', note: 'The game tints these by health. Change their art under Splatter, below the canvas.' },
    { name: 'Incapacitated', label: 'Down picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false,
      stateArt: 'down', note: OWN_STATE },
    { name: 'DuckingIcon', label: 'Crouch icon', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: true,
      colourGate: 'Q8', stateArt: 'crouched', fitPlace: 'keep', note: OWN_STATE },
  ],
};
```

(The splatter spec's Splatter panel is "below the canvas": check the actual wording the splatter Task 6 shipped and match it in the two notes.)

- [ ] **Step 1: Write the failing tests.** In `children.test.ts`:
  - Change the Phase 1 test "covers only the teammate card in this phase" to expect `['teamColumn', 'ownHealth']` (deliberate; the test name becomes "covers the teammate card and your own health").
  - A new describe "the own health registry", modelled on the teammate one: every child is a block in both presets' `localplayerpanel.res` (Modern ships the scratches as `visible 0` blocks: they must still be there); each kind matches its `ControlName`; each label has a font the preset's scheme defines; square art is square in the stock file, or is `Incapacitated` (squared by the fit rule; Modern's is 120x34); `frame` names a real `LocalPlayer` block in both presets' `localplayerdisplay.res`; the two scratches are `art: 'splatter'`; the gated controls are exactly `Health` keys `monochrome_color` (Q1) and `inset` (Q3), `HealthIcon` colour (Q5), `DuckingIcon` colour (Q8).
  - The dll test from Task 2 now covers `monochrome_color` and `inset` automatically: run it.
  - In `render.test.ts`, replace the Task 5 test "keeps the old always-hidden list for panels the registry does not have yet" with: `hiddenInState('siHealth', 'DuckingIcon', 'healthy')` is still true (siHealth is not registered), and for `ownHealth`: `DuckingIcon` hidden unless `crouched`, `Incapacitated` shown only `down`, `Head` hidden `down` (Q9 default), everything else shown in `healthy` and `hurt`.
  - A validation test in `design.test.ts`: `children.ownHealth.HealthIcon.color` and `children.ownHealth.Health.keys.monochrome_color` are dropped while Q5/Q1 are off and kept with `_setProbe` on.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement** the entry. Nothing else should be needed: Tasks 3 to 8 made every consumer registry-driven. If a consumer still special-cases `teamColumn` in a way that breaks the own panel, fix it there with a test.
- [ ] **Step 4: GREEN**, then the golden (unchanged), full suite, typecheck. Commit: "Register the pieces of your own health panel, with the unproven controls gated".

---

### Task 11: Export the crouch icon and the bar outline

**Files:**
- Modify: `scripts/export-hud-art.py`, `web/src/hud/art.ts`, `web/src/hud/art/` (generated), `web/src/hud/art.test.ts` only if it pins a count

- [ ] **Step 1:** Add `'vgui/hud/crouch_survivor'` and `'vgui/hud/s_healthbar_outline'` to `MATERIALS` in the export script (a comment: the crouch icon is `DuckingIcon`'s art, named by the .res file; the outline is `HealthPanel`'s, named by client.dll, drawn only when Q3 passes) and to `NEEDED_MATERIALS` in `art.ts`.
- [ ] **Step 2:** Run `npx vitest run --project web web/src/hud/art.test.ts`: RED (the index lacks the two materials).
- [ ] **Step 3:** Run the export exactly as its header says, with `/home/volence/l4d/hud/.venv/bin/python scripts/export-hud-art.py`. Expect two new PNGs of about 3.5 KB (128x128) and 1.7 KB (256x16) and the index updated; the script enforces the 1 MB cap. Read both PNGs back (Read tool) and check they are a crouching figure and a thin bar outline.
- [ ] **Step 4: GREEN**, full suite. Commit the script, `art.ts` and the generated files by path: "Export the crouch icon and the health bar outline for the own health preview".

---

### Task 12: One hide for the scratches (the splatter seam)

**Files:**
- Modify: `web/src/hud/design.ts`, `web/src/hud/edit.ts`, `web/src/hud/build.ts` (`splatterPass` only), `web/src/hud/design.test.ts`, `web/src/hud/edit.test.ts`, `web/src/hud/splatter.build.test.ts`

Read the splatter plan's decisions ("Kinds", "Scratches") and the committed `patchSplatter`, `splatterKind`, `resetSplatter` and `splatterPass` first. This task makes a scratch's None exactly the teammate splatter's None: the child hide.

- [ ] **Step 1: Write the failing tests.**
  - `design.test.ts`: a stored `splatters.splatTop = { kind: 'none', color: '1 2 3 4' }` loads as `children.ownHealth.HealthbarTextureTop.visible === false` and `splatters.splatTop = { kind: 'stock', color: '1 2 3 4' }` (the Fade colour is kept for when the player picks Fade again); `splatters` never holds `'none'` for any splatter after load.
  - `edit.test.ts`: `patchSplatter(d, 'splatTop', { kind: 'none' })` hides the child `ownHealth.HealthbarTextureTop` and stores no `'none'`; `splatterKind` then says `'none'`; `patchSplatter(..., { kind: 'fade' })` shows it again and leaves no empty override; `setChildrenVisible(d, ['HealthbarTextureTop'], false, 'ownHealth')` makes `splatterKind(d, 'splatTop')` `'none'`; `resetSplatter` shows it.
  - `splatter.build.test.ts`: a Fade scratch whose child is hidden ships no `splattop` texture and keeps the block hard-hidden; the old test "hard-hides a scratch set to None" still passes unchanged through the migration (it builds through `design()`, not `validateDesign`: if it hands `splatters: { splatTop: { kind: 'none' } }` straight to `buildHud`, keep `splatterPass`'s `none` branch as a fallback so it stays green, with a comment that loaded designs never reach it).
  - The Task 0 golden case "damage splatters" (stored `splatBottom: 'none'`) must keep its hash: this is the byte-identity check for the migration.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** Generalise the splatter's "None is the child hide" rule from `route === 'standIn'` to every splatter, finding the child's panel with `panelOfFile(def.file)`; `splatterPass` skips any splatter whose child override has `visible: false` (replacing the `design.children.teamColumn` check); `validateDesign` migrates as tested. Keep comments that say why (decision 4).
- [ ] **Step 4: GREEN**, golden unchanged, full suite, typecheck. Commit: "Make a scratch's None the same hide Layers uses, as the teammate splatter's already is".

---

### Task 13: Fit the own panel

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/design.ts`, `web/src/hud/mock.ts`, `web/src/hud/selection.ts`, `web/src/hud/edit.ts`, and their tests (`build.test.ts`, `design.test.ts`, `mock.test.ts`, `selection.test.ts`, `edit.test.ts`)

**Interfaces produced:**
- `FIT_RULES.ownHealth` in `build.ts` (internal).
- `setFit(design, id, on): HudDesign` in `edit.ts` (sets or removes `elements[id].fit`; the team uses its existing path).
- `validateDesign` keeps `elements.ownHealth.fit` (a boolean) only while `probe('Q2')`.

**The rule** (decisions 1 and 2): content = visible `Head`, `Health`, `HealthIcon`, `HealthNumber`; plus every visible `fitPlace: 'keep'` child (the scratches, `DuckingIcon`) cut to the frame block's base rect (`LocalPlayer`, stock 0,0 130x85, Modern 0,0 120x40) first; a piece cut to nothing counts nothing. Null when nothing is left: keep the file's panel. Every child shifts by the box's top-left; `Incapacitated` squared at the panel width with the band centred (the teammate `fitStateArt` rule for `Incapacitated`, shared, not copied); `ModBg` (Modern) to 0,0 at the panel size; `localplayerdisplay.res` `LocalPlayer` `xpos`/`ypos` = the box's top-left and `wide`/`tall` = the box, unscaled (scalePass scales the file, since `ownHealth.children` lists it). `hudlayout.res` is not touched by fit.

- [ ] **Step 1: Write the failing tests.** Append to `build.test.ts`:

```ts
describe('fitting your own health panel', () => {
  const OWN = 'resource/ui/hud/localplayerpanel.res';
  const DISPLAY = 'resource/ui/hud/localplayerdisplay.res';
  const rectOf = (n: KvNode) => ['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(n, k));
  const own = (o: ElementOverride, kids: Record<string, ChildOverride> = {}, preset: 'stock' | 'modern' = 'stock') =>
    design({ preset, elements: { ownHealth: o }, children: Object.keys(kids).length ? { ownHealth: kids } : {} });

  it('keeps what the stock panel shows: content, the scratches and the crouch icon, cut to LocalPlayer', () => {
    const t = buildTrees(own({ fit: true }));
    expect(rectOf(kvFind(t(DISPLAY), ['LocalPlayer'])!)).toEqual(['0', '32', '130', '53']);
  });
  it('shrinks to the spec box once the decoration and the crouch icon are hidden', () => {
    const hidden = { HealthbarTextureTop: { visible: false }, HealthbarTextureBottom: { visible: false } };
    expect(rectOf(kvFind(buildTrees(own({ fit: true }, hidden))(DISPLAY), ['LocalPlayer'])!)).toEqual(['0', '32', '122', '47']);
    expect(rectOf(kvFind(buildTrees(own({ fit: true }, { ...hidden, DuckingIcon: { visible: false } }))(DISPLAY), ['LocalPlayer'])!))
      .toEqual(['0', '48', '122', '31']);
  });
  it('fits Modern to its content and stretches its fill to match', () => {
    const t = buildTrees(own({ fit: true }, {}, 'modern'));
    expect(rectOf(kvFind(t(DISPLAY), ['LocalPlayer'])!)).toEqual(['3', '3', '114', '28']);
    expect(rectOf(kvFind(t(OWN), ['ModBg'])!)).toEqual(['0', '0', '114', '28']);
  });
  for (const scale of [1, 2]) {
    it(`moves nothing on screen by fitting alone, at scale ${scale}`, () => {
      const at = (d: HudDesign) => {
        const [box] = panelBoxes(d, 'ownHealth');
        return Object.fromEntries(childRects(d, 'ownHealth', box, 1)
          .filter((r) => r.name !== 'Incapacitated').map((r) => [r.name, [r.x, r.y, r.w, r.h]]));
      };
      expect(at(own({ fit: true, scale }))).toEqual(at(own({ scale })));
    });
  }
  it('squares the down picture at the panel width with its band centred', () => {
    const n = kvFind(buildTrees(own({ fit: true }))(OWN), ['Incapacitated'])!;
    expect(rectOf(n)).toEqual(['0', '-22', '130', '130']);
  });
  it('shifts the PC line of a conditional key and leaves the Mac one', () => {
    const block = kvFind(buildTrees(own({ fit: true }))(OWN), ['HealthNumber'])!;
    expect(kvGet(block, 'xpos')).toBe('36');
    expect(kvGet(block, 'ypos')).toBe('16');
  });
  it('leaves the container block alone', () => {
    // layoutPass always parses hudlayout.res, so the file ships either way; the block must not differ.
    const block = (d: HudDesign) => writeKv([kvFind(tree(buildHud(d), 'scripts/hudlayout.res'), ['CHudLocalPlayerDisplay'])!]);
    expect(block(own({ fit: true, x: 20, y: 380 }))).toBe(block(own({ x: 20, y: 380 })));
  });
  it('reads a piece back in the unfitted frame, as the side panel shows it', () => {
    expect(panelChild(own({ fit: true }), 'ownHealth', 'Head')).toMatchObject({ x: 0, y: 54, w: 25, h: 25 });
  });
});
```

(`childRects(design, panelId, origin, k)` takes `k = 1` here: its `k` is canvas pixels per HUD unit, and `panelBoxes` and the generated tree are both already in scaled HUD units, as `selection.ts` uses them. The "moves nothing" test is the contract: adjust the helper, not the expectation. Merge `writeKv` into the kv import.)

Also:
- `design.test.ts`: `elements.ownHealth.fit` dropped while Q2 is off, kept with `_setProbe('Q2', true)`; never added by `validateDesign`.
- `mock.test.ts`: `panelBoxes(d, 'ownHealth')` is `[elementRect + LocalPlayer]` unfitted (stock: at the container origin, 130x85) and follows `LocalPlayer` fitted; `hitTest` of a point inside the container but above the fitted panel (stock fitted, y at container top + 10) returns null.
- `selection.test.ts`: `elementFrame(d, 'ownHealth')` is `panelBoxes(d, 'ownHealth')[0]` when fitted, `elementRect` otherwise.
- `edit.test.ts`: `setFit(d, 'ownHealth', true)` then `false` gives back `d`'s elements exactly; a moved own panel keeps its stored `x`/`y` through the toggle.
- The golden stays unchanged (no saved design has `ownHealth.fit`).

- [ ] **Step 2: Run** the five files: RED.
- [ ] **Step 3: Implement.** Add `FIT_RULES.ownHealth` next to the teammate rule: the box as described (a shared `fitBox(nodes, panel, frameRect)` that the teammate rule also uses with no keep pieces, so its numbers cannot change), the shift, the `Incapacitated` rule (extract the teammate's `Incapacitated`/`Dead` band code into `squareBand(nodes, edits, name, size)` and call it from both), `ModBg`, and the frame write. `panelWork` computes the own box too. `panelBoxes` for `ownHealth` already reads `LocalPlayer` from the tree (Task 6); switch `paintOwnHealth` to use `panelBoxes(...)[0]` (times the canvas scale) for its inner clip, so the preview, hit test and outline share one rect. `hitTest` and `sectionRects` use `panelBoxes(d, 'ownHealth')` as the element's target when `design.elements.ownHealth?.fit`; `elementFrame` likewise. `design.ts` `element()`: `if (id === 'ownHealth' && typeof raw.fit === 'boolean' && probe('Q2')) out.fit = raw.fit;` with a comment naming the probe.
- [ ] **Step 4: GREEN**, golden unchanged, full suite, typecheck. Commit: "Fit your own health panel to what it shows, moving nothing on screen".

---

### Task 14: "Your health background" (`ownBg`)

**Files:**
- Modify: `web/src/hud/slots.ts`, `web/src/hud/build.ts`, `web/src/hud/build.test.ts`, `web/src/hud/render.test.ts`

**Slot:** `{ id: 'ownBg', label: 'Your health background', advancedOnly: false, size: { w: 32, h: 32 }, targets: [{ file: 'resource/ui/hud/localplayerpanel.res', path: ['HudEdOwnBg'], key: 'image' }], stockNames: [], defaultColor: '0 0 0 140' }`, placed right after `panelBg`.

- [ ] **Step 1: Write the failing tests.** In `build.test.ts`:
  - `styles.ownBg = { kind: 'flat', color: '1 2 3 200' }`: `HudEdOwnBg` is the first block of `localplayerpanel.res`, keys `ControlName ImagePanel`, `fieldName HudEdOwnBg`, `xpos 0`, `ypos 0`, `zpos -5`, `wide 130`, `tall 85` (the unfitted `LocalPlayer`), `visible 1`, `enabled 1`, `fillcolor 1 2 3 200`; no `ownbg` texture ships.
  - With `elements.ownHealth.fit` (build directly, no validation), `wide 130`, `tall 53`, and it is injected after the shift (at 0,0, not at -32).
  - `rounded`: `scaleImage 1`, `image hud/hudeditor/ownbg`, and `materials/vgui/hud/hudeditor/ownbg.vtf`/`.vmt` ship; `image` with no stored upload injects nothing.
  - Modern with `ownBg` flat: `HudEdOwnBg` comes before `ModBg` (drawn under it at the same zpos).
  - `panelBg` output is unchanged (the golden's rounded card background case).
  - `render.test.ts`: with a flat `ownBg`, `drawPanel(ctx, d, 'ownHealth', ...)` fills the `HudEdOwnBg` rect in that colour before any other draw.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** Generalise `cardBackground(design)` and `cardBgBlock` to take the slot id and the block name (`panelBg`/`HudEdCardBg`/zpos -2 and `ownBg`/`HudEdOwnBg`/zpos -5), carried on each `FIT_RULES` entry with the base size (`LocalPlayer`'s base `wide`/`tall` for the own panel). `fitPass` injects the own background even when fit is off, as it does for the card. `stylePass`'s `panelBg` special case becomes "a slot whose target is a fit rule's background child". `drawSlotStyle` should already draw `hud/hudeditor/ownbg` from the slot; confirm with the render test.
- [ ] **Step 4: GREEN**, golden unchanged, full suite, typecheck. Commit: "Add a background for your own health panel that the game really draws".

---

### Task 15: Hurt, Down and Crouched in the preview

**Files:**
- Modify: `web/src/hud/render.ts`, `web/src/hud/render.test.ts`, `web/src/hud/mock.ts`, `web/src/hud/mock.test.ts`

- [ ] **Step 1: Write the failing tests** (`render.test.ts`, using `recCtx`, `instantImage` and the file's helpers):
  1. Hurt: `HealthNumber` draws "40" in `rgba(216,146,12,1)` on the own panel and on a teammate card; the scratches are tinted `rgb(216,146,12)` (the existing multiply-fill check, as in the splatter tests).
  2. Hurt bar: `drawImage` of `vgui/healthbar_orange` at the `Health` rect's x, y, 0.4 of its width and its full height; nothing else drawn in the other 0.6.
  3. Healthy and Down bars are drawn exactly as before (green full; red full).
  4. Own Down: `Incapacitated` drawn with `vgui/s_panel_namvet_incap`, `Head` not drawn, the number "299" in the incap red.
  5. Crouched: `DuckingIcon` drawn with `vgui/hud/crouch_survivor` at its rect; not drawn when `crouched` is false.
  6. Gated bar, with `_setProbe('Q1', true)` and a design whose own `Health` has `keys.monochrome_color '255 0 255 255'`: a flat `rgba(255,0,255,1)` fill of the bar rect (0.4 of it when hurt) instead of the texture; with the gate off, the stock texture.
  7. Gated inset, `_setProbe('Q3', true)`, `inset 3`: `vgui/hud/s_healthbar_outline` drawn at the bar rect and the fill inset by 3 units times the scale on every side.
  8. `mock.test.ts`: `drawHud` passes the view's state (a `PreviewState` with `crouched: true`) to the own panel as it does to the teammate cards.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** `sampleHealthRgb(view)`: `hurt` is `healthRgb(40, 100, false)`. `sampleText`: `%HealthNumber%` is "40" when hurt. `drawBar(ctx, design, n, r, k, view)`: fill fraction 0.4 when hurt else 1; `healthbar_orange` when hurt; Q1 and Q3 as tested, read from the block's own keys (`kvGet(n, 'monochrome_color')`, `kvGet(n, 'inset')`), each only while its gate passes; a comment per gate naming the probe and the B1 shot. `paintOwnHealth` passes `state: view.state`. Every guess (the empty part of a hurt bar, Head hidden when down) gets a one-line comment naming its probe (S-hurt, Q9).
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Preview your own health hurt, down and crouched, and the gated bar colour and inset".

---

### Task 16: The page: preview state, Fit and file keys

**Files:**
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/hud/Toolbar.tsx`, `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.test.tsx`
- Create: `KeyControls` inside `ContextPanel.tsx` (no new file unless `ContextPanel.tsx` grows past about 700 lines; then `web/src/routes/hud/KeyControls.tsx`)

**What the UI does:**
- `Hud.tsx` holds `preview: PreviewState` (from `DEFAULT_PREVIEW`) instead of `cardState`; `hitAt`, `boxSelect`, `selectAll`, `pieceTargets` and the canvas view get it.
- Toolbar, survivor side: the state tabs become Healthy, Hurt, Down, Dead; beside them a toggle button "Crouched" (`aria-pressed`). Its props become `preview` and `onPreview`.
- ContextPanel, `ownHealth` element: a "Fit to contents" checkbox (the same wording and `hud__check` markup as the teammates' Fit) shown only while `probe('Q2')`, calling `setFit`; the `ownBg` style row appears in the Styles panel by itself (Task 14 added the slot).
- `ChildControls`: after the colour control, `KeyControls` for every `def.keys` entry whose gate passes: `colour` as a swatch plus opacity (the `hexOf`/`withHex`/`alphaPct`/`withAlphaPct` pattern), `int` as a number input with `min`/`max` from `range`, `bool` as a checkbox; each writes `patchChild(d, name, { keys: { ...o.keys, [key]: value } }, panel)`; the value shown is the override, else `panelChild(...).keys?.[key]`, else the type's default (`255 255 255 255`, `range[0]`, `0`). A colour control whose `colourGate` has not passed is not shown (the `def.colour` check becomes `def.colour && (!def.colourGate || probe(def.colourGate))`).

- [ ] **Step 1: Write the failing tests** in `Hud.test.tsx`, reusing the file's render, click and saved-design helpers:
  1. The survivor state tabs are Healthy, Hurt, Down, Dead; picking Hurt draws the own health number as "40" (read through the same canvas stub the existing state tests use).
  2. "Crouched" toggles `aria-pressed` and makes the preview draw the crouch icon.
  3. Layers lists, under "Your health": Portrait, Health bar, Health cross, Health number, Scratches, top, Scratches, bottom, Down picture ("shown when down"), Crouch icon ("shown when crouched").
  4. Selecting "Health bar" shows X, Y, W, H and the note "The game fills the bar by health.", and no "Bar colour" or "Inset" control; with `_setProbe('Q1', true)` and `_setProbe('Q3', true)` both appear, and setting Inset to 3 saves `children.ownHealth.Health.keys.inset === '3'`.
  5. "Health cross" shows Text size and no Colour; with Q5 on, a Colour control.
  6. The own health element shows no "Fit to contents" while Q2 is off; with Q2 on, ticking it saves `elements.ownHealth.fit === true` and leaves the canvas's drawn number where it was (compare the number's `fillText` position before and after).
  7. Dragging "Health bar" on the canvas saves `children.ownHealth.Health.x/y` in the unfitted frame, and the right-click menu offers Hide, Reset, Bring to front, Send to back and "Select Your health" (no card entry).
  8. The Modern preset lists the two scratches greyed as hidden, and their Visible checkbox shows them as off.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: GREEN**, full suite, typecheck, `npm run build`. Commit: "Edit every piece of your own health: Hurt and Crouched previews, Fit and the file keys behind their probes".

---

### Task 17: Sample VPK and slice 2.1 verification

**Files:**
- Modify: `web/src/hud/sample.vpkcheck.test.ts`, `scripts/check-hud-vpk.sh`

- [ ] **Step 1: Sample `o`** (document it in the header list): a stock design, built directly (not through `validateDesign`, so the gated fit is present): `elements.ownHealth = { fit: true, scale: 1.5, x: 20, y: 380 }`, `children.ownHealth = { Head: { x: 100, y: 50, w: 20, h: 20 }, HealthbarTextureBottom: { visible: false }, HealthNumber: { fontSize: 20 }, DuckingIcon: { z: 9 } }`, `styles.ownBg = { kind: 'rounded', color: '0 40 80 180' }`.
- [ ] **Step 2:** In `check-hud-vpk.sh`, when `HUD_SAMPLE == 'o'`: `resource/ui/hud/localplayerpanel.res` parses (srctools keyvalues) with `HudEdOwnBg` first; `HealthbarTextureBottom` has `wide 0`, `tall 0`; `DuckingIcon` has `zpos 9`; `HealthNumber`'s font is a `HudEd_` copy that `resource/clientscheme.res` defines; `resource/ui/hud/localplayerdisplay.res` `LocalPlayer` has the scaled fitted size; `materials/vgui/hud/hudeditor/ownbg.vtf` reads as 32x32 BGRA8888. Read how the script already asserts sample `a` and follow it.
- [ ] **Step 3: The whole chain**, real output in the report: Task 9's command plus `HUD_SAMPLE=o bash scripts/check-hud-vpk.sh`. The golden: `git diff <Task 0 commit> -- web/src/hud/download.golden.test.ts` still empty.
- [ ] **Step 4: Headless look** (as Task 9): a stock design with the own panel moved and scaled 1.5, previews saved at Healthy, Hurt, Down and Crouched. Fit cannot be switched on in the page before Task F2 (validateDesign drops it), so the fitted look is covered by sample `o` and Task 13's tests; Task F2 repeats these four shots with Fit on. Report the shots' paths and anything that looks wrong.
- [ ] **Step 5:** Commit the two files: "Check an own health download with the independent VPK reader". Report which probe gates are still off, as the table at the top lists them.

---

# Gate flips (run each only when its probe answer is in)

Each flip is one small task. Start by reading the batch's `probe.txt` and screenshots (the harness names them `<batch>-<letter>.jpg`), write the answer and the screenshot path into the spec's section 4 under the question, then:

### Task F1: Q1 passed (bar colour)
- [ ] Set `PROBES.Q1.passed = true`. Update the tests that pin "hidden while Q1 is off" (Tasks 10, 15, 16) to pin "shown", keeping the `_setProbe('Q1', false)` variants as the fail path. If the screenshot shows the magenta holding when hurt, keep the preview's flat fill in every state; if it turns orange when hurt, make the flat fill Healthy-only and say so in `drawBar`'s comment. Full suite, commit: "Offer the own health bar colour: probe Q1 showed monochrome_color works".

### Task F2: Q2 passed (LocalPlayer clips and paints nothing)
- [ ] Set `PROBES.Q2.passed = true`. Add `ownHealth: { fit: true }` to `DEFAULT_DESIGN.elements` (new designs fit; saved designs stay as saved). The four `DEFAULT_DESIGN` golden hashes change: update them, and add two cases pinned to their **old** hashes built as `validateDesign({ v: 1, elements: { teamColumn: { fit: true } } })` (and the Modern and Roboto variants), which proves saved designs did not move. Check `elementsTouched` and `hasOverrides` still treat a fresh design as untouched. Repeat Task 17's four headless shots with Fit on and compare them with the unfitted ones: only the selection outline may differ. Commit: "Fit your own health panel by default: probe Q2 showed LocalPlayer clips it".
- [ ] If the screenshot shows the magenta `image` painted, do not flip: write a 2.F item instead ("fit must not resize a painted LocalPlayer").

### Task F3: Q3 passed (inset)
- [ ] As F1 for `inset`, and compare the in-game outline with the preview's `s_healthbar_outline` draw (thickness, where the fill starts); fix `drawBar` with a test if they differ. Commit: "Offer the own health bar inset: probe Q3 showed it works".

### Task F4: Q5 passed (cross colour)
- [ ] As F1 for `HealthIcon`'s `colourGate`; the note "The game colours this by health." goes. Commit: "Offer the health cross colour: probe Q5 showed the game keeps it".

### Task F5: Q8 passed (crouch icon tint)
- [ ] As F1 for `DuckingIcon`'s `colourGate`; the preview already tints by `drawColor`. If the icon showed while standing, change its `stateArt` and the Crouched preview with a test. Commit: "Offer the crouch icon tint: probe Q8 showed the game keeps it".

---

## Task list and probe dependencies (summary)

| Task | One line | Probes |
|---|---|---|
| 0 | Preconditions, baseline, pin saved Phase 1 designs in the golden | none |
| 1 | Per-panel registry fields and `probes.ts` | none |
| 2 | `dll-hud-strings.txt`, its script and the honest registry test | none |
| 3 | Typed keys, zpos, per-panel children in `validateDesign` | none |
| 4 | `panelWork`/`panelFrame`/`panelChild`, fit rules, key and zpos writes, `upload.ts` shapes | none |
| 5 | `PreviewState` and `hiddenInState` from the registry | none |
| 6 | `panelBoxes`, per-panel hit testing and selection | none |
| 7 | Panel-aware child edits, `raiseChild` | none |
| 8 | Page per panel, Bring to front / Send to back | none |
| 9 | Slice 2.0 verification, golden untouched, pixel-identical preview | none |
| 10 | Register the own health panel, gated controls | Q1, Q3, Q5, Q8 (gates); Q9 (preview default) |
| 11 | Export the crouch icon and the bar outline | none (outline drawn only under Q3) |
| 12 | One hide for the scratches, the splatter seam | none (Q4 does not matter: hard hide) |
| 13 | Fit the own panel inside its unchanged container | Q2 (validation keeps fit only once it passes) |
| 14 | `ownBg`, "Your health background" | none (decision 11) |
| 15 | Hurt, Down, Crouched previews; gated flat bar and inset | Q1, Q3 (gates); Q9, S-hurt (preview defaults) |
| 16 | Page: state tabs, Crouched, Fit checkbox, KeyControls | Q1, Q2, Q3, Q5, Q8 (gates) |
| 17 | Sample VPK `o` and slice 2.1 verification | none |
| F1 to F5 | Flip Q1, Q2, Q3, Q5, Q8 when their answers are in | one each |
