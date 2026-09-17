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

## Chicago (NFO) file pull

`pull-chicago-files.py` runs on the Dallas box as `pug-pull-chicago.timer` (every
2 minutes). It pulls Chicago's match demos and replay files over FTP into the
site's demo and replay directories, then deletes them there. Only files whose
size stopped changing between runs are taken, so a demo still being written is
left alone. Config: `/etc/pug-chicago.env` (root, 0600).

`src/reindex.ts` links whatever lands to its match, since the files arrive after
the match ended.

Install:

    scp ops/pull-chicago-files.py root@45.32.199.85:/usr/local/bin/pug-pull-chicago
    scp ops/pug-pull-chicago.service ops/pug-pull-chicago.timer root@45.32.199.85:/etc/systemd/system/
    ssh root@45.32.199.85 'chmod +x /usr/local/bin/pug-pull-chicago && systemctl daemon-reload && systemctl enable --now pug-pull-chicago.timer'

## Retention

Demos and replays are pruned by the web app (daily, and 30 s after boot), with
retention in Admin -> Settings. **The app must be able to write the game
directory for that to work.** It could not until 2026-09-17: the files are owned
by `l4d` and the unit had `ProtectSystem=strict` with only its own data
directory writable, so every prune silently deleted nothing. The fix is
`/etc/systemd/system/pug-web.service.d/gamedir.conf` (SupplementaryGroups=l4d,
ReadWritePaths for the game dir and replays) plus `g+w` on those two
directories.
