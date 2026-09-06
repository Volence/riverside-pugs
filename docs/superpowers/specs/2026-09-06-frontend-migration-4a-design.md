# Sub-project 4a — Frontend Migration + Redesign

**Date:** 2026-09-06
**Status:** Design, pre-implementation
**Parent:** `2026-09-06-dual-surface-design.md`

## Goal

Replace the placeholder frontend with one built to carry the pages 4b–4f will add,
and give it a visual identity. Two things at once, deliberately: the migration is
cheap to do while the page count is five, and expensive once the link flow, draft
board, and admin panel exist.

**In scope:** stack migration, faithful port of all five existing pages, visual
redesign, real URLs, a frontend test setup.

**Out of scope:** any new user-facing feature, any backend behavior change beyond
static-file serving and an SPA fallback route. If a page does something new, it
belongs to 4b–4f. This sub-project must be invisible in the API surface.

## Current state

`public/` is three hand-written files with no build step: `index.html` (every page
as a `hidden` `<section>`), `app.js` (390 lines — hash router, `innerHTML` string
templates, a hand-rolled `esc()`, a nav token guarding against stale async
renders), and `style.css` (2.4 KB).

It works. What it can't carry: a draft board with per-pick state, an admin form
grid, and a link flow — all of which are state-heavy UI that string-concatenated
`innerHTML` makes genuinely painful and unsafe.

Two behaviors in the current code are load-bearing and must survive the port:

1. **The nav token** (`app.js:38`, `let nav = 0`). Every route bumps it; async
   renders bail if it changed. Without it, a slow `/api/players/:id` response
   paints over whatever page you navigated to since. In Preact this becomes an
   abort/ignore in the fetch hook — the bug it prevents is the same bug.
2. **The WS re-fetch model.** `Hub.broadcast(event)` sends only an event *name*;
   the client re-fetches. This stays exactly as it is. 4a does not touch the wire
   protocol.

## Stack

**Vite + Preact + TypeScript.**

Preact over React for size (~4 KB runtime on a page whose job is showing a
countdown), over Svelte because JSX in TS needs no compiler-aware tooling and the
backend is already TS. No CSS framework — hand-written CSS with custom properties,
which is what a five-page site with a strong visual identity actually wants.

**Routing:** `preact-iso` with the History API, replacing hash routes. Real URLs
matter now, because 4c's bot will post links to profiles and matches into Discord,
and `https://…/player/76561198…` is a link people will paste. Requires a Fastify
SPA fallback (below).

**Layout:**

```
web/                  frontend source (new)
  index.html          Vite entry
  src/
    main.tsx          mount + router
    api.ts            typed fetch wrappers over the existing endpoints
    hooks/            useLiveState (WS + re-fetch), useFetch (nav-token safe)
    routes/           Play, Leaderboard, Matches, MatchDetail, Profile
    components/       shared: PlayerLink, SrDelta, StatTable, Countdown, Sparkline
    styles/           tokens.css + per-component CSS
dist/public/          build output (gitignored)
public/               DELETED
```

**Backend changes — the complete list:**

1. `src/server.ts` static root moves from `../public` to `../dist/public`.
2. A `setNotFoundHandler` that serves `index.html` for non-`/api`, non-`/auth`,
   non-`/ws` GETs, so deep links work on refresh. It must **not** swallow unknown
   API routes into HTML — those keep returning JSON 404s.

Nothing else. No route shapes change.

**Scripts:** `npm run build` (Vite → `dist/public`), `npm run dev` runs Fastify
and the Vite dev server together, with Vite proxying `/api`, `/auth`, and `/ws`
to :8080.

## Design language — "Safe Room"

The feeling is the lull between chapters: warm lamp light in a concrete room, the
door painted red, someone counting ammo. Quiet and warm at rest, because the site
is where people idle before being yanked into a 30-second ready check — a design
that shouts all the time has nothing left for the countdown.

**Explicitly not leaning into L4D's grime.** No textures, distressed type,
weathered-poster treatment, or splatter dividers. Those are right for a splash
page seen once and wrong for a stat table read every night: texture behind digits
is noise, distressed type at 14px is mud, and grunge chrome reads as a 2009 clan
site. What carries over from the game is *temperature* and *typographic voice* —
a warm ash-and-bone palette instead of the usual blue-black, sodium-lamp amber as
the accent, condensed uppercase headings echoing the stenciled HUD. Atmosphere
without artwork; surfaces stay flat and high-contrast.

Rejected: "Broadcast" — cool blue-black, cyan accent, chamfered translucent panels
(the Faceit/Valorant look). Interchangeable with every other game's stat site,
cold against L4D's warmth, and neon on dense tables invites contrast trouble.

**Palette** (all values verified against WCAG relative luminance, not assumed):

| Token | Value | Contrast |
|---|---|---|
| `--bg` | `#141210` | warm near-black |
| `--surface` | `#1c1916` | panels, table bodies |
| `--surface-2` | `#242019` | hover rows, chips |
| `--border` | `#2f2a24` | 1px hairlines only |
| `--text` | `#ebe4d6` | 14.8:1 on bg |
| `--text-muted` | `#9a9082` | 5.9:1 on bg, 5.2:1 on surface-2 |
| `--accent` | `#e3892b` | 7.0:1 on bg |
| `--rating` | `#f2cd6a` | 12.2:1 — reserved for SR, everywhere |
| `--win` / `--loss` / `--draw` | `#45b39c` / `#e35d5d` | 7.3:1 / 5.3:1 |

Teal-vs-red beats green-vs-red for deuteranopes, but **color is never the only
signal**: every result carries a literal `W`/`L`/`D` glyph, and SR deltas always
print their sign with a real minus (U+2212). Amber is never used for anything
negative; red is never used for anything interactive except the final-seconds
countdown.

**Type.** Barlow Condensed 600–700 uppercase for display (HUD-adjacent without
being a novelty face); IBM Plex Sans 400/500/600 for body and — critically — for
all numeric data, because it genuinely ships `tabular-nums` and the leaderboard
and stat tables are dense columns of digits. Scale: 0.75 / 0.875 / 1 / 1.25 /
1.75 / 2.5 rem, plus 4.5rem reserved for two hero numerals only (profile SR, and
the ready-check countdown).

**Layout.** Per-page max widths instead of one column: Play 720px (880px once
teams are shown), Leaderboard and Matches 880px, Profile 960px, Match detail
1120px so the two stat tables sit side by side, each in its own `overflow-x`
wrapper so a phone never scrolls the page sideways.

**Three details doing the work:**

1. *SR number* — 4.5rem Barlow 700 in `--rating` with a faint `text-shadow` lamp
   glow, tracked `RATING` eyebrow above, last delta as a chip beside it. Gold is
   reserved for SR sitewide, so it's recognizable at a glance inside a table too.
2. *Ready-check timer* — no per-tick animation. Set the bar to 100%, then next
   frame to 0 with `transition: width Ns linear`; the browser does the rest. At
   10s remaining a data attribute flips `--accent` to `--loss` locally **and on
   `body`**, so the nav's bottom border goes red and the countdown is visible
   from the leaderboard page. `document.title` becomes `(0:23) Ready check`.
   `prefers-reduced-motion` drops the blink, keeps the color change.
3. *Tables* — no zebra striping (the strongest admin-panel tell). Hairline row
   separators, hover to `--surface-2`, right-aligned tabular numerals, ranks 1–3
   in `--rating`. The viewer's own row gets a 3px `--accent` left border. Match
   rows get a 4px left rule tinted per campaign (No Mercy `#6f8a7a`, Death Toll
   `#5a6f8c`, Dead Air `#b8842f`, Blood Harvest `#8a3f32`) so a match list scans
   as a barcode of results rather than a generic log.

Everything above lives as custom properties in one `tokens.css`. Every color,
space, and type step used anywhere resolves to a token, so a change of heart is
one file, not a grep — the hedge against a taste call made overnight.

## Pages

All five port with identical data and identical semantics. Changes are presentation
only:

- **Play** (`/`) — the live surface. Queue count and join/leave; ready-check with
  countdown and per-player ready state; campaign vote with live tallies; final
  teams. Composed so the ready-check reads as urgent (it is a 30-second window
  people miss).
- **Leaderboard** (`/leaderboard`) — rank, player, SR, W, L, games. Tabular figures.
- **Matches** (`/matches`) — recent matches, linked.
- **Match detail** (`/match/:id`) — per-map scores, two per-player stat tables.
- **Profile** (`/player/:steamid`) — avatar, SR, SR-over-time graph, lifetime
  totals, recent matches.

The **dev panel** ports as a component gated on `/api/dev/enabled`, unchanged in
function — it is how the whole pipeline gets exercised without a game server, and
losing it would cost more than it saves.

## Testing

Backend tests are untouched and must stay green at 117. Vitest gains a second
project so the frontend can run under `happy-dom` while `src/` keeps running under
node.

Frontend tests are deliberately shallow — this is presentation code, and testing
markup is how you get a suite that breaks on every design change:

- **Pure helpers** get real unit tests: sparkline point math (including the
  <2-points case), SR delta sign/class, date formatting, campaign name mapping.
- **The nav-token guard gets a real test** — a slow fetch resolving after a route
  change must not render. This is the one behavior with a known past bug
  (`8975b0f`), and it is logic, not markup.
- **One smoke render per route** with stubbed API responses, asserting the page
  reaches its loaded state. No snapshot tests.

## Risks

- **Taste risk.** The visual direction is being chosen without the site's owner in
  the room. Mitigated by tokenizing every value, and by keeping the port faithful
  so only presentation is in question.
- **Scope creep into 4b–4f.** The rule above is absolute: if it changes the API, it
  is not 4a.
- **Deploy.** The app is not currently deployed anywhere, so adding a build step
  costs nothing today. It does mean `npm run build` becomes mandatory before first
  deploy; noted in the README as part of this work.
