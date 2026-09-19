# Custom campaigns: turning it on

This feature lets an admin upload a custom versus campaign VPK, push it to both
game servers, and put it in the pool players vote from. None of that works
until the box is configured. This is that configuration, plus how to check it
actually worked.

Everything here is web-only. There is no plugin change in this plan: the
existing `sm_pug_match <matchId> <token> <campaign>` call and `changelevel`
already handle a custom campaign once its VPK is sitting in `addons/` on both
servers, because a custom campaign's mission comes from the VPK itself, not
from anything the plugin generates. (Mission generation from a campaign's
`included`/`play_order` columns, so an admin can drop chapters, is a separate
plan, written once this piece is live.)

## 1. The environment: `ADDONS_DIR`

`ADDONS_DIR` in `/home/pug/app/.env` must point at the Dallas game server's
own `left4dead/addons` directory (`src/config.ts`: `addonsDir: env.ADDONS_DIR
?? ''`). Dallas runs the web app and the game server on the same box, so this
is a real local path, not a URL or a mount point to set up:

    ADDONS_DIR=/home/l4d/l4d1-server/left4dead/addons

Unset is a safe default, not a crash. `src/config.ts` defaults it to `''`,
and everything downstream treats empty as "off":

- The upload route (`POST /api/admin/campaigns` in `src/routes/campaigns.ts`)
  checks `if (!addonsDir)` before touching the filesystem and returns a plain
  503 (`no addons directory configured`) instead of trying to `statfs('')` or
  write into whatever the empty string resolves to.
- The admin panel's free-space number degrades the same way: `GET
  /api/admin/campaigns` wraps its `statfs` call in a try/catch and reports
  `free: null` on failure (including the `statfs('')` throw from an unset
  dir) rather than 500ing the whole panel over a number nobody strictly
  needs to see.

So if you forget this step, nothing breaks. Uploads just refuse with a clear
error until you set it.

### Write access

`pug-web` already has what it needs to write into the game directory, because
this piece reuses the fix from the demo/replay pruning work. From
`ops/README.md`: the files under the game directory are owned by `l4d`, and
the unit's `ProtectSystem=strict` only allows writes to the app's own data
directory by default. The fix living in
`/etc/systemd/system/pug-web.service.d/gamedir.conf` adds
`SupplementaryGroups=l4d` and a `ReadWritePaths` entry for the game directory
(plus `g+w` on it).

Check that override covers `addons/` specifically, not just the parent paths
pruning needed (demo and replay directories). If `left4dead/addons` sits
outside every `ReadWritePaths` entry in that drop-in, extend it:

    ssh root@45.32.199.85 'cat /etc/systemd/system/pug-web.service.d/gamedir.conf'

Add the addons path to `ReadWritePaths` if it is missing, then:

    ssh root@45.32.199.85 'systemctl daemon-reload && systemctl restart pug-web'

Until that path is covered, an upload will pass the disk-floor check, start
streaming the file into a `.upload-*.part` temp name inside `addonsDir`
(`src/routes/campaigns.ts`), and fail with `EROFS` the moment it tries to
write, because the rest of the filesystem is read-only to this unit. That
error surfaces as a failed upload request, not a silent no-op, but it is
worth knowing the cause up front rather than debugging it live.

## 2. The per-server rows

Every server the pool installs to needs six columns filled in the `servers`
table before `transportFor` (`src/addonsTransport.ts`) will return a working
transport for it: `addons_transport`, `addons_dir`, and (for FTP) `ftp_host`,
`ftp_port`, `ftp_user`, `ftp_password`. These are added by migration
(`src/db.ts`) with safe defaults: `addons_transport` defaults to `'local'`
and every other column defaults to `NULL`, so an existing server row is
inert until an admin fills it in. Nothing writes to a guessed path.

**This half-configured state is not silent.** `transportFor` returns `null`
whenever a server is not fully configured for its transport: no
`addons_dir` at all, or `addons_transport = 'ftp'` with any of `ftp_host` /
`ftp_user` / `ftp_password` missing. `installCampaign`
(`src/campaignInstall.ts`) treats a `null` transport as an immediate failure,
not a skip: it writes an `installed` row of state `failed` with the error
`server is not configured with an addons transport`. That failure is what
the admin panel's install list shows for that server, so a missing column
reads as a red row in the panel, not as a campaign that looks installed
everywhere when it is not.

**Confirm the actual server names before running anything below.** A SQLite
`UPDATE ... WHERE name = 'Dallas'` that matches no row is a silent no-op: no
error, no changed rows, and `addons_dir` stays `NULL` on whichever row you
meant to fill in. That surfaces much later as a campaign that looks
poolable everywhere else and simply never leaves `pending`, which is a much
harder thing to trace back to a typo'd name than catching it here. Open the
shell and check first:

    ssh root@45.32.199.85 'sqlite3 /home/pug/app/data/pug.db'

```sql
SELECT id, name FROM servers;
```

Match the `WHERE name = '...'` clauses below against what that actually
prints, not against the names used here as examples.

### Dallas (local filesystem)

Dallas runs the web app itself, so its transport is a plain file copy into
the same directory `ADDONS_DIR` already points at:

```sql
UPDATE servers SET addons_transport = 'local',
  addons_dir = '/home/l4d/l4d1-server/left4dead/addons'
WHERE name = 'Dallas';
```

### Chicago (FTP)

Chicago (NFO) has no shared filesystem and no SSH, so its transport is FTP,
the same channel `ops/pull-chicago-files.py` already uses to pull demos and
replays off it. Read the credentials from `/etc/pug-chicago.env` on the
Dallas box rather than retyping them anywhere:

    ssh root@45.32.199.85 'cat /etc/pug-chicago.env'

That file holds `FTP_HOST`, `FTP_USER`, `FTP_PASS` (and `DEMO_DIR` /
`REPLAY_DIR`, which are unrelated to this feature). Use those exact values:

```sql
UPDATE servers SET addons_transport = 'ftp', addons_dir = '/left4dead/addons',
  ftp_host = '<FTP_HOST from /etc/pug-chicago.env>', ftp_port = 21,
  ftp_user = '<FTP_USER from /etc/pug-chicago.env>',
  ftp_password = '<FTP_PASS from /etc/pug-chicago.env>'
WHERE name = 'Chicago';
```

`/left4dead/addons` matches the same FTP root `pull-chicago-files.py` already
uses (`/left4dead`, with `/left4dead/replays` alongside it). Run both
statements against `/home/pug/app/data/pug.db` on the Dallas box, with the
site stopped or at least between installs, the same as any other manual row
edit. `sqlite3` is already on the box for this:

    ssh root@45.32.199.85 'sqlite3 /home/pug/app/data/pug.db'

## 3. Deploy order

This plan is web-only. There is no plugin change to stage, so
`./deploy-web.sh` from this repo is the entire deployment:

    ./deploy-web.sh

Do the **first** campaign upload with both servers empty (no players
connected). `localTransport.put` and `ftpTransport.put` both land the VPK
under a temp name and rename it into place so a running srcds never mounts a
half-written file, but srcds only reads `addons/` at map load. A VPK that
appears while a match is live does not affect that match, but it does change
what the *next* map load on that box will mount, on whatever match happens to
be running at the time. Uploading with the servers empty means the first
mount of a new campaign VPK happens on nobody's live game.

Later uploads (a second campaign, a re-upload after fixing a bad VPK) carry
the same risk on a smaller scale: the safest time is still whenever both
servers are empty. `ops/README.md`'s "Live server: no unasked changes" rule
applies here as much as anywhere else on this box.

## 4. Verify it worked

After deploying and filling in both servers' rows:

1. **Upload a campaign.** Admin -> Campaigns -> upload a VPK containing a
   versus mission. A successful upload returns the parsed campaign as a
   draft with its chapters; publish it from there.
2. **Confirm both servers show `installed`.** Publishing kicks off the
   install to every enabled server in the background (`installCampaign`,
   not awaited by the publish request). Reload the admin panel a few
   seconds later and check the install list under that campaign: both
   Dallas and Chicago should read `installed`. If either reads `failed`,
   the error column, or the panel's audit log entry, whichever the row saved
   will name the reason: e.g. a missing transport column, an FTP auth
   failure, or a size mismatch after a truncated transfer.
3. **Confirm the download link serves the file.** `GET
   /download/campaign/<slug>` should return the VPK with a matching
   `content-length`. This route independently re-checks that the file on
   disk still matches the recorded size, so it also catches a VPK that
   changed or vanished after publish.
4. **Confirm the gating.** A campaign enters the vote in one place: the
   Settings tab's Campaign pool control, which writes `map_pool`. It is only
   offered there once it reports `installed` on every enabled server
   (`poolableCampaigns` in `src/campaignRegistry.ts`), and `validateSetting`
   enforces the same rule, so a direct `PUT` cannot bypass the panel.

   Downloading is a separate question and is not gated. Every published
   campaign is listed on the public page whether or not it is in the vote,
   and the "In the vote" badge is what tells a player which ones they need.
   There used to be an "Available for the pool" checkbox in front of all
   this; it was removed once downloads stopped depending on it, because its
   only remaining job was permitting another switch.

   If a campaign never turns up in the Settings pool list, that is the tell
   that one server is not done installing yet, not a bug to chase in the UI:
   the Campaigns tab says which server and why. Deleting a campaign prunes it
   out of `map_pool` automatically, and refuses with a 409 if it is the only
   campaign left in the pool rather than leaving the vote with nothing.

The orchestrator re-checks install state again at match start
(`isInstalledEverywhere` in `src/campaignInstall.ts`, called from
`src/orchestrator.ts`), so a server that loses its VPK after being marked
installed (a re-image, a manual delete) fails that match's setup with a
named error instead of stranding it on a black screen. That is a safety net,
not a substitute for checking the panel after every publish.

## 5. Campaign stop points: how many maps a campaign plays

An admin can now set, per campaign (stock or custom), how many of its maps a
match plays before it is scored and ended. The Campaigns tab's "Plays"
control writes this; the plugin reads it off the backend's `sm_pug_match`
call as an extra argument (`stopAfterMap`, `src/stopPoint.ts`) and the
finale backstop (`OnMapStart` in `plugin/pug-match.sp`) yields to it when the
stop map is the finale itself. None of this is exercised by a unit test:
`plugin/pug-match.sp` has none, and the interaction between a live match and
a real map load is exactly the kind of thing a test cannot fake honestly.
This section is the actual verification plan.

### Before any of this works: `MISSIONS_DIR`

The "Plays" control is disabled (it reads "Chapters unknown, so this
campaign plays its default") for any campaign whose chapter list the site
cannot see. For a custom campaign that list comes from the uploaded VPK, but
for the stock four it has to be read off the game server's own mission
files, which needs `MISSIONS_DIR` in `/home/pug/app/.env`:

    MISSIONS_DIR=/home/l4d/l4d1-server/left4dead/missions

Unset (the default) is safe, not a crash: `readStockMissions` in
`src/stockMissions.ts` returns an empty map for every stock campaign, the
"Plays" control degrades to its disabled message for all four, and
`stopAfterMap` returns `null`, which sends the plugin nothing and leaves it
on its own `NextMapIsFinale()` exactly as before. So skipping this step does
not break anything; it just leaves the stock four unconfigurable here, the
same as before this feature existed.

### Staging the plugin change

This plan **does** change the plugin, unlike the rest of this document. Two
things about that are easy to get wrong:

1. **`plugin/stage.sh` rsyncs `pug-match.smx` from its own directory**, not
   from wherever your shell happens to be. It resolves `HERE` from
   `${BASH_SOURCE[0]}` and copies `$HERE/pug-match.smx`, so it always ships
   whatever binary sits next to the script it is run from, with no warning
   if that is the wrong one. Run it from **this worktree**
   (`/home/volence/l4d/pug/.claude/worktrees/stop-point/plugin`), which has
   the rebuilt binary. Running it from the main checkout's `plugin/` would
   silently ship that checkout's older plugin, built before this feature
   existed, and every symptom below would look like the feature never
   shipped rather than like a stale binary.
2. **`plugin/pug-match.smx` is gitignored** (`.gitignore:5`; it was
   deliberately untracked in `e97fbab` because a compiled binary that
   changes on every build has no business in history). It is never in the
   repository, on any branch, in any worktree. Run `./build.sh` first, from
   the same `plugin/` directory, or `stage.sh` refuses with "no
   pug-match.smx; run ./build.sh first".

Stage on an **empty** server, the same rule as every other change to this
box (`ops/README.md`, "Live server: no unasked changes"). `stage.sh` itself
refuses to run if anyone is connected unless you pass `--force`, but do not
reach for `--force` here: a plugin reload is low risk, but the sequence
below asks you to actually play matches to the finale, which is not
something to do with real players around.

### Live verification sequence

Do all four of these against the real box, in order, before trusting this
feature with a real match:

1. **Stop one map early.** Set a campaign's "Plays" control to one fewer
   than its full chapter count, start a match on it, and play it down. The
   match should end after that map, not the one after. Confirm the ended
   match's dump (`sm_pug_dump`, or the match page) reports exactly that many
   maps, not one more or one fewer.
2. **Play the finale.** Set a campaign's "Plays" control to its full chapter
   count (the option marked "includes the finale") and play the match
   through. **This path has never run against a real server.** Confirm the
   finale map actually loads, that the second-half round on it is scored
   like any other map, and that the match ends automatically once that
   round is over. This is the one case in this list that specifically did
   not work before `9097ade`, which fixed the finale backstop ending the
   match the instant the finale *loaded* rather than once it was played.
3. **No rule at all.** Confirm a campaign with nothing set in the "Plays"
   control still behaves exactly as it did before this feature: every
   chapter but the last, ending after the second-to-last map.
4. **A self-started match still ends on its own.** Start a match the old
   way (`!load_4v4p` / `!mix`, not through the web queue) on a campaign with
   no rule set, and confirm it still ends itself at the usual point. A
   self-started match never gets a `stopAfterMap` argument at all (there is
   no backend match row to read a rule from), so this should be an
   unaffected no-op, but it is the case most likely to reveal a regression
   in the finale backstop itself.

`[pug] match N stops after <map>` in the server log is how to tell the
backend's argument actually arrived at the plugin; if you set a rule and
never see this line for that match's ID, the argument did not make it and
the match will fall back to the plugin's own default rather than obeying
what the panel says. `sm_pug_status` also prints `stopAfterMap=<map>` (or
`(none)`) for whichever match is live right now, which is faster to check
mid-match than grepping the log.

### A consequence worth knowing before you try case 2

Ending a match used to have exactly one automatic trigger for a finale
campaign: the finale loading. That backstop is now gated on the stop map
matching what actually loaded, which is the whole point (case 2 above is
what that gate makes possible), but it means a finale campaign no longer has
an unconditional automatic end. If an admin changes a campaign mid-finale,
or the finale's second-half round never sends a score (a crash, a stuck
round, whatever match 34 on 2026-09-17 was), nothing ends the match on its
own anymore. Before this feature, the finale loading alone would have
ended it regardless.

Recovery is the same as any other stuck match: `!endpug` in-game, or
`sm_pug_abort <token>` over rcon. `sm_pug_status`'s `stopAfterMap=` line is
the tell that a match is in this state, since it shows a match still
expecting to stop on a map it may already have played or skipped past.
