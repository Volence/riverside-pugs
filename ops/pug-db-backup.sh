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

# Hand-made copies beside the live file (pug.db.bak-*, pug.db.pre-deploy-*, ...)
# are full 330 MB databases that nothing ever deleted; 91 of them filled 15 GB
# by 2026-10-09 and the disk floor refused every community upload. The 6-hourly
# snapshots above cover the same dates, so keep these one day only (3 days until
# 2026-10-25, when 21 copies from two deploy-heavy days held 10 GB). 'pug.db.*'
# needs the dot, so it never matches pug.db, pug.db-wal or pug.db-shm.
find "$(dirname "$SRC")" -maxdepth 1 -type f -name 'pug.db.*' -mmin +1440 -print -delete
