# In-game PUG entry point, public deployment, and match demos

Date: 2026-09-11
Status: approved, implementation starting

## Problem

The pug system works end to end in tests but has never run anywhere real. Two
gaps keep it theoretical:

1. **No deployment.** The app has only ever bound `0.0.0.0:8080` on a
   workstation. No host, no TLS, no public URL, so Steam login has nowhere to
   redirect back to and nobody but the author can see it.
2. **No way to start a match from inside the game.** Matches can only be
   created by the queue/lobby pipeline, which needs eight people on a website
   that does not exist yet. Testing the scoring path therefore requires
   hand-typing rcon commands.

The stated near-term goal is smaller than full matchmaking: play a normal game
on the server, have players recorded by SteamID64 with their stats, and see the
result on a real website. Queue, Discord, and map voting stay out.

## Non-goals

- Website-driven or Discord-driven queueing (sub-projects 4b onward).
- Map voting and SR-balanced team assignment.
- Object storage for demos. Deferred by the user; on-box only.

## Background: two blockers that turned out to be smaller than recorded

**`exec pug_match` was never a design flaw.** `rotoblin_hardcore_4v4.cfg` is 28
self-contained lines: it execs the reset/unload/shared-plugin configs, sets
`l4d_ready_server_cfg` (which the l4dready plugin reads to exec the per-map
config on every map), sets the rotoblin cvars, execs the map config, and
restarts the map. comp_loader is not involved in loading it. `exec <config>.cfg`
works from anywhere, rcon included. The only thing wrong with the original
design was that nobody created the file it pointed at.

**comp_loader's rcon block is irrelevant.** `sm_match` / `sm_load` / `sm_mode`
do bail on `client == 0` (`comp_loader.sp:925`), but comp_loader is only a menu
that picks a filename from a fixed list of cvars. There is no free-form slot for
a custom config, so we would not have used it even if rcon could reach it.

## Design

### 1. The ranked ruleset

`rotoblin_pug_4v4.cfg` and `rotoblin_pug_4v4_map.cfg`, cloned from the hardcore
4v4 pair, with `l4d_ready_league_notice "4v4 PUG"` so the active ruleset is
visible in game. Both live in `deploy/overrides/left4dead/cfg/`.

Cloning rather than pointing at `rotoblin_hardcore_4v4.cfg` directly pins the
ranked ruleset: editing the config people play casually must not silently
change the rules underneath existing ratings.

### 2. `!load_4v4p`

A new admin-gated command in `pug-match.sp`, alongside the five existing
`RegServerCmd` handlers. Registered with `RegAdminCmd` so it works from chat,
which the server commands cannot.

On invocation:

1. Snapshot every connected client into teams `a` / `b` by the side they are
   currently on.
2. Capture their in-game names. **This removes the Steam API key dependency**:
   names come from the game, not from `GetPlayerSummaries`.
3. Generate a match token locally.
4. Emit `MATCH_CREATE` over the existing `logaddress` feed with token,
   campaign, and roster.
5. `tv_record pug_<token>_<ordinal>_<map>` (see section 5).
6. `exec rotoblin_pug_4v4.cfg` and enter `MS_Pending`.

Everything downstream already exists and was verified live on 2026-09-06: team
lock, cross-map score attribution, `MAP_RESULT`, `MATCH_END`, `sm_pug_dump`.

Roster policy, per the user's decision: snapshot whoever is present, and
auto-create a `players` row for any SteamID64 the site has not seen. Nobody has
to register first.

### 3. Match identity

The plugin cannot invent a match id: `matches.id` is an autoincrement the
backend owns. So ownership splits:

- Plugin generates and owns the **token**.
- Backend creates the row and owns the **id**.
- Backend rcons the assigned id back to the plugin via one new command, so the
  existing `DUMP match=<id>` grammar is untouched.

### 4. Backend: adopt a self-started match

- `logParse.ts` gains a `MATCH_CREATE` case.
- A new adopt path creates unknown players, writes `matches` and
  `match_players`, marks the match live, and rcons the id back.
- On `MATCH_END`, pull `sm_pug_dump` over rcon and call the existing
  `completeMatch`. That remains the single write path for a finished match.

No schema change for the match flow itself, and no new transport: the UDP
listener and the rcon dump puller both already exist and are tested.

**Security: `MATCH_CREATE` is the first log line that creates database rows.**
UDP is trivially spoofable, so the listener must reject it from any source
address that is not the configured game server. This is in from the start, not
bolted on later.

### 5. Demos

`tv_autorecord 1` currently records the empty server around the clock. On
2026-09-10 that had reached 9.95 GB in six days on a 47 GB disk with 7.9 GB
free, roughly 1.7 GB/day. Every file over 200 MB was `airport01_greenhouse`,
the idle map; the largest was 1.23 GB of nobody playing. 165 files / 7.76 GB
were pruned by hand, taking the disk from 83% to 65%.

Two changes make that permanent:

- **Deliberate recording.** `!load_4v4p` issues an explicit
  `tv_record pug_<token>_<ordinal>_<map>`, re-issued on each map start during a
  match, so a match demo is linked to its match by construction rather than
  guessed at by timestamp.
- **Nightly prune cron** with a retention window for autorecord demos, so the
  hand-prune becomes automatic.

A `match_demos` table (match_id, ordinal, map, filename, size) backs download
links on the match page. Demos are stored gzipped and served with
`Content-Encoding: gzip` so the browser hands the user a normal `.dem` with no
manual decompression, behind the same `requireActive` guard as the rest of the
read API.

**Known risk:** upstream sourcetvsupport issue #49 reports that on L4D1, demos
after the first one per server restart can be corrupt. A campaign match is four
or five maps, so by that bug only the first demo is reliably good. Whether it
reproduces on our fork is unknown and must be tested by recording a multi-map
match and playing back demo #3. If it reproduces, the fallback is one continuous
demo per match instead of one per map, losing per-map seeking but surviving the
bug.

### 6. Deployment

Host: the existing Dallas box, 45.32.199.85, Ubuntu 24.04.4, 2 dedicated vCPUs,
3.9 GB RAM. Chosen over a separate VPS for zero cost and trivial networking:
rcon to `127.0.0.1:27015`, `logaddress` to `127.0.0.1:27500`, no firewall holes
between hosts.

- Node plus a `pug-web` systemd unit running as a dedicated non-root user.
- Caddy terminating TLS for `riversidepug.com` and `www.riversidepug.com`,
  reverse-proxying to the app on localhost. ufw opens 80 and 443.
- `servers` row pointing at `127.0.0.1:27015`.
- `logaddress_add 127.0.0.1:27500` on the game server.
- `ADMIN_STEAMIDS=76561198030413993`.

DNS is at Porkbun (authoritative nameservers, not a Cloudflare proxy, so
nothing interferes with Let's Encrypt HTTP-01). The parking ALIAS and wildcard
CNAME are removed; `A @ -> 45.32.199.85` is live and propagated.

**Tick risk.** srcds shares 2 cores with node. The user cares about frame timing
and already has `l4d_tickstats`, so this is measured rather than assumed: p99
baseline before, same measurement after, and the node process is niced below
srcds.

### 7. Not polluting the leaderboard

Test matches go into a season named "Test". `applyMatchRatings` is already keyed
to the match's own `season_id` rather than the currently open season, so real
ratings are untouched and the season can be deleted afterward. No schema change
and no unrated flag.

## Testing

- Unit tests for the `MATCH_CREATE` grammar in `logParse.ts`, matching the
  existing wire-format test style, including rejection of a spoofed source
  address.
- Unit tests for the adopt path: unknown players created, known players reused,
  match and `match_players` rows correct, idempotent on a duplicate
  `MATCH_CREATE`.
- Live: solo with `sm_pug_min_orient 1` and bots over a short campaign, verify
  the match appears on the site with per-player stats attributed to the right
  team, then a real game with people.
- Demo playback, specifically demo #3 of a multi-map match, against issue #49.

## Order of work

1. Deploy the site: node, Caddy, TLS, Steam login. Safe with players connected.
2. Prune cron, closing the disk problem rather than postponing it.
3. Plugin: `!load_4v4p`, roster snapshot, `MATCH_CREATE`, `tv_record`.
4. Backend: adopt path, demo rows, match page links.
5. Live test.

Steps 3 to 5 change plugin behaviour on a live server and need an empty box and
explicit go-ahead each time, per the standing rule that the Dallas box is never
changed unasked.
