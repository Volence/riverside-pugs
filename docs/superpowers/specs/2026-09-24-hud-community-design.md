# Community HUDs and crosshairs

Date: 2026-09-24. Branch `hud-community`, branched from `worktree-hud-editor` at 248754a. Written overnight
while the owner slept, from the owner's idea of 2026-09-23/24; every call made without the owner is listed
under "Decided overnight, for owner review" at the end. Nothing here is deployed until the owner approves.

## The idea

A page on riversidepug.com, `/community`, where players share the HUDs they made in the HUD editor (`/hud`)
and the crosshairs they made in the crosshair maker (`/crosshair`, or the crosshair panel inside the HUD
editor). Everyone can browse them. A signed-in player can like them, open one in the editor, download one
as an addon, and report one. Staff can remove one.

Each player may share at most **2 HUDs and 2 crosshairs** at a time.

## What a shared entry is

There are two kinds of entry, `hud` and `crosshair`.

### A crosshair entry

A crosshair entry is the editor's own `CrosshairArt` JSON (`web/src/crosshair/model.ts`): either
`{ kind: 'built', state }` or `{ kind: 'image', png, w, h }`. Nothing else is stored for it.

- It is small. A built crosshair is a few hundred bytes. An image is the 128-pixel texture the crosshair
  page already keeps. Community images are capped at 128 x 128 and 100 KB of base64.
- The gallery draws it live with `drawArt`, the routine the editor, its zoom and the exported texture
  already share, so no preview is stored.
- Downloads use `crosshairFiles` (`web/src/crosshair/vpk.ts`), the same code the crosshair page uses.

### A HUD entry

A HUD entry has up to three parts:

1. **The design JSON**, a `HudDesign` exactly as the editor saves it. Any style images and the crosshair
   ride inside it, as they do in a saved design today. Capped at 2 MB.
2. **The imported HUD's files**, only when `design.preset === 'imported'`. They are stored as one
   content-addressed blob keyed by the import's `hudId` (the SHA-256 the HUD upload feature already
   computes). Two players who share edits of the same imported HUD share one blob. Stock and Modern
   designs have no blob, because their base files ship with the site.
3. **A preview PNG**, drawn in the author's browser when they share, by the editor's own renderer.

A prebuilt `.vpk` of the HUD is **never** stored or served. Every download is rebuilt in the downloader's
browser by the existing `buildHud`/`packHud` path from the design plus the import's files. The files that
come out are therefore always files the editor generates, or import files that passed the allowlist below.
A shared HUD has no way to smuggle an arbitrary file into someone's `addons` folder.

The trust boundary for the design JSON stays where it is today. `validateDesign` already treats every
design as untrusted, because share links and `.json` files are untrusted, and the page runs every
community design through it before use. The server cannot run `validateDesign`: it depends on the base
files, which Vite bundles through `import.meta.glob`. So the server checks structure and sizes only, and
the images and crosshair inside the design (see "Checks on the server").

## Security: the HUD file allowlist

This is the part that matters most. Once installed, an addon VPK in `left4dead/addons` can carry
anything: `cfg/autoexec.cfg` with binds, `scripts/` weapon files, sounds, models, particles,
`resource/gamemenu.res` whose buttons run console commands, and more. A community HUD must carry
nothing but HUD files.

### The list

One pure module, `src/hudFiles.ts`, is imported by both the server and the web. It has no imports, so
the web can use it through a relative path, as it already does for `src/replayFormat.ts`. A path is
allowed only when every segment is `[a-z0-9_.-]` with no empty, `.` or `..` segment (stricter than
`vpkPathProblem`, so any allowed path is one a VPK can hold) and it matches one of these rules:

| Rule | Paths | Content check | Per-file cap |
|---|---|---|---|
| HUD scripts | exactly `scripts/hudlayout.res`, `scripts/hudanimations.txt`, `scripts/hud_textures.txt`, `scripts/mod_textures.txt` | text (see below) | 512 KB |
| Schemes | exactly `resource/clientscheme.res`, `resource/chatscheme.res` | text | 512 KB |
| HUD panels | `resource/ui/hud/` + one or more `[a-z0-9_]` folder segments + `.res` | text | 512 KB |
| Named UI panels | exactly `resource/ui/basechat.res`, `resource/ui/hudghostpanel.res`, `resource/ui/scoreboard.res`, `resource/ui/scoreboardsurvivor.res`, `resource/ui/scoreboardinfectedplayer.res`, `resource/ui/versusmodescoreboard.res`, `resource/ui/zombiepanel.res` | text | 512 KB |
| Fonts | `resource/` + any folders + `.ttf`, `.otf` or `.vfont` | magic bytes: `00 01 00 00`, `OTTO` or `true` at the start; `VFONT1` at the end for a `.vfont` | 4 MB |
| Textures | `materials/vgui/` + any folders + `.vtf` | `VTF\0` magic; width and height from the header, each 1..2048 | 8 MB |
| Materials | `materials/vgui/` + any folders + `.vmt` | text | 16 KB |

The named UI panels are the `resource/ui/*.res` files that the editor's own stock and Modern bases carry.
The rest of `resource/ui/` is refused, because that folder also holds game UI dialogs whose buttons can
send commands.

Everything else is refused. That includes:

- `addoninfo.txt`: the editor writes its own;
- `gameinfo.txt`;
- `cfg/`, `sound/`, `models/`, `particles/`, `maps/`, `bin/`;
- other `scripts/` files, such as weapon scripts;
- `resource/*.txt`, such as localisation and close captions;
- `resource/gamemenu.res`;
- materials outside `materials/vgui/`;
- a nested `.vpk`.

### Text checks

The checks read each file the way the game does, since a check that tokenizes differently from the
game can be walked around: whatever the check thinks is a comment or one long word, the game may read
as a key and a value.

Every KeyValues text file (`.res`, `.vmt`, and the `.txt` files other than `hudanimations.txt`) is
refused if it:

- contains a NUL byte;
- has a quoted string that does not close on its own line. The game reads a quoted string across line
  ends, and one that runs over would make the check and the game disagree about where comments are.
  The check runs with and without backslash escapes, and the string must close on its line both ways;
- has a quoted or bare value starting with `engine` followed by a space, case-insensitive. This is the
  VGUI prefix that turns a button command into a console command. The editor and the stock files never
  write it. A bare word `engine` on its own is refused too.

As in the game, `//` starts a comment only where a new token starts. Inside a bare word it is part of the
word, so `v//x "command" "..."` is a word, then a key and a value, and the value is checked. A bare word
ends at whitespace, a quote or a brace.

`scripts/hudanimations.txt` is read by the animation controller's own tokenizer (Source's `ParseFile`),
not the KeyValues one: a word runs through a quote or a `//`, and `{ } ( ) ' :` are tokens of their own.
It is refused if:

- `FireCommand`, `PlaySound` or `SetInputEnabled` appears anywhere, as a raw case-insensitive
  substring, comments included. No stock file holds any of them;
- `(`, `)`, `'` or `:` appears outside a comment, or a byte above `0x7f` outside a comment or string (the
  game's signed `char` reads such a byte as whitespace). The stock files have none there;
- a quoted string does not close on its line;
- its tokens are not a run of `event <name> { <commands> }` in which every command is one of `Animate`,
  `RunEvent`, `RunEventChild`, `StopEvent`, `StopAnimation`, `StopPanelAnimations`, `SetVisible`,
  `SetFont`, `SetTexture` or `SetString` followed by its full count of arguments (`Animate` takes one
  more when its interpolator is `Pulse` or `Flicker`). The check steps through the stream by those counts,
  so a second command on a line, or a command glued onto another's arguments, is checked like the first.

L4D1's controller (strings in its `client.dll`) knows only `Animate`, `RunEvent`, `StopEvent`,
`StopAnimation`, `StopPanelAnimations`, `SetFont`, `SetTexture` and `SetString`, and it has no
`FireCommand` at all; `RunEventChild` and `SetVisible` come from later engines, are display-only there,
and make L4D1 stop parsing the file. Stock L4D1 uses only `event`, `Animate`, `StopEvent` and
`StopAnimation`.

### Set caps

A HUD's file set is capped as a whole:

- at most 400 files;
- at most 20 MB in total;
- it must contain `scripts/hudlayout.res`.

The editor's own import cap of 50 MB still applies to a player's private imports. Only sharing has the
lower cap.

### Where the list is enforced

1. **When sharing, in the author's browser.** The import's files go through
   `shareableHudFiles(files)`, which keeps the allowed files and lists the rest. The share dialog shows
   "Left out when sharing: cfg/autoexec.cfg, sound/..." before the author confirms. The kept set gets its
   own `hudId`, the design's `imported.id` is rewritten to it, and it passes `importProblem` (the dry run
   the import feature already has) before anything is uploaded. A set that breaks a cap is refused with
   one line.
2. **On upload, on the server.** Nothing is filtered here; anything outside the list is **refused**.
   - A hand-made request with one bad path gets a 400 that names the path.
   - The server reads the uploaded VPK with the same reader the web uses (`readVPK` moves from
     `web/src/vpk/read.ts` to the import-free `src/vpkRead.ts`, and the web file re-exports it) and runs
     every file through `hudFileProblem`.
   - It checks that the VPK holds no split parts and no two paths that differ only in case (`readVPK`
     refuses those), and that it is byte for byte what `encodeVPK` (now in the import-free
     `src/vpkWrite.ts`) writes for the files it holds: `canonicalVpkProblem` in `src/vpkRead.ts`. A length
     rule is not enough, since two entries over the same bytes leave bytes that nothing reads and still
     add up.
   - It recomputes `hudId` and checks that it equals both the id the request claims and
     `design.imported.id`.
3. **When fetching, in every downloader's browser.** Before a community blob is registered as an import,
   every file is checked again with the same function, and its `hudId` must equal the entry's id. If
   either check fails, the page shows "This community HUD failed its safety check" and uses nothing.
4. **At build.**
   - A test pins down that every path `buildHud` can generate is on the list. It runs over stock, Modern,
     Advanced and an imported fixture, with every feature switched on: fonts, style images, weapon boxes,
     the crosshair.
   - At runtime, an import that came from the community is registered with a `community` flag.
     `buildHud` throws rather than emit a path the list refuses: "This community HUD would ship a file
     outside the HUD folders: <path>".
   - A player's own private imports keep the pass-through the import spec promised, byte for byte. That
     is their own content on their own machine.

### Other limits and rendering

| Field | Limit |
|---|---|
| Title | 3 to 40 characters, one line |
| Description | at most 280 characters and 4 lines; no links (`profileFields`' `LINKISH` rule) |
| Design JSON | 2 MB |
| Preview PNG | 1.5 MB, one of 960x540, 864x540 or 720x540 (16:9, 16:10, 4:3 at 540 tall) |
| Crosshair image | 128 x 128, 100 KB of base64 |
| Images inside a design | the editor's existing caps (512 a side, `MAX_IMAGE_B64`), and each must be a real PNG (signature and IHDR checked) |

- **Title and description text.** Control, zero-width and bidi characters are refused with
  `hasUnsafeChars` from `profileFields.ts` (exported for this). Slurs are refused with `findSlurs` (`src/slurs.ts`, the
  conduct-alert matcher). The refusal is "That title is not allowed here." and it is not logged as a
  conduct flag.
- **XSS-safe rendering.** Titles, descriptions and author names render as Preact text, never HTML.
  Preview and file URLs are built by the page from ids and hex hashes that the server validated. The
  download filename goes through `safeName`.
- **File responses** carry these headers:
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - an exact `Content-Type` (`image/png`, or `application/octet-stream` with `Content-Disposition:
    attachment` for a blob).

  So a PNG that is secretly also HTML can never render as a page.
- **Licensing.** The share dialog has a required checkbox: "I made this, or its author said I may share
  it." Imported HUDs can carry fonts and art their makers never meant to be redistributed. The checkbox,
  the report button and staff removal are the answer, not scanning.

## Where the files live

Files are stored on local disk, in `COMMUNITY_DIR`, which defaults to `<dirname(DB_PATH)>/community` (on
the box, `/home/pug/app/data/community`). This follows the ticket-attachments precedent
(`TICKET_ATTACHMENTS_DIR`). `deploy-web.sh` already excludes `data/`.

```
community/
  imports/<hudId>.vpk      one per distinct imported HUD, the verified VPK the author's browser built
  previews/<sha256>.png    one per preview, named by its own hash
```

The design and crosshair JSON live in the database row: they are small, moderation reads them, and the
list query never selects them.

Why not R2: R2 is used only for demos. Its credentials live only in the box's `.env`, and the live R2
token was blanked on 2026-09-23. It would add a second failure mode for no gain at this size.

### Budget

- **Worst case per player:** 2 x (20 MB import + 2 MB design + 1.5 MB preview), about 47 MB. A typical
  editor HUD on Stock or Modern is under 1 MB.
- **Total store cap:** the `community_store_mb` setting, default **1024 MB**. Sharing a HUD that would
  pass it is refused with "The community shelf is full right now."
- **Free-space floor:** a share is also refused when the disk would drop under **12 GB** free. The Dallas
  box's replay floor is 10 GB (see the demo disk pressure note). Community files must never be what
  pushes it there.
- **Purging:**
  - A removed or deleted entry keeps its files for 30 days, as evidence for a report.
  - A sweep then deletes its preview. It also deletes its blob, unless a live entry still references it.
  - The same sweep deletes any file that no row references and that is older than an hour. That covers
    a crash between writing a file and inserting its row.

## Pages

### `/community`

Two tabs, **HUDs** and **Crosshairs**, and a sort, **New** or **Top** (by likes, newest first on ties). It
shows 24 per page, with Previous and Next.

**A HUD card** shows:

- the preview image;
- the title and the description;
- the author's avatar and name, linking to `/player/<steamid>`;
- badges for the base (Stock, Modern, or Imported with the import's name) and for Advanced install when
  the design needs the gameinfo mount;
- the like count and a like button (signed-in, active players; not on their own entry).

It has three actions:

- **Open in the HUD editor** goes to `/hud?community=<id>`.
- **Download** lazy-loads the build code and builds the `.vpk` (or the Advanced `.zip`) in the browser.
- **Report**, which uses the existing report form (see "Moderation").

**A crosshair card** draws the crosshair live over the crosshair page's backdrop, with the same text,
author and likes. It has four actions:

- **Download .vpk**;
- **Open in the crosshair maker**: `/crosshair?community=<id>`, which asks before replacing the saved
  crosshair;
- **Use in my HUD**: `/hud?xhair=<id>`, the same one-step, undoable carry-over `?from=crosshair` does
  today;
- **Report**.

### `/community/<id>`

The same card, larger, for one entry. This is what a Discord link and a ticket point at. A removed or
deleted entry shows "This entry was removed." to everyone except staff. Staff see the entry with a
"Removed by <name>: <reason>" line, because they need it as evidence.

### Sharing from the HUD editor

The toolbar gets **Share to community...**, which opens a dialog. For an anonymous or pending viewer, the
dialog says to sign in with Steam. Otherwise it has:

- the title (pre-filled from the design's name);
- the description;
- the licensing checkbox;
- the preview it will upload;
- the "Left out when sharing" list, when there is one;
- **Share**.

**When the player is at the cap.** The dialog first reads `GET /api/community/mine`. At 2 live HUDs it
says "You are sharing 2 HUDs already. Delete one to share another", links to them, and disables Share.

**The preview** is drawn once, off screen, into a canvas of the design's aspect at 540 tall:

1. `drawBackdrop` with the `scene` backdrop, as the editor's canvas starts.
2. `drawHud` for the survivor side, Healthy, holding the gun, with nothing selected.
3. `drawHud` repaints every time its `onAsset` callback fires, until no asset has arrived for 300 ms
   (capped at 3 s), and it waits for `document.fonts.ready`.
4. The result is exported with `canvas.toBlob('image/png')`.

A locked design cannot be shared: one whose import is missing or broken.

### Sharing a crosshair

The crosshair page and the HUD editor's crosshair panel each get **Share to community...**. It uses the
same dialog, minus the preview upload.

### Opening a community HUD in the editor (`/hud?community=<id>`)

On mount, the page:

1. Fetches the entry.
2. If the entry has a blob that is not already in this browser's `hudStore`, fetches it. It reads the
   blob with `readVPK`, runs every file through `hudFileProblem`, checks the `hudId`, and runs
   `importProblem`.
3. Stores the import in `hudStore` under the entry's title, with `community: { entryId }`, and registers
   it with the community flag.
4. Asks the same "Load the HUD design from this link?" question the share link asks. If the player
   agrees, it applies `usableCrosshair(validateDesign(design))` as one undoable step.

The imported base then appears in the Preset select like any import and can be removed the same way. The
query parameter is stripped once it has been used, as `#d=` and `?from=crosshair` are.

### Profile

A player's profile gets a small **Shared** panel: their live entries as compact cards linking to
`/community/<id>`. It shows only when they have at least one. It sits after the endorsement counts.

### Nav

`Community` joins the nav next to `Crosshair` and `HUD`.

## Server

### Tables

These tables are added in `openDb`, using `CREATE TABLE IF NOT EXISTS` and `ensureColumn`.

```sql
CREATE TABLE IF NOT EXISTS community_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- 'hud' | 'crosshair'; no CHECK (tickets convention)
  author_id TEXT NOT NULL REFERENCES players(steamid),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,                   -- design JSON or CrosshairArt JSON; '' once purged
  preset TEXT,                             -- hud: 'stock' | 'modern' | 'imported'
  aspect TEXT,                             -- hud: '16:9' | '16:10' | '4:3'
  advanced INTEGER NOT NULL DEFAULT 0,
  import_id TEXT,                          -- hud on an imported base: the blob's hudId
  import_name TEXT,
  preview TEXT,                            -- hud: sha256 hex of the preview PNG
  bytes INTEGER NOT NULL DEFAULT 0,        -- payload + preview + blob (if this entry wrote it), for the cap
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,                         -- author (self-delete) or staff steamid; no FK, like admin_actions.target
  delete_reason TEXT,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_community_list ON community_entries (kind, deleted_at, id);
CREATE INDEX IF NOT EXISTS idx_community_author ON community_entries (author_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_community_import ON community_entries (import_id);
CREATE INDEX IF NOT EXISTS idx_community_preview ON community_entries (preview);

CREATE TABLE IF NOT EXISTS community_likes (
  entry_id INTEGER NOT NULL REFERENCES community_entries(id),
  player_id TEXT NOT NULL REFERENCES players(steamid),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, player_id)
);
```

`ticket_reports` gains `community_entry_id INTEGER` through `ensureColumn`. The call goes **after**
`widenTicketIdentity` and `migrateLegacyReports`, whose rebuild copies a fixed column list and would drop
a column added before it.

**Merging players.** `mergePlayers` learns these:

- `community_entries.author_id` and `community_entries.deleted_by` go in `PLAIN`;
- `community_likes.player_id` goes in `KEYED`.

After the move, it deletes any like the surviving account now holds on its own entry. The per-player cap
is checked only when sharing, so a merged account may end up above it. That is allowed.

### Settings

These go in a new settings group, `Community`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `community_uploads` | bool | on | Kill switch. Off refuses new shares; browsing, downloads and likes keep working. |
| `community_huds_per_player` | int, 0..5 | 2 | Live HUD entries per player. |
| `community_crosshairs_per_player` | int, 0..5 | 2 | Live crosshair entries per player. |
| `community_shares_per_day` | int, 1..50 | 6 | Shares per player per 24 h, deletes included, so delete-and-reshare cannot churn the disk. |
| `community_store_mb` | int, 100..20000 | 1024 | Total store cap. |

### Routes

The routes live in `src/routes/community.ts`, registered like `campaignRoutes`. `@fastify/multipart` is
registered inside this plugin only.

| Route | Who | What |
|---|---|---|
| `GET /api/community?kind=&sort=new\|top&page=&author=` | anyone | A page of live entries without payloads. A crosshair entry's art is included, since it is small. It includes `likes` and `likedByMe` (via `makeOptionalViewer`). Entries by players with status `banned` are left out. |
| `GET /api/community/mine` | active | The caller's live entries plus staff-removed tombstones (with the reason), and the caps. |
| `GET /api/community/:id` | anyone | One live entry with its payload. Staff also get removed ones, with the removal. |
| `POST /api/community/crosshairs` | active | JSON `{ title, description, art, permission: true }`. Body limit 256 KB. |
| `POST /api/community/huds` | active | Multipart. Parts: `meta` (JSON `{ title, description, permission, design, importId? }`), `preview` (PNG), `import` (VPK, only when the design is on an imported base). Limits: 3 parts, 20 MB per file. |
| `DELETE /api/community/:id` | author | Tombstone, `deleted_by` = author. |
| `POST /api/community/:id/remove` | mod or admin | `{ reason }` (required, at most 200 characters). Tombstone, then `logAdmin(db, staff, 'community_remove', author, { entryId, kind, title, reason })`. |
| `PUT /api/community/:id/like`, `DELETE /api/community/:id/like` | active, not the author | Idempotent. |
| `GET /api/community/files/previews/:sha.png` | anyone while a live entry uses it; staff always | The file, with the headers above. |
| `GET /api/community/files/imports/:hudId.vpk` | same | The file, with the headers above. |

Refusals are one line each, in the house style:

- 400: a bad field, naming it;
- 403: `community_uploads` is off: "Sharing is switched off right now.";
- 409: at the cap: "You are sharing 2 HUDs already. Delete one to share another.";
- 413: over a size cap;
- 429: over the daily shares: "You can share 6 times a day; try again tomorrow.";
- 507: the store is full or the disk floor would be crossed.

### Checks on the server

These live in `src/community/validate.ts`.

- **Text:** see "Other limits and rendering".
- **Crosshair art:** the server's own port of `readArt`'s rules, kept identical by a parity test that
  runs both over the same cases:
  - a built crosshair needs a known shape, finite numbers clamped to `LIMITS`, and a `#rrggbb` colour;
  - an image needs a PNG data URL whose IHDR matches `w`/`h`, at most 128.
- **HUD design, structure only:**
  - JSON, at most 2 MB, an object with `v === 1`;
  - `preset` in the three presets;
  - `aspect` in the three aspects;
  - `advanced` a boolean;
  - `imported.id` present if and only if the preset is `imported`, and equal to `importId`;
  - every `images[*].png` a real PNG within caps;
  - `xhairArt`, when present, passes the crosshair check with the design caps (512 a side, since designs
    allow that).

  The server then writes `name` to `safeName(title)`, which it ports, and stores the re-serialized JSON.
- **Preview:** a PNG signature, IHDR dimensions matching the design's aspect at 540 tall, and at most
  1.5 MB.
- **Import:** see "Where the list is enforced", step 2.

### Writing

1. Validate everything before touching the disk.
2. Write each new file to a temp name in the same folder, then rename it. A blob or preview whose hash
   already exists is not written again.
3. Insert the row in a transaction that re-checks the caps.
4. If the insert fails, remove the files this request wrote, unless another row references them.

## Moderation

**Reports reuse the tickets system.** A report about a shared entry is a report about its author, so it
joins that player's ticket, as every other report does.

- `fileReport`'s body gains an optional `entryId`.
- It must name an existing entry whose author is the report's target. Otherwise it gets a 400: "that
  entry is not theirs".
- It is stored in `ticket_reports.community_entry_id`.
- The duplicate rule for such a report is "one report per reporter per entry, ever". The rule "one open
  report per player" is not applied to it, so a player can report someone's HUD without losing the
  ability to report their behaviour.
- `ticketDetail` returns `entry: { id, kind, title, removed }` on each report. The staff ticket page links
  it to `/community/<id>`.
- On the site, the card's Report button opens the existing `ReportPlayer` form with the author as its
  fixed target and a new `entry` prop. The form says "About their shared HUD '<title>'".

**Staff remove from the entry itself.** Mods and admins see **Remove** on every card and on the entry
page. It asks for a reason, then tombstones the entry, which also takes it out of every list at once. The
removal lands in the admin audit log and the admin feed through `logAdmin`. The author's own "mine" list
shows the entry as "Removed by staff: <reason>".

No separate admin tab is added in this version. The audit log and the ticket are where staff look.

## Testing

**Shared module:**

- every file of the stock and Modern bases passes;
- each refused family is refused: cfg, sound, `gamemenu.res`, other `resource/ui` files, a nested VPK,
  a material outside vgui, and addoninfo;
- each content check refuses its case: a NUL byte, an `engine` value, `FireCommand`, bad font magic,
  bad VTF magic, a VTF over 2048;
- each cap is refused at its limit plus one;
- `hudId` moves into the shared module; `upload.ts` re-exports it, and its existing tests still pass.

**Build invariant:**

- `buildHud`'s output paths for stock, Modern, Advanced and an imported fixture, with every feature on,
  all pass the allowlist;
- a community-flagged import with a refused path makes `buildHud` throw.

**Server routes** (`app.inject`, as in `ticketRoutes.test.ts`):

- each route's happy path;
- anonymous, pending and banned callers are refused;
- the caps: per kind, per day, store MB and disk floor, the last two through injected functions;
- a hand-made VPK with one refused path gets a 400 naming it;
- a VPK with trailing bytes is refused;
- a `hudId` mismatch is refused;
- a like on your own entry, and double likes;
- author delete and staff remove, the audit row, and 404 for the public afterwards;
- the file routes' headers, including the 404 once an entry is gone;
- the sweep;
- the report with `entryId`: the right author, the wrong author, and the per-entry duplicate rule.

**mergePlayers:** the foreign-key coverage test passes with the new tables. A merge moves entries and
likes and drops the survivor's self-like.

**Web:**

- the community page renders cards from a mocked API, sorts, and pages;
- the like button toggles;
- the share dialog shows the cap state, the left-out list and the checkbox gate;
- `openCommunity`: a good blob registers and stores; a blob with a bad path or a wrong hash is refused
  with the one line;
- `/hud?community=` applies the design as one undoable step after the confirmation;
- `/hud?xhair=` sets the crosshair;
- the Profile panel shows only with entries.

**Headless check:** see the plan's last task.

## Out of scope

- Comments, collections, following, tags and search.
- Editing an entry in place. Delete it and share again. The daily share limit covers churn.
- Download counts: they are noisy and easy to game, and likes cover "popular".
- Server-side rendering of previews, and re-encoding uploaded PNGs.
- Sharing designs from Advanced-only style slots that write outside `materials/vgui` (none exist today;
  the build-invariant test would catch a new one).

## Decided overnight, for owner review

1. **Caps: 2 HUDs and 2 crosshairs per player** (the owner said "1 or 2"). Both are admin settings, so
   dropping to 1 is a settings change.
2. **Local disk under `data/community`, not R2.** This follows ticket attachments. The store is capped at
   1 GB total, with a 12 GB free-disk floor so it can never push the Dallas box toward the replay floor.
3. **Previews are stored PNGs drawn by the editor in the author's browser, not rendered live in the
   gallery.** Drawing live would mean downloading every imported HUD (up to 20 MB each) and the whole
   editor bundle just to show a grid of cards. The cost is that a preview could be faked by a hand-made
   request. "Open in the HUD editor" always shows the truth, and Report covers abuse. Crosshairs are
   drawn live, because they are tiny.
4. **The import is stored as one VPK blob per `hudId`, not per file.** The allowlist is enforced three
   times (share, upload, fetch) plus at build. The server refuses rather than filters; the author's
   browser filters and shows what it left out.
5. **The allowlist** (table above) deliberately leaves out:
   - `addoninfo.txt`: the editor writes its own;
   - `resource/ui/*.res` beyond the seven UI files the editor's bases carry;
   - every non-HUD `scripts/` file;
   - `hudanimations.txt` commands other than the display ones.

   It also refuses any text file with an `engine ` value. None of this was tested in game. It errs on the
   side of refusing, and a HUD that needs more can be looked at case by case.
6. **A player's own private imports keep full pass-through.** Only community-flagged imports get the
   build-time guard.
7. **Likes are in, download counts are out.** "Top" sorts by likes.
8. **Reports go through the existing tickets system** as a report about the author, with a new
   `community_entry_id` column and a per-entry duplicate rule. There is no separate content-report system
   and no admin tab. Staff remove from the card, and the removal is logged through `logAdmin`.
9. **Removed or deleted entries keep their files for 30 days** as evidence, then a sweep purges them.
   The public sees "removed" at once.
10. **Entries by banned players drop out of the gallery.** They are not deleted, so an unban brings them
    back.
11. **Titles and descriptions are refused on a slur match (`findSlurs`) and on links.** A refusal is not
    reported to the conduct feed; it is a website form, not in-game chat.
12. **A licensing checkbox is required to share.** Imported HUDs can carry other people's fonts and art.
13. **The branch needs master first.** `hud-community` is 375 commits behind master. The slur matcher,
    tickets phase 3 (`ticketDetail`, the widened reporter identity) and the current `mergePlayers` lists
    exist only there, and a merge
    dry-run shows one conflict, in `web/src/main.tsx`. The plan's Task 0 merges master into
    `hud-community`. It does not touch `worktree-hud-editor`, which another session owns.
14. **No live deploy, and every migration is additive:** new tables, one nullable column, new settings
    with `INSERT OR IGNORE` defaults.
