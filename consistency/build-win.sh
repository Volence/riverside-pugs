#!/usr/bin/env bash
# Build l4d_consistency.ext.dll for a WINDOWS L4D1 dedicated server, from Linux.
#
# WHY NOT MINGW. The extension's whole job is to call one virtual on an interface
# that Valve compiled with MSVC. On i386, MSVC member calls are __thiscall (`this`
# in ECX, callee cleans); GCC pushes `this` as the first stack argument. A MinGW
# build therefore corrupts the stack on the first call instead of failing to load,
# which is the worst way for this to be wrong. clang-cl implements the Microsoft
# C++ ABI, so it is the only cross-compiler that can produce a correct DLL here.
#
# The MSVC CRT and Windows SDK headers are fetched with xwin into DEPS/winsdk,
# outside the repo. Roughly 800 MB, fetched once.
#
# Two things differ from the linux Makefile, both forced by the SDK:
#
#  1. mathlib.h writes `movzx eax, CtrlwdHolder` inside __asm. MSVC infers a word
#     operand; clang's MS-asm parser refuses it as ambiguous (and movzx r32,r/m32
#     does not exist, so word is the only correct reading). A patched copy is
#     generated at build time and force-included, so its include guard makes the
#     SDK's own copy a no-op. Shadowing it with -I does NOT work: clang-cl runs
#     in MSVC compatibility mode, where a quoted include searches every directory
#     in the include STACK before the -I list, and eiface.h is on that stack.
#
#  2. NO_MALLOC_OVERRIDE, which the linux build needs, must NOT be defined here.
#     On Windows it leaves MemAlloc_Free undeclared, because the fallback inlines
#     that define it live in memalloc.h's POSIX branch.
#
# The build VERIFIES the result before exiting, because we have no Windows machine
# to run it on. See the verify section at the bottom: wrong ABI or a shifted vtable
# index fails the build rather than shipping.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Find sourcetv/deps by walking up: $here/../.. is wrong inside a git worktree,
# where the checkout lives under .claude/worktrees/<name>/.
DEPS="${DEPS:-}"
if [ -z "$DEPS" ]; then
  d="$here"
  while [ "$d" != "/" ]; do
    [ -d "$d/sourcetv/deps" ] && { DEPS="$d/sourcetv/deps"; break; }
    d="$(dirname "$d")"
  done
fi
[ -n "$DEPS" ] && [ -d "$DEPS" ] || { echo "cannot find sourcetv/deps; set DEPS=" >&2; exit 1; }
SM="$DEPS/sourcemod-1.12"; MM="$DEPS/metamod-1.12"; HL="$DEPS/hl2sdk-l4d"
W="$DEPS/winsdk"; OUT="$here/build"; BIN="l4d_consistency.ext.dll"

for t in clang-cl lld-link llvm-objdump llvm-readobj; do
  command -v "$t" >/dev/null || { echo "missing $t (install clang/llvm)" >&2; exit 1; }
done

# --- MSVC headers and import libraries -------------------------------------
if [ ! -d "$W/crt/include" ]; then
  echo "--- fetching the MSVC CRT and Windows SDK into $W (once, ~800 MB)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  url=$(curl -s https://api.github.com/repos/Jake-Shadle/xwin/releases/latest \
        | grep -oE 'https://[^"]*x86_64-unknown-linux-musl.tar.gz' | head -1)
  curl -sL "$url" -o "$tmp/xwin.tgz"
  tar xzf "$tmp/xwin.tgz" -C "$tmp"
  # --cache-dir explicitly: xwin otherwise drops a .xwin-cache of Microsoft
  # installers into the working directory, which is inside the repo.
  "$(find "$tmp" -name xwin -type f | head -1)" --accept-license --arch x86 \
    --cache-dir "$tmp/cache" splat --output "$W"
fi

mkdir -p "$OUT/shim/mathlib"
sed 's/movzx  *eax, CtrlwdHolder/movzx eax, word ptr CtrlwdHolder/' \
  "$HL/public/mathlib/mathlib.h" > "$OUT/shim/mathlib/mathlib.h"

INC="-I$here -I$here/extension
 -I$SM/public -I$SM/public/extensions -I$SM/public/amtl -I$SM/public/amtl/amtl -I$SM/sourcepawn/include
 -I$MM/core -I$MM/core/sourcehook
 -I$HL/public -I$HL/public/engine -I$HL/public/game/server -I$HL/public/tier0 -I$HL/public/tier1 -I$HL/public/mathlib"
SYSINC="-imsvc $W/crt/include -imsvc $W/sdk/include/ucrt -imsvc $W/sdk/include/um -imsvc $W/sdk/include/shared"
DEF="-DWIN32 -D_WINDOWS -DCOMPILER_MSVC -DCOMPILER_MSVC32 -DSOURCEMOD_BUILD
 -DSE_LEFT4DEAD=1 -DSOURCE_ENGINE=8
 -D_CRT_SECURE_NO_WARNINGS -D_CRT_SECURE_NO_DEPRECATE -D_CRT_NONSTDC_NO_DEPRECATE"

for f in "$here/extension/extension.cpp" "$SM/public/smsdk_ext.cpp"; do
  echo "--- compiling $(basename "$f")"
  clang-cl --target=i386-pc-windows-msvc "/FI$OUT/shim/mathlib/mathlib.h" \
    /c /O2 /EHsc /MT /std:c++17 -Wno-everything \
    $DEF $SYSINC $INC "$f" "/Fo:$OUT/$(basename "${f%.cpp}").obj"
done

echo "--- linking $BIN"
# /MT keeps the CRT static, so the DLL needs no vcruntime redistributable.
lld-link /DLL /MACHINE:X86 "/OUT:$OUT/$BIN" "$OUT/extension.obj" "$OUT/smsdk_ext.obj" \
  "/LIBPATH:$W/crt/lib/x86" "/LIBPATH:$W/sdk/lib/um/x86" "/LIBPATH:$W/sdk/lib/ucrt/x86" \
  "/LIBPATH:$HL/lib/public" tier0.lib vstdlib.lib kernel32.lib user32.lib

# --- verify -----------------------------------------------------------------
# No Windows box here, so the build proves what it can statically. All three of
# these have a real failure behind them: a missing export makes SourceMod reject
# the file, a shifted vtable index calls the wrong engine function, and `this`
# anywhere but ECX is the MinGW mistake this script exists to avoid.
echo "--- verifying"
fail=0

for sym in GetSMExtAPI CreateInterface_MMS; do
  llvm-readobj --coff-exports "$OUT/$BIN" | grep -q "Name: $sym" \
    && echo "    export $sym: ok" || { echo "    export $sym: MISSING" >&2; fail=1; }
done

# The expected slot is read from the SDK header rather than hardcoded, so an SDK
# update that inserts a virtual above ForceExactFile fails here instead of in game.
idx=$(sed -n '/abstract_class IVEngineServer/,/^};/p' "$HL/public/eiface.h" \
      | grep "virtual" | grep -n "ForceExactFile" | cut -d: -f1)
off=$(printf '0x%x' $(( (idx - 1) * 4 )))
dis=$(llvm-objdump -d --no-show-raw-insn "$OUT/$BIN")
if grep -q "calll.*\*$off(%e" <<<"$dis"; then
  echo "    vtable slot $((idx - 1)) ($off): ok"
else
  echo "    vtable slot $((idx - 1)) ($off): NOT FOUND in the disassembly" >&2; fail=1
fi
# __thiscall: g_pEngine goes into ECX, and the vtable is read through it.
if grep -B3 "calll.*\*$off(%e" <<<"$dis" | grep -q "movl.*(%ecx), %eax"; then
  echo "    this in ECX (__thiscall): ok"
else
  echo "    this in ECX (__thiscall): NOT PROVEN - do not ship this build" >&2; fail=1
fi

[ "$fail" = 0 ] || { echo "--- VERIFICATION FAILED" >&2; exit 1; }
echo "--- built $OUT/$BIN"
file "$OUT/$BIN"
md5sum "$OUT/$BIN"
echo "--- NOTE: verified by disassembly, never executed on Windows."
