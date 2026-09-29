# Staff server chat

2026-09-28. Owner-approved design, written up for review before planning.

## Goal

Admins and moderators can read the chat of every enabled server live on the site, including practice
leases, and talk back: to the whole server, to one team, or privately to one player. A player can
answer staff privately with `/staff <message>`, so someone reporting a teammate is not forced to say
it in front of them.

## Owner rulings

- Staff only (admins and moderators, `makeRequireMod`). Nothing is public.
- Staff see everything, team chat included, even in a match they are playing (teams are on voice, so
  typed team chat reveals nothing worth hiding).
- Send modes: all chat, team chat (survivors / infected / spectators), whisper to one player.
- A whisper always carries a second line telling the player how to answer with `/staff`.
- Chat is kept for good, like `match_chat` (which is never pruned).
- No general rcon box. The site only ever sends the one staff-say command.
- The chat is a drawer on the Live board, and the Live desk opens to moderators (owner, 2026-09-28).
  Moderators may use: the abandon clock (Hold / +5 min / End now), queue removal, practice servers
  (players list, kick, end a lease), abort / void. Server controls stay admin-only: pool in/out,
  restart after match, SourceTV, log signing, Set idle, DLC check, admin sync, settings. The board
  payloads never carry the rcon password or the log secret; they do carry a live match's join
  password, which moderators already see on the mod call card's Join line.

## What exists today

- pug-match emits `PUGSAY steamid=<id64> team=<n> msg=<text>` for every human chat line on every
  server, in a match or not (`plugin/pug-match.sp` EmitConductSay). It goes out through PugLog, so it
  carries the pug-logauth signature.
- The site parses it into `{ kind: 'say' }` (`src/logParse.ts`) and `src/server.ts` hands it to the
  conduct alert check, then drops it.
- `Hub.sendTo(event, allow)` (`src/ws.ts`) sends an event name to chosen signed-in browsers only.
- `RconClient` (`src/rcon.ts`) already takes turns per server (see the rcon-close bug).
- Recent precedent for sanitizing text into an rcon command: the practice kick reason (quotes,
  semicolons and line breaks stripped).

## Design

### 1. Plugin: pug-match 0.3.16

The commands live in pug-match, not a separate plugin, because the site trusts only lines signed by
pug-logauth, and pug-match already holds that secret and the chat sanitizer.

**`sm_pug_staffsay <to> <staff name> <message>`** (server console / rcon only)
- `<to>` is `all`, `survivors`, `infected`, `spectators`, or a SteamID64.
- Prints in colour: `[Staff] <name>: <message>`, `[Staff → Survivors] <name>: ...`, or for a whisper
  `[Staff → you] <name>: ...` followed by a second line `Reply privately with /staff <message>`.
- Whisper finds the player by SteamID64 itself (no `status` round trip).
- Logs `PUGSTAFFSENT id=<send id> delivered=<n>` so the site can show "delivered to 4" or
  "player not on server" (delivered=0). The send id comes from the site as a fourth argument.

**`/staff <message>` and `!staff <message>`** (players)
- Silent: the typed line is suppressed, nobody in game sees it.
- Logs `PUGSTAFF steamid=<id64> team=<n> msg=<text>` (text last, same ordering rule as PUGSAY).
- Tells the player privately `Sent to staff.`
- Cooldown 5 s per player; an empty message prints the usage line.

### 2. Storage

`server_chat` (kept for good):
`id, server_id, at (unix ms), steamid, name (a snapshot: the in-game name last seen, else the site
name, so an old line still says who it was after a rename), team, scope ('all' | 'team' for a `say`
row, null otherwise; a `say` line from a 0.3.15 server has no scope), kind ('say' | 'staff_in' |
'staff_out'), message, match_id (null outside a match), to_kind (for staff_out: 'all' | 'team' |
'player'), to_value (team number or SteamID64), sent_by (staff SteamID64, staff_out only), delivered
(null until the plugin answers)`.

Indexed on `(server_id, id)`. One table rather than a separate audit table: a staff send IS a chat
line, and the drawer shows it in order with the rest. `mergePlayers` gets `server_chat.steamid`,
`server_chat.sent_by` and `to_value` where `to_kind = 'player'`.

### 3. Web: ingest

`src/server.ts`: after the conduct check, each `say` event is stored with the server from
`serverOf(source, meta)` and the match currently running there, if any. New log kinds `staff_in`
(PUGSTAFF) and `staff_sent` (PUGSTAFFSENT) are parsed and stored. Each new row calls
`hub.sendTo('server_chat', isActiveStaff)`. All of it is off the critical path, wrapped
the same way the conduct and mod call handlers are.

A player's first `/staff` message in 10 minutes also posts one quiet line to the admin feed
("<player> messaged staff on <server>: <text>"), no role ping, behind its own toggle
`admin_feed_staff_messages`. `/mod` stays the urgent route.

### 4. Web: API (all `requireMod`, under `/api/mod/chat`)

- `GET /api/mod/chat/servers`: enabled servers with a practice / match / idle label and the time of
  the last line.
- `GET /api/mod/chat/:serverId?after=<id>&limit=<n>` (limit default 200, max 500): lines in order,
  names resolved from the players table (unknown SteamIDs show the last PUGNAME seen, else the
  SteamID). 404 for an unknown server.
- `POST /api/mod/chat/:serverId`, body `{ to: 'all' } | { to: 'team', team: 1 | 2 | 3 } | { to:
  'player', steamid }` plus `message` on all three:
  - message: `;`, `"` and line breaks stripped, trimmed, 1-190 characters and at most 180 UTF-8 bytes after stripping, cut on whole characters (400 if
    empty after stripping, or if `to` and its fields do not match one of the three shapes);
  - staff name: the sender's site name with the same stripping, capped at 32 characters and 48 bytes (the engine and
    plugin buffers count bytes, so a Cyrillic or CJK line could otherwise overflow them);
  - rate limit 5 sends per 10 s per staff member (429 past it);
  - row stored first (delivered null), then `sm_pug_staffsay <to> "<name>" "<message>" <id>` over
    rcon. `staffSayCommand` (`src/staffChatSend.ts`) cleans the name and message again itself, and
    refuses a whisper target that is not a 17-digit SteamID64 ("Bad whisper target."), so a bad
    target can never reach rcon even if a caller skipped the route's own checks;
  - an rcon failure, or an "Unknown command" reply from an old plugin, sets delivered = -1 and
    answers 502 with an error string; nothing is retried.
  - every stored send, good or failed, sends the staff-only `server_chat` hub event, so
    all open drawers show the row; a failure never overwrites a delivery count that already came back.

### 5. Web: UI

- Admin → Live gets a chat drawer (`/admin/live?chat=<serverId>`), opened from a Chat button on each
  server row and match card, with a server picker inside. It loads the last 200 lines and re-reads
  them on each `server_chat` hub event (a delivery report changes an old row).
- Lines are coloured by team; `/staff` messages show as "to staff" with a distinct style; staff sends
  show who sent them, where to, and the delivered count.
- Send box with All / Team ▾ / Whisper. Clicking a name switches to Whisper for that player;
  "Whisper..." in the Send to list reads `GET /api/mod/chat/:serverId/players` (rcon `status`, humans
  with a SteamID64; 502 when the server cannot be reached) and lists who is on the server now, so a
  /mod caller, a reported player or someone only on voice can be whispered without a chat line.
- The mod call Discord card gets a "Server chat" link button, and the In-game calls page a "server
  chat" link, both to `/admin/live?chat=<serverId>`. The admin feed line for `/staff` links there too.
- Moderators see the Live desk with the server controls hidden (read-only values instead).

## Traps and limits

- Team chat versus all chat: 0.3.16 adds `scope=all|team` to PUGSAY, read from the command name in
  `OnClientSayCommand` (`say` or `say_team`). Lines from 0.3.15 servers have no scope.
- Not shown: other plugins' announcements, and SourceTV spectators' chat.
- Old plugin: a server still on 0.3.15 returns "Unknown command" for `sm_pug_staffsay`; the site
  reports that as delivered = -1 with "server needs pug-match 0.3.16".
- Practice leases must still load pug-match; check that the park and drill cfgs do not unload it.
- sv_lan 1 (local server) gives no SteamID64; the plugin already converts by hand there for /mod,
  and the whisper target lookup must use the same helper.

## Rollout

1. Web deploy (tables, ingest, API, drawer). Reading works at once on every server.
2. pug-match 0.3.16 on each empty server, Dallas first, then the rest (stage-on-restart is fine).
3. Real check: a whisper, a team message, a `/staff` reply, and the admin feed line.

## Testing

- Unit: parsing PUGSTAFF / PUGSTAFFSENT (including forged text inside the message), message and
  name stripping, rate limit, merge coverage.
- Route: 401 anonymous, 403 for a plain player, 200 for a moderator.
- Local server with cheats cfg: type in game and see it on the site; send all / team / whisper and
  see each in game with the reply hint; `/staff` stays silent in game and appears in the drawer.
