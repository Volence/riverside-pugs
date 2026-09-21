# Input macro detection

Detect fire-rate macros, spam-pounce and bunnyhop scripts from input timing, as
evidence for admins. Designed 2026-09-20/21 against measurements taken on the
local test server, not from theory.

## Why this exists

File consistency (`consistency/`) kills the content-swap class. It cannot touch a
cheat that modifies no file, and a macro modifies no file. The owner named three:
pistol fire-rate macros, spam-pounce (holding M1 so you re-pounce the instant you
land), and bunnyhop scripts. All three are the same cheat wearing different hats:
a script pressing a button more regularly, or more often, than a hand can.

The threat model is unusual and it favours us. Nobody is writing new cheats for a
2008 game, so the target is frozen while our tooling is not. Every detection
improvement is permanent, and past matches can be re-examined with a better
detector. That asymmetry is the reason the analysis lives on the web side over
stored data rather than in the plugin.

## What was measured, 2026-09-20

A synthetic input device (`/dev/uinput`, so it works under Wayland) drove a real
client on the local server. `+attack` press edges, burst-segmented at 300ms:

| run | n | mean interval | rate | sd | min | cv |
|---|---|---|---|---|---|---|
| human, manual | 124 | 125.5ms | 8.0/s | 48.5ms | 49.3ms | **0.386** |
| macro, perfect 13/s | 70 | 76.8ms | 13.0/s | 5.6ms | 59.0ms | **0.072** |
| macro, +25ms jitter | 161 | 74.3ms | 13.5/s | 23.8ms | 29.2ms | **0.320** |

Four things follow, and three of them contradict what the design would have been
without the measurements:

1. **Variance alone is not a detector.** Perfect macro sits 5x below the human.
   Add 25ms of gaussian jitter, about ten lines of code, and cv reaches 0.320
   against a human 0.386. Any cv threshold catching that also catches players.
2. **Sustained rate survives jitter.** The human peaked at 8.0/s; both macros held
   ~13.5/s for twelve unbroken seconds, and the jittered run was FASTER, because
   jitter is symmetric. Hands fatigue; scripts do not.
3. **There is a hard floor on how perfect a macro can look.** The server samples
   buttons once per tick, so a flat 76.9ms interval aliases to alternating 70/80ms
   and bottoms out at sd 5.6ms, never zero. A detector written as "sd below 2ms"
   would never fire.
4. **Burst segmentation is mandatory, not a refinement.** The first human sample
   contained a 31-second idle gap, which dragged cv to 6.85 and hid everything.

`Little Anti-Cheat` with `lilac_macro -1` and `lilac_macro_mode 0` did NOT detect
any of it. Its auto-shoot check looks for two consecutive one-tick perfect kill
shots, an aimbot signature, not a fire-rate one. SMAC did not either, which
matches the AlliedMods consensus that it "does not detect macros or scripts 99.9%
of the time". So this replaces nothing; it is new.

## Prior art: Oryx-AC

`shavitush/Oryx-AC` (GPL, CS:S/CS:GO/TF2 bhop) is the best existing design and is
the reference. What is taken from it:

- **Input count per event is the highest-confidence signal.** Its `highn` check
  fires at 17+ scroll inputs per jump. Ours is `+attack` presses during one
  pounce, where a human issues one or two.
- **Randomisation is itself a signature.** Its `wpatt2` fires on "obviously
  randomized scrolls" via `iSameAsNext >= 3 && iCloseToNext >= 10`, comparing each
  interval to the NEXT one. This is the answer to measurement (1) above, and it is
  order-dependent, which drives the storage decision below.
- **Structural signatures beat timing ones.** `nobf`/`bf-af`/`noaf`: no inputs
  before touching ground, equal counts before and after, none after leaving. A
  cheater adding timing jitter does not think to fix the shape.
- **Many signatures with stated confidence**, 40% to 91%, feeding severity levels
  rather than one boolean.
- **Adversarial guard.** `TICKS_NOT_COUNT_AIR 135` exists, per its own comment, to
  stop players "spamming their scroll wheel while falling to purposely make the
  anti-cheat ban them". A player can try to trigger a false positive deliberately.

## Decisions

| question | answer |
|---|---|
| outcome | evidence only; admins decide. No automatic in-game action. |
| analysis | plugin captures, web analyses, so signatures can be re-run over history |
| scope | capture all three anchors; ship TWO signatures, `pounce_spam` and `pistol_rate` |
| severity | always `low`. A detection says "watch this replay", never "this player cheated" |
| repeats | a signature must repeat across separate bursts in one match before there is a row |
| window | live matches only, so every burst carries a match |
| wire | raw interval list AND raw hold list, order preserved |

The first version of this document shipped one signature, called it the one that
"needs no statistical tuning", and gave it severity high. The audit of 2026-09-21
(`/home/volence/l4d/docs/integrity-audit-2026-09-21.md`, item 11) showed the
threshold sat on the measured human peak. Section 3 has the recalibration and the
simulation behind it. What changed in the same pass is marked **0.2.0** below.

## 1. Capture (plugin)

Plugin `l4d_inputstats.smx`, version 0.2.0. NOT added to `pug-match.sp`: that
plugin runs every live match on four servers and does not need a per-tick hook in
it.

- `OnPlayerRunCmdPre`, whose parameters are read-only by signature. This must be
  incapable of changing the game, and it must see input before
  `l4d2_pistol_delay` clamps it.
- Hot path is ~800 calls/sec at 100 tick with 8 players: integer compares and
  array writes only, no string work. Formatting happens at burst close.
- **Press edges, and since 0.2.0 release edges.** A held button repeats every tick
  and drowns the signal, so only the edges are recorded.
- Three anchors: `fire` (consecutive `+attack`, with the weapon in hand at the
  FIRST press, because an automatic weapon produces no press edges and because a
  weapon swap after the burst must not relabel it), `pounce` (`+attack` presses
  while airborne, one burst per airborne phase), `bhop` (landing to next `+jump`,
  one line per hop).
- **0.2.0: ghosts are not captured.** `IsPlayerAlive` is true for a ghost infected,
  a ghost hunter holds `weapon_hunter_claw`, and every player mashes M1 as a ghost
  because that is how you spawn. 0.1.0 captured all of it as pounce bursts. Capture
  is skipped while `m_isGhost` is set, and the button state is kept current so the
  spawning press is not an edge on the first live tick.
- **0.2.0: a ladder is not the air.** `FL_ONGROUND` is clear on a ladder, so a climb
  read as one long airborne phase, and stepping off the top as a bhop landing.
- **0.2.0: intervals are in USERCMDS (`cmdnum` deltas), not server ticks.** The hook
  runs once per usercmd. After a lag spike the server runs a backlog of usercmds
  inside one tick, so timed by `GetGameTickCount` those presses were zero ticks
  apart and were silently dropped, which bent exactly the bursts of the players
  with the worst connections. One usercmd is one tick for a healthy client, so
  the numbers and the per-tick aliasing of measurement (3) are unchanged. The burst
  gap, ground time and air time use the same clock.
- Burst closes after 300ms (30 usercmds) of silence, per measurement (4). Since
  0.2.0 it closes WHEN the gap has passed, not at the next press after it, and
  bursts in flight are emitted on `player_death`, `round_end` and disconnect. 0.1.0
  never emitted the last burst of a life, a round or a session.
- Both clocks recorded: `st` is the server tick and `ct` the usercmd's client
  `tickcount`, read at the same moment when the line is emitted, on every kind.
  (0.1.0 documented `ct` as the client tickcount but sent `cmdnum` on two kinds and
  a literal 0 on the third.) The client value is attacker-controlled and times
  nothing, but its drift against `st` is its own future signal. `sp` is the server
  ticks between the first and last press: set against the sum of the intervals it
  shows lag bunching, or a client lying about its command numbers.
- **0.2.0: hold duration per press**, press edge to release edge, in usercmds. See
  section 2a. Captured now because it cannot be backfilled.
- Caps: 256 intervals per burst. **0.2.0: budgets are per kind**, fire 128, pounce
  96, bhop 96 per player per round. 0.1.0 had one budget of 64 shared by all three
  kinds and reset at `round_start`, which fires BEFORE ready-up, and every hop costs
  a line, so saferoom hopping could spend the whole budget before the round was
  live, in silence. Budgets now refill at `round_start` and again at l4dready's
  `OnRoundIsLive` global forward (a forward is only a public function with the
  right name, so there is no include and no dependency; without l4dready it is
  never called). The first burst a budget refuses emits one `cap` marker.
- **DEVIATION, decided during the first build.** The design said the plugin would
  learn match state from a new `PugMatch_IsLive` native. It does not. `pug-match.sp`
  exposes no natives and has no state cvar, so adding one would mean modifying
  the plugin that runs every live match on four servers, and coupling two
  deploys. Instead the plugin captures whenever a human is alive and the WEB drops
  any burst that does not resolve to a live match on the sending server, which it
  already knows from `resolveServerBySource`. Storage is therefore live-matches-
  only exactly as decided, with zero coupling.
- `l4d_inputstats_bots`, default 0, TEST ONLY: bots are the only way to exercise
  the capture path without a human at a keyboard. Bot input is not evidence, and a
  bot has no steamid the web will accept.
- **0.2.0: `sm_inputstats_emit` is not in the shipped plugin.** It attributed a
  synthetic burst to the first human on the server. It compiles only with
  `spcomp l4d_inputstats.sp DEBUG=1` and then emits only for a fixed test steamid.

## 2. Wire

`L4DM`, admitted exactly like `L4DC`: the marker must be the first token after the
engine's timestamp, from a known server address. The game server relays every
`say` line on the same stream, so an unanchored marker is forgeable from chat.

    L4DM id=<steamid64> k=fire|pounce|bhop w=<weapon> n=<count> g=<groundticks>
         a=<airpresses> st=<servertick> ct=<clienttick> sp=<serverspan> v=2
         d=<chars> h=<chars>

    L4DM id=<steamid64> k=cap c=fire|pounce|bhop st=<servertick> v=2

| key | meaning |
|---|---|
| `n` | intervals in `d`. Presses are `n + 1`. On a bhop line, 1 (a placeholder). |
| `g` | bhop: usercmds on the ground before the jump. pounce: usercmds airborne. fire: 0. |
| `a` | pounce: presses recorded in the airborne phase. Otherwise 0. |
| `st`, `ct` | server tick and client tickcount when the line was emitted. |
| `sp` | **0.2.0.** Server ticks from first press to last. Cross-check on `d`. |
| `v` | **0.2.0.** Wire version. Absent means 1 (plugin 0.1.0, intervals in server ticks). |
| `d` | intervals between presses, one character each. |
| `h` | **0.2.0.** Hold per PRESS, one character each, so `n + 1` of them (1 on a bhop line). |

**Backward compatibility is the parser's job.** Every 0.2.0 key is optional, so a
0.1.0 line parses exactly as before and is stored as wire 1 with no holds and no
span. Present, a key is held to the same standard as the rest: a value the plugin
could not have produced refuses the whole line, including holds that do not line
up with the presses. A wire version the parser does not know is refused, because
it may have changed what a field MEANS. Web deploys before the plugin, always.
The 0.1.0 parser, for its part, ignores unknown keys and refuses `k=cap`, so
nothing breaks in the other order either; the new data is simply lost.

- **No name field. SteamID only.** The live roster-forgery bug is a name field
  carrying identity; there is no reason to repeat it.
- Encoding falls out of the burst rule: a burst closes at 30, so every interval is
  1..30 by construction and encodes as one printable character. Holds use the same
  alphabet, with 30 meaning "30 or more" and a press still down when its burst is
  emitted recording the time so far. In a pounce burst an interval of 30 also
  means "30 or more": an airborne phase runs until the landing whatever the gaps,
  and 0.1.0 DROPPED such gaps, which would now misalign `d` and `h`.
  **Base 48, `'0'`..`'M'`, not base 33.** Base 33 was the first choice and was
  wrong: `chr(34)` is a double quote and `chr(39)` a single one, and this line
  travels on the same stream as quoted chat. Caught by reading a line the plugin
  really emitted, not by a test.
- **Line length.** The longest possible line is about 120 bytes of fixed keys with
  every counter at its widest, plus 256 for `d` and 257 for `h`: under 650, under
  680 with the engine's stamp. That is inside `LogToGame`'s 1024 byte buffer and
  one UDP log datagram, so there is still no chunking and no multi-packet trap. A
  test pins it under 900.
- Bursts of fewer than 3 presses are not emitted: noise, and most of the volume.
  (0.1.0 asked for 3 INTERVALS on a fire burst, one press more than this says.)
- One line per burst, at burst close. One `cap` line per kind, player and round,
  when that kind's budget runs out.
- Worst case volume is 320 lines per player per round. Typical volume is to be
  checked against a real match rather than trusted.

### 2a. The hold series, and what it is for

Press rate says how often a button was pressed. It says nothing about what
pressed it, and three different things produce the same inhuman rate:

| source | holds | annotation |
|---|---|---|
| mouse wheel bound to `+attack` / `+jump` | one usercmd, every time: a wheel notch has no held state | `wheel-like` |
| AutoHotkey-style macro | a set hold time, so constant to within the one tick of aliasing | `fixed-hold` |
| a hand | 5 to 12 ticks, never the same twice | `variable-hold` |

`holdStats` gives the median, the spread (sd, min, max), the share of one-tick
holds and the share within a tick of the median. `holdAnnotation` names the shape:
`wheel-like` at 80% or more one-tick holds, else `fixed-hold` at 90% or more within
a tick of the median, else `variable-hold`; `no-hold-data` for 0.1.0 bursts or
fewer than 4 holds. The median is used rather than the range because the last hold
of a burst is often the player simply keeping the button down.

It is an ANNOTATION, not a detection and not an input to one. It rides on the
detection row (`note`), on the admin feed line, and per burst with its numbers in
the player panel. It changes neither whether a signature fires nor its severity.

Two honest limits. A script that taps with no hold time is `wheel-like` too, so the
annotation means "not a finger on a button", not "innocent": what separates a real
free-spinning wheel from such a script is the RATE, which decays and wobbles on a
wheel and is flat on a script, and that is read off the intervals by the admin.
And a careful cheater can randomise holds as easily as intervals, which is why
holds annotate and sustained rate detects.

## 3. Storage and analysis (web)

`input_bursts`: id, match_id, server_id, steamid, kind, weapon, n, ground_ticks,
air_presses, server_tick, client_tick, intervals TEXT, at TEXT, and since 0.2.0
wire (1 or 2), server_span, holds TEXT (null from 0.1.0). Indexed on match_id and
on (steamid, at).

`input_caps`: id, match_id, server_id, steamid, kind, server_tick, at. One row per
`cap` marker. A row means the capture for that player, kind and round is
TRUNCATED, which is not the same as nothing having happened.

`input_detections`: id, burst_id, match_id, steamid, kind, signature, severity, at,
hits, evidence (JSON burst ids), note. **One row per player, match and signature**,
written by the burst that completes the repeat count (`burst_id` and `at` are
that burst's), with `hits` and `evidence` growing as later bursts qualify.

`src/inputStats.ts` decodes and derives, per burst: n, mean, sd, cv, min, max, and
the order-dependent `sameAsNext` / `closeToNext` counts Oryx uses. Storing the raw
ordered series is what keeps those computable. Every shipped signature lives in one
`SIGNATURES` list, and `matchDetections` is the one pure function that turns one
player's bursts in one match into detections, so the live path, the re-run tool and
the calibration simulation cannot disagree about what a detection is.

### Calibration

The thresholds are pinned by a seeded Monte Carlo (`tests/inputSim.ts`,
`tests/inputSignatureSim.test.ts`) built on the measurements above: a hand is
lognormal at cv 0.39, a macro is a fixed period with optional gaussian jitter, and
press times are quantised to ticks as the plugin sees them. The simulated "match"
is the worst legitimate case on purpose: the player mashes at their PEAK rate
through every airborne phase (60 of them) or every pistol burst (150 of them), with
no fatigue.

| | old `pounce_spam` | new `pounce_spam` | `pistol_rate` |
|---|---|---|---|
| rule | mean <= 12 ticks (8.3/s), 4 intervals, 1 phase, severity high | >= 12/s, 6 intervals, 4 phases, low | >= 12/s over a 3 s window, 2 bursts, low |
| legit 8/s hand, per phase | 45% | | |
| legit 8/s hand, per match | 100% | 0 of 5000 | 0 of 2000 |
| 9/s hand, per match | 100% | 19 of 5000 (0.4%) | 0 of 2000 |
| 10/s hand, per match | 100% | 57% | 41% |
| 13/s macro, per match | 100% | 2000 of 2000 on 10 pounces | 2000 of 2000 on 10 bursts |
| 13/s macro + 25 ms jitter | 100% | 1999 of 2000 on 10 pounces | 2000 of 2000 on 10 bursts |

The 10/s row is the honest edge of this. Nobody measured here gets near a
sustained 10/s, and the row assumes they hold it through every burst of a whole
match, but it is where the margin runs out: a player who really can do that WILL
be flagged, and that is what severity low and a human reading the replay are for.

### Signature `pounce_spam`

An airborne phase on `weapon_hunter_claw` whose MEAN press rate is at or above
**12 presses/s** (mean interval <= 8.33 ticks) over at least **6 intervals**,
repeated on **4 separate airborne phases** in one match. Severity low.

12/s is 50% above the measured human peak of 8.0/s and under the 13/s macro. Six
intervals is the shortest macro pounce that was measured (7 presses over 0.57 s),
so the short pounce that killed the count threshold still qualifies. 11/s was
tried and rejected: over six intervals the mean is too noisy, and a 9/s hand
passed 30% of matches.

History, kept because both mistakes are instructive. This was first a COUNT
threshold (`air_presses >= 12`) and live testing killed it:

| | presses | airborne | mean interval | rate |
|---|---|---|---|---|
| normal pounce | 3 | 2.03s | 15.5t | 6.5/s |
| **hand MASHING M1** | 8 | 1.61s | 19.7t | 5.1/s |
| macro 13/s, short | **7** | 0.57s | 7.7t | 13.0/s |
| macro 13/s, short | **9** | 0.69s | 7.8t | 12.9/s |
| macro 13/s, long | 49 | 3.81s | 7.7t | 13.0/s |

The count is bounded by how long the pounce lasts, so a macro on a SHORT pounce
slips under any count a mashing hand does not also trip. The mean interval is flat
at 7.7t across all three macro pounces. It then became a 12 TICK threshold with
"better than a 2x margin on both sides", which compared the macro to the hand
mashing in the air (5.1/s) and forgot the same hand's 8.0/s on the pistol: 12 ticks
is 8.3/s, the human peak, at severity high, on a single phase.

### Signature `pistol_rate`

The signature the measurements actually support. A `fire` burst on `weapon_pistol`
containing a window of at least **3 seconds** whose MEAN press rate is at or above
**12 presses/s** (so at least 36 presses), on **2 separate bursts** in one match.
Severity low.

- Mean rate, never variance, so 25 ms of jitter (cv 0.32, a human number) does
  nothing to it. Jitter is symmetric; it cannot move a three second mean.
- The FASTEST window inside the burst, not the whole burst, so a macro cannot
  hide by clicking slowly for a few seconds before the burst closes.
- Presses are measured, not shots. Dual pistols fire more bullets per second, but
  each is still one press, so a second pistol changes nothing here. The same goes
  for whatever a fire-rate clamp lets through.
- 12/s rather than the 11/s the raw numbers suggest: taking the fastest window of
  every burst is many draws per match, and in simulation a sustained 9/s hand is
  flagged in 23% of matches at 11/s and in none at 12/s.
- It will miss a macro only ever used in bursts under three seconds. That is the
  price of never flagging a hand that can sprint, and the threshold is a setting.

`scripts/rerun-input-signatures.ts [--dry-run] [--pounce-rate N] [--pistol-rate N]`
REBUILDS every detection from the stored bursts, in one transaction, running the
whole `SIGNATURES` list. It replaces rather than adds: a detection is a function of
the bursts and the current signatures, and the rows the 12 tick rule wrote are
false statements about players, not history. Bursts are never modified. This is
the whole point of approach C: a signature written in three weeks applies to
everything recorded from day one. Bursts recorded by plugin 0.1.0 stay in the
table and still count; a detection that rests on any of them says so in its note,
because they may include ghost spawn mashing and were timed by server tick.

## 4. Admin surface

- Admin feed posts when a detection row is CREATED: once per player, match and
  signature, with the hold annotation in the line.
- `/admin/players/<steamid>` "Input flags" panel: each flag with its hit count and
  note, the bursts it rests on with rate, presses and hold statistics, and a
  "capture truncated" warning listing any `cap` markers for the player.
- Integrity tab capture health counts truncations.
- Settings: `input_pounce_min_rate`, `input_pistol_min_rate`, presses per second,
  10 to 30. **Not `input_pounce_spam_threshold`**: that key was seeded into
  production as 12 (ticks) and seeding never overwrites an existing row, so
  changing its default would have changed nothing live. It is now ignored.
- Nothing is shown to non-admins. A detection is evidence, not an accusation.

## 5. Testing

- Encode/decode round trip, including the 1..30 boundary, the 256 cap and the 257
  hold cap.
- `burstStats` verified against the REAL measured runs above as fixtures.
- Calibration simulation, seeded: the old rule's false positive rate is asserted
  so nobody moves the threshold back, and both signatures must stay under 1% on
  legitimate hands and over 99% on the measured macro, jittered or not.
- Parser: chat-forgery rejection is the critical test, for bursts and for the cap
  marker, plus malformed lines, absent fields, out-of-range values, misaligned
  holds, an unknown wire version, and a 0.1.0 line parsing unchanged.
- Plugin: compiles clean, and lines 0.1.0 REALLY emitted are checked in as fixtures
  in `tests/inputBurstEndToEnd.test.ts`. **The 0.2.0 fixtures there are written
  from the format string, not captured**, because the shared test server could not
  be started during the 0.2.0 work. Replace them with captured lines the first time
  0.2.0 runs anywhere. Until then the plugin's runtime behaviour is unproven.
- Storage round trip, asserting on what comes back OUT of the database.

## 6. Shipping 0.2.0

Web first, then the plugin on an empty server. The web side accepts both wire
versions, so there is no window in which lines are refused. After the web deploy,
run the re-run tool with `--dry-run`, read what it would remove, then run it for
real: that clears the severity-high rows the 12 tick rule wrote today.

## OPEN POLICY QUESTION: are mouse-wheel binds legal here?

**Undecided, and only the owner can decide it.**

`bind mwheeldown +attack` and `bind mwheelup +jump` are old, common Source binds. A
free-spinning wheel produces press rates no finger can (20/s and up) with one-tick
holds, and it WILL trip `pistol_rate` and `pounce_spam`, exactly like a macro,
because at the level of "how often was the button pressed" it is one.

The capture now lets an admin tell them apart: a wheel is `wheel-like` with a rate
that decays as the wheel slows; a scripted macro is `fixed-hold`, or `wheel-like`
with a dead flat rate. What the capture cannot do is say whether the wheel is
ALLOWED. The options, as far as this document can see them:

1. **Wheel binds are legal.** Then `wheel-like` detections are expected noise, the
   panel should probably fold them away by default, and a wheel on the pistol is an
   accepted fire-rate advantage over a player clicking by hand.
2. **Wheel binds are illegal for `+attack`, legal for `+jump`.** The common
   competitive compromise: wheel-jump is a bhop aid, not an input the game
   rate-limits, while wheel-fire is a hardware fire-rate macro. Note the server
   cannot enforce this (memory: L4D1 clients ignore server-issued cvar commands,
   and a bind is client-side anyway), so it is a rule enforced by review.
3. **Wheel binds are illegal.** Then `wheel-like` is simply a second kind of hit.

Whatever the ruling, it has to be PUBLISHED to players before any flag is acted
on, because nobody using a fifteen year old bind thinks of it as cheating. Until
it is ruled on, a `wheel-like` detection must not be treated as evidence of
anything except that the player owns a mouse with a wheel.

## Not in scope

Automatic in-game action. Public display. A bhop signature (hops are captured one
line each, with ground time and jump hold, and nothing reads them yet). Variance
and order signatures, which wait for real player distributions. Aim analysis,
which is the replay analyser's job and a different cheat class.

Known limits worth writing down: jitter-clicking and butterfly-clicking players
exist and can briefly exceed 10 presses/s; nothing measured here says whether any
can hold 12/s for three seconds, which is one more reason severity is low. And any
fixed threshold can be ducked by throttling a macro to 10/s, at which point it is
no faster than a good hand and has stopped being an advantage.
