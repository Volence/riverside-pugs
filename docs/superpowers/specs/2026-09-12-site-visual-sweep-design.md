# Site visual sweep: design

Written 2026-09-12. Status: approved in conversation, awaiting review of this
document before planning.

Reference canvas (the approved look, plus the three directions it was chosen
from on a second page): https://claude.ai/code/artifact/7f1d586e-6bfd-4382-bf39-0f41f59f758e
Working files for the canvas: `design/site-directions/`.

## 1. Why

The site works and reads well, but every page is built from the same three
shapes: a rounded panel, a stat card with an amber left rule, and a plain
table. Nothing on screen says Left 4 Dead except the map art inside the replay
canvas. The owner's words: it feels generic. This sweep gives the site one
visual identity and applies it to every route, without changing what any page
does or what any number means.

## 2. The direction, in one paragraph

Structure from a versus HUD, voice from a campaign poster. Pages keep the dense,
data-first layout they have now (scoreboards, tables, health tiles), but the
chrome around the data is poster grammar: bone type on near-black, blood-red
rules, tall condensed display type for titles and hero numbers, tracked caps
for labels, film sprockets framing the replay stage, and campaigns presented as
poster tiles. Grain and a soft vignette sit behind everything so panels stop
reading as flat rectangles.

## 3. Tokens

`web/src/styles/tokens.css` is rewritten in place. Every color, space and type
step on the site already resolves to this file, so the sweep is an edit here
plus per-component restyling, never a grep for hex values in components.

### 3.1 Surfaces and text

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0b0908` | page |
| `--surface` | `#15110e` | panels, nav |
| `--surface-2` | `#1c1713` | panel headers, hover rows |
| `--border` | `rgba(217,203,176,0.14)` | hairlines |
| `--border-strong` | `rgba(217,203,176,0.28)` | focused or active edges |
| `--text` | `#d9cbb0` | body |
| `--text-bright` | `#efe2c4` | titles, names, primary numbers |
| `--text-muted` | `#958770` | labels, secondary columns |

Contrast is recomputed with WCAG relative luminance and recorded in the token
comments the way the current file does. Body text on every surface it is used
on must clear 4.5:1. `--text-muted` on `--surface-2` is the tightest pair and
must be checked, not assumed.

### 3.2 Accents, with fixed roles

| Token | Value | Only ever used for |
|---|---|---|
| `--accent` | `#de4e40` | interactive: links, active chips, scrub progress, focus rings, the live dot |
| `--rule` | `#9b2a22` | the one red rule under a page header or panel header |
| `--rating` | `#c9a45c` | SR and rating numbers, and the rank numerals of the top three |
| `--win` | `#45b39c` | wins, survivor health, survivor team marks |
| `--loss` | `#de4e40` | losses, infected team marks (same hue as accent by design) |
| `--draw` | `#8d7f66` | draws |

`--accent-ink` becomes `#0b0908`, the page black: bone on this red is only
3.1:1, so a filled button carries dark ink. The amber tokens
(`#e3892b`, `--accent-ink #1a1206`) are deleted. Nothing aliases them, and the
tokens test (section 8) fails if either hex survives anywhere in `web/src`, so
a component that still names amber cannot slip through.

The urgent state (`[data-urgent='true']`) keeps its mechanism: it reassigns
`--accent` locally. Because the accent is already red, urgency instead
brightens it to `#e8503f` and raises the nav rule to 3px so the state is still
distinguishable from calm red.

### 3.3 Campaign tints

The four hand-picked tints stay for the four L4D1 campaigns. Every other
campaign slug gets a tint from one deterministic function, so a custom campaign
looks intentional the first time it appears, with no stylesheet edit.

- New helper `campaignTint(slug): string` in `web/src/format.ts`, next to
  `campaignName`. Known slugs return their token value. Unknown slugs hash to a
  hue on a fixed saturation and lightness (oklch, chroma 0.06, lightness 0.42)
  so every tint sits at the same visual weight as the four originals.
- The attribute selectors `[data-campaign='no_mercy']` and siblings in
  `app.css` are removed. Components set `style="--campaign: <tint>"` from the
  helper instead. One place decides color; the stylesheet only consumes
  `--campaign`.
- The tile row (section 5.3) and the match list's left rule both read this
  variable.

### 3.4 Type

| Token | Value |
|---|---|
| `--font-display` | `"Anton", Impact, "Arial Narrow", sans-serif` |
| `--font-label` | `"Oswald", "Arial Narrow", sans-serif` |
| `--font-body` | `"IBM Plex Sans", system-ui, sans-serif` |

Anton for titles, hero numbers, rank numerals and ratings. Oswald for
eyebrows, nav, chips, column headers and player names in tables. Plex for
body copy and table digits, with tabular figures kept as the table default.
Barlow Condensed is dropped from `index.html` and Anton and Oswald are added;
the Google Fonts request stays a single stylesheet link with `display=swap`.

Type scale is unchanged except `--fs-hero` rises to 5rem for the versus
scoreboard and profile rating, and a new `--fs-title` at 2.25rem for page
titles in Anton, which sets tighter than Barlow did.

`--radius` becomes 0 and `--radius-lg` becomes 2px. The poster voice has
square corners; the only rounded shapes left on the site are dots and rings.

### 3.5 Atmosphere

Two layers on `body`, defined once as tokens so pages never restate them:

- `--grain`: an inline SVG `feTurbulence` tile at low alpha (0.14), the same
  one the canvas mockups use.
- `--vignette`: a radial gradient that darkens the outer 40 percent of the
  viewport, plus a faint warm red bloom at the top center.

Both are `pointer-events: none` by nature (they are backgrounds) and must not
be repeated on panels; a panel is flat `--surface` over the textured page.

## 4. Shell

### 4.1 Nav

Height 62px, `--surface` at 70 percent alpha over the textured body, one
hairline below. Wordmark "Riverside" in Anton at 26px, tracked 0.06em. Links
in Oswald 13px tracked 0.16em, muted, with the active link bright and
underlined by a 2px `--accent` rule. On the right, a live indicator: a red dot
with a soft glow and "Live · <campaign> <map> · <score>" in Oswald 12px when a
match is live, otherwise nothing. The urgent-state red rule survives.

"Maps" is renamed "Campaigns" in the nav and in the page title. The route
stays `/maps` so nothing bookmarked breaks.

### 4.2 Page header

Every route uses one header component (new `PageHeader` in
`web/src/components/bits.tsx`): an Oswald eyebrow, an Anton title, an optional
right-side slot for a season label or a count, and a 2px `--rule` beneath.
Summary numbers that today live in a row of stat cards move into this header
as Anton numerals with eyebrows, laid out with flex and gap. The `Tile`
component and its amber left rule are removed once every route has migrated.

### 4.3 Panels and tables

Panels are `--surface` with a hairline border and square corners. A panel
header is Anton title left, Oswald eyebrow right, `--rule` beneath. Tables
inside a panel run edge to edge with hairline row dividers and no outer
border of their own.

## 5. Components

### 5.1 Stat table

`StatTable` is the shared component for leaderboard, match totals, map tables
and profile history. Changes:

- Rank column in Anton 22px. Ranks 1 to 3 in `--rating`, the rest muted.
  Numerals are zero-padded to two digits so the column keeps a fixed width.
- Player names in Oswald 16px tracked 0.08em, bright. Links keep the accent
  hover, not the resting color, so a table is not a wall of red.
- Rating column in Anton 24px `--rating`. Friendly fire column muted.
- The top row carries a gold wash: a left-to-right gradient from `--rating`
  at 10 percent alpha to transparent at 45 percent.
- Column headers in Oswald 11px tracked 0.18em, muted, with the sorted column
  in `--rating` and a ▾ glyph.
- Row height 46px. Hover lifts the row to `--surface-2`.

### 5.2 Chips (buttons and toggles)

One `.chip` class replaces `.replay__btn`, the vote buttons and the queue
buttons: Oswald 12px tracked 0.12em, 5px by 10px padding, hairline border,
muted text, `--surface` fill at 85 percent alpha. Active or pressed: border
and text turn `--accent` and bright respectively. Primary action (join queue,
ready) is a filled chip: `--accent` fill, `--accent-ink` text, 8px by 14px
padding. Minimum hit target 36px tall on desktop and 44px on phone widths.

### 5.3 Campaign poster tiles

A grid of tiles, one per campaign, each 150px tall: a dark vertical gradient
in the campaign's tint, a heavy inset vignette, an Oswald eyebrow line
(match count and last score, or "Unplayed"), and the campaign name in Anton
30px at the bottom left. The tile for the campaign in focus gets a `--rule`
border. Unplayed campaigns render at 55 percent opacity.

Data: the union of campaigns present in match data and the current map pool,
in map-pool order first, then by most recent match. Names go through
`campaignName` so an unregistered slug still displays. Appears on Play (as the
campaign vote surface, replacing the vote list) and on Campaigns. Not on other
pages.

### 5.4 Versus scoreboard header

Used at the top of Match detail and Live. Three columns: Team A eyebrow in
`--win` and its four names in Oswald 20px; the two scores in Anton at
`--fs-hero` with the leader in `--rating` and the other bright, separated by a
muted slash; Team B eyebrow in `--loss` and names right-aligned. A faint
gradient wash runs teal at the left edge to red at the right. Hairline above,
`--rule` below. "Survivors first" and "infected first" eyebrows come from the
existing half data.

### 5.5 Headliner card

Profile hero, and the side card on Leaderboard for the top-rated player. An
eyebrow, the name in Anton 40px, the rating in Anton 72px `--rating` with a
2px dark drop shadow, a season delta eyebrow in `--win` or `--loss`, then a
three-up grid of small Anton numbers with eyebrows.

### 5.6 Countdown

Keeps its behavior. The number is Anton at `--fs-hero`. The final ten seconds
use the urgent state exactly as today.

### 5.7 Dev panel

Unchanged. It is a tool, not part of the site's face.

## 6. Pages

Each route is one migration step (section 8). What changes per page:

- **Play.** Header with queue count. Queue as a panel of chips. Campaign vote
  as the poster tile grid. Countdown restyled.
- **Live.** Versus scoreboard header, then the viewer (section 7). "LIVE, 10s
  delayed" becomes an Oswald eyebrow in `--accent` inside the HUD overlay.
- **Leaderboard.** Header with players and matches-rated counts. Stat table
  left, headliner card right, as in the canvas.
- **Matches.** Header with match count. Match list keeps its left tint rule,
  now from `campaignTint`. Closest and widest move into the header as numbers
  with the campaign name as an eyebrow.
- **Match detail.** Versus scoreboard header replaces the score block and the
  three SI/commons/FF cards, which become eyebrowed numbers beneath it. Match
  totals table restyled. Per-map viewers each get the section 7 treatment.
- **Campaigns (Maps).** Header, poster tile grid, then per-campaign tables.
  The "Other" grouping stays for maps whose campaign is unknown.
- **Map detail.** Header with the map's campaign as an eyebrow; tables
  restyled.
- **Replays.** Header with session and round counts; session panels restyled.
  Filenames stay in the mono style.
- **Replay page.** Viewer only, section 7.
- **Profile.** Headliner card as hero, then history table.

## 7. Replay viewer

The canvas drawing code changes only where it paints chrome. Positions,
interpolation, layer selection and the playback loop are untouched.

- **Stage.** Film sprocket bands 26px wide on the left and right of the
  stage, drawn in CSS by `Viewer.tsx` around the canvas element, inside the
  existing aspect-ratio box. The vignette is a CSS inset shadow over the
  canvas at 110px blur and 0.8 alpha, lighter than the poster direction, so
  infected rings keep contrast against the art. No sepia filter on the art:
  the mockups' 0.25 sepia flattened the infected marker's red, and the map
  overviews are already warm.
- **HUD overlay.** Time in Anton 40px, "of <end>" eyebrow, alive and entity
  counts as a `--win` eyebrow, all top left inside the stage. Toggle chips top
  right inside the stage. `ReplayControls` keeps ownership of the toggle
  state; only where they render moves. The `replay__status` line below the
  stage is removed, its content having moved into the overlay.
- **Scrub.** `TimelineRail` and the scrub bar merge visually into one
  filmstrip: a 22px strip with 26px frame divisions, progress as `--rule` at
  70 percent alpha, a 2px bright playhead, and event ticks colored by kind
  (infected events red, survivor events teal, item and score events gold).
  Seeking behavior is unchanged. Chat entries stay in the rail's list below.
- **HUD strip.** `HudStrip` renders the portrait tiles: team-colored left
  stripe, slot number and name in Oswald, health in Anton colored by
  threshold (teal above 60, gold 30 to 60, red below 30, muted for ghost),
  a health bar, and an eyebrow for weapon or infected class.
- **Canvas chrome** (`draw.ts`): label plates become `rgba(5,4,3,0.78)` with a
  2px slot-colored left tick, unchanged in geometry. The grid fallback and the
  clear color follow `--bg`. The incapacitated and pinned ring colors move to
  the `--loss` and `--rating` values. `SLOT_COLORS`, `GHOST_COLOR` and every
  entity color are unchanged: they were tuned for color-blind separation and
  `draw.test.ts` enforces the distances.

### 7.1 Theater mode

Reference: the l4dpug.com replay visualizer, whose immersion comes from three
things this section reproduces: a close camera, a HUD drawn on the map edges,
and chrome that gets out of the way.

**Entry and exit.** A "Theater" chip on the viewer's toggle row. Entering makes
the viewer fill the viewport and requests browser fullscreen where the API is
available. Escape, the same chip, or leaving fullscreen returns to the page
with scroll position preserved. One viewer, one URL: theater is a layout state
of `Viewer`, never a separate route.

**Camera.** A view transform is added to the canvas: zoom levels fit, 2x, 4x
and 6x on a chip group, plus mouse wheel zoom centered on the cursor and drag
to pan. Follow is on by default in theater and centers on the survivor
centroid; choosing a player in the follow row centers on them instead, which
the follow camera already does. Any drag turns follow off; the follow chip
turns it back on and clears the pan. The transform lives in `View` as a scale
and offset applied after the content-box fit, so `projectView` and the follow
camera keep working unchanged and `drawScene` needs no knowledge of zoom. A
world position under the cursor is recoverable from the inverse, which is
what drag needs.

**Edge HUD.** Survivor cards stacked down the left edge, infected cards down
the right, as translucent plates (`rgba(5,4,3,0.78)`) over the map. Each card:
slot number and name in Oswald, health in Anton colored by the section 7
thresholds, a health bar, weapon or infected class as an eyebrow, and state
badges for incapped, pinned, ghost and dead. Content is exactly what
`HudStrip` renders today; in theater `HudStrip` renders in this layout instead
of the strip below the stage.

**Status line.** Across the bottom in Oswald: time of end, alive, common,
specials, zoom. Replaces the top-left HUD readout while in theater.

**Hidden chrome.** The toolbar (pause, filmstrip scrub, toggles, speeds, follow
row) sits along the top and fades to 15 percent opacity after two seconds
without pointer movement, returning on movement or keyboard focus. The events
and chat feed, when toggled on, slides in as a 320px column from the right and
pushes the infected cards inward rather than covering them.

**Also in normal mode.** Once the view transform exists, wheel zoom, drag and
the zoom chips are enabled in the embedded viewer too. Fit stays the default
there; follow stays off by default there.

**Left out on purpose.** The map opacity slider: the overview art is already
content-cropped and the slot colors were tuned against it. Calibration and
CSV loading: replays here are addressed by match and file, never by upload.

**Tests.** The view transform gets pure tests for zoom about a point, pan
clamping to the content box, and round-tripping a world position through
project and inverse. The theater layout gets a render test that the card
count and order match the roster and that Escape leaves theater. The
existing draw tests must pass unchanged, because `drawScene` is untouched.

## 8. Rollout and verification

Six steps, each a commit on `feat/skill-stats-5` after the pending lockup
fix is committed, each leaving the site fully working:

1. **Tokens, fonts, atmosphere.** `tokens.css`, `index.html`, body layers,
   `campaignTint`. A new `tokens.test.ts` asserts every color pair the file
   comments claim, and that no source file contains the deleted amber hexes.
2. **Shell.** Nav, `PageHeader`, panels, table base styles, chips.
3. **Components.** `StatTable`, poster tiles, versus header, headliner card,
   countdown.
4. **Pages.** One commit per route in the order of section 6. `Tile` and the
   attribute-selector tints are deleted in the last of these.
5. **Viewer.** Stage frame, HUD overlay, filmstrip, HUD strip, canvas chrome.
6. **Theater mode.** The view transform with its tests first, then zoom and
   drag in the embedded viewer, then the theater layout, edge HUD, status
   line, fading toolbar and fullscreen handling. Last because it is the only
   step that adds capability rather than restyling, and its canvas math
   deserves its own review.

Verification at every step:

- `npm test` and `npm run typecheck` stay green. The 808 existing tests are
  the regression net; the viewer's render-rate and draw tests cover step 5.
- A headless Chrome pass (the CDP rig in the session scratchpad, to be moved
  into `scripts/shoot-pages.mjs`) screenshots every route at 1400px and 390px
  widths against the local dev server with the seeded match 9001. Checked by
  eye for clipping, wrapping and contrast before each commit.
- The reference canvas is updated when a build decision departs from the
  mockup, so it stays the source of truth for the look.

## 9. Out of scope

- Any change to what data is shown, how ratings are computed, or how matches
  run.
- The in-game HUD addon in `/home/volence/l4d/hud`, which is a separate
  surface with its own design.
- Light theme. The site is dark only and declares `color-scheme: dark`.
- Replacing the map overview art or changing the canvas pixel budget.
- Deploying. Nothing on `feat/skill-stats-5` is on the Dallas box, and this
  sweep ships with the rest of that branch.

## 10. Decisions recorded

- Palette: bone on black with blood red. Amber retired, not kept as a second
  accent. Chosen by the owner over keeping amber or splitting accents by role.
- Wordmark "Riverside", nav item "Campaigns". Route paths unchanged.
- Campaign tiles are data-driven with a hashed tint for unknown slugs, because
  custom campaigns are coming.
- Ranks are Arabic numerals, not Roman, so tables work past a dozen rows.
- No sepia on map art in the viewer; the vignette alone carries the film look.
- `SLOT_COLORS` untouched.
- Theater mode is a toggle on the one viewer, not a separate page. Follow is
  on by default in theater and off in the embedded viewer. No map opacity
  slider. Modeled on the l4dpug.com visualizer's close camera and edge HUD.
- Accent brightened to #de4e40 and ink darkened after measuring contrast;
  recorded in tokens.test.ts.
