# Stream widgets (OBS browser sources) — design

Date: 2026-11-04. Status: approved by owner pending final read.

## Why

A player (Danielb32, Discord feedback 2026-11-03) wants their Riverside rating on their stream,
updating on its own, because viewers ask about it. The owner liked the idea and widened it: a small
set of widgets a streamer can drop into OBS, including the score of the match they are playing and
the score of each map so far.

Success: a streamer opens their profile, picks a widget and a style, copies a URL, pastes it into an
OBS Browser Source, and it stays correct through a night of matches with no further touching.

## What a widget is

A page on riversidepug.com with a transparent background and no site chrome, at a URL that names the
player (steamid) and the widget, with the style and options in the query string. It polls a small
public JSON endpoint and redraws. OBS shows it over the stream; the streamer places and sizes it in
OBS (placement is OBS's job, not ours).

No login, no key: every widget shows only data that is already public on the site (profile, public
live view, public queue). That is what makes a bare steamid URL safe.

## The widgets

1. **Live match** — the match the streamer is playing right now.
   - Both teams' totals, the campaign, which map of how many, and each finished map's score
     (`match_live_maps`).
   - **Current map** (owner ruling 2026-11-04): once its first half has ended, show that half's
     score ("Map 3: Rex 438, Mox playing"); nothing mid-half. The half-time score is not public
     today, so it is added to the public /live payload too, with /live's usual delay, and the
     widget reads it from there. Everyone in the server already sees it on the scoreboard, so it
     is not ghosting information. Totals include it.
   - **The streamer's team must be unmistakable** (owner): listed first, in the season accent
     colour, tagged with the streamer's name. The other team is plain. Colour means "my team",
     never "winning"; the leader is marked separately (brighter number or a small arrow).
   - Not in a match: hidden (default) or a small "Not in a match" line (option).
   - Data comes from the same public, delayed source as the /live page (`getLiveMatches`,
     `src/liveView.ts`), so it can never show anything /live does not already show. It must not
     add its own undelayed path.
2. **Rating card** — SR, Season 1 rank (tier + division, `src/seasonRules.ts`), leaderboard
   position, this season's W-L, and the change today. The SR shown must be the same number the
   profile shows.
3. **Session tracker** — SR change and W-L since the stream started. "Started" = when the
   widget page first loaded, with a "Reset" option (my call: a `since` time held by the page;
   a reload keeps it if stored locally, see open points). Shares a look with the rating card;
   may be the rating card with a toggle.
4. **Last match card** — map/campaign, final score, won or lost, SR change, and a few of the
   streamer's own stats (SI damage, skeets, commons). Updates when a match is reported.
5. **Queue status** — "Queueing on Riverside, 6/8" while the streamer is in the queue; hidden
   otherwise. From the public `/api/queue` view.

## Looks

- **Presets, not a builder** (owner: "a couple pre made is fine"). For the live match widget the
  four mocked styles are all approved: **bar** (thin strip, total + who won each map),
  **card** (totals on top, per-map scores below), **corner box** (totals + which map only),
  **scoreboard** (full map-by-map table with a total column). Other widgets get whichever of
  these shapes fit them (my call: card and corner at least, bar where it reads).
- Options per widget, all in the URL: style, size (S/M/L), and widget-specific toggles
  (e.g. hide when idle). Nothing more.
- **Season theme colours** (owner). Widgets take their colours from the current season's
  tokens (`web/src/styles/tokens.css` `[data-season=...]`, theme from `src/seasonThemes.ts` /
  `/api/site`), not hard-coded, so they change look when the season does. Results keep their
  meaning whatever the season (losses/infected stay red, as on the site).
- Must read clearly over busy game footage: solid dark panel behind text, tabular numbers.

## Setup page

A "Stream widgets" section on the player's own profile (visible to them only). For each widget:
style + options pickers, a live preview drawn with their real data over a stand-in background, a
Copy URL button, and one line: "OBS: Sources, +, Browser, paste this URL". Suggested OBS width and
height per style/size shown next to the URL.

## Existing code to reuse

The caster studio already serves chrome-less OBS pages: `/overlay/*` served as `overlay.html`
(`src/server.ts` ~2488, with `no-referrer`), `web/src/overlay/` (feed worker, polling, pieces,
`overlay.css`). Its lesson from 2026-10-04 applies: OBS throttles off-screen sources, so polling
must recover after a pause rather than freeze. Widgets should share that page shell and the
recovery behaviour, but not the caster key system (widgets need no key).

## Non-goals

- No layout editor, no free positioning, no custom colours.
- Nothing about other players' hidden state; no new data the site does not already publish.
- No OBS plugin or obs-websocket integration; plain Browser Source only.
- Not the caster studio: that stays its own thing for casters.

## Anti-goals (failure even if it "works")

- A widget that shows anything earlier or more than the public /live view (ghosting risk).
- A viewer cannot tell which team is the streamer's.
- A widget that silently freezes on old data after OBS hides and re-shows it.
- Hard-coded colours that ignore the season.

## Settled after the builder check (my calls unless marked)

- **Which matches count** for last match, session W-L and change today: exactly the matches the
  public profile shows for that player, with the same filters (visibility, rated, voided/aborted).
  Mirror the profile's query; no widget shows a match the profile hides.
- **"Today"** is the streamer's local day. The page runs in OBS on the streamer's own PC, so it
  sends its UTC offset and the endpoint counts from local midnight.
- **Live widget, streamer not on the roster** (sub without a row, spectating, casting): hide. We
  never guess which team is theirs.
- **Live widget, match just ended**: hold the final score for 5 minutes, marked "Final", then hide.
  This needs a small "recently finished" lookup beside the /live source, limited to public data.

## Open points (builder's call unless marked)

- Scrims and tournament matches in the live widget: shown only when that match is already visible
  on the public /live view; never a way around a private scrim (my call).
- Poll interval and caching (my guess 15-30 s; one cheap per-player endpoint rather than the full
  /api/live payload).
- Session tracker persistence across an OBS reload.
- Behaviour when the steamid is unknown or banned: render nothing.
- Caddy logging of `/widget/*` polls (the caster overlay hit the same noise issue).
