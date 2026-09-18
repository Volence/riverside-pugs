# L4D1 file consistency

Server-side enforcement of file consistency, to kill the content-swap class of
cheating: no-trees addons, brightened SI skins, silenced weapons.

Spec: `docs/superpowers/specs/2026-09-18-file-consistency-design.md`.

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
- `plugin/` the Phase 1 probe plugin: forces ONE file, chosen by cvar.
- `Makefile`, `Dockerfile.build`, `build.sh` the build.

## Building

    ./build.sh

Builds inside Ubuntu 22.04 and prints the highest GLIBC symbol required. **Never
build on the host**: Arch links GLIBC 2.4x and the Dallas box is 2.39.
`sourcetv/README.md` records that mistake being made once already. A correct
build reports `GLIBC_2.4`.

Output: `build/l4d_consistency.ext.so` (ELF 32-bit i386, matching the server).

The plugin compiles with the same wine + spcomp route as `pug/plugin/build.sh`.

## Installing

    cp build/l4d_consistency.ext.so   <game>/left4dead/addons/sourcemod/extensions/
    cp plugin/l4d_consistency.smx     <game>/left4dead/addons/sourcemod/plugins/

## Cvars

| cvar | default | meaning |
|---|---|---|
| `l4d_consistency_enabled` | `1` | force the file on map start |
| `l4d_consistency_file` | `models/infected/hunter.mdl` | the single file Phase 1 forces |
| `sv_consistency` | `1` | the engine's own switch |

Two independent off switches on purpose. The failure mode of this feature is
disconnecting legitimate players, and recovery must not need a rebuild.

## Commands

- `sm_consistency_status` what was forced on this map
- `sm_consistency_force <path>` force one path now, without a map change

## Status

Phase 1 server side is **done and verified on the local test server**: the
extension loads clean and the plugin logs

    [consistency] forced 1 file for consistency checking: models/infected/hunter.mdl
    [consistency] sv_consistency is ON

Phase 1 client side is **not answered**. Whether an L4D1 client actually
disconnects on a mismatch needs a real client with a modified file. Everything
after depends on that answer.
