# Replay viewer avatars, states and events on the map

Design agreed 2026-09-13 with the owner over a mockup session (the screens are
in `.superpowers/brainstorm/758867-1789278712/content/`, git-ignored). Builds on
`2026-09-12-replay-viewer-design.md` (the viewer) and spec 7.2 in
`2026-09-12-theater-mode.md` (bookmarks). This piece changes what the map
DRAWS and adds the map side of the bookmarks. It adds no recording and no
format change.

## Why

The map today draws every player as a 14px slot-coloured dot with a digit, a
2px health arc, a gold or red ring for pinned and down only, and a 7px letter
for everything else. Biled and burning have no colour on the map at all,
infected class shows only on the HUD card, world entities are 4 to 10px dots,
and events exist only on the rail and the scrub bar. The owner's words: "icons,
what things represent, viewability", and "if you're boomed have purple around
it".

## Decisions taken in the session

Each was a screen the owner picked from.

1. **Medallions, not sprites.** Faces for survivors, class pictograms for
   infected, inside a slot-coloured rim. Full-body sprites on a ground ring
   were mocked up and rejected for now ("meh, medallions is better").
2. **One state ring, priority order.** Pinned, down, hanging, burning, biled.
   Stacked rings rejected.
3. **Events stay on the map, filtered by kind then by player**, and the default
   is everything for everyone.
4. **World entities at the "medium" scale**: commons as 7px figures, AI
   specials and the witch as 18px medallions, AI tank 30px, rock 10px with a
   streak.
5. **Facing is a wedge on the rim.** The stub arrow goes.
6. **Hover tooltips plus a Key toggle** for the legend.

## Scope

In: `web/src/replay/draw.ts` and its tests, a portrait image cache, inline
pictogram paths, a state palette with dichromacy tests, marker and burst
rendering, the Show and for filter controls, canvas hit testing with tooltips,
the Key panel, and the Toggles and Viewer wiring those need.

Out: any recorder or format change; the live page (it has no timeline, so it
gets bursts and markers only if a live timeline is ever built, which
`src/routes/replays.ts:367` already says needs its own cutoff); the HUD strip,
which already shows portraits and states; deploying the format 3 plugin.

## 1. Player medallions

Replaces the dot in `drawScene`. All sizes are CSS pixels, fixed at every zoom
exactly as the chrome constants are today.

- **Size.** `avatarRadius` base goes from 7 to 11 (22px). The plus or minus 20
  percent height scaling stays. A player tank (infected with `cls` = tank) uses
  base 15 (30px), the same as the AI tank, so the biggest thing on the field is
  drawn biggest.
- **Survivor face.** `portraitFor(cls, header.version, true)` already picks the
  file; the same function feeds the canvas so the HUD and the map cannot
  disagree. The image is clipped to the disc. Version 1 files and out of range
  indices get the silhouette, as the HUD does.
- **Infected pictogram.** A dark disc (`#14110f`) with a white class figure for
  smoker, boomer, hunter and tank from `ZOMBIE_CLASSES[cls]`, drawn from inline
  SVG path data via `Path2D`, scaled to the disc. No image files. An unknown
  class (0, or a witch player which cannot happen in versus) draws the disc with
  no figure.
- **Rim.** 2.5px stroke in `slotColor(slot)`, with a 1px near-black outer edge so
  a cyan rim survives a pale patch of map.
- **Digit badge.** A 9px filled disc in the slot colour at the rim's lower right
  (angle 45 degrees), 7px bold digit in `numberInk`. Same digit as today
  (`slotNumber`). Replaces the digit in the centre, which the face now occupies.
- **Facing wedge.** A 5px isoceles triangle sitting on the rim, apex outward,
  rotated to yaw with the same sign convention the arrow used (`-sin` for
  canvas y). Drawn in the slot colour with the dark outline. Replaces the stub
  arrow entirely.
- **Ghost.** Unchanged in spirit and stricter in letter: a hollow 2px ring in
  `GHOST_COLOR` at the medallion radius, alpha 0.35, and nothing else. No
  pictogram, badge, wedge, arc, label, state ring or follow ring. The class of
  an unspawned infected is exactly what the anti-ghosting delay hides, so the
  pictogram is withheld. The existing ghost tests keep passing and gain "no
  drawImage, no Path2D fill" assertions.
- **Dead.** Rim in the dead grey (`#6d675e`), portrait or pictogram drawn at
  0.55 brightness through a desaturating pass, a dagger glyph centred where the
  face is, no badge, arc or wedge. Alpha 0.7 rather than today's 0.3, because a
  dead survivor's position is worth reading. A dead infected is the same
  treatment; they become a ghost within seconds anyway.
- **Draw order** inside one medallion: state ring, rim outline, rim, disc and
  face or pictogram, wedge, badge, health arc, glyph, follow ring. Infected
  before survivors, as today.
- **Portrait loading.** A `usePortraits(header)` hook resolves the six portrait
  files once into `HTMLImageElement`s and hands `drawScene` a
  `Record<string, HTMLImageElement>`; an image not yet decoded draws the disc
  and rim without a face for that frame, which is the same fallback the
  backdrop uses. Repaint is triggered when an image finishes, through the same
  dependency list the backdrop is in.

## 2. State ring, health arc, glyph

- **State ring.** One 3px ring at radius `r + 1.5`, hugging the rim. Colour by
  the first state that applies, in the order `statusGlyph` already uses:

  | state | colour | note |
  |---|---|---|
  | pinned | `#c9a45c` | today's alert gold |
  | incap | `#de4e40` | today's alert red |
  | ledged | `#de4e40` | same as incap, as today |
  | burning | `#ff7a1a` | provisional |
  | biled | `#a85cf0` | provisional |

  `alertColor` becomes `stateRingColor` and returns for all five states. The
  ring is drawn for BOTH teams: a burning tank, a biled hunter (a boomer's bile
  hitting its own team is real) all read.
- **Glyph.** `statusGlyph` is unchanged and stays above the medallion. The
  glyph and the ring pick from the same priority list, so they can never
  disagree; a test asserts that for every subset of the five bits.
- **Health arc.** Moves outside the state ring to radius `r + 5.5`, 2px, and
  keeps `healthBar`'s two-part treatment, the incap pool sliver, and the sage
  temp colour. It now draws for a living player tank as well, over the 8000
  pool `HudStrip.maxHealthFor` uses, so the two surfaces agree on what a tank
  has left. Other infected still get no arc.
- **Follow ring.** Radius `r + 10`, unchanged in look, outside everything.
- **Label.** Plate left edge moves to `r + 13` so it clears the follow ring's
  halo; label stacking is untouched.
- **Palette proof.** `draw.test.ts` gains the two provisional colours and the
  dead grey in the same CIELAB and dichromacy harness the slot colours use.
  Requirements: the five state colours (four distinct values) at least 18 dE
  from one another under normal, protan and deutan vision; each at least 15 dE
  from every slot rim it can sit beside, which is all eight; and each at least
  15 dE from `GHOST_COLOR` and the dead grey. If a provisional value fails,
  tune the value, not the threshold. Pinned gold sitting 1 dE from infected
  slot 6's gold is expected to fail the rim test and is accepted by name in the
  test, because a survivor's gold ring is always adjacent to a cool rim and an
  infected's gold rim never carries a gold ring; the same by-name exception is
  the only kind allowed.

## 3. World entities

`ENTITY_STYLES` becomes a table of `{ color, radius, shape }`. Colours are
today's, already tested against the slot palette.

| kind | today | now | shape |
|---|---|---|---|
| common | 2 | 3.5 | head-and-shoulders figure: ellipse 7x5 plus a 2px head disc in a darker shade |
| witch | 5 | 9 | medallion, witch pictogram |
| tank rock | 3 | 5 | six-point polygon plus a streak |
| AI tank | 9 | 15 | medallion, tank pictogram |
| survivor bot | 6 | 9 | medallion, silhouette portrait |
| AI smoker, boomer, hunter | 5, 6, 5 | 9 | medallion, class pictogram |

- **Entity medallions** use the same primitive as players with the entity
  colour as rim and no badge, since there is no slot. A ghost AI special stays a
  solid dot as today (the comment at `sceneCounts` explains why).
- **Rock streak.** The rock's velocity is the difference between its position in
  the two frames `bracket` returns, so a 12px line trails the rock along the
  reverse of that vector, fading to nothing. Zero velocity, no streak.
- **Witch after aggro.** When the timeline has a `witch_aggro` event before the
  playhead with no `witch_killed` after it, every witch entity's rim is the
  alert red instead of white. There is at most one witch alive on an L4D1 versus
  map, so no matching is attempted.
- **Commons under CI toggle, others under Ents**, as today.

## 4. Pins, bursts and markers

All three derive positions the same way: `bracket(frames, tMs)` gives the two
frames around an event's time, `header.slots.indexOf(steamid)` the slot, and
the interpolated sample the position. An event whose actor and target both
fail to resolve (unrostered, or slot empty at that time) has no position and is
skipped for the map; the rail still shows it.

### Pin lines

While a survivor has `STATE.PINNED`, a 2px line in the pinner's slot colour
runs from the pinner's medallion edge to the victim's, dark-haloed. The pinner
is the actor of the most recent `pinned` event for that victim; if none has
been seen (timeline missing or the pin predates the first frame) no line is
drawn. This is the one piece of state carried across frames, kept in a small
`PinTracker` fed by the timeline in seq order, reset on seek.

### Bursts

Short-lived, driven by wall time since the playhead crossed the event's `tMs`
during forward playback; a seek does not replay bursts. Each kind:

| kinds | at | shape | life |
|---|---|---|---|
| boom | target | purple pulse: filled disc fading, ring expanding 10 to 30px | 1000 ms |
| dp, incap, death | target | red flash line actor to target plus a 12px pulse at target | 500 ms |
| skeet, cleared | target | white ring burst 8 to 26px | 600 ms |
| pinned | target | green line actor to target, then the pin line takes over | 300 ms |
| ff | target | none (the value is on the rail; a flash on every FF tick is noise) | |
| witch_aggro, witch_killed, tank_death, car_alarm | actor | white ring burst | 600 ms |

Bursts ignore the Show and for filters; they are playback, not lookup. They are
drawn under the medallions.

### Markers

A 12px square tag with a 2px border in the kind's colour, near-black fill, a
7px bold kind letter in white, at the event's position. Kinds and letters:

| kind | letter | colour |
|---|---|---|
| boom | B | purple |
| dp | P | red |
| skeet | S | white |
| cleared | C | white |
| incap | X | red |
| death | dagger | light grey |
| pinned | T | green |
| tank_death | K | white |
| witch_aggro, witch_killed | W | white |
| car_alarm | A | gold |
| ff, revive | F, R | excluded from All events; shown only when Show is set to them |

Not mapped: `si_spawn`, `tank_spawn`, `tank_take`, `tank_give`, chat.

- **Filters.** Two `<select>`s in a new row above the stage, under the toggles:
  Show (All events, which means every mapped kind except ff and revive, then one
  entry per mapped kind that occurs in this timeline, with counts) and for (Everyone, then the rostered players by name).
  "for" IS the follow row's selection: choosing a player in either updates the
  other. Default All events, Everyone. Stored with the toggles under
  `replay.toggles` so it survives a reload, with the same merge-over-defaults
  reading.
- **Numbering.** With a player chosen, tags carry a badge with their index in
  that player's filtered list, which is the order the rail shows them in, so
  "boomed at 2" is the same 2 in both places.
- **Time.** Tags for events after the playhead are drawn at alpha 0.45, like
  the rail dims entries ahead. Nothing is hidden by time; the whole round is
  always on the map, because "where did I get boomed" is a question about the
  round.
- **Click to seek.** A pointer down within 8px of a tag's centre seeks to its
  `tMs`. Tag hit-testing shares the hit-test pass tooltips use (section 5).
- **Layering.** Under the medallions and over the trail, so a tag never hides
  a player and a player standing on a tag hides only the tag.
- **Marker toggle.** The Events toggle already exists; it now also governs
  markers and bursts. Off means the rail, the scrub ticks, the tags and the
  bursts all go.

## 5. Tooltips and Key

- **Hit testing.** `hitTest(scene, px, py)` returns the topmost of: player
  medallion (within `r + 6`), entity (within its radius plus 4), marker (within
  8), or null. Runs on pointermove over the canvas at most once per animation
  frame, using the same projected positions the last paint used, which
  `ReplayCanvas` records in a ref alongside the existing `shiftRef`.
- **Tooltip.** One absolutely positioned element over the stage, 12px, dark
  plate, placed above and right of the pointer and flipped when it would leave
  the stage. Content: player, "name, class or character, states as words
  (`statusFlags`), health as `HudStrip` formats it"; entity, "Common",
  "Witch, startled", "AI tank, 6200"; marker, `formatTime(tMs)` plus
  `eventSentence`. Never a SteamID64: names resolve through the roster and fall
  back to `slotLabel`. Hidden on pointerleave and while dragging the camera.
- **Key.** A `Key` chip in the toggle row (persisted like the others) shows a
  panel anchored to the stage's top-left: the eight slot rims as two rows of
  four, the five state rings with their words, ghost and dead, the seven
  pictograms, the entity shapes, and the marker letters. It is rendered from
  the same exported tables the canvas draws from (`SLOT_COLORS`, the state
  table, `ENTITY_STYLES`, the marker table), so adding a kind adds it to the
  key with no second edit. Closes on Escape and on the chip.

## 6. Code shape

- `draw.ts` is already 900 lines. This piece splits it: `draw.ts` keeps
  `drawScene`, the palette exports and label stacking; `avatar.ts` gets the
  medallion primitive (`drawMedallion(ctx, spec)`) shared by players and entity
  medallions; `pictograms.ts` gets the path strings and a `Path2D` cache;
  `stateRing.ts` the state table and priority; `markers.ts` the kind table,
  filters (`markerEntries(timeline, kind, selected)`) and burst timing;
  `hitTest.ts` the hit pass. Each is unit-testable without a canvas.
- `bookmarks.ts` `tickEntries` gains an optional kind parameter so the scrub
  ticks, the rail and the map filter from one function.
- `Toggles` gains `key: boolean`, `showKind: string` ('all' or a kind slug)
  and nothing for the player, which stays in `Follow`.
- `DrawArgs` gains `portraits`, `timeline` (already filtered to the mapped
  kinds), `markerFilter`, `bursts` (the active list with start times), `pins`
  (from the tracker) and `nowMs` (wall clock for burst fade).

## 7. Testing

- Stub-context tests in `draw.test.ts`: a survivor medallion issues one
  `drawImage` with the portrait for its `cls` and version; a v1 survivor draws
  the silhouette; an infected fills a `Path2D`; a ghost issues none of
  drawImage, Path2D fill, fillText or the badge arc; a dead player uses the dead
  grey and no arc; the wedge's rotation matches yaw for four cardinal angles;
  the state ring colour equals the table entry for the winning bit for every
  subset of the five bits and always agrees with `statusGlyph`; the tank arc
  sweeps `health / 8000`.
- Palette tests as in section 2.
- `markers.test.ts`: filtering by kind, by player, by both; numbering equals
  rail order; unresolvable positions are dropped; burst life and shape per
  kind; the witch aggro window.
- `hitTest.test.ts`: topmost wins, radii, an empty scene.
- Component tests: the Show select lists only kinds present with counts;
  choosing a player in the follow row updates for and vice versa; the Key panel
  lists every state colour and every marker letter from the tables.
- Visual check on the seeded local match through the `pug-dev` launch config,
  and a screenshot pass with `npm run shoot` at 1400 and 390.

## 8. Not recorded, so not drawable

Listed so nobody looks for them in the viewer. Each needs a recorder change
(a new `ENTITY_KIND` or event) before it can be drawn:

- Molotov and gascan fire areas, and pipe bomb positions and timers.
- The smoker tongue as a path; only the pin is known, so the pin line is
  straight.
- Pills and kit use, and item pickups.
- Hunter pounce flight; only the landing is known.
- Which common is targeting whom, and common health.
- Tank rock hits (the rock entity just disappears).

## 9. Dependencies and risks

- **Survivor faces on real recordings need the format 3 plugin** (which
  includes format 2's character byte). It is compiled and not staged; staging
  is a separate live-box go-ahead. Until then every survivor medallion carries
  the silhouette, which still leaves rim, digit, state ring and arc as
  improvements.
- **Cluster density.** Four survivors within eleven canvas pixels at fit zoom
  will overlap as 22px medallions; they overlapped as 14px dots too. The
  survivor draw order is stable (slot order) so the overlap does not flicker,
  and the follow-team camera at 2x resolves it. If it reads badly in practice
  the base radius is one constant.
- **Per-frame cost.** Medallions add a clip, a drawImage and a badge per player
  per frame; commons add a second ellipse each. `renderRate.test.tsx` already
  guards the render budget; the draw loop should stay under 2 ms for eight
  players and forty commons on the reference laptop, measured once with the
  Performance panel before merge.
- **Anti-ghosting.** Nothing here relaxes it. The pictogram withheld from
  ghosts, the pin line only ever drawn to a spawned pinner, and the markers
  drawn only from a completed match's timeline are the three places it could
  have leaked.

## Resolved 2026-09-13

Sprites on ground rings (rejected for now, may return as an option once the
medallions ship), stacked state rings (rejected), always-on legend strip
(rejected), event markers default (everything for everyone), entity scale
(medium), facing (wedge on rim), legend (tooltips plus Key toggle).

## Built 2026-09-13

Tasks 1 to 10 of `docs/superpowers/plans/2026-09-13-replay-viewer-avatars.md`.
Pinned gold moved from #c9a45c to #e0b654 (see stateRing.ts). Biled purple is
exempt from the dichromacy rim test against survivor slots, by name, with the
B glyph as the channel. Draw cost measured at 0.19 ms mean script time per
frame (1.83 ms mean task time per frame; CDP `Performance.getMetrics` deltas
over 600 rAF frames across a 10 s window at 1x playback on the standalone
cluster fixture, `/replay/file/pug_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0_1.rpl`,
eight players and its 14 commons); both clear the 2 ms budget. rAF interval
held at 16.7 ms median / 16.8 ms p95 (steady 60 fps, no jank) over the same
window.

The state ring and arc centre radii shipped at r + 3.75 and r + 6.5, not the
r + 1.5 and r + 5.5 this spec's section 2 first proposed: those two could not
both clear the 2.5px rim plus its 1px edge without overlapping it. See the
derivation in `avatar.ts` (`STATE_RING_GAP`, `ARC_GAP`).

Bookmark seeks land `BOOKMARK_LEAD_MS` (3 s) before the event's own
timestamp, not on it, per an owner request made 2026-09-13 after the first
build: landing exactly on the event showed its aftermath rather than the
moment itself. See `timeline.ts`.

The tooltip anchors to the hit item's own recorded canvas position, not the
live pointer: `Viewer.tsx` stores `hover.px/py` from the hit test and shifts
it by the follow camera's translate on read, so the tooltip stays pinned to
the medallion or marker as the camera pans instead of trailing the mouse.

Visual pass (`npm run shoot` at 1400/390 on match 9001, plus the cluster
fixture at 6x zoom): medallions show silhouette faces, rim, and state ring as
designed; the cluster fixture's four overlapping survivors resolve to
distinct numbered badges (S1 to S4) once zoomed past the overlap. No route
reported horizontal overflow. Full detail in
`.superpowers/sdd/2026-09-13-replay-viewer-avatars/task-11-report.md`.

## Amended 2026-09-13 (owner review of the live build)

- Pinned is the red (#de4e40) and gets a breathing halo (PIN_PULSE_MS 900, gap 13, swing 6) plus a
  thicker pulsing pin line; down and hanging move to the gold (#e0b654). Red means act now.
- Ghosts are named on every surface: class figure, slot digit and name label in the muted ghost
  colour, a tooltip "name · Class · unspawned", a hit item. Still withheld: facing, arc, state ring,
  follow ring, and any event position. The ten second server-side delay is the anti-cheat protection.
  Section 1's "Ghost" bullet and the anti-ghosting trace are superseded to that extent.
- Bookmark seeks land 3 s early; durations in the feed and rail read as words ("for 1.3 seconds").
