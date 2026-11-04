# Stream Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can add OBS browser-source widgets (live match, rating, session, last match, queue) that update on their own, set up from their profile.

**Architecture:** One public JSON endpoint `GET /api/widget/:steamid` assembles everything a widget needs from existing public sources (`profileData`, `getLiveMatches`, `publicQueue`). A second Vite page `web/widget.html`, served at `/widget/<steamid>/<kind>`, polls it and renders one widget in one preset style on a transparent background, coloured by the current season's tokens. A "Stream widgets" section on the player's own profile builds the URL with a live preview.

**Tech Stack:** Fastify + better-sqlite3 (src/), Preact + Vite (web/), vitest + @testing-library/preact.

**Spec:** `docs/superpowers/specs/2026-11-04-stream-widgets-design.md`

## Global Constraints

- No login, no key on widget URLs. Every value served must already be public on the site.
- The live widget never shows anything the public /live view does not (`getLiveMatches`, `visibility = 'public'`), and nothing newer than `DEFAULT_DELAY_MS` (`src/replayTail.ts`, 10 s).
- Last match, session and today's change use exactly the matches `profileData(db, steamid, null)` returns (completed PUGs of the current season) and its `srDelta` per match.
- The streamer's team: listed first, accent colour (`var(--accent)`), tagged with the streamer's name. Accent never means "winning"; the leader gets a separate marker.
- Colours come from the season tokens (`web/src/styles/tokens.css`, `[data-season]`); no hard-coded accent. Losses and the infected team stay red.
- Presets only: styles `bar | card | corner | board`; sizes `s | m | l`. No layout editor, no custom colours.
- User-facing copy: no em dashes, no emojis.
- Shared checkout: commit only the files you touched (`git add <paths>`), never `git commit -a`.

## Review Focus

1. Streamer is in the server but not on either roster (sub without a row, spectator, caster): live section is `null`, widget hidden. Test in Task 2.
2. First half just ended (< 10 s ago), never ended, or `reliable = false`: no half-time score. Test in Task 1.
3. Player still placing (`sr === null`): rating card says "Placing 3/5", never "0 SR" or "NaN". Test in Task 4.
4. Fetch fails or OBS hides the source for minutes: last good data stays on screen, polling resumes on its own. Test in Task 3.
5. Unknown or banned steamid, or a bad `kind` in the URL: the page renders nothing visible (transparent), no error text on stream. Tests in Tasks 2 and 3.

---

### Task 1: Half-time score on the public live payload

**Files:**
- Modify: `src/liveView.ts` (`LiveMatch` interface ~line 93, `getLiveMatches` ~line 940)
- Modify: `web/src/api.ts` (only if it mirrors `LiveMatch` by hand rather than importing it)
- Test: `tests/liveView.test.ts`

**Interfaces:**
- Produces: `LiveMatch.halfTime: { ordinal: number; survTeam: 'a' | 'b'; score: number } | null`. It is the first half of the map in progress (`ordinal === maps.length`), shown only when that `match_rounds` row has `half = 1`, `ended_at` set, `reliable = 1`, and `ended_at <= now - DEFAULT_DELAY_MS`. `teamAScore`/`teamBScore` are unchanged (finished maps only).

- [ ] **Step 1: Write the failing tests** in `tests/liveView.test.ts`, reusing that file's match/round setup helpers:
  - `halfTime shows the first half of the map in progress once it is older than the delay`: two maps in `match_live_maps`, a round row `ordinal 2, half 1, surv_team 'a', score 438, reliable 1, ended_at` = 60 s ago. Expect `halfTime` to equal `{ ordinal: 2, survTeam: 'a', score: 438 }` and `teamAScore` unchanged.
  - `halfTime is null within the delay`: same with `ended_at` = 3 s ago. Expect `null`.
  - `halfTime is null for an unreliable or unfinished half`: `reliable 0`, then `ended_at NULL`. Expect `null` both times.
  - `halfTime is null once the second half has also ended`: does not double-count after `MAP_RESULT` (the map now has a `match_live_maps` row, so `ordinal !== maps.length`).
- [ ] **Step 2: Run** `npx vitest run tests/liveView.test.ts`. Expected: the 4 new tests FAIL.
- [ ] **Step 3: Implement** `function halfTimeFor(db: DB, matchId: number, mapsDone: number, now: number): LiveMatch['halfTime']` in `src/liveView.ts` and set `halfTime` in `getLiveMatches`. Parse `ended_at` with the file's `sqliteToMs`.
- [ ] **Step 4: Run** `npx vitest run tests/liveView.test.ts tests/matchVisibilityLive.test.ts tests/liveBoard.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/liveView.ts tests/liveView.test.ts [web/src/api.ts] && git commit -m "Live: first-half score of the map in progress, after the live delay"`

### Task 2: Widget payload and endpoint

**Files:**
- Create: `src/widgets.ts`
- Modify: `src/routes/stats.ts` (register the route beside `/api/players/:steamid`)
- Test: `tests/widgets.test.ts`

**Interfaces:**
- Consumes: `profileData` (`src/playerQueries.ts`), `leaderboardData`, `getLiveMatches` + `LiveMatch.halfTime` (Task 1), `currentSeasonLook` (`src/seasonThemes.ts`), `inGoodStanding`, `matchmaker.publicQueue()`.
- Produces (exported from `src/widgets.ts`, imported by web as a type):

```ts
export const WIDGET_KINDS = ['live', 'rating', 'session', 'last', 'queue'] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];
export const RECENT_FINAL_MS = 5 * 60_000;

export interface WidgetLiveTeam { side: 'a' | 'b'; names: string[]; score: number; mine: boolean }
export interface WidgetLive {
  matchId: number; campaign: string; currentMap: string | null;
  mapsPlayed: number;                 // finished maps
  mapsTotal: number | null;           // maps in the campaign plan, null if unknown
  mine: WidgetLiveTeam; theirs: WidgetLiveTeam;   // totals include halfTime
  maps: { ordinal: number; map: string; mine: number; theirs: number }[];
  halfTime: { ordinal: number; mineSurvived: boolean; score: number } | null;
  final: boolean;                     // true during the 5 min hold after the match ended
}
export interface WidgetRating {
  sr: number | null; rank: string | null;           // "Gold II"
  placing: { played: number; of: number } | null;
  position: number | null;                         // leaderboard place, current season
  wins: number; losses: number; todayDelta: number;
}
export interface WidgetSession { since: number; srDelta: number; wins: number; losses: number }
export interface WidgetLastMatch {
  matchId: number; campaign: string; endedAt: string; result: 'win' | 'loss' | 'draw';
  mine: number; theirs: number; srDelta: number | null;
  stats: { siDamage: number; skeets: number; commons: number };
}
export interface WidgetPayload {
  serverNow: number; theme: string | null;
  player: { steamid: string; name: string };
  live: WidgetLive | null; rating: WidgetRating | null; session: WidgetSession | null;
  last: WidgetLastMatch | null; queue: { count: number; size: number; inQueue: boolean } | null;
}
export function widgetData(db: DB, steamid: string, opts: { tzOffsetMin: number; since: number | null; now?: number }): WidgetPayload | null;
```

  Route: `GET /api/widget/:steamid?tz=<minutes east of UTC>&since=<ms>` returns `WidgetPayload` with `Cache-Control: no-store`, or 404 `{ error: 'no such player' }` when `widgetData` is null. The route adds `queue` from `matchmaker.publicQueue()` (`inQueue` = steamid in `players`; `size` = the lobby size the queue page uses).

  Rules `widgetData` must follow:
  - Returns null for an unknown player or one not `inGoodStanding`.
  - `live`: the `getLiveMatches(db)` entry whose `teamA`/`teamB` contains the steamid. If none, the most recent `matches` row with `state = 'completed'`, `visibility = 'public'`, `ended_at` within `RECENT_FINAL_MS`, the player in `match_players`, built from `match_live_maps` + `matches.team_*_score` with `final: true`. Not on either roster → `null`.
  - `rating`, `last`, `session`, `todayDelta`: from `profileData(db, steamid, null)`. `rating.rank` = `season.rank?.name ?? null`. `position` = 1-based place among `leaderboardData(db).rows` that have an SR, in the order the board shows them (check the leaderboard page sorts the same way), else null. Today = `endedAt` ≥ local midnight from `tzOffsetMin`. Session = `endedAt` ≥ `since`; `session` is null when `since` is null. `tz` outside ±840 or `since` in the future or non-numeric are treated as 0 / null.
  - `last.stats`: `siDamage` + `commons` from the match's `match_players` row, `skeets` from `match_player_stats` (`skeets` + `team_skeets`, the caster studio's definition).

- [ ] **Step 1: Write the failing tests** in `tests/widgets.test.ts` (build the server like `tests/profileApi.test.ts`):
  - `404 for an unknown steamid` and `404 for a banned player`.
  - `live puts the streamer's team first with mine: true and adds the half-time score to the totals` (live match, P1 on team b, maps 512/480 and 610/590 as a/b, half-time a 438): expect `mine.side === 'b'`, `mine.score === 1070`, `theirs.score === 1560`, `halfTime.mineSurvived === false`.
  - `live is null when the player is not on either roster` (P3 not in `match_players` of a live match).
  - `live is null for a non-public match`.
  - `a finished match is held as final for 5 minutes`: ended 4 min ago → `final: true`. Ended 6 min ago → `null`.
  - `todayDelta counts from the streamer's local midnight`: two rated matches at 23:30 and 01:30 UTC with `tz=-300` and now = 03:00 UTC. Expect both counted. With `tz=0`, only the 01:30 one.
  - `session counts matches since the given time, and is null without one`.
  - `garbage tz and future since are ignored`.
- [ ] **Step 2: Run** `npx vitest run tests/widgets.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/widgets.ts` and the route.
- [ ] **Step 4: Run** `npx vitest run tests/widgets.test.ts tests/profileApi.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/widgets.ts src/routes/stats.ts tests/widgets.test.ts && git commit -m "Stream widgets: public per-player widget payload"`

### Task 3: Widget page shell (served page, polling, theme)

**Files:**
- Create: `web/widget.html` (copy `web/overlay.html`'s head: transparent body, fonts, `noindex`; root `<div id="widget">`, script `/src/widget/main.tsx`)
- Create: `web/src/widget/main.tsx`, `web/src/widget/useWidgetData.ts`, `web/src/widget/params.ts`
- Modify: `src/server.ts` not-found handler (~line 2488), `vite.config.ts` (`overlayPages` plugin + `rollupOptions.input.widget`)
- Test: `web/src/widget/params.test.ts`, `web/src/widget/useWidgetData.test.ts`, `tests/widgetPage.test.ts`

**Interfaces:**
- Consumes: `WidgetPayload`, `WIDGET_KINDS` (Task 2), `applySeasonTheme` (`web/src/seasonTheme.ts`), `web/src/styles/tokens.css`.
- Produces:

```ts
// params.ts
export type WidgetStyle = 'bar' | 'card' | 'corner' | 'board';
export type WidgetSize = 's' | 'm' | 'l';
export interface WidgetParams { steamid: string; kind: WidgetKind; style: WidgetStyle; size: WidgetSize; idle: 'hide' | 'note' }
export function parseWidgetUrl(pathname: string, search: string): WidgetParams | null;   // /widget/<17 digits>/<kind>
export function widgetUrl(origin: string, p: WidgetParams): string;                      // inverse; omits defaults
export const STYLES_FOR: Record<WidgetKind, WidgetStyle[]>;   // live: all four; rating, session, last: card, corner, bar; queue: corner, bar
export const DEFAULT_STYLE: Record<WidgetKind, WidgetStyle>;  // live: bar; rating, session, last: card; queue: corner
export const SUGGESTED_PX: Record<WidgetStyle, Record<WidgetSize, [number, number]>>;  // OBS width x height
// useWidgetData.ts
export const WIDGET_POLL_MS = 20_000;
export type WidgetState = { kind: 'loading' } | { kind: 'ok'; data: WidgetPayload } | { kind: 'gone' };
export function useWidgetData(steamid: string, opts: { since: number | null }): WidgetState;
```

  Server: `/^\/widget\/\d{17}\/[a-z]+\/?(\?|$)/` page requests get `widget.html` with `Cache-Control: no-cache`. Vite dev does the same rewrite.

  `useWidgetData`: polls `/api/widget/<id>?tz=<-new Date().getTimezoneOffset()>&since=` with `AbortSignal.timeout(8000)` on a `setTimeout` chain. It polls again at once on `visibilitychange` to visible. A failed or timed-out fetch keeps the last `ok` state. A 404 gives `gone`. The session `since` lives in `localStorage` key `widget-session-<steamid>` (try/catch). If it is missing or older than 12 h it is set to now (a new stream starts a new session). `?reset=1` also sets it to now.

  `main.tsx`: parse the URL. A bad URL, `gone`, or `loading` renders nothing. On data, call `applySeasonTheme(data.theme)` and render `<Widget params data />` (Task 4). Before Task 4 lands, render a placeholder `null`.

- [ ] **Step 1: Write the failing tests:**
  - `params.test.ts`: round-trips `widgetUrl`/`parseWidgetUrl` for every kind. Rejects a 16-digit id, an unknown kind, and a style not in `STYLES_FOR[kind]` (falls back to `DEFAULT_STYLE`).
  - `useWidgetData.test.ts` (fake timers, mocked `fetch`): `keeps the last data when a poll fails`, `becomes gone on 404`, `polls immediately when the page becomes visible`, `starts a new session when the stored one is older than 12 h`.
  - `tests/widgetPage.test.ts`: `GET /widget/76561198000000001/live` answers HTML. `GET /widget/abc/live` answers the normal app shell, not `widget.html`. `GET /api/widget/x` is JSON 404, not HTML.
- [ ] **Step 2: Run** `npx vitest run web/src/widget tests/widgetPage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** the same command, plus `npm run typecheck && npm run build`. Expected: PASS, and `dist/public/widget.html` exists.
- [ ] **Step 5: Commit** the touched files: "Stream widgets: /widget page, polling, season theme"

### Task 4: Widget renderers (the presets)

**Files:**
- Create: `web/src/widget/Widgets.tsx`, `web/src/widget/widget.css`
- Modify: `web/src/widget/main.tsx` (render `Widget`)
- Test: `web/src/widget/Widgets.test.tsx`

**Interfaces:**
- Consumes: `WidgetPayload` (Task 2), `WidgetParams` (Task 3), `campaignName`/`mapName` from `web/src/format.ts`.
- Produces: `export function Widget(props: { params: WidgetParams; data: WidgetPayload; preview?: boolean }): JSX.Element | null`. `preview` draws a stand-in game background (used by Task 5).

  Looks follow the approved mockups (brainstorm 2026-11-04). **bar**: one strip, totals, then a chip per map naming who won it. **card**: header "Campaign · map N of M", the two teams with totals, and per-map rows below. **corner**: totals plus "Campaign N/M". **board**: a table with one column per map, then Total. Every panel is a solid dark panel (`var(--surface)` at ~92% opacity) with tabular numbers, sized by `--wsize` (s 0.8, m 1, l 1.3). The streamer's team row gets class `is-mine` (accent colour) and the label `<streamer name>`. The other team is labelled "Opponents". The leading total gets class `is-leading` (bold plus a ▲ marker, never the accent). A half-time map shows "438 / playing". `final` shows a "Final" tag. Rating: SR big, rank name, "#position", "W-L", today's change signed ("+38 today"). Placing: "Placing 3/5". Session: "+52 SR · 3-1 this stream". Last: result word (Win/Loss/Draw, loss in red), score mine-theirs, signed SR change, and the three stats. Queue: "Queueing on Riverside · 6/8". Nothing renders when the section is null or `inQueue` is false, unless `idle === 'note'` for live/queue ("Not in a match" / "Not queueing").

- [ ] **Step 1: Write the failing tests** (`Widgets.test.tsx`, one fixture payload with the streamer on team b and trailing):
  - `every live style lists the streamer's team first with is-mine and their name`, looping over `bar, card, corner, board`.
  - `the leader is marked with is-leading, not is-mine`: the opponents' total has `is-leading` and no `is-mine`.
  - `half-time shows the score and "playing"`, and `final match shows Final`.
  - `live renders nothing when live is null, and "Not in a match" with idle=note`.
  - `rating shows Placing 3/5 when sr is null` and never the text `NaN` or `0 SR`.
  - `rating shows a signed today change` (`+38 today`, `-12 today`).
  - `copy has no em dash`: render every kind and style and assert `textContent` has no `—`.
- [ ] **Step 2: Run** `npx vitest run web/src/widget/Widgets.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `Widgets.tsx` + `widget.css` and wire into `main.tsx`.
- [ ] **Step 4: Run** `npx vitest run web/src/widget && npm run typecheck`. Expected: PASS. Then `npm run dev`, open `/widget/<a real local steamid>/live?style=card` and `?theme=wrong-way`, and check by eye that the accent changes with the theme.
- [ ] **Step 5: Commit** the touched files: "Stream widgets: bar, card, corner and scoreboard presets"

### Task 5: "Stream widgets" section on the profile

**Files:**
- Create: `web/src/routes/StreamWidgets.tsx`
- Modify: `web/src/routes/Profile.tsx` (beside the own-profile cards at ~line 227, shown only when `session.me.steamid === steamid`)
- Modify: `web/src/api.ts` (`api.widget(steamid, since): Promise<WidgetPayload>`)
- Test: `web/src/routes/StreamWidgets.test.tsx`

**Interfaces:**
- Consumes: `Widget` (Task 4); `widgetUrl`, `STYLES_FOR`, `DEFAULT_STYLE`, `SUGGESTED_PX` (Task 3); `WIDGET_KINDS` (Task 2).
- Produces: `export function StreamWidgets(props: { steamid: string }): JSX.Element`.

  The section has a heading "Stream widgets" and one line: "Show your Riverside numbers on stream. In OBS: Sources, +, Browser, then paste the link." Below that: a kind picker (Live match, Rating, This stream, Last match, Queue), a style picker limited to `STYLES_FOR[kind]`, a size picker S/M/L, and an "If idle" choice for live/queue. Then the preview (`<Widget preview />` with their real data, refreshed every 20 s), the URL in a read-only input with a Copy button (`navigator.clipboard.writeText`, "Copied" for 2 s), and "Suggested size in OBS: W x H". When live is null the preview uses a sample live match, labelled "Sample: shows your match when you're in one".

- [ ] **Step 1: Write the failing tests:**
  - `Profile shows Stream widgets only on your own profile` (in a Profile test file, following `Profile.scope.test.tsx` mocking).
  - `changing kind and style updates the copied URL` (mock clipboard; pick Rating + Corner; expect `/widget/<id>/rating?style=corner`).
  - `style choices follow the kind` (Queue offers only Corner and Bar).
  - `the preview uses sample data when not in a match`.
- [ ] **Step 2: Run** `npx vitest run web/src/routes/StreamWidgets.test.tsx web/src/routes/Profile`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: all PASS. Note any failures that already fail on master as pre-existing.
- [ ] **Step 5: Commit** the touched files: "Stream widgets: setup section on your own profile"

### Task 6: End-to-end check (no deploy)

- [ ] **Step 1:** `npm run dev`. As a local player with completed matches, open your profile, pick each kind and style, paste the URL into a new tab, and confirm it matches the preview. Fake a live match with the live-view test helpers, or the local server in cheats mode (see memory `l4d1-local-test-server`), and watch the half-time score appear about 10 s after the half ends.
- [ ] **Step 2:** Headless Chrome screenshot of `/widget/<id>/live?style=board` at 1920x1080 to confirm a transparent background (`google-chrome-stable --headless=new --screenshot --default-background-color=00000000`).
- [ ] **Step 3:** Report to the owner for the deploy decision. Deploying is the owner's call (memory `feedback-deploy-when-empty`, `feedback-deploy-web-lock`). Deploy notes to hand over: add `/api/widget/*` to Caddy's `log_skip` the same way the caster overlay plan proposed, and suggest a real OBS test by Danielb32 or the owner.
