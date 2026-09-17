#!/usr/bin/env bash
# Pull the box's PUG database snapshots to this workstation, so a copy survives
# losing the box. Run daily by a systemd user timer (see install notes in
# ops/README.md). Keeps the newest 90 files locally.
set -euo pipefail
DEST="$HOME/l4d/backups/pug"
mkdir -p "$DEST"
rsync -a --timeout=60 root@45.32.199.85:/home/pug/backups/ "$DEST/"
ls -1t "$DEST"/pug-*.db.gz | tail -n +91 | xargs -r rm -f
