# Season 1 "Wrong Way" launch runbook

Season 1 starts **Tue 2026-11-03** and ends **Mon 2027-01-04**; Season 2 starts Tue 2027-01-05.
Everything below is on branch `season1`. Review page with screenshots of every piece:
https://claude.ai/artifact/ERRD7bcv1cdYBpFa3GuzWF

**The Season 1 switch.** Every new feature waits for the season flip (`seasonOneLive` in
`src/seasonThemes.ts`: the current season plays the ranked rules). Before the flip the site looks
and behaves exactly as today, so the code can ship days early. Starting Season 1 in Admin > Setup >
Seasons turns all of it on at once.

## What ships

| Piece | Before the flip | After the flip |
|---|---|---|
| Soft reset, 5 placements, SR = mu - 1 sigma, Bronze to Master (III/II/I), 50 SR demotion buffer | Season 0 rules | On |
| Wrong Way theme, season banner, glitch effects | Normal look | On (theme picked in the new-season form) |
| Rank emblems (scripts/rank-art, scripts/rank-emblems.py) | Not shown (no ranks) | On |
| Rank-up / placement animation on the site | Off | On |
| Season-end trophies on profiles | Nothing to show | S0 top 10 get medals at the flip |
| SR line in chat + disconnect box after every match (pug-match 0.3.38, ships as 0.3.39) | Off | On |
| !rq / site checkbox / Discord "Queue again after" button | Off (!rq silent) | On |
| News + hand-written Patch notes (`/patch-notes`), tracker page becomes "Full change log" | Drafts only; nav unchanged | On |
| How to Play SR answer | Season 0 text | Season 1 text |
| Per-map score multipliers from the Season 0 saferoom rate (mission VPK on the servers; Campaigns page column + note, map page figure) | Old 1.0/1.2/1.4/1.5 ladder; site shows nothing | New numbers once the VPK is on a box; site shows them |

## Still to do before launch

- [x] **Season 0 Wrapped.** BUILT (backend c56db376, site b6bdf232 + 4553b529; owner to look over decks via the staff preview before launch). Backend (src/seasonWrapped.ts, freezes at the close; staff preview /wrapped/preview/1/<steamid>). Spec and data notes:
      `docs/season-wrapped.md` (13 player cards; 10+ matches full deck, 3 to 9 short deck,
      1 to 2 one card; banned players left off named boards; nemesis = worst record vs someone with
      5+ games; best single map, not best match; deadstops/tongue cuts never recorded; endorsements
      and weekly awards only since 09-21). It must read the **frozen** Season 0 results, so it
      opens at the flip. Needs building and testing this week.
- [ ] **Owner calls:** who may post news (admins only now; mods too?), glitch title strength.
- [ ] **Mirrored maps** on all five pool servers (owner: mostly done).
- [ ] **Season 0 announcement:** the final standings and the Top 10 need 20 matches in the season.
- [ ] **Discord:** create or choose the announcements channel; set its id in
      Admin > Setup > Settings > Discord > News channel id.
- [ ] **Video:** use the PNGs in `~/l4d/trailer/season1/rank-emblems/` (not `old/` or `old-v2/`).
- [ ] **Map multipliers** (owner OK 2026-10-23, memory pug-season1-map-multipliers). Table:
      `balance/map-multipliers.json` from `scripts/map-multipliers.ts` (rules in
      `src/mapMultipliers.ts`). The VPK is built by the deploy repo's
      `tools/season-multipliers/build_mission_vpk.py` (branch `season1-multipliers` there) from the
      SAME json. Counts completed, unvoided PUGs only (owner 10-23).
      Shipping numbers (owner OK 11-02, recomputed from prod 11-02; 7 maps moved 0.05 to 0.10 from the 10-23 table):
      Dead Air 0.80/1.50/1.75/1.05, Death Toll 0.90/1.10/1.75/1.35, No Mercy 1.15/1.35/1.35/1.20,
      Blood Harvest 1.30/1.25/1.30/1.30. The 10-23 table was: Dead Air 0.75/1.60/1.75/1.00,
      Death Toll 0.90/1.10/1.75/1.35, No Mercy 1.15/1.40/1.35/1.15, Blood Harvest 1.30/1.20/1.35/1.30.
      Season 0 keeps playing until the flip, so the night before, rerun the script on a fresh prod
      copy and diff against the committed json. Blood Harvest 2 sits near a rounding edge (1.177; every
      match kind gave 1.15): if any number moves, ask the owner which table ships, then rebuild the
      json AND the VPK together. Never ship one without the other.
- [ ] Mirror packs: rebuild the mirrored mission files with the same numbers
      (`~/l4d/mirror`: `build.py --missions-only --multipliers <json> <maps...>`, see its README) and
      ship them with the mirror packs, so a mirrored map scores like its original.
- [ ] Duo queue: run `scripts/duo-calibrate.ts` on a fresh prod copy, send the owner the proposed `duo_bonus_min_sr` / `duo_bonus_max_sr`, set them in Admin > Settings > Queue before the flip. Duos turn on with the flip (seasonOneLive). Trial review: `scripts/duo-review.ts` ~2 weeks after the flip and again at 40 duo matches.

## Deploy (target around Tue 10-27, owner's go)

1. Local test match on the l4d1-ds test server with pug-match 0.3.39 and a test Season 1 started
   on a copy of the DB: check the SR line in chat and in the disconnect box, `!rq`, `!rq off`, the
   site checkbox, the Discord button, and that a requeued player lands at the back of the queue.
   Also check that with Season 0 current, `!rq` does nothing and no SR line is sent.
2. Merge `season1` into master (other sessions commit to master: merge, do not rebase their work).
3. Web: `deploy-web.sh` (see memory pug-deploy-verification for the gated deploy rules).
   **Deadline if it carries season1-stats:** the weekly Damage as SI award switches to the net
   figure from week `NET_SI_DAMAGE_FROM_WEEK` (2026-10-26, src/weeklyAwards.ts). That week
   freezes Mon **11-02 12:00 UTC**, so this deploy must land before then. If it will not, bump
   the constant to the first week that starts after the deploy, so no week changes its rule
   halfway through or is frozen under the old one while the code says new.
4. Plugin: pug-match 0.3.39 to all five pool servers between matches (it carries `pug-endnote.inc`;
   0.3.39 = the 0.3.38 end notes and !rq plus s0-audit-fixes' FinalizeMap LIVESTAT flush).
   It stays silent until the site sends `sm_pug_requeue 1`, which it only does after the flip.
5. Verify: the site still shows Season 0 everywhere, News is not in the nav, Patch notes still
   opens the tracker page, a normal match completes and rates as before.
6. Paste the launch post into Admin > Setup > News as a **draft** (text:
   `docs/news/season1-launch-draft.md`). Owner edits it there.

## Flip day (Tue 11-03)

1. Wait until no match is being set up or played (the new-season button refuses otherwise).
2. **Back up the database** (copy pug.db before anything else).
2b. **Map multipliers to every pool box, with the flip restart.** The new
   `addons/l4d1_mission_nav.vpk` replaces the one every box loads today (md5 bb0d95ca on all five
   on 10-23); srcds only reads mission files at boot, so each box needs a restart, and a box must
   not pick it up before the flip (a Season 0 match would score with Season 1 numbers). The VPK is
   gitignored in deploy, so stage it from a temporary deploy root, as Crash Center was:

   ```
   cd ~/l4d/deploy-season1-mult/tools/season-multipliers
   python3 build_mission_vpk.py build  ~/l4d/deploy/overrides/left4dead/addons/l4d1_mission_nav.vpk season1.json /tmp/s1.vpk
   python3 build_mission_vpk.py verify ~/l4d/deploy/overrides/left4dead/addons/l4d1_mission_nav.vpk season1.json /tmp/s1.vpk   # PASS, md5 045889e7 (11-02 table)
   T=$(mktemp -d); mkdir -p $T/overrides/left4dead/addons $T/riverside1 $T/riverside2
   cp ~/l4d/deploy/server.env $T/; cp ~/l4d/deploy/riverside1/riverside1.env $T/riverside1/; cp ~/l4d/deploy/riverside2/riverside2.env $T/riverside2/
   cp /tmp/s1.vpk $T/overrides/left4dead/addons/l4d1_mission_nav.vpk
   for t in dallas riverside-3 riverside-4 riverside-5 riverside-6; do L4D_DEPLOY=$T ~/l4d/deploy/tools/stage-on-restart.sh $t addons/l4d1_mission_nav.vpk; done
   ```

   With nothing live (step 1), every box is idle, so stage-on-restart restarts each one at once
   (about 20 s out of the pool each). Do this right before step 4, and start Season 1 as soon as
   the five report applied (`--status`). Then check `md5sum` of the VPK on all five, and that a
   box's pug-match log line `[pug] gg: <map> from missions/<x>.txt ... ` shows the new numbers on
   its first map load. Last, copy the new VPK over
   `~/l4d/deploy/overrides/left4dead/addons/l4d1_mission_nav.vpk` (keep the old one as
   `l4d1_mission_nav.vpk.season0` beside it), or the next deploy.sh puts Season 0 numbers back.
   Chicago is out of the pool: never re-enable it without this VPK.
3. Look over Admin > Setup > Seasons: the reset preview shows everyone's starting SR and rank.
4. Start **Season 1: Wrong Way** with theme **Wrong Way** and end date **2027-01-04**. This freezes
   Season 0, seeds the soft reset, and turns on every Season 1 feature.
5. Open Season 0 Wrapped (once built).
6. Publish the launch post (goes to Discord too).
7. Server panel text, all five boxes, `left4dead/myhost.txt`:
   `Riverside PUGs · Season 1: Wrong Way` / `<city>` / `The end of the world is just the beginning.`
8. Newcomer balance offset: owner's toggle, Admin > Settings > Queue > First-match balance offset
   (`newcomer_balance_offset`, suggested 6).
   Stat-aware team balance (owner approved 2026-10-23, branch `season1-balance`): Admin > Setup >
   Settings > Queue > Stat-aware team balance ON (`balance_stats_enabled` 1). Leave the gate at 60%
   and the tolerance at 5 points. To turn it off, set the same switch off: the next pop uses the
   rating-best teams exactly as before (nothing is stored on players, so there is nothing to undo).
   Every queue match is logged on or off, in Admin > Balance > Teams.
   With it on, a quarter of the matches where it would change teams (match ids divisible by
   `balance_stats_holdout_every`, 4) keep the rating-best teams as a holdout for the A/B check.
9. Check: theme and banner show, leaderboard says placing for everyone, a first match plays and
   rates, the SR line arrives in game, the rank-up animation plays after a placement completes.

## Patch notes line (map multipliers)

> **Map score multipliers.** A map's score multiplier now follows how often survivors reached the
> saferoom there in Season 0, instead of going up map by map. Harder maps are worth more (Ranch
> House and Dead Air's Garage are now 1.75), easier ones less (Greenhouse is 0.80), so every map
> counts about the same in a match. Each campaign adds up to the same total as before. The numbers,
> and the saferoom rate behind each one, are on the Campaigns page, and they are worked out again
> at the start of every season.

## After launch

- ~11-10: revisit win-chance accuracy and the newcomer offset (memory pug-win-chance).
- ~11-17 (two weeks after the flip): Admin > Balance > Teams. "Gate fired, tie-break: stat favourite
  of the chosen teams" should win about 50%, and no more than about 55%, while the holdout line (rating-best
  teams, same gate) should stay well above it (S0: about 70%); the gate should fire on roughly half
  of matches (the backtest: 47%; the stat favourite won 72% of those before). If the chosen favourite
  still wins 60%+ over 40+ decided fired matches, look at raising the tolerance; if fewer than ~30%
  fire, the gate may be too high.
- Watch the first week of placements: anyone landing far from where they finished Season 0.
- Optional: Discord roles for final rank at season end; a Season 0 Top 10 post in Discord.

## Rollback

- Map multipliers: stage the Season 0 VPK (md5 bb0d95ca, kept as `l4d1_mission_nav.vpk.season0`)
  the same way and restart. The site table only explains the numbers; revert its json with the web.

- Site: redeploy the previous web build. The new DB columns and tables are additive.
- Plugin: restage pug-match 0.3.37. The site sends `sm_pug_endnote` and `sm_pug_requeue`, which an
  older plugin ignores as unknown commands.
- Undoing the flip after matches are played is NOT simple (Season 0 is frozen, seeds written): do
  it only from the backup taken in step 2.
