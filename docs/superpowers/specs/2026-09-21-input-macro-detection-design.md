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
| scope | capture all three anchors; ship ONE signature (count per event) |
| window | live matches only, so every burst carries a match |
| wire | raw interval list, order preserved |

Shipping one signature rather than none is deliberate: count-per-event needs no
statistical tuning (separating 2 from 40 is arithmetic, not a threshold), it is
Oryx's proven check, and it exercises the whole pipeline end to end. The rate and
variance signatures wait for real distributions, because the only human sample we
have is one person clicking for fifteen seconds.

## 1. Capture (plugin)

New plugin `l4d_inputstats.smx`. NOT added to `pug-match.sp`: that plugin runs
every live match on four servers and does not need a per-tick hook in it.

- `OnPlayerRunCmd`, full signature, always returns `Plugin_Continue` and never
  writes `buttons`. This must be incapable of changing the game.
- Hot path is ~800 calls/sec at 100 tick with 8 players: integer compares and
  array writes only, no string work. Formatting happens at burst close.
- **Press edges only.** A held button repeats every tick and drowns the signal.
- Three anchors: `fire` (consecutive `+attack`, with the active weapon, because an
  automatic weapon produces no press edges), `pounce` (landing to next `+attack`,
  plus `+attack` presses while airborne), `bhop` (landing to next `+jump`, plus
  ticks on ground).
- **Intervals in TICKS, not ms**, per measurement (3).
- Burst closes after 300ms of silence, per measurement (4).
- Both clocks recorded: server `GetGameTickCount` and the client's `tickcount`.
  The client value is attacker-controlled and is never used for timing, but the
  divergence is its own future signal and cannot be added retroactively.
- Caps: 256 intervals per burst, 64 bursts per player per round.
- **DEVIATION, decided during the build.** The design said the plugin would learn
  match state from a new `PugMatch_IsLive` native. It does not. `pug-match.sp`
  exposes no natives and has no state cvar, so adding one would mean modifying
  the plugin that runs every live match on four servers, and coupling two
  deploys: `l4d_inputstats` could not work at all until `pug-match` shipped too.
  Instead the plugin captures whenever a human is alive and the WEB drops any
  burst that does not resolve to a live match on the sending server, which it
  already knows from `resolveServerBySource`. Storage is therefore live-matches-
  only exactly as decided, with zero coupling. The cost is wire traffic during
  warmup, which the `n >= 3` burst filter and the empty-server case make small.
  If it ever proves a problem, the native is still the right fix.
- `l4d_inputstats_bots`, default 0, TEST ONLY: bots are the only way to exercise
  the capture path without a human at a keyboard. Bot input is not evidence.

## 2. Wire

`L4DM`, admitted exactly like `L4DC`: the marker must be the first token after the
engine's timestamp, from a known server address. The game server relays every
`say` line on the same stream, so an unanchored marker is forgeable from chat.

    L4DM id=<steamid64> k=fire|pounce|bhop w=<weapon> n=<count> g=<groundticks>
         a=<airpresses> st=<servertick> ct=<clienttick> d=<chars>

- **No name field. SteamID only.** The live roster-forgery bug is a name field
  carrying identity; there is no reason to repeat it.
- Encoding falls out of the burst rule: a burst closes at 300ms = 30 ticks, so
  every interval is 1..30 by construction and encodes as one printable character.
  **Base 48, `'0'`..`'M'`, not base 33.** Base 33 was the first choice and was
  wrong: `chr(34)` is a double quote and `chr(39)` a single one, and this line
  travels on the same stream as quoted chat. It was harmless for admission, since
  the marker is anchored at the start of the body, but there is no reason to put
  quote characters in that line when a different offset costs nothing. Caught by
  reading a line the plugin really emitted, not by a test: the unit test had spot
  checked three values that happened to be quote-free. 256 intervals fit one log line, so there is no
  chunking and no multi-packet rcon trap.
- Bursts of fewer than 3 presses are not emitted: noise, and most of the volume.
- One line per burst, at burst close.
- Estimated volume ~10-13k lines per four-map match, ~2/sec. To be checked against
  a real match rather than trusted.

## 3. Storage and analysis (web)

`input_bursts`: id, match_id, server_id, steamid, kind, weapon, n, ground_ticks,
air_presses, server_tick, client_tick, intervals TEXT, at TEXT. Indexed on
match_id and on (steamid, at).

`input_detections`: id, burst_id, match_id, steamid, kind, signature, severity, at.

`src/inputStats.ts` decodes and derives, per burst: n, mean, sd, cv, min, max, and
the order-dependent `sameAsNext` / `closeToNext` counts Oryx uses. Storing the raw
ordered intervals is what keeps those computable; a summary or a histogram would
discard exactly the information that catches a jittered macro.

**Signature v1, `pounce_spam`:** a pounce with `weapon_hunter_claw` whose MEAN
INTERVAL between attack presses is at or below 12 ticks (8.3/s), over at least 4
intervals. Severity high. Threshold is a setting.

This was a COUNT threshold (`air_presses >= 12`) and live testing killed it.
Measured 2026-09-21 against a real client:

| | presses | airborne | mean interval | rate |
|---|---|---|---|---|
| normal pounce | 3 | 2.03s | 15.5t | 6.5/s |
| **hand MASHING M1** | 8 | 1.61s | 19.7t | 5.1/s |
| macro 13/s, short | **7** | 0.57s | 7.7t | 13.0/s |
| macro 13/s, short | **9** | 0.69s | 7.8t | 12.9/s |
| macro 13/s, long | 49 | 3.81s | 7.7t | 13.0/s |

The count is bounded by how long the pounce lasts, so a macro on a SHORT pounce
registers 7 or 9 presses and slips under any threshold that a mashing hand (8)
does not also trip. Only a freak 3.8 second leap exceeded it. The mean interval
is flat at 7.7t across all three macro pounces regardless of length, because it
does not depend on airborne time at all. A hand mashing as hard as it can reached
5.1/s; the macro is more than twice that.

The earlier claim that this signature "needs no tuning because it separates 2 from
40" was wrong. It is a tuned threshold sitting between two human-reachable
numbers, and it earned that threshold from measurement rather than from argument.

`scripts/rerun-input-signatures.ts` recomputes detections over stored bursts, which
is the whole point of approach C: a signature written in three weeks applies to
everything recorded from day one.

## 4. Admin surface

- Admin feed posts on the FIRST detection per player per match, not per burst.
- `/admin/players/<steamid>` gains an "Input flags" panel beside "Connect drops".
- Settings: `input_stats_enabled`, `input_pounce_spam_threshold`.
- Nothing is shown to non-admins. A detection is evidence, not an accusation.

## 5. Testing

- Encode/decode round trip, including the 1..30 boundary and the 256 cap.
- `burstStats` verified against the REAL measured runs above as fixtures: the
  human sample must not flag, both macro samples must be separable on rate.
- Parser: chat-forgery rejection is the critical test (a `say` line containing a
  whole `L4DM ...` body must be refused), plus malformed lines, absent fields,
  and out-of-range values.
- Signature: a synthetic pounce burst at 1-2 presses does not flag; at 20 it does.
- Plugin: compiles, loads, and lines it REALLY emitted are checked in as fixtures
  in `tests/inputBurstEndToEnd.test.ts`, so the plugin's format and the parser
  cannot drift apart silently.
- Storage round trip, asserting on what comes back OUT of the database. This is
  not redundant with the encode/decode test: `recordInputBurst` once held its own
  inlined copy of the encoder, and when the alphabet changed, storage wrote one
  base while the decoder read another. Every stored burst decoded to nothing, and
  re-run found zero detections, while the encode-only and decode-only tests both
  stayed green throughout.

## Not in scope

Automatic in-game action. Public display. Rate and variance signatures, which wait
for real player distributions. Aim analysis, which is the replay analyser's job and
a different cheat class.
