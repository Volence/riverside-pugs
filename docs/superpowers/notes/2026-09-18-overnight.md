# Overnight 2026-09-17 to 18: Discord bot + admin panel

Spec: `docs/superpowers/specs/2026-09-17-discord-bot-and-admin-design.md`
Plan: `docs/superpowers/plans/2026-09-17-discord-bot-and-admin.md`

All six parts (A to F) are built and tested (1354 tests green). Deploy status is at
the bottom.

## What you can try

**On Discord (#queue-here)**
- The queue panel: Join Queue / Leave Queue / Website / Leaderboard. It is kept as
  the last message in the channel.
- Press Join while unlinked: you get a private "Link Steam account" button.
  Sign in with Steam once and you are linked (and activated if you are in the server).
- When the queue pops: a card pings the 8 players with Ready, then campaign vote
  buttons, then teams + a Connect button (private reply with the console line),
  then "server is ready" pings, then a result post with SR changes.
- Team A / Team B voice channels per match under a `PUG #N` category; anyone
  already in voice is moved in. Deleted when the match ends and they empty, or
  10 minutes after the end.
- Slash commands: `/profile [user]`, `/leaderboard`, `/matches [user]`, `/queue`, `/link`.

**On the site**
- Profile: Connect Discord / Disconnect (your own profile only).
- Register page: Connect Discord first, invite code second.
- `/admin` (nav link for admins): Players (search, ban with reason + length,
  unban, activate, admin flag, unlink Discord, clear penalties, notes, reports
  against, penalty history), Matches (abort open match, set server idle, remove
  from queue, void a completed match), Reports, Settings, Audit.
- Match page: "Report a player" for people who played in it, for 48 hours.
- No-show penalties: missing a ready check or never connecting to a match that
  gets aborted for no-shows costs a queue timeout of 5 min, 15 min, 1 h, then 1 day
  (7 day window). Shown on /play with a countdown; Discord join refuses with a
  timestamp. Admins can clear them, and the ladder is editable in Settings.

## Decisions I made without you

1. **Leaving the Discord server does not deactivate anyone.** The gate only ever
   activates. (4b's open question; the milder answer.)
2. **Void = aborted + full season ratings rebuild.** Scores are never hand-edited.
   The rebuild replays every completed match in finish order through the same
   rating code, and a test proves it reproduces the live ratings exactly when
   nothing is voided.
3. **The panel is reposted below every new bot message** (not rate limited, which
   the spec suggested). A 5 s limit made the panel end up above the result post.
4. **Old matches show no "never connected" warnings.** connected_at only exists
   for recent matches, so the admin panel flags it on aborted matches only.
5. **A ready-check failure penalises only the players who did not ready.** The
   "nobody readied in game" no-show rule penalises nobody, since that is not
   anyone's no-show.
6. **Timed-out and banned players can still browse, link and report.** Only
   queueing is blocked.
7. **Existing webhook announcements are silenced while the bot runs** (they
   would duplicate the cards). The webhook setting is still editable.
8. **Reports** allow one per (reporter, target, match); the reported player is
   never told who filed it; categories are griefing, cheating, toxicity, afk, other.

## Verified live

- The discord.js adapter was smoke-tested against the real server in a private
  throwaway channel (created and deleted by the bot): send, edit, delete, detection
  of a hand-deleted message, slash command registration, voice category + channels
  create / member count / delete. All passed.
- Side effect: the slash commands are registered in the guild, so before the
  deploy they show "The application did not respond".

## Not verified until real use

- Button presses and slash commands from real users (needs the deployed bot).
- Moving members between voice channels (needs someone in voice).
- The OAuth "Connect Discord" round trip on riversidepug.com.

## Deploy

See the end of this file for what happened.

### Result

Overnight background deploy watchers were killed by the host twice. Deployed on
request 2026-09-17 12:53 UTC with no match open (one idle player dropped from the
queue by the restart). Bot logged in as Riverside Pug Bot#8281; queue panel posted
in #queue-here with its four buttons; /admin and /link/discord serve, admin and
Discord auth APIs answer 401 anonymously.
