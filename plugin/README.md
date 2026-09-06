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

## RCON commands

| Command | Arg grammar | Notes |
|---|---|---|
| `sm_pug_match` | `<matchid> <token> <campaign>` | Starts match intake. Resets all match state, arms the roster. |
| `sm_pug_roster` | `<steamid64>:<a\|b>` | Call once per player (×8). Team letters are lowercase `a`/`b`; convention: team `a` starts as survivors on map 1. |
| `sm_pug_dump` | `<token>` | Authoritative match record over the RCON response body. Idempotent, so it is safe to call more than once. |
| `sm_pug_abort` | `<token>` | Clears match state. Roster enforcement stops immediately. |
| `sm_pug_status` | none | Full current plugin state over the RCON response body. Takes no token deliberately, since the moment you most want it is when setup went wrong and you do not trust your own idea of the token. Read-only, safe at any time. |

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

Debug output goes to the SourceMod log, not the `logaddress` stream, because the
UDP grammar is parsed by `src/logParse.ts` and free-text lines there would be
noise at best and mis-parses at worst. Read it with:

    tail -f addons/sourcemod/logs/L<date>.log

## Testing this alone

Roughly eight of the eleven checklist items below need only you. Roster yourself
plus placeholder SteamID64s that never connect; the roster does not have to be
full for the plugin to arm.

**Solo, unmodified:** items 1, 2, 3, 4, 5, 9, 10, 11. That is the whole RCON
contract, the kick path, the UDP line format, the dump grammar and its
idempotency, abort, and heartbeats. `sm_pug_status` after each step tells you
what the plugin thinks happened.

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

### Authoritative: RCON `sm_pug_dump` response body (`src/dumpParse.ts`)

```
DUMP match=<id>
MAP map=<m> a=<n> b=<n>              (one per completed map, in order)
STAT steamid=<id64> team=a|b sidmg=<n> sikill=<n> ck=<n> ff=<n> rev=<n>   (x8)
END winner=a|b|draw a=<total> b=<total>
```

Both grammars are emitted from single central helpers in `pug-match.sp`
(`EmitPug` for the live view, `DumpLine` for the dump) so the wire format
lives in one place. Any change here must be mirrored in `src/logParse.ts` /
`src/dumpParse.ts` and vice versa.

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
`MS_None`, including the kick path in `OnClientPostAdminCheck`, so it is safe to
leave installed on the casual server between test sessions. The only things
running are two timers that return immediately.

Step-by-step runbook with copy-pasteable RCON: `plugin/TESTING.md`.

## Manual staging checklist

For the joint session, once the server is free. Run `sm_pug_status` between
steps and turn on `sm_pug_debug 1` for the whole session: together they turn "it
didn't work" into a specific line.

1. Compile on server, install to `plugins/`, `sm plugins list` shows
   `pug-match`.
2. RCON `sm_pug_match 999 testtoken no_mercy` + 8 `sm_pug_roster` lines (use
   real friends' steamid64s) → `PUGOK` responses.
3. Non-rostered player joins → kicked with roster message.
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
    enforcement stops and rejoining players are no longer kicked.
11. Heartbeats arrive every 30s throughout.
