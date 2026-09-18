# Build l4d_consistency.ext.so for L4D1 (linux, 32-bit).
#
# A plain Makefile rather than AMBuild. AMBuild is the right tool for an upstream
# project with several targets and SDK branches; this is one translation unit
# plus SourceMod's own smsdk_ext.cpp, and a Makefile you can read start to finish
# is worth more here than a build system you have to learn to debug.
#
# ALWAYS build via ../build.sh, which runs this inside Ubuntu 22.04. A host build
# on Arch links against GLIBC 2.4x and will not load on the Dallas box (2.39).
# sourcetv/README.md records that exact mistake being made once already.

DEPS    ?= ../../sourcetv/deps
SMSDK   ?= $(DEPS)/sourcemod-1.12
MMSDK   ?= $(DEPS)/metamod-1.12
HL2SDK  ?= $(DEPS)/hl2sdk-l4d

BIN      = l4d_consistency.ext.so
BUILDDIR = build

INCLUDES = \
  -I. -Iextension \
  -I$(SMSDK)/public -I$(SMSDK)/public/extensions -I$(SMSDK)/public/amtl \
  -I$(SMSDK)/public/amtl/amtl -I$(SMSDK)/sourcepawn/include \
  -I$(MMSDK)/core -I$(MMSDK)/core/sourcehook \
  -I$(HL2SDK)/public -I$(HL2SDK)/public/engine -I$(HL2SDK)/public/game/server \
  -I$(HL2SDK)/public/tier0 -I$(HL2SDK)/public/tier1 -I$(HL2SDK)/public/mathlib

# -m32: the L4D1 dedicated server is 32-bit i386, confirmed with `file bin/engine.so`.
# The Source SDK requires these three defines; without them the headers select
# the wrong platform paths and fail in ways that do not name the cause.
DEFINES = -DPOSIX -D_LINUX -DLINUX -DGNUC -DCOMPILER_GCC -DSOURCEMOD_BUILD \
          -DSE_LEFT4DEAD=1 -DSOURCE_ENGINE=8 -DNO_MALLOC_OVERRIDE

# The Source SDK headers are written against MSVC's C runtime names and expect
# the build to supply POSIX aliases. Without these, tier1/strtools.h fails on
# `stricmp` with an error that does not mention the cause. This is the same set
# every SourceMod extension Makefile has carried for fifteen years.
DEFINES += -Dstricmp=strcasecmp -D_stricmp=strcasecmp \
           -Dstrnicmp=strncasecmp -D_strnicmp=strncasecmp \
           -Dstrcmpi=strcasecmp -D_strcmpi=strcasecmp \
           -D_snprintf=snprintf -D_vsnprintf=vsnprintf -D_alloca=alloca

CXXFLAGS = -m32 -O2 -fPIC -fno-strict-aliasing -fvisibility=hidden \
           -fpermissive -std=gnu++17 -Wall -Wno-unused -Wno-switch -Wno-invalid-offsetof \
           -Wno-write-strings -Wno-register -Wno-deprecated \
           $(DEFINES) $(INCLUDES)

LDFLAGS = -m32 -shared -static-libgcc

SOURCES = extension/extension.cpp $(SMSDK)/public/smsdk_ext.cpp
OBJECTS = $(addprefix $(BUILDDIR)/,$(notdir $(SOURCES:.cpp=.o)))

all: $(BUILDDIR)/$(BIN)

$(BUILDDIR):
	mkdir -p $(BUILDDIR)

$(BUILDDIR)/extension.o: extension/extension.cpp | $(BUILDDIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILDDIR)/smsdk_ext.o: $(SMSDK)/public/smsdk_ext.cpp | $(BUILDDIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILDDIR)/$(BIN): $(OBJECTS)
	$(CXX) $(LDFLAGS) $(OBJECTS) -o $@
	@echo "--- built $@"
	@file $@
	@echo "--- highest GLIBC symbol required (must be <= 2.35 for the Dallas box):"
	@objdump -T $@ 2>/dev/null | grep -oE "GLIBC_[0-9.]+" | sort -uV | tail -1 || true

clean:
	rm -rf $(BUILDDIR)

.PHONY: all clean
