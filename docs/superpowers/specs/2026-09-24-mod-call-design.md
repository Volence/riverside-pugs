# In-game mod call (`/mod`) design

Date: 2026-09-24. Status: approved in conversation with the owner, awaiting review of this written spec.

## Problem

A player who sees cheating, a team fighting, someone silent on comms, or a broken round (tank stuck) has to leave the game to get staff attention: the site Report button, `/report` in Discord, or a DM. That is slow and public enough that people often don't bother. We want a silent in-game command that pings the moderators in the admin channel within seconds, carries enough context for a mod to jump straight in, and leaves a record on the website.

## Decisions made with the owner

1. **Transport:** a signed log line (`PUGCALL`) through the existing `PugLog` path, the same one conduct alerts use. No HTTP from the plugin, no third-party CallAdmin plugin.
2. **Targetless calls exist.** "My team", "General" and "Something broke" are calls that ping and log but file no ticket (tickets require a player target).
3. **Ping:** a Discord role mention, from a new setting "Mod call role" (the owner's moderation role is `1551114695010816040`). Blank means the card posts without a ping.
4. **Every reason pings.** Noise is controlled by a cooldown per caller, folding and a rate cap per caller, not by quiet categories.
5. **Who may call:** anyone connected to the server, in a match or not. Outside a match the call carries server and map but no match or replay link.
6. **Discord identities on the card:** caller and target are shown as Discord mentions when their account is linked, with those user pings suppressed. Only the role pings.
7. **In-game powers:** unchanged. Everyone who is a mod today is also an admin and already has SourceMod root through the admins.cfg sync. If a mod-only person is ever added, they will need a limited flag set (kick, slay, chat mute/gag, spectator moves: `c`, `f`, `j`); that is out of scope here.
8. **SourceTV viewers** (connected to the relay, not the game server) are Part 2, gated on a local probe.

## Part 1: in game

### Player experience (plugin, pug-match)

- **Commands:** `sm_mod` and `sm_calladmin` via `RegConsoleCmd`, so `/mod` and `/calladmin` are silent through SourceMod's own trigger handling. The `!mod` and `!calladmin` forms are caught in pug-match's existing `say`/`say_team` listener, which runs the command and returns `Plugin_Handled`, so the echo never reaches chat and the conduct logger (`PUGSAY`) never logs the report text.
- **Reason menu:** Cheating, Toxic / team fighting, Griefing / throwing, AFK / no comms, Not speaking English, Something broke (stuck tank, bug, lag), Other. "Safety concern" is deliberately absent: it is handled privately, and a card in the mod channel would expose it. The menu has a footer line telling the player to use the site for safety concerns.
- **Who menu:** skipped for Something broke. Lists every connected human except the caller and the SourceTV bot, labelled `[S] name`, `[I] name`, `[Spec] name`, followed by **My team** and **General**.
- **Details:** text typed with the command (`/mod aimlocking through walls`) is attached. Otherwise, after the menus the player sees "Type details in chat now, only mods see it (30 s), or /skip". Their next `say` or `say_team` within 30 s is swallowed (not shown, not logged as `PUGSAY`) and attached. `/skip`, the timeout or a disconnect sends the call without details. Text is run through the same `SanitizeChat` as conduct lines and capped at 200 bytes.
- **Confirmation:** a private chat line, "Mods have been called. Thanks." The outcome is never reported back, matching the ticket rule.
- **Cooldown:** one call per SteamID per 180 s, kept in the plugin (survives a disconnect/reconnect within the map through a StringMap keyed by SteamID). A caller on cooldown sees "You can call again in m:ss" and no line is emitted.
- **Menu cancelled or player disconnects mid-menu:** nothing is sent.

### The log line

```
PUGCALL steamid=<caller id64> target=<id64|team|general|none> tteam=<caller team> reason=<key> match=<id|0> ord=<map ordinal> half=<half> tms=<ms since round start|-1> via=<game|tv> text=<details>
```

- Emitted with `PugLog`, so it carries the `lseq`/`mac` trailer and is verified in `src/logParse.ts` like every signed line.
- `reason` keys: `cheating`, `toxicity`, `griefing`, `afk`, `english`, `broke`, `other`.
- `text=` is last. The parser reads fields only from the slice before the first ` text=`, the same injection guard `PUGSAY`/`PUGNAME` use. The line must begin with `PUGCALL ` after the engine timestamp, which a player cannot forge.
- `tms` is computed from the round start the plugin already tracks for replays; `-1` when no round is running. The moment link needs `match`, `ord`, `half` and `tms`; when any is missing the card has no replay link.
- The plugin also writes the same call to the SourceMod log (`LogMessage`) so an admin can recover a call lost while the web was down.
- The plugin knows only SteamIDs. Names and Discord ids are resolved on the web.

### Web handling

**Parser:** `logParse.ts` gains a `call` event with the fields above. Unknown reason keys are dropped.

**Table `mod_calls`:**

| column | notes |
|---|---|
| id | integer primary key autoincrement |
| created_at | unix seconds |
| server_id | FK servers |
| match_id | nullable FK matches |
| map, map_ordinal, half, t_ms | moment; nullable |
| caller_steamid, caller_name | always set; name from `players`, else the SteamID |
| caller_id | nullable FK players |
| target_kind | `player`, `team`, `general`, `none` |
| target_steamid, target_name | when target_kind = player |
| target_id | nullable FK players |
| caller_team | integer |
| reason | reason key |
| text | details, may be empty |
| via | `game` or `tv` |
| ticket_id | nullable FK tickets |
| folded_into | nullable FK mod_calls |
| pinged | 0/1, whether this call's post mentioned the role |
| discord_message_id | nullable; null means not yet posted |
| handled_by_discord_id, handled_at | set by the Handling it button |

`caller_id` and `target_id` reference `players`, so both are added to `mergePlayers` (a missing entry makes a merge fail because `foreign_keys = ON`) and to the exhaustive table list in `tests/db.test.ts`. Names are resolved from `players` when the SteamID has an account; otherwise the name column holds the SteamID and the card links the Steam profile. The plugin sends no names, because a name is free text and only one free-text field (`text=`) can sit safely at the end of the line.

**Filing:** when `target_kind = player`, the caller has a `players` row and the reason is not `broke`, the web calls `fileReport(db, callerSteamId, { targetId, category, text, matchId, moment }, deps)`. Category mapping: `cheating`, `toxicity`, `griefing`, `afk` map to themselves; `english` and `other` map to `other`, with the text prefixed `Not speaking English:` for `english`. All existing rules apply: banned reporters and self-reports refused, one open case per target, new reports fold into it. On success `mod_calls.ticket_id` is set. On refusal, or when the caller has no account, the call still stores and posts; the card says "No ticket (reason)".

`ticket_reports` gains a nullable `source` column (`site`, `discord`, `button`, `game`); only the in-game path sets it in this work, the others stay null. The ticket timeline shows "from in game" when it is `game`.

**Folding:** a new call folds into an earlier call when the earlier one is unhandled, not itself folded, less than 5 minutes old, on the same server, and either (a) both target the same player, or (b) both are targetless (`team`, `general`, `none`). A folded call stores `folded_into`, edits the parent card to list every caller ("3 calls: A, B, C", reasons and texts appended), and does not ping. It still files its own ticket report when it qualifies, which the ticket system folds into the open case.

**Rate cap per caller:** a caller with more than 5 unfolded calls in the past hour is stored and posted with `pinged = 0` and a "not pinged: rate cap" line on the card.

**Discord card** (admin channel, `discord_admin_channel_id`):

- Content: `<@&role>` when the "Mod call role" setting is set and the call pings.
- Embed title: `In-game call: <reason label>`.
- Fields: caller and target as `<@discordId>` when linked, else the escaped name with a Steam profile link; server; map; match number; details text (escaped, in a quote block); ticket number or "No ticket (reason)".
- Links: replay at the moment (`/match/<id>?ordinal=<ord>&half=<half>&t=<ms>`), the ticket, and the SourceTV `connect` string built by `spectateFor` (the same one the match card's Spectate button uses) when the server has SourceTV enabled.
- Allowed mentions: roles = [the mod role] only; users = []. This needs `djsTransport.ts` to accept a role allow-list, which it does not today (it only takes `mentionUserIds`). The fake transport gets the same field and records it, so tests can assert that only the role would ping.
- **Handling it** button: records `handled_by_discord_id` and `handled_at`, edits the card to "Handled by @mod", and disables the button. Only members who are admin or mod on the site (linked Discord id) can press it; others get an ephemeral refusal.
- The card is posted even when the admin feed toggles are off; it is not an admin feed event. It uses its own poster with a retry timer: rows with `discord_message_id IS NULL` newer than 24 h are retried every 30 s, so a Discord outage or a web restart loses nothing that reached the database.

**Settings:**

- `mod_call_role_id` (string, group Discord, label "Mod call role", help: "Role mentioned on every in-game /mod call. Empty posts calls without a ping."). Seeded empty; the owner pastes `1551114695010816040`.
- `mod_calls_enabled` (bool, default true). Off stores calls but posts nothing.

**Site:** an admin page "In-game calls": newest first, filter unhandled/all, columns time, server, reason, caller, target, text, ticket link, replay link, handled by. Folded calls nest under their parent. When `discord_admin_channel_id` is blank the page shows a banner that calls are not reaching Discord.

### Failure handling

- Admin channel or role blank: stored and shown on the site with the banner; no Discord post.
- Discord post fails: retried by the timer as above.
- Web down when the line is sent: the call is lost to the web (same limit as every log event). The SourceMod log copy is the recovery path.
- Unsigned, replayed or malformed line: dropped by the existing trailer check.
- Target disconnects before the line is processed: no effect; the SteamID is on the line.
- Caller banned on the site: refused. The row is stored with `pinged = 0` and shown on the site, but nothing is posted to Discord and no ticket is filed.

## Part 2: SourceTV viewers

SourceTV viewers connect to the relay, not the game server, so SourceMod has no client for them and cannot show a menu or run a command. `sourcetvmanager` is installed on all four servers (loaded by `l4d_tvwatch`) and exposes a spectator chat forward. Part 2 starts with a probe on the local test server (`/home/volence/l4d1-ds`, shared: check `status` for humans before restarting it):

1. Is SourceTV chat available on L4D1 at all (`tv_chat` / relay chat cvars exist and deliver)?
2. Does the chat forward fire for a relay spectator, and can returning `Plugin_Handled` suppress the message for other viewers?
3. Can the plugin get the spectator's SteamID (needed to identify the caller and refuse abuse)?

If all three are yes: a viewer types `/mod <reason word> [player name] <text>`. The plugin matches the reason word against the reason keys (and a few aliases: `cheat`, `toxic`, `grief`, `afk`, `english`, `broken`, `other`), matches the optional name against connected players (unique case-insensitive substring; ambiguous or no match becomes `general` with the name kept in the text), applies the same cooldown, emits the same `PUGCALL` with `via=tv`, and replies privately in relay chat if the forward allows it. The card labels the caller "watching on SourceTV".

If any answer is no, this spec is updated with the finding and watchers are pointed to the web Report button. Part 1 does not depend on Part 2.

## Testing

**Web (vitest, full suite every task):**
- Parser: a well-formed line; `steamid=` and `target=` injected into `text=` do not change the fields; missing trailer or a bad mac is dropped; unknown reason dropped; `match=0` and `tms=-1` give no moment.
- Handling: named target with an account files a ticket with the right category, match and moment; `english` maps to `other` with the prefix; `broke` never files; caller without an account stores and posts with no ticket; `fileReport` refusal stores the reason; folding by same target and by targetless on the same server, not across servers, not after 5 minutes, not into a handled call; folded calls do not ping; the rate cap; `mergePlayers` repoints `caller_id` and `target_id`.
- Card: role mention present only when the setting is set; allowed mentions contain only the role; linked players render as `<@id>`, unlinked as escaped names; replay link only with a full moment; the SourceTV connect string only when enabled; Handling it records and disables, refuses non-staff; retry of unposted rows.

**Plugin:** compile with the existing build script, then run on the local test server with rigged bots: the menus list the right people, `!mod` does not echo and does not produce a `PUGSAY`, the details capture swallows exactly one line, the cooldown message, and the emitted `PUGCALL` line verified by the web parser.

**Live checklist for the owner (things the fake transport cannot prove):** the role actually pings and the user mentions do not; the Handling it button in real Discord; one real `/mod` from a player in a match, end to end.

## Rollout

1. Web deploy (`deploy-web.sh`) on an empty server: `mod_calls` table, `ticket_reports.source`, settings, parser, poster, admin page. Dry-run the boot migration on a production backup first, per the tickets recipe.
2. Owner pastes `1551114695010816040` into Mod call role.
3. pug-match with the call feature (the next version after whatever is live) staged on an empty server: Dallas first, then Riverside #3/#4 and Chicago. Follow the fleet parity recipe.
4. The owner makes one real test call in game.
5. Part 2 probe, then Part 2 if the probe passes.

## Out of scope

- In-game SourceMod flags for mod-only people (see decision 7).
- Telling the caller the outcome.
- Calling from the web or Discord (the Report button and `/report` already exist).
- Safety concerns from in game.
