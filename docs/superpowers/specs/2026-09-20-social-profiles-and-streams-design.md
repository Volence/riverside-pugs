# Social profiles, the streams page, chemistry, and endorsements

Status: design approved in conversation 2026-09-20, spec written the same day. Nothing
built.

Scope: web app only. No plugin change, no game server change, no cfg change. Work happens on
a worktree and nothing is deployed until the owner says so.

Related: `2026-09-17-discord-bot-and-admin-design.md` (the bot, the result card, the button
transport this reuses), `2026-09-15` audit work (why every free text field here is
constrained rather than trusted).

## Decisions taken by the owner, 2026-09-20

1. **Placement:** a new `/streams` page, not a merge into `/live`. `/live` already scrolls a
   long way with three games of replay viewers, so it gains only a one line strip.
2. **Twitch link:** real OAuth, the same shape as the Discord link. Not a typed name.
3. **Profile fields:** fixed social handle fields, a short bio, country, and pronouns.
4. **Who is listed:** anyone who links Twitch. Offline tier capped, most recently live first.
5. **Ghosting:** no filtering of live streams from opposing players. The owner's ruling is
   that streamers accept that risk. Recorded here so it is not re-litigated later.
6. **Pinned replay clips: cut.** The viewer is a top down map view, so a skeet is two dots
   ceasing to be two dots. The idea does not survive contact with what the viewer shows.
7. **No DMs.** Endorsements ride the result card that the bot already posts, via ephemeral
   replies. Not one new message is sent to anyone.
8. **Endorsement kinds:** Caller, Clutch, Good vibes. The owner's words, because "caller" is
   already an identity in this community rather than a statistic.
9. **Twitch VOD links: deferred** to a final phase needing its own go-ahead.

## Why the tiering is the point

elmt.gg/live sorts streamers into live and offline. That is all it can do, because it knows
nothing about what those people are doing.

This site knows who is in queue and who is on a live match roster. So the top tier is not
"this person is streaming", it is "this stream is a Riverside PUG happening right now". That
is a different and better page, and the relationship runs both ways: `/live` can say three
people are streaming the match you are looking at.

Everything else in this spec is ordinary community site furniture. The tiering is the part
worth building carefully.

## Data model

Style follows `src/db.ts` as it already is: `CREATE TABLE IF NOT EXISTS` in `SCHEMA` for new
tables, `ensureColumn` for new columns, no migration framework.

### Columns on `players`

```
bio         TEXT     -- <= 200 chars, plain text, no markup, no URLs
pronouns    TEXT     -- <= 24 chars, plain text
country     TEXT     -- ISO 3166-1 alpha-2, validated against a fixed list
twitch_id   TEXT     -- Twitch's numeric user id
twitch_name TEXT     -- cached login, refreshed every poll, used only to build the URL
```

Plus, mirroring `players_discord_id`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS players_twitch_id
  ON players(twitch_id) WHERE twitch_id IS NOT NULL;
```

`twitch_id` is canonical and `twitch_name` is a cache. Twitch logins change; ids do not. A
partial index because the overwhelming majority of rows will hold NULL and NULLs must not
collide.

### `player_links`

```sql
CREATE TABLE IF NOT EXISTS player_links (
  player_id  TEXT NOT NULL REFERENCES players(steamid),
  platform   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  PRIMARY KEY (player_id, platform)
);
```

A table rather than four more columns on `players`, so adding a platform later is a row
rather than a migration.

**Deliberately no `CHECK (platform IN (...))`**, even though the rest of this schema uses
them freely. A CHECK cannot be altered in SQLite without rebuilding the table, which would
make adding a platform exactly the migration this table exists to avoid. The permitted set
lives in one place in code, the platform template registry that also builds the URLs, and the
write path validates against it. One source of truth, and it is the one that has to be
correct anyway.

**`handle` is a handle, never a URL.** The URL is built server side from a per platform
template. This is the single most important constraint in this document: the site is public,
and it has already had one identity forgery bug (`logParse` roster forgery). A free URL field
on a public profile is an open redirect for phishing and a place to hang anything at all.
Storing a handle and generating the link makes that structurally impossible rather than
policed.

### `twitch_status`

```sql
CREATE TABLE IF NOT EXISTS twitch_status (
  player_id    TEXT PRIMARY KEY REFERENCES players(steamid),
  is_live      INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  game_name    TEXT,
  viewers      INTEGER,
  thumbnail    TEXT,
  started_at   TEXT,
  last_live_at TEXT,
  checked_at   TEXT NOT NULL
);
```

Separate from `players` on purpose. This is volatile data overwritten every sixty seconds by
a background job, and keeping it out of `players` means that write path never touches the row
where identity, admin flag and ban status live.

`started_at` is the stream start, kept because it gives uptime now and the VOD offset in the
deferred phase. `last_live_at` orders the offline tier.

### `endorsements`

```sql
CREATE TABLE IF NOT EXISTS endorsements (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  from_id    TEXT NOT NULL REFERENCES players(steamid),
  to_id      TEXT NOT NULL REFERENCES players(steamid),
  kind       TEXT NOT NULL CHECK (kind IN ('caller','clutch','vibes')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_endorsements_to ON endorsements (to_id, kind);
```

The primary key is an anti abuse rule expressed structurally: one endorsement per giver per
recipient per match. No stacking all three kinds on the same friend, no endorsing twice.

What the schema cannot express, and what the write path therefore enforces with tests behind
it: `from_id != to_id`, both parties rostered on that match, match `state = 'completed'`,
inside the window, and within the per match budget. A `CHECK` cannot see another table.

Chemistry adds no schema. It is a query.

### Settings

Added to `DEFAULT_SETTINGS`, following the reasoning in `5d2ae85` that a threshold for an
average deserves its own knob rather than a reused one:

| key | default | meaning |
| --- | --- | --- |
| `chemistry_min_games` | `5` | minimum shared matches before a with/against win rate is shown |
| `endorse_budget` | `2` | endorsements a player may give per match |
| `endorse_window_hours` | `24` | how long after a match ends endorsing stays open |
| `endorse_title_min` | `5` | endorsements of one kind before that kind can become a title |
| `endorse_title_min_games` | `10` | matches played before any title is shown |

Poll interval, staleness cutoff and the offline tier cap are constants in code, not settings.
Nobody will ever want to tune them from an admin panel.

## Twitch integration

### Prerequisite, done by hand

Register an application at dev.twitch.tv:

- Name: Riverside PUG
- Redirect URLs: `https://riversidepug.com/auth/twitch/callback` and
  `http://localhost:8080/auth/twitch/callback` for local testing. `PUBLIC_URL` defaults to
  `http://localhost:8080` in `src/config.ts`.
- Category: Website Integration
- Client Type: **Confidential**. The secret lives in the Node process on the box. Public
  clients cannot hold a secret and could not use the client credentials grant the poller
  needs.

`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` go in the box `.env` beside the Discord ones
and never leave it.

### Linking: `src/routes/twitchAuth.ts`

Authorization code flow with an **empty scope list**, which is enough to call
`GET helix/users` as the authenticated user and learn their id and login. We want no
permission beyond knowing who they are.

Mirrors `src/routes/discordAuth.ts` throughout, including its CSRF handling: that file
already carries a comment about an attacker walking a logged in player through a callback
that attaches the wrong account, and whatever it does about that is what this does.

On success, write `twitch_id` and `twitch_name`. On unique index violation, the channel is
already claimed by another player: reject with a clear message rather than stealing it.

Unlinking clears `twitch_id`, `twitch_name`, and the `twitch_status` row. It is the single
off switch: no row, no listing anywhere, no badge. There is deliberately no separate "hide me
from /streams" toggle, because unlink already is one.

### Polling: `src/twitchPoll.ts`

One background job. App access token from the client credentials grant, cached in memory and
re-fetched on a 401.

`GET helix/streams` accepts up to 100 `user_id` parameters per request, so the whole
community is **one HTTP request per poll** regardless of how many people link. That makes the
interval essentially free, so it is 60 seconds. Twitch's own data lags around a minute, so
polling faster buys nothing real.

Each poll upserts every linked player's row: present in the response means live with fresh
title, viewers, thumbnail and `started_at`, plus `last_live_at` bumped; absent means
`is_live = 0` with the other fields left as they were. `checked_at` is always written.

**Staleness is handled explicitly.** If the most recent successful poll is more than ten
minutes old, the read path stops reporting anyone as live and the page says status is
unavailable. A wrong "offline" is a shrug. A LIVE badge stuck on forever because the poller
died makes the entire page untrustworthy, and that is the failure mode this exists to
prevent.

Thumbnails arrive as a `{width}x{height}` template, substituted at render to 440x248 with
`checked_at` appended as a cache buster. Twitch's CDN will otherwise happily serve a frame
twenty minutes old.

## Pages

### `/streams`

Three tiers. **A tier with nothing in it renders nothing at all**, not an empty heading.

**Live in a PUG.** Full width cards: thumbnail, LIVE badge, viewer count, uptime, stream
title, avatar, name, and a chip naming the match and current map, linking to `/live`. That
chip is the reason this tier exists, so it is the loudest element on the card. Membership is
`is_live` intersected with the in memory queue and the rosters of matches in state `live`.

**Live.** The same card at smaller scale, without the match chip.

Both sort by viewer count descending.

**Offline.** Compact avatar grid: circular avatar, name, "last live 3 days ago", linking
straight to the Twitch channel. Ordered by `last_live_at` descending, capped at 24 with a
"show all". No Players / Content Creators filter tabs; the owner does not want that split.

Client polls at 60 seconds, matching the server job.

### The strip on `/live`

One line at the top, above the match cards: a few avatars with a live dot, "3 streaming now",
linking to `/streams`. **Not sticky**, because that page is already a long scroll and a
sticky bar would take space from the thing people came for.

When nobody is live the strip does not render at all, so a quiet night leaves `/live` exactly
as it is today.

### Profile

Pronouns and a country flag beside the name in `Headliner`, bio underneath, then a row of
social chips: icon plus handle, rendered only for platforms actually filled in, Twitch
included.

Editing is an expanding panel on your own profile, next to where `DiscordLinkCard` already
sits and under the same self check that card uses:

```
session && (session.kind === 'active' || session.kind === 'pending')
  && session.me.steamid === steamid
```

No `/settings` route for six fields. If settings accumulate later, moving them is small.

## Chemistry

A self join on `match_players` over `m.state = 'completed'`, which is also what excludes
voided matches, since voiding sets `aborted`. Ids resolve through `player_aliases` first so a
merged alt is not counted as a separate teammate.

Three lines on the profile:

- **Most played with**: highest count of shared completed matches on the same team. No
  threshold, because it is a count and a count of three is honestly a count of three.
- **Best with**: highest win rate on the same team, gated by `chemistry_min_games`.
- **Worst against**: lowest win rate on opposing teams, gated by `chemistry_min_games`.

The gated lines are averages, so they follow the precedent the owner set in `5d2ae85`: an
average over three games is noise. If nobody clears the threshold those lines are absent
rather than shown empty.

Three lines and no more. The profile already carries a lot of numbers.

## Endorsements

### Giving one

The bot already posts a result card per match (`renderResult`, kind `result`, ref the match
id) carrying a single "Match page" link button. It gains an **Endorse** button beside it.

Clicking produces an **ephemeral** reply, visible only to the clicker, listing the seven
other players as buttons. Pick a player, then pick a kind, and the ephemeral edits in place
to show what remains. Seven buttons is two rows, well inside Discord's limits, so
`presenter.ts` needs no new component type: the button and ephemeral machinery in
`djsTransport.ts` already does all of this.

**No new message reaches anybody.** No DM, nothing added to the channel. A player who never
clicks Endorse is never contacted about it. That is the whole reason for this shape.

A click from someone not on that roster gets an ephemeral "you were not in this match" and
changes nothing.

On the site, the match page carries the same panel, and a quiet one line bar appears at the
top of the site when you have unspent endorsements from a recent match. That is a page
somebody chose to open, not a notification.

### The rules

- `endorse_budget` (2) per giver per match, chosen from the seven other players, either team.
  Cross team endorsement is worth encouraging.
- No self endorsement. Both parties rostered. Match `completed`.
- Open for `endorse_window_hours` (24) after the match ends, then closed. Without a window, a
  pair can decide one evening to farm every match they have ever played.
- **No negative option exists.** There is no downvote, so there is nothing to aim at whoever
  out fragged you.
- Budget is enforced inside a transaction, so a double submitted click cannot spend three.

### What it shows

Aggregate and anonymous, like Overwatch. A profile shows counts per kind and a received per
match rate. **It never shows who endorsed whom.** The moment it does it becomes a public
record of who likes whom, which is the opposite of the intent.

### Titles

The payoff is a word, not a number. "Caller" under somebody's name is worth more to them than
"17 comms endorsements", and it lets a newer player read a roster before a match starts.

A title is shown when all three hold:

1. The player has at least `endorse_title_min_games` (10) completed matches.
2. They have at least `endorse_title_min` (5) endorsements of that kind.
3. That kind is the **strict** plurality of their received endorsements. A tie shows no
   title, which also stops a title flickering between two kinds match to match.

Titles appear next to the name on the profile, on match rosters, and on the leaderboard. The
counts stay on the profile; the title is the part that travels.

### Collusion detection: deliberately not built

The budget of two, the 24 hour window, and anonymity together make farming tedious for very
little payoff. The table records `from_id`, so if it ever does become a problem the data
needed to audit it is already there. Building a detector now would be guessing at an abuse
pattern nobody has exhibited.

## Security

The site is public and has a recent audit history, so every field here is constrained rather
than trusted.

- **Handles** are validated server side against a per platform character pattern and stored
  as handles. The URL is generated from a template. There is no code path that renders a user
  supplied URL.
- **Bio** is capped at 200 characters, plain text, with URLs rejected on submit. Preact
  escapes on render, so this is defence in depth rather than the only barrier.
- **Country** is validated against a fixed ISO 3166-1 alpha-2 list. Not free text.
- **Pronouns** capped at 24 characters, plain text.
- **Twitch OAuth** carries the same CSRF state handling as `discordAuth.ts`. A channel
  already linked to another player is refused, not reassigned.
- **Endorsement endpoint** requires an authenticated session and checks roster membership,
  window and budget server side. The Discord path checks the same things against the linked
  player, never against the Discord id alone.
- **Rate limiting:** the September audit recorded that the site has none anywhere. This spec
  does not fix that. It does add two new authenticated write endpoints, profile edit and
  endorse, and profile edit is the more interesting of the two because it writes strings that
  are then shown on a public page to everyone. Both should be included in whatever rate
  limiting work lands from that audit.

## Testing

- Handle validation and URL generation per platform, including rejection cases.
- Bio sanitation: length, URL rejection.
- Country validation against the fixed list.
- Chemistry queries against fixtures: alias resolution, aborted and voided matches excluded,
  threshold behaviour, absent lines when nothing clears it.
- Endorsement write path: self endorsement refused, non roster refused, budget exhausted,
  window closed, double submit cannot exceed the budget.
- Title computation: threshold not met, tie produces no title, strict plurality wins.
- Twitch poller against a fake transport in `tests/fakes`: live and offline transitions,
  token refresh on 401, and that a stale cache does not report anyone live.

## Phases

Each phase is independently shippable and leaves the site coherent.

1. **Profile fields.** Schema, validation, the edit panel, the display. No Twitch anywhere.
2. **Twitch link.** OAuth route, profile card, unlink. Still no page.
3. **Streams page.** Poller, `/streams`, the strip on `/live`.
4. **Chemistry.** Query and three profile lines. No schema.
5. **Endorsements.** Schema, endpoint, the Endorse button and ephemeral flow, match page
   panel, titles.
6. **Twitch VOD links. Deferred, needs its own go-ahead.** See below.

## Phase 6: Twitch VOD links, deferred

Worth writing down so the decision is not re-made from scratch.

**The idea.** After a match, look for the VOD covering it and put a "watch <name>'s POV" link
on the match page, timestamped to the match start.

**The timestamp problem is solved.** Helix gives `started_at` for the stream and
`matches.went_live_at` gives the match start, so the offset is subtraction, and Twitch VOD
URLs accept `?t=1h24m30s`. The link lands on the PUG rather than on hour six of whatever else
they played that night. This was the owner's specific worry and it has a clean answer.

**The VODs-are-off problem has no fix, only honest handling.** "Store past broadcasts" is off
by default on Twitch and many people never enable it, so for a good share of streamers no VOD
will ever exist. Retention also expires, short for a plain account and much longer for
Partner or Prime. **Verify Twitch's current retention numbers before relying on them**; they
are not stated here because the figures in circulation are frequently out of date.

So the contract must be: look for a VOD after the match, store it only if one exists, show
nothing whatever when it does not, and run a cheap nightly job clearing links whose VOD has
vanished. Absent by default, bonus when present.

**Why it is last.** It reuses the Twitch client with no new auth, so it is perhaps a day of
work, but it is silently absent for a large fraction of the people it applies to. It should
not hold up anything above it.
