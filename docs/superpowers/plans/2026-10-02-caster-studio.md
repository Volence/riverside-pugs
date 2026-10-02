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

## Status (2026-10-02, overnight build)

Built on branch `caster-studio`. Screenshots: `scripts/seed-cast-studio.ts` fills a scratch DB (and
keeps a live replay file growing), `scripts/shoot-cast-studio.mjs` shoots every scene at 1920x1080 and
the panel at 1440 and 390 px.

Also built beyond the list above: per-map boss % (numbers typed for one map never show on the next),
"Reset overlay links" on the admin player file, a one-minute cache of career numbers.

Not tried yet: a real OBS (browser sources, obs-websocket connect and scene cuts, the scene collection
import), SharedWorker sharing between OBS browser sources (falls back to one poll per source if OBS
isolates them), the live round HUD against a real pushed replay file.

## Review fix wave (2026-10-02)

- canCastMatch refuses a match the caster is rostered in, and a booking game (or booking to follow)
  where the caster has any stake: on the people list (invited or accepted), managing a side, or a
  member of either side's team. Staff included: undelayed ghost and infected intel on your own game is
  never offered. It also requires canViewMatch for non-booking matches and keeps to the picker's
  window (setting up, live, or finished within 6 hours).
- A save never touches the callout; it is fired and cleared through its own routes.
- The live reader takes sides from the roster when a file has no side mask, decodes only a 128 KB tail
  on a first read (finding a frame boundary by walking frame lengths), keeps entities from the last
  frame that sampled them, and lists survivor bots.
- **The key in the URL and the proxy.** Overlay pages send `Referrer-Policy: no-referrer` (header and
  meta tag), and Caddy already sends `strict-origin-when-cross-origin` site-wide, so `?k=` does not
  leave in a Referer. But Caddy's access log (`/var/log/caddy/riversidepug.log`, from
  `deploy/state/dallas/system/etc/caddy/Caddyfile`) records every request URI, so it holds the key, and
  every overlay polls `/api/overlay/feed?k=...` once a second (a dozen sources is a dozen lines a
  second, which also churns the 10 MB x 5 rotation). Not changed (prod config, owner's call). Options
  for the Caddyfile: `log_skip /api/overlay/*` inside the site block to drop those lines, or a log
  `format filter` with `request>uri query { replace k REDACTED }` to keep them scrubbed.
- **X-Frame-Options DENY.** The same Caddyfile sends `X-Frame-Options DENY` on every response, which
  would blank an iframe of an overlay. So the panel's preview draws the scenes inline from its own feed
  (overlay styles are scoped to `.ov`) instead of framing `/overlay/program`. OBS browser sources are
  top-level pages, not frames, so they are unaffected.

## Broadcast bar, LIVEHUD and the stat set (2026-10-02, branch hud-bar)

The owner tried the deployed studio and saw no gameplay HUD: no match was on air (their studio row had
`matchId` null and no PUG was running), and the scene draws nothing without one. They pointed at a
tournament broadcast bar (players at the edges, scores, distance) as the kind of HUD wanted.

18. **Gameplay HUD style `bar` (default) or `scorebug`.** The bar runs across the top. Its default
    content is only what the game never shows a spectator (ruling 14 stands): both teams and scores,
    map and game N of M, round or paused, a progress strip with the tank and witch points, and the
    tank's health, in a compact 840 px middle (x 540-1380). With the survivor or infected rows on it
    runs the full width, each team's four players at the outer edge (survivor rows: portrait, health
    with temp health, DOWN / LEDGE / PINNED / BILED / DEAD, kit, pills, throwable; infected rows: class,
    SPAWNING or DEAD, a health bar, damage this half). Team A is always on the left. Rows stay **off** by
    default (owner, 2026-10-02) and the panel says to turn them on only with a clean-feed HUD, SourceTV
    or free cam.
19. **LIVEHUD (pug-match 0.3.20).** Every 2 s while a half is live the plugin emits
    `LIVEHUD prog=<team %> tank=<%> witch=<%> p=<steamid>:<flow %>:<items>:<dmg>,...`: the furthest
    survivor's flow % (the number `!cur` prints, true flow, no boss buffer), each survivor's own flow and
    held kit/pills/throwable (bits 1/2/4/8), damage this half per player (SI damage as survivor, damage
    as SI as infected, from the go-live snapshot), and l4d_boss_percent's tank and witch % through
    optional natives (-1 absent, 0 none, witch -2 a witch party). The site keeps it **in memory only**,
    keyed by token, read only by the caster feed (behind the key and the caster gate), dropped after
    6 s, never in the DB or on the public live page. Without it (an older plugin) the strip and the item
    icons hide themselves and the boss % falls back to what the producer typed.
20. **Boss %: typed for this map wins, else the server's.** Same override idea as the team fields.
21. **Nothing on air.** OBS gets a transparent frame (no placeholder on stream, no toggle). The panel's
    preview draws a labelled sample match ("Sample: no match on air") from its own state, and the On air
    box says to pick a match.
22. **Stat set (owner, 2026-10-02).** Match stats shows SI dmg, SI kills, Commons, Skeets (skeets +
    team_skeets, all weapons, counted once), Tank dmg under "As survivors", then DPs (damage pounces,
    `dps_landed`) and Boomer % (booms landed per boomer life, "-" with no boomers, never 0% from 0/0)
    under "As infected". Deadstops and "Dmg as SI" are gone. Every key is in the 10 s LIVESTAT line, and
    a finished match now reads its skill stats from `match_player_stats` (match_players.stats_json holds
    only the fixed five, so skeets, DPs and boomer % were blank on a finished match before). Lineup cards
    show career Skeets, DPs and Boomer %. "DPs" is never upper-cased (it read as DPS).

Shipping the plugin side: pug-match 0.3.20 is a game-server plugin, so it goes through
`deploy/tools/stage-on-restart.sh` on each pool box (installs at the next srcds restart, never on a
box with humans). The web side works with or without it.

## Our own look, the caster HUD direction, and the touches (2026-10-02, later)

23. **The broadcast bar is gone; four looks replace it** (owner: the bar copied the tournament
    reference too closely). `plate` (default): a poster plate at top centre, each team's name, side and
    score either side of the map in stencil, cut at an angle, with the progress strip as its bottom rail;
    rows on stack each team's players as medallions down its own side of the screen, mid height.
    `corners`: a plate per team in the top corners with its players hanging under it as medallion chips,
    the map and strip in a small tag at top centre. `rail`: one board down the left edge (map, strip,
    both teams, players, tank). `frame`: see 24. `scorebug` stays. A saved `bar` reads as `plate`.
    Pick: plate, because it is the only one that leaves both top corners free for the game's own team
    panels (what frame mode and the caster HUD need) and reads as one object at a glance.
24. **Frame mode** (owner, after the Neutral Casting HUD reference): a client caster HUD will move the
    game's survivor and infected team panels to two rects; the overlay frames those holes, tabs each with
    the team on that side this half, and puts the plate between. The rects are studio state (`frame`),
    editable in the panel; the defaults (survivor 20,20 560x150, infected 1340,20 560x150) are a guess
    until the in-game probe sets them. The caster HUD itself is not built here.
25. **Game art only.** Survivors: the released character-select portraits (vgui/select_*), cropped to
    the face. Infected: the HUD's own team icons (vgui/hud/zombieteamimage_*). Witch: L4D1 has no HUD
    icon, so the "Don't awaken the witch" achievement art, cropped to the figure. Items: the game's
    inventory glyphs. All exported by `scripts/export-cast-art.py` to `web/public/cast-art/`.
26. **Streak callouts.** Skeets fold into runs by the Discord post's rules (`streakRuns` in
    src/skeetStreaks.ts, 5 s from the run's first skeet, one player, one map half; triples first, then
    doubles), so a TRIPLE here is a triple there; the highlight list carries one entry per run and the
    card upgrades instead of stacking. Booms by one boomer in one window fold into a bile with everyone
    it caught (Double / Triple / Quad bile). DP cards say "DP". The tank-killed callout is dropped.
27. **Lineups by match kind.** PUGs show SR, PUGs, win % and career skeets, DPs, boomer %. Scrims and
    tournaments show the roster (Steam avatar, name, team tag, captain or co-captain from the team or
    the pickup side's captain) with an empty slot for event stats later; no PUG numbers are sent at all.
28. **Touches the in-game HUD cannot have** (owner's guiding principle), each with a panel switch:
    the progress strip with the tank and witch pins (kept in every look, owner); the **opponent's mark**
    (second half: how far the other team got on this map, from LIVEHUD progress kept per half in memory
    at ingest; a web restart during the first half loses it); **survivor dots** (each survivor's own
    flow as a small face on the strip); the **tank damage card** for 12 s after a tank dies (pug-match
    0.3.20 TANKDONE: each survivor's damage to that tank from pug-match's own hook, exact, its share of
    the team's damage, the tank's player, time alive, damage it dealt).

### Backlog (not built)

- Score to beat: what the survivors need to pass the other team on this map or the campaign. Needs a
  read of how Rotoblin scores versus (distance vs health bonus) before anything is shown.
- Tank recap extras: passes (tank_take / tank_give events exist), rocks and punches landed per tank.
- Round context: chapter scores as a mini strip on the plate, a round clock, a pause banner with the
  pausing team and timer (the phase already carries both).
- More callouts: witch crowned, team wipe, last survivor standing, insta-clear and tongue cut (crowns and
  clears are counters today, not events; they need EVENT lines from the plugin).
- Infected respawn timers are out (owner): the in-game infected HUD already shows them.

29. **Cleanup round (owner, 2026-10-02).** No hazard tape anywhere: thin accent rules and team-colour
    edges instead. Boss points on the strip are slim notches with a small icon and % above the rail,
    never boxes on the fill; the opponent's mark is a dashed notch labelled under the rail. Medallion
    text columns grow and never shrink the HP or state, so long names ellipsize and "210 DOWN" always
    fits. Survivor faces are re-cropped centred on the face for round medallions. The replay and live
    viewer now draw the same game art: the released survivor portraits (was the beta set in
    /portraits) and the HUD's infected icons in medallions, the HUD strip and the Key panel; the path
    figures remain only as the fallback until the images load.
30. **What a spectator sees (in-game probe 2026-10-02, real L4D1 dedicated-server spectator, stock
    HUD, 1920x1080; runs /home/volence/l4d/hud/ingame-harness/runs/specds-112810 and specds-105632).**
    A dark translucent top band y 0-115, full width, with "SPECTATING: name" at about x 1525-1790,
    y 80-110 (red when spectating an infected). A bottom band y 962-1080 holding the four survivor cards
    across x 60-1290 (portrait, name, health bar, DOWN); infected are never shown there, not even while
    spectating the tank, and the right part of the band is empty. No tank HP, no SI classes or health
    anywhere; no player HUD; Tab shows survivors and the versus score panel. Kill feed at the left
    middle from about y 385; chat prints just above the band at x 330-690, y 905-945.
    Caveat: the probe could only spawn AI infected, so a human-infected row may still appear; treated
    as stock behaviour until a real match says otherwise.
    So: survivor rows default OFF, infected rows ON, tank HP ON. Frame mode frames the bottom-band
    survivor cards (default hole x 40, y 966, 1270x110), drops the infected hole unless the producer
    adds one, and draws the infected as cards in the game cards' shape in the band's free right part,
    so the band reads as one strip, half game and half overlay. Corner plates and the rail start under
    the top band (the rail moved to the right edge, away from the kill feed), plate stacks start under
    the kill feed (y 470), callouts stay above the kill feed, and the lower third sits clear of the
    chat and the band.
31. **Tank recap windows (review, 2026-10-02).** L4D1 fires tank_spawn again on a pass, so an open
    window is never restarted: a frustration or human pass keeps one recap (damage across every
    controller, alive from the first spawn), naming the final controller and the pass count. Two tanks at
    once cannot be split, because PS_TankDamage is per player, not per tank: overlapping tanks share
    one window and one combined recap goes out when the last of them dies, flagged `tanks=<n>` and
    shown as "Tanks down, N tanks, combined". A tank killed by the world (no attacker) still reports.
    LIVEHUD progress rounds to nearest like !cur. The opponent's mark resets when a half (re)starts.
