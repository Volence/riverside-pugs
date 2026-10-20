# Season Wrapped

Built in `src/seasonWrapped.ts` (compute + freeze into `season_wrapped` at the season close, right after `season_results`), served by `src/routes/wrapped.ts`. Staff preview a season still open at `/wrapped/preview/:season/:steamid`. Below is the data study the cards were designed from (prod copy 2026-10-19). Differences in the build: names on every list skip banned players, community records count only full 8-player rosters, nights cut at 5 am Eastern, and the hour histogram is stored in UTC and turned into the viewer's zone on the page.


Source: read-only prod DB copy taken 2026-10-19 (`scratchpad/pug.db`). Every number below was computed from it by
`scratchpad/wrapped/wrapped.mjs` (raw output in `wrapped/out.json`). Run it with player names as arguments:
`node wrapped.mjs "Bone Breaker" brewcejewce Duckzy`.

## 0. Ground rules for every query

**Match filter.** One base set, the same one every PUG-facing number already uses:

```sql
-- completedPug('m') from src/matchKinds.ts, plus season and not voided
m.state = 'completed' AND m.kind = 'pug' AND m.season_id = 1 AND m.voided_at IS NULL
```

(`voided_at IS NULL` costs nothing today: voiding sets `state = 'aborted'`, so no completed PUG is voided. Keep it anyway,
like `WEEK_MATCHES` in weeklyAwards.ts does.) This leaves 610 matches, ids 8 to 750, 2026-09-11 to 2026-10-19. The 2
scrims are excluded by `kind`.

**Match duration** (for every "hours" figure), as a temp view `pm`:

```sql
CREATE TEMP VIEW pm AS
SELECT m.id, m.campaign, m.winner, m.team_a_score, m.team_b_score, m.ended_at,
       COALESCE(r.s, m.went_live_at, m.created_at) AS started_at,
       (julianday(COALESCE(r.e, m.ended_at)) - julianday(COALESCE(r.s, m.went_live_at, m.created_at))) * 24 AS hours
FROM matches m
LEFT JOIN (SELECT match_id, MIN(started_at) s, MAX(ended_at) e FROM match_rounds GROUP BY match_id) r ON r.match_id = m.id
WHERE <base filter>;
```

First round start to last round end. 609 of 610 matches have rounds; match 8 falls back to created_at to ended_at
(`went_live_at` is NULL on 79 matches, so it cannot be the primary source). Average match: 46 minutes.

**SR.** `displaySr(mu, sigma) = max(0, round((mu - 2*sigma) * 100))` from src/rating.ts. Start value is 833.

**Who appears on community boards.** Exclude `players.status = 'banned'` (the leaderboard does, via `notBannedSql`).
Their matches still count in community totals.

**Freeze it.** Ratings are recomputed on merges (`recomputeSeasonRatings`), voids remove matches, and names change.
Compute the whole Wrapped once at season close and store it as JSON (one row per player plus one community row), the
same way `weeklyStore.ts` freezes a week, so the cards never shift after they are shared.

**Time zone.** Store a 168-bucket UTC hour-of-week histogram per player; the client rotates it into the viewer's own
zone. Examples below use US Eastern. (Season 0 is entirely inside EDT, so a fixed offset is exact.)

**Sample gates** (existing settings where one exists):

| Gate | Value | Source |
|---|---|---|
| Wrapped at all (full deck) | 10 completed PUGs | `standing_min_games` = 10 |
| Short deck | 3 to 9 PUGs | `RANKED_MIN_GAMES` = 3 |
| Drop-in card only | 1 to 2 PUGs | |
| Duo best / nemesis / favourite opponent | 5 games together or against | `chemistry_min_games` = 5 |
| Best campaign | 5 matches on it | new |
| Best / worst map | 4 recorded plays | new |
| Percentile pool | players with 10+ PUGs (103 players) | same as profile standings |
| Endorsement title | 5 of a kind, 10 games, strict plurality | `endorse_title_min`, `endorse_title_min_games` |

Player distribution by completed PUGs: 1-2: **100**, 3-9: **57**, 10-24: **41**, 25-49: **27**, 50-99: **27**, 100+: **8**
(260 players). So 103 players get the full deck, 57 a short deck, 100 the drop-in card.

## 1. Per-player cards

Examples: **Bone Breaker** (188 PUGs, #3 final), **brewcejewce** (43 PUGs, #19), **Duckzy** (6 PUGs, #82).
`:me` is the player's steamid. All per-player queries resolve aliases the way chemistry.ts does where pairs are involved
(see gaps: merges rewrite rows, so `player_aliases` matters only for the pair joins).

### Card 1: Your season in numbers (all tiers)

Matches, W-L, hours, maps, nights played, games rank in the community.

```sql
SELECT COUNT(*) n, ROUND(SUM(pm.hours),1) hours, SUM(pm.winner = mp.team) wins,
       MIN(pm.started_at) first, MAX(pm.ended_at) last,
       COUNT(DISTINCT date(pm.started_at, '-9 hours')) nights      -- Eastern evening, 5 am cut
FROM match_players mp JOIN pm ON pm.id = mp.match_id WHERE mp.player_id = :me;
-- maps: join match_maps mm ON mm.match_id = mp.match_id AND mm.ordinal >= mp.joined_map
```

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Matches | 188 (2nd most of 260) | 43 (36th) | 6 (118th) |
| Record | 107-81 (56.9%) | 25-18 (58.1%) | 3-3 (50%) |
| Hours | 143.0 | 32.6 | 4.8 |
| Maps | 742 | 172 | 24 |
| Nights | 36 | 20 | 4 |
| Longest night | 12 matches, 9.3 h (evening of 2026-09-27 ET) | 6 matches, 4.3 h | 2 matches |

Longest night: `GROUP BY date(pm.started_at,'-9 hours') ORDER BY COUNT(*) DESC, SUM(hours) DESC LIMIT 1`.

### Card 2: Where you finished (rated players, 3+ games)

Final SR and rank on the non-banned leaderboard, plus the peak.

```sql
SELECT rh.mu_after, rh.sigma_after, m.ended_at, m.id
FROM rating_history rh JOIN matches m ON m.id = rh.match_id
WHERE rh.player_id = :me AND rh.season_id = 1 ORDER BY rh.id;
-- peak = max displaySr(mu_after, sigma_after); rank from leaderboardData order, banned removed, games >= 3
```

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Final SR / rank | 3009, #3 of 137 | 2081, #19 of 137 | 893, #82 of 137 |
| Peak SR | **3760** on 2026-09-27 (match 252) | 2081 (final match, 10-18) | 893 (final) |

Rule: show the peak as its own beat only when `peak - final >= 100`. Because SR is `mu - 2 sigma`, a player whose sigma is
still shrinking peaks at their latest match (both other examples), so for them show "833 to 893, climbing" with a
sparkline of `history` instead.

### Card 3: Streaks (10+ games)

```sql
SELECT pm.winner = mp.team AS w FROM match_players mp JOIN pm ON pm.id = mp.match_id
WHERE mp.player_id = :me ORDER BY pm.ended_at, pm.id;   -- longest run of 1s in JS (weeklyAwards.longestRun)
```

Bone Breaker: longest win streak **10**, longest losing streak 5. brewcejewce: 8 and 3. Duckzy: 3 and 3 (short deck: show
only if >= 3). Draws do not exist this season (`winner` is only a or b), so the run logic needs no draw case.

### Card 4: Your campaign (5+ matches) and your map (4+ plays)

Campaign, match level:

```sql
SELECT pm.campaign, COUNT(*) n, SUM(pm.winner = mp.team) w
FROM match_players mp JOIN pm ON pm.id = mp.match_id
WHERE mp.player_id = :me GROUP BY pm.campaign HAVING n >= 5
ORDER BY w * 1.0 / n DESC, n DESC LIMIT 1;
```

Map, map level (a map is won when your side's map score is higher; unrecorded maps skipped, same rule as
playerStats.ts `recordedFor`):

```sql
SELECT mm.map, mm.team_a_score a, mm.team_b_score b, mp.team
FROM match_players mp JOIN pm ON pm.id = mp.match_id
JOIN match_maps mm ON mm.match_id = mp.match_id AND mm.ordinal >= mp.joined_map
WHERE mp.player_id = :me
  AND NOT EXISTS (SELECT 1 FROM match_rounds r WHERE r.match_id = mm.match_id AND r.ordinal = mm.ordinal AND r.reliable = 0)
  AND mm.team_a_score + mm.team_b_score > 0;
-- group in JS: n, wins, avg margin; best = highest win rate (tie: margin), worst = mirror; n >= 4
```

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Most played | Blood Harvest, 66 (43-23) | Blood Harvest, 15 (6-9) | Death Toll, 3 |
| Best campaign | Blood Harvest, 65.2% (66) | **Death Toll, 81.8% (9-2)** | none (gate) |
| Best map | No Mercy 2 (hospital02_subway): 21-12, +159 avg | Death Toll 1 (smalltown01_caves): 8-3, +444 avg | none |
| Worst map | stadium2_underground (Suicide Blitz): 0-4, -323 | No Mercy 1 (hospital01_apartment): 1-4 | none |

The brewcejewce pair (most played is his worst, his best is another) is the kind of contrast this card is for.

### Card 5: Your people (duo and teammates)

Pair query is chemistry.ts `chemistryFor` verbatim (alias-resolved roster self-join), restricted to `pm`:

```sql
WITH roster AS (
  SELECT DISTINCT mp.match_id, COALESCE(pa.canonical_id, mp.player_id) pid, mp.team
  FROM match_players mp JOIN pm ON pm.id = mp.match_id
  LEFT JOIN player_aliases pa ON pa.steamid = mp.player_id)
SELECT o.pid, p.name, (o.team = me.team) same, COUNT(*) games, SUM(m.winner = me.team) wins
FROM roster me JOIN roster o ON o.match_id = me.match_id AND o.pid != me.pid
JOIN pm m ON m.id = me.match_id JOIN players p ON p.steamid = o.pid
WHERE me.pid = :me GROUP BY o.pid, same;
```

- Most played with: max games where same = 1 (no gate).
- Best duo: max win rate where same = 1 and games >= 5.
- Distinct teammates: count of same = 1 rows.

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Most played with | KoRn, 51 games (31-20) | Bone Breaker, 10 (6-4) | ynot, 2 |
| Best duo (5+) | **VII, 17-5 (77.3%)** | KoRn, 4-1 | none |
| Teammates | 88 different | 63 | 17 |

### Card 6: Nemesis and favourite opponent (5+ games against)

Same pair rows with same = 0. Nemesis = lowest win rate against (this is `worstAgainst` on the profile, so the two agree);
favourite opponent = highest. Tie-break by more games. Also "most faced" (no gate) as a subtitle.

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Nemesis | **diz: 0-11** | Bone Breaker: 2-5 | none |
| Favourite opponent | SoKuShd: 8-0 | fyd: 5-0 | none |
| Most faced | VII, 73 times (37-36) | P $tache #L4DRevival, 8 | donny J, 2 |

Do not rank nemesis by raw loss count: for heavy players it just returns whoever they face most (VII for Bone Breaker,
a 37-36 split, which is not a nemesis).

### Card 7: Signature stat (10+ games)

Per-match rate of every `high_good` public stat plus the fixed columns and win rate, ranked within the 103-player pool.
Same rules as standings.ts (`playerStandings`): per match, zero never ranks, ties share a rank.

```sql
-- totals per player
SELECT player_id, SUM(si_damage) sidmg, SUM(si_kills) sikill, SUM(common_kills) ck, SUM(revives) rev
FROM match_players mp JOIN pm ON pm.id = mp.match_id GROUP BY player_id;
SELECT player_id, stat, SUM(value) FROM match_player_stats mps JOIN pm ON pm.id = mps.match_id GROUP BY player_id, stat;
-- rate = total / completed PUGs; crowns = crowns + draw_crowns (weeklyAwards does the same)
-- rank = 1 + count(pool players with a strictly higher rate); "top X%" = ceil(rank / pool * 100)
```

Candidate keys: sidmg, sikill, ck, rev, skeets, team_skeets, skeet_assists, boomer_pops, crowns, self_clears, rock_skeets,
clears, insta_clears, tongue_clears, tank_damage, dps_landed, pounce_damage_high, biles_landed, tank_rocks_landed,
damage_as_si, tank_punches, boom_successes, quad_caps, winrate. (Leave out deadstops, tongue_cuts, skeets_melee: always 0,
see gaps.) Show the best one big and the next two small.

| | Bone Breaker | brewcejewce |
|---|---|---|
| #1 | SI kills: 31.1 per match, **#3 of 103 (top 3%)** | Win rate 58%, #19 (top 19%) |
| next | Witch crowns 0.94/match, #3; tank punches 10.6/match, #3 | Witch crowns 0.44/match, #26; damage pounces 0.47/match, #29 |

Duckzy (6 games): not in the pool. Short deck replaces this card with Card 8.

### Card 8: Best single map (all tiers)

Per-map stats come from `match_live_map_stats`, which holds **cumulative** snapshots per map end; the per-map value is
the difference from the previous ordinal (exactly `liveView.mapStatsFor`). Prefer this over "best match": 16 matches
have 1 to 3 maps and match 15 had 6, so a per-match record is biased.

```sql
SELECT l.match_id, l.ordinal, l.stats_json, mm.map FROM match_live_map_stats l
JOIN pm ON pm.id = l.match_id LEFT JOIN match_maps mm ON mm.match_id = l.match_id AND mm.ordinal = l.ordinal
WHERE l.player_id = :me ORDER BY l.match_id, l.ordinal;
-- diff each row against the same match's ordinal - 1, take the max per key (sidmg, ck, skeets, damage_as_si, tank_damage)
```

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| SI damage, one map | 4559 (No Mercy 3, match 215) | 2983 (Blood Harvest 3, match 49) | 2021 (Death Toll 3, match 237) |
| Damage as SI, one map | 730 (Death Toll 4, match 428) | 498 (Blood Harvest 2, match 458) | 366 (Death Toll 4, match 237) |
| Skeets, one map | 5 | 3 | 1 |
| Skeets, one match (`match_player_stats`) | 9 (match 458) | 4 (match 458) | 3 (match 283) |

Link each value to `/matches/:id`.

### Card 9: Survivor or infected? (10+ games; short deck too, it needs few games)

Team half scores while the player was on each side, from reliable rounds only, maps they were present for:

```sql
SELECT (r.surv_team = mp.team) AS surv, COUNT(*) n, AVG(r.score) avg,
       AVG(CASE WHEN r.survivors_alive IS NULL THEN NULL ELSE r.survivors_alive > 0 END) survived
FROM match_players mp JOIN pm ON pm.id = mp.match_id
JOIN match_rounds r ON r.match_id = mp.match_id AND r.ordinal >= mp.joined_map
WHERE mp.player_id = :me AND r.reliable = 1 GROUP BY surv;
-- community baseline: AVG(score) over all reliable rounds = 280
```

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Your team as survivors | 329 per half (+49 vs 280) | 300 (+20) | 96 (-184) |
| Survivors made it (measured halves) | 36.9% | 36.4% | 8.3% |
| Conceded as infected | 273 (7 better than avg) | 344 (64 worse) | 177 (103 better) |
| Your infected wiped them | 69.6% | 63.6% | 83.3% |

Verdict line: compare (survivor avg - 280) with (280 - conceded avg). Bone Breaker: "+49 survivor, +7 infected, a survivor
main". brewcejewce: "+20 survivor, -64 infected". It is a team number, so word it as "when you are survivor, your team
scores...", never as personal credit.

### Card 10: Endorsements (any tier with at least 1 received)

```sql
SELECT kind, COUNT(*) FROM endorsements e JOIN pm ON pm.id = e.match_id WHERE to_id = :me GROUP BY kind;
SELECT COUNT(DISTINCT from_id) FROM endorsements e JOIN pm ON pm.id = e.match_id WHERE to_id = :me;  -- people, never names
SELECT COUNT(*) FROM endorsements e JOIN pm ON pm.id = e.match_id WHERE from_id = :me;              -- given
```

Bone Breaker: **82 received** (39 Caller, 29 Clutch, 14 Good vibes) from 33 different people, title Caller, most endorsed
player of the season. Gave 33. brewcejewce: 12 received (10 vibes, 2 caller) from 11 people, gave 26. Duckzy: none, skip
the card. Keep the module's privacy rule: counts and distinct-giver counts only, never who.

### Card 11: Trophy shelf (weekly awards; skeet triples; quad caps)

```sql
SELECT award, kind, week_start FROM weekly_awards
WHERE player_id = :me AND award NOT IN ('slow_ready','friendly_fire','group_hug') ORDER BY week_start;
SELECT COUNT(*), MAX(count) FROM skeet_streaks s JOIN pm ON pm.id = s.match_id WHERE player_id = :me;
```

Bone Breaker: **20 weekly awards** across all 4 frozen weeks (2nd most; VII has 47), incl. Top caller twice and Most wins
(week of 09-21). brewcejewce: 2 (Best win rate wk 09-28, Damage pounces avg wk 10-12). Duckzy: none, skip. Skeet triples:
none of the three (only 7 exist all season). Season totals to show as chips: Bone Breaker 43,199 commons, 605 skeets, 176
crowns, 190 rock skeets, 31 quad caps, 299 revives.

### Card 12: When you play (all tiers)

Hour-of-week histogram of `pm.started_at` per player.

| | Bone Breaker | brewcejewce | Duckzy |
|---|---|---|---|
| Peak hour (ET) | 11 pm (14% of matches) | 11 pm (19%) | midnight |
| After midnight ET | **56%** of matches | 26% | 33% |
| Top day | Sunday (41) | Friday (18) | Saturday |

### Card 13: Where it started (all tiers, good opener or closer)

```sql
SELECT pm.id, pm.campaign, pm.started_at, pm.winner = mp.team won FROM match_players mp JOIN pm ON pm.id = mp.match_id
WHERE mp.player_id = :me ORDER BY pm.started_at LIMIT 1;
```

Bone Breaker: match 8, Dead Air, 2026-09-11, the first completed PUG ever, and he won it. brewcejewce: match 14, Blood
Harvest, lost. Duckzy: match 234, Blood Harvest, lost.

### Deck per tier

| Tier | Cards |
|---|---|
| 10+ PUGs (103 players) | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 (skip any card whose gate leaves it empty) |
| 3-9 PUGs (57) | 1, 2 (climb wording, never "peak"), 5 (most played with only), 8, 9, 12, 13, then a "Season 1 is yours" closer |
| 1-2 PUGs (100) | One card: first match, result, who they played with, hours; then the community deck |

Everyone gets the community deck after their own.

## 2. Community cards

### C1: Season 0 in numbers
610 completed PUGs, **464 match hours** (3,712 player hours), 2,421 maps, 4,834 halves, **260 players**, 2026-09-11 to
2026-10-19. Average match 46 minutes.

```sql
SELECT COUNT(*), SUM(hours), AVG(hours)*60, MIN(started_at), MAX(ended_at) FROM pm;
SELECT SUM(pm.hours) FROM match_players mp JOIN pm ON pm.id = mp.match_id;  -- player hours
```

### C2: The grind, week by week
Matches per award week: Sep 7 (opening weekend) 7, Sep 14: 66, **Sep 21: 172**, Sep 28: 170, Oct 5: 119, Oct 12: 76. Busiest
evening: **2026-10-03, 33 matches**. Peak start hour 11 pm ET (64 matches), dead zone 9 to 10 am ET (0).

```sql
SELECT strftime('%Y-%W', started_at, '-12 hours') wk, COUNT(*) FROM pm GROUP BY wk;  -- matches the Monday 12:00 UTC week
SELECT date(started_at, '-5 hours') d, COUNT(*) n FROM pm GROUP BY d ORDER BY n DESC LIMIT 1;
```

### C3: Campaigns and maps
Death Toll **174** matches (129 h), Blood Harvest 124, Dead Air 122, No Mercy 106, Dark Carnival 31 (then Suicide Blitz 13,
The Parish 10, Dead Center 6, 5 others under 6). Deadliest map for survivors: Death Toll 3 (smalltown03_ranchhouse),
survivors lived through only **14.4%** of 340 halves; kindest: Dead Air 1 (airport01_greenhouse), 51.7%.

```sql
SELECT campaign, COUNT(*), SUM(hours) FROM pm GROUP BY campaign ORDER BY 2 DESC;
SELECT mm.map, COUNT(*) n, AVG(r.survivors_alive > 0) FROM match_rounds r JOIN pm ON pm.id = r.match_id
JOIN match_maps mm ON mm.match_id = r.match_id AND mm.ordinal = r.ordinal
WHERE r.reliable = 1 AND r.survivors_alive IS NOT NULL GROUP BY mm.map HAVING n >= 40 ORDER BY 3;
```

### C4: The carnage
897,726 common kills, 109,960 SI killed, 23.0 M damage to SI, 32.2 M tank damage, **11,084 skeets** (+3,732 team skeets),
4,532 rock skeets, 1,903 witch crowns (458 clean + 1,445 draw), 1,925 damage pounces, 18,079 booms landed, **864 quad caps**,
33,366 tank punches, 6,923 revives, 66,385 friendly fire. Survivors made it to the saferoom in 30.6% of measured halves
(1,435 of 4,694).

```sql
SELECT SUM(common_kills), SUM(si_kills), SUM(si_damage), SUM(revives), SUM(ff_dealt) FROM match_players mp JOIN pm ON pm.id = mp.match_id;
SELECT stat, SUM(value) FROM match_player_stats mps JOIN pm ON pm.id = mps.match_id GROUP BY stat;
```

### C5: Final standings, top 10 (non-banned, 3+ games)

| # | Player | SR | W-L |
|---|---|---|---|
| 1 | brisa | 3118 | 23-9 |
| 2 | exp | 3048 | 55-40 |
| 3 | Bone Breaker | 3009 | 107-81 |
| 4 | VII | 2989 | 106-90 |
| 5 | Stinkler23 | 2672 | 46-37 |
| 6 | mado | 2656 | 31-21 |
| 7 | doodo | 2612 | 19-9 |
| 8 | Jerco | 2555 | 16-6 |
| 9 | prodigy | 2507 | 32-24 |
| 10 | wasd | 2491 | 20-11 |

Raw `player_ratings` order would put 3 banned players in this list (the top SR overall, 3782, is a banned account). Use
`leaderboardData` (it already excludes them) at the moment the season closes. Highest SR anyone (non-banned) reached:
Bone Breaker **3760** on 2026-09-27.

### C6: Season leaders (totals; per-match versions available from the percentile pass)

| Category | #1 | #2 | #3 |
|---|---|---|---|
| Iron man (PUGs) | VII 197 | Bone Breaker 188 | shove 144 |
| Skeets | VII 926 | Bone Breaker 605 | gabe 449 |
| Most skeets in one match | VII 14 (matches 656 and 734) | prodigy 13 | |
| SI damage | VII 1.26 M | Bone Breaker 1.14 M | gabe 0.65 M |
| Common kills | Bone Breaker 43,199 | VII 39,324 | KoRn 23,851 |
| Witch crowns (incl. draw) | Bone Breaker 176 | VII 127 | exp 108 |
| Rock skeets | VII 301 | Bone Breaker 190 | exp 169 |
| Revives | Bone Breaker 299 | VII 296 | †ino 233 |
| Damage as SI | Bone Breaker 113,779 | VII 103,392 | shove 59,075 |
| Quad caps | VII 45 | mourn 32 | Bone Breaker 31 |
| Damage pounces | PATEK PHILIPPE 100 (banned: drop) | KoRn 99 | Dust 81 |
| Longest win streak | roughee 13 (banned: drop) | mado 12 | Bone Breaker 10 |
| Most endorsed | Bone Breaker 82 (33 people) | adam 73 (27) | VII 69 (34) |
| Weekly awards won | VII 47 | Bone Breaker 20 | gabe 12 |
| Best duo (15+ together) | Bone Breaker + VII 17-5 | KoRn + mourn 11-4 | mourn + VII 16-7 |
| Most common duo | KoRn + Bone Breaker 51 | Bone Breaker + happy 36 | Bone Breaker + †ino 32 |

Totals reward volume (VII and Bone Breaker top almost everything). Pair each total with the per-match leader from the
10+ pool so the board is not two names.

### C7: Moments
- Closest finishes: **1 point**, three times: match 154 (Death Toll, 177-178), 334 (Dead Center, 615-616), 354 (No Mercy,
  180-179).
- Biggest blowout: match 373, Blood Harvest, 255 to 4382.
- Longest 4-map match: match 93, Suicide Blitz, 67 minutes.
- Highest single half: 1764 on Death Toll 4 (match 150).
- Best single maps: SI damage 6024 by gabe (match 692, Dead Air 3); damage as SI 1009 by mado (match 724, Dead Air 3);
  skeets 7 by sesh (match 340, Death Toll 1).
- Skeet triples (3 skeets in 5 s): 7 all season.
- 1,414 endorsements given by 107 people to 154 players.

## 3. Data gaps and quirks

1. **Stats that are always zero.** `deadstops`, `times_deadstopped`, `tongue_cuts`, `skeets_melee` sum to 0 over the whole
   season. Never show them.
2. **Late-starting feeds.** `quad_caps`/`times_quadded` are absent for 17 matches (ids below 20). `dmg_as_*` start at match 14.
   Per-half `match_round_stats` exist only from match 150 (118 completed PUGs without). `survivors_alive` is NULL on 140
   halves (early season). `match_si_lives`/`match_survivor_downs` cover only 118 matches from 628, and `si_kills` only 16
   matches: do not build cards on these three. The skeet ruleset changed on 2026-09-18 (matches 15, 17, 22 predate it).
3. **Endorsements started 2026-09-21** (first one 17:00 UTC, around match 103). A player active only in the first ten
   days cannot have any; say "endorsements started Sep 21" rather than "0".
4. **Weekly awards** are frozen for 4 weeks only (09-21, 09-28, 10-05, 10-12). Weeks before 09-21 were never awarded;
   `computeWeek` can compute 09-14 from live tables if wanted, but it was never posted, so do not count it as a win.
5. **Per-map stats are cumulative.** `match_live_map_stats` stores running totals per map end; diff against the previous
   ordinal. Up to 10 s of end-of-map play bleeds into the next map, and in 320 of 4,868 player-matches the last snapshot
   differs from the authoritative dump total in `match_players`. Fine for "best map" moments, not for season totals (use
   `match_players` / `match_player_stats` for those).
6. **Odd rosters.** Completed PUG 8 has 4 players and 9 has 2 (opening-day tests); 646, 647, 732 have 9 rostered (in-game
   matches with a late joiner, source 'udp'). Only 4 rows have `joined_map > 0`, so subs barely matter, but always join maps
   with `mm.ordinal >= mp.joined_map`. Consider excluding matches whose roster is not 8 from community records (closest
   game, blowout).
7. **Odd map counts.** 16 matches have 1 to 3 maps and match 15 has 6. Per-match records (biggest SI damage match) favour
   match 15 (Bone Breaker's and brewcejewce's best SI damage "match" are both match 15); use per-map records.
8. **Banned players.** 47 banned accounts played 605 player-matches. Keep their matches in totals, drop them from every
   named board, and do not generate a Wrapped for them (or generate it but never serve it). Also watch for a non-banned
   player whose nemesis or duo is banned: decide whether to show the name.
9. **Merged accounts.** `mergePlayers.ts` rewrites match rows onto the canonical id, so per-player totals are already merged
   (no `match_players` row points at an alias today; 3 aliases exist). The pair queries still resolve `player_aliases` like
   chemistry.ts, to be safe.
10. **Rated games vs matches.** `rating_history` has 5 rows on aborted matches (abandon losses) and the leaderboard counts
    games from `rating_history`; Wrapped should count matches from `match_players` on completed PUGs. Tiny difference (e.g.
    VII 196 rated, 197 played).
11. **Aborted PUGs.** 134 aborted (10 voided). They are excluded everywhere. A "matches you queued for that never happened"
    stat is possible from match_players on aborted matches but is not a happy card; leave out.
12. **Names.** `players.name` is the current name; someone who renamed mid-season will see today's name on old moments.
    `alsoKnownAs` exists if a "you were also known as" line is wanted.
13. **Sides a and b** carry no meaning (a won 315, b 295); do not present it as a stat.
14. **Peak SR is a recompute artifact risk.** Any later merge or void recomputes every rating after it, which can move peaks
    and dates. Another reason to freeze at season close.
15. **Season boundary.** `seasons.ended_at` is still NULL. Decide the cut (probably the moment Season 1 starts) and compute
    then; this study's numbers stop at 2026-10-19 09:37 UTC.
