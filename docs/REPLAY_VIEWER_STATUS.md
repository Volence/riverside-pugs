# Replay viewer: status and what is left

Written 2026-09-12 at the end of the build session. Branch `feat/skill-stats-5`,
58 commits, 807 tests, typecheck and build clean, **nothing deployed**.

Design: `docs/superpowers/specs/2026-09-12-replay-viewer-design.md`
Plans: `docs/superpowers/plans/2026-09-12-replay-viewer.md` and `-v2.md`
Full execution ledger, including every ruling made and why:
`.superpowers/sdd/2026-09-12-replay-viewer/progress.md` (git-ignored)

---

## 1. The lockup, fixed 2026-09-12

**The viewer page was uninteractable in a real browser.** Loading `/match/9001`
or a single-viewer `/replay/file/<name>` spun the main thread hard enough that
right click and dev tools would not open.

**Root cause: an infinite loop in `stackLabels` (`web/src/replay/draw.ts`).**
The label de-confliction pass pushes a label to `o.ly + lineH` whenever it sits
within `lineH` of an already placed label `o`, and relied on `ly` strictly
increasing for termination. In floating point `(o.ly + lineH) - o.ly` can come
out a hair under `lineH`: with three survivors at spawn the third baseline was
`71.56827036458554`, its distance from the second (`59.56827036458555`) read as
`11.999999999999993 < 12`, and pushing it to the second's baseline plus twelve
rounded back to the very same number. `moved` never cleared. Any cluster of
three or more labels in one column with fractional canvas positions could hit
it, which is what every round's spawn looks like.

Found by driving headless Chrome over the DevTools protocol, waiting for
`Runtime.evaluate` to stop answering, then `Debugger.pause` to sample the stack
and `Debugger.evaluateOnCallFrame` to read the loop's locals. Every sample was
inside `stackLabels`.

Fix: a push only counts if it actually moves the baseline down
(`o.ly + lineH > ly`). `ly` then strictly increases through a finite set of
values, so the loop is bounded by the number of placed labels. Regression test
with the captured numbers is in `draw.test.ts`. After the fix the page runs at
60 rAF/s with no long tasks and both viewers' clocks advance.

Why every earlier measurement missed it: the browser pane used all session
reported `document.hidden`, so the animation loop never ran and the paint that
first hit the crowded spawn frame never happened there. The ResizeObserver
theory this section used to lead with is dead: the observer fires exactly
twice per viewer on load.

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
