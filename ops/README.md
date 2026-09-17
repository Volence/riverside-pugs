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
