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

`sm_pug_dump` and `sm_pug_abort` both check `<token>` against the token set by
the most recent `sm_pug_match` and reply `PUGERR bad token` if it doesn't
match.

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

## Manual staging checklist

For the joint session, once the server is free:

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
