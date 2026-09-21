# pug-match: SourcePawn plugin

Server-side counterpart of the `pug-web` orchestrator (`src/orchestrator.ts`).
It runs on the L4D1 server, layered on Rotoblin-AZMod, and handles match
intake over RCON, roster enforcement, per-map score + per-player stat
capture, live-view `LogToGame` lines, and the authoritative `sm_pug_dump`
response. All state is keyed by SteamID64 (reconnect-safe) and survives map
transitions. A match spans a campaign minus its finale.

Two reporting channels, per the sub-project 2 design spec:

- **Live view (lossy):** UDP `logaddress` lines via `LogToGame`, parsed by
  `src/logParse.ts`.
- **Authoritative (reliable):** RCON response body via `PrintToServer` inside
  `RegServerCmd` handlers, parsed by `src/dumpParse.ts`.

## Starting a match from in-game: `!load_4v4p`

The normal flow is backend-driven: the website allocates a match and pushes it
to the server over rcon. `!load_4v4p` is the reverse, for when everyone is
already in the server and nobody wants to go queue on a website.

    !load_4v4p          (in chat, needs ADMFLAG_CHANGEMAP)

It snapshots everyone currently on a team (survivors become pug team `a`,
infected become `b`), captures their in-game names, invents a token, announces
the roster over the `logaddress` feed, starts a match-named demo, and execs the
ranked config. The backend materialises the match and hands back the id it
allocated via `sm_pug_setid`.

Difference from a backend-driven match, deliberate:

- **The match id is 0 until the backend assigns one.** The plugin cannot invent
  it, because `matches.id` is an autoincrement the backend owns.

No match, self-started or not, kicks a non-rostered player. `Timer_TeamLock`
places the rostered eight on their correct sides; anyone else stays,
unscored, and may spectate.

Refuses cleanly when a match is already configured, when nobody is on a team,
or when more than `MAX_ROSTER` (8) players are on teams.

## RCON commands

| Command | Arg grammar | Notes |
|---|---|---|
| `sm_pug_match` | `<matchid> <token> <campaign>` | Starts match intake. Resets all match state, arms the roster. |
| `sm_pug_roster` | `<steamid64>:<a\|b>` | Call once per player (×8). Team letters are lowercase `a`/`b`; convention: team `a` starts as survivors on map 1. |
| `sm_pug_dump` | `<token> [nonce]` | Authoritative match record over the RCON response body. Idempotent, so it is safe to call more than once. `nonce` (1 to 32 hex digits, 0.3.3 and later) is echoed on the DUMP and END lines. |
| `sm_pug_abort` | `<token> [teardown [<map>]]` | End the match. Plain form: reset plugin state, nothing else (the routine post-report call). With `teardown`: announce in chat, ask Rotoblin for an unpause and wait up to 10 s for it, kick every human (bots and SourceTV stay), then `ForceChangeLevel(<map>)` once the kicks have landed. Logs `PUG <token> PROBLEM code=unpause_timeout` if the game never unpaused. The backend sends the teardown form from the release path for abandon, no-show and admin abort; never for a clean finish. |
| `sm_pug_status` | none | Full current plugin state over the RCON response body. Takes no token deliberately, since the moment you most want it is when setup went wrong and you do not trust your own idea of the token. Read-only, safe at any time. |
| `sm_pug_setid` | `<token> <matchid>` | Backend assigns the match id for a **self-started** match. Keyed by token, because the id is exactly what the plugin does not know and so cannot be asked for. |

`sm_pug_dump` and `sm_pug_abort` both check `<token>` against the token set by
the most recent `sm_pug_match` and reply `PUGERR bad token` if it doesn't
match.

## Cvars

Both default to production behaviour. They exist so the plugin can be exercised
without eight people in the server.

| Cvar | Default | Notes |
|---|---|---|
| `sm_pug_min_orient` | `3` | Rostered players that must agree before the pug-team/side mapping moves. Set to `1` on a test instance to drive a match solo. |
| `sm_pug_debug` | `0` | `1` logs orientation flips, team-lock moves, score reads and attribution to the SourceMod log. |
| `sm_pug_config` | `pug_match.cfg` | Config `!load_4v4p` execs. `pug_match.cfg` execs the pinned ruleset (`rotoblin_pug_4v4.cfg`, a clone of hardcore 4v4), loads `skill_detect` as a data source, and restores `sm_pug_min_orient 3`. Changing this changes the rules under every rating earned from here on. |
| `sm_pug_record_demos` | `1` | `1` stops `tv_autorecord`'s file and records `pug_<token>_<ordinal>_<map>.dem` for each map of a match, so the demo is linked to the match by name rather than guessed at by timestamp. |

Debug output goes to the SourceMod log, not the `logaddress` stream, because the
UDP grammar is parsed by `src/logParse.ts` and free-text lines there would be
noise at best and mis-parses at worst. Read it with:

    tail -f addons/sourcemod/logs/L<date>.log

## Testing this alone

Roughly eight of the eleven checklist items below need only you. Roster yourself
plus placeholder SteamID64s that never connect; the roster does not have to be
full for the plugin to arm.

**Solo, unmodified:** items 1, 2, 3, 4, 5, 9, 10, 11. That is the whole RCON
contract, non-rostered clients staying unscored, the UDP line format, the dump
grammar and its idempotency, abort, and heartbeats. `sm_pug_status` after each
step tells you what the plugin thinks happened.

**Needs `sm_pug_min_orient 1`:** items 6 and 8, the score attribution and the
cross-map relabeling case. The orientation vote at `Timer_TeamLock` normally
needs three rostered players agreeing, and bots cannot help because the vote only
counts clients matched to a roster slot by SteamID64. With the threshold at 1 you
can drive a full versus round with bots and verify that scores land on the right
pug team across a map change, which is the riskiest logic in the plugin.

**Genuinely needs people:** item 7 (team lock fighting a real mid-round swap) and
a true 4v4 run of items 6 and 8. Solo testing proves the mechanism; it does not
prove the vote itself, since you are the only voter.

Set the threshold back to 3 before any real match.

## Wire grammars

### Live view: UDP `logaddress` lines (`src/logParse.ts`)

```
PUG <token> MATCH_START map=<map>
PUG <token> MAP_RESULT map=<map> a=<n> b=<n>
PUG <token> HEARTBEAT
PUG <token> PLAYER steamid=<id64> event=connect|disconnect
PUG <token> MATCH_END a=<n> b=<n> winner=a|b|draw
```

Self-started matches (`!load_4v4p`) emit one more burst, once, up front:

```
PUG <token> MATCH_CREATE map=<map> players=<n>
PUG <token> MATCH_ROSTER steamid=<id64> team=a|b name=<rest of line>
PUG <token> MATCH_CREATE_END players=<n>
```

Two constraints that are easy to break and silent when broken:

- **`name=` must stay LAST on its line.** In-game names contain spaces and can
  contain `=`, so the backend takes the entire remainder of the line as the
  name rather than splitting on whitespace.
- **The token must be exactly 32 lowercase hex characters.** `src/logParse.ts`
  pins `/^[0-9a-f]{32}$/`, so a shorter token makes every line unparseable with
  no error anywhere.

These three are the only lines the backend will accept for a token it has never
seen, and only from the game server's own source address: they are the ones
that cause database writes, so `src/logListener.ts` pins the source. Everything
else stays gated on a registered token, so a spoofed `MATCH_END` cannot invent
a score.

### Authoritative: RCON `sm_pug_dump` response body (`src/dumpParse.ts`)

```
DUMP match=<id> skilldetect=0|1 [nonce=<hex>] state=pending|live|ended
MAP map=<m> a=<n> b=<n>              (one per completed map, in order)
STAT steamid=<id64> team=a|b joined_map=<n> sidmg=<n> sikill=<n> ck=<n> ff=<n> rev=<n>   (one per roster slot)
SKILL steamid=<id64> <key>=<n> ...   (one per roster slot)
END winner=a|b|draw a=<total> b=<total> [nonce=<hex>] state=pending|live|ended
```

`nonce=` and `state=` are 0.3.3 and later. The backend sends a fresh nonce with
every pull and, when the answer echoes it, reads the LAST block that carries it
(an rcon response also holds whatever else reached the console) and completes
the match only on `state=ended`: the dump answers in any state, and the
`MATCH_END` line that triggers the pull is UDP. An answer with no nonce is an
older plugin and is read as it always was, first DUMP to first END.

Both grammars are emitted from single central helpers in `pug-match.sp`
(`EmitPug` for the live view, `DumpLine` for the dump) so the wire format
lives in one place. Any change here must be mirrored in `src/logParse.ts` /
`src/dumpParse.ts` and vice versa.

### Signed log lines (`pug-logauth.inc`, `src/logAuth.ts`)

Every line above is a UDP datagram, and the backend admits the token-less kinds
(`L4DC`, `L4DL`, `L4DM`, `PUGNET`) on the sender's address alone, which is the
thing a spoofer forges. The token on a `PUG` line is little better: it crosses
the same cleartext stream. This engine has no `sv_logsecret`. So a server that
has been given a secret signs every line it logs:

```
<the line as before> lseq=<boot>.<n> mac=<8 hex>
```

- `mac` is the first four bytes of HMAC-SHA1(secret, everything before ` mac=`).
  The key is the secret's own characters. `pug-hmac.inc` is that in plain
  SourcePawn; `tests/logauth_vectors.sp` holds it and `node:crypto` to one table
  of vectors (`./test-logauth.sh`, `tests/logAuthVectors.test.ts`).
- `n` counts signed lines for the whole server, across all four plugins; `boot`
  is when this srcds process first loaded one of them. A line from an earlier
  boot, or a counter already seen, is a replay. Both live in ConVars
  (`sm_pug_log_boot`, `sm_pug_log_seq`) because those outlive a plugin reload
  and die with the process, which is the lifetime wanted. `boot` rides on every
  line so that a lost datagram cannot leave a restarted server refused.
- `lseq`, not `seq`: EVENT and CHAT already carry a per-match `seq=`.
- The secret arrives as `sm_pug_log_secret <hex>` over rcon (FCVAR_PROTECTED),
  pushed by the backend at every match set-up, with `sm_pug_setid`, and from the
  admin server panel. The backend turns `sv_rcon_log` off around that one
  command, because srcds logs rcon commands onto this same stream. The plugins
  keep it in `data/pug_logauth_<hostport>.txt`, so a restarted server signs from
  its first line. With no secret, lines go out exactly as they always did.
- The engine's own `entered the game` line cannot be signed. It is honoured
  from the pinned source address only, and all it can do is clear a signon drop.

The backend strips the trailer before the grammar sees the line, and decides
per server (`servers.log_auth`): `off` believes everything as before, `log`
counts failures and believes them anyway, `enforce` drops them. A valid
signature also says which server a line came from, which address and port
cannot always (two srcds on one machine).

Roll-out, one server at a time, web first:

1. Deploy the web app. Nothing changes: every server is `off` with no secret.
2. Admin, Matches, Servers, "Log signing": **Set up**. A secret is generated
   and pushed. Old plugins answer "Unknown command" and carry on unsigned.
3. Stage the four new plugins on that server while it is empty, then **Push
   again** (the cvar exists only once one of them has loaded).
4. Set the mode to **log** and play a match. `unsigned` should stop climbing
   and `bad` and `replayed` should stay at zero.
5. Set the mode to **enforce**.

Back out: set the mode to `off`. To stop a server signing altogether, run
`sm_pug_log_secret ""` on it, which also removes the file.

## Build

### Locally, via wine

```
./build.sh
```

Copies `pug-match.sp` into the Rotoblin-AZMod scripting tree (spcomp under
wine breaks on absolute Unix paths, so it must compile with relative paths from
inside that directory), compiles with that tree's `spcomp.exe` and its
`include/`, copies `pug-match.smx` back into `plugin/`, and cleans up the
tree via a `trap` on exit. Must end with `Code size: ...` and 0 errors.

### On the server

Same idea as the `l4d_clipvis` workflow (see
`/home/volence/l4d/l4d_clipvis/NEXT.md`'s "Build loop" section): copy the
`.sp` up, compile in place with the server's own `spcomp`, then install the
resulting `.smx`. Gate the install on the compile actually succeeding so a
failed build doesn't silently leave the previous binary running:

```
scp plugin/pug-match.sp root@45.32.199.85:/tmp/
ssh root@45.32.199.85 'cd /path/to/scripting \
  && cp /tmp/pug-match.sp . && rm -f /tmp/pug-match.smx \
  && ./spcomp pug-match.sp -o/tmp/pug-match.smx \
  && install -o l4d -g l4d -m 644 /tmp/pug-match.smx ../plugins/pug-match.smx'
```

Then sync the built `.smx` back into `deploy/overrides/.../plugins/` (see
Install below) or a later redeploy will overwrite the server copy with an
older build.

## Install

The compiled `pug-match.smx` (never the `.sp`) belongs at:

```
deploy/overrides/left4dead/addons/sourcemod/plugins/pug-match.smx
```

`deploy.sh` (in `/home/volence/l4d/deploy/`) rsyncs `overrides/` onto the live
box.

**Do not run `deploy.sh`, or otherwise push this plugin to the server, while
the server is in use.** Staging this plugin means new RCON commands,
event hooks, and a repeating team-lock timer running live; treat it as a
maintenance-window change, not a hot deploy.

## Staging and testing

    ./build.sh            # compile (wine + the Rotoblin tree's spcomp)
    ./stage.sh --solo     # install/reload on the box, set solo-test cvars

`stage.sh` deliberately does not use `deploy/deploy.sh`, which rsyncs every
override and restarts the service. SourceMod loads a plugin on a running server,
so staging copies one file and calls `sm plugins load`: no restart, no map
change, nobody kicked. It refuses to run while players are connected unless you
pass `--force`.

**The plugin is inert until a match is configured.** Every hook early-returns at
`MS_None`, including `OnClientPostAdminCheck`, so it is safe to leave installed
on the casual server between test sessions. The only things running are two
timers that return immediately.

Step-by-step runbook with copy-pasteable RCON: `plugin/TESTING.md`.

## Manual staging checklist

For the joint session, once the server is free. Run `sm_pug_status` between
steps and turn on `sm_pug_debug 1` for the whole session: together they turn "it
didn't work" into a specific line.

1. Compile on server, install to `plugins/`, `sm plugins list` shows
   `pug-match`.
2. RCON `sm_pug_match 999 testtoken no_mercy` + 8 `sm_pug_roster` lines (use
   real friends' steamid64s) → `PUGOK` responses.
3. Non-rostered player joins → not kicked, stays a spectator.
4. Rostered players join → placed on their teams; `PLAYER ... event=connect`
   lines reach the backend UDP listener (capture the real line format, research
   item #1, and pin `logParse.ts` tests with it).
5. Ready-up → live → `MATCH_START` line.
6. Play a map both halves → `MAP_RESULT` with plausible a/b scores; verify
   against scoreboard.
7. Deliberately swap a player mid-round → lock timer moves them back within
   ~4s.
8. Second map: verify scores still attribute to the right pug teams (the
   cross-map relabeling case, the plan's biggest risk).
9. On finale load → `MATCH_END`; `sm_pug_dump testtoken` over RCON returns
   full DUMP/MAP/STAT/END; run it twice (idempotent).
10. `sm_pug_abort testtoken` → `PUGOK aborted`; after the abort, roster
    enforcement stops and rejoining players are no longer placed on teams.
11. Heartbeats arrive every 30s throughout.
