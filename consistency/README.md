# L4D1 file consistency

Server-side enforcement of file consistency, to kill the content-swap class of
cheating: no-trees addons, brightened SI skins, silenced weapons.

Specs: `docs/superpowers/specs/2026-09-18-file-consistency-design.md` (Phase 1, the
mechanism) and `docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md`
(Phase 2, the enforced list and marking who was rejected).

## Why this exists

L4D1's engine has the whole mechanism already. `sv_consistency` is a real cvar
with a real help string, `CDownloadListGenerator::ForceExactFile` is in
`bin/engine.so`, and the client half is `CClientState::ConsistencyCheck`.

What it does not have is anything that turns it on. `bin/server.so` contains no
reference to `ForceExactFile`, so the game DLL asks for zero files to be checked,
the enforced list is empty, and `sv_consistency 1` appears to do nothing. That is
why the received wisdom is that this is broken on L4D1. It is not broken; nothing
populates the list.

## How it is reached

`ForceExactFile` is a **public virtual on `IVEngineServer`**
(`hl2sdk-l4d/public/eiface.h:306`), so an extension that already holds `engine`
just calls it. No signature scan, no gamedata, no `dlsym`.

The SDK's `INTERFACEVERSION_VENGINESERVER` is `"VEngineServer022"`, and
`strings bin/engine.so` yields exactly and only `VEngineServer022`, so the vtable
the SDK header describes is the one this engine has. The extension either binds
that interface or fails loudly at load; there is no path where it binds a
different layout and calls the wrong virtual.

(An earlier probe concluded this needed binding the mangled symbol
`_ZN22CDownloadListGenerator14ForceExactFileEPKc15ConsistencyType`. That symbol
appears in `strings` but not in `nm -D`, so it is not dynamically linkable. It is
also not needed.)

## Layout

- `extension/` the SourceMod extension. One native, no state, no hooks.
- `plugin/` `l4d_consistency.sp`: reads the list, forces it on every map start,
  and emits the `L4DC SIGNON_DROP` line.
- `configs/l4d_consistency.cfg` the enforced list. GENERATED and committed; never
  edited by hand.
- `../scripts/gen-consistency-list.ts` the generator, with its `--overlay` check and
  its `--verify`.
- `../scripts/check-campaign-collisions.ts` checks the VPKs already on a server
  against the list.
- `Makefile`, `Dockerfile.build`, `build.sh` the extension build.

The web half lives in the app: `src/logParse.ts` and `src/logListener.ts` (the
drop line), `src/signonDrops.ts` and `src/signonDropNotify.ts` (storage, the admin
feed, the player DM), `src/consistencyList.ts` and `src/campaignCollisions.ts` (the
campaign uploader's refusal), and `web/src/routes/HelpConsistency.tsx` (the page a
dropped player is sent to).

## Building

    ./build.sh

Builds inside Ubuntu 22.04 and prints the highest GLIBC symbol required. **Never
build on the host**: Arch links GLIBC 2.4x and the Dallas box is 2.39.
`sourcetv/README.md` records that mistake being made once already. A correct
build reports `GLIBC_2.4`.

Output: `build/l4d_consistency.ext.so` (ELF 32-bit i386, matching the server).

The plugin compiles with the local test server's native spcomp:

    cd /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/scripting
    ./spcomp /home/volence/l4d/pug/consistency/plugin/l4d_consistency.sp \
      -i /home/volence/l4d/pug/consistency/plugin \
      -o /home/volence/l4d/pug/consistency/plugin/l4d_consistency.smx

The `.smx` is committed, unlike `plugin/pug-match.smx`, so a checkout is
installable without a compiler.

## The enforced list

`configs/l4d_consistency.cfg` is one game-relative path per line. `#` starts a
comment, and a `# group N: title` comment opens a group, which is what
`sm_consistency_status` reports per. **No wildcards at runtime**: a glob that
matches nothing is a silent zero, and a generated file is diffable.

    npx tsx scripts/gen-consistency-list.ts                     # groups 1 to 5 (651 paths)
    npx tsx scripts/gen-consistency-list.ts --commons           # also group 6, common infected
    npx tsx scripts/gen-consistency-list.ts --game /path/to/left4dead
    npx tsx scripts/gen-consistency-list.ts --overlay /path/to/left4dead_dlc4
    npx tsx scripts/gen-consistency-list.ts --verify /path/to/other/left4dead

Run from `pug/`. `--game` is a STOCK install and defaults to the local test server
(`/home/volence/l4d1-ds/server/left4dead`). Models, materials and particles are read
from its `pak01_dir.vpk`; sounds and scripts are loose files on L4D1 and are walked
on disk, resolved through `left4dead_dlc3` first and then `left4dead`, which is the
engine's own search order (several soundscripts exist only in the dlc3 directory).

`--overlay` names a search-path directory that some legitimate clients mount ahead
of `left4dead` and others do not, such as `left4dead_dlc4` (the L4D2 maps pack). A
listed path that an overlay also ships, loose or in its `pak01_dir.vpk`, resolves
to different files for the two populations and disconnects one of them, so
generation FAILS naming the path. It defaults to `<game>/../left4dead_dlc4` when
that exists and may be given more than once. This is why
`scripts/game_sounds_manifest.txt` is deliberately not on the list: the dlc4 pack
ships its own.

`--verify` compares every loose file on the list, and `pak01_dir.vpk` itself,
against a second install and names anything that differs or is missing. **Run it
against a real client before trusting a server.** The engine checksums the
SERVER's copy, so one customised sound on the server would disconnect every stock
client, and that failure looks identical to everyone cheating at once.

After regenerating, in this order:

1. Read the diff. A rule that suddenly matches nothing shows up as deleted lines.
2. `npm test`. `tests/consistencyList.test.ts` pins the path count (651 for groups
   1 to 5) so that a changed list is always a deliberate commit; update the number
   in the same commit.
3. `npx tsx scripts/check-campaign-collisions.ts` against every server's addons
   directory, because a path that is newly forced may be one a published campaign
   already ships.
4. Copy the cfg to every game server (see Installing). The web reads its own copy
   from the repo checkout, which `deploy-web.sh` ships.

## Installing

    cp build/l4d_consistency.ext.so    <game>/left4dead/addons/sourcemod/extensions/
    cp plugin/l4d_consistency.smx      <game>/left4dead/addons/sourcemod/plugins/
    cp configs/l4d_consistency.cfg     <game>/left4dead/addons/sourcemod/configs/

The drop line reaches the web over the same `logaddress_add` feed `pug-match.smx`
uses, so it needs `log on` and nothing new in the server cfg.

## Cvars

| cvar | default | meaning |
|---|---|---|
| `l4d_consistency_enabled` | `1` | force the list on map start. Read at the NEXT map start |
| `sv_consistency` | `1` | the engine's own switch. Instant |

Two independent off switches on purpose. The failure mode of this feature is
disconnecting legitimate players, and recovery must not need a rebuild.

## Commands

- `sm_consistency_status` per group, forced N of M on this map, plus unresolved
  paths and the downloadables table's fill
- `sm_consistency_reload` re-read the cfg and force it now, for tuning on the test
  server. A path forced earlier this map stays forced until the next map
- `sm_consistency_force <path>` force one path now, for probing a single file

## The drop line

The client does the check and drops itself; the reason the server sees is the plain
"Disconnect by user." and the file name never reaches the server. What the plugin
can see is the signature: a human who left by their own hand, without ever being in
game, on a map that forced at least one file. It emits, over `LogToGame`:

    L4DC SIGNON_DROP steamid=<id> secs=<int, -1 if unknown> forced=<int> name=<rest of line>

`<id>` is a SteamID64 when the client slot is still valid and the event's
`STEAM_1:Y:Z` networkid otherwise; the web accepts both. The name is last and takes
the rest of the line, so it cannot forge an earlier field. **A cancelled loading
screen produces the same line.** Everything downstream treats it as a hint.

The line has no match token (most drops happen while people are still joining,
before any match exists), so the web admits it only from a game server's address,
the same address-pinned path the `!load_4v4p` match-create burst uses, and only
when `L4DC ` is the first thing after the engine's timestamp. That second rule is
what stops a player forging a drop for someone else by typing the line into chat:
the game server's address also sends every `say` line.

What the web does with it:

- stores it in `signon_drops`, and stamps `entered_after_at` when the same SteamID
  is next seen in game (the engine's "entered the game" line, or `PLAYER
  event=connect` during a match)
- DMs a player with a linked Discord account at once, with a link to
  `/help/consistency`: at most one DM per SteamID per hour, and a DM that fails is
  logged and never retried
- posts to the Discord admin feed on the SECOND drop inside ten minutes with no
  entry between, under the Problems toggle; one cancelled load posts nothing
- shows a "Connect drops" line, with the rows behind it, on the admin player page

## Custom campaigns

A forced path that a campaign VPK overrides would disconnect every player on that
campaign's maps, stock client or not, because the server checksums ITS copy and the
server has the campaign mounted. So the uploader refuses any VPK that ships a path
on the list, naming the paths (compared case-insensitively). If the list cannot be
read the uploader refuses everything rather than checking nothing.

What was installed before that check existed is covered by

    npx tsx scripts/check-campaign-collisions.ts

which checks every `.vpk` in `ADDONS_DIR`, site campaign or hand-copied, and exits
non-zero if anything collides. Fix or remove a colliding VPK before the list goes
live.

## Rollout

Local test server first, never Dallas, in this order. Nothing ships without step 1.

1. **The stock gate.** Full list applied, a stock client joins and plays a full
   map. Zero disconnects.
2. One modified file per group; expect the rejection naming it.
3. Loading time with the list on and off, same map, three runs each. Record the
   numbers under Status: they are what the group 6 decision is made on.
4. The drop line: a rejected client produces exactly one `SIGNON_DROP`, a loading
   cancel produces one too, a timeout and a kick produce none.
5. `npx tsx scripts/gen-consistency-list.ts --verify <a real client's left4dead>`.
6. `npx tsx scripts/check-campaign-collisions.ts` with `ADDONS_DIR` pointed at the
   Dallas addons directory. Anything that collides is fixed first.

Dallas, with the owner's go-ahead, on an EMPTY server:

1. Deploy the web first (`deploy-web.sh`), so the drop line has somewhere to land.
2. Stage the extension, the plugin and the cfg with `l4d_consistency_enabled 0`.
3. Flip it on over rcon: `l4d_consistency_enabled 1`. The client re-runs the check
   at every level change, so the flip never touches the map in progress; it takes
   effect for everyone, already connected or not, at the next map load.
4. Watch `sm_consistency_status` after that map load: forced 651, unresolved 0.

**Rollback is `sv_consistency 0` over rcon.** Instant, no restart, no map change.

Two traps in step 2, both from the cvar having no cfg of its own:

- The plugin creates `l4d_consistency_enabled` with a default of `1`, so a server
  restart during the staging window reloads it ENABLED. Keep the window short, or
  hold `sv_consistency 0` as well until the flip.
- Do not put `l4d_consistency_enabled 0` in a cfg that is exec'd on every map. The
  plugin reads the cvar once per map, in `OnMapStart`, and a cfg that re-asserts 0
  around every map start fights the flip: depending on which runs first, the flip
  either never takes effect or lasts exactly one map.

Group 6 (common infected) repeats local steps 1 to 3 and the Dallas staging as its
own rollout, after groups 1 to 5 have survived real matches.

## Status

- Phase 1 (the mechanism): done. All six file types the list uses (`.vmt .vtf .mdl
  .pcf .wav .txt`) produced a rejection naming the file on the local server with a
  real client, 2026-09-19.
- Phase 2 plugin and list: built, 651 paths in groups 1 to 5.
- Phase 2 web: parser, admission, storage, admin feed, DM, admin page, help page,
  uploader refusal and the collision script are built and tested.
- Not yet done: the local stock gate, the loading-time measurement, and everything
  under Dallas above.
