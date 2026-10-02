# Caster studio (v1)

Spec: "Caster studio (v1.1)" in `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md`
plus `~/l4d/research/competitive-2026-09-30/elemental-overlay.md`. Owner's ask (2026-10-02): an
online production toolkit like Elemental Production, for L4D, picking a PUG, a match, or a scrim the
caster was invited to, with themed scenes that integrate with OBS, using our own data instead of an
outside API.

Written and built overnight while the owner slept, so every call below was made without them and is
listed as a ruling to confirm.

## What it is

- `/cast/studio`: the producer panel, for casters and admins (the same gate as `/cast`).
- `/overlay/<scene>?k=<overlay key>`: OBS browser sources, 1920x1080, transparent where the scene is a
  layer. A separate Vite entry (`web/overlay.html`), so OBS loads no site chrome, no queue socket and
  no nav.
- `/api/overlay/feed?k=`: one JSON snapshot for every scene (studio state, match view, live round).
  Overlays share one poll through a SharedWorker, falling back to one poll per page.
- OBS: an optional in-browser obs-websocket v5 client in the panel (scene switching, connect to
  `ws://localhost:4455`), and a downloadable OBS scene collection with every scene pre-wired.

## Rulings (to confirm)

1. **Overlay key, not a session.** OBS has no cookie, so each caster gets a key
   `<steamid>.<generation>.<hmac>` signed with the cookie secret. Nothing secret is stored: the panel
   can always show the URLs again. "New link" bumps the generation and kills every old URL. Staff
   revoke the same way from the player file (also bumps it). The feed re-checks on every poll that the
   key's owner is still an admin or an active caster in good standing, so clearing the caster flag or
   a ban cuts overlays off within a second.
2. **Which matches.** Exactly the `/cast` rule: every PUG and tournament match; a booking's game only
   for staff or a caster both sides invited (`fullyInvited`). The picker also lists matches that ended
   in the last 6 hours (for final stats and the winner scene) and open bookings the caster may cast,
   which the studio can **follow**: it shows the booking's newest game as each one starts.
3. **No delay for casters** (spec). The live round HUD reads the newest replay frame directly. Ghost
   infected are shown only as "ghost" plus class, never positions.
4. **Tank and witch %** are not reported by any plugin today, so they are producer fields (shown on the
   scorebug when set). A plugin feed is deferred.
5. **Team names.** Booked games use the side's team name, tag and logo (pickup sides: "<captain>'s
   team"). PUGs default to "Team A" / "Team B"; the producer can override names, tags and colours.
6. **SR on player cards** only for PUGs. Scrims follow `scrim_show_sr`; tournaments never show SR.
7. **Overrides** (Elemental's idea): any overridden field (team names, tags, colours, scores) wins over
   live data until cleared, and the panel marks it.
8. **State per caster** in `cast_studios` (one row each), saved on every change, with a revision
   number the overlays use to replay entrance animations when the scene changes.
9. **Two ways to run OBS.** Either one browser source on `/overlay/program`, which shows whatever scene
   the panel picked (no OBS plugin needed), or one OBS scene per overlay (the downloadable collection),
   switched from the panel through obs-websocket. Both work at once.
10. **No new npm dependency.** obs-websocket v5 is a small JSON protocol (Hello, Identify with a
    SHA-256 challenge, requests), implemented in `web/src/cast/obs.ts` with WebCrypto.
11. **Caster cams.** Each caster line can carry a cam URL (for example a VDO.Ninja view link). The
    casters scene draws framed slots, and the scene collection places a browser source for each cam
    exactly in its slot (layout shared by server and client in `src/cast/layout.ts`).
12. **Live 2D map** is deferred: overviews for most maps live on R2 behind the replay viewer's loader,
    and wiring that into an overlay is its own piece.
13. **Gameplay scene has no game capture**: the caster adds their own game or SourceTV capture under
    the overlay in OBS (it differs per machine).
14. **Duplication audit (owner note 2026-10-02): the gameplay overlay never repeats the game's HUD.**
    What a caster's screen already shows, from the stock `scripts/hudlayout.res` and our modern HUD
    (`~/l4d/hud/src`, which casters may run):
    - First-person spectating a **survivor**: every survivor's health and state (CHudTeamDisplay
      teammate column, CHudLocalPlayerDisplay own panel bottom left), the spectated survivor's weapons
      and ammo (HudWeaponSelection, bottom right in our HUD, top right in stock), kill feed (top right).
    - First-person spectating an **infected**: the infected team row with each class and health
      (CHudZombieTeamDisplay), own SI health and ability ring (HudZombieHealth, bottom right), the
      ghost/spawn panel (centre), the damage record when an SI dies (HudPZDamageRecord, a band across the
      top), the frustration meter while on tank (left middle).
    - **Tank health**: only the tank itself (and whoever spectates the tank) sees it; survivors and other
      spectators never get a tank bar in L4D1.
    - **Scoreboard (Tab / round end)**: campaign scores and survival distance, only while held.
    - Never on screen: team names, which team is on which side, the campaign score outside Tab, map N of
      M, tank and witch flow %.
    So the gameplay scene is the scorebug (team names and tags, sides, campaign score, map N of M,
    boss %) plus live elements that each have their own toggle in the panel: survivor health list
    (default OFF), infected lineup (default OFF), tank health (default ON), boss % (default ON). The
    OFF ones are for free-cam, third person or SourceTV views, where the game draws no team panels.
    Map progress has no data source today (no plugin reports flow), so it is not offered (deferred).
15. **Screen regions the game HUD uses** (1920x1080; HUD units are 640x480 scaled by 2.25, with the
    width widened to 853 units at 16:9), which the gameplay overlay keeps clear of:
    - top right: kill feed and stock weapon selection, roughly x 1320-1920, y 0-320;
    - top band: infected damage record, y 45-215 full width, only for a few seconds after an SI dies;
      finale meter and holdout timer top centre (finales only; PUGs stop before the finale);
    - left middle and bottom left: survivor team column, own health, chat, frustration meter,
      x 0-640, y 400-1080;
    - right middle and bottom right: infected team row (stock) / weapons and ammo (our HUD) / SI health,
      x 1500-1920, y 400-1080;
    - centre: crosshair, target ID, progress bars, ghost and zombie panels, x 560-1360, y 380-700;
    - bottom centre: closed captions when turned on, x 620-1300, y 720-960.
    The scorebug sits top centre, x 640-1280, y 10-86 (it can briefly overlap the infected damage record,
    which is why the panel has a "scorebug at bottom" switch: bottom centre, y 990-1066). Tank health
    and, when toggled on, the survivor row and the infected row stack under the scorebug in the same
    top-centre column (x 640-1280, down to y 330 at most), so nothing reaches the kill feed, the team
    panels or the crosshair area. With the scorebug at the bottom they stack upward above it instead.
16. **Theme direction (owner note 2026-10-02): L4D and the Riverside site, not Elemental.** Every scene
    uses the site's poster look and tokens (`web/src/styles/tokens.css`): warm near-black, bone text,
    blood red as the one accent, Anton display type, Oswald labels, square corners, film grain and the
    red vignette. L4D touches: safehouse stencil lettering and the spray-painted safe room arrow, hazard
    stripes for infected moments (tank alive, highlight cards), campaign tints and the site's survivor
    portraits and SI pictograms. Nothing from the Elemental/Overwatch package (no pinwheels, no four
    colour gradient, no ELMT marks). Theme presets are variations of that look only: Riverside (blood
    red), Safehouse (stencil red on concrete), Night (moonlit blue, for The Parish night mode) and Bile
    (boomer green).
17. **Extras built tonight** (owner note 2026-10-02, free hand): highlight callouts the producer fires
    from the live event feed (skeets, deadstops, crowns, tank kills and so on) or types by hand, shown
    for eight seconds in the free top-left corner of the gameplay scene; a caster prep sheet per match
    in the panel (SR, recent form, career averages, best single-match marks, head-to-head between the
    two rosters); a pre-flight checklist (key, match picked, live data arriving, casters named, OBS
    connected); number-key scene hotkeys with a printable run of show. **Deferred:** a rendered WebM
    stinger for OBS's Stinger transition (needs the headless render rig Elemental has), plugin-fed
    boss % and map progress, the live 2D map, a bracket/standings scene (waits for tournaments T1b+),
    replay clips between maps, music and flythrough media.

## Scenes

| key | what it shows |
| --- | --- |
| program | whichever scene the panel selected, with the lower third on top |
| starting | title, match-up, countdown |
| casters | caster names and cam slots, match-up |
| gameplay | scorebug (teams, current side, campaign score, map N of M, tank/witch %) plus the toggled live elements (tank HP and controller on by default; survivor HP row and infected lineup off by default, see rulings 14-15) |
| scorebug | the scorebug alone (layer) |
| roundhud | the live round strip alone (layer) |
| mapintro | campaign, chapter N of M and map name, sides for the coming half |
| maps | chapter x team score table with who survived first, totals |
| lineups | both rosters as player cards with L4D stats |
| stats | match stats (live totals or final box score) |
| brb | be right back, countdown optional |
| winner | match winner and final score |
| ending | thanks for watching |
| lowerthird | the lower third alone (layer) |

## Tasks

1. Schema `cast_studios` + `src/cast/studio.ts` (validate and save state, generation).
2. `src/cast/key.ts` overlay keys (sign, verify).
3. `src/cast/access.ts`: castable matches and bookings, shared with `/api/cast`.
4. `src/cast/matchView.ts`: teams, rosters, chapters x halves, sides, phase, stats, cards.
5. `src/cast/liveRound.ts`: newest frame of the round in progress, read incrementally per file.
6. Routes `src/routes/castStudio.ts`: studio get/save/new link, preview feed, overlay feed, logo,
   scene collection download, staff revoke.
7. Overlay entry, feed worker, theme, scenes.
8. Producer panel with OBS client.
9. Screenshots of every scene at 1920x1080 and the panel at desktop and 390 px, review, fix wave.
