# Replay viewer, piece 3

Design agreed 2026-09-12. Builds directly on
`2026-09-11-replay-capture-design.md`, which specified the recorder (6b) and
deferred the viewer to this piece.

Piece 3 turns recorded `.rpl` files into something watchable: a top-down player
for finished rounds, the same player fed live from a round still being recorded,
and a browse page for the standalone `!mix` files that have no match row.

## What it inherits

6b is code-complete and verified in game. This piece adds no recording.

- `src/replayFormat.ts` parses a file. `parseReplay` already survives truncated
  and never-closed files, and `Frame.offset` is already filled in by the decoder.
- `src/replayTail.ts` `releasableFrames()` is the 10 second anti-ghosting delay,
  built and tested with no caller. This piece is its first caller.
- `src/replays.ts` `resolveReplayPath()` resolves a `match_replays` row to a
  path with traversal hardening, also with no HTTP route yet.
- `match_events` and `match_chat` share one sequence counter, so chat and deaths
  interleave in true order.

## Scope

In: the viewer component, saved playback, live playback, the standalone browse
page, the per-map world-to-image transform table, and the in-game-style HUD
panel strip.

Out: the nav-mesh schematic backdrop (its own later piece), map overhead capture
for the twelve maps that lack art, and 6c's admin storage panel.

## Placement

Three surfaces, one component:

- Live page, at the top above the stats. Current round, 10 seconds behind.
- Match page, under each map's section, with a round 1 / round 2 switch.
- `/replays`, new: sessions from `REPLAY_DIR` grouped by token.

The `/replays` page exists because standalone `!mix` sessions produce no
`match_replays` row and therefore cannot be reached through a match page. It is
also the only way to exercise the viewer against real data before the next
ranked PUG, since every file recorded so far is standalone.

## The viewer surface

Modelled on suprep's `player.html`, which was picked as the reference
implementation.

- Canvas showing the map area with avatars drawn on top.
- Play/pause, a scrub bar showing round time, speed at 0.5x / 1x / 2x / 4x.
- Toggles: HP, Guns, Events, Chat, CI, Entities, Follow. Persisted in
  `localStorage`.
- Status line: survivors alive, common count, specials alive. Live adds
  `LIVE, 10s delayed`.
- Timeline rail beside the canvas, below it on narrow screens, interleaving
  `match_events` and `match_chat`. Click any line to seek.

Two deliberate departures from suprep. There is no manual calibration panel,
because `cl_leveloverview` reports origin and scale directly and the transform
is therefore derived rather than eyeballed. And on maps with no overhead art the
backdrop is a faint grid plus an accumulating survivor trail rather than a void.

## The HUD panel strip

Four survivor panels and four infected panels in the in-game style: portrait,
name, health number with a colour ramp, a two-tone permanent-plus-temp health
bar, and status flags.

Everything except the portrait already exists in the format. `health` and `temp`
are carried separately precisely so a viewer can draw the two-tone bar; the
comment saying so is at `pug-match.sp:1104`. `INCAP`, `LEDGED`, `PINNED`,
`BILED` and `BURNING` are live bits in the state byte. Infected panels get a
real class icon because `cls` carries `m_zombieClass` today.

**Portraits are game art, not Steam avatars.** Steam avatars were the first
choice and were rejected: some are lewd, the site renders no avatars anywhere
today so the viewer would be introducing that exposure, and moderating it would
be reactive. `/home/volence/l4d/hud/src/materials/vgui/` already carries the
real panel art (`s_panel_namvet`, `s_panel_biker`, `s_panel_manager`,
`s_panel_teenangst`, `s_panel_dead`), which is four conversions to PNG. The
player's name still labels the panel, so who it was is never lost.

**The held-item box is omitted.** In game that slot shows carried pills or a
kit. Only the *active* weapon is recorded, so the box would blink on only while
someone is holding pills. An omitted indicator beats a lying one.

### Survivor character needs a format bump

The plugin hardcodes `cls` to 0 for survivors, so which character someone played
is not in any file recorded to date. Sequence:

1. Land the `header.version` check in `parseReplay` (follow-up 3 from 6b). It
   must precede any format change regardless, since a v2 file fed to a v1 reader
   decodes as plausible nonsense rather than erroring.
2. Bump to version 2, where `cls` means survivor character for survivors instead
   of always 0. No record growth, just a field that is currently dead weight.
   One `m_survivorCharacter` read in the plugin.
3. Version 1 files render a neutral silhouette. Version 2 files render the real
   character. The version byte makes that exact rather than guessed.

The viewer ships fully working without step 2. Only portraits wait on it, and
the plugin deploy is a live ranked path change, so it happens on request.

## The data path

### Shared code, one decoder

`src/replayFormat.ts` becomes isomorphic: DataView over `Uint8Array` in place of
Buffer methods. `Buffer` is a `Uint8Array` subclass and `fs` accepts
`Uint8Array`, so no Node caller changes. The module imports nothing today, which
is what makes this cheap.

**Rule: shared modules stay self-contained with no relative imports.** The
server resolves `./replayFormat.js` under NodeNext; the browser imports
`../../src/replayFormat` extensionless under Vite's bundler resolution. A
relative `.js` specifier inside a shared file would break the browser side, so
there are none. Vite's root is `web/`, so this costs one entry in
`web/tsconfig.json` and no build plugin.

A second browser decoder was rejected outright. The plugin is already a second
hand-written implementation of this layout, and the reason 6b needed an in-game
byte-for-byte read-back gate is that a one-byte disagreement produces plausible
nonsense rather than an error. Once was enough.

### Server

- `replayTail.ts` gains `releasableBytes()`: how many bytes of this file may be
  sent right now. Built on the existing tested `releasableFrames` plus
  `Frame.offset` and `frameBytes`, so the cutoff rule lives in exactly one place.
- `replaySessions.ts`, new: scan `REPLAY_DIR`, read each file's 160 byte header
  rather than parsing it, group by token. Serves the browse page and answers
  "which file is the current round for this token".
- `src/routes/replays.ts`, new: whole file with Range support for a finished
  round, a `?since=<byte>` feed for anything still recording, the session list,
  and a by-name file route for standalone files. The by-name route reuses
  `resolveReplayPath`'s hardening, which is already factored around `NAME_RE`
  plus a `basename` and resolved-prefix check: the name must match the known
  filename pattern and resolve inside `REPLAY_DIR`. The difference is only
  where the name comes from, a URL rather than a database row, and that
  function already treats its row as untrusted for the same reason.

**One invariant instead of per-route rules: a closed file is history and streams
in full, an open file is live and gets the cutoff.** `header.frameCount != 0`
means closed. A file whose mtime has not moved in 60 seconds also counts as
closed, so a crashed recording is not delayed forever. Round start comes from
`header.startedUnix`, which is in the file, so standalone sessions get the same
protection with no database row involved.

This matters because standalone mix sessions are live too and carry ghost
positions. A browse page that served raw open files would be a ghosting hole.

### Live transport: byte-prefix polling

The server hands out raw replay bytes truncated at the last releasable frame.
The client keeps a byte cursor and polls about once a second. If the server
reports a different current filename, the cursor resets and a new round has
begun.

Saved and live therefore share one decoder, because live is literally a prefix
of the same file. The 10 second delay becomes structural rather than a rule
someone can forget: bytes past the cutoff are never written to the response.
The server stays stateless, so a refresh or a reconnect is just `since=0`.

WebSocket push was rejected. The latency win is meaningless under a deliberate
10 second delay, and it costs subscription state, backfill for late joiners, and
a second wire format to hold in lockstep with the byte layout. JSON frame
polling was rejected because joining a round seven minutes in is a
multi-megabyte catch-up and it is a second representation of the same records.

### Client

`useReplaySource()` returns header plus frames and does not know which source it
has: saved fetches once, live polls and appends. Playback is a separate clock,
so seeking and speed changes never touch fetching.

## The map transform

`src/mapTransform.ts`, shared, is a table keyed by map name holding origin x,
origin y, units per pixel, and an image path.

Ten entries seed straight from `mapinfo.res` (Blood Harvest `l4d_farm01..05`,
Death Toll `l4d_smalltown01..05`), whose BMPs ship with the game and are already
on disk. The conversion is `px = (world_x - x) / scale` and
`py = (y - world_y) / scale`, carrying the `1024 * scale / image_height`
correction so a non-square capture reads as a wider field of view rather than a
stretched one.

A map with no entry auto-fits from the position bounds the replay itself
contains, computed once at load, with a faint grid and the survivor trail as the
backdrop. That covers No Mercy, Dead Air and Crash Course with no art and no
capture session.

Adding a map later is a row and a PNG, not a code change, and no replay ever
needs re-recording because positions are stored as raw world units. This is
strictly better than suprep's manual anchor calibration, which exists only
because they were reverse-engineering numbers `cl_leveloverview` hands you.

## Rendering

One `<canvas>`, Canvas 2D, drawn imperatively in a `requestAnimationFrame` loop.
Preact holds refs and never re-renders per frame.

**Interpolation.** 10Hz looks like a slideshow, so the loop lerps position
between the two bracketing frames and lerps yaw the short way around the wrap at
180 degrees.

Entities need care. `ref` is a recycled engine index and the format's own
comment says to treat it as an identity hint, never a durable key. An entity
interpolates only when `ref` and `kind` both match across adjacent frames and
the movement is plausible; otherwise it pops. Commons churn constantly, so
getting this wrong makes the whole screen crawl.

**Draw order.** Backdrop, trail, commons as small dim dots, specials and world
entities, survivors on top.

**Height.** Avatar radius scales about 20 percent with height relative to the
survivor team's median, per the 6b decision. Higher reads as closer to an
overhead camera.

**Guns** needs a weapon id to name table on the TypeScript side mirroring the
plugin's ten ids (`pug-match.sp:1010`). This is a second copy of a mapping, but
a wrong weapon name is visibly wrong rather than silently wrong, unlike a byte
layout. It lives next to `ENTITY_KIND` so the two stay in view of each other.

## Testing

Pure functions carry the weight: `releasableBytes`, world-to-image, auto-fit,
the events-plus-chat merge, and the interpolation maths. Routes are tested
against a temp directory of synthesized files, including one with `frameCount`
0 to prove an open file is cut off, and a traversal attempt.

**The load-bearing test is the anti-ghosting assertion:** for an open file, no
byte past the cutoff ever appears in a response. That is the entire security
model of a public live page.

For the isomorphic swap, the existing 512 tests are the gate. If they pass
unchanged the swap is correct. No test is adjusted to make the swap pass.

Rendering is tested through its pure helpers by computed output, not pixels. No
pixel diffing.

## Known risks

1. **AI tanks may be flagged ghost.** 6b follow-up 4 records `TANK_AI` showing
   the GHOST bit on 90 samples, unexplained. Ghost treatment therefore applies
   to player records only, not entities, until that is understood. Otherwise an
   AI tank renders as an invisible spawn.
2. **First fetch on a long round is expensive.** A viewer joining seven minutes
   in reads and parses the whole file to find the cutoff. The cutoff is memoised
   per file for about a second so concurrent viewers share one scan.
3. **The version 2 plugin change touches the live ranked path.** It deploys on
   explicit request only. The viewer works fully without it.
4. **Dead survivor bots vanish** rather than leaving a body, per 6b follow-up 5.
   Known, not fixed here.

## Resolved 2026-09-12

- Saved and live ship together. Standalone browsing ships with them as a
  minimal by-token route, because it is the only real test data available and
  because mix nights are what is actually being played
- All four viewer feature groups ship in v1: core playback, state and health,
  events and chat timeline, world entities and follow
- Backdrop is auto-fit plus trail for maps without art, with the ten Valve maps
  getting real calibrated overheads in the same release. The nav-mesh schematic
  becomes its own later piece rather than gating this one
- Portraits are game art. Steam avatars rejected on content grounds
- Held-item indicator omitted rather than shown unreliably
- Live transport is byte-prefix polling, not WebSocket push
- One isomorphic decoder, not a second browser implementation
- No Mercy 4's vertical overlap is revisited when the overhead capture work
  happens, not in this piece

## Still open

Nothing blocking.

Revisit later, not now:

- Whether live replay visibility needs tightening. It ships visible to everyone,
  and the server-side delay is what makes that safe, so the delay is not optional
- No Mercy 4's hospital interior, per the resolved item above. Height scaling
  is the mitigation and may not be enough; it is revisited with the overhead
  capture work, where there will be real art to judge it against
