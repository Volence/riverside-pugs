# demo-push: the live 3D sidecar for a game box

`demo_push.py` follows the SourceTV demo of a PUG match while srcds records it
(`pug_<token>_<ordinal>_<map>.dem`, the name pug-match gives it) and sends the new bytes to the
site's `POST /api/demos/push` about once a second. The site holds every byte back 10 s and serves
the live 3D view on /live (docs/theatre-3d.md "Phase 2").

- Read only: it never writes, moves or deletes a demo (the Dallas pull timer still collects them).
- The match token from the file name is the credential, sent in `X-Demo-Token` over HTTPS only
  (it refuses a non-HTTPS URL except to localhost). Logs show the token's first four hex digits.
- No state on disk. `X-Demo-Started` is the file's birth time (`stat -c %W`), so a sidecar restart
  resumes the same recording (the site answers 409 with its length) instead of restarting viewers.
- Standard library only; python3 is on every box.

Dallas does not run it: the site there reads the growing files itself (`DEMO_LIVE_LOCAL=1`).

## Install on a Riverside box (owner's go-ahead first: it is a change on a game box)

```sh
install -D -m 0755 tools/demo-push/demo_push.py root@<box>:/usr/local/lib/pug-demo-push/demo_push.py
scp tools/demo-push/pug-demo-push.service root@<box>:/etc/systemd/system/
ssh root@<box> 'systemctl daemon-reload && systemctl enable --now pug-demo-push && journalctl -u pug-demo-push -n 20'
```

Nothing changes for the game server: no plugin, cfg or restart. Rollback: `systemctl disable --now
pug-demo-push` (viewers fall back to 2D once the feed stops).

## Measured

srcds writes the growing demo in 688 KiB pieces about every 25 s (Riverside #5, 2026-11-11), so the
sidecar sends one piece every ~25 s, not a trickle: about 28 KB/s per match on average.

Checked locally (2026-11-11): a demo grown in 688 KiB pieces every 25 s, the dev site in push mode,
the real viewer on /live in headless Chrome: no waits, no restarts; killing and restarting the
sidecar mid-map went unnoticed by the viewer; a match that stopped being live made it stop that
recording ("match not live").
