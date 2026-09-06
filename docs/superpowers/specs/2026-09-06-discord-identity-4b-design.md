# Sub-project 4b: Discord Identity, Linking + Gate

**Date:** 2026-09-06
**Status:** Design, awaiting review. **Blocked on credentials only you can create.**
**Parent:** `2026-09-06-dual-surface-design.md`

## Goal

Make a Discord user resolve to a player row, and let Discord server membership be
what makes someone `active`, replacing the shared invite code as the normal path
in. Everything Discord-facing in 4c–4f depends on this and nothing else does, which
is why it comes first among the bot pieces.

## A correction to the build order

The umbrella design put both link flows in 4b. One of them can't be here: the
`/link` slash command needs a running bot, and the bot is 4c.

Splitting it along the real dependency:

- **4b (this):** the OAuth link flow, the membership gate, and the schema. Needs a
  bot **token**, but no gateway connection. Discord's REST API answers membership
  questions over plain HTTPS with `Authorization: Bot <token>`. No discord.js, no
  always-on socket, nothing to crash.
- **4c:** the `/link` code flow arrives with the rest of the slash commands, on top
  of the schema and the link-completion path 4b already built.

This makes 4b a pure backend change with no new runtime component, which is the
right shape for the piece everything else waits on.

## What you need to create before this can be verified

This is the blocker, and it needs your Discord account:

1. A Discord **application** (discord.com/developers) → gives `DISCORD_CLIENT_ID`
   and `DISCORD_CLIENT_SECRET`.
2. A **bot user** on that application → gives `DISCORD_BOT_TOKEN`. The bot must be
   invited to the server with the `guilds.members.read` scope so it can be asked
   who is a member.
3. The **server (guild) ID** → `DISCORD_GUILD_ID`.
4. An OAuth **redirect URI** registered on the application, matching
   `PUBLIC_URL` + `/auth/discord/callback`.

I can build and test the whole thing against a fake Discord before those exist.
The codebase already injects `verifyLogin` and `fetchPersona` for exactly this
reason. But the first real link can only be tried once you've made the app.

## Schema

```sql
ALTER TABLE players ADD COLUMN discord_id   TEXT;    -- SNOWFLAKE, unique when set
ALTER TABLE players ADD COLUMN discord_name TEXT;    -- cached for display only
CREATE UNIQUE INDEX players_discord_id ON players(discord_id) WHERE discord_id IS NOT NULL;
```

The partial unique index is the important part: one Discord account maps to exactly
one Steam account, but many players legitimately have no Discord linked, and a
plain UNIQUE would collide all of them on NULL in some engines. Attempting to link
an already-claimed Discord id fails loudly rather than silently stealing it. That
case is somebody trying to link a second Steam account to their Discord, and
quietly moving the link would orphan their rating.

## Flow

```
site: "Connect Discord"
  → GET  /auth/discord           302 to Discord authorize, state=<signed, session-bound>
  → user approves on discord.com
  → GET  /auth/discord/callback  code + state
       verify state matches this session      (else 400; this is the CSRF guard)
       exchange code for a user access token
       fetch the Discord user (id, username)
       reject if that discord_id belongs to another player
       write discord_id/discord_name onto the logged-in player
       check guild membership; activate if it passes
  → 302 back to /player/<steamid>
```

`state` is signed with `COOKIE_SECRET` and bound to the session cookie. Without
that, anyone can walk a logged-in player through a callback that attaches the
attacker's Discord account to the victim's player row.

## The gate

`GET /guilds/{guild}/members/{user}` with the bot token: 200 means member (and the
body carries their roles), 404 means not.

- Optional `settings.discord_required_role_id` (default `''`). Empty means
  membership alone is enough; set it and the member must also hold that role.
- Checked at link time **and** at login, because membership can be revoked. A
  player who leaves the server does not lose their rating or history. They lose
  the ability to queue, which is what `status` already controls.
- `settings.invite_code` stays and keeps working. It is the fallback for someone
  not in the Discord, and the only path in if Discord is unconfigured.

**If Discord is unconfigured** (`DISCORD_CLIENT_ID` unset), every route above
returns 404 and the site behaves exactly as it does today. That is the tested
default, so an unconfigured deploy is never a broken deploy.

## Structure

- `src/discordApi.ts`: a `DiscordApi` interface (`exchangeCode`, `getUser`,
  `getGuildMember`) plus the real fetch-backed implementation. Injected into
  routes the way `verifyLogin` is, so tests never touch the network.
- `src/routes/discordAuth.ts`: the two routes above.
- `src/players.ts`: `linkDiscord`, `unlinkDiscord`, `playerByDiscordId`. That last
  one is the function 4c's every slash command starts with.
- `web/`: a "Connect Discord" / "Disconnect" control on the profile page, and the
  registration page gaining Discord as the primary path with the invite code
  demoted to a secondary option.

## Testing

Against a fake `DiscordApi`, no network:

- Callback with a mismatched or missing `state` is rejected.
- Callback for a `discord_id` already linked to another player is rejected, and
  leaves both players untouched.
- A member of the guild is activated; a non-member is not.
- With `discord_required_role_id` set, a member lacking the role is not activated.
- Revocation: a linked player who has left the guild loses `active` at next login
  but keeps their rating rows and match history.
- Unconfigured Discord: routes 404, invite-code registration still works.

## Open question for you

**Should leaving the Discord server deactivate someone immediately, or only stop
them queueing?** The design above does the milder thing: they keep everything,
they just can't queue. Worth confirming that matches what you want for a friend
group where someone might leave the server in a huff and come back.
