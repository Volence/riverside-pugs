# Demo tick bookmarks (idea, 2026-09-14)

Owner's ask: watching a SourceTV demo back in game, jump straight to the events
the site already tracks (pounces, skeets, booms, pins...) instead of typing
times into demoui. At minimum, show the number to type.

## What the engine offers

- `demo_gototick <tick>` seeks a playing demo. Backward seeks restart the demo
  and fast-forward, so they hitch; forward seeks are quick. (Verify the command
  exists in the L4D1 client before building anything: type it in console while
  a demo plays.)
- `demoui` is engine VGUI, not moddable. The client has no scripting.
- `left4dead.exe -hijack +<command>` passes console commands to an already
  running instance. That is the only outside-in control channel.
- Client cfg files can be `exec`'d during playback, so alias chains and binds
  work.

## Prerequisite: know each event's demo tick

Events carry `t_ms` since round live. The demo for a map starts at map load
(`StartMatchDemo`, `tv_record pug_<token>_<ordinal>_<map>`). So:

1. Plugin logs the server tick when the recording starts:
   `DEMO_START map=... tick=<GetGameTickCount()>` (alongside the existing
   demo start), and the server tick on `ROUND_START` (`tick=`).
2. Backend stores `demo_start_tick` per map and `live_tick` per round.
3. `demoTick(event) = (live_tick - demo_start_tick) + round(t_ms / 10)` at 100
   tick; expose it on the timeline API as `demoTick`.
4. Calibrate once: the recorded demo's tick zero is either the `tv_record`
   moment or that moment minus `tv_delay` (30 s). Parse one existing .dem
   (header is 1072 bytes; each command carries an int32 tick) and compare its
   first tick and `playback_ticks` against the journal timestamps for that
   recording (`Recording SourceTV demo to ...` and `Completed SourceTV demo`).
   Adjust step 3 by the measured offset. Also confirm demo ticks are relative
   to demo start rather than absolute server ticks.

## Option 1: numbers on the site + a cfg to exec (no third-party tool)

- Each bookmark (rail entry, map tag tooltip, scrub tick tooltip) shows
  `tick 45120` and a copy button for `demo_gototick 45120`.
- The match page offers a per-map `pug_<token>_<ordinal>.cfg` download:
  ```
  alias bm_1 "demo_gototick 4480; alias bm_next bm_2; alias bm_prev bm_1"
  alias bm_2 "demo_gototick 9810; alias bm_next bm_3; alias bm_prev bm_1"
  ...
  alias bm_next bm_1
  bind KP_PLUS bm_next
  bind KP_MINUS bm_prev
  echo "[PUG] 23 bookmarks loaded. KP_PLUS next, KP_MINUS previous."
  ```
  Land 3 s early like the site does (`bookmarkSeekMs`), i.e. subtract 300
  ticks. Optionally one cfg per player (their bookmarks only), mirroring the
  follow-row filter.
- Works on any OS, nothing to install. Cost: small plugin change, backend
  columns, a cfg generator route, UI for the numbers.

## Option 2: one click from the site

- A small helper on the player's PC registers a `riverside://` URL scheme.
  Clicking a bookmark on the site opens `riverside://demo/goto/45120`; the
  helper runs `left4dead.exe -hijack +demo_gototick 45120`.
- Could also `+playdemo pug_...` to open the right file first (helper needs the
  demo in the game dir; the site already serves demos to logged-in users).
- Windows-first, per-player install, a day or two. Do option 1 first; option 2
  reuses its numbers.

## Not doing

- Replacing demoui, or any in-game overlay: impossible without client mods.
- Reading ticks from the .rpl replay: the replay clock is round-relative and
  says nothing about the demo file; the plugin has to log the server ticks.
