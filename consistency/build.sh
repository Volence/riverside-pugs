#!/usr/bin/env bash
# Build l4d_consistency.ext.so inside the Ubuntu 22.04 container.
#
# Never build this on the host. Arch's toolchain links GLIBC 2.4x symbols and the
# Dallas box is 2.39, so a host build loads nowhere. Ubuntu 22.04 keeps the
# highest required symbol at 2.35, which is the same constraint sourcetvsupport
# was built under (see sourcetv/README.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"        # /home/volence/l4d, so deps/ is reachable
img=l4d-consistency-build:u22

docker image inspect "$img" >/dev/null 2>&1 \
  || docker build -t "$img" -f "$here/Dockerfile.build" "$here"

docker run --rm -u "$(id -u):$(id -g)" -v "$root:/work" -w /work/pug/consistency "$img" \
  bash -c 'make clean && make CXX=g++ DEPS=/work/sourcetv/deps'
