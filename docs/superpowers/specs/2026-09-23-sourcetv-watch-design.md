# SourceTV: no delay, every spectator on record, and the map-change drop

Status: design approved by the owner in conversation 2026-09-23. Not built.

## Why

SourceTV runs on all four servers with `tv_delay 30`, behind `tv_password "dunged"`, which
most regulars know. Spectators are dropped at every map change and have to reconnect, and
nobody has found out why. The owner wants SourceTV live (no delay) and, in exchange, a record
admins can check for ghosting: who was watching, when, and whether they were on the same
connection as somebody playing that match.

The website's live viewer is not part of this. It is public and anonymous, so it keeps its
10-second delay.

## What the server can know about a SourceTV spectator

A SourceTV spectator connects without Steam authentication. The server knows only the name
they typed and their IP address. The IP is enough: every player connect already sends its IP
on a signed `PUGNET` log line, and the site stores it only as an HMAC (`hashIp` in
`src/playerNetworks.ts`), which is what powers "seen on the same connection as". A SourceTV
spectator's IP, hashed the same way, can be matched to the players who have used that
connection. That is evidence, never proof (households, VPNs), and the admin copy says so, the
same as the existing shared-connection view.

## Pieces, in order

### 1. The extension, proven locally first (spike)

`peace-maker/sourcetvmanager` (already cloned at `/home/volence/l4d/sourcetv/sourcetvmanager`)
exposes SourceTV spectator events: `SourceTV_OnSpectatorConnected`, `..._OnSpectatorDisconnect`
(with a reason), `SourceTV_GetClientName`, `SourceTV_GetClientIP`, `SourceTV_OnServerStart`,
`SourceTV_OnServerShutdown`. It ships a `left4dead` game data section.

- Build it for L4D1 32-bit inside the Ubuntu 22.04 container, the same way as
  `sourcetvsupport` and the consistency extension (a host build on Arch links GLIBC 2.4x and
  will not load on the servers).
- It has never run beside `sourcetvsupport`, which is what makes SourceTV work on L4D1 at all
  and which detours HLTV code too. So it is loaded on the local test server first, with
  `sourcetvsupport`, and must: load without errors, survive map changes, and fire the connect
  and disconnect events for a real SourceTV spectator.
- If it cannot coexist, stop and report: pieces 2 and 3 need another way to see spectators.

### 2. Why spectators are dropped at a map change (diagnosis)

With the extension loaded on the local server, a throwaway plugin logs every server start and
shutdown event and every spectator disconnect with its reason. The owner joins the local
SourceTV as a spectator (about 10 minutes) while maps are changed over rcon. The result says
whether SourceTV is torn down and rebuilt on each level change (structural) or spectators are
dropped for a reason that can be addressed.

**The fix is decided after the diagnosis, with the owner.** It may be a real fix, or it may be
limited to telling spectators to reconnect. Nothing is promised here.

### 3. Every SourceTV spectator on record (can run beside piece 2)

**Plugin `l4d_tvwatch`**, on all four servers, using the shared signed-log include
(`plugin/pug-logauth.inc`, `PugLog`):

- On `SourceTV_OnSpectatorConnected`: `PUGTV event=join slot=<n> ip=<ip> cc=<country> name=<name>`
- On `SourceTV_OnSpectatorDisconnected`: `PUGTV event=leave slot=<n> reason=<reason> name=<name>`
- The name is always last on the line, as with every other line that carries player text, so
  a name cannot forge an earlier field. The country comes from `geoip` where the server has it,
  as `PUGNET` does.
- Proxies (`SourceTV_IsClientProxy`) are ignored.

**Site:**

- `src/logParse.ts`: parse `PUGTV` lines (signed, admitted only from a known server address,
  exactly as `PUGNET`).
- New table `sourcetv_sessions`: `id`, `server_id`, `match_id` (the match live on that server
  at join time, or null), `slot`, `name`, `ip_hash` (via `hashIp`; the raw IP is never
  stored), `country`, `joined_at`, `left_at`, `leave_reason`. A join opens a row; a leave closes
  the open row for that server and slot. Rows left open when a server restarts are closed at the
  next join on that slot or by the orphan reaper.
- **Likely accounts:** the players whose recorded network hash equals the session's `ip_hash`
  (the same lookup `sharesAddressWith` uses).
- **Admin match page:** a "SourceTV watchers" section listing each session in that match: name,
  likely account(s), country, joined and left times (and which map/round that was, from the
  match's timeline). Admin only.
- **Admin feed alert:** when a session's likely account is rostered in the match live on that
  server, post at once to the admin problems channel: "SourceTV spectator 'x' is on the same
  connection as <player>, who is playing match N". Uses the existing `adminFeed.ts` event path
  and its settings key, like `signon_drop`.

### 4. No delay

`tv_delay 0` on all four servers (Dallas and Riverside via their cfg overrides, Chicago via its
cfg), changed only after piece 3 is live, so there is never a window of undelayed, unrecorded
viewing. Takes effect at the next map load. The password stays. The website viewer is unchanged.

## Safety and rollout

- Nothing reaches a live server before the local spike passes. Extension and plugin are staged
  on empty servers only, one server first (Dallas), then the rest.
- Rollback: unload `l4d_tvwatch` and the extension (SourceTV keeps working without them, as
  today), and `tv_delay 30`.

## Tests

- Parser: `PUGTV` join and leave lines, including a name containing `event=` and `ip=` text
  (must not forge fields), and an unsigned or wrong-source line (rejected).
- Sessions: join opens, leave closes the matching server and slot; a second join on a slot
  whose row is still open closes the stale row first; `match_id` is the match live on that
  server at join time.
- Raw IP never stored (only the hash).
- Alert fires only when a likely account is rostered in that live match; not for a spectator
  matching nobody, nor a player from another match.
- Admin route and page: the section is admin only.

## Out of scope

- The website live viewer and its delay.
- Changing or removing the SourceTV password.
- Blocking spectators automatically (the owner chose record and flag, not block).
