# Weekly awards

Status: design approved in chat 2026-09-26/27, spec awaiting owner review.

## Why

Every season board ranks totals or long-run averages, so the same heavy
players top everything and someone who plays a few nights a week has nothing
to aim for. Weekly awards reset every Monday, cover many categories so more
people show up, and are announced in Discord.

## Rules (owner decisions)

- A week is Monday 00:00 UTC up to the next Monday 00:00 UTC. A match belongs
  to the week its `ended_at` falls in. Only `state = 'completed'` and
  `voided_at IS NULL` matches count.
- Each stat award has two winners: **best average** (per match, among players
  with at least `WEEKLY_MIN_GAMES` = 5 matches that week) and **most total**
  (no gate). Five, not three: a replay of the week of 2026-09-21 gave the
  damage-pounce average to a 4-game player at min 3 and a 12-game player at
  min 5, the same failure `standings.ts` documents for season badges.
  Held in the setting `weekly_min_games` (default 5), like
  `standing_min_games`.
- Winner only in Discord, not a top 3.
- Ties share the award. A zero never wins, so a stat nobody recorded that week
  has no winner and its line is left out.
- Posted to a new channel, setting `discord_weekly_channel_id`. Empty means no
  post, but the week is still frozen.
- No emojis in the Discord post.
- Shame awards appear in the Discord post and on the weekly tab, never as a
  profile badge.

## Awards

`key` is the stable id stored in the database. Source is either a fixed
`match_players` column or a `match_player_stats` stat.

Survivor:

| key | Label | Source |
|---|---|---|
| si_damage | SI damage | match_players.si_damage |
| si_kills | SI kills | match_players.si_kills |
| common_kills | Common kills | match_players.common_kills |
| revives | Revives | match_players.revives |
| skeets | Skeets | skeets |
| skeet_assists | Skeet assists | skeet_assists |
| boomer_pops | Boomer pops | boomer_pops |
| crowns | Witch crowns | crowns + draw_crowns |
| rock_skeets | Rock skeets | rock_skeets |
| tongue_clears | Tongue clears | tongue_clears |
| insta_clears | Insta clears | insta_clears |
| tank_damage | Tank damage | tank_damage |

Infected:

| key | Label | Source |
|---|---|---|
| damage_as_si | Damage as SI | damage_as_si |
| dps_landed | Damage pounces | dps_landed |
| pounce_damage | Pounce damage | pounce_damage_high |
| quad_caps | Quad caps | quad_caps |
| booms | Booms landed | boom_successes |
| rocks | Tank rocks landed | tank_rocks_landed |
| punches | Tank punches | tank_punches |
| hunter_damage | Hunter damage | dmg_as_hunter |
| smoker_damage | Smoker damage | dmg_as_smoker |

Overall (single winner each, no average/total split):

| key | Label | Rule |
|---|---|---|
| sr_climb | Biggest SR climb | displayed SR after the player's last rated match of the week minus displayed SR before their first; min `weekly_min_games` matches |
| wins | Most wins | count of won matches |
| win_streak | Longest win streak | longest run of consecutive wins, matches ordered by `ended_at`; a draw or loss breaks it |
| matches | Iron man | most matches played |
| win_rate | Best win rate | wins / (wins + losses), min `weekly_min_games` decided matches; shown as a W-L record ("15-4") |

Shame (single winner each, min `weekly_min_games` matches):

| key | Label | Rule |
|---|---|---|
| slow_ready | Slowest ready-up | highest average `match_readyup_players.seconds` per ready-up |
| friendly_fire | Friendly fire | highest per-match average `match_players.ff_dealt` |
| group_hug | Group hug | highest per-match average `times_quadded` |

Left out on purpose: self clears (owner), highest SR (owner agreed to skip: it
is the season leaderboard's #1 every week), stats that are always zero on L4D1 (deadstops, tongue
cuts, sniper and melee skeets, survivors biled), every `self`-visibility
stat such as times skeeted, and most damage to incapped survivors (owner: it does not mean anything).

Known bias, accepted: displayed SR is mu - 2 sigma, and sigma shrinks with
every game, so a newer player climbs a little even at a 50 % win rate. The
5-game gate keeps pure newcomers out; nothing further is done.

The award list lives in one array in `src/weeklyAwards.ts`, so adding or
dropping one is a one-line change plus its label.

## Components

### `src/weeklyAwards.ts` (pure computation)

- `weekStartOf(date)` returns the Monday as `YYYY-MM-DD`; `weekBounds(week)`
  returns `{ from, to }` in the `YYYY-MM-DD HH:MM:SS` UTC form SQLite's
  `datetime('now')` writes to `matches.ended_at`, so plain string comparison
  is correct.
- `computeWeek(db, start)` returns every award's winners for that week from
  live tables: `{ key, kind: 'avg' | 'total' | 'single', winners: [{ steamid,
  name, value, games }] }`.
- No writes. Used for the current, unfrozen week on the site and by the
  freezer.

### Freezing (`weekly_awards` table)

```sql
CREATE TABLE IF NOT EXISTS weekly_awards (
  week_start TEXT NOT NULL,          -- Monday as 'YYYY-MM-DD' (UTC)
  award      TEXT NOT NULL,          -- key from the award list
  kind       TEXT NOT NULL CHECK (kind IN ('avg','total','single')),
  player_id  TEXT NOT NULL REFERENCES players(steamid),
  value      REAL NOT NULL,
  games      INTEGER NOT NULL,
  detail     TEXT,                   -- display extra, e.g. '15-4' for win rate
  PRIMARY KEY (week_start, award, kind, player_id)
);
CREATE TABLE IF NOT EXISTS weekly_award_weeks (
  week_start TEXT PRIMARY KEY,
  frozen_at  TEXT NOT NULL,
  posted_at  TEXT,                   -- null until Discord accepted both messages
  recap_message_id  TEXT,
  awards_message_id TEXT,
  weekly_recap TEXT                  -- JSON, frozen with the awards
);
```

- A closed week is frozen once, in one transaction, into both tables. After
  that the site, badges and post read only the frozen rows, so a later void
  does not silently rewrite who won. An admin void of a match inside a frozen
  week does not refreeze; that is accepted.
- The poster freezes only the week that just closed (the one before the
  current week), so weeks before the feature shipped are never frozen
  automatically. `scripts/weekly-awards.ts --freeze <week>` freezes one by
  hand, and without `--freeze` prints a week's post for a dry run.
- `weekly_awards` references players, so `mergePlayers` moves its rows to the
  kept account (collapsing duplicates on the primary key), per the standing
  rule for new tables.

### `src/discord/weeklyPoster.ts`

- Same pattern as `ModCallPoster`: start/stop, one promise chain, hourly
  timer (`unref`), and the database is the queue.
- Each tick: freeze every closed week that is not yet frozen; then post every
  frozen week with `posted_at IS NULL` that ended within the last 7 days, if
  the channel setting is set. `posted_at` is written only after Discord
  accepts the send, so a restart or outage retries and never double-posts.
- The card: title "Weekly awards, week of Sep 21", sections Survivor,
  Infected, Overall, Shame. One line per award:
  `Skeets: VII 4.6/g, VII 187 total`, collapsing to
  `Skeets: VII (4.6/g, 187 total)` when one player holds both. Sent as one
  embed (description limit 4,096). Names are plain escaped text, not profile
  links: 27 lines of two links each would not fit. No emojis. One link to
  the weekly tab at the bottom.

### Weekly recap (the first message)

Modelled on the owner's hand-written "Friday recap" that players liked: plain
Discord markdown, bold numbers, match numbers named. Built from the frozen
week, so it lives in the same freeze (a `weekly_recap` JSON column on
`weekly_award_weeks`, written once with the awards).

- Headline: matches played, distinct players, peak games running at once
  (max overlap of `went_live_at`..`ended_at`), busiest day.
- Highlights, best single game of the week, each naming the match:
  skeets, tank damage, common kills, boomer pops, rock skeets, damage
  pounces. Plus the match with the most quad caps, and week totals for witch
  crowns, skeets and common infected, naming who led each.
- Hot streaks: up to 4 best W-L records at 5+ decided matches ("mado went
  15-4").
- Iron players: the top player(s) by matches plus the runner-up.
- Closest game: smallest score margin, with campaign and score.

`quad_caps` credits a quad to every infected player in it (a quad needs all
four), so summing it over a match counts each quad four times: match 218 sums
to 12 for 3 quads. The recap counts a match's quads as the highest
`quad_caps` on team a plus the highest on team b, since each team plays
infected in its own halves. The per-player Quad caps award is unaffected.

Discord caps a plain message at 2,000 characters, and the recap plus ~27
award lines exceeds that. So the post is two messages sent back to back: the
recap, then the awards. `weekly_award_weeks` keeps both message ids and
`posted_at` is set only after both are accepted; a retry resends only the one
that is missing.

### API

- `GET /api/weekly?week=<YYYY-MM-DD>`: public, like the other stats reads.
  No `week` returns the current week computed live, flagged `live: true`.
  A past week returns its frozen rows, or 404 if it was never frozen.
- `GET /api/weekly/weeks`: frozen week list for the picker.
- The profile payload gains `weeklyAwards: [{ award, label, count, weeks }]`
  for non-shame awards, grouped by award.

### Site

- Leaderboard page gets a Season / This week toggle. The weekly view shows the
  four sections as a grid of award cards (label, average winner, total
  winner), a week picker, and a "live, final Monday 00:00 UTC" note on the
  current week.
- Profile gets a "Weekly awards" row: one chip per award with a count
  ("Top Skeeter x3"), average and total wins counting as the same award, at
  most 4 chips ordered by count, then "+N more" which expands the full list
  with weeks. Hidden entirely when the player has none.

## Testing

- Week bounds, including a match ending exactly at Monday 00:00 UTC.
- The 5-game gate on averages and its absence on totals.
- Ties share; zeros never win.
- Win streak across a loss and a draw; SR climb for a player whose first
  match of the week was their first ever.
- Freezing is idempotent, and a void after freezing does not change the
  frozen rows.
- `mergePlayers` moves and de-duplicates weekly awards.
- Poster: blank channel posts nothing but freezes; a failed send leaves
  `posted_at` null and the next tick posts once.
- Card rendering: collapse when one player holds both, no emoji characters.
- Dry run against a copy of the prod DB for the week of 2026-09-21, checked
  against the numbers shown in chat (mira tank damage average, VII skeets,
  methanol connoisseur slowest ready-up).

## Out of scope

- Top 3 per award, weekly role filters, notifications to winners.
