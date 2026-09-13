# Theater Mode and Bookmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the replay viewer a camera (zoom, pan, follow), a fullscreen theater layout with an edge HUD and fading chrome, and Overwatch-style per-player bookmarks on the scrub bar and rail, with every event sentence naming people rather than SteamIDs.

**Architecture:** The camera is a pure `Camera { zoom, panX, panY }` composed onto the fitted `View` by `zoomedView`, so `projectView`, `drawScene` and the follow translate in `ReplayCanvas` keep working unchanged; the follow camera grows a survivor-centroid mode. Theater is a layout state of `Viewer` (a `replay--theater` class that makes the root `position: fixed`), never a route; in it `HudStrip` renders as edge columns, the toggles and controls move into a top bar that fades when idle, and a bottom status line replaces the in-stage HUD. Bookmarks need no new state: the follow row's selected slot is the selected player, and the timeline payload becomes a discriminated union with structured `event`, `actor`, `target` and `value` so the client can compose sentences and decide roles per kind.

**Tech Stack:** Preact 10 + preact-iso, Vite, TypeScript, vitest 4 with happy-dom and `@testing-library/preact`, Fastify 5 on the server, plain CSS with custom properties. Node 24. Headless Google Chrome over the DevTools protocol for screenshot passes.

**Spec:** `docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md`, sections 7.1 (theater mode) and 7.2 (bookmarks). Read both first; every task cites the paragraph it implements. Section 7 (the viewer's chrome) is already built and is the baseline these tasks edit.

## Global Constraints

- Branch: `feat/theater-mode`, created off `master` at `8a247f5` or later (the previous feature branch was fast-forwarded into master and deleted). One commit per task, message in the repo's `type(scope): summary` style, lower case, no trailing period. Never use an em dash anywhere: not in code, comments, commits or docs.
- `npm test` (835 tests before this plan) and `npm run typecheck` must pass before every commit. Run both from `/home/volence/l4d/pug`.
- Colors carry fixed roles: `--accent` (#de4e40) is interactive and infected and, in this plan, "it happened to the selected player"; `--win` (#45b39c) is survivor health and "the selected player did it"; `--rating` (#c9a45c) is ratings only. No new hex values in CSS; use tokens. Translucent plates over the map are `rgba(5,4,3,0.78)` exactly (spec 7 and 7.1).
- Type: `--font-display` is Anton, `--font-label` is Oswald, `--font-body` is IBM Plex Sans. Nothing else.
- `SLOT_COLORS`, `GHOST_COLOR`, `ENTITY_STYLES`, `TEMP_HEALTH_COLOR` and `drawScene` in `web/src/replay/` are not changed by any task. `draw.test.ts` must pass unchanged.
- `src/mapTransform.ts` has no imports and must stay that way (it is loaded by browser and server).
- Positions, interpolation, layer selection and the playback loop are untouched. Avatar radii and line widths do not scale with zoom (spec 7: icons over a map).
- Nothing is deployed by this plan. The live Dallas box is never touched.

## File structure

New files:

- `web/src/replay/eventText.ts`: the per-kind table (`EVENT_KINDS`), `eventPhrase`, `eventSentence`, `valueText`, `roleOf`, `groupLabel`. Pure.
- `web/src/replay/eventText.test.ts`
- `web/src/replay/bookmarks.ts`: `tickEntries`, `groupTicks`. Pure.
- `web/src/replay/bookmarks.test.ts`
- `web/src/replay/camera.ts`: `Camera`, `zoomedView`, `clampPan`, `zoomAbout`, `clampZoom`, `Follow`, `followPoint`, `followSlotOf`. Pure.
- `web/src/replay/camera.test.ts`
- `web/src/replay/useCamera.ts`: the hook owning camera and follow state plus wheel and drag handlers.
- `web/src/replay/useTheater.ts`: enter and exit, fullscreen, Escape, body class.
- `web/src/replay/useTheater.test.tsx`
- `web/src/replay/useIdle.ts`: the two second chrome fade timer.
- `web/src/replay/useIdle.test.tsx`
- `web/src/replay/TheaterStatus.tsx`: the bottom status line.
- `web/src/replay/TheaterStatus.test.tsx`
- `web/src/replay/HudStrip.test.tsx`
- `web/src/replay/TimelineRail.test.tsx`
- `web/src/replay/Viewer.test.tsx`: theater render test.

Modified files, by responsibility:

- `src/mapTransform.ts`: `unprojectView`.
- `src/routes/replays.ts`: the timeline payload (spec 7.2 Payload).
- `tests/replayRoutes.test.ts`: payload assertions.
- `web/src/replay/timeline.ts`: `TimelineEntry` union, `entryText`.
- `web/src/replay/timeline.test.ts`, `ReplayControls.test.tsx`, `renderRate.test.tsx`: fixtures follow the new shapes.
- `web/src/replay/ReplayControls.tsx`: clickable role-coloured ticks, Survivors follow chip, zoom chips.
- `web/src/replay/TimelineRail.tsx`: per-player grouped mode.
- `web/src/replay/ReplayHud.tsx`: `ToggleChips` extracted, Theater chip.
- `web/src/replay/HudStrip.tsx`: `layout` prop.
- `web/src/replay/ReplayCanvas.tsx`: `follow` prop and `shiftRef`.
- `web/src/replay/canvasSize.ts`: fill mode and the theater pixel budget.
- `web/src/replay/Viewer.tsx`: wires everything; theater layout.
- `web/src/components/StatTable.tsx`: `EventFeed` reads verbs from `EVENT_KINDS`.
- `web/src/styles/app.css`: replay viewer section only.

---

### Task 1: Event vocabulary

Spec 7.2, Sentences. The table every later task reads. Also retires the one-entry `KIND_VERBS` in the live feed so there is one vocabulary.

**Files:**
- Create: `web/src/replay/eventText.ts`
- Create: `web/src/replay/eventText.test.ts`
- Modify: `web/src/components/StatTable.tsx:161-200`

**Interfaces:**
- Produces:
  - `EVENT_KINDS: Record<string, EventKind>` where `EventKind = { verb: string; link?: string; unit?: string; actorIs: 'doer' | 'victim'; did: string; suffered: string }`
  - `interface EventLike { event: string; actor: string; target: string | null; value: number }`
  - `valueText(event: string, value: number): string | null`
  - `eventPhrase(e: EventLike, nameOf: (id: string) => string): string` (no leading actor)
  - `eventSentence(e: EventLike, nameOf: (id: string) => string): string` (actor plus phrase)
  - `type Role = 'did' | 'suffered'`; `roleOf(e: EventLike, steamid: string): Role | null`
  - `groupLabel(event: string, role: Role): string`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/replay/eventText.test.ts
import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, eventPhrase, eventSentence, groupLabel, roleOf, valueText } from './eventText';

const names: Record<string, string> = { A: 'volence', B: 'tino' };
const nameOf = (id: string) => names[id] ?? id;

describe('eventSentence', () => {
  it('reads actor, verb, target and unit plus value', () => {
    expect(eventSentence({ event: 'dp', actor: 'A', target: 'B', value: 22 }, nameOf))
      .toBe('volence pounced tino for 22');
  });

  it('reads a target with no value', () => {
    expect(eventSentence({ event: 'boom', actor: 'A', target: 'B', value: 0 }, nameOf))
      .toBe('volence boomed tino');
  });

  it('reads a kind with no target at all', () => {
    expect(eventSentence({ event: 'car_alarm', actor: 'A', target: null, value: 0 }, nameOf))
      .toBe('volence set off a car alarm');
  });

  // The plugin puts the survivor it happened to first for death and incap so
  // the live feed reads naturally; the link word goes between verb and target.
  it('links a victim-first kind to its attacker', () => {
    expect(eventSentence({ event: 'death', actor: 'B', target: 'A', value: 0 }, nameOf))
      .toBe('tino died to volence');
    expect(eventSentence({ event: 'death', actor: 'B', target: null, value: 0 }, nameOf))
      .toBe('tino died');
  });

  it('names the infected class for a spawn instead of printing the index', () => {
    expect(eventSentence({ event: 'si_spawn', actor: 'A', target: null, value: 3 }, nameOf))
      .toBe('volence spawned as hunter');
  });

  // A silently dropped event is worse than an ugly one.
  it('falls back to the raw slug for an unknown kind', () => {
    expect(eventSentence({ event: 'moonwalk', actor: 'A', target: 'B', value: 5 }, nameOf))
      .toBe('volence moonwalk tino 5');
  });

  it('resolves every id in the sentence, never only the actor', () => {
    const s = eventSentence({ event: 'pinned', actor: 'A', target: 'B', value: 0 }, nameOf);
    expect(s).not.toMatch(/\bB\b/);
    expect(s).toBe('volence pinned tino');
  });

  it('phrase is the sentence without the actor', () => {
    expect(eventPhrase({ event: 'dp', actor: 'A', target: 'B', value: 22 }, nameOf)).toBe('pounced tino for 22');
  });
});

describe('valueText', () => {
  it('is null for a zero value on an ordinary kind', () => {
    expect(valueText('boom', 0)).toBeNull();
  });
  it('is the class name for si_spawn even when the class is 0', () => {
    expect(valueText('si_spawn', 0)).toBe('class 0');
    expect(valueText('si_spawn', 5)).toBe('tank');
  });
});

describe('roleOf', () => {
  it('actor did it and target suffered it for a doer-first kind', () => {
    const e = { event: 'dp', actor: 'A', target: 'B', value: 22 };
    expect(roleOf(e, 'A')).toBe('did');
    expect(roleOf(e, 'B')).toBe('suffered');
    expect(roleOf(e, 'C')).toBeNull();
  });

  it('inverts for the victim-first kinds', () => {
    for (const kind of ['death', 'incap']) {
      const e = { event: kind, actor: 'B', target: 'A', value: 0 };
      expect(roleOf(e, 'B')).toBe('suffered');
      expect(roleOf(e, 'A')).toBe('did');
    }
  });

  it('treats an unknown kind as doer-first', () => {
    expect(roleOf({ event: 'moonwalk', actor: 'A', target: null, value: 0 }, 'A')).toBe('did');
  });
});

describe('groupLabel', () => {
  it('reads from the selected player side', () => {
    expect(groupLabel('boom', 'suffered')).toBe('Got boomed');
    expect(groupLabel('dp', 'did')).toBe('Pounces');
    expect(groupLabel('death', 'suffered')).toBe('Deaths');
    expect(groupLabel('death', 'did')).toBe('Kills');
  });
  it('falls back to the slug', () => {
    expect(groupLabel('moonwalk', 'did')).toBe('moonwalk');
  });
});

describe('EVENT_KINDS', () => {
  // Every kind the plugin emits today. Adding a kind to the plugin means
  // adding it here; this list is the reminder.
  it('covers every kind pug-match.sp and pug-stats.inc emit', () => {
    for (const k of [
      'dp', 'skeet', 'boom', 'pinned', 'cleared', 'ff', 'revive', 'death', 'incap',
      'si_spawn', 'tank_spawn', 'tank_death', 'tank_take', 'tank_give',
      'witch_aggro', 'witch_killed', 'car_alarm',
    ]) expect(EVENT_KINDS[k], k).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/replay/eventText.test.ts`
Expected: FAIL, cannot resolve `./eventText`.

- [ ] **Step 3: Write the module**

```ts
// web/src/replay/eventText.ts
import { ZOMBIE_CLASSES } from '../../../src/replayFormat';

/** Which side of the event the plugin puts in `actor`.
 *
 *  Most kinds put the doer first: "volence pounced tino". `death` and `incap`
 *  put the survivor it happened to first so the live feed reads "tino died
 *  to volence", which is why a player's role in an event is decided per kind
 *  and never by which field their id is in. */
export type ActorRole = 'doer' | 'victim';

export interface EventKind {
  /** Between actor and target: "volence pounced tino". */
  verb: string;
  /** Between verb and target when there is one: "died TO volence". */
  link?: string;
  /** Between target and value when the value is meaningful: "FOR 22". */
  unit?: string;
  actorIs: ActorRole;
  /** Group headings in the bookmark rail, from the selected player's side. */
  did: string;
  suffered: string;
}

/**
 * How each kind reads. Adding a kind here is the only frontend change needed
 * when the plugin starts emitting a new one; an unknown kind still renders
 * with its slug as the verb.
 */
export const EVENT_KINDS: Record<string, EventKind> = {
  dp:           { verb: 'pounced', unit: 'for', actorIs: 'doer', did: 'Pounces', suffered: 'Got pounced' },
  skeet:        { verb: 'skeeted', actorIs: 'doer', did: 'Skeets', suffered: 'Got skeeted' },
  boom:         { verb: 'boomed', actorIs: 'doer', did: 'Booms', suffered: 'Got boomed' },
  pinned:       { verb: 'pinned', actorIs: 'doer', did: 'Pins', suffered: 'Got pinned' },
  cleared:      { verb: 'cleared', actorIs: 'doer', did: 'Clears', suffered: 'Got cleared' },
  ff:           { verb: 'friendly fired', unit: 'for', actorIs: 'doer', did: 'FF dealt', suffered: 'FF taken' },
  revive:       { verb: 'revived', actorIs: 'doer', did: 'Revives', suffered: 'Got revived' },
  death:        { verb: 'died', link: 'to', actorIs: 'victim', did: 'Kills', suffered: 'Deaths' },
  incap:        { verb: 'went down', link: 'to', actorIs: 'victim', did: 'Incaps dealt', suffered: 'Incaps' },
  si_spawn:     { verb: 'spawned as', actorIs: 'doer', did: 'Spawns', suffered: 'Spawns' },
  tank_spawn:   { verb: 'became the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  tank_death:   { verb: 'killed the tank', actorIs: 'doer', did: 'Tank kills', suffered: 'Tank kills' },
  tank_take:    { verb: 'took the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  tank_give:    { verb: 'gave up the tank', actorIs: 'doer', did: 'Tank', suffered: 'Tank' },
  witch_aggro:  { verb: 'startled the witch', actorIs: 'doer', did: 'Witch', suffered: 'Witch' },
  witch_killed: { verb: 'killed the witch', actorIs: 'doer', did: 'Witch kills', suffered: 'Witch kills' },
  car_alarm:    { verb: 'set off a car alarm', actorIs: 'doer', did: 'Car alarms', suffered: 'Car alarms' },
};

/** The fields a sentence needs. Both the timeline entry and the live feed's
 *  event satisfy it structurally. */
export interface EventLike {
  event: string;
  actor: string;
  target: string | null;
  value: number;
}

/** The value as words, or null when it carries nothing worth saying.
 *
 *  `si_spawn` is the one kind whose value is a code rather than a quantity:
 *  it is the `m_zombieClass` index, and zero is a real (if unnamed) class
 *  rather than "no value". */
export function valueText(event: string, value: number): string | null {
  if (event === 'si_spawn') return ZOMBIE_CLASSES[value] || `class ${value}`;
  if (value <= 0) return null;
  const unit = EVENT_KINDS[event]?.unit;
  return unit ? `${unit} ${value}` : String(value);
}

/** Everything after the actor: "pounced tino for 22". */
export function eventPhrase(e: EventLike, nameOf: (id: string) => string): string {
  const k = EVENT_KINDS[e.event];
  const parts = [k?.verb ?? e.event];
  if (e.target) {
    if (k?.link) parts.push(k.link);
    parts.push(nameOf(e.target));
  }
  const v = valueText(e.event, e.value);
  if (v) parts.push(v);
  return parts.join(' ');
}

export function eventSentence(e: EventLike, nameOf: (id: string) => string): string {
  return `${nameOf(e.actor)} ${eventPhrase(e, nameOf)}`;
}

export type Role = 'did' | 'suffered';

/** Which side of the event a player was on, or null if they were not in it. */
export function roleOf(e: EventLike, steamid: string): Role | null {
  const actorIs = EVENT_KINDS[e.event]?.actorIs ?? 'doer';
  if (e.actor === steamid) return actorIs === 'doer' ? 'did' : 'suffered';
  if (e.target === steamid) return actorIs === 'doer' ? 'suffered' : 'did';
  return null;
}

export function groupLabel(event: string, role: Role): string {
  const k = EVENT_KINDS[event];
  if (!k) return event;
  return role === 'did' ? k.did : k.suffered;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/replay/eventText.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Point the live feed at the same table**

In `web/src/components/StatTable.tsx`, delete the `KIND_VERBS` constant (the block starting `/** How each event kind reads.` through the closing `};`) and add at the top of the file:

```ts
import { EVENT_KINDS } from '../replay/eventText';
```

In `EventFeed`, replace `const verb = KIND_VERBS[e.kind];` with `const verb = EVENT_KINDS[e.kind];` and replace the verb span:

```tsx
<span class="muted">{verb?.verb ?? e.kind}{verb?.link && e.target ? ` ${verb.link}` : ''}</span>
```

The `unit` lookup two lines below (`verb?.unit ?? 'for'`) keeps working because `EventKind` has the same `unit` field.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: 851 tests pass (835 + 16), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/replay/eventText.ts web/src/replay/eventText.test.ts web/src/components/StatTable.tsx
git commit -m "feat(replay): one event vocabulary with roles and sentences"
```

---

### Task 2: Structured timeline payload

Spec 7.2, Payload and Sentences. Fixes the live bug where the rail printed "Tunnel pounce 76561198000000002 34".

**Files:**
- Modify: `src/routes/replays.ts:323-365` (the timeline route)
- Modify: `tests/replayRoutes.test.ts:524-565`
- Modify: `web/src/replay/timeline.ts`
- Modify: `web/src/replay/timeline.test.ts`
- Modify: `web/src/replay/TimelineRail.tsx`
- Modify: `web/src/replay/ReplayControls.test.tsx`

**Interfaces:**
- Consumes: `eventPhrase` from Task 1.
- Produces:
  - `interface TimelineEvent { seq: number; tMs: number; kind: 'event'; event: string; actor: string; target: string | null; value: number }`
  - `interface TimelineChat { seq: number; tMs: number; kind: 'chat'; actor: string; team: string | null; text: string }`
  - `type TimelineEntry = TimelineEvent | TimelineChat`
  - `entryText(e: TimelineEntry, nameOf: (id: string) => string): string`
  - The route serves exactly these two shapes.

- [ ] **Step 1: Extend the route test**

In `tests/replayRoutes.test.ts`, in the test `returns events and chat for that map and half, in sequence order`, replace the two assertion lines at the end with:

```ts
    const body = res.json() as { entries: Record<string, unknown>[] };
    expect(body.entries).toEqual([
      { seq: 1, tMs: 5000, kind: 'event', event: 'pounce', actor: 'A', target: 'B', value: 20 },
      { seq: 2, tMs: 6000, kind: 'chat', actor: 'A', team: 'survivor', text: 'nice' },
    ]);
    // The old payload composed a `text` of kind, raw target id and value; a
    // seventeen-digit id is not a name and the client now composes the
    // sentence itself.
    expect(body.entries[0]).not.toHaveProperty('text');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/replayRoutes.test.ts -t "returns events and chat"`
Expected: FAIL, the event entry has `text` and no `event`.

- [ ] **Step 3: Change the route**

In `src/routes/replays.ts`, replace the `const entries = [` block through `].sort((a, b) => a.seq - b.seq);` with:

```ts
    // Two shapes, discriminated on `kind`, mirroring TimelineEntry in
    // web/src/replay/timeline.ts. An event carries the plugin's own kind
    // slug and its operands and the client composes the sentence, so every
    // id in it can be resolved through the roster; the old pre-joined `text`
    // put a raw target SteamID on screen.
    const entries = [
      ...events.map((e) => ({
        seq: e.seq, tMs: e.tMs, kind: 'event' as const,
        event: e.kind, actor: e.actor, target: e.target, value: e.value,
      })),
      ...chat.map((c) => ({
        seq: c.seq, tMs: c.tMs, kind: 'chat' as const,
        actor: c.steamid, team: c.team, text: c.message,
      })),
    ].sort((a, b) => a.seq - b.seq);
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `npx vitest run tests/replayRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite the web type and add entryText**

Replace `web/src/replay/timeline.ts` in full:

```ts
import { eventPhrase } from './eventText';

interface TimelineBase {
  /** Per-match monotonic sequence shared by events and chat, so the two
   *  interleave in the order they really happened. */
  seq: number;
  tMs: number;
}

/** One thing that happened, as the plugin reported it. `event` is the kind
 *  slug (dp, boom, death...); see EVENT_KINDS for how each reads. */
export interface TimelineEvent extends TimelineBase {
  kind: 'event';
  event: string;
  actor: string;
  target: string | null;
  value: number;
}

export interface TimelineChat extends TimelineBase {
  kind: 'chat';
  actor: string;
  team: string | null;
  text: string;
}

export type TimelineEntry = TimelineEvent | TimelineChat;

/** What the rail prints after the speaker or actor: the message, or the
 *  event phrase with every id resolved. */
export function entryText(e: TimelineEntry, nameOf: (id: string) => string): string {
  return e.kind === 'chat' ? e.text : eventPhrase(e, nameOf);
}

/** How much history the rail shows by default. Long enough to read what just
 *  happened, short enough that it is not a wall of text during a horde. */
export const DEFAULT_WINDOW_MS = 20_000;

/**
 * Entries the viewer may show at this moment.
 *
 * Nothing in the future is ever returned, and nothing older than the window.
 * That is presentation, not protection: the server only serves a timeline for
 * a completed match, so there is nothing here to hold back. A live timeline
 * would need its own server-side cutoff, the way the frames have one, rather
 * than relying on this filter.
 */
export function activeEntries(
  entries: TimelineEntry[], tMs: number, windowMs = DEFAULT_WINDOW_MS,
): TimelineEntry[] {
  const from = tMs - windowMs;
  return entries.filter((e) => e.tMs <= tMs && e.tMs >= from);
}
```

- [ ] **Step 6: Update the timeline test fixtures and add an entryText test**

Replace the `entries` constant in `web/src/replay/timeline.test.ts` and add one test:

```ts
import { describe, it, expect } from 'vitest';
import { activeEntries, entryText, type TimelineEntry } from './timeline';

const entries: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'dp', actor: 'A', target: 'B', value: 20 },
  { seq: 2, tMs: 5000, kind: 'chat', actor: 'B', team: 'survivor', text: 'nice' },
  { seq: 3, tMs: 9000, kind: 'event', event: 'death', actor: 'C', target: null, value: 0 },
];

describe('entryText', () => {
  const nameOf = (id: string) => ({ A: 'volence', B: 'tino' }[id] ?? id);
  it('is the message for chat and the resolved phrase for an event', () => {
    expect(entryText(entries[1], nameOf)).toBe('nice');
    expect(entryText(entries[0], nameOf)).toBe('pounced tino for 20');
  });
});
```

Keep the existing `describe('activeEntries', ...)` block as it is.

- [ ] **Step 7: Make the rail and the controls test compile against the union**

In `web/src/replay/TimelineRail.tsx`, change the import and the two spans:

```ts
import { activeEntries, entryText, type TimelineEntry } from './timeline';
```

```tsx
export function TimelineRail({ timeline, tMs, toggles, seek, names }: TimelineRailProps) {
  const nameOf = (id: string) => names[id] ?? id;
  return (
    <div class="replay__rail">
      {activeEntries(timeline, tMs)
        .filter((e) => (e.kind === 'chat' ? toggles.chat : toggles.events))
        .map((e) => (
          <button
            key={e.seq}
            class={`replay__entry replay__entry--${e.kind}`}
            onClick={() => seek(e.tMs)}
          >
            <span class="replay__entry-t">{formatTime(e.tMs)}</span>
            <span class="replay__entry-who">{nameOf(e.actor)}</span>
            <span class="replay__entry-text">{entryText(e, nameOf)}</span>
          </button>
        ))}
    </div>
  );
}
```

In `web/src/replay/ReplayControls.test.tsx`, replace the two fixture entries:

```ts
        timeline={[
          { seq: 1, tMs: 25000, kind: 'event', event: 'dp', actor: 'x', target: 'y', value: 12 },
          { seq: 2, tMs: 50000, kind: 'chat', actor: 'y', team: 'survivor', text: 'gg' },
        ]}
```

- [ ] **Step 8: Run everything**

Run: `npm test && npm run typecheck`
Expected: 852 tests pass, typecheck clean. If typecheck reports another consumer of `TimelineEntry.text` on an event, fix it with `entryText`; the known consumers are only the rail and the two tests.

- [ ] **Step 9: Commit**

```bash
git add src/routes/replays.ts tests/replayRoutes.test.ts web/src/replay/timeline.ts web/src/replay/timeline.test.ts web/src/replay/TimelineRail.tsx web/src/replay/ReplayControls.test.tsx
git commit -m "feat(replay): structured timeline entries, names resolved on every id"
```

---

### Task 3: Bookmark filtering and grouping

Spec 7.2, Selection and Rail. Pure functions; the components in Tasks 4 and 5 only call these.

**Files:**
- Create: `web/src/replay/bookmarks.ts`
- Create: `web/src/replay/bookmarks.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry`, `TimelineEvent` (Task 2); `roleOf`, `groupLabel`, `Role` (Task 1).
- Produces:
  - `interface Tick { entry: TimelineEntry; role: Role | null }`
  - `tickEntries(timeline: TimelineEntry[], selected: string | null): Tick[]`
  - `interface TickGroup { key: string; label: string; role: Role; items: { entry: TimelineEvent; role: Role }[] }`
  - `groupTicks(ticks: Tick[]): TickGroup[]`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/replay/bookmarks.test.ts
import { describe, it, expect } from 'vitest';
import { groupTicks, tickEntries } from './bookmarks';
import type { TimelineEntry } from './timeline';

const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'chat', actor: 'A', team: 'survivor', text: 'ugh' },
  { seq: 3, tMs: 3000, kind: 'event', event: 'dp', actor: 'H', target: 'C', value: 25 },
  { seq: 4, tMs: 4000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 5, tMs: 5000, kind: 'event', event: 'death', actor: 'A', target: 'H', value: 0 },
  { seq: 6, tMs: 6000, kind: 'chat', actor: 'C', team: 'survivor', text: 'rip' },
  { seq: 7, tMs: 7000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

describe('tickEntries', () => {
  it('returns everything with no role when nobody is selected', () => {
    const ticks = tickEntries(T, null);
    expect(ticks).toHaveLength(7);
    expect(ticks.every((t) => t.role === null)).toBe(true);
  });

  it('keeps only the events the player was in, plus their own chat', () => {
    const seqs = tickEntries(T, 'A').map((t) => t.entry.seq);
    expect(seqs).toEqual([1, 2, 4, 5, 7]);
  });

  it('marks the side the player was on, per kind', () => {
    const byseq = Object.fromEntries(tickEntries(T, 'A').map((t) => [t.entry.seq, t.role]));
    expect(byseq[1]).toBe('suffered');   // got boomed
    expect(byseq[2]).toBeNull();          // own chat has no side
    expect(byseq[5]).toBe('suffered');   // died (victim-first kind)
    expect(byseq[7]).toBe('did');         // skeeted
  });

  it('sees the other side of the same events for the infected player', () => {
    const byseq = Object.fromEntries(tickEntries(T, 'H').map((t) => [t.entry.seq, t.role]));
    expect(byseq[3]).toBe('did');
    expect(byseq[5]).toBe('did');         // the kill
    expect(byseq[7]).toBe('suffered');   // got skeeted
  });

  it('selects nobody for a blank id rather than matching empty actors', () => {
    const blank: TimelineEntry[] = [
      { seq: 1, tMs: 0, kind: 'event', event: 'car_alarm', actor: '', target: null, value: 0 },
    ];
    expect(tickEntries(blank, '')).toEqual([]);
  });
});

describe('groupTicks', () => {
  it('groups events by kind and side, biggest group first, ties by first seq', () => {
    const groups = groupTicks(tickEntries(T, 'A'));
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Got boomed', 2], ['Deaths', 1], ['Skeets', 1],
    ]);
    expect(groups[0].role).toBe('suffered');
    expect(groups[0].items.map((i) => i.entry.seq)).toEqual([1, 4]);
  });

  it('leaves chat out of the groups', () => {
    const groups = groupTicks(tickEntries(T, 'A'));
    expect(groups.flatMap((g) => g.items).every((i) => i.entry.kind === 'event')).toBe(true);
  });

  it('is empty for an unselected tick list', () => {
    expect(groupTicks(tickEntries(T, null))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/bookmarks.test.ts`
Expected: FAIL, cannot resolve `./bookmarks`.

- [ ] **Step 3: Write the module**

```ts
// web/src/replay/bookmarks.ts
import { groupLabel, roleOf, type Role } from './eventText';
import type { TimelineEntry, TimelineEvent } from './timeline';

/** One mark on the scrub bar or one line in the rail. `role` is which side
 *  the selected player was on, or null when nobody is selected or the entry
 *  is chat (chat has no side). */
export interface Tick {
  entry: TimelineEntry;
  role: Role | null;
}

/**
 * What to show for a selection.
 *
 * Nobody selected: everything, unsided. A player selected: the events they
 * were actor or target of, plus their own chat lines. The follow row is the
 * selector (spec 7.2), so `selected` is the SteamID64 in the followed slot;
 * an empty slot has '' there, which must select nothing rather than match
 * every event with an unrostered actor.
 */
export function tickEntries(timeline: TimelineEntry[], selected: string | null): Tick[] {
  if (selected === null) return timeline.map((entry) => ({ entry, role: null }));
  if (selected === '') return [];
  const out: Tick[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'chat') {
      if (entry.actor === selected) out.push({ entry, role: null });
      continue;
    }
    const role = roleOf(entry, selected);
    if (role) out.push({ entry, role });
  }
  return out;
}

export interface TickGroup {
  key: string;
  label: string;
  role: Role;
  items: { entry: TimelineEvent; role: Role }[];
}

/**
 * The selected player's events by kind and side, for the rail's headings:
 * "Got boomed x3", "Pounces x2". Biggest group first so the thing that
 * happened most is the first thing read; ties keep round order.
 */
export function groupTicks(ticks: Tick[]): TickGroup[] {
  const groups = new Map<string, TickGroup>();
  for (const t of ticks) {
    if (t.entry.kind !== 'event' || t.role === null) continue;
    const key = `${t.entry.event}:${t.role}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: groupLabel(t.entry.event, t.role), role: t.role, items: [] };
      groups.set(key, g);
    }
    g.items.push({ entry: t.entry, role: t.role });
  }
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || a.items[0].entry.seq - b.items[0].entry.seq,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run web/src/replay/bookmarks.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/bookmarks.ts web/src/replay/bookmarks.test.ts
git commit -m "feat(replay): bookmark filtering and grouping for a selected player"
```

---

### Task 4: Clickable, role-coloured scrub ticks

Spec 7.2, Clickable ticks and Role colour. The selected player is derived from `followSlot` and the header's slot roster, which `ReplayControls` already receives.

**Files:**
- Modify: `web/src/replay/ReplayControls.tsx:53-66` (the ticks layer)
- Modify: `web/src/replay/ReplayControls.test.tsx`
- Modify: `web/src/styles/app.css` (the `.scrub__ticks` and `.scrub__tick` rules near line 966)

**Interfaces:**
- Consumes: `tickEntries` (Task 3), `entryText` (Task 2).
- Produces: `ReplayControls` renders one `button.scrub__tick` per tick with modifier `--event`, `--chat`, `--did` or `--suffered`, `aria-label` of time plus sentence, and seeks on click. No prop changes.

- [ ] **Step 1: Rewrite the ticks tests**

Replace the `describe('ReplayControls ticks', ...)` block in `web/src/replay/ReplayControls.test.tsx` with:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ReplayControls } from './ReplayControls';
import type { TimelineEntry } from './timeline';

afterEach(cleanup);

const playback = {
  tRef: { current: 0 }, tMs: 0, playing: true, speed: 1, following: false,
  play() {}, pause() {}, toggle() {}, seek() {}, setSpeed() {}, follow() {},
};

const SLOTS = ['A', 'B', '', '', 'H', '', '', ''];
const NAMES = { A: 'volence', B: 'tino', H: 'hunter' };
const T: TimelineEntry[] = [
  { seq: 1, tMs: 25000, kind: 'event', event: 'dp', actor: 'H', target: 'A', value: 12 },
  { seq: 2, tMs: 50000, kind: 'chat', actor: 'B', team: 'survivor', text: 'gg' },
  { seq: 3, tMs: 75000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

function mount(over: Partial<Parameters<typeof ReplayControls>[0]> = {}) {
  return render(
    <ReplayControls
      playback={playback} endMs={100000} live={false}
      followSlot={null} setFollowSlot={() => {}} slots={SLOTS} names={NAMES}
      timeline={T}
      {...over}
    />,
  );
}

describe('ReplayControls ticks', () => {
  it('places one tick per timeline entry at its fraction of the round', () => {
    const { container } = mount();
    const ticks = container.querySelectorAll('.scrub__tick');
    expect(ticks).toHaveLength(3);
    expect((ticks[0] as HTMLElement).style.left).toBe('25%');
    expect(ticks[0].classList.contains('scrub__tick--event')).toBe(true);
    expect((ticks[1] as HTMLElement).style.left).toBe('50%');
    expect(ticks[1].classList.contains('scrub__tick--chat')).toBe(true);
  });

  it('renders no tick layer without a timeline', () => {
    const { container } = mount({ timeline: undefined });
    expect(container.querySelector('.scrub__tick')).toBeNull();
  });

  it('seeks to the entry when a tick is clicked, and says what it is', () => {
    const seek = vi.fn();
    const { container } = mount({ playback: { ...playback, seek } });
    const tick = container.querySelectorAll('.scrub__tick')[0] as HTMLButtonElement;
    expect(tick.tagName).toBe('BUTTON');
    expect(tick.getAttribute('aria-label')).toBe('0:25 hunter pounced volence for 12');
    fireEvent.click(tick);
    expect(seek).toHaveBeenCalledWith(25000);
  });

  // Spec 7.2: the follow row is the selector. Slot 0 is 'A'.
  it('filters and colours the ticks by the followed player and their side', () => {
    const { container } = mount({ followSlot: 0 });
    const ticks = [...container.querySelectorAll('.scrub__tick')];
    expect(ticks).toHaveLength(2);
    expect(ticks[0].classList.contains('scrub__tick--suffered')).toBe(true);
    expect(ticks[1].classList.contains('scrub__tick--did')).toBe(true);
  });

  it('shows nothing for a followed slot with no roster entry', () => {
    const { container } = mount({ followSlot: 2 });
    expect(container.querySelectorAll('.scrub__tick')).toHaveLength(0);
  });

  it('sizes the progress fill as a percentage of the round, browser-independently', () => {
    const { container } = mount({ playback: { ...playback, tMs: 25000 } });
    const progress = container.querySelector('.scrub__progress') as HTMLElement;
    expect(progress.style.width).toBe('25%');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/ReplayControls.test.tsx`
Expected: FAIL on the click test (ticks are spans, no aria-label) and the filter test (3 ticks, no role class).

- [ ] **Step 3: Rewrite the ticks layer**

In `web/src/replay/ReplayControls.tsx`, add imports:

```ts
import { tickEntries } from './bookmarks';
import { entryText, type TimelineEntry } from './timeline';
```

(replace the existing `import type { TimelineEntry } from './timeline';`). Inside the component body, before the `return`, add:

```tsx
  const nameOf = (id: string) => names[id] ?? id;
  // The follow row is the bookmark selector (spec 7.2). An unrostered slot is
  // '' in the header and selects nothing rather than everything.
  const selected = followSlot === null ? null : (slots[followSlot] ?? '');
  const ticks = timeline ? tickEntries(timeline, selected) : [];
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / endMs) * 100))}%`;
```

Replace the `{timeline && endMs > 0 && (<div class="scrub__ticks" aria-hidden="true">...</div>)}` block with:

```tsx
          {timeline && endMs > 0 && (
            <div class="scrub__ticks">
              {ticks.map(({ entry: e, role }) => (
                <button
                  key={e.seq}
                  type="button"
                  class={`scrub__tick scrub__tick--${role ?? e.kind}`}
                  style={{ left: pct(e.tMs) }}
                  aria-label={`${formatTime(e.tMs)} ${nameOf(e.actor)} ${entryText(e, nameOf)}`}
                  onClick={() => playback.seek(e.tMs)}
                />
              ))}
            </div>
          )}
```

- [ ] **Step 4: Style the tick as a 10px hit target drawing a 2px line**

In `web/src/styles/app.css`, replace the four rules `.scrub__ticks`, `.scrub__tick`, `.scrub__tick--event`, `.scrub__tick--chat` with:

```css
/* Ticks are seek targets (spec 7.2): a 10px button, centred on the moment,
   drawing the 2px line it used to be as a pseudo element. They sit above the
   range input so a click on a tick lands on the event rather than on the
   pixel under it; the layer itself lets clicks through. */
.scrub__ticks { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.scrub__tick {
  position: absolute; top: 0; bottom: 0; width: 10px; transform: translateX(-50%);
  padding: 0; border: 0; background: transparent; cursor: pointer; pointer-events: auto;
  --tick: var(--accent);
}
.scrub__tick::after { content: ''; position: absolute; left: 4px; top: 3px; width: 2px; height: 16px; background: var(--tick); }
.scrub__tick:hover::after, .scrub__tick:focus-visible::after { left: 3px; width: 4px; }
.scrub__tick:focus-visible { outline: 2px solid var(--text-bright); outline-offset: -2px; }
.scrub__tick--event { --tick: var(--accent); }
.scrub__tick--chat { --tick: var(--text-muted); opacity: 0.6; }
.scrub__tick--did { --tick: var(--win); }
.scrub__tick--suffered { --tick: var(--accent); }
```

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/replay/ReplayControls.tsx web/src/replay/ReplayControls.test.tsx web/src/styles/app.css
git commit -m "feat(replay): clickable scrub ticks filtered and coloured by the followed player"
```

---

### Task 5: Per-player rail

Spec 7.2, Rail. Unselected the rail is unchanged. Selected, it shows the whole round grouped with counts.

**Files:**
- Modify: `web/src/replay/TimelineRail.tsx`
- Create: `web/src/replay/TimelineRail.test.tsx`
- Modify: `web/src/replay/Viewer.tsx:150-158` (pass `selected`)
- Modify: `web/src/styles/app.css` (`.replay__rail` rules near line 900)

**Interfaces:**
- Consumes: `tickEntries`, `groupTicks` (Task 3), `entryText` (Task 2).
- Produces: `TimelineRailProps` gains `selected: string | null`. Grouped markup: `section.rail-group > div.rail-group__head.rail-group__head--{did|suffered} + button.replay__entry...`, entries after the playhead carry `replay__entry--ahead`.

- [ ] **Step 1: Write the failing render tests**

```tsx
// web/src/replay/TimelineRail.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/preact';
import { TimelineRail } from './TimelineRail';
import { DEFAULT_TOGGLES } from './useToggles';
import type { TimelineEntry } from './timeline';

afterEach(cleanup);

const NAMES = { A: 'volence', B: 'tino', H: 'hunter', Z: 'boomer', Q: 'quiet' };
const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'Z', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'chat', actor: 'A', team: 'survivor', text: 'ugh' },
  { seq: 3, tMs: 30000, kind: 'event', event: 'dp', actor: 'H', target: 'B', value: 25 },
  { seq: 4, tMs: 40000, kind: 'event', event: 'boom', actor: 'Z', target: 'A', value: 0 },
  { seq: 5, tMs: 50000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

function mount(selected: string | null, tMs: number, seek = vi.fn()) {
  const r = render(
    <TimelineRail timeline={T} tMs={tMs} toggles={DEFAULT_TOGGLES} seek={seek} names={NAMES} selected={selected} />,
  );
  return { ...r, seek };
}

describe('TimelineRail, nobody selected', () => {
  it('shows the rolling window with names resolved on every id', () => {
    const { container } = mount(null, 35000);
    const rows = [...container.querySelectorAll('.replay__entry')];
    // 30000 is inside the 20s window ending at 35000; 1000 and 2000 are not.
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('hunter');
    expect(rows[0].textContent).toContain('pounced tino for 25');
    expect(rows[0].textContent).not.toMatch(/\bB\b/);
  });
});

describe('TimelineRail, a player selected', () => {
  it('shows the whole round for that player, grouped by kind and side with counts', () => {
    const { container } = mount('A', 0);
    const heads = [...container.querySelectorAll('.rail-group__head')].map((h) => h.textContent);
    expect(heads).toEqual(['Got boomed ×2', 'Skeets ×1', 'Chat ×1']);
    expect(container.querySelector('.rail-group__head--suffered')?.textContent).toContain('Got boomed');
    expect(container.querySelector('.rail-group__head--did')?.textContent).toContain('Skeets');
  });

  it('dims what is still ahead of the playhead and seeks on click', () => {
    const { container, seek } = mount('A', 1500);
    const rows = [...container.querySelectorAll('.replay__entry')];
    const ahead = rows.filter((r) => r.classList.contains('replay__entry--ahead'));
    // Everything after 1.5s: the second boom, the skeet, the chat at 2s.
    expect(ahead).toHaveLength(3);
    fireEvent.click(rows[1]);
    expect(seek).toHaveBeenCalledWith(40000);
  });

  // Q is rostered but in no event and no chat line. (B would not do: B is
  // the target of the pounce at seq 3.)
  it('says so when the player has nothing this round', () => {
    mount('Q', 0);
    expect(screen.getByText(/nothing recorded for quiet/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/TimelineRail.test.tsx`
Expected: FAIL (typecheck error on `selected`, and no `.rail-group__head`).

- [ ] **Step 3: Rewrite the rail**

Replace `web/src/replay/TimelineRail.tsx` in full:

```tsx
import { groupTicks, tickEntries } from './bookmarks';
import { activeEntries, entryText, type TimelineEntry } from './timeline';
import { formatTime } from './ReplayControls';
import type { Toggles } from './useToggles';

export interface TimelineRailProps {
  timeline: TimelineEntry[];
  tMs: number;
  toggles: Toggles;
  seek: (t: number) => void;
  names: Record<string, string>;
  /** SteamID64 of the followed player, or null. Selecting one turns the rail
   *  from a rolling window into that player's whole round (spec 7.2). */
  selected: string | null;
}

function Entry(
  { e, tMs, seek, nameOf }:
  { e: TimelineEntry; tMs: number; seek: (t: number) => void; nameOf: (id: string) => string },
) {
  return (
    <button
      class={`replay__entry replay__entry--${e.kind}${e.tMs > tMs ? ' replay__entry--ahead' : ''}`}
      onClick={() => seek(e.tMs)}
    >
      <span class="replay__entry-t">{formatTime(e.tMs)}</span>
      <span class="replay__entry-who">{nameOf(e.actor)}</span>
      <span class="replay__entry-text">{entryText(e, nameOf)}</span>
    </button>
  );
}

/**
 * The rail of events and chat under the stage.
 *
 * Purely presentational, same discipline as ReplayControls: everything it
 * shows and does is a prop or a callback. Unselected, `activeEntries` keeps
 * it to the last twenty seconds. Selected, it is a bookmark list for one
 * player: every event they were part of, grouped by what happened and which
 * side of it they were on, with entries ahead of the playhead dimmed rather
 * than hidden so the whole round is jumpable.
 */
export function TimelineRail({ timeline, tMs, toggles, seek, names, selected }: TimelineRailProps) {
  const nameOf = (id: string) => names[id] ?? id;
  const visible = (e: TimelineEntry) => (e.kind === 'chat' ? toggles.chat : toggles.events);

  if (selected !== null) {
    const ticks = tickEntries(timeline, selected).filter((t) => visible(t.entry));
    const groups = groupTicks(ticks);
    const chat = ticks.filter((t) => t.entry.kind === 'chat');
    if (groups.length === 0 && chat.length === 0) {
      return (
        <div class="replay__rail replay__rail--player">
          <span class="replay__rail-empty">Nothing recorded for {nameOf(selected)} this round.</span>
        </div>
      );
    }
    return (
      <div class="replay__rail replay__rail--player">
        {groups.map((g) => (
          <section key={g.key} class="rail-group">
            <div class={`rail-group__head rail-group__head--${g.role}`}>
              {g.label} <span class="num">×{g.items.length}</span>
            </div>
            {g.items.map((i) => <Entry key={i.entry.seq} e={i.entry} tMs={tMs} seek={seek} nameOf={nameOf} />)}
          </section>
        ))}
        {chat.length > 0 && (
          <section class="rail-group">
            <div class="rail-group__head">Chat <span class="num">×{chat.length}</span></div>
            {chat.map((t) => <Entry key={t.entry.seq} e={t.entry} tMs={tMs} seek={seek} nameOf={nameOf} />)}
          </section>
        )}
      </div>
    );
  }

  return (
    <div class="replay__rail">
      {activeEntries(timeline, tMs).filter(visible).map((e) => (
        <Entry key={e.seq} e={e} tMs={tMs} seek={seek} nameOf={nameOf} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Pass the selection from the viewer**

In `web/src/replay/Viewer.tsx`, after the `followSlot` state line, add:

```ts
  // The follow row is the bookmark selector (spec 7.2). '' is an unrostered
  // slot and selects nothing; see tickEntries.
  const selected = followSlot === null || !header ? null : (header.slots[followSlot] ?? '');
```

(`header` is declared above it by `useReplaySource`; this line must come after that call.) Then add `selected={selected}` to the `<TimelineRail ... />` element.

- [ ] **Step 5: Style the groups**

In `web/src/styles/app.css`, after the `.replay__entry-who { font-weight: 600; }` rule, add:

```css
.replay__entry--ahead { opacity: 0.45; }
.replay__rail--player { max-height: 24rem; }
.replay__rail-empty { font-family: var(--font-label); font-size: var(--fs-dense); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); padding: var(--sp-2) 0.3rem; }
.rail-group { display: flex; flex-direction: column; gap: 0.15rem; }
.rail-group + .rail-group { margin-top: var(--sp-2); }
.rail-group__head { font-family: var(--font-label); font-size: var(--fs-label); letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-muted); padding: 0.15rem 0.3rem; border-bottom: 1px solid var(--border); }
.rail-group__head--did { color: var(--win); }
.rail-group__head--suffered { color: var(--accent); }
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/replay/TimelineRail.tsx web/src/replay/TimelineRail.test.tsx web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): per-player bookmark rail grouped by kind and side"
```

---

### Task 6: Camera math

Spec 7.1, Camera and Tests: zoom about a point, pan clamping to the content box, round-tripping a world position through project and inverse. Pure; nothing renders yet.

**Files:**
- Modify: `src/mapTransform.ts` (add `unprojectView` after `projectView`)
- Create: `web/src/replay/camera.ts`
- Create: `web/src/replay/camera.test.ts`

**Interfaces:**
- Produces:
  - `unprojectView(t: MapTransform, v: View, px: number, py: number): { x: number; y: number }` in `src/mapTransform.ts`
  - `interface Camera { zoom: number; panX: number; panY: number }`; `FIT_CAMERA`; `ZOOM_LEVELS = [1, 2, 4, 6]`; `MIN_ZOOM = 1`; `MAX_ZOOM = 8`; `WHEEL_STEP = 1.25`
  - `clampZoom(z: number): number`
  - `zoomedView(fit: View, cam: Camera, cssW: number, cssH: number): View`
  - `clampPan(fit: View, cam: Camera, cssW: number, cssH: number): Camera`
  - `zoomAbout(fit: View, cam: Camera, zoom: number, px: number, py: number, cssW: number, cssH: number): Camera`
  - `type Follow = { kind: 'free' } | { kind: 'team' } | { kind: 'slot'; slot: number }`; `FREE`; `TEAM`
  - `followSlotOf(f: Follow): number | null`
  - `followPoint(players: PlayerSample[], f: Follow): { x: number; y: number } | null`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/replay/camera.test.ts
import { describe, it, expect } from 'vitest';
import {
  FIT_CAMERA, FREE, TEAM, MAX_ZOOM, clampPan, clampZoom, followPoint, followSlotOf, zoomAbout, zoomedView,
} from './camera';
import { fitView, projectView, unprojectView, type MapTransform } from '../../../src/mapTransform';
import { STATE, type PlayerSample } from '../../../src/replayFormat';

const T: MapTransform = { originX: -1000, originY: 2000, unitsPerPixel: 4, image: null, width: 2048, height: 1271 };
// A content box the same shape as the canvas, so at fit (3 percent padding)
// the drawn map is a little smaller than the canvas on BOTH axes and at any
// zoom of 2 or more it overflows both. The clamp behaves differently in the
// two regimes and the tests below need each one cleanly.
const BOX = { x0: 0, y0: 0, x1: 1600, y1: 1000 };
const W = 800, H = 500;
const FIT = fitView(BOX, W, H);

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('unprojectView', () => {
  it('round-trips a world position through project and inverse', () => {
    const v = zoomedView(FIT, { zoom: 3, panX: 40, panY: -25 }, W, H);
    const p = projectView(T, v, 123.4, -567.8);
    const w = unprojectView(T, v, p.px, p.py);
    expect(w.x).toBeCloseTo(123.4, 6);
    expect(w.y).toBeCloseTo(-567.8, 6);
  });
});

describe('zoomedView', () => {
  it('is the fit itself at zoom 1 with no pan', () => {
    const v = zoomedView(FIT, FIT_CAMERA, W, H);
    expect(v.scale).toBeCloseTo(FIT.scale, 9);
    expect(v.offsetX).toBeCloseTo(FIT.offsetX, 9);
    expect(v.offsetY).toBeCloseTo(FIT.offsetY, 9);
    expect(v.box).toBe(FIT.box);
  });

  it('magnifies about the canvas centre', () => {
    const v = zoomedView(FIT, { zoom: 2, panX: 0, panY: 0 }, W, H);
    // The image point at the canvas centre before is still there after.
    const centreBefore = unprojectView(T, FIT, W / 2, H / 2);
    const centreAfter = unprojectView(T, v, W / 2, H / 2);
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 6);
    expect(centreAfter.y).toBeCloseTo(centreBefore.y, 6);
    expect(v.scale).toBeCloseTo(FIT.scale * 2, 9);
  });

  it('shifts by the pan in canvas pixels', () => {
    const a = zoomedView(FIT, { zoom: 2, panX: 0, panY: 0 }, W, H);
    const b = zoomedView(FIT, { zoom: 2, panX: 30, panY: -10 }, W, H);
    expect(b.offsetX - a.offsetX).toBeCloseTo(30, 9);
    expect(b.offsetY - a.offsetY).toBeCloseTo(-10, 9);
  });
});

describe('clampPan', () => {
  it('centres an axis where the drawn map fits inside the canvas', () => {
    // At fit the map is smaller than the canvas on both axes: no pan at all.
    const c = clampPan(FIT, { zoom: 1, panX: 300, panY: -300 }, W, H);
    expect(c.panX).toBe(0);
    expect(c.panY).toBe(0);
  });

  it('never shows void past the map edge on an axis the map overflows', () => {
    const cam = { zoom: 4, panX: 5000, panY: -5000 };
    const c = clampPan(FIT, cam, W, H);
    const v = zoomedView(FIT, c, W, H);
    const drawnW = (BOX.x1 - BOX.x0) * v.scale;
    const drawnH = (BOX.y1 - BOX.y0) * v.scale;
    // Left edge at or left of the canvas edge, right edge at or right of it.
    expect(v.offsetX).toBeLessThanOrEqual(0 + 1e-9);
    expect(v.offsetX + drawnW).toBeGreaterThanOrEqual(W - 1e-9);
    expect(v.offsetY).toBeLessThanOrEqual(0 + 1e-9);
    expect(v.offsetY + drawnH).toBeGreaterThanOrEqual(H - 1e-9);
  });

  it('leaves a pan that is already inside the limits alone', () => {
    const cam = { zoom: 4, panX: 10, panY: 10 };
    expect(clampPan(FIT, cam, W, H)).toEqual(cam);
  });
});

describe('zoomAbout', () => {
  it('keeps the map point under the cursor where it is', () => {
    const cam = { zoom: 2, panX: 0, panY: 0 };
    const cursor = { px: 500, py: 300 };
    const before = unprojectView(T, zoomedView(FIT, cam, W, H), cursor.px, cursor.py);
    const next = zoomAbout(FIT, cam, 4, cursor.px, cursor.py, W, H);
    const after = unprojectView(T, zoomedView(FIT, next, W, H), cursor.px, cursor.py);
    expect(next.zoom).toBe(4);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps the zoom and then the pan', () => {
    const next = zoomAbout(FIT, FIT_CAMERA, 50, 10, 10, W, H);
    expect(next.zoom).toBe(MAX_ZOOM);
    expect(next).toEqual(clampPan(FIT, next, W, H));
  });

  it('clampZoom holds the range', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });
});

describe('follow', () => {
  const players = [
    player({ slot: 0, x: 0, y: 0 }),
    player({ slot: 1, x: 100, y: 0 }),
    player({ slot: 2, x: 100, y: 100, state: STATE.PRESENT }),          // dead: left out
    player({ slot: 3, x: 9999, y: 9999, state: 0 }),                     // empty slot
    player({ slot: 4, x: -500, y: -500 }),                               // infected: never in the centroid
  ];

  it('follows nobody when free', () => {
    expect(followPoint(players, FREE)).toBeNull();
    expect(followSlotOf(FREE)).toBeNull();
  });

  it('follows the slot, and reports it for the ring', () => {
    expect(followPoint(players, { kind: 'slot', slot: 1 })).toEqual({ x: 100, y: 0 });
    expect(followSlotOf({ kind: 'slot', slot: 1 })).toBe(1);
  });

  it('follows nobody rather than the world origin for an empty slot', () => {
    expect(followPoint(players, { kind: 'slot', slot: 3 })).toBeNull();
  });

  it('centres the team on the alive, present survivors', () => {
    expect(followPoint(players, TEAM)).toEqual({ x: 50, y: 0 });
    expect(followSlotOf(TEAM)).toBeNull();
  });

  it('falls back to the present survivors when none are alive', () => {
    const wiped = players.map((p) => ({ ...p, state: p.state & ~STATE.ALIVE }));
    expect(followPoint(wiped, TEAM)).toEqual({ x: 200 / 3, y: 100 / 3 });
  });

  it('follows nobody with no survivors present at all', () => {
    expect(followPoint([player({ slot: 4 })], TEAM)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/camera.test.ts`
Expected: FAIL, cannot resolve `./camera` and `unprojectView` is not exported.

- [ ] **Step 3: Add the inverse to the shared transform**

In `src/mapTransform.ts`, directly after `projectView`, add (no imports; the file must stay import-free):

```ts
/** Canvas pixel back to world position: the inverse of `projectView`. What a
 *  drag needs to know which map point is under the cursor. */
export function unprojectView(
  t: MapTransform, v: View, px: number, py: number,
): { x: number; y: number } {
  const ipx = (px - v.offsetX) / v.scale + v.box.x0;
  const ipy = (py - v.offsetY) / v.scale + v.box.y0;
  return {
    x: t.originX + ipx * t.unitsPerPixel,
    y: t.originY - ipy * t.unitsPerPixel,
  };
}
```

- [ ] **Step 4: Write the camera module**

```ts
// web/src/replay/camera.ts
import { boxSpan, type View } from '../../../src/mapTransform';
import { STATE, type PlayerSample } from '../../../src/replayFormat';
import { followTarget, isSurvivor } from './draw';

/**
 * The camera, as a magnification of the fitted view plus a shift.
 *
 * It composes onto the `View` that `fitView` produced rather than replacing
 * it (spec 7.1): a zoomed view is just another View, so `projectView`, the
 * follow translate in ReplayCanvas and `drawScene` all keep working with no
 * knowledge of zoom.
 */
export interface Camera {
  /** Multiplier over the fitted view. 1 is fit. */
  zoom: number;
  /** Shift of the magnified view, in CSS pixels. Zero while following: the
   *  follow translate in ReplayCanvas is the shift then. */
  panX: number;
  panY: number;
}

export const FIT_CAMERA: Camera = { zoom: 1, panX: 0, panY: 0 };
/** The chip group. */
export const ZOOM_LEVELS = [1, 2, 4, 6] as const;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** One wheel notch. Three notches are 1.95x, close enough to a chip step. */
export const WHEEL_STEP = 1.25;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The fitted view magnified about the canvas centre, then shifted by the pan. */
export function zoomedView(fit: View, cam: Camera, cssW: number, cssH: number): View {
  const cx = cssW / 2;
  const cy = cssH / 2;
  return {
    box: fit.box,
    scale: fit.scale * cam.zoom,
    offsetX: cx + (fit.offsetX - cx) * cam.zoom + cam.panX,
    offsetY: cy + (fit.offsetY - cy) * cam.zoom + cam.panY,
  };
}

function clampAxis(pan: number, offset: number, drawn: number, canvas: number): number {
  // Smaller than the canvas: the fit already centred it, and a pan would
  // only move the map off centre for no reason.
  if (drawn <= canvas) return 0;
  // Bigger: the map's edges may reach the canvas edges but never pass them.
  const min = canvas - drawn - offset;
  const max = -offset;
  return Math.min(max, Math.max(min, pan));
}

/** Keep the map on the canvas (spec 7.1: pan clamps to the content box). */
export function clampPan(fit: View, cam: Camera, cssW: number, cssH: number): Camera {
  const unpanned = zoomedView(fit, { zoom: cam.zoom, panX: 0, panY: 0 }, cssW, cssH);
  const { w, h } = boxSpan(fit.box);
  return {
    zoom: cam.zoom,
    panX: clampAxis(cam.panX, unpanned.offsetX, w * unpanned.scale, cssW),
    panY: clampAxis(cam.panY, unpanned.offsetY, h * unpanned.scale, cssH),
  };
}

/** Change the zoom keeping the map point under canvas pixel (px, py) still. */
export function zoomAbout(
  fit: View, cam: Camera, zoom: number, px: number, py: number, cssW: number, cssH: number,
): Camera {
  const z = clampZoom(zoom);
  const before = zoomedView(fit, cam, cssW, cssH);
  // The image-space point under the cursor, box-relative.
  const ix = (px - before.offsetX) / before.scale;
  const iy = (py - before.offsetY) / before.scale;
  const unpanned = zoomedView(fit, { zoom: z, panX: 0, panY: 0 }, cssW, cssH);
  return clampPan(fit, {
    zoom: z,
    panX: px - (ix * unpanned.scale + unpanned.offsetX),
    panY: py - (iy * unpanned.scale + unpanned.offsetY),
  }, cssW, cssH);
}

/** What the camera centres on. `team` is the survivor centroid (spec 7.1). */
export type Follow =
  | { kind: 'free' }
  | { kind: 'team' }
  | { kind: 'slot'; slot: number };

export const FREE: Follow = { kind: 'free' };
export const TEAM: Follow = { kind: 'team' };

/** The slot to draw the follow ring around, or null. */
export function followSlotOf(f: Follow): number | null {
  return f.kind === 'slot' ? f.slot : null;
}

/** The world point to centre on, or null to leave the camera where it is. */
export function followPoint(
  players: PlayerSample[], f: Follow,
): { x: number; y: number } | null {
  if (f.kind === 'free') return null;
  if (f.kind === 'slot') {
    const p = followTarget(players, f.slot);
    return p ? { x: p.x, y: p.y } : null;
  }
  const present = players.filter((p) => isSurvivor(p) && (p.state & STATE.PRESENT) !== 0);
  const alive = present.filter((p) => (p.state & STATE.ALIVE) !== 0);
  // A wiped team still has bodies somewhere; centring on them beats jumping
  // to nowhere in the last seconds of a round.
  const pool = alive.length ? alive : present;
  if (pool.length === 0) return null;
  return {
    x: pool.reduce((n, p) => n + p.x, 0) / pool.length,
    y: pool.reduce((n, p) => n + p.y, 0) / pool.length,
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run web/src/replay/camera.test.ts && npm run typecheck`
Expected: PASS, 16 tests; typecheck clean (the server tsconfig also compiles `mapTransform.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/mapTransform.ts web/src/replay/camera.ts web/src/replay/camera.test.ts
git commit -m "feat(replay): camera math, view inverse and survivor-centroid follow"
```

---

### Task 7: Follow through the canvas, the controls and the viewer

Spec 7.1, Camera: "Follow ... centers on the survivor centroid; choosing a player in the follow row centers on them instead". Replaces the `followSlot: number | null` plumbing with `Follow`, adds the Survivors chip, and has the canvas report the translate it applied so a drag can take over without a jump.

**Files:**
- Modify: `web/src/replay/ReplayCanvas.tsx`
- Modify: `web/src/replay/ReplayControls.tsx`
- Modify: `web/src/replay/ReplayControls.test.tsx`
- Modify: `web/src/replay/renderRate.test.tsx:148-152`
- Modify: `web/src/replay/Viewer.tsx`

**Interfaces:**
- Consumes: `Follow`, `FREE`, `TEAM`, `followPoint`, `followSlotOf` (Task 6).
- Produces:
  - `ReplayCanvasProps.follow: Follow` replaces `followSlot`; new `ReplayCanvasProps.shiftRef: { current: { x: number; y: number } }`, written on every paint with the follow translate applied (zero when free).
  - `ReplayControlsProps.follow: Follow; setFollow: (f: Follow) => void` replace `followSlot`/`setFollowSlot`. The follow row renders chips `Free`, `Survivors`, then one per slot.

- [ ] **Step 1: Update the controls test to the new props**

In `web/src/replay/ReplayControls.test.tsx`, add `import { FREE, TEAM } from './camera';`, change `mount` to pass `follow={FREE} setFollow={() => {}}` instead of `followSlot={null} setFollowSlot={() => {}}`, change the two tests that passed `followSlot: 0` and `followSlot: 2` to `follow: { kind: 'slot', slot: 0 }` and `follow: { kind: 'slot', slot: 2 }`, and add:

```tsx
describe('ReplayControls follow row', () => {
  it('offers free, the survivor centroid and every slot', () => {
    const setFollow = vi.fn();
    const { getByRole } = mount({ setFollow, follow: TEAM });
    expect(getByRole('button', { name: 'Survivors' }).classList.contains('is-on')).toBe(true);
    fireEvent.click(getByRole('button', { name: 'Free' }));
    expect(setFollow).toHaveBeenCalledWith(FREE);
    fireEvent.click(getByRole('button', { name: /tino/ }));
    expect(setFollow).toHaveBeenCalledWith({ kind: 'slot', slot: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/ReplayControls.test.tsx`
Expected: FAIL (no `Survivors` button; typecheck complaints about `follow`).

- [ ] **Step 3: Change ReplayControls**

Imports: add `import { FREE, TEAM, followSlotOf, type Follow } from './camera';`. Props:

```ts
export interface ReplayControlsProps {
  playback: ReturnType<typeof usePlayback>;
  endMs: number;
  live: boolean;
  follow: Follow;
  setFollow: (f: Follow) => void;
  slots: string[];
  names: Record<string, string>;
  timeline?: TimelineEntry[];
}
```

Destructure `follow, setFollow` instead of `followSlot, setFollowSlot`. Replace the `selected` line from Task 4 with:

```ts
  const followSlot = followSlotOf(follow);
  const selected = followSlot === null ? null : (slots[followSlot] ?? '');
```

Replace the follow row's first chip and the slot chips' handlers:

```tsx
      <div class="replay__toolbar">
        <button
          class={`chip ${follow.kind === 'free' ? 'is-on' : ''}`}
          onClick={() => setFollow(FREE)}
        >Free</button>
        {/* The survivor centroid (spec 7.1). Following the team rather than
            one player is what theater defaults to; here it is one chip. */}
        <button
          class={`chip ${follow.kind === 'team' ? 'is-on' : ''}`}
          onClick={() => setFollow(TEAM)}
        >Survivors</button>
        {slots.map((id, i) => (
          <button
            key={i}
            class={`chip chip--slot ${followSlot === i ? 'is-on' : ''}`}
            style={{ color: slotColor(i) }}
            onClick={() => setFollow({ kind: 'slot', slot: i })}
          >
            <span class="replay__swatch" />
            <span class="replay__slot-name">{names[id] ?? slotLabel(i)}</span>
          </button>
        ))}
      </div>
```

Keep the existing comment block above the slot buttons.

- [ ] **Step 4: Change ReplayCanvas**

Imports: replace `import { drawScene, followTarget, type ShowFlags } from './draw';` with

```ts
import { drawScene, type ShowFlags } from './draw';
import { followPoint, followSlotOf, type Follow } from './camera';
```

Props: replace `followSlot: number | null;` with

```ts
  follow: Follow;
  /** The translate the last paint applied to centre the followed point, in
   *  CSS pixels, or zero when free. A drag that starts while following reads
   *  this to seed the pan so the map does not jump under the cursor. */
  shiftRef: { current: { x: number; y: number } };
```

In `paint`, destructure `follow` instead of `followSlot` and replace the block from `const target = followTarget(players, followSlot);` through `drawScene(...)` with:

```ts
  const pt = followPoint(players, follow);
  ctx.save();
  // Everything below this line is in CSS pixels. One scale here is what
  // lets an avatar radius or a line width in the draw code mean the same
  // thing on a phone at 3x and a desktop at 1x, instead of meaning a
  // backing pixel that the browser then resamples to whatever is left.
  ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
  let shift = { x: 0, y: 0 };
  if (pt) {
    // Keep the followed point centred by moving the world under it.
    // `projectView` is the same helper drawScene uses to turn a world
    // position into a canvas position, through the view's crop and scale;
    // a raw `worldToImage` result is in image space and would centre the
    // camera off by that same scale factor.
    const c = projectView(transform, view, pt.x, pt.y);
    shift = { x: size.cssW / 2 - c.px, y: size.cssH / 2 - c.py };
    ctx.translate(shift.x, shift.y);
  }
  p.shiftRef.current = shift;
  drawScene(ctx, {
    transform, view, backdrop, trail,
    players,
    entities,
    show,
    width: size.cssW,
    height: size.cssH,
    names,
    slots,
    followSlot: followSlotOf(follow),
  });
  ctx.restore();
```

In the repaint effect's dependency list, replace `props.followSlot` with `props.follow`.

- [ ] **Step 5: Update renderRate.test.tsx**

Add `import { FREE } from './camera';` and a module-level `const SHIFT = { current: { x: 0, y: 0 } };`. In `mountViewer`'s `<ReplayCanvas>` replace `followSlot={null}` with `follow={FREE}` and add `shiftRef={SHIFT}`.

- [ ] **Step 6: Change the Viewer**

In `web/src/replay/Viewer.tsx`: add `import { FREE, followSlotOf, type Follow } from './camera';`. Replace `const [followSlot, setFollowSlot] = useState<number | null>(null);` with:

```ts
  const [follow, setFollow] = useState<Follow>(FREE);
  const followSlot = followSlotOf(follow);
  /** Written by the canvas on every paint. See ReplayCanvasProps.shiftRef. */
  const shiftRef = useRef({ x: 0, y: 0 });
```

(add `useRef` to the preact/hooks import). The `selected` line from Task 5 keeps reading `followSlot`. Pass `follow={follow} shiftRef={shiftRef}` to `<ReplayCanvas>` in place of `followSlot={followSlot}`, and `follow={follow} setFollow={setFollow}` to `<ReplayControls>` in place of `followSlot={followSlot} setFollowSlot={setFollowSlot}`.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/replay/ReplayCanvas.tsx web/src/replay/ReplayControls.tsx web/src/replay/ReplayControls.test.tsx web/src/replay/renderRate.test.tsx web/src/replay/Viewer.tsx
git commit -m "feat(replay): follow modes free, survivors and slot through the canvas"
```

---

### Task 8: Camera hook, zoom chips, wheel and drag

Spec 7.1, Camera and "Also in normal mode": wheel zoom about the cursor, drag to pan, zoom chips fit, 2x, 4x, 6x; any drag turns follow off; the follow chip turns it back on and clears the pan. Fit and free stay the defaults in the embedded viewer.

**Files:**
- Create: `web/src/replay/useCamera.ts`
- Create: `web/src/replay/useCamera.test.tsx`
- Modify: `web/src/replay/ReplayControls.tsx` (zoom chips)
- Modify: `web/src/replay/ReplayControls.test.tsx`
- Modify: `web/src/replay/Viewer.tsx`
- Modify: `web/src/styles/app.css` (`.replay__stage`)

**Interfaces:**
- Consumes: everything in `camera.ts`; `View`, `CanvasSize`.
- Produces:

```ts
export interface CameraState { cam: Camera; follow: Follow }
export interface CameraControls {
  cam: Camera;
  /** The fitted view with the camera applied and the pan clamped. */
  view: View;
  follow: Follow;
  setFollow(f: Follow): void;      // clears the pan when f is not free
  setZoom(z: number): void;        // about the canvas centre
  dragging: boolean;
  onWheel(e: WheelEvent): void;
  onPointerDown(e: PointerEvent): void;
  snapshot(): CameraState;
  restore(s: CameraState): void;
}
export function useCamera(fit: View, size: CanvasSize, shiftRef: { current: { x: number; y: number } }): CameraControls
```
  - `ReplayControlsProps` gains `zoom: number; setZoom: (z: number) => void`; chips labelled `Fit`, `2x`, `4x`, `6x`.

- [ ] **Step 1: Write the failing hook tests**

```tsx
// web/src/replay/useCamera.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { useCamera, type CameraControls } from './useCamera';
import { FREE, TEAM, zoomedView } from './camera';
import { fitView } from '../../../src/mapTransform';

afterEach(cleanup);

// Same shape as the canvas: overflows both axes from zoom 2 up, so a pan is
// never clamped to zero in the drag tests below. See camera.test.ts.
const BOX = { x0: 0, y0: 0, x1: 1600, y1: 1000 };
const SIZE = { cssW: 800, cssH: 500, pixelW: 800, pixelH: 500, ratio: 1 };
const FIT = fitView(BOX, SIZE.cssW, SIZE.cssH);

function mount() {
  const shiftRef = { current: { x: 0, y: 0 } };
  let ctl!: CameraControls;
  function Host() {
    ctl = useCamera(FIT, SIZE, shiftRef);
    return <div data-testid="stage" onWheel={ctl.onWheel} onPointerDown={ctl.onPointerDown} />;
  }
  const r = render(<Host />);
  const stage = r.getByTestId('stage') as HTMLElement;
  // happy-dom lays nothing out; the hook measures the stage's rect, so give it one.
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { get ctl() { return ctl; }, stage, shiftRef };
}

function wheel(stage: HTMLElement, deltaY: number, clientX: number, clientY: number) {
  act(() => {
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true, cancelable: true }));
  });
}

function drag(stage: HTMLElement, from: [number, number], to: [number, number]) {
  act(() => {
    stage.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: from[0], clientY: from[1], bubbles: true }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to[0], clientY: to[1], bubbles: true }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: to[0], clientY: to[1], bubbles: true }));
  });
}

describe('useCamera', () => {
  it('starts at fit and free, and its view is the fit', () => {
    const h = mount();
    expect(h.ctl.cam).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(h.ctl.follow).toEqual(FREE);
    expect(h.ctl.view.scale).toBeCloseTo(FIT.scale, 9);
    expect(h.ctl.view.offsetX).toBeCloseTo(FIT.offsetX, 9);
    expect(h.ctl.view.offsetY).toBeCloseTo(FIT.offsetY, 9);
  });

  it('zooms a notch in on wheel up about the cursor, out on wheel down', () => {
    const h = mount();
    wheel(h.stage, -100, 400, 250);
    expect(h.ctl.cam.zoom).toBeCloseTo(1.25, 9);
    wheel(h.stage, 100, 400, 250);
    expect(h.ctl.cam.zoom).toBeCloseTo(1, 9);
  });

  it('sets a chip zoom about the centre and reports the zoomed view', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    expect(h.ctl.cam.zoom).toBe(4);
    expect(h.ctl.view).toEqual(zoomedView(FIT, h.ctl.cam, SIZE.cssW, SIZE.cssH));
  });

  it('pans by the drag distance when zoomed in and free', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    drag(h.stage, [400, 250], [430, 240]);
    expect(h.ctl.cam.panX).toBeCloseTo(30, 9);
    expect(h.ctl.cam.panY).toBeCloseTo(-10, 9);
    expect(h.ctl.dragging).toBe(false);
  });

  it('ignores a movement under the drag threshold, so a click is a click', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    act(() => h.ctl.setFollow(TEAM));
    drag(h.stage, [400, 250], [401, 251]);
    expect(h.ctl.follow).toEqual(TEAM);
    expect(h.ctl.cam.panX).toBe(0);
  });

  it('a drag turns follow off and seeds the pan from the follow shift so nothing jumps', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    act(() => h.ctl.setFollow(TEAM));
    // What the canvas last translated by to keep the centroid centred.
    h.shiftRef.current = { x: -120, y: 45 };
    drag(h.stage, [400, 250], [410, 250]);
    expect(h.ctl.follow).toEqual(FREE);
    expect(h.ctl.cam.panX).toBeCloseTo(-110, 9);
    expect(h.ctl.cam.panY).toBeCloseTo(45, 9);
  });

  it('following again clears the pan', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    drag(h.stage, [400, 250], [450, 250]);
    expect(h.ctl.cam.panX).not.toBe(0);
    act(() => h.ctl.setFollow({ kind: 'slot', slot: 2 }));
    expect(h.ctl.cam.panX).toBe(0);
    expect(h.ctl.cam.panY).toBe(0);
    expect(h.ctl.cam.zoom).toBe(4);
  });

  it('snapshots and restores', () => {
    const h = mount();
    act(() => h.ctl.setZoom(2));
    const s = h.ctl.snapshot();
    act(() => { h.ctl.setZoom(6); h.ctl.setFollow(TEAM); });
    act(() => h.ctl.restore(s));
    expect(h.ctl.cam.zoom).toBe(2);
    expect(h.ctl.follow).toEqual(FREE);
  });

  it('does not start a drag from a button inside the stage', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    const btn = document.createElement('button');
    h.stage.appendChild(btn);
    act(() => {
      btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 400, clientY: 250, bubbles: true }));
    });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 450, clientY: 250 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { clientX: 450, clientY: 250 })); });
    expect(h.ctl.cam.panX).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/useCamera.test.tsx`
Expected: FAIL, cannot resolve `./useCamera`.

- [ ] **Step 3: Write the hook**

```ts
// web/src/replay/useCamera.ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { View } from '../../../src/mapTransform';
import type { CanvasSize } from './canvasSize';
import {
  FIT_CAMERA, FREE, WHEEL_STEP, clampPan, clampZoom, zoomAbout, zoomedView,
  type Camera, type Follow,
} from './camera';

/** Pointer travel before a press becomes a drag. Under this a press is a
 *  click on whatever is under it and follow is left alone. */
export const DRAG_THRESHOLD_PX = 3;

export interface CameraState { cam: Camera; follow: Follow }

export interface CameraControls {
  cam: Camera;
  /** The fitted view with the camera applied and the pan clamped. Hand this
   *  to the canvas in place of the fit. */
  view: View;
  follow: Follow;
  /** Following anything clears the pan: the follow translate is the shift
   *  then, and a leftover pan would add to it. */
  setFollow(f: Follow): void;
  /** A chip. Zooms about the canvas centre, which is also the followed point
   *  while following. */
  setZoom(z: number): void;
  dragging: boolean;
  onWheel(e: WheelEvent): void;
  onPointerDown(e: PointerEvent): void;
  snapshot(): CameraState;
  restore(s: CameraState): void;
}

interface Drag {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  moved: boolean;
}

/**
 * Camera and follow state for one viewer, with the wheel and drag behaviour
 * of spec 7.1.
 *
 * Pan is stored raw and clamped when the view is derived, so a resize that
 * makes a stored pan too large is corrected on the next render rather than
 * left showing void. Drag listens on the window once a press starts, rather
 * than capturing the pointer on the stage: pointer capture would redirect
 * the click that ends a press on a chip inside the stage.
 */
export function useCamera(
  fit: View, size: CanvasSize, shiftRef: { current: { x: number; y: number } },
): CameraControls {
  const [cam, setCam] = useState<Camera>(FIT_CAMERA);
  const [follow, setFollowState] = useState<Follow>(FREE);
  const [dragging, setDragging] = useState(false);
  const { cssW, cssH } = size;

  const view = useMemo(
    () => zoomedView(fit, clampPan(fit, cam, cssW, cssH), cssW, cssH),
    [fit, cam, cssW, cssH],
  );

  // Handlers read the newest values through refs so the window listeners a
  // drag installs never close over a stale render.
  const latest = useRef({ fit, cam, follow, cssW, cssH });
  latest.current = { fit, cam, follow, cssW, cssH };
  const drag = useRef<Drag | null>(null);

  const setFollow = useCallback((f: Follow) => {
    setFollowState(f);
    if (f.kind !== 'free') setCam((c) => ({ zoom: c.zoom, panX: 0, panY: 0 }));
  }, []);

  const zoomAt = useCallback((zoom: number, px: number, py: number) => {
    const l = latest.current;
    setCam((c) => (
      l.follow.kind === 'free'
        ? zoomAbout(l.fit, c, zoom, px, py, l.cssW, l.cssH)
        : { zoom: clampZoom(zoom), panX: 0, panY: 0 }
    ));
  }, []);

  const setZoom = useCallback((z: number) => {
    const l = latest.current;
    zoomAt(z, l.cssW / 2, l.cssH / 2);
  }, [zoomAt]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    zoomAt(latest.current.cam.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0) return;
    // A press on a chip inside the stage is a click, never a drag.
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    const l = latest.current;
    drag.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: l.cam.panX, baseY: l.cam.panY, moved: false,
    };
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        d.moved = true;
        setDragging(true);
        if (latest.current.follow.kind !== 'free') {
          // Take over from the follow camera where it is: while following the
          // pan is zero and the canvas translate is the whole shift, so that
          // shift IS the equivalent free pan (spec 7.1: any drag turns follow
          // off).
          d.baseX = shiftRef.current.x;
          d.baseY = shiftRef.current.y;
          setFollowState(FREE);
        }
      }
      setCam((c) => ({ zoom: c.zoom, panX: d.baseX + dx, panY: d.baseY + dy }));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [shiftRef]);

  const snapshot = useCallback((): CameraState => {
    const l = latest.current;
    return { cam: l.cam, follow: l.follow };
  }, []);
  const restore = useCallback((s: CameraState) => {
    setCam(s.cam);
    setFollowState(s.follow);
  }, []);

  return { cam, view, follow, setFollow, setZoom, dragging, onWheel, onPointerDown, snapshot, restore };
}
```

- [ ] **Step 4: Run the hook tests**

Run: `npx vitest run web/src/replay/useCamera.test.tsx`
Expected: PASS, 9 tests. If happy-dom lacks `PointerEvent`, add at the top of the test file:

```ts
if (typeof PointerEvent === 'undefined') {
  // happy-dom builds without PointerEvent: MouseEvent carries every field the hook reads.
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
}
```

- [ ] **Step 5: Zoom chips in ReplayControls**

Add `zoom: number; setZoom: (z: number) => void;` to `ReplayControlsProps`, destructure them, import `ZOOM_LEVELS` from `./camera`, and add after the speed chips inside `.replay__controls`:

```tsx
        <span class="replay__sep" aria-hidden="true" />
        {/* Spec 7.1: fit, 2x, 4x, 6x. Wheel zoom lands between chips, and
            then none is lit, which is honest. */}
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z}
            class={`chip ${Math.abs(zoom - z) < 0.01 ? 'is-on' : ''}`}
            onClick={() => setZoom(z)}
            aria-label={z === 1 ? 'Zoom to fit' : `Zoom ${z}x`}
          >{z === 1 ? 'Fit' : `${z}x`}</button>
        ))}
```

Add to the controls test's `mount` defaults: `zoom={1} setZoom={() => {}}`, and a test:

```tsx
describe('ReplayControls zoom chips', () => {
  it('lights the current level and sets a chosen one', () => {
    const setZoom = vi.fn();
    const { getByRole } = mount({ zoom: 4, setZoom });
    expect(getByRole('button', { name: 'Zoom 4x' }).classList.contains('is-on')).toBe(true);
    fireEvent.click(getByRole('button', { name: 'Zoom to fit' }));
    expect(setZoom).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 6: Wire the viewer**

In `web/src/replay/Viewer.tsx`:

- Replace the Task 7 lines `const [follow, setFollow] = useState<Follow>(FREE);` and `const followSlot = followSlotOf(follow);` with nothing yet; they move below the map layer because the hook needs the fitted view. Keep `const shiftRef = useRef({ x: 0, y: 0 });`.
- After `const { transform, view, backdrop } = useMapLayer(header, frames, livePlayers, size);` add:

```ts
  // The fit from useMapLayer is the camera's base; the canvas draws the
  // camera's view. Follow lives here too because following clears the pan.
  const camera = useCamera(view, size, shiftRef);
  const { follow, setFollow } = camera;
  const followSlot = followSlotOf(follow);
```

- Move the `selected` line (Task 5) below this block, since it reads `followSlot`.
- Change the import to `import { followSlotOf } from './camera';` and add `import { useCamera } from './useCamera';`.
- On the `.replay__stage` div add: `onWheel={camera.onWheel} onPointerDown={camera.onPointerDown}` and `class={`replay__stage${camera.dragging ? ' is-dragging' : ''}`}`.
- `<ReplayCanvas view={camera.view} ... />` instead of `view={view}`.
- `<ReplayControls ... zoom={camera.cam.zoom} setZoom={camera.setZoom} />`.

- [ ] **Step 7: Stage cursor and touch**

In `web/src/styles/app.css`, replace `.replay__stage { position: relative; width: 100%; }` with:

```css
.replay__stage { position: relative; width: 100%; touch-action: none; cursor: grab; }
.replay__stage.is-dragging { cursor: grabbing; }
.replay__sep { width: 1px; height: 20px; background: var(--border); margin: 0 var(--sp-1); }
```

- [ ] **Step 8: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 9: Browser check**

Start the dev server (`preview_start` with name `pug-dev`, or `npm run dev` in a terminal) and open `http://localhost:5173/match/9001`. Wheel over a map: it zooms about the cursor and the map never shows void past its edge. Drag: it pans; the cursor is a grabbing hand. Click Survivors, then drag: the Free chip lights and the map does not jump. Click 4x while following: the followed point stays centred. Nothing else on the page scrolls when wheeling over the stage.

- [ ] **Step 10: Commit**

```bash
git add web/src/replay/useCamera.ts web/src/replay/useCamera.test.tsx web/src/replay/ReplayControls.tsx web/src/replay/ReplayControls.test.tsx web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): wheel zoom, drag pan and zoom chips on the stage"
```

---

### Task 9: Canvas fills the viewport in theater

Spec 7.1, Entry and exit: "the viewer fill the viewport". The stage's shape is the map's in normal mode and the viewport's in theater, and the pixel budget has to grow with it or a 1080p theater canvas would be drawn at 0.7 backing pixels per CSS pixel.

**Files:**
- Modify: `web/src/replay/canvasSize.ts`
- Modify: `web/src/replay/canvasSize.test.ts`
- Modify: `web/src/replay/useCanvasSize.test.tsx`

**Interfaces:**
- Produces:
  - `THEATER_PIXEL_BUDGET = 2560 * 1440`
  - `resolveSize(width: number, height: number, aspect: number, dpr: number, fill: boolean): CanvasSize`
  - `useCanvasSize(aspect: number, fill = false)`: with `fill`, the element's own width and height set the shape and the theater budget applies.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/replay/canvasSize.test.ts`:

```ts
import { resolveSize, THEATER_PIXEL_BUDGET } from './canvasSize';

describe('resolveSize', () => {
  it('uses the map aspect and the page budget when not filling', () => {
    const s = resolveSize(1000, 3000, 1.6, 1, false);
    expect(s.cssW).toBe(1000);
    expect(s.cssH).toBeCloseTo(625, 6);
  });

  it('takes the element shape and the theater budget when filling', () => {
    const s = resolveSize(1920, 1080, 1.6, 2, true);
    expect(s.cssW).toBe(1920);
    expect(s.cssH).toBe(1080);
    // 1920x1080 at 2x is 8.3M backing pixels, over the 3.7M theater budget:
    // capped, but well above the 0.7 the page budget would have left.
    expect(s.pixelW * s.pixelH).toBeLessThanOrEqual(THEATER_PIXEL_BUDGET * 1.01);
    expect(s.ratio).toBeGreaterThan(1.3);
  });

  it('falls back to the map aspect while filling with no height yet', () => {
    const s = resolveSize(1920, 0, 1.6, 1, true);
    expect(s.cssH).toBeCloseTo(1200, 6);
  });
});
```

(Move the two imports to the top of the file with the existing ones.) Append to `web/src/replay/useCanvasSize.test.tsx` a probe that fills:

```tsx
function FillProbe({ sizes }: { sizes: CanvasSize[] }) {
  const { size, ref } = useCanvasSize(ASPECT, true);
  sizes.push(size);
  const attach = (el: HTMLElement | null) => {
    if (el) {
      Object.defineProperty(el, 'clientWidth', { value: 1600, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 900, configurable: true });
    }
    ref(el);
  };
  return <div ref={attach} />;
}

describe('useCanvasSize in fill mode', () => {
  it('takes the element shape rather than the map shape', async () => {
    const sizes: CanvasSize[] = [];
    render(<FillProbe sizes={sizes} />);
    await waitFor(() => {
      expect(sizes[sizes.length - 1].cssW).toBe(1600);
    });
    expect(sizes[sizes.length - 1].cssH).toBe(900);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/canvasSize.test.ts web/src/replay/useCanvasSize.test.tsx`
Expected: FAIL, `resolveSize` not exported; fill probe height is 1600 / ASPECT.

- [ ] **Step 3: Implement**

In `web/src/replay/canvasSize.ts`, after `canvasSize`, add:

```ts
/** Backing-store pixels a theater canvas may spend. The page budget is a
 *  1280x794 canvas; a viewport-filling canvas at that budget would be drawn
 *  at about 0.7 backing pixels per CSS pixel on a 1080p screen and look soft
 *  exactly when the map is largest. 1440p is the biggest common desktop. */
export const THEATER_PIXEL_BUDGET = 2560 * 1440;

/**
 * The canvas size for what was measured.
 *
 * Not filling: the width and the map's aspect, as ever. Filling (theater):
 * the element's own width and height set the shape, because the stage is
 * the viewport there and the fit letterboxes the map inside it. A fill with
 * no height measured yet falls back to the map shape rather than dividing
 * by zero.
 */
export function resolveSize(
  width: number, height: number, aspect: number, dpr: number, fill: boolean,
): CanvasSize {
  const w = width > 0 ? width : canvasForAspect(aspect).width;
  if (fill && width > 0 && height > 0) {
    return canvasSize(w, width / height, dpr, THEATER_PIXEL_BUDGET);
  }
  return canvasSize(w, aspect, dpr);
}
```

Change `useCanvasSize`:

```ts
export function useCanvasSize(
  aspect: number, fill = false,
): { size: CanvasSize; ref: (el: HTMLElement | null) => void } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // A zero width is a hidden element or an environment with no layout at
      // all, not a real measurement. Keeping the last good one leaves the
      // budget-sized fallback below in place rather than collapsing to 1px.
      if (w > 0) setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return {
    size: resolveSize(box.w, box.h, aspect, pixelRatio(), fill),
    // `setEl` is stable across renders, so preact does not detach and
    // reattach the observer on every frame of playback.
    ref: setEl,
  };
}
```

Delete the old `const fallback = ...` lines and the old `width` state. Keep the doc comment above the hook.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/canvasSize.ts web/src/replay/canvasSize.test.ts web/src/replay/useCanvasSize.test.tsx
git commit -m "feat(replay): canvas can take the element shape and a theater pixel budget"
```

---

### Task 10: Theater and idle hooks

Spec 7.1, Entry and exit, and Hidden chrome. Two small hooks with no layout in them.

**Files:**
- Create: `web/src/replay/useTheater.ts`
- Create: `web/src/replay/useTheater.test.tsx`
- Create: `web/src/replay/useIdle.ts`
- Create: `web/src/replay/useIdle.test.tsx`

**Interfaces:**
- Produces:
  - `useTheater(rootRef: { current: HTMLElement | null }): { theater: boolean; enter(): void; exit(): void; toggle(): void }`. While on: Escape exits, leaving browser fullscreen exits, `document.body` carries `is-theater`. Entering requests fullscreen on the root when the API exists; exiting leaves fullscreen when in it.
  - `IDLE_MS = 2000`; `useIdle(active: boolean, ms = IDLE_MS): { idle: boolean; wake(): void }`. `idle` becomes true `ms` after the last `wake` while active, is always false while inactive.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/replay/useTheater.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { useTheater } from './useTheater';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.classList.remove('is-theater'); });

function mount() {
  let api!: ReturnType<typeof useTheater>;
  function Host() {
    const ref = useRef<HTMLDivElement>(null);
    api = useTheater(ref);
    return <div ref={ref} data-testid="root" />;
  }
  const r = render(<Host />);
  return { get api() { return api; }, root: r.getByTestId('root') as HTMLElement };
}

describe('useTheater', () => {
  it('starts off, toggles on and marks the body', () => {
    const h = mount();
    expect(h.api.theater).toBe(false);
    act(() => h.api.toggle());
    expect(h.api.theater).toBe(true);
    expect(document.body.classList.contains('is-theater')).toBe(true);
    act(() => h.api.toggle());
    expect(h.api.theater).toBe(false);
    expect(document.body.classList.contains('is-theater')).toBe(false);
  });

  it('Escape leaves theater', () => {
    const h = mount();
    act(() => h.api.enter());
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(h.api.theater).toBe(false);
  });

  it('requests fullscreen on the root when the browser offers it, and survives its refusal', () => {
    const h = mount();
    const req = vi.fn(() => Promise.reject(new Error('denied')));
    (h.root as HTMLElement & { requestFullscreen: () => Promise<void> }).requestFullscreen = req;
    act(() => h.api.enter());
    expect(req).toHaveBeenCalledTimes(1);
    expect(h.api.theater).toBe(true);
  });

  it('leaving browser fullscreen leaves theater', () => {
    const h = mount();
    act(() => h.api.enter());
    // fullscreenElement is null in happy-dom, which is what "left" looks like.
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(h.api.theater).toBe(false);
  });
});
```

```tsx
// web/src/replay/useIdle.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { useIdle, IDLE_MS } from './useIdle';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function mount(active: boolean) {
  let api!: ReturnType<typeof useIdle>;
  function Host({ on }: { on: boolean }) {
    api = useIdle(on);
    return null;
  }
  const r = render(<Host on={active} />);
  return { get api() { return api; }, set(on: boolean) { r.rerender(<Host on={on} />); } };
}

describe('useIdle', () => {
  it('goes idle after the delay and wakes on demand', () => {
    vi.useFakeTimers();
    const h = mount(true);
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(h.api.idle).toBe(true);
    act(() => h.api.wake());
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS - 1); });
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.api.idle).toBe(true);
  });

  it('never goes idle while inactive, and resets when deactivated', () => {
    vi.useFakeTimers();
    const h = mount(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(h.api.idle).toBe(false);
    h.set(true);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(h.api.idle).toBe(true);
    h.set(false);
    expect(h.api.idle).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/useTheater.test.tsx web/src/replay/useIdle.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the hooks**

```ts
// web/src/replay/useTheater.ts
import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * Theater is a layout state of the viewer, never a route (spec 7.1).
 *
 * Fullscreen is asked for but not relied on: a browser that refuses (or
 * has no API) still gets the fixed-position layout, and the two ways out,
 * Escape and leaving browser fullscreen, both land here. In real fullscreen
 * the browser eats the Escape and fires fullscreenchange instead, so both
 * listeners are needed. The body class lets the stylesheet stop the page
 * behind from scrolling without touching scroll position, which is what
 * "returns to the page with scroll position preserved" needs.
 */
export function useTheater(
  rootRef: { current: HTMLElement | null },
): { theater: boolean; enter(): void; exit(): void; toggle(): void } {
  const [theater, setTheater] = useState(false);

  const enter = useCallback(() => {
    setTheater(true);
    const el = rootRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      // Older engines return undefined rather than a promise; a refusal
      // (the user denied it, or an iframe forbids it) leaves the fixed
      // layout, which is enough.
      const p = el.requestFullscreen() as Promise<void> | undefined;
      p?.catch?.(() => {});
    }
  }, [rootRef]);

  const exit = useCallback(() => {
    setTheater(false);
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      const p = document.exitFullscreen() as Promise<void> | undefined;
      p?.catch?.(() => {});
    }
  }, []);

  const toggle = useCallback(() => {
    if (theater) exit(); else enter();
  }, [theater, enter, exit]);

  useEffect(() => {
    if (!theater) return;
    document.body.classList.add('is-theater');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exit(); };
    const onFs = () => { if (!document.fullscreenElement) setTheater(false); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.body.classList.remove('is-theater');
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [theater, exit]);

  return { theater, enter, exit, toggle };
}
```

```ts
// web/src/replay/useIdle.ts
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** How long without pointer movement before the theater chrome fades (spec 7.1). */
export const IDLE_MS = 2000;

/**
 * `idle` turns true `ms` after the last `wake` while `active`; it is never
 * true while inactive. The viewer calls `wake` from pointer movement and
 * focus so the toolbar comes back the moment someone reaches for it.
 */
export function useIdle(active: boolean, ms = IDLE_MS): { idle: boolean; wake(): void } {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const arm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (activeRef.current) setIdle(true); }, ms);
  }, [ms]);

  const wake = useCallback(() => {
    setIdle(false);
    if (activeRef.current) arm();
  }, [arm]);

  useEffect(() => {
    if (!active) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setIdle(false);
      return;
    }
    arm();
    return () => { if (timer.current !== null) clearTimeout(timer.current); };
  }, [active, arm]);

  return { idle, wake };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run web/src/replay/useTheater.test.tsx web/src/replay/useIdle.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/useTheater.ts web/src/replay/useTheater.test.tsx web/src/replay/useIdle.ts web/src/replay/useIdle.test.tsx
git commit -m "feat(replay): theater and idle hooks"
```

---

### Task 11: Theater pieces: toggle chips, status line, edge HUD

Spec 7.1, Edge HUD and Status line; the Theater chip from Entry and exit. Components only; the viewer assembles them in Task 12.

**Files:**
- Modify: `web/src/replay/ReplayHud.tsx`
- Modify: `web/src/replay/ReplayHud.test.tsx`
- Create: `web/src/replay/TheaterStatus.tsx`
- Create: `web/src/replay/TheaterStatus.test.tsx`
- Modify: `web/src/replay/HudStrip.tsx`
- Create: `web/src/replay/HudStrip.test.tsx`

**Interfaces:**
- Produces:
  - `ToggleChips({ toggles, toggle, theater }: { toggles: Toggles; toggle: (k: keyof Toggles) => void; theater?: { on: boolean; toggle(): void } })` exported from `ReplayHud.tsx`; renders the seven toggle chips and, when `theater` is given, a `Theater` chip lit while on. `ReplayHud` gains the same optional `theater` prop and passes it through.
  - `TheaterStatus({ tMs, endMs, counts, zoom, live, closed })`; `zoomLabel(zoom: number): string` ("fit", "2x", "2.4x").
  - `HudStrip` gains `layout?: 'strip' | 'edges'` (default `'strip'`). Edges renders `div.hud-edge.hud-edge--l` with the survivor panels and `div.hud-edge.hud-edge--r` with the infected panels, no row labels, panels in slot order.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/replay/ReplayHud.test.tsx`:

```tsx
  it('offers a theater chip when given one, lit while on', () => {
    const t = vi.fn();
    render(
      <ReplayHud tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        live={false} closed toggles={DEFAULT_TOGGLES} toggle={() => {}}
        theater={{ on: true, toggle: t }} />,
    );
    const chip = screen.getByRole('button', { name: 'Theater' });
    expect(chip.classList.contains('is-on')).toBe(true);
    fireEvent.click(chip);
    expect(t).toHaveBeenCalledTimes(1);
  });
```

```tsx
// web/src/replay/TheaterStatus.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { TheaterStatus, zoomLabel } from './TheaterStatus';

afterEach(cleanup);

describe('TheaterStatus', () => {
  it('reads time of end, the counts and the zoom', () => {
    render(
      <TheaterStatus tMs={65000} endMs={200000} counts={{ survivors: 3, commons: 12, specials: 2 }}
        zoom={2} live={false} closed />,
    );
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.getByText('of 3:20')).toBeTruthy();
    expect(screen.getByText('3 alive')).toBeTruthy();
    expect(screen.getByText('12 common')).toBeTruthy();
    expect(screen.getByText('2 specials')).toBeTruthy();
    expect(screen.getByText('2x')).toBeTruthy();
  });

  it('flags a live round', () => {
    render(
      <TheaterStatus tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        zoom={1} live closed={false} />,
    );
    expect(screen.getByText(/live, 10s delayed/i)).toBeTruthy();
  });
});

describe('zoomLabel', () => {
  it('says fit at 1 and one decimal otherwise, trimmed', () => {
    expect(zoomLabel(1)).toBe('fit');
    expect(zoomLabel(2)).toBe('2x');
    expect(zoomLabel(2.4414)).toBe('2.4x');
  });
});
```

```tsx
// web/src/replay/HudStrip.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { HudStrip } from './HudStrip';
import { STATE, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';

afterEach(cleanup);

const HEADER: ReplayHeader = {
  version: 2, token: '', ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'l4d_hospital01_apartment',
  startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
  slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
};
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };

function players(): PlayerSample[] {
  return Array.from({ length: 8 }, (_, slot) => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
  }));
}

describe('HudStrip', () => {
  it('renders two labelled rows by default', () => {
    const { container } = render(
      <HudStrip players={players()} header={HEADER} names={NAMES} showHp showGuns={false} />,
    );
    expect(container.querySelectorAll('.hud-row')).toHaveLength(2);
    expect(container.querySelectorAll('.hudp')).toHaveLength(8);
  });

  it('renders survivors down the left edge and infected down the right in slot order', () => {
    const { container } = render(
      <HudStrip players={players()} header={HEADER} names={NAMES} showHp showGuns={false} layout="edges" />,
    );
    const left = [...container.querySelectorAll('.hud-edge--l .hudp__name')].map((n) => n.textContent);
    const right = [...container.querySelectorAll('.hud-edge--r .hudp__name')].map((n) => n.textContent);
    expect(left).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(right).toEqual(['smk', 'boom', 'hunt', 'tank']);
    expect(container.querySelector('.hud-row__label')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/ReplayHud.test.tsx web/src/replay/TheaterStatus.test.tsx web/src/replay/HudStrip.test.tsx`
Expected: FAIL on all three.

- [ ] **Step 3: Extract ToggleChips and add the Theater chip**

Replace `web/src/replay/ReplayHud.tsx` in full:

```tsx
import { formatTime } from './ReplayControls';
import type { Toggles } from './useToggles';

const TOGGLE_LABELS: [keyof Toggles, string][] = [
  ['hp', 'HP'], ['names', 'Names'], ['guns', 'Guns'], ['events', 'Events'],
  ['chat', 'Chat'], ['ci', 'CI'], ['entities', 'Ents'],
];

export interface TheaterChip { on: boolean; toggle(): void }

/** The toggle chips, plus the Theater chip when the viewer offers one. In
 *  normal mode they sit top right inside the stage; in theater they move to
 *  the top bar, which is why they are their own component. */
export function ToggleChips(
  { toggles, toggle, theater }:
  { toggles: Toggles; toggle: (k: keyof Toggles) => void; theater?: TheaterChip },
) {
  return (
    <>
      {TOGGLE_LABELS.map(([k, label]) => (
        <button key={k} type="button" class={`chip${toggles[k] ? ' is-on' : ''}`} onClick={() => toggle(k)}>
          {label}
        </button>
      ))}
      {theater && (
        <button type="button" class={`chip${theater.on ? ' is-on' : ''}`} onClick={theater.toggle}>
          Theater
        </button>
      )}
    </>
  );
}

/**
 * The overlay drawn over the stage: the clock and the alive counts top left,
 * the toggle chips top right, the live flag beneath the clock. What used to
 * be a status line under the canvas and a toggle row above the follow row.
 * Purely presentational, like ReplayControls.
 */
export function ReplayHud(
  { tMs, endMs, counts, live, closed, toggles, toggle, theater }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    live: boolean;
    closed: boolean;
    toggles: Toggles;
    toggle: (k: keyof Toggles) => void;
    theater?: TheaterChip;
  },
) {
  return (
    <div class="rhud">
      <div class="rhud__left">
        <span class="rhud__time num">{formatTime(tMs)}</span>
        <span class="rhud__of eyebrow">of {formatTime(endMs)}</span>
        <span class="rhud__counts eyebrow">
          {counts.survivors} alive · {counts.commons} common · {counts.specials} special
        </span>
        {live && !closed && <span class="rhud__live eyebrow">Live, 10s delayed</span>}
      </div>
      <div class="rhud__right">
        <ToggleChips toggles={toggles} toggle={toggle} theater={theater} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write TheaterStatus**

```tsx
// web/src/replay/TheaterStatus.tsx
import { formatTime } from './ReplayControls';

/** "fit" at 1, otherwise one decimal with a trailing .0 dropped: 2x, 2.4x. */
export function zoomLabel(zoom: number): string {
  if (Math.abs(zoom - 1) < 0.01) return 'fit';
  return `${Number(zoom.toFixed(1))}x`;
}

/**
 * The line across the bottom of the theater (spec 7.1, Status line): time
 * of end, alive, common, specials, zoom. Replaces the top-left readout of
 * ReplayHud while in theater. Purely presentational.
 */
export function TheaterStatus(
  { tMs, endMs, counts, zoom, live, closed }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    zoom: number;
    live: boolean;
    closed: boolean;
  },
) {
  return (
    <div class="tstat">
      <span class="tstat__time num">{formatTime(tMs)}</span>
      <span class="tstat__item">of {formatTime(endMs)}</span>
      <span class="tstat__item tstat__item--win">{counts.survivors} alive</span>
      <span class="tstat__item">{counts.commons} common</span>
      <span class="tstat__item">{counts.specials} specials</span>
      <span class="tstat__item">{zoomLabel(zoom)}</span>
      {live && !closed && <span class="tstat__item tstat__item--live">Live, 10s delayed</span>}
    </div>
  );
}
```

- [ ] **Step 5: Add the edges layout to HudStrip**

Replace the `HudStrip` function in `web/src/replay/HudStrip.tsx` (leave `Panel` and `maxHealthFor` alone):

```tsx
export function HudStrip(
  { players, header, names, showHp, showGuns, layout = 'strip' }: {
    players: PlayerSample[]; header: ReplayHeader; names: Record<string, string>;
    showHp: boolean; showGuns: boolean;
    /** `strip`: two labelled rows under the stage. `edges`: survivors down
     *  the left, infected down the right, as plates over the map (theater,
     *  spec 7.1). Same panels either way. */
    layout?: 'strip' | 'edges';
  },
) {
  const survivors = players.filter(isSurvivor);
  const infected = players.filter((p) => !isSurvivor(p));

  const panels = (group: PlayerSample[]) => group.map((p) => (
    <Panel
      key={p.slot}
      p={p}
      header={header}
      // The header's slot roster is SteamID64 per slot. The name lookup
      // comes from the match page when there is one; a standalone session
      // has no roster to look names up in, so the id is the name.
      // Finding 12's rule, here too: a standalone session has no roster,
      // and the seventeen-digit id is a worse answer than the slot's own
      // short label.
      name={names[header.slots[p.slot]] || slotLabel(p.slot)}
      showHp={showHp}
      showGuns={showGuns}
    />
  ));

  if (layout === 'edges') {
    return (
      <>
        <div class="hud-edge hud-edge--l">{panels(survivors)}</div>
        <div class="hud-edge hud-edge--r">{panels(infected)}</div>
      </>
    );
  }

  const row = (group: PlayerSample[], label: string) => (
    <div class="hud-row">
      <span class="hud-row__label">{label}</span>
      {panels(group)}
    </div>
  );

  return (
    <div class="hud-strip">
      {row(survivors, 'Survivors')}
      {row(infected, 'Infected')}
    </div>
  );
}
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/replay/ReplayHud.tsx web/src/replay/ReplayHud.test.tsx web/src/replay/TheaterStatus.tsx web/src/replay/TheaterStatus.test.tsx web/src/replay/HudStrip.tsx web/src/replay/HudStrip.test.tsx
git commit -m "feat(replay): toggle chips, theater status line and edge hud layout"
```

---

### Task 12: Theater layout in the viewer

Spec 7.1 in full: entry and exit, camera defaults in theater, edge HUD, status line, hidden chrome, the rail column pushing the infected cards inward.

**Files:**
- Modify: `web/src/replay/Viewer.tsx`
- Create: `web/src/replay/Viewer.test.tsx`
- Modify: `web/src/styles/app.css` (replay viewer section)

**Interfaces:**
- Consumes: `useTheater`, `useIdle` (Task 10); `ToggleChips`, `TheaterStatus`, `HudStrip layout` (Task 11); `useCamera` (Task 8); `useCanvasSize(aspect, fill)` (Task 9).
- Produces: `Viewer` root carries `replay--theater` while in theater and `is-idle` when the chrome has faded; theater DOM is `.theater__top` (controls, toggles), `.hud-edge--l`, `.hud-edge--r`, optional `.theater__rail`, `.tstat`. Root style sets `--rail-w` to `320px` or `0px` in theater.

- [ ] **Step 1: Write the failing render test**

```tsx
// web/src/replay/Viewer.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { Viewer } from './Viewer';
import { STATE, type Frame, type ReplayHeader } from '../../../src/replayFormat';

const HEADER: ReplayHeader = {
  version: 2, token: '', ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'not_a_real_map',
  startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
  slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
};
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };

function frames(): Frame[] {
  return [0, 100, 200].map((tMs) => ({
    tMs, offset: 0,
    players: Array.from({ length: 8 }, (_, slot) => ({
      slot, x: slot * 10, y: 0, z: 0, yaw: 0, pitch: 0,
      state: STATE.PRESENT | STATE.ALIVE,
      health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  }));
}

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    useReplaySource: () => ({ header: HEADER, frames: frames(), closed: true, tooNew: false, error: null }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('is-theater');
  // useToggles persists to localStorage; the second test turns two toggles off.
  localStorage.clear();
});

function mount() {
  // happy-dom has no 2D context. paint() returns early on a null context,
  // which is all this test needs of the canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never);
  return render(
    <Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES}
      timeline={[{ seq: 1, tMs: 100, kind: 'event', event: 'boom', actor: 'F', target: 'A', value: 0 }]} />,
  );
}

describe('Viewer theater', () => {
  it('enters theater from the chip, lays the roster down the edges in order, and leaves on Escape', () => {
    const { container } = mount();
    expect(container.querySelector('.replay--theater')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    expect(container.querySelector('.replay--theater')).not.toBeNull();
    expect(container.querySelector('.hud-strip')).toBeNull();
    expect(container.querySelector('.tstat')).not.toBeNull();

    const left = [...container.querySelectorAll('.hud-edge--l .hudp__name')].map((n) => n.textContent);
    const right = [...container.querySelectorAll('.hud-edge--r .hudp__name')].map((n) => n.textContent);
    expect(left).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(right).toEqual(['smk', 'boom', 'hunt', 'tank']);

    // Spec 7.1: follow is on by default in theater, on the survivor centroid.
    expect(screen.getByRole('button', { name: 'Survivors' }).classList.contains('is-on')).toBe(true);

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.querySelector('.replay--theater')).toBeNull();
    expect(container.querySelector('.hud-strip')).not.toBeNull();
    // And the camera is back where it was: free at fit.
    expect(screen.getByRole('button', { name: 'Free' }).classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).classList.contains('is-on')).toBe(true);
  });

  it('gives the rail its column and pushes the infected cards inward', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const root = container.querySelector('.replay--theater') as HTMLElement;
    // Events and chat are on by default, so the rail is shown.
    expect(container.querySelector('.theater__rail')).not.toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('320px');
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(container.querySelector('.theater__rail')).toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('0px');
  });
});
```

If happy-dom does not surface a custom property through `style.getPropertyValue`, assert on the attribute instead: `expect(root.getAttribute('style')).toContain('--rail-w: 320px')`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/replay/Viewer.test.tsx`
Expected: FAIL, no `Theater` button.

- [ ] **Step 3: Rewrite Viewer.tsx**

Replace `web/src/replay/Viewer.tsx` in full. Everything above the `return` that existed before is kept; the additions are marked in comments.

```tsx
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { canvasForAspect } from '../../../src/mapTransform';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { isSurvivor, sceneCounts, type ShowFlags } from './draw';
import { useToggles } from './useToggles';
import { mapAspect, useMapLayer } from './useMapLayer';
import { useCanvasSize } from './canvasSize';
import { ReplayCanvas } from './ReplayCanvas';
import { ReplayControls } from './ReplayControls';
import { ReplayHud, ToggleChips } from './ReplayHud';
import { HudStrip } from './HudStrip';
import { TimelineRail } from './TimelineRail';
import { TheaterStatus } from './TheaterStatus';
import { FREE, TEAM, followSlotOf } from './camera';
import { useCamera, type CameraState } from './useCamera';
import { useTheater } from './useTheater';
import { useIdle } from './useIdle';
import type { TimelineEntry } from './timeline';

/**
 * How much of the viewport height the map may take.
 *
 * The canvas now follows the map's shape, and a portrait map at the pixel
 * budget is over 1300px tall, which would push the scrub bar and the health
 * panels off the bottom of every screen. Capping the WIDTH by the height the
 * viewport can spare keeps the aspect exact, where a `max-height` would clamp
 * one axis only and stretch the bitmap.
 */
const STAGE_MAX_VH = 78;

/** The camera theater opens with when the viewer was sitting at fit and
 *  free (spec 7.1: a close camera, follow on by default). A camera the
 *  viewer had already set up is kept as it is. */
const THEATER_CAMERA: CameraState = { cam: { zoom: 2, panX: 0, panY: 0 }, follow: TEAM };

/** The events-and-chat column's width in theater (spec 7.1, Hidden chrome). */
const RAIL_W = 320;

/** The default roster lookup, as one shared object rather than a fresh `{}`
 *  per render. The canvas repaints when its props change, and a route that
 *  passes no names (the by-filename replay page) would otherwise hand it a
 *  new object every render and make a paused viewer repaint for nothing. */
const NO_NAMES: Record<string, string> = {};

export function Viewer(
  { spec, live = false, names = NO_NAMES, timeline }:
  { spec: ReplaySpec; live?: boolean; names?: Record<string, string>; timeline?: TimelineEntry[] },
) {
  const { header, frames, closed, tooNew, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live });
  const [toggles, toggle] = useToggles();
  const show: ShowFlags = { ci: toggles.ci, entities: toggles.entities, names: toggles.names };

  // Theater is a layout state of this component (spec 7.1), never a route.
  const rootRef = useRef<HTMLDivElement>(null);
  const { theater, toggle: toggleTheater } = useTheater(rootRef);
  const { idle, wake } = useIdle(theater);

  /**
   * One interpolated frame per DOM tick, shared by everything made of DOM.
   *
   * The status counts, the health panels and the map layer must agree, so
   * they all read this one memo rather than bracketing for themselves. It
   * runs at `playback.tMs`, which publishes about ten times a second, because
   * that is the rate the recording changes at: nothing below can show a value
   * the frames did not have.
   *
   * The canvas is deliberately NOT on this. It interpolates from
   * `playback.tRef` inside its own animation loop, because it is the one
   * thing on the page whose output changes between two recorded frames.
   * Worst case it is drawing a moment up to one publish ahead of these
   * numbers, which is the same tenth of a second the recording rounds away
   * anyway.
   */
  const { livePlayers, counts } = useMemo(() => {
    const pair = bracket(frames, playback.tMs);
    if (!pair) {
      return { livePlayers: [], counts: { survivors: 0, commons: 0, specials: 0 } };
    }
    const players = interpolatePlayers(pair.a, pair.b, pair.f);
    const entities = interpolateEntities(pair.a, pair.b, pair.f);
    return { livePlayers: players, counts: sceneCounts(players, entities) };
  }, [frames, playback.tMs]);

  /**
   * The canvas takes the map's own shape instead of one fixed rectangle, and
   * its backing store follows the element's real width. In theater the stage
   * is the viewport, so the element's own shape wins and the fit letterboxes
   * the map inside it.
   *
   * The captures and the old fixed canvas were both 1.61 landscape, so
   * cropping a map's horizontal void only moved that void into the canvas as
   * black bars and left the height governing the fit: eighteen of the
   * twenty-two maps came out SMALLER than before the crop existed. The shape
   * has to follow the content box for the crop to buy anything at all.
   */
  const aspect = useMemo(() => mapAspect(header), [header?.map]);
  const { size, ref: stageRef } = useCanvasSize(aspect, theater);
  const stageStyle = useMemo(() => ({
    // A single number, not a `w / h` pair, so the layout box and the backing
    // store are computed from the identical value and the browser has nothing
    // left to letterbox.
    aspectRatio: String(aspect),
    maxWidth: `min(${canvasForAspect(aspect).width}px, calc(${STAGE_MAX_VH}vh * ${aspect}))`,
  }), [aspect]);

  const { transform, view, backdrop } = useMapLayer(header, frames, livePlayers, size);

  /** Written by the canvas on every paint. See ReplayCanvasProps.shiftRef. */
  const shiftRef = useRef({ x: 0, y: 0 });
  // The fit from useMapLayer is the camera's base; the canvas draws the
  // camera's view. Follow lives here too because following clears the pan.
  const camera = useCamera(view, size, shiftRef);
  const { follow, setFollow } = camera;
  const followSlot = followSlotOf(follow);
  // The follow row is the bookmark selector (spec 7.2). '' is an unrostered
  // slot and selects nothing; see tickEntries.
  const selected = followSlot === null || !header ? null : (header.slots[followSlot] ?? '');

  /** Entering theater opens a close camera on the team if the viewer was
   *  still at its defaults; leaving puts back whatever was there before,
   *  so a viewer the user had already zoomed is not reset on them. */
  const before = useRef<CameraState | null>(null);
  useEffect(() => {
    if (theater) {
      const s = camera.snapshot();
      before.current = s;
      if (s.cam.zoom === 1 && s.follow.kind === 'free') camera.restore(THEATER_CAMERA);
    } else if (before.current) {
      camera.restore(before.current);
      before.current = null;
    }
    // camera.snapshot and camera.restore are stable callbacks; only the
    // theater flag should drive this.
  }, [theater]);

  const trail = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < frames.length; i += 10) {
      const alive = frames[i].players.filter((p) => isSurvivor(p) && (p.state & STATE.ALIVE) !== 0);
      if (alive.length === 0) continue;
      out.push({
        x: alive.reduce((n, p) => n + p.x, 0) / alive.length,
        y: alive.reduce((n, p) => n + p.y, 0) / alive.length,
      });
    }
    return out;
  }, [frames.length]);

  if (tooNew) {
    return (
      <div class="replay replay--empty">
        This replay was recorded in a newer format than this page can read.
      </div>
    );
  }
  if (error && !header) return <div class="replay replay--empty">Couldn't load that replay.</div>;
  if (!header) return <div class="replay replay--empty">Loading replay...</div>;

  const railOn = Boolean(timeline) && (toggles.events || toggles.chat);
  const theaterChip = { on: theater, toggle: toggleTheater };
  const rootClass = `replay${theater ? ' replay--theater' : ''}${theater && idle ? ' is-idle' : ''}`;

  const canvas = (
    <div
      class={`replay__stage${camera.dragging ? ' is-dragging' : ''}`}
      ref={stageRef}
      style={theater ? undefined : stageStyle}
      onWheel={camera.onWheel}
      onPointerDown={camera.onPointerDown}
    >
      <ReplayCanvas
        transform={transform}
        view={camera.view}
        size={size}
        backdrop={backdrop}
        trail={trail}
        frames={frames}
        timeRef={playback.tRef}
        show={show}
        follow={follow}
        shiftRef={shiftRef}
        names={names}
        slots={header.slots}
      />
      <div class="replay__vignette" aria-hidden="true" />
      {!theater && (
        <ReplayHud
          tMs={playback.tMs}
          endMs={endMs}
          counts={counts}
          live={live}
          closed={closed}
          toggles={toggles}
          toggle={toggle}
          theater={theaterChip}
        />
      )}
    </div>
  );

  const controls = (
    <ReplayControls
      playback={playback}
      endMs={endMs}
      live={live}
      follow={follow}
      setFollow={setFollow}
      slots={header.slots}
      names={names}
      timeline={timeline}
      zoom={camera.cam.zoom}
      setZoom={camera.setZoom}
    />
  );

  const rail = timeline && railOn && (
    <TimelineRail
      timeline={timeline}
      tMs={playback.tMs}
      toggles={toggles}
      seek={playback.seek}
      names={names}
      selected={selected}
    />
  );

  if (theater) {
    return (
      <div
        class={rootClass}
        ref={rootRef}
        style={{ '--rail-w': `${railOn ? RAIL_W : 0}px` }}
        onPointerMove={wake}
        onFocusIn={wake}
      >
        <div class="replay__frame">{canvas}</div>
        {/* Spec 7.1, Hidden chrome: the toolbar along the top fades when idle.
            Toggles join it because the in-stage HUD is not drawn here. */}
        <div class="theater__top">
          {controls}
          <div class="theater__toggles">
            <ToggleChips toggles={toggles} toggle={toggle} theater={theaterChip} />
          </div>
        </div>
        <HudStrip
          players={livePlayers}
          header={header}
          names={names}
          showHp={toggles.hp}
          showGuns={toggles.guns}
          layout="edges"
        />
        {rail && <div class="theater__rail">{rail}</div>}
        <TheaterStatus
          tMs={playback.tMs}
          endMs={endMs}
          counts={counts}
          zoom={camera.cam.zoom}
          live={live}
          closed={closed}
        />
      </div>
    );
  }

  return (
    <div class={rootClass} ref={rootRef}>
      <div class="replay__frame">
        <div class="replay__sprocket replay__sprocket--l" aria-hidden="true" />
        {canvas}
        <div class="replay__sprocket replay__sprocket--r" aria-hidden="true" />
      </div>

      {rail}

      {controls}

      <HudStrip
        players={livePlayers}
        header={header}
        names={names}
        showHp={toggles.hp}
        showGuns={toggles.guns}
      />
    </div>
  );
}
```

Note on `style={{ '--rail-w': ... }}`: Preact passes unknown style keys through `style.setProperty`, so a custom property works. If the typecheck rejects the key, cast: `style={{ '--rail-w': `${railOn ? RAIL_W : 0}px` } as Record<string, string>}`.

- [ ] **Step 4: Theater CSS**

Append to the replay viewer section of `web/src/styles/app.css` (before the `/* ---------- ... */` banner that follows it, or at the end of the file if it is last):

```css
/* ---------- theater (spec 7.1) ---------- */

/* The viewer takes the viewport; the page behind keeps its scroll position
   because nothing about it moved, it only stopped scrolling. */
body.is-theater { overflow: hidden; }
.replay--theater { position: fixed; inset: 0; z-index: 50; gap: 0; background: var(--bg); }
.replay--theater .replay__frame { position: absolute; inset: 0; border: 0; background: var(--bg); }
.replay--theater .replay__stage { width: 100%; height: 100%; }
.replay--theater .replay__vignette { box-shadow: inset 0 0 160px rgba(0, 0, 0, 0.8); }

/* Hidden chrome: the toolbar fades after two seconds without pointer
   movement (useIdle) and comes back on movement or keyboard focus. */
.theater__top {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
  background: linear-gradient(rgba(5, 4, 3, 0.9), rgba(5, 4, 3, 0));
  transition: opacity 0.4s ease;
}
.theater__toggles { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.replay--theater.is-idle .theater__top { opacity: 0.15; }
.replay--theater.is-idle .theater__top:hover,
.replay--theater.is-idle .theater__top:focus-within { opacity: 1; }
.replay--theater .chip { background: rgba(5, 4, 3, 0.78); }

/* Edge HUD: survivors down the left, infected down the right, as plates
   over the map. The right column sits inboard of the rail when the rail is
   open (`--rail-w` is set on the root), so the feed pushes the cards in
   rather than covering them. */
.hud-edge {
  position: absolute; top: 150px; bottom: 60px; z-index: 2;
  display: flex; flex-direction: column; gap: var(--sp-2);
  width: 240px; padding: var(--sp-2); overflow: hidden; pointer-events: none;
}
.hud-edge--l { left: 0; }
.hud-edge--r { right: var(--rail-w, 0px); transition: right 0.25s ease; }
.hud-edge .hudp { background: rgba(5, 4, 3, 0.78); border-color: rgba(255, 255, 255, 0.06); min-width: 0; flex: none; pointer-events: auto; }
.hud-edge .hudp--empty { display: none; }

/* The events and chat column. */
.theater__rail {
  position: absolute; top: 150px; right: 0; bottom: 60px; z-index: 2;
  width: 320px; padding: var(--sp-2); overflow-y: auto;
  background: rgba(5, 4, 3, 0.85); border-left: 1px solid var(--border);
}
.theater__rail .replay__rail { max-height: none; }

/* Status line across the bottom. */
.tstat {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  display: flex; align-items: baseline; gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  font-family: var(--font-label); font-size: var(--fs-dense); letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text); background: linear-gradient(rgba(5, 4, 3, 0), rgba(5, 4, 3, 0.9));
  pointer-events: none;
}
.tstat__time { font-family: var(--font-display); font-size: 1.75rem; line-height: 1; color: var(--text-bright); letter-spacing: 0; text-shadow: 0 3px 0 #000; }
.tstat__item--win { color: var(--win); }
.tstat__item--live { color: var(--accent); }

@media (max-width: 900px) {
  .hud-edge { width: 170px; }
  .hud-edge .hudp__face { display: none; }
  .theater__rail { width: 260px; }
}
```

Note that `#000` in the text shadow mirrors the existing `.rhud__time` rule; no other raw hex is introduced. If `web/src/styles/tokens.test.ts`'s forbidden-hex scan flags anything here, replace it with the token it names rather than adding an exception.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Browser check**

With the dev server on 5173, open `http://localhost:5173/match/9001`, press play, click Theater. Check each against spec 7.1:

- The viewer fills the window (fullscreen if the browser allows it); the map is zoomed 2x and follows the survivors; the Survivors chip is lit.
- Survivor cards down the left, infected down the right, as translucent plates. Toggle Events and Chat off: the right cards slide to the window edge; on: they move inboard of the rail.
- Stop moving the mouse for two seconds: the top bar fades to a ghost; move it: it returns. Tab into a chip while faded: it returns.
- The bottom line reads time of end, alive, common, specials, zoom.
- Wheel zooms about the cursor; drag pans and turns follow off; Survivors turns it back on centred.
- Escape returns to the page at the same scroll position, with the camera back at fit and free, and the strip HUD below the stage again.
- Press the Theater chip again to enter and the browser back button: the route must not change (theater is not a URL).

Take a screenshot in theater with the rail open and one with it closed; keep them for the commit message or the PR.

- [ ] **Step 7: Commit**

```bash
git add web/src/replay/Viewer.tsx web/src/replay/Viewer.test.tsx web/src/styles/app.css
git commit -m "feat(replay): theater mode with edge hud, status line and fading chrome"
```

---

### Task 13: Record the build and close out

Spec 8 and 10. The spec's decisions list and the rollout table record what shipped; the memory note is outside the repo and is the session's job, not this plan's.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md` (sections 8 and 10)

- [ ] **Step 1: Amend the spec's rollout and decisions**

In section 8, find the line describing step 6 (theater mode) and mark it built, in the same style the other five steps were marked in commit 8a247f5. In section 10, append:

```markdown
- Theater opens at 2x on the survivor centroid only when the viewer was at
  fit and free; a camera the user had set is kept, and leaving theater
  restores the camera from before entry.
- Pan clamps per axis: an axis where the drawn map fits inside the canvas is
  centred and cannot pan; one it overflows may bring the map edge to the
  canvas edge and no further. Following is never clamped.
- Theater canvas budget is 2560x1440 backing pixels, up from 1280x794, so a
  viewport-filling canvas is not drawn soft.
- The follow row is the bookmark selector; there is no separate control.
  Role colour: `--win` did it, `--accent` had it done to them. `death` and
  `incap` are victim-first kinds and the role table accounts for it.
- The timeline payload is a discriminated union (event: `event`, `actor`,
  `target`, `value`; chat: `actor`, `team`, `text`); the client composes
  every sentence and resolves every id through the roster. The live feed
  reads verbs from the same table.
- Wheel zoom step is 1.25 per notch, range 1 to 8; chips are fit, 2x, 4x, 6x.
- Drag is recognised after 3px of travel; a shorter press is a click.
```

- [ ] **Step 2: Run everything one last time**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md
git commit -m "docs(design): record theater mode and bookmarks as built"
```

---

## Self-review against the spec

**7.1 Entry and exit:** Theater chip (Task 11, 12), viewport fill (Task 9, 12), fullscreen requested (Task 10), Escape, chip and leaving fullscreen all exit (Task 10, 12), scroll preserved by `body.is-theater { overflow: hidden }` (Task 12), one URL (Task 12: layout state only).
**7.1 Camera:** zoom chips fit/2/4/6 (Task 8), wheel about the cursor (Task 6, 8), drag to pan (Task 8), follow on by default in theater on the centroid (Task 6 `TEAM`, Task 12 `THEATER_CAMERA`), slot follow (Task 7), any drag turns follow off and the follow chip clears the pan (Task 8), transform in `View` after the fit with `projectView` and `drawScene` unchanged (Task 6), inverse for drag (Task 6 `unprojectView`).
**7.1 Edge HUD:** Task 11 `layout="edges"`, Task 12 CSS with the `rgba(5,4,3,0.78)` plate.
**7.1 Status line:** Task 11, 12.
**7.1 Hidden chrome:** Task 10 `useIdle`, Task 12 `.theater__top` fade and `--rail-w` push.
**7.1 Also in normal mode:** Task 8 wires wheel, drag and chips in the embedded viewer with fit and free defaults.
**7.1 Left out on purpose:** no opacity slider, no calibration, no CSV; none added.
**7.1 Tests:** zoom about a point, pan clamping, round trip (Task 6); theater render test with card count and order and Escape (Task 12); draw tests untouched (no task edits `draw.ts` or `draw.test.ts`).
**7.2 Selection, Role colour, Clickable ticks, Rail, Sentences, Payload, Tests:** Tasks 1 to 5.

**Type consistency check:** `Follow`, `FREE`, `TEAM`, `followSlotOf`, `followPoint` (Task 6) are what Tasks 7, 8, 12 import. `ReplayControlsProps` ends with `follow`, `setFollow`, `zoom`, `setZoom` (Tasks 7, 8) and Task 12 passes exactly those. `ReplayCanvasProps.follow` and `shiftRef` (Task 7) are what Task 8's hook and Task 12 use. `TimelineRailProps.selected` (Task 5) is passed in Task 12. `useCanvasSize(aspect, fill)` (Task 9) matches Task 12. `CameraState` (Task 8) is what Task 12's `THEATER_CAMERA` is typed as. `ToggleChips`'s `theater` prop shape `{ on, toggle }` (Task 11) matches Task 12's `theaterChip`.

**Known judgment calls the executor should not relitigate:** the theater pixel budget, the 3px drag threshold, the 1.25 wheel step, "Survivors" as the centroid chip's label, and grouping the rail biggest-first. All are recorded in Task 13.
