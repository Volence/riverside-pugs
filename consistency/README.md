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
- `configs/l4d_consistency.batch2.cfg` the shipped list plus groups 7 to 15. Generated
  and committed, read by NOTHING until it is promoted (see Batch 2).
- `../src/consistencyGen.ts` the rules, and the checks a generated list has to pass.
- `../scripts/gen-consistency-list.ts` the generator's command line, with `--overlay`
  and `--verify`.
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
      -i /home/volence/l4d/pug/plugin \
      -o /home/volence/l4d/pug/consistency/plugin/l4d_consistency.smx

The second `-i` is for `pug-logauth.inc` and `pug-hmac.inc`, which sign the
SIGNON_DROP line and are shared with the plugins in `pug/plugin`.

The `.smx` is committed, unlike `plugin/pug-match.smx`, so a checkout is
installable without a compiler.

## Building for Windows

    ./build-win.sh

Cross-compiles `build/l4d_consistency.ext.dll` from Linux for a Windows dedicated
server. Needs `clang-cl`, `lld-link` and the LLVM binutils; the MSVC CRT and
Windows SDK headers are fetched once with `xwin` into `sourcetv/deps/winsdk`,
about 800 MB, outside the repo.

**Not MinGW, and this is not a preference.** The extension exists to call one
virtual on an interface Valve compiled with MSVC. On i386 an MSVC member call is
`__thiscall`, with `this` in ECX; GCC passes `this` as the first stack argument.
A MinGW build links and loads perfectly and then corrupts the stack on the first
call. clang-cl implements the Microsoft C++ ABI, so it is the only cross
compiler that produces a correct DLL here.

Two SDK problems the Linux build never hits, both handled in the script:

- `mathlib.h` writes `movzx eax, CtrlwdHolder` inside `__asm`. MSVC infers a word
  operand; clang's MS-asm parser refuses it as ambiguous, and it is right to,
  since `movzx r32, r/m32` does not exist. The script patches a copy and force
  includes it, so the include guard makes the SDK's own copy a no-op. Shadowing
  it with `-I` does NOT work: clang-cl runs in MSVC compatibility mode, where a
  quoted include searches every directory on the include STACK before the `-I`
  list, and `eiface.h` is on that stack.
- `NO_MALLOC_OVERRIDE`, which the Linux build requires, must not be defined here.
  On Windows it leaves `MemAlloc_Free` undeclared, because the fallback inlines
  that define it live in `memalloc.h`'s POSIX branch.

The CRT is linked statically (`/MT`), so the DLL imports only `KERNEL32` and
needs no vcruntime redistributable on the target.

### What the build verifies, and why

There is no Windows machine here, so the build proves statically what it can and
FAILS rather than emitting a DLL that would be wrong in game:

| check | the failure it catches |
|---|---|
| exports `GetSMExtAPI`, `CreateInterface_MMS` | SourceMod rejects the file at load |
| the vtable slot, read from `eiface.h` at build time, appears in the disassembly | an SDK update inserting a virtual above `ForceExactFile` silently shifts the index and calls a different engine function |
| `this` reaches the call in ECX | the MinGW mistake above |

The slot is computed from the header rather than hardcoded, so it stays honest
across SDK updates. As of the L4D1 SDK at the time of writing it is slot 82
(offset `0x148`), which is the same slot the proven Linux build calls.

**The DLL has never been executed on Windows.** Verified by disassembly is not
verified by running, and the binary is committed on that understanding.

## The enforced list

`configs/l4d_consistency.cfg` is one game-relative path per line. `#` starts a
comment, and a `# group N: title` comment opens a group, which is what
`sm_consistency_status` reports per. **No wildcards at runtime**: a glob that
matches nothing is a silent zero, and a generated file is diffable.

    npx tsx scripts/gen-consistency-list.ts                     # groups 1 to 5 (651 paths)
    npx tsx scripts/gen-consistency-list.ts --commons           # also group 6, common infected
    npx tsx scripts/gen-consistency-list.ts --batch2            # also groups 7 to 15 (1531), to l4d_consistency.batch2.cfg
    npx tsx scripts/gen-consistency-list.ts --batch2 --without 15
    npx tsx scripts/gen-consistency-list.ts --groups 1-5,7-16 --out /tmp/probe.cfg
    npx tsx scripts/gen-consistency-list.ts --game /path/to/left4dead
    npx tsx scripts/gen-consistency-list.ts --overlay /path/to/left4dead_dlc4
    npx tsx scripts/gen-consistency-list.ts --verify /path/to/other/left4dead

Run from `pug/`. `--game` is a STOCK install and defaults to the local test server
(`/home/volence/l4d1-ds/server/left4dead`). Models, materials and particles are read
from its `pak01_dir.vpk`; sounds and scripts are loose files on L4D1 and are walked
on disk, resolved through `left4dead_dlc3` first and then `left4dead`, which is the
engine's own search order (several soundscripts exist only in the dlc3 directory).
Groups 7 and up read `left4dead_dlc3/pak01_dir.vpk` as well, in the same order; groups
1 to 6 are pinned to the base pak so that the live list cannot drift.

`--batch2` writes to `l4d_consistency.batch2.cfg` unless `--out` says otherwise, so the
shipped file is never replaced by accident. `--groups` names the groups outright (group
16 is reachable no other way) and refuses to run without `--out`. `--without` drops
groups from whatever else was selected. Every run prints, per group, the path count and
the bytes a client re-checksums on each map load, the downloadables table estimate, and
a `note:` line for every exclusion and waiver, so nothing is left out silently.

Beyond never-force and `--overlay`, three checks fail generation:

- a listed path the stock install does not have (the engine will not force it);
- a listed path that `left4dead` and `left4dead_dlc3` hold with DIFFERENT content, unless
  it is waived with a reason (`DUAL_COPY_WAIVED`) or excluded from its rule (`except`);
- a forced `.vmt` that names a stock texture, under any key, or `include`s a material
  that nothing forces, unless it is waived with a reason (`REF_WAIVED`). A forced
  material is only as forced as the textures it names.

`--overlay` names a search-path directory that some legitimate clients mount ahead
of `left4dead` and others do not, such as `left4dead_dlc4` (the L4D2 maps pack). A
listed path that an overlay also ships, loose or in its `pak01_dir.vpk`, resolves
to different files for the two populations and disconnects one of them, so
generation FAILS naming the path. It defaults to `<game>/../left4dead_dlc4` when
that exists and may be given more than once. This is why
`scripts/game_sounds_manifest.txt` is deliberately not on the list: the dlc4 pack
ships its own.

`--verify` checksums the content of every file on the list, loose or inside an
archive, on both installs, compares both `pak01_dir.vpk` files as well, and names
anything that differs or is missing. **Run it
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
   already ships. `--list <cfg>` checks a list that is not live yet.
4. Copy the cfg to every game server (see Installing). The web reads its own copy
   from the repo checkout, which `deploy-web.sh` ships.

## Batch 2

Groups 7 to 15, 880 paths on top of the shipped 651: the Sacrifice tank, the textures
forced materials borrow, SI and foliage mesh companions, the commons parent material,
the rest of the particle definitions and particle materials, SI footsteps, detail
sprites, the flashlight textures and the tank rock. The spec has the table, what was
excluded and why, the budget (about 1,551 of 8,192 table entries, 161 MB re-checksummed
per map load against 93 MB today). It passed the owner's client gate on 2026-09-23: a
stock client and a client with dlc4, a custom HUD and campaign VPKs both connected and
survived map changes, and each new group rejected a modified file. The gate's procedure
and full results are kept privately, not in this repository.

Until it is promoted nothing reads `l4d_consistency.batch2.cfg`. Promoting it is moving the
group numbers from `BATCH2` to `SHIPPED` in `src/consistencyGen.ts` and regenerating.

## Installing

    cp build/l4d_consistency.ext.so    <game>/left4dead/addons/sourcemod/extensions/
    # windows server: cp build/l4d_consistency.ext.dll instead
    cp plugin/l4d_consistency.smx      <game>/left4dead/addons/sourcemod/plugins/
    cp configs/l4d_consistency.cfg     <game>/left4dead/addons/sourcemod/configs/

The drop line reaches the web over the same `logaddress_add` feed `pug-match.smx`
uses, so it needs `log on` and nothing new in the server cfg.

## Older SourceMod versions

Verified 2026-09-20 against SourceMod 1.9, for a server locked to 1.9 by another
plugin. The split is that the **extension is fine as shipped and the plugin is
not**, and the fix is a recompile of the plugin with no source changes.

**The extension binary loads on 1.9 unchanged.** It is built against the 1.12
SDK, but an extension reaches SourceMod only through vtables (`nm -D` shows no
undefined SourceMod or Metamod symbols, and the only `NEEDED` entries are
`libstdc++` and `libc`), so what matters is whether those vtables match:

- `SMINTERFACE_EXTENSIONAPI_VERSION` is `8` on every branch from 1.9 to 1.12,
  and core rejects an extension only when its version is *greater* than core's.
- `IExtensionInterface` and `IShareSys`, the two this extension implements and
  calls, have byte-identical virtual lists in 1.9 and 1.12.
- `IPluginContext` in 1.9 is a strict prefix of 1.12's: the first 56 slots are
  identical and 1.12 only appends. `LocalToString` and `ThrowNativeError`, the
  only two this extension calls, sit at the same slots in both.
- `ISmmAPI` slots 1 (`GetEngineFactory`) and 19 (`VInterfaceMatch`), the only
  two `GET_V_IFACE_CURRENT` touches, are identical from Metamod 1.10 up. The one
  1.10-vs-1.12 difference is `FormatIface`'s parameter type at slot 14, same
  width on i386 and never called here.
- Highest versioned symbol required is `GLIBC_2.4`, so an old distro is fine too.

**The shipped `.smx` does not load on 1.9, and this is not negotiable.** It is
compiled by spcomp 1.12 and carries code version 13 with the `DirectArrays`,
`HeapScopes` and `NullFunctions` feature flags. SourcePawn in 1.9 accepts code
versions 9 and 10 only (`CODE_VERSION_SP1_MAX`), and refuses anything higher
with `code version is too new, not supported`.

Recompiling `plugin/l4d_consistency.sp` with the 1.9 spcomp is the whole fix:

    <sm1.9>/addons/sourcemod/scripting/spcomp \
      -i<sm1.9>/addons/sourcemod/scripting/include \
      -iplugin \
      plugin/l4d_consistency.sp -ol4d_consistency.smx

It compiles clean, no errors and no warnings, and emits code version 10. The
plugin only uses natives that have been in SourceMod since 1.7 (`ConVar` and
`File` methodmaps, `FindStringTable`, `BuildPath`, `RegAdminCmd`, `HookEvent`),
so there is nothing to port. `plugin/l4d_consistency.inc` has to be on the
include path, which is what the second `-i` above is for.

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
- Batch 2 (2026-09-21): rules, checks and `l4d_consistency.batch2.cfg` built, verified
  against the owner's real client install (1,531 files, 0 differ, 0 missing), 0
  overlay collisions. Client gate PASSED 2026-09-23; about 0.7 s more per map load
  than the shipped list on the owner's machine. NOT live until promoted.
- Groups 1 to 5 have been live on all four servers since 2026-09-20.
