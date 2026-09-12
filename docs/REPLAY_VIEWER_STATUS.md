# Replay viewer: status and what is left

Written 2026-09-12 at the end of the build session. Branch `feat/skill-stats-5`,
58 commits, 807 tests, typecheck and build clean, **nothing deployed**.

Design: `docs/superpowers/specs/2026-09-12-replay-viewer-design.md`
Plans: `docs/superpowers/plans/2026-09-12-replay-viewer.md` and `-v2.md`
Full execution ledger, including every ruling made and why:
`.superpowers/sdd/2026-09-12-replay-viewer/progress.md` (git-ignored)

---

## 1. The open bug, and it is the blocker

**The viewer page is uninteractable in a real browser.** Loading either
`/match/9001` or a single-viewer `/replay/file/<name>` makes the page
unresponsive enough that right click and dev tools do not open. Other sites on
the same machine are fine.

**It is not reproduced and not diagnosed.** Everything below was ruled out by
measurement, so do not spend time re-checking them:

| Ruled out | Evidence |
|---|---|
| Server, routes, data | 200s throughout; 700 frames, 250 KB, correct map, decodes clean |
| Request storm or re-decode loop | Network log shows each replay fetched exactly once, connection closes |
| Backdrop blit cost | 0.115 ms per scaled 2048x1271 blit, about 1% of a frame budget |
| Two viewers being mounted at once | A single-viewer page locks up identically |
| Machine load | Reproduced with load average 5.8 as well as 19.7 |
| Stale Vite modules | Survives a dep-cache wipe and a hard reload |

**Why it was never caught:** the browser pane available during the build
reports `document.hidden`, and a hidden tab never fires `requestAnimationFrame`
and never performs layout. Those are exactly the two things that only happen in
a visible tab, so every measurement taken during the build was blind to this
entire class of problem. Any future attempt needs a genuinely visible browser.

**Where to look first**, in order:

1. **A `ResizeObserver` feedback loop** in `web/src/replay/canvasSize.ts`. It
   reads `el.clientWidth` inside the observer callback, which forces layout,
   and the resulting state change resizes the very element being observed. The
   stage carries an inline `aspectRatio` and a `maxWidth` derived from `vh`, so
   a height change can feed back into a width measurement. This is the single
   most likely cause and it is invisible without layout.
   Quick test: hard-code the canvas size, bypassing the hook entirely. If the
   page becomes interactive, this is it.
2. **The `requestAnimationFrame` loop in `ReplayCanvas`**, which now drives
   drawing directly. Quick test: make it draw on a 500 ms `setInterval` instead.
   If the page frees up, the cost is per-frame, and the next question is which
   part of `drawScene`.
3. **Something in `drawScene`'s text path.** The name labels call `measureText`
   per player per frame for their backing plates. That is 8 calls a frame and
   `measureText` can force layout in some engines.

The bisect that has not been run yet, and should be: comment out the
`<ReplayCanvas>` element but leave everything else mounted. If the page is
responsive, the problem is the canvas and its loop. If it is still locked, the
problem is in the surrounding component tree or the sizing hook.

---

## 2. What needs a human before this ships

1. **The plugin is committed but NOT deployed.** Format version 2 fills the
   `cls` byte with the survivor character. `SURVIVOR_CHARACTERS` is
   `['bill','zoey','francis','louis']`, corroborated from Rotoblin's own
   `include/l4d_lib.inc:546` but never checked in game. A wrong order fails
   silently, putting the wrong face on the right player. One round on the local
   test server plus `scripts/dump-replay.ts` settles it.
2. **The live page has never run end to end**, because no live match existed
   locally. It is the one surface carrying the ghost risk, so the first live
   match should be watched with the page open.
3. **`pug-match.sp` around line 1119** iterates `IsClientInGame` without
   excluding fake clients and then calls `IsPlayerAlive`, which SourceTV
   reaches. If that ever throws it unwinds into `RplFail()` and kills a whole
   match's recording. Both have been live since early September without
   incident, so this is probably fine, but it is the sharpest edge in that file.
4. **`sv_password` is still derived from the match token**
   (`orchestrator.ts:107`). The token is no longer published anywhere, so the
   leak is closed, but the two secrets remain the same secret. Decoupling them
   is the durable fix and was deliberately not done while nobody was awake to
   confirm how players actually learn the password.

---

## 3. Things that work and are verified

- Browse page, match page, per-map viewers with a round switch, and the
  events-and-chat timeline, all verified rendering against real data.
- 22 maps of height-sliced overview art, converted to WebP (256 MB to 28 MB)
  and committed. Layer selection follows the median survivor height with
  hysteresis, which closed the vertical-overlap problem the design had parked.
- The anti-ghosting delay, rebuilt after a review found it was comparing game
  time against wall time. A Rotoblin pause used to collapse it to zero for the
  rest of the round. It is now anchored to the file's mtime, so a frame's age
  is a game-time difference plus pure wall time, which no pause can distort.
- The match token no longer reaches any public response: not in a payload, not
  in a filename, not in the replay header bytes, which are zeroed on the wire.

## 4. Local development

- `npm run dev` now defaults `REPLAY_DIR` to `$PWD/data/replays-test`, which is
  where the synthetic fixtures live. Nothing loads a `.env` file in this app.
- Fixtures: a Death Toll session that walks the real road at ground level, and
  a No Mercy session that climbs from z=20 to z=900 specifically to exercise
  layer switching on a map with 14 cuts.
- Match `9001` is seeded in the local `data/pug.db` with replays and a timeline.
  It exists only locally.
