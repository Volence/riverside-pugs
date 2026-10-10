# ops

## Database backups

The box snapshots `/home/pug/app/data/pug.db` every 6 hours into
`/home/pug/backups/pug-YYYYmmdd-HHMM.db.gz`, keeping 60 (about 15 days).
The workstation pulls those daily into `~/l4d/backups/pug/`, keeping 90.

Install on the box:

    scp ops/pug-db-backup.sh root@45.32.199.85:/usr/local/bin/pug-db-backup
    scp ops/pug-db-backup.service ops/pug-db-backup.timer root@45.32.199.85:/etc/systemd/system/
    ssh root@45.32.199.85 'chmod +x /usr/local/bin/pug-db-backup && systemctl daemon-reload && systemctl enable --now pug-db-backup.timer'

Install the pull on the workstation (systemd user units in ~/.config/systemd/user).

Restore: stop the site, `gunzip -c pug-....db.gz > /home/pug/app/data/pug.db`,
remove `pug.db-wal` and `pug.db-shm`, `chown pug:pug`, start the site.

## Retention

Demos and replays are pruned by the web app (daily, and 30 s after boot), with
retention in Admin -> Settings. **The app must be able to write the game
directory for that to work.** It could not until 2026-09-17: the files are owned
by `l4d` and the unit had `ProtectSystem=strict` with only its own data
directory writable, so every prune silently deleted nothing. The fix is
`/etc/systemd/system/pug-web.service.d/gamedir.conf` (SupplementaryGroups=l4d,
ReadWritePaths for the game dir and replays) plus `g+w` on those two
directories.

## Custom campaigns

Uploading and installing custom campaign VPKs reuses this same write access,
but needs `ADDONS_DIR` and per-server addons columns configured before any of
it works. See `docs/CUSTOM_CAMPAIGNS.md` for the environment variable, the
exact SQL for both servers' rows, deploy order, and how to verify an install.
