#!/usr/bin/env bash
# Snapshot the PUG database. Installed on the box as /usr/local/bin/pug-db-backup
# and run every 6 hours by pug-db-backup.timer.
#
# sqlite3 .backup, not cp: the site keeps the database open in WAL mode, and a
# plain copy of pug.db can miss everything still sitting in pug.db-wal.
set -euo pipefail
SRC=/home/pug/app/data/pug.db
DEST=/home/pug/backups
KEEP=60   # 6-hourly, so about 15 days

mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%d-%H%M)
TMP="$DEST/.pug-$STAMP.db"
sqlite3 "$SRC" ".backup '$TMP'"
# Refuse to keep a snapshot that is not a readable database.
[ "$(sqlite3 "$TMP" 'PRAGMA integrity_check')" = "ok" ] || { echo "integrity check failed"; rm -f "$TMP"; exit 1; }
gzip -9 "$TMP"
mv "$TMP.gz" "$DEST/pug-$STAMP.db.gz"
ls -1t "$DEST"/pug-*.db.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backed up to $DEST/pug-$STAMP.db.gz"
