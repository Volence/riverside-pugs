# Drafts plan D2b2: the caster studio's live draft scenes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A caster can put a live draft on air from the caster studio. The studio follows one draft event (picked in a new "Draft on air" box, next to the match on air), the OBS overlays get two new scenes, **Draft board** (every team, captains on top, picks filling in, the pick on the clock highlighted) and **On the clock** (the captain up, a big countdown synced with the server's clock, their team so far and the best three available by SR), and every new pick is revealed by itself: a big card over the two draft scenes, and a lower-third strip (a new **Pick reveal** layer, also laid over the other scenes on the Program link). The overlay feed carries the public room only, and the OBS scene collection gains the two scenes.

D2b1 (`docs/superpowers/plans/2026-10-08-drafts-2b-live-draft-room.md`) built the room and promised that D2b2 reads it through `draftRoomView` and the `draft:<eventId>` hub event without changing it. This plan keeps that promise: no file D2b1 created is modified.

**Architecture:**
- **Shapes** (`src/cast/types.ts`, no imports, shared with the web): two scene keys and one layer key appended, letter hotkeys for them, `StudioState.draftEventId` and `StudioState.draftStrip`, the overlay's own draft shapes (`CastDraftView` and friends) and `OverlayFeed.draft`.
- **Access** (`src/cast/access.ts`): `canCastDraft` and `pickableDrafts`, the one rule for which drafts a caster may follow, asked on every feed read like `canCastMatch`.
- **The public view** (`src/cast/draftView.ts`, new): `castDraftView` calls D2b1's `draftRoomView` as an anonymous viewer and copies a whitelist of fields into `CastDraftView`, so even a staff caster's overlay can never carry notes, lists, chemistry or fairness. A per-event card memo (`makeCardCache`) keeps a pick from rebuilding every card.
- **Routes** (`src/routes/castStudio.ts`): the panel lists followable drafts and refuses one the caster may not follow, the feed carries `draft`, and a `Hub` subscription drops the cached feed of every studio following a draft when `draft:<eventId>` is broadcast, so the next 1 s poll is fresh. The poll stays the delivery path (OBS browser sources keep their shared-worker poll; Ruling 6).
- **Overlay** (`web/src/overlay/`): a pure reveal queue (`draftReveal.ts`, the auto-callout pattern), the draft scenes and reveal cards (`DraftScenes.tsx`), shared pieces moved out of `Scenes.tsx` (`pieces.tsx`), a sample draft for the panel preview, and the CSS.
- **Panel** (`web/src/routes/CastStudio.tsx`): a "Draft on air" box with the picker and the strip toggle; the preview shows the sample only when neither a match nor a draft is on air.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes on the server), Fastify 5, better-sqlite3, vitest (`npx vitest run <file>`; web: `npx vitest run --project web <file>`), `npm run typecheck` (server and web). Preact + @testing-library/preact (happy-dom). Headless Chrome over the DevTools protocol for the scratch walk, as `scripts/shoot-pages.mjs` does. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` section 4 ("The caster studio (part 2, v1.1) gets draft scenes: pick reveal, board, on-the-clock"; "chemistry and captains' lists are never sent to viewers") and its Testing section (privacy). It builds on D2b1 (`docs/superpowers/plans/2026-10-08-drafts-2b-live-draft-room.md`, Rulings 3, 7, 9, 10, 14, 21, 22) and the caster studio plan (`docs/superpowers/plans/2026-10-02-caster-studio.md`, Rulings 1, 2, 9, 15, 16).

## Global Constraints

- Work only in a new worktree `/home/volence/l4d/pug/.claude/worktrees/drafts-2b2` on a new branch `drafts-2b2` cut from `drafts-2b` (D2b1's branch, at its head when execution starts). `node_modules` is installed in the parent checkout; run `npm ci` in the new worktree if `node_modules` is missing. Never use bare `git stash`. Do not push. Do not deploy, restart, stage or rcon any box, and never touch `/home/volence/l4d1-ds` or `data/pug.db`.
- Never write em dashes (or en dashes) in code, comments, copy, commits or docs: use a comma, a colon, parentheses or "to".
- Commit messages follow the repo style: one plain sentence (or two) describing the change, ending with "(plan D2b2)".
- No file D2b1 created is modified: `src/events/draftRoom.ts`, `draftRoomView.ts`, `draftCards.ts`, `draftClock.ts`, `src/routes/draftRoom.ts`, `web/src/routes/EventDraft.tsx` and `web/src/routes/event/draft/*` are read only here.
- Writers (`tests/eventLogGuard.test.ts`): nothing in this plan writes an event table. `src/cast/*` only reads `events`, `draft_rooms`, `draft_picks` and `draft_signups` (through D2b1's readers).
- Privacy (spec, D2b1 Ruling 14): the overlay feed, the panel feed and the panel never carry a signup note, a pick list, chemistry, the fairness readout, the room's `me`, `lists`, `notes` or `delegates`, whoever the caster is (staff, organizer or a captain included).
- Overlay keys stay the only overlay credential (caster studio Ruling 1): every overlay read asks `canCastDraft` again, so a cleared caster flag, a ban, the switch going back to `admins`, a cancelled event or a revoked key takes the draft off air at once.
- Scene and layer keys are lower-case letters only: `src/server.ts` and `vite.config.ts` route `/overlay/<key>` with `/^\/overlay\/[a-z]+\/?(\?|$)/`.
- Overlay CSS uses only the existing overlay variables (`--accent`, `--panel`, `--panel-2`, `--bone`, `--text`, `--text-muted`, `--font-display`, `--font-label`, `--font-body`, `--stencil`) plus the per-team `--c` set inline.
- The 7 `tests/skeetStreakPoster.test.ts` wall-clock failures are known on master (checked 2026-10-08); keep everything else passing.

## Review Focus

1. **A caster who is staff, the event's organizer and a captain.** D2b1's room view shows such a viewer the notes, every list and their chemistry. The overlay must still get the anonymous public view. Task 3 pins it with a caster who is all three at once.
2. **A followed draft that goes off air while saved.** Six hours after the teams are published (or after a cancel) the saved `draftEventId` is no longer castable. The feed drops it, and the next save clears it quietly instead of refusing every later save with 403. Task 3 pins it.
3. **Undo while a pick is being revealed.** Staff undo the pick on screen: the card leaves at once, and the re-pick of the same slot is revealed as a new pick. Task 4 pins it.
4. **An overlay that loads mid-draft, or that OBS throttled.** Picks already made when the overlay first sees the draft are history and never revealed; a backlog of picks older than 20 s is skipped rather than replayed card after card. Task 4 pins it.
5. **Two picks in one feed.** The site makes the final pick in the same transaction as the one before it (D2b1 Ruling 9), so one feed brings two new picks: both are revealed, one after the other, in pick order. Task 4 pins it.

## Rulings

None of these is an owner ruling yet; all are decided for this plan and await owner review.

1. **The draft follows separately from the match.** `StudioState.draftEventId` sits alongside `matchId` and `bookingId`, cleaned with the same `posInt`. Picking a draft never clears the match on air and picking a match never clears the draft, so a show can cut from the draft board to the first game and back. Draft scenes read `feed.draft`, match scenes read `feed.match`.
2. **Which drafts a caster may follow.** A draft-kind event that is published (status not `draft` or `cancelled`), whose cut is published, whose `team_mode` is `'live'`, and whose teams are unpublished or were published within `RECENT_HOURS` (6 h, the match picker's window). The caster must pass `mayCast` and `competitiveAccess` (the `competitive_enabled` switch, so under `admins` only admin casters see drafts). There is no stake rule: a caster who is a captain or a pool player may follow the draft, because the overlay carries only what the public room page shows.
3. **Public view only, by whitelist.** `castDraftView` builds D2b1's view for the anonymous viewer (`{ steamid: null, staff: false }`) and copies named fields into `CastDraftView`. Cards keep SR, PUGs, form, survivor and infected per-game numbers and the best class; the SR trend and the skill counters stay off the overlay (no room for them on a broadcast card). A test pins the exact key sets.
4. **Scenes and layers.** Two scenes, appended after Results so the run-of-show keys 1 to 0 and R do not move: `draftboard` "Draft board" (hotkey B) and `draftclock` "On the clock" (hotkey C). One layer: `draftreveal` "Pick reveal" (the strip). Pick reveal is not a scene of its own, because a scene the producer must cut to by hand defeats a reveal that fires by itself: the big card fires over the two draft scenes, and the strip fires on the Pick reveal layer link and, on the Program link, over any scene that is not a draft scene when `draftStrip` is on (default on).
5. **Reveal timing.** Each new pick shows for `DRAFT_REVEAL_MS` (7 s), queued in pick order. The queue lives in each overlay, like auto callouts, so every OBS source agrees. The first feed of a draft is history. A queued pick older than `REVEAL_STALE_MS` (20 s, by its server `at` against the overlay's skew-corrected clock) is skipped. A pick that is undone leaves the screen and the queue at once.
6. **Push path.** Overlays keep the shared-worker poll (1 s) they already use; there is no websocket for OBS sources. The `draft:<eventId>` hub event drops the 900 ms feed cache of every studio following that draft, so the next poll answers fresh. The poll is the fallback and the delivery path at once.
7. **On the clock.** Captain (avatar, name), "X picks for the team" when a delegate picks, pick X of Y and round, the countdown from the stored deadline against the feed's server time (the existing `skewMs`), turning accent in the last 10 s, the team so far (captain first) and the best three free players by SR (`BEST_AVAILABLE = 3`, public cards sorted by SR then name; never a captain's list). Paused: "Paused" and the frozen time left. Before Start: "The draft starts soon", plus the studio countdown when one is set. Done: "Draft complete".
8. **Board.** Teams in round 1 order (signup order before Start), the captain on top with SR, one slot per round with its snake pick number once the room has started, the slot on the clock highlighted, auto picks marked "Auto", a status line along the bottom. An eight-colour team palette in `DraftScenes.tsx`. With more than five teams the slot avatars are hidden so names keep their room.
9. **Card memo.** `makeCardCache` keeps a 60 s per-event memo in the cast module (D2b1's route memo is private to `src/routes/draftRoom.ts`; Ruling 21's 60 s is kept).
10. **Saving the studio.** A newly chosen draft the caster may not follow is refused `not_castable_draft` (the panel says "You cannot put that draft on air any more."). A saved draft that has gone off air is cleared to null on the next save instead (Review Focus 2).
11. **OBS scene collection.** It gains "RS Draft board" and "RS On the clock", each a full-frame browser source on the caster's own link, through the existing loop over `SCENES`. Layers stay links only, as today.
12. **Panel preview.** The sample feed gains a sample draft (five teams, seven picks, pick 8 on the clock), shown only when neither a match nor a draft is on air, so a caster can set up the draft scenes before a draft exists.
13. **Shared overlay pieces.** `Backdrop`, `Title`, `Countdown` and `fmtClock` move unchanged from `Scenes.tsx` to `web/src/overlay/pieces.tsx` so the draft scenes can use them without a circular import.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/cast/types.ts` | modify | Draft scene and layer keys, letter hotkeys, `DRAFT_SCENES`, `StudioState.draftEventId` and `draftStrip`, `CastDraft*` shapes, `OverlayFeed.draft` |
| `src/cast/studio.ts` | modify | `cleanState` for the two new fields |
| `src/cast/access.ts` | modify | `canCastDraft`, `pickableDrafts` |
| `src/cast/draftView.ts` | create | `castDraftView` (the whitelisted public view), `makeCardCache` |
| `src/routes/castStudio.ts` | modify | Panel `drafts`, the save check, `feed.draft`, hub cache drop, injectable clock |
| `src/server.ts` | modify | Pass `hub` to `castStudioRoutes` |
| `web/src/overlay/pieces.tsx` | create | `Backdrop`, `Title`, `Countdown`, `fmtClock` (moved) |
| `web/src/overlay/draftReveal.ts` | create | The pure reveal queue |
| `web/src/overlay/DraftScenes.tsx` | create | `DraftBoard`, `OnTheClock`, `DraftRevealCard`, `DraftRevealStrip`, `draftClockMs`, `draftStatusLine` |
| `web/src/overlay/Scenes.tsx` | modify | Import the pieces, run the reveal queue, route the new keys, the Program strip |
| `web/src/overlay/overlay.css` | modify | Draft board, clock, reveal card and strip |
| `web/src/overlay/sample.ts` | modify | `sampleDraft`, `draft` on the sample feed |
| `web/src/api.ts` | modify | `StudioPickDraft`, `StudioPanel.drafts` |
| `web/src/routes/CastStudio.tsx` | modify | `DraftOnAir` box, save error, preview sample rule |
| `tests/castDraftState.test.ts` | create | State cleaning, scene keys, OBS collection |
| `tests/castDraft.test.ts` | create | Access rule and the public view |
| `tests/castDraftFeed.test.ts` | create | Panel, save and feed routes, privacy, hub refresh |
| `web/src/overlay/draftReveal.test.ts` | create | Reveal queue |
| `web/src/overlay/DraftScenes.test.tsx` | create | Scene rendering |
| `web/src/routes/CastStudio.test.tsx` | create | The Draft on air box |
| `web/src/overlay/Scenes.test.tsx` | modify | `draft: null` on its feed literal |

---

### Task 1: Draft scene keys and the studio's draft fields

**Files:**
- Modify: `src/cast/types.ts`
- Modify: `src/cast/studio.ts`
- Modify: `src/routes/castStudio.ts` (one line: `draft: null` on the feed, replaced in Task 3)
- Modify: `web/src/overlay/sample.ts` (one line: `draft: null`, replaced in Task 5)
- Modify: `web/src/overlay/Scenes.test.tsx` (one line: `draft: null` on its feed literal)
- Test: `tests/castDraftState.test.ts` (new)

**Interfaces:**
- Consumes: `cleanState` (`src/cast/studio.ts`), `obsCollection(o: { overlayUrl: (key: string) => string; casters: CasterLine[] }): object` and `obsSceneName(key: SceneKey | 'program'): string` (`src/cast/obsCollection.ts`), unchanged.
- Produces (all in `src/cast/types.ts`):
  ```ts
  export const SCENES: readonly [..., 'results', 'draftboard', 'draftclock'];
  export const DRAFT_SCENES: readonly SceneKey[]; // ['draftboard', 'draftclock']
  export const LAYERS: readonly ['scorebug', 'roundhud', 'lowerthird', 'draftreveal'];
  export const SCENE_HOTKEYS: Record<SceneKey, string>; // draftboard 'B', draftclock 'C'
  // StudioState gains: draftEventId: number | null; draftStrip: boolean;
  export type DraftStatus = 'ready' | 'running' | 'paused' | 'done';
  export interface CastDraftPlayer { steamid: string; name: string; avatar: string | null; sr: number }
  export interface CastDraftCard extends CastDraftPlayer {
    pugs: number; form: ('W' | 'L' | 'D')[];
    survivor: { siDamage: number; commonKills: number };
    infected: { damageAsSi: number; dpsLanded: number };
    bestClass: 'hunter' | 'smoker' | 'boomer' | 'tank' | null;
  }
  export interface CastDraftPick { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
  export interface CastDraftTeam { captain: CastDraftPlayer; players: CastDraftPlayer[]; slots: number[] }
  export interface CastDraftView {
    eventId: number; eventName: string; status: DraftStatus;
    deadlineAt: string | null; pausedLeftMs: number | null; pickSeconds: number;
    totalPicks: number; rounds: number;
    onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
    teams: CastDraftTeam[]; picks: CastDraftPick[];
    cards: Record<string, CastDraftCard>; best: CastDraftCard[]; poolLeft: number;
  }
  export const BEST_AVAILABLE = 3;
  // OverlayFeed gains: draft: CastDraftView | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/castDraftState.test.ts
import { describe, it, expect } from 'vitest';
import { cleanState } from '../src/cast/studio.js';
import { obsCollection, obsSceneName } from '../src/cast/obsCollection.js';
import { DRAFT_SCENES, LAYERS, SCENES, SCENE_HOTKEYS, SCENE_LABELS, defaultStudioState } from '../src/cast/types.js';

/** Drafts plan D2b2 Rulings 1, 4 and 11. */
describe('studio state: the draft on air', () => {
  it('defaults to no draft and the reveal strip on', () => {
    expect(defaultStudioState()).toMatchObject({ draftEventId: null, draftStrip: true });
    expect(cleanState({})).toMatchObject({ draftEventId: null, draftStrip: true });
  });

  it('keeps a positive integer id and an explicit strip off, nothing else', () => {
    expect(cleanState({ draftEventId: 12, draftStrip: false })).toMatchObject({ draftEventId: 12, draftStrip: false });
    for (const bad of [0, -4, 1.5, '12', null, 2 ** 31]) expect(cleanState({ draftEventId: bad }).draftEventId).toBeNull();
    expect(cleanState({ draftStrip: 'no' }).draftStrip).toBe(true);
  });

  it('is independent of the match on air', () => {
    expect(cleanState({ matchId: 7, draftEventId: 12 })).toMatchObject({ matchId: 7, bookingId: null, draftEventId: 12 });
  });

  it('accepts the draft scenes, and never the reveal layer as a scene', () => {
    expect(cleanState({ scene: 'draftboard' }).scene).toBe('draftboard');
    expect(cleanState({ scene: 'draftclock' }).scene).toBe('draftclock');
    expect(cleanState({ scene: 'draftreveal' }).scene).toBe('starting');
  });
});

describe('draft scene keys', () => {
  it('appends the draft scenes after the run of show, with letter hotkeys', () => {
    expect(SCENES.slice(0, 11)).toEqual(['starting', 'casters', 'gameplay', 'mapintro', 'maps', 'lineups', 'stats', 'brb', 'winner', 'ending', 'results']);
    expect(DRAFT_SCENES).toEqual(['draftboard', 'draftclock']);
    expect(SCENE_HOTKEYS.draftboard).toBe('B');
    expect(SCENE_HOTKEYS.draftclock).toBe('C');
    expect(SCENE_HOTKEYS.starting).toBe('1');
    expect(SCENE_HOTKEYS.ending).toBe('0');
    expect(SCENE_HOTKEYS.results).toBe('R');
    expect(new Set(Object.values(SCENE_HOTKEYS)).size).toBe(SCENES.length);
    expect(LAYERS).toContain('draftreveal');
    expect(SCENE_LABELS.draftboard).toBe('Draft board');
    expect(SCENE_LABELS.draftclock).toBe('On the clock');
    expect(SCENE_LABELS.draftreveal).toBe('Pick reveal');
  });

  it('keeps every overlay key to lower-case letters (the /overlay/<key> route pattern)', () => {
    for (const k of [...SCENES, ...LAYERS]) expect(k).toMatch(/^[a-z]+$/);
  });

  it('puts both draft scenes in the OBS scene collection', () => {
    const c = obsCollection({ overlayUrl: (k) => `https://x/overlay/${k}?k=K`, casters: [] }) as {
      scene_order: { name: string }[]; sources: { id: string; settings: { url?: string } }[];
    };
    const names = c.scene_order.map((s) => s.name);
    expect(obsSceneName('draftboard')).toBe('RS Draft board');
    expect(obsSceneName('draftclock')).toBe('RS On the clock');
    expect(names).toContain('RS Draft board');
    expect(names).toContain('RS On the clock');
    const urls = c.sources.filter((s) => s.id === 'browser_source').map((s) => s.settings.url);
    expect(urls).toContain('https://x/overlay/draftboard?k=K');
    expect(urls).toContain('https://x/overlay/draftclock?k=K');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/castDraftState.test.ts`
Expected: FAIL (`DRAFT_SCENES` is not exported; `draftEventId` is undefined).

- [ ] **Step 3: Add the keys and shapes to `src/cast/types.ts`**

Replace the `SCENES` and `SCENE_HOTKEYS` block (from `export const SCENES = [` through `export type SceneKey = (typeof SCENES)[number];`) with:

```ts
export const SCENES = [
  'starting', 'casters', 'gameplay', 'mapintro', 'maps', 'lineups', 'stats', 'brb', 'winner', 'ending', 'results',
  // Drafts plan D2b2: appended, so the run-of-show keys never move.
  'draftboard', 'draftclock',
] as const;

/** Scenes with a letter instead of a number: added after the run of show. */
const LETTER_KEYS: Partial<Record<SceneKey, string>> = { results: 'R', draftboard: 'B', draftclock: 'C' };

/** The panel's hotkey for each scene: 1-9 and 0 in order (the run of show
 *  casters learned), then letters for scenes added later. */
export const SCENE_HOTKEYS: Record<SceneKey, string> = Object.fromEntries(
  SCENES.map((s, i) => [s, LETTER_KEYS[s] ?? (i === 9 ? '0' : String(i + 1))]),
) as Record<SceneKey, string>;
export type SceneKey = (typeof SCENES)[number];

/** The live draft scenes (drafts plan D2b2): the pick reveal card fires over
 *  these by itself, and the Program strip never does. */
export const DRAFT_SCENES: readonly SceneKey[] = ['draftboard', 'draftclock'];
```

Change `LAYERS` to:

```ts
export const LAYERS = ['scorebug', 'roundhud', 'lowerthird', 'draftreveal'] as const;
```

Add to `SCENE_LABELS` (after `lowerthird: 'Lower third',`):

```ts
  draftboard: 'Draft board',
  draftclock: 'On the clock',
  draftreveal: 'Pick reveal',
```

In `interface StudioState`, after `bookingId: number | null;`:

```ts
  /** A live draft being followed (drafts plan D2b2 Ruling 1), or null.
   *  Independent of the match: a show can cut between the draft and a game. */
  draftEventId: number | null;
```

and at the end of `StudioState`, after `calloutSize: 'compact' | 'normal';`:

```ts
  /** On the Program link, a pick reveal strip over scenes that are not draft
   *  scenes (Ruling 4). The draft scenes always reveal with their own card. */
  draftStrip: boolean;
```

In `defaultStudioState()`, after `bookingId: null,` add `draftEventId: null,` and after `calloutSize: 'compact',` add `draftStrip: true,`.

After the `WitchRecap` interface (before `export interface OverlayFeed`), add:

```ts
/** A live draft as the overlays get it (drafts plan D2b2 Ruling 3): the
 *  public room only, built by src/cast/draftView.ts from a whitelist. Never a
 *  note, a pick list, chemistry or the fairness readout. */
export type DraftStatus = 'ready' | 'running' | 'paused' | 'done';
export interface CastDraftPlayer { steamid: string; name: string; avatar: string | null; sr: number }
export interface CastDraftCard extends CastDraftPlayer {
  /** Completed PUGs played. */
  pugs: number;
  /** Newest first, up to 10. */
  form: ('W' | 'L' | 'D')[];
  /** Per completed PUG, one decimal. */
  survivor: { siDamage: number; commonKills: number };
  infected: { damageAsSi: number; dpsLanded: number };
  bestClass: 'hunter' | 'smoker' | 'boomer' | 'tank' | null;
}
export interface CastDraftPick { pickNo: number; round: number; captain: string; steamid: string; name: string; auto: boolean; at: string }
export interface CastDraftTeam {
  captain: CastDraftPlayer;
  /** In pick order, so players[r] is the round r + 1 pick. */
  players: CastDraftPlayer[];
  /** This team's pick number in each round once the room has started; empty before Start. */
  slots: number[];
}
export interface CastDraftView {
  eventId: number;
  eventName: string;
  status: DraftStatus;
  /** Server time the running pick ends, or null when not running. */
  deadlineAt: string | null;
  /** Time left on the clock while paused, or null. */
  pausedLeftMs: number | null;
  pickSeconds: number;
  totalPicks: number;
  rounds: number;
  onClock: { pickNo: number; round: number; captain: string; picker: string } | null;
  /** Round 1 order. */
  teams: CastDraftTeam[];
  /** Live picks, in pick order. */
  picks: CastDraftPick[];
  /** A card for every picked player, for the reveal. */
  cards: Record<string, CastDraftCard>;
  /** The best free players by SR, highest first. */
  best: CastDraftCard[];
  poolLeft: number;
}
export const BEST_AVAILABLE = 3;
```

In `interface OverlayFeed`, after `casterAvatars: (string | null)[];`:

```ts
  /** The draft the studio follows, when the caster may still follow it (drafts plan D2b2). */
  draft: CastDraftView | null;
```

- [ ] **Step 4: Clean the two fields in `src/cast/studio.ts`**

In `cleanState`, after `bookingId: posInt(o.bookingId),` add:

```ts
    draftEventId: posInt(o.draftEventId),
```

and after `calloutSize: o.calloutSize === 'normal' ? 'normal' : 'compact',` add:

```ts
    draftStrip: o.draftStrip !== false,
```

- [ ] **Step 5: Keep every feed literal whole**

In `src/routes/castStudio.ts`, inside `feedFor`, in the `const feed: OverlayFeed = {` literal, after `casterAvatars: casterAvatars(db, studio.state.casters),` add `draft: null,` (Task 3 fills it).

In `web/src/overlay/sample.ts`, change the last line of `sampleFeed` to:

```ts
  return { rev: 0, serverNow: now, studio, match, live, tankRecap: null, witchRecap: null, casterAvatars: studio.casters.map(() => null), draft: null };
```

In `web/src/overlay/Scenes.test.tsx`, change the `feed` helper's literal to end with `casterAvatars: [], draft: null,`:

```ts
const feed = (patch: Partial<ReturnType<typeof defaultStudioState>> = {}): OverlayFeed => ({
  rev: 1, serverNow: Date.now(), studio: { ...defaultStudioState(), ...patch }, match, live, tankRecap: null, witchRecap: null, casterAvatars: [], draft: null,
});
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/castDraftState.test.ts tests/castStudio.test.ts && npx vitest run --project web web/src/overlay && npm run typecheck`
Expected: PASS; typecheck clean. `CastStudio.tsx` needs no change yet: its scene pad, hotkeys and links iterate `SCENES` and `LAYERS`, so the new keys appear by themselves (the draft scenes show their empty title until Task 5).

- [ ] **Step 7: Commit**

```bash
git add src/cast/types.ts src/cast/studio.ts src/routes/castStudio.ts web/src/overlay/sample.ts web/src/overlay/Scenes.test.tsx tests/castDraftState.test.ts
git commit -m "The caster studio knows two draft scenes (Draft board on B, On the clock on C) and a Pick reveal layer, its state can follow a draft event alongside the match, and the OBS scene collection includes the draft scenes (plan D2b2)"
```

---

### Task 2: Which drafts a caster may follow, and the public draft view

**Files:**
- Modify: `src/cast/access.ts`
- Create: `src/cast/draftView.ts`
- Test: `tests/castDraft.test.ts` (new)

**Interfaces:**
- Consumes (verified against D2b1's source):
  - `draftRoomView(db: DB, ev: E.EventRow, viewer: { steamid: string | null; staff: boolean }, now: Date, cardsOf: (steamids: string[]) => PlayerCard[]): DraftRoomView` from `src/events/draftRoomView.ts`. With `{ steamid: null, staff: false }` its `notes`, `lists`, `me.list` and `me.chemistry` are null; `status` is `'none'` unless `team_mode` is `'live'`.
  - `DraftRoomView` fields read: `eventId, eventName, status, settings.pickSeconds, deadlineAt, pausedLeftMs, totalPicks, order: { steamid; name }[], onClock: { pickNo; round; captain; picker } | null, picks: { pickNo; round; captain; steamid; name; auto; at }[], teams: { captain: { steamid; name }; players: { steamid; name }[] }[], pool: PlayerCard[]`.
  - `playerCard(db: DB, steamid: string, season?: number): PlayerCard` and `PlayerCard` (`steamid, name, avatar, sr, trend, pugs, form, survivor, infected, bestClass: { cls; damage } | null, skills`) from `src/events/draftCards.ts`.
  - `snakeSlots(order: string[], rounds?: number): { pickNo; round; captain }[]` and `ROUNDS` (3) from `src/events/draftRules.ts`.
  - `roomOf(db, eventId): RoomRow | null` and `livePicks(db, eventId): PickRow[]` from `src/events/draftRoom.ts`; `activeSignups(db, eventId): SignupRow[]` from `src/events/drafts.ts`; `getEvent(db, id): EventRow | undefined` from `src/events/events.ts`; `competitiveAccess(db, viewer: string | null): boolean` from `src/teams/access.ts`; `currentSeasonId(db): number` from `src/players.ts`; `mayCast`, `RECENT_HOURS` (already in `src/cast/access.ts`).
- Produces:
  ```ts
  // src/cast/access.ts
  export interface PickableDraft { id: number; name: string; slug: string; status: DraftStatus; picks: number; totalPicks: number }
  export function canCastDraft(db: DB, steamid: string, eventId: number, now?: Date): boolean;
  export function pickableDrafts(db: DB, steamid: string, now?: Date): PickableDraft[];
  // src/cast/draftView.ts
  export const CARD_TTL_MS = 60_000;
  export type CardCache = (eventId: number, nowMs: number) => (steamid: string) => PlayerCard;
  export function makeCardCache(db: DB, ttlMs?: number): CardCache;
  export function castDraftView(db: DB, eventId: number, now: Date, cardOf: (steamid: string) => PlayerCard): CastDraftView | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/castDraft.test.ts
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db.js';
import * as DR from '../src/events/draftRoom.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import { playerCard } from '../src/events/draftCards.js';
import { canCastDraft, pickableDrafts } from '../src/cast/access.js';
import { castDraftView, makeCardCache } from '../src/cast/draftView.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, CAPTAINS, POOL, T0, at, drive, liveDraft, must, startedDraft } from './draftRoomFixture.js';

/** Drafts plan D2b2 Rulings 2, 3, 7, 8 and 9. */
const CASTER = '76561199000000791';
function caster(db: DB, id = CASTER): string {
  upsertPlayer(db, { steamid: id, name: 'caster', avatar: null }, []);
  activatePlayer(db, id);
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(id);
  return id;
}
const view = (f: DraftFixture, now = at(5)) => castDraftView(f.db, f.eventId, now, (s) => playerCard(f.db, s))!;
const HOUR = 3_600_000;

describe('which drafts a caster may follow', () => {
  it('offers a live draft once its cut is published, and not an auto-balance one', () => {
    const live = liveDraft();
    caster(live.db);
    expect(canCastDraft(live.db, CASTER, live.eventId, T0)).toBe(true);
    expect(pickableDrafts(live.db, CASTER, T0)).toEqual([
      { id: live.eventId, name: 'Draft Night', slug: live.slug, status: 'ready', picks: 0, totalPicks: 15 },
    ]);
    const auto = cutDraft({ balance: true });
    caster(auto.db);
    expect(canCastDraft(auto.db, CASTER, auto.eventId, T0)).toBe(false);
    expect(pickableDrafts(auto.db, CASTER, T0)).toEqual([]);
  });

  it('needs a caster in good standing with the competitive switch open to them', () => {
    const f = liveDraft();
    expect(canCastDraft(f.db, POOL[0]!, f.eventId, T0)).toBe(false);
    caster(f.db);
    f.db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(false);
    expect(pickableDrafts(f.db, CASTER, T0)).toEqual([]);
    f.db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(CASTER);
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(true);
  });

  it('keeps a draft six hours after its teams are published, then drops it', () => {
    const f = startedDraft();
    caster(f.db);
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(T0.toISOString(), f.eventId);
    expect(canCastDraft(f.db, CASTER, f.eventId, new Date(T0.getTime() + 5 * HOUR))).toBe(true);
    expect(canCastDraft(f.db, CASTER, f.eventId, new Date(T0.getTime() + 7 * HOUR))).toBe(false);
    expect(pickableDrafts(f.db, CASTER, new Date(T0.getTime() + 7 * HOUR))).toEqual([]);
  });

  it('drops a cancelled event and an unknown id', () => {
    const f = liveDraft();
    caster(f.db);
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(false);
    expect(canCastDraft(f.db, CASTER, 99_999, T0)).toBe(false);
  });

  it('lists a running room with its pick count', () => {
    const f = startedDraft();
    caster(f.db);
    drive(f, 3);
    expect(pickableDrafts(f.db, CASTER, at(10))).toEqual([expect.objectContaining({ id: f.eventId, status: 'running', picks: 3, totalPicks: 15 })]);
  });
});

describe('the draft view the overlay gets', () => {
  it('is the public room: board, clock, picks, cards for picked players and the best three by SR', () => {
    const f = startedDraft();
    drive(f, 2);
    const v = view(f);
    expect(v).toMatchObject({ eventId: f.eventId, eventName: 'Draft Night', status: 'running', rounds: 3, totalPicks: 15, pickSeconds: 75, poolLeft: 13 });
    expect(v.teams.map((t) => t.captain.steamid)).toEqual(CAPTAINS);
    expect(v.teams[0]!.slots).toEqual([1, 10, 11]);
    expect(v.teams[4]!.slots).toEqual([5, 6, 15]);
    expect(v.picks.map((p) => p.steamid)).toEqual([POOL[0], POOL[1]]);
    expect(v.teams[0]!.players.map((p) => p.steamid)).toEqual([POOL[0]]);
    expect(Object.keys(v.cards).sort()).toEqual([POOL[0]!, POOL[1]!].sort());
    expect(v.onClock).toMatchObject({ pickNo: 3, round: 1, captain: CAPTAINS[2], picker: CAPTAINS[2] });
    expect(v.deadlineAt).not.toBeNull();
    // SR is 1000 + 25 * i, so the best free players are the highest left in the pool.
    expect(v.best.map((c) => c.steamid)).toEqual([POOL[14], POOL[13], POOL[12]]);
  });

  it('carries nothing private: exact keys, no list, note or chemistry', () => {
    const f = liveDraft();
    f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run('secret note 4410', f.eventId, POOL[0]);
    must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, list: [POOL[7]!, POOL[3]!], now: T0 }));
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
    drive(f, 1);
    const v = view(f);
    expect(Object.keys(v).sort()).toEqual([
      'best', 'cards', 'deadlineAt', 'eventId', 'eventName', 'onClock', 'pausedLeftMs', 'pickSeconds', 'picks', 'poolLeft', 'rounds', 'status', 'teams', 'totalPicks',
    ]);
    expect(Object.keys(v.cards[POOL[0]!]!).sort()).toEqual(['avatar', 'bestClass', 'form', 'infected', 'name', 'pugs', 'sr', 'steamid', 'survivor']);
    expect(Object.keys(v.teams[0]!.captain).sort()).toEqual(['avatar', 'name', 'sr', 'steamid']);
    const s = JSON.stringify(v);
    expect(s).not.toContain('secret note 4410');
    expect(s).not.toContain(JSON.stringify([POOL[7], POOL[3]]));
    for (const k of ['"note"', '"notes"', '"lists"', '"list"', '"chemistry"', '"together"', '"me"', '"delegates"', '"skills"', '"trend"']) expect(s).not.toContain(k);
  });

  it('is null for a draft that is not in live mode', () => {
    const auto = cutDraft({ balance: true });
    expect(castDraftView(auto.db, auto.eventId, T0, (s) => playerCard(auto.db, s))).toBeNull();
    const undecided = cutDraft();
    expect(castDraftView(undecided.db, undecided.eventId, T0, (s) => playerCard(undecided.db, s))).toBeNull();
  });

  it('shows a ready room with captains and no pick numbers, and a paused one with its clock frozen', () => {
    const f = liveDraft();
    const ready = view(f, T0);
    expect(ready.status).toBe('ready');
    expect(ready.teams.map((t) => t.captain.steamid)).toEqual(CAPTAINS);
    expect(ready.teams.every((t) => t.slots.length === 0 && t.players.length === 0)).toBe(true);
    expect(ready.onClock).toBeNull();
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(30) }));
    const paused = view(f, at(40));
    expect(paused).toMatchObject({ status: 'paused', deadlineAt: null, pausedLeftMs: 45_000, onClock: null });
  });

  it('memoizes cards per event for a minute', () => {
    const f = liveDraft();
    const cache = makeCardCache(f.db, 60_000);
    const first = cache(f.eventId, 0)(POOL[0]!);
    expect(cache(f.eventId, 59_000)(POOL[0]!)).toBe(first);
    expect(cache(f.eventId, 61_000)(POOL[0]!)).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/castDraft.test.ts`
Expected: FAIL (`canCastDraft` is not exported; `../src/cast/draftView.js` does not exist).

- [ ] **Step 3: Add the access rule to `src/cast/access.ts`**

Add to the imports at the top:

```ts
import { competitiveAccess } from '../teams/access.js';
import { activeSignups } from '../events/drafts.js';
import { livePicks, roomOf } from '../events/draftRoom.js';
import type { DraftStatus } from './types.js';
```

Append to the file:

```ts
/**
 * Live drafts (drafts plan D2b2 Ruling 2): a published draft-kind event with
 * its cut published, in live mode, its teams unpublished or published within
 * RECENT_HOURS. The overlay carries only the public room, so there is no
 * stake rule: a caster who is a captain may follow their own draft.
 */
interface DraftRow { id: number; name: string; slug: string }
function castableDraftRows(db: DB, now: Date, id?: number): DraftRow[] {
  const since = new Date(now.getTime() - RECENT_HOURS * 3_600_000).toISOString();
  return db.prepare(
    `SELECT id, name, slug FROM events
     WHERE entry_kind = 'draft' AND team_mode = 'live' AND cut_at IS NOT NULL
       AND status NOT IN ('draft', 'cancelled')
       AND (teams_made_at IS NULL OR teams_made_at >= ?)
       ${id === undefined ? '' : 'AND id = ?'}
     ORDER BY starts_at, id LIMIT 20`,
  ).all(...(id === undefined ? [since] : [since, id])) as DraftRow[];
}

export function canCastDraft(db: DB, steamid: string, eventId: number, now = new Date()): boolean {
  return mayCast(db, steamid) && competitiveAccess(db, steamid) && castableDraftRows(db, now, eventId).length > 0;
}

export interface PickableDraft { id: number; name: string; slug: string; status: DraftStatus; picks: number; totalPicks: number }

export function pickableDrafts(db: DB, steamid: string, now = new Date()): PickableDraft[] {
  if (!mayCast(db, steamid) || !competitiveAccess(db, steamid)) return [];
  return castableDraftRows(db, now).map((r) => ({
    ...r,
    status: roomOf(db, r.id)?.status ?? 'ready',
    picks: livePicks(db, r.id).length,
    totalPicks: activeSignups(db, r.id).filter((s) => s.role === 'pool').length,
  }));
}
```

- [ ] **Step 4: Create `src/cast/draftView.ts`**

```ts
import type { DB } from '../db.js';
import { currentSeasonId } from '../players.js';
import * as E from '../events/events.js';
import { draftRoomView } from '../events/draftRoomView.js';
import { playerCard, type PlayerCard } from '../events/draftCards.js';
import { ROUNDS, snakeSlots } from '../events/draftRules.js';
import { BEST_AVAILABLE, type CastDraftCard, type CastDraftPlayer, type CastDraftView } from './types.js';

/**
 * The draft as the overlays get it (drafts plan D2b2 Ruling 3). Built from
 * D2b1's room view for the anonymous viewer and then copied field by field,
 * so nothing private can ride along whoever the caster is: no note, no pick
 * list, no chemistry, no fairness, no `me`, `lists`, `notes` or `delegates`,
 * and no SR trend or skill counters (no room on a broadcast card).
 */

/** Ruling 9: D2b1's 60 s card memo, kept here because the room route's is private. */
export const CARD_TTL_MS = 60_000;
export type CardCache = (eventId: number, nowMs: number) => (steamid: string) => PlayerCard;

export function makeCardCache(db: DB, ttlMs = CARD_TTL_MS): CardCache {
  const memo = new Map<number, { at: number; season: number; cards: Map<string, PlayerCard> }>();
  return (eventId, nowMs) => {
    let m = memo.get(eventId);
    if (!m || nowMs - m.at > ttlMs) {
      m = { at: nowMs, season: currentSeasonId(db), cards: new Map() };
      memo.set(eventId, m);
    }
    const { season, cards } = m;
    return (steamid) => {
      let c = cards.get(steamid);
      if (!c) {
        c = playerCard(db, steamid, season);
        cards.set(steamid, c);
      }
      return c;
    };
  };
}

const toPlayer = (c: PlayerCard): CastDraftPlayer => ({ steamid: c.steamid, name: c.name, avatar: c.avatar, sr: c.sr });
const toCard = (c: PlayerCard): CastDraftCard => ({
  ...toPlayer(c),
  pugs: c.pugs,
  form: [...c.form],
  survivor: { siDamage: c.survivor.siDamage, commonKills: c.survivor.commonKills },
  infected: { damageAsSi: c.infected.damageAsSi, dpsLanded: c.infected.dpsLanded },
  bestClass: c.bestClass?.cls ?? null,
});

/** Null unless the event is a published draft with its cut published, in live mode. */
export function castDraftView(db: DB, eventId: number, now: Date, cardOf: (steamid: string) => PlayerCard): CastDraftView | null {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status === 'draft' || ev.entry_kind !== 'draft' || ev.cut_at === null) return null;
  const v = draftRoomView(db, ev, { steamid: null, staff: false }, now, (ids) => ids.map(cardOf));
  if (v.status === 'none') return null;
  // Pick numbers only once the order is fixed at Start (Ruling 8).
  const slots = v.status === 'ready' ? [] : snakeSlots(v.order.map((o) => o.steamid), ROUNDS).filter((s) => s.pickNo <= v.totalPicks);
  return {
    eventId: v.eventId,
    eventName: v.eventName,
    status: v.status,
    deadlineAt: v.deadlineAt,
    pausedLeftMs: v.pausedLeftMs,
    pickSeconds: v.settings.pickSeconds,
    totalPicks: v.totalPicks,
    rounds: ROUNDS,
    onClock: v.onClock ? { pickNo: v.onClock.pickNo, round: v.onClock.round, captain: v.onClock.captain, picker: v.onClock.picker } : null,
    teams: v.teams.map((t) => ({
      captain: toPlayer(cardOf(t.captain.steamid)),
      players: t.players.map((p) => toPlayer(cardOf(p.steamid))),
      slots: slots.filter((s) => s.captain === t.captain.steamid).map((s) => s.pickNo),
    })),
    picks: v.picks.map((p) => ({ pickNo: p.pickNo, round: p.round, captain: p.captain, steamid: p.steamid, name: p.name, auto: p.auto, at: p.at })),
    cards: Object.fromEntries(v.picks.map((p) => [p.steamid, toCard(cardOf(p.steamid))])),
    best: [...v.pool].sort((a, b) => b.sr - a.sr || a.name.localeCompare(b.name)).slice(0, BEST_AVAILABLE).map(toCard),
    poolLeft: v.pool.length,
  };
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/castDraft.test.ts tests/castStudio.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/cast/access.ts src/cast/draftView.ts tests/castDraft.test.ts
git commit -m "A caster may follow a published live draft while the competitive switch lets them in, until six hours after its teams are published, and the overlay's draft view is the public room copied field by field with nothing private in it (plan D2b2)"
```

---

### Task 3: The panel, the save check and the overlay feed

**Files:**
- Modify: `src/routes/castStudio.ts`
- Modify: `src/server.ts:2137`
- Test: `tests/castDraftFeed.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `canCastDraft`, `pickableDrafts`, `castDraftView`, `makeCardCache`; `Hub.subscribe(fn: (event: string) => void): () => void` and `Hub.broadcast(event: string): void` (`src/ws.ts`); D2b1's `DraftClock` already broadcasts `draft:<eventId>` through `hub.broadcast` (`src/server.ts:2100`).
- Produces:
  - `castStudioRoutes(app, opts: { db; config; store; hud?; hub?: Hub; now?: () => number })`.
  - `GET /api/cast/studio` gains `drafts: PickableDraft[]`.
  - `PUT /api/cast/studio` refuses a new unfollowable draft with `403 { error: 'not_castable_draft' }` and clears a stale saved one.
  - `GET /api/overlay/feed` and `GET /api/cast/studio/feed` carry `draft: CastDraftView | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/castDraftFeed.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { castStudioRoutes } from '../src/routes/castStudio.js';
import { Hub } from '../src/ws.js';
import { overlayKey } from '../src/cast/key.js';
import { getStudio } from '../src/cast/studio.js';
import * as DR from '../src/events/draftRoom.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import type { DraftFixture } from './draftFixture.js';
import { ALL, CAPTAINS, POOL, T0, at, drive, liveDraft, must } from './draftRoomFixture.js';

/** Drafts plan D2b2 Rulings 3, 6 and 10; Review Focus 1 and 2. */
const SECRET = 'k'.repeat(32);
const NOTE = 'secret note 5521';
const LIST = [POOL[9]!, POOL[8]!];
/** A captain who is also an admin, a caster and the organizer (Review Focus 1). */
const CASTER = CAPTAINS[0]!;
let f: DraftFixture;
let app: FastifyInstance;
let hub: Hub;
let nowMs: number;

async function setup(): Promise<void> {
  f = liveDraft();
  f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run(NOTE, f.eventId, POOL[4]);
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CASTER, list: LIST, now: T0 }));
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
  drive(f, 1);
  nowMs = at(5).getTime();
  hub = new Hub();
  app = Fastify();
  await app.register(cookie, { secret: SECRET });
  await app.register(castStudioRoutes, {
    db: f.db,
    config: { cookieSecret: SECRET, publicUrl: 'http://localhost', replayDir: mkdtempSync(join(tmpdir(), 'castdraft-')), replayLiveDir: '' },
    store: () => { throw new Error('no community store in this test'); },
    hub,
    now: () => nowMs,
  });
  await app.ready();
  authedCookie(app, f.db, CASTER);
  f.db.prepare('UPDATE players SET is_caster = 1, is_admin = 1 WHERE steamid = ?').run(CASTER);
  f.db.prepare('UPDATE events SET organizer_steamid = ? WHERE id = ?').run(CASTER, f.eventId);
}
afterEach(async () => { await app?.close(); });

const as = (method: 'GET' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: authedCookie(app, f.db, CASTER) });
const feed = () => app.inject({
  method: 'GET', url: `/api/overlay/feed?k=${encodeURIComponent(overlayKey(SECRET, CASTER, getStudio(f.db, CASTER).keyGen))}`,
});
const PRIVATE_KEYS = ['"notes"', '"lists"', '"chemistry"', '"together"', '"me"', '"delegates"', '"avgSr"', '"spread"', '"forecasts"'];

describe('the overlay feed follows a draft', () => {
  it('serves the public room only, even to a caster who is staff, the organizer and a captain', async () => {
    await setup();
    expect((await as('PUT', '/api/cast/studio', { draftEventId: f.eventId, scene: 'draftboard' })).statusCode).toBe(200);
    const res = await feed();
    expect(res.statusCode).toBe(200);
    expect(res.json().draft).toMatchObject({ eventId: f.eventId, status: 'running', totalPicks: 15 });
    expect(res.json().draft.picks).toHaveLength(1);
    for (const body of [res.body, (await as('GET', '/api/cast/studio/feed')).body]) {
      expect(body).not.toContain(NOTE);
      expect(body).not.toContain(JSON.stringify(LIST));
      for (const k of PRIVATE_KEYS) expect(body).not.toContain(k);
    }
  });

  it('lists the draft on the panel and refuses one the caster may not put on air', async () => {
    await setup();
    const panel = (await as('GET', '/api/cast/studio')).json();
    expect(panel.drafts).toEqual([expect.objectContaining({ id: f.eventId, status: 'running', picks: 1, totalPicks: 15 })]);
    expect(JSON.stringify(panel)).not.toContain(NOTE);
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    const r = await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('not_castable_draft');
  });

  it('clears a saved draft that went off air instead of refusing every later save', async () => {
    await setup();
    await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(new Date(nowMs - 7 * 3_600_000).toISOString(), f.eventId);
    expect((await feed()).json().draft).toBeNull();
    const r = await as('PUT', '/api/cast/studio', { ...getStudio(f.db, CASTER).state, title: 'Next show' });
    expect(r.statusCode).toBe(200);
    expect(r.json().studio).toMatchObject({ title: 'Next show', draftEventId: null });
  });

  it('shows a pick on the next read once the room broadcasts, not when the cache runs out', async () => {
    await setup();
    await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    expect((await feed()).json().draft.picks).toHaveLength(1);
    drive(f, 1, 6);
    // The same instant: the 900 ms cache still holds the old answer.
    expect((await feed()).json().draft.picks).toHaveLength(1);
    // Another event's broadcast leaves it alone.
    hub.broadcast(`draft:${f.eventId + 1}`);
    expect((await feed()).json().draft.picks).toHaveLength(1);
    hub.broadcast(`draft:${f.eventId}`);
    expect((await feed()).json().draft.picks).toHaveLength(2);
  });

  it('keeps the match on air when a draft is picked', async () => {
    await setup();
    const r = await as('PUT', '/api/cast/studio', { draftEventId: f.eventId, scene: 'draftclock' });
    expect(r.json().studio).toMatchObject({ draftEventId: f.eventId, matchId: null, scene: 'draftclock' });
    expect((await feed()).json().match).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/castDraftFeed.test.ts`
Expected: FAIL (`draft` is null in the feed, `drafts` is undefined on the panel, the cancelled draft is saved with 200).

- [ ] **Step 3: Wire the draft into `src/routes/castStudio.ts`**

Imports: add `canCastDraft, pickableDrafts` to the `'../cast/access.js'` import, and add:

```ts
import { castDraftView, makeCardCache } from '../cast/draftView.js';
import type { Hub } from '../ws.js';
```

In the `opts` type, after `hud?: LiveHudStore;`:

```ts
    /** Room broadcasts: draft:<eventId> drops the cached feed of every studio
     *  following that draft, so the next poll is fresh (drafts plan D2b2 Ruling 6). */
    hub?: Hub;
    /** The feed's clock; tests pin it. */
    now?: () => number;
```

After `const hud = opts.hud ?? liveHudStore;`:

```ts
  const clockNow = opts.now ?? Date.now;
  const cards = makeCardCache(db);
  const unsubscribe = opts.hub?.subscribe((event) => {
    const m = /^draft:(\d+)$/.exec(event);
    if (!m) return;
    const id = Number(m[1]);
    for (const [k, v] of cache) if (v.feed.studio.draftEventId === id) cache.delete(k);
  });
  if (unsubscribe) app.addHook('onClose', async () => { unsubscribe(); });
```

Change `function feedFor(steamid: string, nowMs = Date.now()): OverlayFeed {` to `function feedFor(steamid: string, nowMs = clockNow()): OverlayFeed {`, and right before `const feed: OverlayFeed = {` add:

```ts
    // The draft the studio follows, asked again on every build (Ruling 2):
    // the public view only (Ruling 3).
    const draftId = studio.state.draftEventId;
    const nowDate = new Date(nowMs);
    const draft = draftId !== null && canCastDraft(db, steamid, draftId, nowDate) ? castDraftView(db, draftId, nowDate, cards(draftId, nowMs)) : null;
```

and in the literal replace Task 1's `draft: null,` with `draft,`.

In `panel(steamid)`, after `bookings: pickableBookings(db, steamid),` add:

```ts
      drafts: pickableDrafts(db, steamid, new Date(clockNow())),
```

In `app.put('/api/cast/studio', ...)`, replace

```ts
    next.callout = getStudio(db, me).state.callout;
```

with

```ts
    const prev = getStudio(db, me).state;
    if (next.draftEventId !== null && !canCastDraft(db, me, next.draftEventId, new Date(clockNow()))) {
      // Ruling 10: a newly chosen draft is refused; one that went off air
      // while saved is dropped, or every later save would be refused too.
      if (next.draftEventId !== prev.draftEventId) return reply.code(403).send({ error: 'not_castable_draft' });
      next.draftEventId = null;
    }
    next.callout = prev.callout;
```

(The comment above the old line, "A save never touches the callout ...", stays where it is.)

- [ ] **Step 4: Pass the hub in `src/server.ts`**

Replace

```ts
  await app.register(castStudioRoutes, { db: deps.db, config: deps.config, store: getCommunityStore });
```

with

```ts
  await app.register(castStudioRoutes, { db: deps.db, config: deps.config, store: getCommunityStore, hub });
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/castDraftFeed.test.ts tests/castDraft.test.ts tests/castStudio.test.ts tests/draftRoomPrivacy.test.ts tests/draftRoomRoutes.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/castStudio.ts src/server.ts tests/castDraftFeed.test.ts
git commit -m "The studio panel lists the live drafts a caster may follow and refuses one they may not, a saved draft that went off air is cleared on the next save, the overlay feed carries the public draft view, and a room broadcast refreshes it on the next poll (plan D2b2)"
```

---

### Task 4: The pick reveal queue

**Files:**
- Create: `web/src/overlay/draftReveal.ts`
- Test: `web/src/overlay/draftReveal.test.ts` (new)

**Interfaces:**
- Consumes: `CastDraftPick`, `CastDraftView` (Task 1).
- Produces:
  ```ts
  export const DRAFT_REVEAL_MS = 7000;
  export const REVEAL_STALE_MS = 20_000;
  export interface DraftReveal { pick: CastDraftPick; key: string; until: number }
  export interface RevealQueue { eventId: number | null; seen: ReadonlySet<string>; pending: CastDraftPick[]; showing: DraftReveal | null }
  export function emptyReveal(): RevealQueue;
  export function revealKey(p: CastDraftPick): string;
  export function stepReveal(q: RevealQueue, draft: CastDraftView | null, now: number): RevealQueue;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// web/src/overlay/draftReveal.test.ts
import { describe, it, expect } from 'vitest';
import { DRAFT_REVEAL_MS, REVEAL_STALE_MS, emptyReveal, revealKey, stepReveal } from './draftReveal';
import type { CastDraftPick, CastDraftView } from '../../../src/cast/types';

/** Drafts plan D2b2 Ruling 5; Review Focus 3, 4 and 5. */
const T = Date.parse('2026-10-08T20:00:00.000Z');
const pick = (pickNo: number, steamid: string, atMs: number): CastDraftPick => ({
  pickNo, round: 1, captain: 'c1', steamid, name: `n${steamid}`, auto: false, at: new Date(atMs).toISOString(),
});
const draft = (picks: CastDraftPick[], eventId = 4): CastDraftView => ({
  eventId, eventName: 'Draft Night', status: 'running', deadlineAt: null, pausedLeftMs: null, pickSeconds: 75, totalPicks: 15, rounds: 3,
  onClock: null, teams: [], picks, cards: {}, best: [], poolLeft: 15 - picks.length,
});

describe('pick reveal queue', () => {
  it('treats what is there on the first feed as history (an overlay loading mid-draft)', () => {
    const q = stepReveal(emptyReveal(), draft([pick(1, 'a', T - 1000), pick(2, 'b', T - 500)]), T);
    expect(q.showing).toBeNull();
    expect(q.pending).toEqual([]);
  });

  it('reveals a new pick for DRAFT_REVEAL_MS, then clears', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const p = pick(1, 'a', T + 500);
    q = stepReveal(q, draft([p]), T + 1000);
    expect(q.showing?.key).toBe(revealKey(p));
    q = stepReveal(q, draft([p]), T + 1000 + DRAFT_REVEAL_MS - 1);
    expect(q.showing?.key).toBe(revealKey(p));
    q = stepReveal(q, draft([p]), T + 1000 + DRAFT_REVEAL_MS);
    expect(q.showing).toBeNull();
  });

  it('shows two picks that land in one feed one after the other (the forced final pick)', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(14, 'a', T + 200);
    const b = pick(15, 'b', T + 200);
    q = stepReveal(q, draft([a, b]), T + 1000);
    expect(q.showing?.pick.steamid).toBe('a');
    q = stepReveal(q, draft([a, b]), T + 1000 + DRAFT_REVEAL_MS);
    expect(q.showing?.pick.steamid).toBe('b');
    q = stepReveal(q, draft([a, b]), T + 1000 + 2 * DRAFT_REVEAL_MS);
    expect(q.showing).toBeNull();
  });

  it('drops a revealed pick that staff undo, and reveals the slot again when it is re-picked', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(3, 'a', T + 100);
    q = stepReveal(q, draft([a]), T + 1000);
    expect(q.showing?.pick.steamid).toBe('a');
    q = stepReveal(q, draft([]), T + 2000);
    expect(q.showing).toBeNull();
    const again = pick(3, 'z', T + 9000);
    q = stepReveal(q, draft([again]), T + 9500);
    expect(q.showing?.pick.steamid).toBe('z');
  });

  it('drops a queued pick that is undone before its turn', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(5, 'a', T + 100);
    const b = pick(6, 'b', T + 200);
    q = stepReveal(q, draft([a, b]), T + 1000);
    q = stepReveal(q, draft([a]), T + 2000);
    expect(q.pending).toEqual([]);
  });

  it('never replays a backlog older than REVEAL_STALE_MS (an overlay OBS throttled)', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const fresh = pick(3, 'c', T + REVEAL_STALE_MS + 5000);
    q = stepReveal(q, draft([pick(1, 'a', T + 100), pick(2, 'b', T + 200), fresh]), T + REVEAL_STALE_MS + 6000);
    expect(q.showing?.pick.steamid).toBe('c');
    expect(q.pending).toEqual([]);
  });

  it('starts over on another draft, its picks history', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    q = stepReveal(q, draft([pick(1, 'a', T + 100)], 9), T + 1000);
    expect(q.showing).toBeNull();
  });

  it('shows nothing with no draft on air', () => {
    expect(stepReveal(emptyReveal(), null, T).showing).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web web/src/overlay/draftReveal.test.ts`
Expected: FAIL (cannot resolve `./draftReveal`).

- [ ] **Step 3: Create `web/src/overlay/draftReveal.ts`**

```ts
import type { CastDraftPick, CastDraftView } from '../../../src/cast/types';

/**
 * The pick reveal (drafts plan D2b2 Ruling 5): each overlay's own queue,
 * like auto callouts (callouts.ts), so every OBS source agrees. Pure: the
 * overlay steps it on every render with the feed's draft and its
 * skew-corrected clock.
 */

export const DRAFT_REVEAL_MS = 7000;
/** A queued pick this old (by its server time) is skipped, not replayed. */
export const REVEAL_STALE_MS = 20_000;

export interface DraftReveal { pick: CastDraftPick; key: string; until: number }
export interface RevealQueue {
  /** The draft this queue follows; another draft starts a fresh queue. */
  eventId: number | null;
  /** Keys of the live picks already taken in. */
  seen: ReadonlySet<string>;
  pending: CastDraftPick[];
  showing: DraftReveal | null;
}

export const emptyReveal = (): RevealQueue => ({ eventId: null, seen: new Set(), pending: [], showing: null });

/** The same slot picked again after an undo is a new pick. */
export const revealKey = (p: CastDraftPick): string => `${p.pickNo}:${p.at}:${p.steamid}`;

export function stepReveal(q: RevealQueue, draft: CastDraftView | null, now: number): RevealQueue {
  const eventId = draft?.eventId ?? null;
  const picks = draft?.picks ?? [];
  const live = new Set(picks.map(revealKey));
  // The first feed of a draft (or another draft): what is there is history.
  if (eventId !== q.eventId) return { eventId, seen: live, pending: [], showing: null };
  const fresh = picks.filter((p) => !q.seen.has(revealKey(p)));
  // An undone pick leaves the queue and the screen at once (Review Focus 3).
  let pending = [...q.pending, ...fresh].filter((p) => live.has(revealKey(p)) && now - Date.parse(p.at) <= REVEAL_STALE_MS);
  let showing = q.showing && live.has(q.showing.key) && now < q.showing.until ? q.showing : null;
  if (!showing && pending.length > 0) {
    const [next, ...rest] = pending;
    showing = { pick: next!, key: revealKey(next!), until: now + DRAFT_REVEAL_MS };
    pending = rest;
  }
  return { eventId, seen: live, pending, showing };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project web web/src/overlay/draftReveal.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/draftReveal.ts web/src/overlay/draftReveal.test.ts
git commit -m "Each overlay queues a pick reveal for every new pick for seven seconds in pick order, treating the picks it first sees as history, skipping a stale backlog and dropping a pick that staff undo (plan D2b2)"
```

---

### Task 5: The draft scenes on the overlay

**Files:**
- Create: `web/src/overlay/pieces.tsx`
- Create: `web/src/overlay/DraftScenes.tsx`
- Modify: `web/src/overlay/Scenes.tsx`
- Modify: `web/src/overlay/overlay.css`
- Modify: `web/src/overlay/sample.ts`
- Test: `web/src/overlay/DraftScenes.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's shapes and `DRAFT_SCENES`; Task 4's `emptyReveal`, `stepReveal`, `DraftReveal`.
- Produces:
  ```ts
  // web/src/overlay/pieces.tsx (moved unchanged from Scenes.tsx, now exported)
  export function Backdrop(p: { art?: string }): JSX.Element;
  export function fmtClock(ms: number): string;
  export function Countdown(p: { to: string | null; now: number; label: string }): JSX.Element;
  export function Title(p: { studio: StudioState; fallback: string }): JSX.Element;
  // web/src/overlay/DraftScenes.tsx
  export const DRAFT_TEAM_COLORS: readonly string[];
  export function draftClockMs(d: CastDraftView, now: number): number | null;
  export function draftStatusLine(d: CastDraftView, leftMs: number | null): string;
  export function DraftBoard(p: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }): JSX.Element;
  export function OnTheClock(p: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }): JSX.Element;
  export function DraftRevealCard(p: { draft: CastDraftView; reveal: DraftReveal }): JSX.Element;
  export function DraftRevealStrip(p: { draft: CastDraftView; reveal: DraftReveal }): JSX.Element;
  // web/src/overlay/sample.ts
  export function sampleDraft(now: number): CastDraftView;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/overlay/DraftScenes.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Overlay } from './Scenes';
import { sampleDraft } from './sample';
import { defaultStudioState, type CastDraftView, type OverlayFeed, type StudioState } from '../../../src/cast/types';

/** Drafts plan D2b2 Rulings 4, 7, 8 and 12. sampleDraft: five teams
 *  (Captain One to Captain Five), seven picks, pick 8 (round 2) on the clock
 *  for Captain Three with 42 s left, best available Player 8, 9 and 10. */
const N = Date.parse('2026-10-08T20:00:00.000Z');
const feedWith = (draft: CastDraftView | null, patch: Partial<StudioState> = {}): OverlayFeed => ({
  rev: 1, serverNow: N, studio: { ...defaultStudioState(), ...patch }, match: null, live: null, tankRecap: null, witchRecap: null, casterAvatars: [], draft,
});
/** sampleDraft with pick 8 made at N + 500. */
function withPick8(d: CastDraftView): CastDraftView {
  const p = d.best[0]!;
  return {
    ...d,
    picks: [...d.picks, { pickNo: 8, round: 2, captain: d.onClock!.captain, steamid: p.steamid, name: p.name, auto: false, at: new Date(N + 500).toISOString() }],
    cards: { ...d.cards, [p.steamid]: p },
  };
}

describe('draft board', () => {
  it('shows every team, captains on top, picks filled in and the pick on the clock', () => {
    const { container } = render(<Overlay which="draftboard" feed={feedWith(sampleDraft(N))} now={N} />);
    const t = container.textContent ?? '';
    for (const s of ['Captain One', 'Captain Three', 'Captain Five', 'Player 1', 'Player 7']) expect(t).toContain(s);
    expect(container.querySelectorAll('.ov-dboard__team')).toHaveLength(5);
    const up = container.querySelectorAll('.ov-dboard__slot.is-up');
    expect(up).toHaveLength(1);
    expect(up[0]!.textContent).toContain('#8');
    expect(up[0]!.textContent).toContain('On the clock');
    expect(container.querySelector('.ov-dboard__foot')?.textContent).toBe('Pick 8 of 15 · Round 2 · 00:42');
    // Pick 5 was an auto pick.
    expect(t).toContain('Auto');
  });

  it('shows the studio title and nothing else with no draft on air', () => {
    const { container } = render(<Overlay which="draftboard" feed={feedWith(null)} now={N} />);
    expect(container.querySelector('.ov-dboard')).toBeNull();
    expect(container.textContent).toContain('Draft board');
  });
});

describe('on the clock', () => {
  it('shows the captain up, a countdown from the server deadline, their team so far and the best three by SR', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftclock" feed={feedWith(d)} now={N} />);
    const t = container.textContent ?? '';
    expect(container.querySelector('.ov-dclock__name')?.textContent).toBe('Captain Three');
    expect(container.querySelector('.ov-dclock__clock')?.textContent).toBe('00:42');
    expect(t).toContain('Pick 8 of 15 · Round 2');
    expect([...container.querySelectorAll('.ov-dclock__team li')].map((li) => li.querySelector('.ov-dclock__tname')?.textContent)).toEqual(['Captain Three', 'Player 3']);
    expect([...container.querySelectorAll('.ov-dmini__name')].map((e) => e.textContent)).toEqual(['Player 8', 'Player 9', 'Player 10']);
    rerender(<Overlay which="draftclock" feed={feedWith(d)} now={N + 40_000} />);
    const clock = container.querySelector('.ov-dclock__clock');
    expect(clock?.textContent).toBe('00:02');
    expect(clock?.classList.contains('is-low')).toBe(true);
  });

  it('freezes the clock while paused', () => {
    const paused: CastDraftView = { ...sampleDraft(N), status: 'paused', deadlineAt: null, pausedLeftMs: 31_000, onClock: null };
    for (const now of [N, N + 20_000]) {
      const { container, unmount } = render(<Overlay which="draftclock" feed={feedWith(paused)} now={now} />);
      expect(container.textContent).toContain('Paused · 00:31 left on the clock');
      unmount();
    }
  });

  it('names a delegate who picks for the team', () => {
    const d = sampleDraft(N);
    const delegate = d.teams[2]!.players[0]!.steamid;
    const { container } = render(<Overlay which="draftclock" feed={feedWith({ ...d, onClock: { ...d.onClock!, picker: delegate } })} now={N} />);
    expect(container.textContent).toContain('Player 3 picks for the team');
  });
});

describe('pick reveal', () => {
  it('reveals a new pick with a card on the draft scenes, never one already made', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftboard" feed={feedWith(d)} now={N} />);
    expect(container.querySelector('.ov-dreveal')).toBeNull();
    rerender(<Overlay which="draftboard" feed={feedWith(withPick8(d))} now={N + 1000} />);
    const card = container.querySelector('.ov-dreveal');
    expect(card?.textContent).toContain('Player 8');
    expect(card?.textContent).toContain('Pick 8 · Round 2');
    expect(card?.textContent).toContain("to Captain Three's team");
    expect(container.querySelector('.ov-dstrip')).toBeNull();
  });

  it('lays the strip over another scene on Program unless the producer turned it off', () => {
    const d = sampleDraft(N);
    for (const draftStrip of [true, false]) {
      const { container, rerender, unmount } = render(<Overlay which="program" feed={feedWith(d, { scene: 'casters', draftStrip })} now={N} />);
      rerender(<Overlay which="program" feed={feedWith(withPick8(d), { scene: 'casters', draftStrip })} now={N + 1000} />);
      const strip = container.querySelector('.ov-dstrip');
      if (draftStrip) expect(strip?.textContent).toContain('Player 8');
      else expect(strip).toBeNull();
      unmount();
    }
  });

  it('shows the strip on the Pick reveal layer link', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftreveal" feed={feedWith(d)} now={N} />);
    expect(container.querySelector('.ov-dstrip')).toBeNull();
    rerender(<Overlay which="draftreveal" feed={feedWith(withPick8(d))} now={N + 1000} />);
    expect(container.querySelector('.ov-dstrip')?.textContent).toContain("to Captain Three's team");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web web/src/overlay/DraftScenes.test.tsx`
Expected: FAIL (`sampleDraft` is not exported).

- [ ] **Step 3: Move the shared pieces to `web/src/overlay/pieces.tsx`**

Cut these four functions out of `web/src/overlay/Scenes.tsx` (with their doc comments) and paste them into the new file, each now `export`ed and otherwise unchanged:

```tsx
import type { StudioState } from '../../../src/cast/types';

/**
 * Pieces every overlay scene file shares (moved unchanged out of Scenes.tsx
 * for the draft scenes, drafts plan D2b2 Ruling 13).
 */

/** The full-frame backdrop: page black, grain, the campaign's tint and a
 *  survivor or infected still, darkened. */
export function Backdrop({ art = 'survivor-hilltop' }: { art?: string }) {
  return (
    <div class="ov-bg" aria-hidden="true">
      <div class="ov-bg__art" style={{ backgroundImage: `url(/hud-backdrops/${art}.jpg)` }} />
      <div class="ov-bg__tint" />
      <div class="ov-bg__grain" />
    </div>
  );
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function Countdown({ to, now, label }: { to: string | null; now: number; label: string }) {
  if (!to) return <p class="ov-count ov-count--idle">{label}</p>;
  const left = Date.parse(to) - now;
  return (
    <div class="ov-count">
      <span class="ov-count__label">{left > 0 ? label : 'Any moment now'}</span>
      {left > 0 && <span class="ov-count__clock">{fmtClock(left)}</span>}
    </div>
  );
}

export function Title({ studio, fallback }: { studio: StudioState; fallback: string }) {
  return (
    <header class="ov-title">
      <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
      <h1 class="ov-title__main">{fallback}</h1>
      {studio.subtitle && <p class="ov-title__sub">{studio.subtitle}</p>}
    </header>
  );
}
```

In `Scenes.tsx`, add `import { Backdrop, Countdown, Title } from './pieces';` under the existing imports (`fmtClock` is used only inside `Countdown`).

- [ ] **Step 4: Create `web/src/overlay/DraftScenes.tsx`**

```tsx
import { Backdrop, Countdown, Title, fmtClock } from './pieces';
import type { DraftReveal } from './draftReveal';
import type { CastDraftCard, CastDraftPlayer, CastDraftView, StudioState } from '../../../src/cast/types';

/**
 * The live draft scenes (drafts plan D2b2 Rulings 4, 7 and 8): the board,
 * on the clock, and the pick reveal as a big card (over the two draft
 * scenes) or a lower-third strip (the Pick reveal layer, and Program over
 * other scenes). Everything here is the public room (CastDraftView).
 */

/** One colour per team in round 1 order (Ruling 8). */
export const DRAFT_TEAM_COLORS: readonly string[] = ['#5b8fd9', '#d9913f', '#6fbf73', '#c76fd1', '#d9cf4f', '#4fc9d9', '#d95f7a', '#9a8f80'];
const CLASS_NAME = { hunter: 'Hunter', smoker: 'Smoker', boomer: 'Boomer', tank: 'Tank' } as const;
/** The last seconds of a pick turn the clock to the accent colour. */
const LOW_MS = 10_000;

const colorOf = (i: number): string => DRAFT_TEAM_COLORS[Math.max(0, i) % DRAFT_TEAM_COLORS.length]!;
const teamIndex = (d: CastDraftView, captain: string): number => d.teams.findIndex((t) => t.captain.steamid === captain);
const teamVar = (i: number) => ({ '--c': colorOf(i) } as Record<string, string>);

function nameIn(d: CastDraftView, steamid: string): string {
  for (const t of d.teams) {
    if (t.captain.steamid === steamid) return t.captain.name;
    const p = t.players.find((x) => x.steamid === steamid);
    if (p) return p.name;
  }
  return steamid;
}

/** Time left on the pick clock: the stored deadline against the overlay's
 *  server-synced now, or the frozen time left while paused. */
export function draftClockMs(d: CastDraftView, now: number): number | null {
  if (d.status === 'running' && d.deadlineAt) return Math.max(0, Date.parse(d.deadlineAt) - now);
  if (d.status === 'paused' && d.pausedLeftMs !== null) return d.pausedLeftMs;
  return null;
}

export function draftStatusLine(d: CastDraftView, leftMs: number | null): string {
  switch (d.status) {
    case 'ready': return 'The draft starts soon';
    case 'paused': return `Paused${leftMs !== null ? ` · ${fmtClock(leftMs)} left on the clock` : ''}`;
    case 'done': return 'Draft complete';
    case 'running': return d.onClock ? `Pick ${d.onClock.pickNo} of ${d.totalPicks} · Round ${d.onClock.round} · ${fmtClock(leftMs ?? 0)}` : 'Picking';
  }
}

function Face({ p, size }: { p: CastDraftPlayer; size: number }) {
  const box = { width: `${size}px`, height: `${size}px` };
  return p.avatar
    ? <img class="ov-dface" style={box} src={p.avatar} alt="" referrerpolicy="no-referrer" />
    : <span class="ov-dface ov-dface--none" style={{ ...box, fontSize: `${Math.round(size * 0.42)}px` }}>{[...p.name][0]?.toUpperCase() ?? '?'}</span>;
}

function Form({ form }: { form: CastDraftCard['form'] }) {
  return <span class="ov-dform">{form.slice(0, 5).map((r, i) => <i key={i} class={`ov-dform__r ov-dform__r--${r}`}>{r}</i>)}</span>;
}

export function DraftBoard({ studio, draft, now, reveal }: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }) {
  if (!draft) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Draft board" /></div>;
  const up = draft.status === 'running' ? draft.onClock : null;
  const left = draftClockMs(draft, now);
  const dense = draft.teams.length > 5;
  return (
    <div class="ov-full">
      <Backdrop art="survivor-hilltop" />
      <Title studio={studio} fallback={draft.eventName} />
      <div class={`ov-dboard${dense ? ' ov-dboard--dense' : ''}`} style={{ '--n': String(Math.max(1, draft.teams.length)) } as Record<string, string>}>
        {draft.teams.map((t, i) => (
          <section key={t.captain.steamid} class={`ov-dboard__team${up?.captain === t.captain.steamid ? ' is-up' : ''}`} style={{ ...teamVar(i), animationDelay: `${i * 70}ms` } as Record<string, string>}>
            <header class="ov-dboard__cap">
              <Face p={t.captain} size={72} />
              <span class="ov-dboard__capname">{t.captain.name}</span>
              <span class="ov-dboard__sr">{`Captain · ${t.captain.sr} SR`}</span>
            </header>
            {Array.from({ length: draft.rounds }, (_, r) => {
              const p = t.players[r];
              const pickNo = t.slots[r];
              const isUp = !p && up !== null && pickNo === up.pickNo;
              const auto = p ? draft.picks.find((x) => x.steamid === p.steamid)?.auto === true : false;
              return (
                <div key={r} class={`ov-dboard__slot${p ? ' is-filled' : ''}${isUp ? ' is-up' : ''}`}>
                  <span class="ov-dboard__no">{pickNo ? `#${pickNo}` : `R${r + 1}`}</span>
                  {p ? (
                    <>
                      <Face p={p} size={52} />
                      <span class="ov-dboard__name">{p.name}</span>
                      <span class="ov-dboard__sr">{`${p.sr} SR${auto ? ' · Auto' : ''}`}</span>
                    </>
                  ) : <span class="ov-dboard__open">{isUp ? 'On the clock' : 'Open'}</span>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <p class="ov-dboard__foot">{draftStatusLine(draft, left)}</p>
      {reveal && <DraftRevealCard draft={draft} reveal={reveal} />}
    </div>
  );
}

function MiniCard({ card }: { card: CastDraftCard }) {
  return (
    <div class="ov-dmini">
      <Face p={card} size={56} />
      <div class="ov-dmini__body">
        <span class="ov-dmini__name">{card.name}</span>
        <span class="ov-dmini__line">{`${card.sr} SR · ${card.pugs} PUGs${card.bestClass ? ` · ${CLASS_NAME[card.bestClass]}` : ''}`}</span>
      </div>
      <Form form={card.form} />
    </div>
  );
}

export function OnTheClock({ studio, draft, now, reveal }: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }) {
  if (!draft) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="On the clock" /></div>;
  const up = draft.status === 'running' ? draft.onClock : null;
  const left = draftClockMs(draft, now);
  const ti = up ? teamIndex(draft, up.captain) : -1;
  const team = ti >= 0 ? draft.teams[ti]! : null;
  return (
    <div class="ov-full">
      <Backdrop art="infected-hunter" />
      <Title studio={studio} fallback={draft.eventName} />
      {team && up ? (
        <div class="ov-dclock" style={teamVar(ti)}>
          <section class="ov-dclock__who">
            <p class="ov-dclock__eyebrow">On the clock</p>
            <Face p={team.captain} size={200} />
            <h2 class="ov-stencil ov-dclock__name">{team.captain.name}</h2>
            {up.picker !== up.captain && <p class="ov-dclock__picker">{`${nameIn(draft, up.picker)} picks for the team`}</p>}
            <p class="ov-dclock__pick">{`Pick ${up.pickNo} of ${draft.totalPicks} · Round ${up.round}`}</p>
          </section>
          <section class="ov-dclock__time">
            <span class={`ov-dclock__clock${left !== null && left <= LOW_MS ? ' is-low' : ''}`} aria-label="Time left">{fmtClock(left ?? 0)}</span>
            <div class="ov-dclock__team">
              <p class="ov-dclock__label">Team so far</p>
              <ul>
                {[team.captain, ...team.players].map((p) => <li key={p.steamid}><Face p={p} size={44} /><span class="ov-dclock__tname">{p.name}</span><b>{p.sr}</b></li>)}
              </ul>
            </div>
          </section>
          <section class="ov-dclock__best">
            <p class="ov-dclock__label">Best available by SR</p>
            {draft.best.map((c) => <MiniCard key={c.steamid} card={c} />)}
          </section>
        </div>
      ) : (
        <div class="ov-dclock ov-dclock--idle">
          <p class="ov-stencil ov-dclock__idle">{draftStatusLine(draft, left)}</p>
          {draft.status === 'ready' && studio.countdownTo && <Countdown to={studio.countdownTo} now={now} label="Draft starts in" />}
        </div>
      )}
      {reveal && <DraftRevealCard draft={draft} reveal={reveal} />}
    </div>
  );
}

export function DraftRevealCard({ draft, reveal }: { draft: CastDraftView; reveal: DraftReveal }) {
  const p = reveal.pick;
  const card = draft.cards[p.steamid];
  return (
    <div class="ov-dreveal" key={reveal.key} style={teamVar(teamIndex(draft, p.captain))} role="status">
      <p class="ov-dreveal__pick">{`Pick ${p.pickNo} · Round ${p.round}${p.auto ? ' · Auto pick' : ''}`}</p>
      {card && <Face p={card} size={180} />}
      <h2 class="ov-stencil ov-dreveal__name">{p.name}</h2>
      <p class="ov-dreveal__to">{`to ${nameIn(draft, p.captain)}'s team`}</p>
      {card && (
        <dl class="ov-dreveal__stats">
          <div><dt>SR</dt><dd>{card.sr}</dd></div>
          <div><dt>PUGs</dt><dd>{card.pugs}</dd></div>
          <div><dt>SI dmg a game</dt><dd>{card.survivor.siDamage}</dd></div>
          {/* Not upper-cased: "DPS" reads as damage per second. */}
          <div><dt class="ov-keepcase">DPs a game</dt><dd>{card.infected.dpsLanded}</dd></div>
          {card.bestClass && <div><dt>Best class</dt><dd>{CLASS_NAME[card.bestClass]}</dd></div>}
        </dl>
      )}
      {card && <Form form={card.form} />}
    </div>
  );
}

export function DraftRevealStrip({ draft, reveal }: { draft: CastDraftView; reveal: DraftReveal }) {
  const p = reveal.pick;
  const card = draft.cards[p.steamid];
  return (
    <div class="ov-dstrip" key={reveal.key} style={teamVar(teamIndex(draft, p.captain))} role="status">
      <span class="ov-dstrip__pick">{`Pick ${p.pickNo}`}</span>
      {card && <Face p={card} size={64} />}
      <span class="ov-dstrip__name">{p.name}</span>
      <span class="ov-dstrip__to">{`to ${nameIn(draft, p.captain)}'s team${p.auto ? ' (auto pick)' : ''}`}</span>
      {card && <span class="ov-dstrip__sr">{`${card.sr} SR`}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Wire the scenes into `web/src/overlay/Scenes.tsx`**

Add imports:

```ts
import { DraftBoard, DraftRevealStrip, OnTheClock } from './DraftScenes';
import { emptyReveal, stepReveal, type DraftReveal } from './draftReveal';
```

and add `DRAFT_SCENES` and `type CastDraftView` to the existing `'../../../src/cast/types'` import.

In `Overlay`, after `const auto = useAutoCallout(studio, match, now);` add:

```ts
  const reveal = useDraftReveal(feed.draft ?? null, now);
```

change `<SceneBody scene={scene} feed={feed} now={now} auto={auto} />` to `<SceneBody scene={scene} feed={feed} now={now} auto={auto} reveal={reveal} />`, and after the `LowerThird` line add:

```tsx
      {which === 'program' && studio.draftStrip && feed.draft && reveal && !(DRAFT_SCENES as readonly string[]).includes(scene) && (
        <DraftRevealStrip draft={feed.draft} reveal={reveal} />
      )}
```

After `useAutoCallout`, add:

```ts
/** The pick reveal (drafts plan D2b2 Ruling 5): this overlay's own queue,
 *  held above the scene like auto-fire so a cut keeps its place. */
function useDraftReveal(draft: CastDraftView | null, now: number): DraftReveal | null {
  const q = useRef(emptyReveal());
  q.current = stepReveal(q.current, draft, now);
  return q.current.showing;
}
```

Change `SceneBody`'s signature to

```ts
function SceneBody({ scene, feed, now, auto, reveal }: { scene: OverlayKey; feed: OverlayFeed; now: number; auto: AutoCard | null; reveal: DraftReveal | null }) {
```

and add, before `case 'program': return null;`:

```tsx
    case 'draftboard': return <DraftBoard studio={studio} draft={feed.draft ?? null} now={now} reveal={reveal} />;
    case 'draftclock': return <OnTheClock studio={studio} draft={feed.draft ?? null} now={now} reveal={reveal} />;
    case 'draftreveal': return feed.draft && reveal ? <DraftRevealStrip draft={feed.draft} reveal={reveal} /> : null;
```

(`feed.draft ?? null` keeps an overlay page that outlived a deploy working against a feed without the field.)

- [ ] **Step 6: The sample draft in `web/src/overlay/sample.ts`**

Add `CastDraftCard, CastDraftPick, CastDraftPlayer, CastDraftView` to its type import, change `draft: null` in `sampleFeed`'s return to `draft: sampleDraft(now)`, and append:

```ts
/** A made-up draft for the panel's preview (drafts plan D2b2 Ruling 12):
 *  five teams, seven picks, pick 8 on the clock for Captain Three with 42 s
 *  left. Pick times are fixed, so the preview never fires a reveal. */
export function sampleDraft(now: number): CastDraftView {
  const card = (i: number, name: string, sr: number): CastDraftCard => ({
    steamid: `0000000000000${String(900 + i)}`, name, avatar: null, sr, pugs: 20 + i, form: ['W', 'L', 'W', 'W', 'L'],
    survivor: { siDamage: 640 + i * 10, commonKills: 88 }, infected: { damageAsSi: 180 + i * 4, dpsLanded: 0.6 }, bestClass: 'hunter',
  });
  const strip = (c: CastDraftCard): CastDraftPlayer => ({ steamid: c.steamid, name: c.name, avatar: c.avatar, sr: c.sr });
  const caps = ['Captain One', 'Captain Two', 'Captain Three', 'Captain Four', 'Captain Five'].map((n, i) => card(i, n, 1500 - i * 40));
  const pool = Array.from({ length: 15 }, (_, i) => card(10 + i, `Player ${i + 1}`, 1460 - i * 22));
  const taken = 7;
  // Snake over five teams: round 1 to teams 0..4, round 2 back from 4 to 0.
  const picks: CastDraftPick[] = pool.slice(0, taken).map((p, k) => ({
    pickNo: k + 1, round: k < 5 ? 1 : 2, captain: caps[k < 5 ? k : 9 - k]!.steamid, steamid: p.steamid, name: p.name,
    auto: k === 4, at: `2026-01-01T00:00:0${k}.000Z`,
  }));
  return {
    eventId: 0, eventName: 'Sample draft', status: 'running', deadlineAt: new Date(now + 42_000).toISOString(), pausedLeftMs: null,
    pickSeconds: 75, totalPicks: 15, rounds: 3,
    onClock: { pickNo: 8, round: 2, captain: caps[2]!.steamid, picker: caps[2]!.steamid },
    teams: caps.map((c, ti) => ({
      captain: strip(c),
      players: picks.filter((p) => p.captain === c.steamid).map((p) => strip(pool.find((x) => x.steamid === p.steamid)!)),
      slots: [ti + 1, 10 - ti, 11 + ti],
    })),
    picks,
    cards: Object.fromEntries(pool.slice(0, taken).map((c) => [c.steamid, c])),
    best: pool.slice(taken, taken + 3),
    poolLeft: 15 - taken,
  };
}
```

- [ ] **Step 7: The CSS, appended to `web/src/overlay/overlay.css`**

```css
/* ---------- live draft (drafts plan D2b2) ---------- */
.ov-dface { display: block; flex: none; border-radius: 50%; object-fit: cover; border: 3px solid var(--c, var(--accent)); background: var(--panel-2); }
.ov-dface--none { display: flex; align-items: center; justify-content: center; font-family: var(--font-display); color: var(--bone); }

.ov-dboard { position: absolute; left: 120px; right: 120px; top: 300px; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 18px; }
.ov-dboard__team { display: flex; flex-direction: column; gap: 10px; min-width: 0; animation: ov-rise 500ms cubic-bezier(.2,.7,.2,1) both; }
.ov-dboard__cap { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 14px; align-items: center; padding: 14px 16px; background: var(--panel); border-top: 6px solid var(--c); }
.ov-dboard__cap .ov-dface { grid-row: 1 / 3; }
.ov-dboard__capname { font: 400 34px var(--font-display); text-transform: uppercase; color: var(--bone); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dboard__sr { font: 500 18px var(--font-label); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); white-space: nowrap; }
.ov-dboard__slot { display: grid; grid-template-columns: 56px auto minmax(0, 1fr); column-gap: 12px; align-items: center; min-height: 104px; padding: 12px 16px; background: var(--panel-2); border-left: 4px solid transparent; }
.ov-dboard__slot.is-filled { border-left-color: var(--c); }
.ov-dboard__slot.is-up { border-left-color: var(--accent); box-shadow: inset 0 0 0 3px var(--accent); animation: ov-breathe 1.4s ease-in-out infinite; }
.ov-dboard__no { grid-row: 1 / 3; font: 400 30px var(--font-display); color: var(--text-muted); }
.ov-dboard__slot .ov-dface { grid-row: 1 / 3; }
.ov-dboard__slot .ov-dboard__name, .ov-dboard__slot .ov-dboard__sr { grid-column: 3; }
.ov-dboard__name { font: 600 26px var(--font-body); color: var(--bone); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dboard__open { grid-column: 2 / 4; grid-row: 1 / 3; font: 500 22px var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
.ov-dboard__slot.is-up .ov-dboard__open { color: var(--accent); }
.ov-dboard--dense .ov-dboard__slot .ov-dface { display: none; }
.ov-dboard--dense .ov-dboard__slot .ov-dboard__name, .ov-dboard--dense .ov-dboard__slot .ov-dboard__sr { grid-column: 2 / 4; }
.ov-dboard__foot { position: absolute; left: 120px; right: 120px; bottom: 70px; padding: 14px 24px; background: var(--panel); border-top: 3px solid var(--accent); font: 500 30px var(--font-label); letter-spacing: 0.06em; text-transform: uppercase; color: var(--bone); }

.ov-dclock { position: absolute; left: 120px; right: 120px; top: 290px; bottom: 90px; display: grid; grid-template-columns: 560px minmax(0, 1fr) 520px; gap: 36px; }
.ov-dclock--idle { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; }
.ov-dclock__idle { font-size: 110px; text-align: center; }
.ov-dclock__who { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; padding: 28px; min-width: 0; background: var(--panel); border-top: 8px solid var(--c); animation: ov-rise 500ms cubic-bezier(.2,.7,.2,1) both; }
.ov-dclock__eyebrow, .ov-dclock__label { font: 500 22px var(--font-label); letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent); }
.ov-dclock__name { font-size: 84px; color: var(--bone); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dclock__picker, .ov-dclock__pick { font: 400 26px var(--font-body); color: var(--text); }
.ov-dclock__time { display: flex; flex-direction: column; align-items: center; gap: 28px; min-width: 0; }
.ov-dclock__clock { font: 400 260px var(--stencil); line-height: 0.9; color: var(--bone); font-variant-numeric: tabular-nums; text-shadow: 0 8px 40px rgba(0,0,0,0.7); }
.ov-dclock__clock.is-low { color: var(--accent); animation: ov-breathe 0.8s ease-in-out infinite; }
.ov-dclock__team { align-self: stretch; padding: 18px 22px; background: var(--panel); }
.ov-dclock__team ul { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ov-dclock__team li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; font: 500 24px var(--font-body); color: var(--bone); }
.ov-dclock__tname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dclock__team li b { font: 400 24px var(--font-display); color: var(--text-muted); }
.ov-dclock__best { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.ov-dmini { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; align-items: center; padding: 14px 18px; background: var(--panel); border-left: 4px solid var(--accent); animation: ov-rise 500ms cubic-bezier(.2,.7,.2,1) both; }
.ov-dmini__body { display: flex; flex-direction: column; min-width: 0; }
.ov-dmini__name { font: 600 28px var(--font-body); color: var(--bone); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dmini__line { font: 400 20px var(--font-body); color: var(--text-muted); }
.ov-dmini .ov-dform { grid-column: 1 / 3; }
.ov-dform { display: flex; gap: 6px; }
.ov-dform__r { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font: normal 600 16px var(--font-label); background: var(--panel-2); color: var(--text-muted); }
.ov-dform__r--W { background: #2f6b3a; color: #e9f5ea; }
.ov-dform__r--L { background: #7a2a24; color: #f6e5e3; }

@keyframes ov-reveal { from { opacity: 0; transform: translate(-50%, -46%) scale(0.94); } to { opacity: 1; transform: translate(-50%, -50%); } }
.ov-dreveal {
  position: absolute; left: 50%; top: 50%; width: 820px; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 40px 48px 36px; text-align: center;
  background: var(--panel); border-top: 10px solid var(--c);
  box-shadow: 0 0 0 9999px rgba(0,0,0,0.55), 0 24px 80px rgba(0,0,0,0.7);
  animation: ov-reveal 600ms cubic-bezier(.2,.7,.2,1) both;
}
.ov-dreveal__pick { font: 500 24px var(--font-label); letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent); }
.ov-dreveal__name { font-size: 104px; color: var(--bone); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-dreveal__to { font: 400 30px var(--font-body); color: var(--text); }
.ov-dreveal__stats { display: flex; gap: 34px; margin: 8px 0 4px; }
.ov-dreveal__stats div { display: flex; flex-direction: column; align-items: center; }
.ov-dreveal__stats dt { font: 500 16px var(--font-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
.ov-dreveal__stats dt.ov-keepcase { text-transform: none; }
.ov-dreveal__stats dd { font: 400 40px var(--font-display); color: var(--bone); }

.ov-dstrip {
  position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); max-width: 1500px;
  display: flex; align-items: center; gap: 18px; padding: 12px 28px 12px 0; white-space: nowrap;
  background: var(--panel); border-left: 8px solid var(--c); box-shadow: 0 14px 40px rgba(0,0,0,0.5);
  animation: ov-wipe 500ms cubic-bezier(.2,.7,.2,1) both;
}
.ov-dstrip__pick { align-self: stretch; display: flex; align-items: center; margin: -12px 0; padding: 0 22px; background: var(--c); color: #0b0908; font: 400 30px var(--font-display); text-transform: uppercase; }
.ov-dstrip__name { font: 400 40px var(--font-display); text-transform: uppercase; color: var(--bone); }
.ov-dstrip__to { font: 400 24px var(--font-body); color: var(--text); }
.ov-dstrip__sr { font: 500 22px var(--font-label); letter-spacing: 0.08em; color: var(--text-muted); }
```

`.ov .ov-keepcase` (overlay.css line 584) is outweighed by `.ov-dreveal__stats dt`, which is why the card carries its own `dt.ov-keepcase` rule.

- [ ] **Step 8: Run the tests and the typecheck**

Run: `npx vitest run --project web web/src/overlay && npm run typecheck`
Expected: PASS (the existing `Scenes.test.tsx` and `callouts.test.ts` unchanged, plus `DraftScenes.test.tsx` and `draftReveal.test.ts`); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/overlay/pieces.tsx web/src/overlay/DraftScenes.tsx web/src/overlay/DraftScenes.test.tsx web/src/overlay/Scenes.tsx web/src/overlay/overlay.css web/src/overlay/sample.ts
git commit -m "The overlay draws the draft board and the on-the-clock scene with a server-synced countdown, the best three available and the team so far, reveals each new pick with a card on the draft scenes and a strip on the Pick reveal layer and over other Program scenes, and the panel preview has a sample draft (plan D2b2)"
```

---

### Task 6: The Draft on air box in the studio panel

**Files:**
- Modify: `web/src/api.ts` (the caster studio block, around line 1826)
- Modify: `web/src/routes/CastStudio.tsx`
- Test: `web/src/routes/CastStudio.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /api/cast/studio` `drafts` (Task 3), `StudioState.draftEventId` and `draftStrip` (Task 1), `sampleDraft` via `sampleFeed` (Task 5).
- Produces:
  ```ts
  // web/src/api.ts
  export interface StudioPickDraft { id: number; name: string; slug: string; status: 'ready' | 'running' | 'paused' | 'done'; picks: number; totalPicks: number }
  // StudioPanel gains: drafts: StudioPickDraft[];
  // web/src/routes/CastStudio.tsx
  export function DraftOnAir(p: { drafts: StudioPickDraft[]; state: StudioState; update: (fn: (s: StudioState) => StudioState, now?: boolean) => void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/routes/CastStudio.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { DraftOnAir } from './CastStudio';
import { defaultStudioState, type StudioState } from '../../../src/cast/types';
import type { StudioPickDraft } from '../api';

/** Drafts plan D2b2 Rulings 1 and 4. */
const drafts: StudioPickDraft[] = [{ id: 4, name: 'Draft Night', slug: 'draft-night', status: 'running', picks: 7, totalPicks: 15 }];

describe('studio: draft on air', () => {
  it('lists followable drafts and toggles one on and off, leaving the match alone', () => {
    let state: StudioState = { ...defaultStudioState(), matchId: 9 };
    const update = vi.fn((fn: (s: StudioState) => StudioState) => { state = fn(state); });
    const { getByRole, rerender } = render(<DraftOnAir drafts={drafts} state={state} update={update} />);
    const button = () => getByRole('button', { name: /Draft Night/ });
    expect(button().textContent).toContain('7 of 15 picks');
    fireEvent.click(button());
    expect(state).toMatchObject({ draftEventId: 4, matchId: 9 });
    rerender(<DraftOnAir drafts={drafts} state={state} update={update} />);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button());
    expect(state.draftEventId).toBeNull();
    expect(state.matchId).toBe(9);
  });

  it('says how a draft gets here when there is none, and turns the strip off', () => {
    let state = defaultStudioState();
    const update = vi.fn((fn: (s: StudioState) => StudioState) => { state = fn(state); });
    const { getByText, getByRole } = render(<DraftOnAir drafts={[]} state={state} update={update} />);
    expect(getByText(/No live draft to follow/)).toBeTruthy();
    fireEvent.change(getByRole('checkbox'), { target: { checked: false } });
    expect(state.draftStrip).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web web/src/routes/CastStudio.test.tsx`
Expected: FAIL (`DraftOnAir` is not exported).

- [ ] **Step 3: The panel type in `web/src/api.ts`**

After `export interface StudioPickBooking { ... }` add:

```ts
/** A live draft the caster may follow (drafts plan D2b2, src/cast/access.ts pickableDrafts). */
export interface StudioPickDraft {
  id: number; name: string; slug: string; status: 'ready' | 'running' | 'paused' | 'done'; picks: number; totalPicks: number;
}
```

and in `interface StudioPanel`, after `bookings: StudioPickBooking[];` add `drafts: StudioPickDraft[];`.

- [ ] **Step 4: The box in `web/src/routes/CastStudio.tsx`**

Add `type StudioPickDraft` to the `'../api'` import.

In `flush`, replace the `setError(...)` call with:

```ts
      setError(e instanceof ApiError && e.message === 'not_castable' ? 'You cannot put that match on air any more.'
        : e instanceof ApiError && e.message === 'not_castable_draft' ? 'You cannot put that draft on air any more.'
        : 'Could not save. Check your connection.');
```

In the page body, right after `<OnAir panel={panel} state={state} update={update} onAirId={match?.id ?? state.matchId} connects={connects} />`, add:

```tsx
          <DraftOnAir drafts={panel.drafts ?? []} state={state} update={update} />
```

After the `OnAir` function (before the `/* ---------- scenes ---------- */` comment), add:

```tsx
const DRAFT_STATUS_LABEL: Record<StudioPickDraft['status'], string> = { ready: 'Not started', running: 'Picking', paused: 'Paused', done: 'Done' };
const DRAFT_STATUS_CLASS: Record<StudioPickDraft['status'], string> = { ready: 'configuring', running: 'live', paused: 'configuring', done: 'completed' };

/** The live draft the overlays follow (drafts plan D2b2 Ruling 1): separate
 *  from the match on air, so a show can cut between the two. */
export function DraftOnAir({ drafts, state, update }: { drafts: StudioPickDraft[]; state: StudioState; update: Update }) {
  const pick = (id: number | null) => update((s) => ({ ...s, draftEventId: id }), true);
  return (
    <section class="panel">
      <h3>Draft on air</h3>
      {drafts.length === 0 ? (
        <p class="muted">No live draft to follow. A draft shows here once its cut is published and staff choose Let captains pick.</p>
      ) : (
        <div class="studio__picks">
          {drafts.map((d) => {
            const on = state.draftEventId === d.id;
            return (
              <button key={d.id} type="button" class={`studio__pick${on ? ' is-on' : ''}`} onClick={() => pick(on ? null : d.id)} aria-pressed={on}>
                <span class="studio__pick-head">
                  <b>{d.name}</b>
                  <span class={`studio__state studio__state--${DRAFT_STATUS_CLASS[d.status]}`}>{DRAFT_STATUS_LABEL[d.status]}</span>
                </span>
                <span class="studio__pick-teams"><span>{`${d.picks} of ${d.totalPicks} picks`}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <label class="studio__toggle studio__toggle--small">
        <input type="checkbox" checked={state.draftStrip}
          onChange={(e) => { const v = e.currentTarget.checked; update((s) => ({ ...s, draftStrip: v }), true); }} />
        <span>Announce each pick with a strip over the other scenes (Program link)</span>
      </label>
      <p class="muted studio__hint">Cut to Draft board (B) or On the clock (C). Each new pick is revealed with a card on those two scenes by itself.</p>
    </section>
  );
}
```

`Update` is the file's existing `type Update = (fn: (s: StudioState) => StudioState, now?: boolean) => void;`, declared below the page component; a type alias is usable anywhere in the module.

In `PreviewFrame`, change

```ts
  const sample = !feed?.match;
```

to

```ts
  // Ruling 12: the sample only when neither a match nor a draft is on air.
  const sample = !feed?.match && !feed?.draft;
```

and the label `<span class="studio__sample">Sample: no match on air</span>` to `<span class="studio__sample">Sample: nothing on air</span>`. In the page's preview hint, change the `match ?` condition to `match || feed?.draft ?` so a draft on air is not described as a sample:

```tsx
              {match || feed?.draft ? 'What the Program overlay shows right now. Transparent parts show as checkerboard.'
                : 'Nothing is on air, so this is a made-up sample match. OBS shows nothing on the gameplay scene until you pick a match.'}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run --project web web/src/routes/CastStudio.test.tsx web/src/routes/Cast.test.tsx web/src/overlay && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/routes/CastStudio.tsx web/src/routes/CastStudio.test.tsx
git commit -m "The caster studio has a Draft on air box that follows a live draft separately from the match, with a switch for the Program pick strip, and the preview shows the real draft once one is on air (plan D2b2)"
```

---

### Task 7: Everything together, and a scratch walk with screenshots

**Files:**
- No tracked file changes.
- Scratch only (never committed): `$S/seed-d2b2.ts`, `$S/room-d2b2.ts`, `$S/shoot-overlay.mjs`, `$S/d2b2.sqlite`, `$S/caster.jar`, `$S/shots-d2b2/`, where `$S` is your session's scratchpad directory and `$WT` is `/home/volence/l4d/pug/.claude/worktrees/drafts-2b2`.

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Run everything**

Run: `npm test` and `npm run typecheck`
Expected: only the 7 known `tests/skeetStreakPoster.test.ts` failures; typecheck clean. Also `grep -rnP '[\x{2013}\x{2014}]' src web/src tests docs/superpowers/plans/2026-10-08-drafts-2b2-caster-draft-scenes.md` finds nothing, and `git diff --stat drafts-2b -- src/events src/routes/draftRoom.ts web/src/routes/EventDraft.tsx web/src/routes/event` is empty (no D2b1 file touched).

- [ ] **Step 2: Seed a paused live draft**

Never against `data/pug.db`, `/home/volence/l4d1-ds` or a live box. Write `$S/seed-d2b2.ts` (replace `$WT` with the worktree path):

```ts
// $S/seed-d2b2.ts: a live draft with seven picks, paused, and a caster.
//   npx tsx $S/seed-d2b2.ts $S/d2b2.sqlite
import { openDb } from '$WT/src/db.js';
import { activatePlayer, upsertPlayer } from '$WT/src/players.js';
import * as E from '$WT/src/events/events.js';
import * as D from '$WT/src/events/drafts.js';
import * as DR from '$WT/src/events/draftRoom.js';
import { givePugs, rate } from '$WT/tests/draftFixture.js';
import { stageBody } from '$WT/tests/eventFixture.js';

const db = openDb(process.argv[2]!);
const ADMIN = '76561198000000900';
const CASTER = '76561198000000950';
const P = Array.from({ length: 20 }, (_, i) => `765611980000010${String(i).padStart(2, '0')}`);
const NAMES = ['Ash', 'Bea', 'Cole', 'Dax', 'Eli', 'Fen', 'Gia', 'Hux', 'Ivy', 'Jax', 'Kai', 'Lux', 'Mo', 'Nia', 'Oz', 'Pia', 'Quin', 'Rex', 'Sol', 'Tia'];
const ALL = () => true;
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
upsertPlayer(db, { steamid: ADMIN, name: 'walk admin', avatar: null }, [ADMIN]);
upsertPlayer(db, { steamid: CASTER, name: 'walk caster', avatar: null }, []);
activatePlayer(db, CASTER);
db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(CASTER);
P.forEach((s, i) => {
  upsertPlayer(db, { steamid: s, name: NAMES[i]!, avatar: null }, []);
  activatePlayer(db, s);
  db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`walk${i}`, s);
  givePugs(db, s, 6);
  rate(db, s, 1000 + 30 * i);
});
const now = new Date();
const h = (n: number) => new Date(now.getTime() + n * 3_600_000).toISOString();
const ev = must(E.createEvent(db, { by: ADMIN, now, fields: { name: 'Friday Draft', startsAt: h(72), entryKind: 'draft', draft: { signupsCloseAt: h(1), draftAt: h(2) } } }));
must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, { advanceCount: null }), now }));
must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now }));
must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now }));
P.forEach((s, i) => must(D.signUp(db, { eventId: ev.id, steamid: s, captainPref: 'willing', note: i % 4 === 0 ? 'prefer infected' : null, now: new Date(now.getTime() + i) })));
must(D.closeSignups(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.pickCaptains(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.publishCut(db, { eventId: ev.id, actor: ADMIN, now }));
must(D.chooseTeamMode(db, { eventId: ev.id, mode: 'live', actor: ADMIN, now }));
must(D.setRoomSettings(db, { eventId: ev.id, settings: { firstPick: 'lowest_sr', pickSeconds: 300 }, actor: ADMIN, now }));
must(DR.startRoom(db, { eventId: ev.id, actor: ADMIN, now, present: ALL }));
for (let k = 0; k < 7; k++) {
  const st = DR.roomState(db, ev.id)!;
  const free = st.available;
  must(DR.makePick(db, { eventId: ev.id, steamid: st.picker!, player: free[k % 2 === 0 ? free.length - 1 : 0]!.steamid, pickNo: st.next!.pickNo, now: new Date(now.getTime() + k * 1000), present: ALL }));
}
// Paused, so the server's tick cannot run the clock out before the walk starts.
must(DR.pauseRoom(db, { eventId: ev.id, actor: ADMIN, now: new Date(now.getTime() + 8000) }));
console.log(JSON.stringify({ slug: ev.slug, id: ev.id, caster: CASTER }));
```

and `$S/room-d2b2.ts`, which drives the room from outside the server (the overlay polls, so it sees the change within a second or two):

```ts
// $S/room-d2b2.ts: npx tsx $S/room-d2b2.ts $S/d2b2.sqlite <eventId> resume|pause|pick
import { openDb } from '$WT/src/db.js';
import * as DR from '$WT/src/events/draftRoom.js';

const [file, id, cmd] = process.argv.slice(2);
const db = openDb(file!);
const eventId = Number(id);
const ADMIN = '76561198000000900';
const now = new Date();
const out = cmd === 'resume' ? DR.resumeRoom(db, { eventId, actor: ADMIN, now })
  : cmd === 'pause' ? DR.pauseRoom(db, { eventId, actor: ADMIN, now })
  : (() => {
    const st = DR.roomState(db, eventId)!;
    // Present for everyone, so the next pick gets the full 300 s clock.
    return DR.makePick(db, { eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: st.next!.pickNo, now, present: () => true });
  })();
console.log(cmd, JSON.stringify(out));
```

Run: `npx tsx $S/seed-d2b2.ts $S/d2b2.sqlite`
Expected: one JSON line with `slug`, `id` and `caster`. Note the id.

- [ ] **Step 3: Start the API and the web, and put the draft on air**

Check `ss -ltnu | grep -E ':(8094|5194|27594)\b'` first and pick other ports if any is taken (other sessions run dev servers). In the background:

- `DEV_MODE=1 DB_PATH=$S/d2b2.sqlite PORT=8094 LOG_LISTEN_PORT=27594 npx tsx src/index.ts`
- `API_PORT=8094 npx vite --port 5194 --strictPort`

Then:

```bash
curl -s -c $S/caster.jar -H 'content-type: application/json' -d '{"steamid":"76561198000000950"}' localhost:8094/api/dev/login
KEY=$(curl -s -b $S/caster.jar localhost:8094/api/cast/studio | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
curl -s -b $S/caster.jar localhost:8094/api/cast/studio | python3 -c 'import json,sys; print(json.load(sys.stdin)["drafts"])'
curl -s -b $S/caster.jar -X PUT -H 'content-type: application/json' -d "{\"draftEventId\":<id>,\"scene\":\"draftboard\",\"title\":\"Riverside PUGs\",\"subtitle\":\"Friday draft night\"}" localhost:8094/api/cast/studio
curl -s "localhost:8094/api/overlay/feed?k=$KEY" | python3 -c 'import json,sys; d=json.load(sys.stdin)["draft"]; print(d["status"], len(d["picks"]), sorted(d))'
```

Expected: `drafts` lists Friday Draft as `paused` with 7 of 15 picks; the feed prints `paused 7` and the fourteen whitelisted keys (no `notes`, `lists`, `me`).

- [ ] **Step 4: Shoot each scene at 1920x1080**

Write `$S/shoot-overlay.mjs` (the CDP pattern of `scripts/shoot-pages.mjs`, one viewport, transparent page over a dark grey):

```js
// $S/shoot-overlay.mjs: node $S/shoot-overlay.mjs <base> <key> <outdir> [strip]
// Env: ROOM is the command prefix for $S/room-d2b2.ts (resume, pause, pick appended).
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [BASE, KEY, OUT, MODE = 'all'] = process.argv.slice(2);
const ROOM = process.env.ROOM;
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('google-chrome-stable', ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/shoot-overlay-profile', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws; let id = 0; const pending = new Map();
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
    pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  });
}
const room = (cmd) => execSync(`${ROOM} ${cmd}`, { stdio: 'inherit' });
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const page = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m); };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 40, g: 44, b: 52, a: 1 } });
  mkdirSync(OUT, { recursive: true });
  const open = async (scene) => { await send('Page.navigate', { url: `${BASE}/overlay/${scene}?k=${encodeURIComponent(KEY)}` }); await sleep(3000); };
  const shoot = async (name) => {
    const probe = await send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify({ refused: !!document.querySelector(".ov-refused"), w: document.documentElement.scrollWidth })' });
    const { refused, w } = JSON.parse(probe.result.value);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
    console.log(`${OUT}/${name}.png${refused ? ' REFUSED' : ''}${w > 1920 ? ' HORIZONTAL OVERFLOW' : ''}`);
  };
  // A reveal fires only for a pick that lands while the page is open.
  if (MODE === 'strip') {
    await open('program'); room('pick'); await sleep(2500); await shoot('program-casters-strip');
  } else {
    await open('draftclock'); await shoot('clock-paused');
    room('resume');
    await open('draftboard'); await shoot('board');
    await open('draftclock'); await shoot('clock-running');
    await open('program'); room('pick'); await sleep(2500); await shoot('program-board-reveal');
    await open('draftreveal'); room('pick'); await sleep(2500); await shoot('layer-strip');
  }
} finally {
  chrome.kill();
}
```

Run: `ROOM="npx tsx $S/room-d2b2.ts $S/d2b2.sqlite <id>" node $S/shoot-overlay.mjs http://localhost:5194 "$KEY" $S/shots-d2b2`
Expected: five PNG paths printed, none with `REFUSED` or `HORIZONTAL OVERFLOW`.

Then put the studio on the casters scene and shoot the Program strip over it:

```bash
curl -s -b $S/caster.jar -X PUT -H 'content-type: application/json' -d "{\"draftEventId\":<id>,\"scene\":\"casters\",\"casters\":[{\"name\":\"Walk Caster\"}]}" localhost:8094/api/cast/studio
```

and run `ROOM="npx tsx $S/room-d2b2.ts $S/d2b2.sqlite <id>" node $S/shoot-overlay.mjs http://localhost:5194 "$KEY" $S/shots-d2b2 strip`. Expected: one more PNG path, `program-casters-strip.png`.

- [ ] **Step 5: Look at every screenshot**

Open each PNG in `$S/shots-d2b2` and check:
- `board.png`: five columns between x 120 and 1800, captains on top with SR, seven filled slots with pick numbers, the slot on the clock outlined, no "Auto" mark (the seed made no auto pick), the status line along the bottom, nothing cut off at the right.
- `clock-paused.png`: "Paused · MM:SS left on the clock" centred, no countdown running.
- `clock-running.png`: captain left, a big countdown near 05:00 in the middle with the team below it, three "Best available by SR" cards on the right.
- `program-board-reveal.png`: the board dimmed behind a centred reveal card with the new pick's name, "to <captain>'s team", SR, PUGs and form.
- `layer-strip.png` and `program-casters-strip.png`: the strip at the bottom centre, above nothing else of the overlay and clear of the lower-third slot.

Record in the task report what each shot showed and anything that looked wrong. Fix real layout faults in `overlay.css` (and rerun Steps 1 and 4) before reporting.

- [ ] **Step 6: Clean up**

Stop both background processes. Delete nothing outside `$S`. Commit nothing from this task (no tracked file changed); if Step 5 led to a CSS fix, commit it:

```bash
git add web/src/overlay/overlay.css
git commit -m "The draft scenes' layout is adjusted after a walk with screenshots at 1920x1080 (plan D2b2)"
```

List the screenshot paths in the task report.

---

## Self-review

1. **Spec coverage.** Spec section 4 "draft scenes: pick reveal, board, on-the-clock": Tasks 1 (keys, hotkeys, OBS collection), 5 (the scenes and both reveal forms), 6 (panel). "chemistry and captains' lists are never sent to viewers": Task 2 (whitelist test) and Task 3 (route privacy test with a staff, organizer and captain caster). The brief's items: studio follows a draft (Task 1 state, Task 3 save rules, Task 6 picker), public feed only with the hub event and a poll fallback (Tasks 2 and 3, Ruling 6), OBS export (Task 1), tests for feed privacy, state cleaning, scene rendering and a 1920x1080 walk (Tasks 1 to 7).
2. **Placeholder scan.** Every code step carries its code; the scratch scripts are complete. `$S` and `$WT` are named paths, `<id>` is printed by the seed.
3. **Type consistency.** `CastDraftView`, `CastDraftCard`, `CastDraftPick`, `CastDraftPlayer`, `CastDraftTeam`, `DraftStatus`, `BEST_AVAILABLE` (Task 1) are the names Tasks 2, 4, 5 and 6 use. `canCastDraft(db, steamid, eventId, now?)`, `pickableDrafts(db, steamid, now?)`, `castDraftView(db, eventId, now, cardOf)`, `makeCardCache(db, ttlMs?)` match between Tasks 2 and 3. `stepReveal(q, draft, now)`, `emptyReveal()`, `DraftReveal` match between Tasks 4 and 5. `StudioPickDraft` matches `PickableDraft`'s fields. D2b1 signatures consumed (`draftRoomView`, `roomOf`, `livePicks`, `activeSignups`, `playerCard`, `snakeSlots`, `ROUNDS`, `startRoom`, `makePick`, `pauseRoom`, `resumeRoom`, `savePickList`, `setRoomSettings`) were read from the drafts-2b source.
4. **Review Focus.** Each of the five lines has its test: 1 and 2 in Task 3, 3, 4 and 5 in Task 4.
