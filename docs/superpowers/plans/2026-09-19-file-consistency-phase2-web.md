# File Consistency Phase 2, Web Side: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web notices a player whose connection was dropped by the file-consistency check, tells that player why over Discord, tells admins when it repeats, and refuses a custom campaign VPK that would trip the check for everyone.

**Architecture:** The consistency plugin's token-less `L4DC SIGNON_DROP` line, and the engine's own "entered the game" line, join the UDP log grammar and are admitted by `LogListener` only from a game server's source address, through the same allowlist the `!load_4v4p` match-create burst already uses. A small storage module owns the `signon_drops` table; a notifier on top of it applies the two timing rules (DM on the first drop at most hourly, admin feed on the second drop inside ten minutes with no entry between) and talks to Discord through one new `dm` method on the existing bot transport. Separately, the campaign upload route loads the committed enforced-file list at startup and intersects it with the uploaded VPK's directory.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, better-sqlite3, discord.js behind `BotTransport`, Preact + preact-iso, vitest (node project for `tests/`, happy-dom project for `web/`); SourcePawn (SourceMod 1.12) compiled with the local test server's native `spcomp`.

**Spec:** `docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md`, sections "The web" and "Custom campaigns", plus the "Testing" and "Risks" items that name them. Read "What the server can and cannot know" first: it is why everything here is worded as a hint.

## Already built, do not plan again (commits `bbba54e` and `9bac557`)

- `scripts/gen-consistency-list.ts` generates `consistency/configs/l4d_consistency.cfg` (652 paths since `9bac557`, which added every soundscript the manifest loads plus `soundmixers.txt`; `# group N: title` headers, one game-relative path per line, `#` comments). It has `--commons`, `--game`, `--out` and `--verify`, and resolves loose files through `left4dead_dlc3` before `left4dead`, the engine's own search order.
- `src/vpk.ts` exports `listVpkPaths(vpkPath: string): string[]` (every path in a VPK directory as `dir/name.ext`, `[]` if not a VPK; it can THROW on a truncated directory). Tested in `tests/vpk.test.ts`.
- `consistency/plugin/l4d_consistency.sp` v0.2.0 reads the list, forces it on map start, and emits from the `player_disconnect` event, over `LogToGame`:
  `L4DC SIGNON_DROP steamid=<id> secs=<int, -1 if unknown> forced=<int> name=<rest of line, spaces preserved>`

## Global Constraints

- No em dashes anywhere: code, comments, test names, commit messages, docs, page copy. Rephrase by meaning, never swap the character for a hyphen.
- Nothing in this plan deploys to, restarts, or sends rcon to the live Dallas box (45.32.199.85). Every manual check runs on this workstation against a scratch database. The rollout section of the README is documentation of a later, owner-approved step.
- Everything the drop line produces is a hint, never an accusation: a cancelled loading screen produces the identical line. No code in this plan kicks, bans, penalises or blocks a player. Admin-facing and player-facing copy both say so.
- The admin feed message carries, verbatim from the spec: `likely rejected for a modified game file; the file name was shown on their screen`.
- The timing rules, verbatim from the spec: admin feed on the **second** drop by the same steamid within **ten minutes** with no entry in between; at most **one DM per steamid per hour**; a failed DM is **logged and not retried**.
- Table shape, verbatim from the spec: `signon_drops(id, steamid, name, secs_connected, forced_count, at, entered_after_at)`. No extra columns.
- The web stores and compares SteamID64 (17 digits) everywhere. The parser accepts both `STEAM_X:Y:Z` and SteamID64 on the wire and normalises to SteamID64: `76561197960265728 + Z*2 + Y`, computed with `BigInt`.
- A player's in-game NAME must never be able to forge another field. Structured fields are read only from the slice of the line BEFORE the first ` name=`; the name is everything after it. This is the `CHAT` treatment in `src/logParse.ts`, NOT the `MATCH_ROSTER` treatment, which still has the known roster-forgery bug (it reads `steamid` and `team` from a whole-line `kv()`). Do not copy `MATCH_ROSTER`, and do not fix it in this plan either: it has its own task.
- Schema changes follow `src/db.ts` exactly: a new table goes in the `SCHEMA` string as `CREATE TABLE IF NOT EXISTS`, a new column on an existing table goes through `ensureColumn` in `openDb`. There is no migration framework, by design. App-written timestamps are ISO strings (`new Date().toISOString()`), passed in through a `now = new Date()` parameter so tests drive the clock, the way `src/penalties.ts` and `src/admin/players.ts` do.
- Commit messages match the repo: one short imperative sentence, no conventional-commit prefix (see `git log --oneline -10`).
- Run `npm run typecheck` before every commit that touches `src/`, `tests/` or `web/`.
- All commands run from `/home/volence/l4d/pug` unless a step says otherwise.
- Line numbers are as of `9bac557` (identical to `bbba54e` for every file this plan modifies; that commit touched only the cfg and the generator) and drift as tasks land. Every modification also quotes the exact text to find, which is authoritative.

## Facts about the existing code this plan depends on

Read these before Task 2. Each was checked against the source on 2026-09-19.

**How the address-pinned admission path works today (`src/logListener.ts`, 69 lines).** `LogListener` binds one UDP socket. For every datagram it calls `parseLogDatagram`; a null is dropped. Then there are exactly two ways in:

1. *The token gate* (line 35): `if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address)`. Tokens are registered by the orchestrator at match setup and re-registered at boot from `matches WHERE state='live'`.
2. *The address gate* (lines 40 to 43): if the event's kind is in `SELF_START_KINDS` (`match_create`, `match_roster`, `match_create_end`) AND the datagram's source address is either in the fixed set `matchCreateSources` (filled by `allowMatchCreateFrom(address)`) or accepted by the per-datagram predicate `matchCreateCheck` (set by `allowMatchCreateWhen(fn)`), it is delivered. Anything else with an unknown token is dropped.

`src/server.ts` lines 515 to 528 fill the address gate: one `allowMatchCreateFrom(s.host)` per row of `servers`, one for the host half of `LOG_PUBLIC_ADDRESS` (default `127.0.0.1`, because a loopback feed is sourced from loopback, not from the public IP), and a predicate `resolveServerBySource(db, address, feedHost) !== null` so a server added to the database later is admitted without a restart. The new events reuse this gate unchanged; they add nothing to how addresses are allowed, only to which kinds may pass it.

**Every existing `LogEvent` has a `token: string`.** The new kinds have none, so `ev.token` stops compiling in `logListener.ts` line 35 the moment the union grows. That is why Task 2 touches the listener at all.

**The listener only exists in production mode.** `src/server.ts` builds `LogListener` only when no orchestrator is injected AND `config.devMode` is false (line 333 onward). `npm run dev` sets `DEV_MODE=1` and gets a `DevOrchestrator` with NO UDP socket. Every vitest suite injects `stubOrchestrator()` and also gets none, except `tests/liveView.test.ts` line 398, which passes `{ devMode: false, logListenPort: 0 }` and is the precedent Task 7 follows. The manual check in Task 14 therefore runs `tsx src/index.ts` WITHOUT `DEV_MODE`.

**`parseLogDatagram` finds `PUG ` with `text.indexOf`, anywhere in the datagram.** That is safe for `PUG` lines only because a secret token follows. It would NOT be safe for a token-less marker: the game server's own address also sends every chat line (`"name<2><STEAM_1:0:5><Survivor>" say "..."`), so a player could type a complete `L4DC SIGNON_DROP steamid=<someone else> ...` into chat and have it admitted by address. The new marker is therefore accepted only as the first thing after the engine's `L MM/DD/YYYY - HH:MM:SS: ` stamp. Every engine line about a player opens with a double quote, so no player-controlled text can sit there.

**What "the player is in game" signals already reach the web.** Two:

- `PUG <token> PLAYER steamid=<id64> event=connect`, emitted by `plugin/pug-match.sp` line 2334 from `OnClientPostAdminCheck` (which SourceMod only calls once the client is fully in game). Token-gated, and only for ROSTERED players during a match, so it never fires for someone joining before a match exists, which is when most drops happen.
- The engine's own line, exactly as `/home/volence/l4d1-ds/server/left4dead/logs/` records it: `"Mal<61><STEAM_1:1:35074132><>" entered the game`. It rides the same permanent `logaddress_add` feed (`log on` is set in the box's `local.cfg`), it fires for everyone in every mode, and until now the parser ignored it. Bots log `<BOT>` where the SteamID goes.

The plan uses both: the engine line is the primary signal, `PLAYER event=connect` is the second chance when that datagram is lost.

**Bot DMs do not exist yet.** `BotTransport` (`src/discord/transport.ts`) has `send(channelId, ...)`, `edit`, `remove` and no way to message a user. `src/discord/djsTransport.ts` is the only file that imports discord.js and is "verified live rather than unit tested"; everything with logic sits behind the interface and is tested against `tests/fakes/fakeTransport.ts`. Task 6 adds one method to all three. Sending a DM is a REST call and needs no new gateway intent.

**The upload validation is in `src/routes/campaigns.ts`, not `src/campaignInstall.ts`.** The spec names `campaignInstall.ts`, but that file only copies an already-accepted VPK to servers. `missionFromVpk(tmp)` is called at `src/routes/campaigns.ts` line 192, inside `POST /api/admin/campaigns`, after the upload has been streamed to a `.upload-<uuid>.part` temp file in the addons directory and before it is renamed into place. That is where the refusal goes. The route's `finally` removes the temp file, but it runs AFTER `reply.send()` has answered, so a test that checks for leftover `.part` files must wait for it.

**The list ships to the box already.** `deploy-web.sh` rsyncs the whole `pug/` tree to `/home/pug/app` minus an explicit exclude list (`node_modules/`, `data/`, `dist/`, `.git`, `.env`, `*.db`, `.superpowers/`, `web/public/overviews/`). `consistency/` is not excluded, the service runs `tsx src/index.ts` from that directory, so `consistency/configs/l4d_consistency.cfg` is present next to `src/` in production exactly as it is in a checkout. No deploy change is needed; Task 10 adds a test that fails if someone later adds an exclude that would drop it.

**An unmerged branch overlaps.** `worktree-cancel-teardown` (11 commits, not yet on `master`) adds `src/steamId.ts` with `steam64ToSteam2`, a `problem` kind to `LogEvent`, and edits `src/server.ts`, `src/db.ts` and `src/logParse.ts` in places near, but not the same as, this plan's. To avoid an add/add conflict on `src/steamId.ts`, this plan puts the inverse conversion in `src/logParse.ts`, where its only caller is. Whoever merges second moves `steamId64Of` into `src/steamId.ts` next to its sibling; nothing else should conflict beyond adjacent-line noise.

## Interpretation decisions

The spec leaves four things open. They are decided here so every task agrees.

1. **"Second drop within ten minutes" for someone who keeps retrying.** The feed posts when a drop brings the steamid's count of drops in the last ten minutes, with no entry since, to two or more, AND no post for that steamid went out in the last ten minutes. So five retries in four minutes is one line, and a further line ten minutes later if they are still at it. An entry clears both the streak and the post limiter.
2. **"First drop" for the DM.** Every drop is eligible; the hourly limit is what makes it the first. The hour is charged BEFORE the send, which is what makes a failed DM "not retried". While the bot is not running nothing is charged.
3. **`count` in the feed message** is the drops in that ten minute window (2 on the first post). The event also carries `total`, every drop on record for the steamid, because "2 times in ten minutes (9 on record)" is a different story from "(2 on record)".
4. **Duplicate datagrams.** UDP may deliver a datagram twice, and a doubled first drop would read as a repeat. A drop for the same steamid within 3 seconds of their last one is discarded. Nobody clicks through the rejection dialog, reconnects and is rejected again in 3 seconds.

Both limiters live in memory in the notifier. A restart forgets them; the cost is one extra DM or one extra line, which does not justify a column the spec's table does not have.

## File Structure

| file | responsibility |
|---|---|
| `consistency/plugin/l4d_consistency.sp`, `.smx` | Emit SteamID64 on the drop line when the client slot is still valid; v0.2.1. |
| `src/logParse.ts` | `steamId64Of`; the `signon_drop` and `entered` events; the stamp-anchored token-less parse. |
| `src/logListener.ts` | Admit the two token-less kinds by source address only. |
| `src/db.ts` | The `signon_drops` table. |
| `src/signonDrops.ts` (new) | Storage only: record a drop (with streak and total), stamp an entry, summarise for the admin page. |
| `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts`, `src/settingsSchema.ts` | The `signon_drop` admin event, its line, its toggle's help text. |
| `src/discord/transport.ts`, `src/discord/djsTransport.ts`, `tests/fakes/fakeTransport.ts` | `dm(userId, payload)`. |
| `src/signonDropNotify.ts` (new) | `SignonDropNotifier`: the ten minute rule, the hourly DM, the DM text. |
| `src/server.ts` | Route the two events to the notifier; pass `consistencyListPath` through. |
| `src/admin/players.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminPlayers.tsx` | The "Connect drops" line and rows. |
| `web/src/routes/HelpConsistency.tsx` (new), `web/src/main.tsx`, `web/src/routes/HowToPlay.tsx` | The static help page, its route, a FAQ entry that links to it. |
| `src/consistencyList.ts` (new) | Load and parse the committed cfg; intersect with a VPK's paths; word the refusal. |
| `src/routes/campaigns.ts` | Refuse a colliding upload. |
| `tests/fixtures/makeVpk.ts` | `makeVpkMulti`: a VPK with several files, which the one-entry `makeVpk` cannot express. |
| `src/campaignCollisions.ts` (new), `scripts/check-campaign-collisions.ts` (new) | Check every VPK already in an addons directory. |
| `consistency/README.md` | Phase 2 usage, generator, `--verify`, the drop line, rollout and rollback. |

---

### Task 1: The plugin emits SteamID64

The v0.2.0 line carries the event's `networkid`, which is `STEAM_1:1:35074132`. The web keys everything on SteamID64. The plugin should send that whenever it can; the parser (Task 2) accepts both, so plugin and web can ship in either order.

There is no SourcePawn test harness in this repo. The deliverable is a clean compile and a committed `.smx`; the behaviour is exercised for real in the README's local rollout step 4.

**Files:**
- Modify: `consistency/plugin/l4d_consistency.sp:8` (version), `:187-198` (comment), `:214-216` (the id)
- Modify: `consistency/plugin/l4d_consistency.smx` (rebuilt, committed: unlike `plugin/*.smx` it is tracked)

**Interfaces:**
- Produces: `L4DC SIGNON_DROP steamid=<17 digit SteamID64, or STEAM_X:Y:Z when the client slot is gone> secs=<int, -1 if unknown> forced=<int> name=<rest of line>`

- [ ] **Step 1: Bump the version**

In `consistency/plugin/l4d_consistency.sp` line 8, find:

```c
#define PLUGIN_VERSION "0.2.0"
```

Replace with:

```c
#define PLUGIN_VERSION "0.2.1"
```

- [ ] **Step 2: Say what the id is, in the comment above `Event_PlayerDisconnect`**

Find:

```c
 *   L4DC SIGNON_DROP steamid=<id> secs=<connected seconds> forced=<count> name=<rest of line>
 *
 * Name is LAST
```

Replace with:

```c
 *   L4DC SIGNON_DROP steamid=<id> secs=<connected seconds> forced=<count> name=<rest of line>
 *
 * <id> is a 17 digit SteamID64 when the client slot is still valid, otherwise the
 * event's networkid (STEAM_1:Y:Z). Name is LAST
```

- [ ] **Step 3: Read the id from the client when the slot is still valid**

`client` is already resolved a few lines above (`int client = GetClientOfUserId(event.GetInt("userid"));`). Find:

```c
	char steamid[64], player[MAX_NAME_LENGTH];
	event.GetString("networkid", steamid, sizeof(steamid));
	event.GetString("name", player, sizeof(player));
```

Replace with:

```c
	// SteamID64, the form the web keys everything on, whenever the slot can
	// still be asked. validate is false on purpose: a client that drops itself
	// during signon has often not finished Steam validation, and an id that is
	// only good enough for a hint is exactly what this line carries. When the
	// slot is already gone, fall back to the event's networkid, which is the
	// STEAM_1:Y:Z form; the web accepts both and converts.
	char steamid[64], player[MAX_NAME_LENGTH];
	if (client <= 0 || !IsClientConnected(client)
		|| !GetClientAuthId(client, AuthId_SteamID64, steamid, sizeof(steamid), false)) {
		event.GetString("networkid", steamid, sizeof(steamid));
	}
	event.GetString("name", player, sizeof(player));
```

Leave the `if (StrEqual(steamid, "BOT"))` check that follows exactly where it is: a bot has no SteamID64, so `GetClientAuthId` returns false for it, the fallback runs, and `networkid` is still `BOT`.

- [ ] **Step 4: Compile**

```bash
cd /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/scripting && ./spcomp /home/volence/l4d/pug/consistency/plugin/l4d_consistency.sp -i /home/volence/l4d/pug/consistency/plugin -o /home/volence/l4d/pug/consistency/plugin/l4d_consistency.smx
```

Expected: the SourcePawn Compiler 1.12 banner, then `Code size`, `Data size`, `Stack/heap size` and `Total requirements` lines, with no `error` and no `warning` line. (Rehearsed on 2026-09-19: code size 9352 bytes.)

- [ ] **Step 5: Commit**

```bash
cd /home/volence/l4d/pug
git add consistency/plugin/l4d_consistency.sp consistency/plugin/l4d_consistency.smx
git commit -m "Send SteamID64 on the signon drop line when the client slot is still valid"
```

Do NOT copy the `.smx` anywhere. Installing it on the local test server is part of the README's rollout, and installing it on Dallas needs the owner's go-ahead.

---

### Task 2: The parser learns the two token-less lines

**Files:**
- Modify: `src/logParse.ts:94-97` (the union), `:134` (new helpers above the doc comment of `parseLogDatagram`), `:141-142` (the dispatch)
- Modify: `src/logListener.ts:33-35` (a type-safe guard; real admission is Task 3)
- Test: `tests/logParseSignon.test.ts` (new)

**Interfaces:**
- Produces: `steamId64Of(raw: string): string | null`
- Produces: two new `LogEvent` members, neither with a `token` field:
  `{ kind: 'signon_drop'; steamid: string; secs: number; forced: number; name: string }` and `{ kind: 'entered'; steamid: string }`. `steamid` is always a SteamID64.
- `parseLogDatagram(buf: Buffer): LogEvent | null` keeps its signature.

- [ ] **Step 1: Write the failing test**

`framed()` is the same helper `tests/logParse.test.ts` uses: the five header bytes srcds puts on a log datagram, then the engine's timestamp.

```ts
// tests/logParseSignon.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram, steamId64Of } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const ID64 = '76561198030413993';
const ID2 = 'STEAM_1:1:35074132';

function framed(body: string): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  const text = Buffer.from(`L 09/19/2026 - 14:23:01: ${body}\n`, 'utf8');
  return Buffer.concat([head, text]);
}

describe('steamId64Of', () => {
  it('passes a SteamID64 through', () => {
    expect(steamId64Of(ID64)).toBe(ID64);
  });

  it('converts the verified live pair', () => {
    // How the Dallas and local logs print this account: 35074132 * 2 + 1.
    expect(steamId64Of(ID2)).toBe(ID64);
  });

  it('handles an even account and any universe digit', () => {
    expect(steamId64Of('STEAM_0:0:1')).toBe('76561197960265730');
  });

  it('is null for anything else', () => {
    for (const bad of ['', 'BOT', 'STEAM_ID_PENDING', '[U:1:70148265]', 'STEAM_1:2:5', '1234', `${ID64}0`]) {
      expect(steamId64Of(bad), bad).toBeNull();
    }
  });
});

describe('parseLogDatagram: L4DC SIGNON_DROP', () => {
  it('parses the line with a SteamID64', () => {
    expect(parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=14 forced=652 name=volence`)))
      .toEqual({ kind: 'signon_drop', steamid: ID64, secs: 14, forced: 652, name: 'volence' });
  });

  it('normalises the STEAM_X:Y:Z form the v0.2.0 plugin sends', () => {
    expect(parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID2} secs=-1 forced=652 name=volence`)))
      .toEqual({ kind: 'signon_drop', steamid: ID64, secs: -1, forced: 652, name: 'volence' });
  });

  it('keeps spaces and = inside the name', () => {
    const ev = parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=Big Bill  x=y`));
    expect(ev).toMatchObject({ kind: 'signon_drop', name: 'Big Bill  x=y' });
  });

  it('does not let a name forge the steamid, secs or forced fields', () => {
    const ev = parseLogDatagram(framed(
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=x steamid=76561198000000009 secs=999 forced=1`,
    ));
    expect(ev).toEqual({
      kind: 'signon_drop', steamid: ID64, secs: 3, forced: 652,
      name: 'x steamid=76561198000000009 secs=999 forced=1',
    });
  });

  it('takes the FIRST name= as the start of the name', () => {
    const ev = parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=a name=b`));
    expect(ev).toMatchObject({ name: 'a name=b' });
  });

  it('rejects a malformed steamid, a missing field, an empty name and forced=0', () => {
    const bad = [
      `L4DC SIGNON_DROP steamid=123 secs=3 forced=652 name=x`,
      `L4DC SIGNON_DROP steamid=BOT secs=3 forced=652 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} forced=652 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=-2 forced=652 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=0 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652`,
      `L4DC SOMETHING_ELSE steamid=${ID64} secs=3 forced=652 name=x`,
    ];
    for (const line of bad) expect(parseLogDatagram(framed(line)), line).toBeNull();
  });

  // The game server's address also sends every chat line, and admission for
  // this marker is by address alone. If the marker were searched for anywhere
  // in the datagram, the way `PUG ` is, anyone on the server could type a drop
  // for any SteamID into chat.
  it('ignores the marker inside a chat line', () => {
    const say = `"griefer<7><STEAM_1:0:5><Survivor>" say "L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=victim"`;
    expect(parseLogDatagram(framed(say))).toBeNull();
  });

  it('ignores the marker inside a player name on an engine line', () => {
    const line = `"L4DC SIGNON_DROP x<7><STEAM_1:0:5><>" connected, address "203.0.113.7:27005"`;
    expect(parseLogDatagram(framed(line))).toBeNull();
  });

  it('parses a bare line with no engine framing at all', () => {
    const ev = parseLogDatagram(Buffer.from(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=x`));
    expect(ev).toMatchObject({ kind: 'signon_drop', steamid: ID64 });
  });

  it('does not fall through to the PUG grammar when the name carries a PUG line', () => {
    const ev = parseLogDatagram(framed(
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=652 name=PUG ${TOKEN} MATCH_END a=9 b=0 winner=a`,
    ));
    expect(ev).toMatchObject({ kind: 'signon_drop', name: `PUG ${TOKEN} MATCH_END a=9 b=0 winner=a` });
  });
});

describe('parseLogDatagram: entered the game', () => {
  it('parses the engine line, exactly as the local server logged it', () => {
    expect(parseLogDatagram(framed(`"Mal<61><${ID2}><>" entered the game`)))
      .toEqual({ kind: 'entered', steamid: ID64 });
  });

  it('ignores a bot', () => {
    expect(parseLogDatagram(framed('"Hunter<17><BOT><>" entered the game'))).toBeNull();
  });

  it('reads the engine\'s own fields when the name carries a fake suffix', () => {
    const line = `"x<9><STEAM_1:0:1><>" entered the game<61><${ID2}><>" entered the game`;
    expect(parseLogDatagram(framed(line))).toEqual({ kind: 'entered', steamid: ID64 });
  });

  it('ignores the phrase inside a chat line', () => {
    const say = `"griefer<7><STEAM_1:0:5><Survivor>" say "x<9><${ID2}><>" entered the game"`;
    expect(parseLogDatagram(framed(say))).toBeNull();
  });

  it('leaves the PUG grammar untouched', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT`))).toEqual({ kind: 'heartbeat', token: TOKEN });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PLAYER steamid=${ID64} event=connect`)))
      .toEqual({ kind: 'player', token: TOKEN, steamid: ID64, event: 'connect' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/logParseSignon.test.ts`
Expected: FAIL. Every `steamId64Of` test dies with `TypeError: steamId64Of is not a function`, and the `SIGNON_DROP` and `entered` tests get `null` where an event was expected. "leaves the PUG grammar untouched" passes already, and must still pass at the end.

- [ ] **Step 3: Add the two kinds to the union**

In `src/logParse.ts`, find the end of the `LogEvent` union (lines 94 to 97):

```ts
      steamid: string; team: 'a' | 'b' | null; message: string;
    };
```

Replace with:

```ts
      steamid: string; team: 'a' | 'b' | null; message: string;
    }
  // The two lines below carry NO token, so neither has a `token` field and
  // neither can pass the listener's token gate. LogListener admits them only
  // from a game server's own address. Both can only ever produce a hint.
  //
  // From l4d_consistency.smx: a human who connected, never entered the game
  // and left by their own hand on a map that forced files. That is what a
  // file-consistency rejection looks like from the server, and also what a
  // cancelled loading screen looks like. `secs` is -1 when the plugin could
  // not read the connection time.
  | { kind: 'signon_drop'; steamid: string; secs: number; forced: number; name: string }
  // The engine's own `"name<uid><STEAM_1:Y:Z><>" entered the game` line.
  | { kind: 'entered'; steamid: string };
```

- [ ] **Step 4: Add the conversion and the token-less parse**

In `src/logParse.ts`, find the doc comment that opens `parseLogDatagram` (line 134):

```ts
/**
 * Decode a raw srcds log UDP datagram into a typed PUG event, or null if it is
```

Insert this immediately ABOVE it (the two lines you found stay, unchanged, right after the inserted block). `kv` and `intOf` are the existing helpers earlier in the file:

```ts
/** The SteamID64 of account 0 in the individual-account universe. */
const STEAM64_BASE = 76561197960265728n;

/**
 * A SteamID in either form the game server writes, as the SteamID64 the rest
 * of the web uses, or null when it is neither.
 *
 * `STEAM_X:Y:Z` is what the engine prints in its own log lines and what the
 * player_disconnect event carries as `networkid`; the account number is
 * Z * 2 + Y. BigInt because the result is past Number.MAX_SAFE_INTEGER.
 */
export function steamId64Of(raw: string): string | null {
  if (/^\d{17}$/.test(raw)) return raw;
  const m = /^STEAM_\d:([01]):(\d{1,10})$/.exec(raw);
  if (!m) return null;
  return String(STEAM64_BASE + BigInt(m[2]) * 2n + BigInt(m[1]));
}

/** The engine's `L MM/DD/YYYY - HH:MM:SS: ` stamp, which opens every log line. */
const LOG_STAMP_RE = /L \d{2}\/\d{2}\/\d{4} - \d{2}:\d{2}:\d{2}: /;

/** Anchored at BOTH ends, and the name is greedy, so the fields read are the
 *  last `<uid><steamid><team>` on the line: the engine's own. A name that
 *  contains a whole fake suffix only ends up inside the name group. A `say`
 *  line cannot match either, because it ends with a closing quote. */
const ENTERED_RE = /^".*<\d+><(STEAM_\d:[01]:\d{1,10})><[^<>"]*>" entered the game$/;

/**
 * The token-less lines: `L4DC SIGNON_DROP ...` from l4d_consistency.smx and the
 * engine's "entered the game". Returns undefined when the line is neither, so
 * the caller carries on to the PUG grammar; null when it is one of ours but
 * malformed.
 *
 * Unlike the PUG path, the marker is NOT searched for anywhere in the datagram.
 * Those lines are protected by a secret token; these are protected only by the
 * sender's address, and the game server's address also sends every chat line
 * (`"name<2><STEAM_1:0:5><Survivor>" say "L4DC SIGNON_DROP steamid=..."`). So
 * the marker must be the first thing after the engine's stamp, which no player
 * controlled text can be: every engine line about a player opens with a quote.
 */
function parseSourcePinned(text: string): LogEvent | null | undefined {
  const stamp = LOG_STAMP_RE.exec(text);
  const body = (stamp ? text.slice(stamp.index + stamp[0].length) : text).split('\n', 1)[0].trimEnd();

  if (body.startsWith('L4DC ')) {
    // Name is last and takes the rest of the line. Every other field is read
    // from the slice BEFORE the first ` name=`, the CHAT treatment, so a name
    // like "x steamid=76561198000000009" cannot overwrite the real steamid.
    const at = body.indexOf(' name=');
    if (at < 0) return null;
    const head = body.slice(0, at).split(/\s+/);
    if (head[1] !== 'SIGNON_DROP') return null;
    const rest = kv(head.slice(2));
    const steamid = steamId64Of(rest.steamid ?? '');
    const secs = intOf(rest.secs);
    const forced = intOf(rest.forced);
    const name = body.slice(at + ' name='.length).trim().slice(0, 64);
    if (!steamid || secs === null || secs < -1 || forced === null || forced < 1 || !name) return null;
    return { kind: 'signon_drop', steamid, secs, forced, name };
  }

  const entered = ENTERED_RE.exec(body);
  if (entered) {
    const steamid = steamId64Of(entered[1]);
    return steamid ? { kind: 'entered', steamid } : null;
  }
  return undefined;
}
```

- [ ] **Step 5: Dispatch to it first**

In `parseLogDatagram` (lines 141 to 142), find:

```ts
  const text = buf.toString('utf8');
  const idx = text.indexOf('PUG ');
```

Replace with:

```ts
  const text = buf.toString('utf8');
  const pinned = parseSourcePinned(text);
  if (pinned !== undefined) return pinned;
  const idx = text.indexOf('PUG ');
```

A line that starts with `L4DC ` never falls through to the `PUG ` search, even when it is malformed, so a name carrying a whole `PUG <token> MATCH_END ...` line stays a name. The last `SIGNON_DROP` test pins that.

- [ ] **Step 6: Keep the listener compiling**

The union now has members without `token`, so `src/logListener.ts` line 35 (`this.tokens.has(ev.token)`) no longer typechecks. Find (lines 33 to 35):

```ts
        const ev = parseLogDatagram(msg);
        if (!ev) return;
        if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address);
```

Replace with:

```ts
        const ev = parseLogDatagram(msg);
        if (!ev) return;
        // Token-less lines have no token to gate on. Dropped until the
        // address-pinned admission for them exists, which is the next commit.
        if (ev.kind === 'signon_drop' || ev.kind === 'entered') return;
        if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address);
```

Dropping is the safe interim: nothing consumes these events yet. `src/server.ts` needs no change to compile, because every `ev.token` it reads is already inside a branch narrowed by `ev.kind`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/logParseSignon.test.ts tests/logParse.test.ts tests/logListener.test.ts`
Expected: PASS, all three files. `tests/logParse.test.ts` and `tests/logListener.test.ts` are unchanged and prove the PUG grammar and both existing gates still behave.

Run: `npm run typecheck`
Expected: no output after the two `tsc` command echoes.

- [ ] **Step 8: Commit**

```bash
git add src/logParse.ts src/logListener.ts tests/logParseSignon.test.ts
git commit -m "Parse the consistency plugin's signon drop line and the engine's entered line"
```

---

### Task 3: Admission by source address

**Files:**
- Modify: `src/logListener.ts:5-15` (doc comment), `:33-43` (the message handler)
- Test: `tests/logListener.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: the `signon_drop` and `entered` kinds from Task 2.
- Produces: `LogListener` delivers those two kinds to `onEvent(ev, source)` if and only if the datagram's source address passes the existing allowlist (`allowMatchCreateFrom` or `allowMatchCreateWhen`). A registered token never admits them. No new public method: the allowlist `src/server.ts` already fills is the one that applies.

- [ ] **Step 1: Write the failing tests**

Append to the END of `tests/logListener.test.ts`. `send`, `listener`, `TOKEN` and the `afterEach` that closes the listener are the file's existing helpers; `send` always sends from `127.0.0.1`, so "not allowed" is expressed the way the existing self-start test does it, by allowing some other address.

```ts
describe('LogListener: token-less lines are admitted by source address alone', () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const DROP = 'L4DC SIGNON_DROP steamid=76561198030413993 secs=14 forced=652 name=volence';
  const ENTERED = '"volence<61><STEAM_1:1:35074132><>" entered the game';

  it('delivers SIGNON_DROP and "entered the game" from an allowed source', async () => {
    const got: Array<{ ev: LogEvent; source: string }> = [];
    listener = new LogListener((ev, source) => got.push({ ev, source }));
    const port = await listener.listen(0, '127.0.0.1');
    listener.allowMatchCreateFrom('127.0.0.1');

    await send(port, DROP);
    await send(port, ENTERED);
    await settle();

    expect(got).toEqual([
      { ev: { kind: 'signon_drop', steamid: '76561198030413993', secs: 14, forced: 652, name: 'volence' }, source: '127.0.0.1' },
      { ev: { kind: 'entered', steamid: '76561198030413993' }, source: '127.0.0.1' },
    ]);
  });

  it('admits them through the per-datagram predicate too', async () => {
    // A game server added to the database after boot is only known to the
    // predicate, never to the fixed set.
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0, '127.0.0.1');
    listener.allowMatchCreateWhen((address) => address === '127.0.0.1');

    await send(port, DROP);
    await settle();

    expect(got.map((e) => e.kind)).toEqual(['signon_drop']);
  });

  it('drops them when no source is allowed', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0, '127.0.0.1');

    await send(port, DROP);
    await send(port, ENTERED);
    await settle();

    expect(got).toEqual([]);
  });

  it('drops them from a source that is not allowed', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0, '127.0.0.1');
    listener.allowMatchCreateFrom('203.0.113.7');

    await send(port, DROP);
    await send(port, ENTERED);
    await settle();

    expect(got).toEqual([]);
  });

  it('a registered token buys a token-less line nothing', async () => {
    // The token gate and the address gate are separate. A live match on the
    // box must not open the address gate for everyone else.
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0, '127.0.0.1');
    listener.register(TOKEN);

    await send(port, DROP);
    await send(port, `PUG ${TOKEN} HEARTBEAT`);
    await settle();

    expect(got.map((e) => e.kind)).toEqual(['heartbeat']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/logListener.test.ts`
Expected: FAIL on the first two new tests (`expected [] to deeply equal [ ... ]`), because Task 2's guard drops these kinds unconditionally. The three "drops" tests already pass, for the wrong reason; they are there to keep passing.

- [ ] **Step 3: Replace the guard with the real gate**

In `src/logListener.ts`, find the handler body as Task 2 left it:

```ts
        const ev = parseLogDatagram(msg);
        if (!ev) return;
        // Token-less lines have no token to gate on. Dropped until the
        // address-pinned admission for them exists, which is the next commit.
        if (ev.kind === 'signon_drop' || ev.kind === 'entered') return;
        if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address);
        // MATCH_CREATE is the first line that can cause database writes, and
        // UDP source addresses are trivially spoofable off-path but not from
        // the open internet against a localhost-only feed. Admission is
        // therefore pinned to the configured game server's address.
        if (SELF_START_KINDS.has(ev.kind)
          && (this.matchCreateSources.has(rinfo.address) || this.matchCreateCheck?.(rinfo.address))) {
          return this.onEvent(ev, rinfo.address);
        }
```

Replace all of it with:

```ts
        const ev = parseLogDatagram(msg);
        if (!ev) return;
        // Both address-pinned paths below ask the same question: is this
        // datagram from a game server we know? UDP source addresses are
        // trivially spoofable off-path but not from the open internet against
        // a feed port the firewall does not open.
        const fromGameServer = (): boolean =>
          this.matchCreateSources.has(rinfo.address) || this.matchCreateCheck?.(rinfo.address) === true;
        // Token-less lines (the consistency plugin's SIGNON_DROP and the
        // engine's "entered the game") have no token to gate on, so the
        // sender's address is the ONLY gate. Checked first and returned from
        // unconditionally: nothing below may ever see an event without a token.
        if (ev.kind === 'signon_drop' || ev.kind === 'entered') {
          if (fromGameServer()) this.onEvent(ev, rinfo.address);
          return;
        }
        if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address);
        // MATCH_CREATE is the first line that can cause database writes.
        // Admission is therefore pinned to the configured game server's address.
        if (SELF_START_KINDS.has(ev.kind) && fromGameServer()) {
          return this.onEvent(ev, rinfo.address);
        }
```

- [ ] **Step 4: Bring the file's doc comment up to date**

At the top of `src/logListener.ts` (lines 5 to 9), find:

```ts
/**
 * Binds a UDP socket for srcds `logaddress` traffic. Datagrams are parsed and,
 * if their token is registered, handed to the callback. Everything else (bad
 * parse, unknown token) is dropped, because the stream is untrusted and lossy by design.
 */
```

Replace with:

```ts
/**
 * Binds a UDP socket for srcds `logaddress` traffic. Datagrams are parsed and,
 * if their token is registered, handed to the callback. Two things may arrive
 * without a registered token, and both are admitted by the sender's address
 * instead: the in-game match-create burst, and the token-less lines
 * (`L4DC SIGNON_DROP`, "entered the game"), which can only ever produce a hint.
 * Everything else is dropped, because the stream is untrusted and lossy by design.
 */
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/logListener.test.ts`
Expected: PASS, 12 tests (7 existing, 5 new).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/logListener.ts tests/logListener.test.ts
git commit -m "Admit token-less log lines only from a game server's address"
```

---

### Task 4: The signon_drops table and its storage module

**Files:**
- Modify: `src/db.ts:470-471` (end of the `SCHEMA` string)
- Modify: `tests/db.test.ts:22` (the table list)
- Create: `src/signonDrops.ts`
- Test: `tests/signonDrops.test.ts` (new)

**Interfaces:**
- Produces:
  - `STREAK_WINDOW_MS: number` (ten minutes)
  - `interface SignonDropInput { steamid: string; name: string; secs: number; forced: number }` (structurally what the `signon_drop` event carries, so the event can be passed straight in)
  - `interface RecordedDrop { id: number; streak: number; total: number }`
  - `recordSignonDrop(db: DB, d: SignonDropInput, now?: Date): RecordedDrop | null` (null means a duplicate datagram; nothing stored)
  - `markEntered(db: DB, steamid: string, now?: Date): number` (rows stamped)
  - `interface SignonDropRow { id: number; name: string; secsConnected: number; forcedCount: number; at: string; enteredAfterAt: string | null }`
  - `signonDropSummary(db: DB, steamid: string, limit?: number): { count: number; lastAt: string | null; rows: SignonDropRow[] }` (rows newest first)

- [ ] **Step 1: Write the failing test**

```ts
// tests/signonDrops.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { markEntered, recordSignonDrop, signonDropSummary } from '../src/signonDrops.js';

const A = '76561198030413993';
const B = '76561198005192652';
const T0 = Date.parse('2026-09-19T20:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const drop = (steamid = A, name = 'volence') => ({ steamid, name, secs: 14, forced: 652 });

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('signon_drops schema', () => {
  it('has exactly the columns the spec names', () => {
    const cols = (db.prepare('PRAGMA table_info(signon_drops)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'steamid', 'name', 'secs_connected', 'forced_count', 'at', 'entered_after_at']);
  });

  it('stores a drop for a steamid that is not a registered player', () => {
    // Most drops happen to people who have never signed in to the site, so
    // steamid must not be a foreign key into players.
    expect(recordSignonDrop(db, drop(), at(0))).toEqual({ id: 1, streak: 1, total: 1 });
    expect(db.prepare('SELECT steamid, name, secs_connected, forced_count, at, entered_after_at FROM signon_drops').get())
      .toEqual({ steamid: A, name: 'volence', secs_connected: 14, forced_count: 652, at: '2026-09-19T20:00:00.000Z', entered_after_at: null });
  });
});

describe('recordSignonDrop: the streak', () => {
  it('counts a second drop inside ten minutes', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), at(9))).toMatchObject({ streak: 2, total: 2 });
  });

  it('does not count a drop older than ten minutes', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), at(11))).toMatchObject({ streak: 1, total: 2 });
  });

  it('starts again after an entry', () => {
    recordSignonDrop(db, drop(), at(0));
    markEntered(db, A, at(1));
    expect(recordSignonDrop(db, drop(), at(2))).toMatchObject({ streak: 1, total: 2 });
  });

  it('keeps each steamid to itself', () => {
    recordSignonDrop(db, drop(A), at(0));
    expect(recordSignonDrop(db, drop(B, 'mayhem'), at(1))).toMatchObject({ streak: 1, total: 1 });
  });

  it('treats the same datagram delivered twice as one drop', () => {
    recordSignonDrop(db, drop(), at(0));
    expect(recordSignonDrop(db, drop(), new Date(T0 + 1_000))).toBeNull();
    expect(signonDropSummary(db, A).count).toBe(1);
  });
});

describe('markEntered', () => {
  it('stamps every open drop of that steamid and nobody else\'s', () => {
    recordSignonDrop(db, drop(A), at(0));
    recordSignonDrop(db, drop(A), at(5));
    recordSignonDrop(db, drop(B, 'mayhem'), at(5));
    expect(markEntered(db, A, at(6))).toBe(2);
    const rows = db.prepare('SELECT steamid, entered_after_at FROM signon_drops ORDER BY id').all();
    expect(rows).toEqual([
      { steamid: A, entered_after_at: '2026-09-19T20:06:00.000Z' },
      { steamid: A, entered_after_at: '2026-09-19T20:06:00.000Z' },
      { steamid: B, entered_after_at: null },
    ]);
  });

  it('never moves a stamp that is already set', () => {
    recordSignonDrop(db, drop(), at(0));
    markEntered(db, A, at(1));
    expect(markEntered(db, A, at(30))).toBe(0);
    expect(signonDropSummary(db, A).rows[0].enteredAfterAt).toBe('2026-09-19T20:01:00.000Z');
  });

  it('is a no-op for someone with no drops, which is nearly every entry', () => {
    expect(markEntered(db, B, at(0))).toBe(0);
  });
});

describe('signonDropSummary', () => {
  it('reports the count, the last time and the rows newest first', () => {
    recordSignonDrop(db, drop(A, 'old name'), at(0));
    recordSignonDrop(db, drop(A, 'new name'), at(20));
    expect(signonDropSummary(db, A)).toEqual({
      count: 2,
      lastAt: '2026-09-19T20:20:00.000Z',
      rows: [
        { id: 2, name: 'new name', secsConnected: 14, forcedCount: 652, at: '2026-09-19T20:20:00.000Z', enteredAfterAt: null },
        { id: 1, name: 'old name', secsConnected: 14, forcedCount: 652, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: null },
      ],
    });
  });

  it('is empty for someone with none', () => {
    expect(signonDropSummary(db, B)).toEqual({ count: 0, lastAt: null, rows: [] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/signonDrops.test.ts`
Expected: FAIL, the whole file, with a module resolution error for `../src/signonDrops.js`.

- [ ] **Step 3: Add the table**

In `src/db.ts`, find the last two lines of the `SCHEMA` template string (lines 470 to 471):

```ts
CREATE INDEX IF NOT EXISTS custom_chapter_map ON custom_campaign_chapters(map);
`;
```

Replace with:

```ts
CREATE INDEX IF NOT EXISTS custom_chapter_map ON custom_campaign_chapters(map);
-- A client that connected, never entered the game and left by its own hand on
-- a map that forced files: the only trace a file-consistency rejection leaves
-- on the server, and also what a cancelled loading screen looks like. A hint,
-- never an accusation. steamid is deliberately NOT a foreign key: most drops
-- happen to people who have never signed in to the site. Timestamps are ISO
-- strings written by the app, so the ten minute rule is testable with a clock.
-- entered_after_at is when the same steamid was next seen in game, which is
-- what separates "came back clean" from "still trying".
CREATE TABLE IF NOT EXISTS signon_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steamid TEXT NOT NULL,
  name TEXT NOT NULL,
  secs_connected INTEGER NOT NULL,
  forced_count INTEGER NOT NULL,
  at TEXT NOT NULL,
  entered_after_at TEXT
);
CREATE INDEX IF NOT EXISTS signon_drops_steamid ON signon_drops(steamid, at);
`;
```

A new table needs nothing in `openDb`: `CREATE TABLE IF NOT EXISTS` runs on every open, so an existing production database gains the table the first time the new code opens it. `ensureColumn` is only for adding a column to a table that already exists.

- [ ] **Step 4: Add the table to the schema test's list**

`tests/db.test.ts` asserts the exact, sorted list of tables. On line 22, find:

```ts
      'rating_history', 'reports', 'seasons', 'servers', 'settings',
```

Replace with:

```ts
      'rating_history', 'reports', 'seasons', 'servers', 'settings', 'signon_drops',
```

- [ ] **Step 5: Write the module**

```ts
// src/signonDrops.ts
import type { DB } from './db.js';

/**
 * Storage for SIGNON_DROP lines: a client that connected, never entered the
 * game and left by its own hand on a map that forced files. See the table's
 * comment in db.ts for why this is a hint and never an accusation.
 */

/** Two drops by one steamid inside this window, with no entry between them,
 *  are what the admin feed calls a repeat. */
export const STREAK_WINDOW_MS = 10 * 60_000;

/** A second row for the same steamid this soon after the last is the same
 *  datagram delivered twice, not a second attempt: nobody clicks through the
 *  rejection dialog, reconnects and gets rejected again in three seconds. */
const DUPLICATE_MS = 3_000;

export interface SignonDropInput { steamid: string; name: string; secs: number; forced: number }

export interface SignonDropRow {
  id: number;
  name: string;
  secsConnected: number;
  forcedCount: number;
  at: string;
  enteredAfterAt: string | null;
}

export interface RecordedDrop {
  id: number;
  /** Drops by this steamid in the last ten minutes with no entry since,
   *  this one included. 1 is a first drop. */
  streak: number;
  /** Every drop on record for this steamid, this one included. */
  total: number;
}

/** Store one drop. Null when it is a duplicate datagram, which stores nothing. */
export function recordSignonDrop(db: DB, d: SignonDropInput, now = new Date()): RecordedDrop | null {
  const iso = now.toISOString();
  const dupSince = new Date(now.getTime() - DUPLICATE_MS).toISOString();
  const dup = db.prepare('SELECT 1 FROM signon_drops WHERE steamid = ? AND at > ? AND at <= ? LIMIT 1')
    .get(d.steamid, dupSince, iso);
  if (dup) return null;

  const id = Number(db.prepare(
    'INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at) VALUES (?, ?, ?, ?, ?)',
  ).run(d.steamid, d.name, d.secs, d.forced, iso).lastInsertRowid);

  const since = new Date(now.getTime() - STREAK_WINDOW_MS).toISOString();
  const { streak } = db.prepare(
    'SELECT COUNT(*) AS streak FROM signon_drops WHERE steamid = ? AND entered_after_at IS NULL AND at > ? AND at <= ?',
  ).get(d.steamid, since, iso) as { streak: number };
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM signon_drops WHERE steamid = ?')
    .get(d.steamid) as { total: number };
  return { id, streak, total };
}

/**
 * The steamid was seen in game. Stamps every drop of theirs that has no entry
 * yet, which also ends the streak: the next drop counts from one again.
 * Returns how many rows were stamped.
 */
export function markEntered(db: DB, steamid: string, now = new Date()): number {
  return db.prepare('UPDATE signon_drops SET entered_after_at = ? WHERE steamid = ? AND entered_after_at IS NULL')
    .run(now.toISOString(), steamid).changes;
}

/** Count, last time and the newest rows, for the admin player page. */
export function signonDropSummary(
  db: DB, steamid: string, limit = 50,
): { count: number; lastAt: string | null; rows: SignonDropRow[] } {
  const { count, lastAt } = db.prepare('SELECT COUNT(*) AS count, MAX(at) AS lastAt FROM signon_drops WHERE steamid = ?')
    .get(steamid) as { count: number; lastAt: string | null };
  const rows = (db.prepare(
    `SELECT id, name, secs_connected, forced_count, at, entered_after_at
     FROM signon_drops WHERE steamid = ? ORDER BY id DESC LIMIT ?`,
  ).all(steamid, limit) as {
    id: number; name: string; secs_connected: number; forced_count: number; at: string; entered_after_at: string | null;
  }[]).map((r) => ({
    id: r.id, name: r.name, secsConnected: r.secs_connected, forcedCount: r.forced_count,
    at: r.at, enteredAfterAt: r.entered_after_at,
  }));
  return { count, lastAt, rows };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/signonDrops.test.ts tests/db.test.ts`
Expected: PASS, both files.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/signonDrops.ts tests/db.test.ts tests/signonDrops.test.ts
git commit -m "Store signon drops, with the ten minute streak and the entry that ends it"
```

---

### Task 5: The admin feed kind

**Files:**
- Modify: `src/adminFeed.ts:17` (the union), `:26` (the toggle map)
- Modify: `src/discord/adminFeedPoster.ts:130-135` (the `line` switch)
- Modify: `src/settingsSchema.ts:52` (help text)
- Test: `tests/discordAdminFeed.test.ts` (three new `it`s)

**Interfaces:**
- Produces: `AdminEvent` member `{ kind: 'signon_drop'; steamid: string; name: string; count: number; total: number }`, mapped to the existing `admin_feed_problems` setting in `FEED_SETTING`. `publishAdminEvent` and `subscribeAdminEvents` are unchanged.

- [ ] **Step 1: Write the failing tests**

In `tests/discordAdminFeed.test.ts`, inside `describe('admin feed', ...)`, insert these three tests immediately ABOVE the existing `it('a secret setting change never shows its value', ...)`. `db`, `t`, `feed`, `IDS` and `setSetting` are already in scope in that file; `IDS[4]` is a registered player named `player4`.

```ts
  it('a repeated connect drop posts one line: name, steamid, count and the wording', async () => {
    // Not one of IDS: most dropped steamids have never signed in to the site.
    const stranger = '76561198005192652';
    publishAdminEvent({ kind: 'signon_drop', steamid: stranger, name: 'may*hem', count: 2, total: 5 });
    await feed.idle();
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].channelId).toBe('admins');
    const line = t.live()[0].payload.embeds[0].description ?? '';
    // The in-game name, markdown-escaped: it is attacker-controlled text.
    expect(line).toContain('**may\\*hem**');
    expect(line).toContain(`\`${stranger}\``);
    expect(line).toContain('2 times in ten minutes');
    expect(line).toContain('5 on record');
    expect(line).toContain('likely rejected for a modified game file; the file name was shown on their screen');
    expect(line).not.toContain('/player/');
  });

  it('a connect drop by a known player links the steamid to their profile', async () => {
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'in game name', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()[0].payload.embeds[0].description).toContain(`[${IDS[4]}](https://pug.test/player/${IDS[4]})`);
  });

  it('connect drops ride the problems toggle', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'x', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/discordAdminFeed.test.ts`
Expected: FAIL. At runtime the first two get `expected [] to have a length of 1` (the poster has no channel mapping for the unknown kind and posts nothing); `npm run typecheck` would also reject the object literals, because `signon_drop` is not yet in `AdminEvent`.

- [ ] **Step 3: Add the kind and its toggle**

In `src/adminFeed.ts` line 17, find:

```ts
  | { kind: 'abandon'; steamid: string; matchId: number; minutes: number };
```

Replace with:

```ts
  | { kind: 'abandon'; steamid: string; matchId: number; minutes: number }
  // A steamid dropped while connecting for the second time in ten minutes
  // without getting in between. `name` is the in-game name off the drop line,
  // because the steamid is often nobody the site knows. `count` is the drops in
  // that window, `total` every drop on record.
  | { kind: 'signon_drop'; steamid: string; name: string; count: number; total: number };
```

In the same file, find (line 26):

```ts
  abandon: 'admin_feed_penalties',
};
```

Replace with:

```ts
  abandon: 'admin_feed_penalties',
  signon_drop: 'admin_feed_problems',
};
```

`FEED_SETTING` is typed `Record<AdminEvent['kind'], string>`, so forgetting this second edit is a compile error, not a silent miss.

- [ ] **Step 4: Word the line**

In `src/discord/adminFeedPoster.ts`, the `line` method's switch ends with the `abandon` case (lines 130 to 135). Find:

```ts
          color: COLOR.problem,
        };
    }
  }
```

Replace with:

```ts
          color: COLOR.problem,
        };
      case 'signon_drop': {
        // The in-game name, not this.name(): most of these steamids have never
        // signed in, and an admin searching the server log needs the name the
        // player was actually using.
        const known = getPlayer(this.deps.db, e.steamid);
        const id = known ? `[${e.steamid}](${this.deps.publicUrl}/player/${e.steamid})` : `\`${e.steamid}\``;
        return {
          text: `**${escapeName(e.name)}** (${id}) dropped while connecting ${e.count} times in ten minutes without getting in (${e.total} on record): likely rejected for a modified game file; the file name was shown on their screen. A cancelled loading screen looks the same, so this is a hint, not proof.`,
          color: COLOR.problem,
        };
      }
    }
  }
```

`getPlayer` and `escapeName` are already imported at the top of that file. The switch is exhaustive over the union, so until this case exists `tsc` reports that `line` lacks a return.

- [ ] **Step 5: Tell admins what the toggle now covers**

In `src/settingsSchema.ts` line 52, find:

```ts
help: 'Matches aborted by the reapers, lost results, voice channel failures.'
```

Replace with:

```ts
help: 'Matches aborted by the reapers, lost results, voice channel failures, and a player dropped twice while connecting (likely a modified game file).'
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/adminSettings.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/adminFeed.ts src/discord/adminFeedPoster.ts src/settingsSchema.ts tests/discordAdminFeed.test.ts
git commit -m "Give the admin feed a line for a repeated connect drop"
```

---

### Task 6: The notifier, and a way for the bot to DM

**Files:**
- Modify: `src/discord/transport.ts:113` (the interface)
- Modify: `src/discord/djsTransport.ts:226-227` (the implementation)
- Modify: `tests/fakes/fakeTransport.ts:46-47` (the fake)
- Create: `src/signonDropNotify.ts`
- Test: `tests/signonDropNotify.test.ts` (new)

**Interfaces:**
- Consumes: `recordSignonDrop`, `markEntered`, `STREAK_WINDOW_MS`, `SignonDropInput` (Task 4); `publishAdminEvent` with the `signon_drop` kind (Task 5); `getPlayer(db, steamid)?.discord_id` from `src/players.ts`.
- Produces:
  - `BotTransport.dm(userId: string, payload: MessagePayload): Promise<void>`, rejecting when Discord refuses.
  - `FakeTransport.dms: { userId: string; payload: MessagePayload }[]` and `FakeTransport.dmsClosed: Set<string>`.
  - `CONSISTENCY_HELP_PATH = '/help/consistency'`
  - `type DmFn = (discordUserId: string, payload: MessagePayload) => Promise<void>`
  - `signonDropDm(helpUrl: string): MessagePayload`
  - `class SignonDropNotifier { constructor(deps: { db: DB; publicUrl: string; dm: () => DmFn | null }); onDrop(d: SignonDropInput, now?: Date): Promise<void>; onEntered(steamid: string, now?: Date): void }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/signonDropNotify.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { SignonDropNotifier, CONSISTENCY_HELP_PATH } from '../src/signonDropNotify.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const LINKED = '76561198030413993';
const STRANGER = '76561198005192652';
const T0 = Date.parse('2026-09-19T20:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const drop = (steamid: string, name = 'volence') => ({ steamid, name, secs: 14, forced: 652 });

let db: DB;
let t: FakeTransport;
let notifier: SignonDropNotifier;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: LINKED, name: 'volence', avatar: null }, []);
  activatePlayer(db, LINKED);
  linkDiscord(db, LINKED, '900', 'volence_d');
  t = new FakeTransport();
  notifier = new SignonDropNotifier({ db, publicUrl: 'https://pug.test', dm: () => (id, p) => t.dm(id, p) });
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { off(); vi.restoreAllMocks(); });

describe('SignonDropNotifier: the admin feed', () => {
  it('stores the first drop and posts nothing', async () => {
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(0));
    expect(events).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signon_drops').get()).toEqual({ n: 1 });
  });

  it('posts on the second drop inside ten minutes, with the count and the total', async () => {
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(0));
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(4));
    expect(events).toEqual([{ kind: 'signon_drop', steamid: STRANGER, name: 'mayhem', count: 2, total: 2 }]);
  });

  it('posts nothing when the second drop is more than ten minutes later', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), at(11));
    expect(events).toEqual([]);
  });

  it('posts nothing when the player got in between the two drops', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    notifier.onEntered(STRANGER, at(2));
    await notifier.onDrop(drop(STRANGER), at(4));
    expect(events).toEqual([]);
  });

  it('posts once per ten minutes for someone who keeps retrying', async () => {
    for (const m of [0, 1, 2, 3, 9]) await notifier.onDrop(drop(STRANGER), at(m));
    expect(events.map((e) => (e as { count: number }).count)).toEqual([2]);
    await notifier.onDrop(drop(STRANGER), at(12));
    expect(events.map((e) => (e as { count: number }).count)).toEqual([2, 3]);
  });

  it('posts again at once for a fresh streak after the player got in', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), at(1));
    notifier.onEntered(STRANGER, at(2));
    await notifier.onDrop(drop(STRANGER), at(3));
    await notifier.onDrop(drop(STRANGER), at(4));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ count: 2, total: 4 });
  });

  it('ignores a duplicated datagram entirely', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), new Date(T0 + 500));
    expect(events).toEqual([]);
  });
});

describe('SignonDropNotifier: the player DM', () => {
  it('DMs a linked player on the first drop, with the help page link', async () => {
    await notifier.onDrop(drop(LINKED), at(0));
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0].userId).toBe('900');
    expect(t.dms[0].payload.content).toContain(`https://pug.test${CONSISTENCY_HELP_PATH}`);
    expect(t.dms[0].payload.content).toMatch(/modified game file/);
    expect(t.dms[0].payload.components.flat()).toEqual([
      { kind: 'link', url: `https://pug.test${CONSISTENCY_HELP_PATH}`, label: 'How to fix it' },
    ]);
  });

  it('never DMs someone with no linked Discord account', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    expect(t.dms).toEqual([]);
  });

  it('sends at most one DM per steamid per hour', async () => {
    await notifier.onDrop(drop(LINKED), at(0));
    await notifier.onDrop(drop(LINKED), at(5));
    await notifier.onDrop(drop(LINKED), at(59));
    expect(t.dms).toHaveLength(1);
    await notifier.onDrop(drop(LINKED), at(61));
    expect(t.dms).toHaveLength(2);
  });

  it('logs a failed DM, does not throw, and does not retry inside the hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.dmsClosed.add('900');
    await expect(notifier.onDrop(drop(LINKED), at(0))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(LINKED);

    t.dmsClosed.clear();
    await notifier.onDrop(drop(LINKED), at(5));
    expect(t.dms).toEqual([]);
  });

  it('skips the DM without charging the hour while the bot is not running', async () => {
    let up = false;
    const n = new SignonDropNotifier({ db, publicUrl: 'https://pug.test', dm: () => (up ? (id, p) => t.dm(id, p) : null) });
    await n.onDrop(drop(LINKED), at(0));
    expect(t.dms).toEqual([]);
    up = true;
    await n.onDrop(drop(LINKED), at(5));
    expect(t.dms).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/signonDropNotify.test.ts`
Expected: FAIL, the whole file, with a module resolution error for `../src/signonDropNotify.js`.

- [ ] **Step 3: Add `dm` to the transport interface**

In `src/discord/transport.ts`, inside `interface BotTransport`, find:

```ts
  remove(channelId: string, messageId: string): Promise<void>;
  onInteraction
```

Replace with:

```ts
  remove(channelId: string, messageId: string): Promise<void>;
  /** A direct message to one user. Rejects when Discord refuses it, which is
   *  ordinary: the user has DMs from server members closed, or has left the
   *  guild and shares no server with the bot. Callers decide what that means. */
  dm(userId: string, payload: MessagePayload): Promise<void>;
  onInteraction
```

- [ ] **Step 4: Implement it in the real transport**

In `src/discord/djsTransport.ts`, in the object returned at the bottom of `createDjsTransport`, find:

```ts
    onInteraction(h) {
      handler = h;
    },
```

Replace with:

```ts
    async dm(userId, payload) {
      // No extra gateway intent: sending a DM is a REST call. users.fetch
      // resolves anyone by id; send() is what fails for closed DMs (50007).
      const user = await client.users.fetch(userId);
      const m = toMessage(payload);
      await user.send({
        content: m.content || undefined, embeds: m.embeds, components: m.components as never,
        allowedMentions: m.allowedMentions,
      });
    },
    onInteraction(h) {
      handler = h;
    },
```

The `components: m.components as never` cast is the one the file's own `i.reply(...)` call already uses for the same `toMessage` output. This file has no unit test by design (its header says so); it is covered by `npm run typecheck` here and by a real DM the first time the feature runs against Discord.

- [ ] **Step 5: Implement it in the fake**

In `tests/fakes/fakeTransport.ts`, find:

```ts
  async remove(_channelId: string, messageId: string): Promise<void> {
```

Insert this immediately ABOVE it:

```ts
  /** Direct messages, in order. */
  dms: { userId: string; payload: MessagePayload }[] = [];
  /** User ids whose DMs are closed: dm() rejects for them, as Discord does. */
  dmsClosed = new Set<string>();

  async dm(userId: string, payload: MessagePayload): Promise<void> {
    if (this.dmsClosed.has(userId)) throw new Error('Cannot send messages to this user');
    this.dms.push({ userId, payload });
  }
```

- [ ] **Step 6: Write the notifier**

```ts
// src/signonDropNotify.ts
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getPlayer } from './players.js';
import { markEntered, recordSignonDrop, STREAK_WINDOW_MS, type SignonDropInput } from './signonDrops.js';
import type { MessagePayload } from './discord/transport.js';

/** Where the DM and the help link point. A page on the Preact site. */
export const CONSISTENCY_HELP_PATH = '/help/consistency';

/** At most one DM per steamid in this long. */
const DM_EVERY_MS = 60 * 60_000;

export type DmFn = (discordUserId: string, payload: MessagePayload) => Promise<void>;

export function signonDropDm(helpUrl: string): MessagePayload {
  return {
    content: [
      'The Riverside L4D server dropped your connection while you were loading in.',
      'That usually means it rejected a modified game file. The server checks a list of game files (special infected models and skins, trees and plants, weapon and infected sounds, smoke and bile effects), and your game showed a dialog naming the one that did not match:',
      '> Server is enforcing consistency for this file: ...',
      `Remove the addon that changes that file, or verify your game files in Steam, then connect again. Step by step: ${helpUrl}`,
      'If you only cancelled the loading screen, ignore this message.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url: helpUrl, label: 'How to fix it' }]],
    mentionUserIds: [],
  };
}

/**
 * What the web does about a SIGNON_DROP line, beyond storing it.
 *
 * - The player is told at once, on the FIRST drop: they already have the file
 *   name on their screen and lack only the explanation. At most one DM per
 *   steamid per hour, and the hour is charged BEFORE the send, so a DM that
 *   fails (closed DMs, not in the guild) is logged and never retried.
 * - Admins are told only when it repeats: the second drop inside ten minutes
 *   with no entry between. One cancelled loading screen posts nothing. At most
 *   one post per steamid per ten minutes, so someone retrying over and over is
 *   one line and then another ten minutes later, not a line per attempt.
 *
 * Both limiters are in memory. A restart forgets them, and the cost of that is
 * one extra DM or one extra line, which is not worth a column.
 */
export class SignonDropNotifier {
  private lastDm = new Map<string, number>();
  private lastPost = new Map<string, number>();

  constructor(private deps: {
    db: DB;
    publicUrl: string;
    /** The bot's DM call, or null while the bot is not running. Read per drop,
     *  because the bot connects some seconds after the listener starts. */
    dm: () => DmFn | null;
  }) {}

  /** Resolves once the DM, if any, has been sent or has failed. Never rejects. */
  async onDrop(d: SignonDropInput, now = new Date()): Promise<void> {
    const rec = recordSignonDrop(this.deps.db, d, now);
    if (!rec) return;

    const posted = this.lastPost.get(d.steamid);
    if (rec.streak >= 2 && (posted === undefined || now.getTime() - posted >= STREAK_WINDOW_MS)) {
      this.lastPost.set(d.steamid, now.getTime());
      publishAdminEvent({ kind: 'signon_drop', steamid: d.steamid, name: d.name, count: rec.streak, total: rec.total });
    }

    const discordId = getPlayer(this.deps.db, d.steamid)?.discord_id;
    const dm = this.deps.dm();
    if (!discordId || !dm) return;
    const sent = this.lastDm.get(d.steamid);
    if (sent !== undefined && now.getTime() - sent < DM_EVERY_MS) return;
    this.lastDm.set(d.steamid, now.getTime());
    try {
      await dm(discordId, signonDropDm(`${this.deps.publicUrl}${CONSISTENCY_HELP_PATH}`));
    } catch (err) {
      console.warn(`[consistency] could not DM ${d.steamid} about a connect drop, not retrying:`, err);
    }
  }

  /** The steamid was seen in game: close their open drops and their streak. */
  onEntered(steamid: string, now = new Date()): void {
    if (markEntered(this.deps.db, steamid, now) > 0) this.lastPost.delete(steamid);
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/signonDropNotify.test.ts tests/discordBot.test.ts tests/discordSync.test.ts`
Expected: PASS. The two existing Discord suites are there to prove the fake still satisfies `BotTransport`.

Run: `npm run typecheck`
Expected: clean. This is the only check `djsTransport.ts` gets.

- [ ] **Step 8: Commit**

```bash
git add src/discord/transport.ts src/discord/djsTransport.ts tests/fakes/fakeTransport.ts src/signonDropNotify.ts tests/signonDropNotify.test.ts
git commit -m "DM a dropped player once an hour and tell admins when it repeats"
```

---

### Task 7: Wire the events into the server

**Files:**
- Modify: `src/server.ts:46` (import), `:332` (forward reference), `:340-341` (the two handlers), `:399-401` (`PLAYER connect`), `:655` (construction)
- Test: `tests/signonDropWiring.test.ts` (new)

**Interfaces:**
- Consumes: `SignonDropNotifier` (Task 6); `LogListener` admission (Task 3); `RunningBot.transport.dm` (Task 6).
- Produces: nothing new for later tasks. After this task a real datagram on the log port becomes a row.

- [ ] **Step 1: Write the failing test**

This drives the real UDP socket through `buildServer`, the way `tests/liveView.test.ts` ("re-registers in-flight match tokens") does: `devMode: false` with no injected orchestrator is what builds the listener.

```ts
// tests/signonDropWiring.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const ID64 = '76561198030413993';
const DROP = `L4DC SIGNON_DROP steamid=STEAM_1:1:35074132 secs=14 forced=652 name=volence`;
const ENTERED = '"volence<61><STEAM_1:1:35074132><>" entered the game';

/** buildServer does not hand back the port its listener bound, so pick a free
 *  one first. The gap between closing this socket and the listener binding the
 *  same port is a race only against other processes on the machine. */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 09/19/2026 - 14:23:01: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));
const rows = (db: DB) => db.prepare('SELECT steamid, name, secs_connected, forced_count, entered_after_at FROM signon_drops').all();

let db: DB;
let app: FastifyInstance | null = null;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(async () => { await app?.close(); app = null; });

describe('signon drops, from the UDP socket to the table', () => {
  it('stores a drop sent from the game server\'s address, and stamps it on entry', async () => {
    const port = await freeUdpPort();
    // devMode:false is what builds the real listener. The default
    // LOG_PUBLIC_ADDRESS is 127.0.0.1:27500, and its host half is an allowed
    // source, which is exactly the one-box production shape.
    app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });

    await send(port, DROP);
    await settle();
    expect(rows(db)).toEqual([
      { steamid: ID64, name: 'volence', secs_connected: 14, forced_count: 652, entered_after_at: null },
    ]);

    await send(port, ENTERED);
    await settle();
    expect((rows(db)[0] as { entered_after_at: string | null }).entered_after_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('stores nothing when the sender is not a known game server', async () => {
    const port = await freeUdpPort();
    // The feed host is somewhere else and there is no servers row, so
    // 127.0.0.1 (where this test sends from) is nobody.
    app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: port, logPublicAddress: '203.0.113.9:27500' },
      db,
    });

    await send(port, DROP);
    await settle();
    expect(rows(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/signonDropWiring.test.ts`
Expected: FAIL on the first test with `expected [] to deeply equal [ { steamid: '76561198030413993', ... } ]`: the listener admits the event, and `server.ts` falls through its final `else return;` without storing anything. The second test passes already and must keep passing.

- [ ] **Step 3: Import the notifier**

In `src/server.ts` line 46, find:

```ts
import { SelfStartedMatches } from './selfStarted.js';
```

Replace with:

```ts
import { SelfStartedMatches } from './selfStarted.js';
import { SignonDropNotifier } from './signonDropNotify.js';
```

- [ ] **Step 4: Declare the forward reference**

Find (line 332):

```ts
  let logListener: LogListener | null = null;
  if (!orchestrator) {
```

Replace with:

```ts
  let logListener: LogListener | null = null;
  // Assigned further down, once the bot variable it reads exists: the same
  // forward reference selfStarted uses, null-safe for the same reason.
  let signonDrops: SignonDropNotifier | null = null;
  if (!orchestrator) {
```

- [ ] **Step 5: Handle the two token-less kinds first**

Find (lines 340 to 341):

```ts
      logListener = new LogListener((ev, source) => {
        if (ev.kind === 'match_end') {
```

Replace with:

```ts
      logListener = new LogListener((ev, source) => {
        // The two token-less kinds. LogListener has already pinned them to a
        // game server's address. Handled first so nothing below is ever
        // asked for a token they do not have, and guarded so a database error
        // cannot take down the listener that also carries match_end.
        if (ev.kind === 'signon_drop') {
          signonDrops?.onDrop(ev).catch((err) => console.error('[consistency] failed to record a connect drop:', err));
          return;
        }
        if (ev.kind === 'entered') {
          try {
            signonDrops?.onEntered(ev.steamid);
          } catch (err) {
            console.error('[consistency] failed to record an entry:', err);
          }
          return;
        }
        if (ev.kind === 'match_end') {
```

The `signon_drop` event is passed to `onDrop` as it is: it has `steamid`, `name`, `secs` and `forced`, which is all `SignonDropInput` asks for.

- [ ] **Step 6: Count `PLAYER event=connect` as an entry too**

Find (lines 399 to 401):

```ts
          else if (ev.kind === 'player' && ev.event === 'connect') {
            recordPlayerConnect(deps.db, ev.token, ev.steamid);
          }
```

Replace with:

```ts
          else if (ev.kind === 'player' && ev.event === 'connect') {
            recordPlayerConnect(deps.db, ev.token, ev.steamid);
            // The plugin emits this from OnClientPostAdminCheck, which only
            // fires once the client is fully in game, so it is an entry too.
            // The engine's own "entered the game" line normally gets here
            // first; this is the second chance when that datagram was lost.
            signonDrops?.onEntered(ev.steamid);
          }
```

This sits inside the existing `try` whose `catch` logs `[live] failed to record`, so it needs no guard of its own.

- [ ] **Step 7: Construct it where `bot` exists**

Find (line 655):

```ts
  let adminFeed: AdminFeedPoster | null = null;
```

Replace with:

```ts
  let adminFeed: AdminFeedPoster | null = null;
  // Only where a real listener exists to feed it. `bot` is read per drop,
  // because the bot logs in some seconds after this line runs, and stays null
  // for good when Discord is not configured: drops are then stored and shown
  // to admins on the site, and nobody is DMed.
  if (logListener) {
    signonDrops = new SignonDropNotifier({
      db: deps.db,
      publicUrl: deps.config.publicUrl,
      dm: () => {
        const transport = bot?.transport;
        return transport ? (userId, payload) => transport.dm(userId, payload) : null;
      },
    });
  }
```

Nothing between `await logListener.listen(...)` (line 443) and this point awaits, so no datagram can reach the callback while `signonDrops` is still null. If a later edit puts an `await` in that stretch, the `?.` calls turn the gap into a dropped hint rather than a crash.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/signonDropWiring.test.ts tests/liveView.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/signonDropWiring.test.ts
git commit -m "Route signon drops and entries from the log listener to the notifier"
```

---

### Task 8: The admin player page

The spec asks for "a connect drops line with count and last time, linking to the rows". The admin player page is one panel (`PlayerDetail` in `AdminPlayers.tsx`) whose sections are inline lists, so the line goes in the header block and links to a "Connect drops" section further down the same panel, by fragment.

The admin player API only answers for registered players (`playerDetail` returns null without a `players` row, and the route 404s). A drop by a steamid the site has never seen is still stored and still reaches the admin feed with the steamid in it; it simply has no player page to appear on until that person signs in.

**Files:**
- Modify: `src/admin/players.ts:5` (import), `:143` (the detail object)
- Modify: `web/src/api.ts:486-487` (`AdminPlayerDetail`)
- Modify: `web/src/routes/admin/AdminPlayers.tsx:71-72` (the line), `:156-157` (the section)
- Test: `tests/adminPlayers.test.ts` (one new `it`), `web/src/routes/admin.test.tsx` (one fixed mock, two new `it`s)

**Interfaces:**
- Consumes: `signonDropSummary(db, steamid)` (Task 4).
- Produces: `GET /api/admin/players/:steamid` gains `signonDrops: { count: number; lastAt: string | null; rows: { id: number; name: string; secsConnected: number; forcedCount: number; at: string; enteredAfterAt: string | null }[] }`.

- [ ] **Step 1: Write the failing API test**

In `tests/adminPlayers.test.ts`, add to the imports, directly above the `./helpers.js` import:

```ts
import { recordSignonDrop, markEntered } from '../src/signonDrops.js';
```

Then, inside `describe('admin players', ...)`, insert this test immediately ABOVE `it('activate does not unban', ...)`. `P2` and `P3` are registered players in that file's `beforeEach`.

```ts
  it('reports connect drops with the count, the last time and the rows', async () => {
    const empty = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(empty.signonDrops).toEqual({ count: 0, lastAt: null, rows: [] });

    recordSignonDrop(db, { steamid: P2, name: 'p002 in game', secs: 12, forced: 652 }, new Date('2026-09-19T20:00:00.000Z'));
    markEntered(db, P2, new Date('2026-09-19T20:03:00.000Z'));
    recordSignonDrop(db, { steamid: P2, name: 'p002 in game', secs: -1, forced: 652 }, new Date('2026-09-19T21:00:00.000Z'));
    recordSignonDrop(db, { steamid: P3, name: 'someone else', secs: 5, forced: 652 }, new Date('2026-09-19T21:30:00.000Z'));

    const detail = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(detail.signonDrops.count).toBe(2);
    expect(detail.signonDrops.lastAt).toBe('2026-09-19T21:00:00.000Z');
    expect(detail.signonDrops.rows).toEqual([
      { id: 2, name: 'p002 in game', secsConnected: -1, forcedCount: 652, at: '2026-09-19T21:00:00.000Z', enteredAfterAt: null },
      { id: 1, name: 'p002 in game', secsConnected: 12, forcedCount: 652, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: '2026-09-19T20:03:00.000Z' },
    ]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/adminPlayers.test.ts`
Expected: FAIL on the new test: `expected undefined to deeply equal { count: 0, lastAt: null, rows: [] }`.

- [ ] **Step 3: Add the summary to the detail**

In `src/admin/players.ts` line 5, find:

```ts
import { listReports } from '../reports.js';
```

Replace with:

```ts
import { listReports } from '../reports.js';
import { signonDropSummary } from '../signonDrops.js';
```

In `playerDetail` (line 143), find:

```ts
    reportsAgainst: listReports(db, 'all').filter((r) => r.targetId === steamid),
```

Replace with:

```ts
    reportsAgainst: listReports(db, 'all').filter((r) => r.targetId === steamid),
    // Connects that ended before the player was in game, on a map that forced
    // files: likely a consistency rejection, possibly a cancelled load.
    signonDrops: signonDropSummary(db, steamid),
```

- [ ] **Step 4: Run the API test**

Run: `npx vitest run tests/adminPlayers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests**

In `web/src/routes/admin.test.tsx`, the existing test `'lists players, opens a detail and bans with a reason'` mocks a player detail without the new field, and the component will now read it. Find, in that test:

```tsx
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
    });
    mockAdmin.ban.mockResolvedValue({ ok: true });
```

Replace with:

```tsx
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
      signonDrops: { count: 0, lastAt: null, rows: [] },
    });
    mockAdmin.ban.mockResolvedValue({ ok: true });
```

Then, inside `describe('Admin page', ...)`, insert these two tests immediately ABOVE `it('settings tab shows grouped settings', ...)`. `me`, `mockAdmin`, `within` and the rest are already in scope.

```tsx
  it('shows a connect drops line that links to the rows', async () => {
    const row = { steamid: '2', name: 'skinner', avatar: null, status: 'active', isAdmin: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 0 };
    mockAdmin.players.mockResolvedValue({ players: [row] });
    mockAdmin.player.mockResolvedValue({
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
      signonDrops: {
        count: 2, lastAt: '2026-09-19T21:00:00.000Z',
        rows: [
          { id: 2, name: 'skinner', secsConnected: -1, forcedCount: 652, at: '2026-09-19T21:00:00.000Z', enteredAfterAt: null },
          { id: 1, name: 'skinner', secsConnected: 12, forcedCount: 652, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: '2026-09-19T20:03:00.000Z' },
        ],
      },
    });
    render(<Admin session={{ kind: 'active', me }} />);
    await waitFor(() => expect(screen.getByText('skinner')).toBeTruthy());
    fireEvent.click(screen.getByText('skinner'));

    const link = await waitFor(() => screen.getByRole('link', { name: /^2, last / }));
    expect(link.getAttribute('href')).toBe('#connect-drops');
    const section = document.getElementById('connect-drops')!;
    expect(section).toBeTruthy();
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('time unknown');
    expect(items[0].textContent).toContain('has not got in since');
    expect(items[1].textContent).toContain('after 12 s');
    expect(items[1].textContent).toContain('got in');
    expect(within(section).getByRole('link', { name: 'What players are told' }).getAttribute('href')).toBe('/help/consistency');
  });

  it('says none, with no section, for a player with no connect drops', async () => {
    const row = { steamid: '2', name: 'clean', avatar: null, status: 'active', isAdmin: false, discordName: null, sr: 900, games: 4, createdAt: '2026-09-01', offenses: 0 };
    mockAdmin.players.mockResolvedValue({ players: [row] });
    mockAdmin.player.mockResolvedValue({
      ...row, discordId: null, activeBan: null, bans: [], notes: [], matches: [], penalties: [], timeout: null, reportsAgainst: [],
      signonDrops: { count: 0, lastAt: null, rows: [] },
    });
    render(<Admin session={{ kind: 'active', me }} />);
    await waitFor(() => expect(screen.getByText('clean')).toBeTruthy());
    fireEvent.click(screen.getByText('clean'));
    await waitFor(() => expect(screen.getByText(/Connect drops: none/)).toBeTruthy());
    expect(document.getElementById('connect-drops')).toBeNull();
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: FAIL on the two new tests (no link named `2, last ...`; no text `Connect drops: none`). The ban test still passes.

- [ ] **Step 7: Type the field**

In `web/src/api.ts`, at the end of `interface AdminPlayerDetail` (lines 486 to 487), find:

```ts
  reportsAgainst: AdminReport[];
}
```

Replace with:

```ts
  reportsAgainst: AdminReport[];
  /** Connects that ended before the player was in game, on a map that forced
   *  files. Likely a file-consistency rejection; a cancelled loading screen
   *  looks identical. `enteredAfterAt` is when they next got in, null if never. */
  signonDrops: {
    count: number;
    lastAt: string | null;
    rows: { id: number; name: string; secsConnected: number; forcedCount: number; at: string; enteredAfterAt: string | null }[];
  };
}
```

- [ ] **Step 8: Render the line and the rows**

In `web/src/routes/admin/AdminPlayers.tsx`, in the header block of `PlayerDetail` (lines 71 to 72), find:

```tsx
            <br />Discord: {d.discordName ?? 'not linked'}
          </p>
```

Replace with:

```tsx
            <br />Discord: {d.discordName ?? 'not linked'}
            <br />Connect drops:{' '}
            {d.signonDrops.count === 0 ? 'none' : (
              <a href="#connect-drops" class="admin-warn">
                {d.signonDrops.count}, last {fmtTime(d.signonDrops.lastAt)}
              </a>
            )}
          </p>
```

Then find the opening of the Notes section (lines 157 to 158):

```tsx
      <section>
        <h4>Notes</h4>
```

Replace with:

```tsx
      {d.signonDrops.count > 0 && (
        <section id="connect-drops">
          <h4>Connect drops</h4>
          <p class="muted">
            Left while still loading in, on a map that was enforcing file consistency. Usually a rejected
            modified file (the player saw its name on their screen; the server never does), sometimes
            just a cancelled loading screen. <a href="/help/consistency">What players are told</a>.
          </p>
          <ul class="admin-list">
            {d.signonDrops.rows.map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)}: as {r.name}, {r.secsConnected < 0 ? 'time unknown' : `after ${r.secsConnected} s`}, {r.forcedCount} files enforced
                {r.enteredAfterAt
                  ? <span class="muted"> · got in {fmtTime(r.enteredAfterAt)}</span>
                  : <span class="admin-warn"> · has not got in since</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Notes</h4>
```

`fmtTime`, `admin-list`, `admin-warn` and `muted` all exist already; no CSS changes.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run web/src/routes/admin.test.tsx tests/adminPlayers.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean (this runs the `web/tsconfig.json` project too).

- [ ] **Step 10: Commit**

```bash
git add src/admin/players.ts tests/adminPlayers.test.ts web/src/api.ts web/src/routes/admin/AdminPlayers.tsx web/src/routes/admin.test.tsx
git commit -m "Show a player's connect drops on the admin player page"
```

---

### Task 9: The help page

Static pages in this site are plain components registered as a `<Route>` in `web/src/main.tsx`; `HowToPlay` is the model. The Fastify SPA fallback (`setNotFoundHandler` in `src/server.ts`) already serves the shell for any GET outside `/api/`, `/auth/` and `/ws`, and `/link/discord` proves nested paths work, so the backend needs nothing.

**Files:**
- Create: `web/src/routes/HelpConsistency.tsx`
- Modify: `web/src/main.tsx:22` (import), `:84` (route)
- Modify: `web/src/routes/HowToPlay.tsx:51-52` (a FAQ entry that links to the page)
- Test: `web/src/routes/HelpConsistency.test.tsx` (new)

**Interfaces:**
- Consumes: nothing. The path must equal `CONSISTENCY_HELP_PATH` from Task 6 (`/help/consistency`), which is what the DM and the admin page link to.
- Produces: `export function HelpConsistency()`, a component with no props.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/routes/HelpConsistency.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { HelpConsistency } from './HelpConsistency';

afterEach(cleanup);

/* Shallow on purpose, like routes.test.tsx: this asserts that the page says the
 * things the spec requires it to say, not how it is marked up. */
describe('HelpConsistency', () => {
  it('shows the dialog text a dropped player is looking at', () => {
    render(<HelpConsistency />);
    expect(screen.getByText(/Server is enforcing consistency for this file:/)).toBeTruthy();
  });

  it('names the three usual causes', () => {
    render(<HelpConsistency />);
    expect(screen.getByText('A skin.')).toBeTruthy();
    expect(screen.getByText('A no-trees or foliage pack.')).toBeTruthy();
    expect(screen.getByText('Silenced weapons or a sound pack.')).toBeTruthy();
  });

  it('explains removing an addon and verifying game files', () => {
    render(<HelpConsistency />);
    expect(screen.getByRole('heading', { name: 'Remove the addon' })).toBeTruthy();
    expect(screen.getByText('left4dead/addons')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Verify your game files' })).toBeTruthy();
    expect(screen.getByText('Verify integrity of game files')).toBeTruthy();
  });

  it('says the detail-grass cvars are not part of it', () => {
    render(<HelpConsistency />);
    expect(screen.getByText('cl_detaildist')).toBeTruthy();
    expect(screen.getByText('r_drawdetailprops')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Grass settings are not part of this' })).toBeTruthy();
  });

  it('contains no em dash', () => {
    const { container } = render(<HelpConsistency />);
    // Built from its code point so this file does not contain one either.
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/routes/HelpConsistency.test.tsx`
Expected: FAIL, the whole file, with a module resolution error for `./HelpConsistency`.

- [ ] **Step 3: Write the page**

```tsx
// web/src/routes/HelpConsistency.tsx
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** Static. Linked from the bot's DM to a player whose connection dropped while
 *  loading in, and from the admin player page. Everything here has to make
 *  sense to someone who has never heard the word "consistency": they have a
 *  dialog with a file name on it and want to get into the match. */
export function HelpConsistency() {
  return (
    <div class="page page--profile">
      <PageHeader eyebrow="Help" title="Server is enforcing consistency" />
      <div class="stack">
        <Panel>
          <h3>What the dialog means</h3>
          <p>
            If the game dropped you back to the menu while loading in, with a box that says
          </p>
          <blockquote class="mono">
            Server is enforcing consistency for this file:<br />
            materials/models/infected/hunter/hunter_01.vmt
          </blockquote>
          <p>
            then your copy of that file is not the one the game shipped with. The server sends a
            checksum for a list of game files, your game compares each one against its own disk, and
            it disconnects itself at the first one that differs. The file it names is the one to fix.
            Nobody kicked you and nothing was banned: fix the file and you can connect straight away.
            The same check runs again at every map change.
          </p>
          <p class="muted">
            Only your own screen shows the file name. The server and the admins never see it, so if
            you ask for help, say which file it was.
          </p>
        </Panel>

        <Panel>
          <h3>What it usually is</h3>
          <ol class="howto">
            <li>
              <strong>A skin.</strong> Recolored, brightened or glowing special infected, and replacement
              models. The file named starts with <code>materials/models/infected/</code> or{' '}
              <code>models/infected/</code>. Many skin guides have you edit <code>pak01_dir.vpk</code>{' '}
              directly, which is why removing addons alone does not always clear it.
            </li>
            <li>
              <strong>A no-trees or foliage pack.</strong> Anything that removes or thins trees, bushes
              and plants. The file named starts with <code>models/props_foliage/</code>,{' '}
              <code>models/props_plants/</code> or the matching <code>materials/models/</code> folders.
            </li>
            <li>
              <strong>Silenced weapons or a sound pack.</strong> Quieter gunfire, or louder or replaced
              special infected sounds. The file named starts with <code>sound/weapons/</code>,{' '}
              <code>sound/player/</code>, <code>sound/npc/witch/</code> or is one of the{' '}
              <code>scripts/game_sounds_*.txt</code> files.
            </li>
          </ol>
          <p>
            Smoke, boomer bile and the special infected particle effects (<code>materials/particle/</code>{' '}
            and <code>particles/*.pcf</code>) are checked too. HUDs, crosshairs, survivor skins, weapon
            skins and menu music are not on the list and are fine.
          </p>
        </Panel>

        <Panel>
          <h3>Remove the addon</h3>
          <ol class="howto">
            <li>Quit the game.</li>
            <li>
              Open the addons folder. In Steam: right-click <strong>Left 4 Dead</strong>,{' '}
              <strong>Manage</strong>, <strong>Browse local files</strong>, then{' '}
              <code>left4dead/addons</code>.
            </li>
            <li>
              Move the <code>.vpk</code> that changes the named file somewhere else (the Desktop is
              fine). If you cannot tell which one it is, move them all out and put them back one at a
              time.
            </li>
            <li>
              Look for loose files too. A sound pack is often unpacked straight into{' '}
              <code>left4dead/sound</code> or <code>left4dead/scripts</code> rather than shipped as a
              <code>.vpk</code>. Verifying game files, below, puts those back.
            </li>
            <li>Start the game and connect again.</li>
          </ol>
        </Panel>

        <Panel>
          <h3>Verify your game files</h3>
          <p>
            This is the fix when the file was edited in place, which is how most skins are installed,
            and it is safe to do any time.
          </p>
          <ol class="howto">
            <li>In Steam, right-click <strong>Left 4 Dead</strong> and pick <strong>Properties</strong>.</li>
            <li>Open <strong>Installed Files</strong>.</li>
            <li>
              Press <strong>Verify integrity of game files</strong> and let it finish. Steam downloads
              the original of anything that was changed.
            </li>
            <li>Start the game and connect again.</li>
          </ol>
        </Panel>

        <Panel>
          <h3>Grass settings are not part of this</h3>
          <p>
            Turning detail grass down or off with <code>cl_detaildist</code> or{' '}
            <code>r_drawdetailprops</code> is a console setting, not a file. This check cannot see
            settings, so those two never cause the dialog and changing them back will not clear it.
          </p>
        </Panel>

        <Panel>
          <h3>Still stuck</h3>
          <p>
            Tell an admin in the Riverside Discord which file the dialog named. If it names a file
            and you have no addons and have verified your game files, that is a bug on our side and we
            want to hear about it.
          </p>
        </Panel>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `web/src/main.tsx` line 22, find:

```tsx
import { HowToPlay } from './routes/HowToPlay';
```

Replace with:

```tsx
import { HowToPlay } from './routes/HowToPlay';
import { HelpConsistency } from './routes/HelpConsistency';
```

And at line 84, find:

```tsx
          <Route path="/how-to-play" component={HowToPlay} session={session} />
```

Replace with:

```tsx
          <Route path="/how-to-play" component={HowToPlay} session={session} />
          <Route path="/help/consistency" component={HelpConsistency} />
```

- [ ] **Step 5: Link to it from the FAQ**

A player who was not DMed (no linked Discord) will look on How to play. In `web/src/routes/HowToPlay.tsx`, in the `FAQ` array (lines 51 to 52), find:

```tsx
  {
    q: 'My demo crashes when I play it back.',
```

Replace with:

```tsx
  {
    q: 'I was dropped while loading with "Server is enforcing consistency for this file".',
    a: <>Your copy of the file it names has been modified, usually by a skin, a no-trees pack or a silenced-weapons pack. Remove that addon or verify your game files in Steam and you can connect straight away. <a href="/help/consistency">Step by step</a>.</>,
  },
  {
    q: 'My demo crashes when I play it back.',
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run web/src/routes/HelpConsistency.test.tsx web/src/routes/routes.test.tsx`
Expected: PASS. (`routes.test.tsx` prints a harmless `ECONNREFUSED 127.0.0.1:3000` from an unrelated fetch; it did before this change too.)

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Look at it**

Run: `npm run dev`, open `http://localhost:5173/help/consistency`, and check it at a phone width as well: the blockquote and the long `<code>` paths must wrap rather than push the panel sideways. If a path overflows, add `overflow-wrap: anywhere` to that `<code>` through the existing `.mono` rule in `web/src/styles/app.css` rather than a new class. Stop the dev server afterwards.

- [ ] **Step 8: Commit**

```bash
git add web/src/routes/HelpConsistency.tsx web/src/routes/HelpConsistency.test.tsx web/src/main.tsx web/src/routes/HowToPlay.tsx
git commit -m "Add the help page a dropped player is sent to"
```

---

### Task 10: Load the enforced list on the web

**How the backend gets the list:** it reads `consistency/configs/l4d_consistency.cfg` from the repo checkout, at a path resolved relative to the module (`src/consistencyList.ts` plus `../consistency/configs/`), ignoring blank lines and `#` lines. It is read once, when the campaign routes are registered (Task 11). There is no environment variable and no copy step: `deploy-web.sh` ships the whole tree, and the service runs `tsx src/index.ts` from `/home/pug/app`, so the file is in the same relative place on the box. A test in this task fails if the deploy script ever grows an exclude that would drop it.

**When the list cannot be read, the uploader must refuse, not wave everything through.** `loadConsistencyList` returns null for a missing file AND for a file with no paths in it, and says why on stderr.

**Files:**
- Create: `src/consistencyList.ts`
- Test: `tests/consistencyList.test.ts` (new)

**Interfaces:**
- Produces:
  - `CONSISTENCY_CFG: string` (absolute path to the committed cfg)
  - `parseConsistencyList(text: string): string[]`
  - `loadConsistencyList(path?: string): string[] | null`
  - `consistencyCollisions(vpkPaths: string[], forced: string[]): string[]` (case-insensitive, backslash-tolerant; result in list order and list spelling)
  - `collisionMessage(collisions: string[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/consistencyList.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSISTENCY_CFG, collisionMessage, consistencyCollisions, loadConsistencyList, parseConsistencyList,
} from '../src/consistencyList.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('parseConsistencyList', () => {
  it('keeps paths and skips blanks, comments and group headers', () => {
    const text = [
      '# GENERATED, do not edit', '', '# group 1: special infected models and materials',
      'models/infected/hunter.mdl', '  materials/models/infected/hunter/hunter_01.vmt  ', '',
      '# group 3: gunfire', 'scripts/game_sounds_weapons.txt', '',
    ].join('\n');
    expect(parseConsistencyList(text)).toEqual([
      'models/infected/hunter.mdl', 'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt',
    ]);
  });

  it('copes with CRLF line endings', () => {
    expect(parseConsistencyList('# c\r\nmodels/infected/hunter.mdl\r\n')).toEqual(['models/infected/hunter.mdl']);
  });
});

describe('loadConsistencyList', () => {
  it('loads the committed list from the repo, relative to src/', () => {
    const list = loadConsistencyList();
    expect(list).not.toBeNull();
    // Groups 1 to 5 as committed in 9bac557 on 2026-09-19. A deliberate regeneration
    // (group 6, a game update) changes this number; update it then.
    expect(list!.length).toBe(652);
    expect(list).toContain('materials/models/infected/hunter/hunter_01.vmt');
    expect(list).toContain('scripts/game_sounds_weapons.txt');
    expect(list!.every((p) => !p.startsWith('#') && p.trim() === p && p !== '')).toBe(true);
  });

  it('is null, loudly, when the file is missing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadConsistencyList('/nonexistent/l4d_consistency.cfg')).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('is null, loudly, when the file holds no paths', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'consistency-'));
    try {
      const empty = join(dir, 'l4d_consistency.cfg');
      writeFileSync(empty, '# GENERATED\n\n# group 1: nothing survived the rules\n');
      expect(loadConsistencyList(empty)).toBeNull();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The list only protects uploads on the box if it is on the box. deploy-web.sh
  // rsyncs the whole tree minus its excludes, so the way to lose the file is an
  // exclude that catches it.
  it('is not excluded by the web deploy script', () => {
    const script = readFileSync(join(CONSISTENCY_CFG, '..', '..', '..', 'deploy-web.sh'), 'utf8');
    const excludes = [...script.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]);
    // Sanity: the regex really is reading the rsync excludes.
    expect(excludes).toContain('node_modules/');
    const wouldDropTheList = excludes.filter((e) => e.startsWith('consistency') || e === 'configs/' || e === '*.cfg');
    expect(wouldDropTheList).toEqual([]);
  });
});

describe('consistencyCollisions', () => {
  const forced = ['models/infected/hunter.mdl', 'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt'];

  it('is empty for a campaign that ships only its own files', () => {
    expect(consistencyCollisions(['missions/dbd.txt', 'maps/dbd1_alley.bsp', 'materials/dbd/wall.vmt'], forced)).toEqual([]);
  });

  it('finds a collision whatever the case or the slash', () => {
    expect(consistencyCollisions(['Materials\\Models\\Infected\\Hunter\\Hunter_01.VMT', 'missions/dbd.txt'], forced))
      .toEqual(['materials/models/infected/hunter/hunter_01.vmt']);
  });

  it('returns collisions in list order, in the list\'s spelling', () => {
    expect(consistencyCollisions(['scripts/game_sounds_weapons.txt', 'MODELS/infected/hunter.mdl'], forced))
      .toEqual(['models/infected/hunter.mdl', 'scripts/game_sounds_weapons.txt']);
  });
});

describe('collisionMessage', () => {
  it('names every path when there are few', () => {
    expect(collisionMessage(['a/b.vmt'])).toContain('a file the server enforces');
    expect(collisionMessage(['a/b.vmt', 'c/d.wav'])).toContain('a/b.vmt, c/d.wav.');
  });

  it('names ten and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => `sound/x/${i}.wav`);
    const msg = collisionMessage(many);
    expect(msg).toContain('sound/x/9.wav, and 3 more.');
    expect(msg).not.toContain('sound/x/10.wav');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/consistencyList.test.ts`
Expected: FAIL, the whole file, with a module resolution error for `../src/consistencyList.js`.

- [ ] **Step 3: Write the module**

```ts
// src/consistencyList.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The committed list of files the game server forces for consistency checking,
 * as the web needs it: to refuse a campaign VPK that ships one of those paths.
 *
 * A forced path that a campaign legitimately overrides would disconnect every
 * player on that map, stock client or not, because the client compares its own
 * disk against the SERVER's checksum and the server has the campaign mounted.
 *
 * The file is the same one the plugin reads, generated by
 * scripts/gen-consistency-list.ts. It is read from the repo checkout, relative
 * to this module, which is also where it is on the box: deploy-web.sh rsyncs
 * the whole tree to /home/pug/app and the service runs `tsx src/index.ts`.
 */
export const CONSISTENCY_CFG = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'consistency', 'configs', 'l4d_consistency.cfg',
);

/** One path per line; blank lines and `#` comments (group headers included)
 *  are skipped. Paths keep the spelling the file has. */
export function parseConsistencyList(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * The list, or null when it cannot be trusted: the file is missing, unreadable,
 * or holds no paths at all. Null is loud here and makes the uploader refuse
 * everything, because the alternative is an uploader that silently checks
 * nothing, and the first anyone would hear of it is a full server dropping to
 * the menu on map three.
 */
export function loadConsistencyList(path: string = CONSISTENCY_CFG): string[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[consistency] cannot read the enforced file list at ${path}; campaign uploads will be refused:`, err);
    return null;
  }
  const paths = parseConsistencyList(text);
  if (paths.length === 0) {
    console.error(`[consistency] the enforced file list at ${path} holds no paths; campaign uploads will be refused`);
    return null;
  }
  return paths;
}

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** The forced paths a VPK also ships, compared case-insensitively (the engine's
 *  file system is, and addon authors are careless about case), in list order
 *  and in the list's spelling. */
export function consistencyCollisions(vpkPaths: string[], forced: string[]): string[] {
  const shipped = new Set(vpkPaths.map(norm));
  return forced.filter((p) => shipped.has(norm(p)));
}

/** The sentence an admin sees. Names every path up to ten, then a count. */
export function collisionMessage(collisions: string[]): string {
  const shown = collisions.slice(0, 10).join(', ');
  const more = collisions.length > 10 ? `, and ${collisions.length - 10} more` : '';
  return `this VPK replaces ${collisions.length === 1 ? 'a file' : 'files'} the server enforces for consistency, `
    + `which would disconnect every player on its maps: ${shown}${more}. `
    + 'Remove them from the VPK and upload it again.';
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/consistencyList.test.ts`
Expected: PASS, 11 tests. If "loads the committed list" reports a number other than 652, stop: either the cfg was regenerated on this branch or the parser is miscounting. `grep -vc '^#\|^$' consistency/configs/l4d_consistency.cfg` is the independent count.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/consistencyList.ts tests/consistencyList.test.ts
git commit -m "Load the enforced file list on the web and intersect it with a VPK"
```

---

### Task 11: The uploader refuses a colliding campaign

**Files:**
- Modify: `tests/fixtures/makeVpk.ts` (append `makeVpkMulti`)
- Modify: `src/routes/campaigns.ts:20` (imports), `:43-47` (options), `:56` (load the list), `:192-197` (the check)
- Modify: `src/server.ts:85-88` (`ServerDeps`), `:716-719` (pass it through)
- Test: `tests/campaignRoutes.test.ts` (three new `it`s and the plumbing for them)

**Interfaces:**
- Consumes: `loadConsistencyList`, `consistencyCollisions`, `collisionMessage` (Task 10); `listVpkPaths` (already built).
- Produces:
  - `makeVpkMulti(path: string, entries: { ext: string; dir: string; name: string; body: string }[]): void`
  - `CampaignRouteOpts.consistencyListPath?: string` and `ServerDeps.consistencyListPath?: string` (tests only)
  - `POST /api/admin/campaigns` answers `422 { error: string, collisions: string[] }` for a VPK that ships an enforced path, and `503 { error }` when the list could not be loaded. The admin UI already shows `error` verbatim (`adminApi.uploadCampaign` in `web/src/api.ts` rejects with the backend's own string), so no web change is needed.

- [ ] **Step 1: Add a fixture that can build a real campaign with extra files**

`makeVpk` writes exactly one entry, so it cannot build the case this task exists for: a VPK that has a mission file (so it is accepted as a campaign) AND a path the server enforces. Append to the END of `tests/fixtures/makeVpk.ts`:

```ts
/** Write a valid v1 VPK holding several files, every one stored inline.
 *  makeVpk above writes exactly one entry, which cannot express the case the
 *  consistency check exists for: a real campaign (it has a mission file) that
 *  ALSO ships a path the server enforces. Entries are grouped the way the
 *  format requires, by extension and then by directory, in first-seen order. */
export function makeVpkMulti(path: string, entries: Pick<VpkEntry, 'ext' | 'dir' | 'name' | 'body'>[]): void {
  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
  const end = Buffer.from([0]);

  const byExt = new Map<string, Map<string, typeof entries>>();
  for (const e of entries) {
    const dirs = byExt.get(e.ext) ?? new Map<string, typeof entries>();
    byExt.set(e.ext, dirs);
    dirs.set(e.dir, [...(dirs.get(e.dir) ?? []), e]);
  }

  const tree: Buffer[] = [];
  const data: Buffer[] = [];
  let offset = 0;
  for (const [ext, dirs] of byExt) {
    tree.push(cstr(ext));
    for (const [dir, files] of dirs) {
      tree.push(cstr(dir));
      for (const f of files) {
        const body = Buffer.from(f.body, 'utf8');
        const meta = Buffer.alloc(18);
        meta.writeUInt32LE(0, 0);            // CRC, unchecked by the reader
        meta.writeUInt16LE(0, 4);            // no preload
        meta.writeUInt16LE(0x7fff, 6);       // data is in this file
        meta.writeUInt32LE(offset, 8);       // from the end of the tree
        meta.writeUInt32LE(body.length, 12);
        meta.writeUInt16LE(0xffff, 16);      // entry terminator
        tree.push(cstr(f.name), meta);
        data.push(body);
        offset += body.length;
      }
      tree.push(end);                        // end of this directory's files
    }
    tree.push(end);                          // end of this extension's directories
  }
  tree.push(end);                            // end of extensions

  const treeBuf = Buffer.concat(tree);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(treeBuf.length, 8);
  writeFileSync(path, Buffer.concat([header, treeBuf, ...data]));
}
```

- [ ] **Step 2: Write the failing route tests**

In `tests/campaignRoutes.test.ts`:

Change the first two import lines to add `vi` and `readdirSync`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
```

Change the fixture import:

```ts
import { makeVpk, makeVpkMulti } from './fixtures/makeVpk.js';
```

In `buildTestApp`, add the new option to the parameter type and pass it on. Find:

```ts
  installTargets?: () => InstallTarget[]; maxUploadBytes?: number;
}): Promise<FastifyInstance> =>
```

Replace with:

```ts
  installTargets?: () => InstallTarget[]; maxUploadBytes?: number;
  consistencyListPath?: string;
}): Promise<FastifyInstance> =>
```

and find:

```ts
    maxUploadBytes: o.maxUploadBytes,
  });
```

Replace with:

```ts
    maxUploadBytes: o.maxUploadBytes,
    consistencyListPath: o.consistencyListPath,
  });
```

Then, inside `describe('POST /api/admin/campaigns', ...)`, insert these three tests immediately ABOVE `it('rejects a file that is not a campaign VPK', ...)`. They run against the REAL committed list, which is the point: `materials/models/infected/hunter/hunter_01.vmt` and `scripts/game_sounds_weapons.txt` are both on it.

```ts
  // A forced path that a campaign overrides would disconnect every player on
  // its maps, stock client or not: the client checks its disk against the
  // SERVER's checksum, and the server has the campaign mounted.
  it('refuses a campaign that ships files the server enforces, naming them', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpkMulti(vpkPath, [
      { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION },
      { ext: 'txt', dir: 'scripts', name: 'game_sounds_weapons', body: '// quieter' },
      // Case must not matter: the engine's file system does not care.
      { ext: 'vmt', dir: 'Materials/Models/Infected/Hunter', name: 'Hunter_01', body: 'x' },
      { ext: 'vmt', dir: 'materials/dbd', name: 'wall', body: 'x' },
    ]);
    const form = new FormData();
    form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().collisions).toEqual([
      'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt',
    ]);
    expect(res.json().error).toContain('materials/models/infected/hunter/hunter_01.vmt');
    expect(res.json().error).toContain('scripts/game_sounds_weapons.txt');
    expect(res.json().error).not.toContain('materials/dbd/wall.vmt');

    // Refused means nothing landed: no row, no VPK, no temp file. The temp
    // file is removed in the route's finally, which runs AFTER reply.send has
    // already answered this inject, so wait for it rather than race it.
    expect(getCampaign(db, 'dbd')).toBeUndefined();
    expect(existsSync(join(addons, 'dbd.vpk'))).toBe(false);
    await vi.waitFor(() => {
      expect(readdirSync(addons).filter((f) => f.endsWith('.part'))).toEqual([]);
    });
  });

  it('accepts a multi-file campaign that ships only its own files', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    const vpkPath = join(addons, 'source.vpk');
    makeVpkMulti(vpkPath, [
      { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION },
      { ext: 'vmt', dir: 'materials/dbd', name: 'wall', body: 'x' },
      { ext: 'wav', dir: 'sound/dbd', name: 'alarm', body: 'x' },
    ]);
    const form = new FormData();
    form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
    const res = await app.inject({
      method: 'POST', url: '/api/admin/campaigns',
      cookies: adminCookie(app, '76561198000000001'),
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('dbd');
  });

  it('refuses every upload when the enforced list cannot be loaded', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = await buildTestApp({ db, addonsDir: addons, consistencyListPath: join(addons, 'no-such.cfg') });
      const vpkPath = join(addons, 'source.vpk');
      makeVpk(vpkPath, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
      const form = new FormData();
      form.set('file', new Blob([readFileSync(vpkPath)]), 'dbd.vpk');
      const res = await app.inject({
        method: 'POST', url: '/api/admin/campaigns',
        cookies: adminCookie(app, '76561198000000001'),
        payload: form,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/enforced file list/);
      expect(getCampaign(db, 'dbd')).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/campaignRoutes.test.ts`
Expected: FAIL on two of the three new tests: the colliding upload comes back `200` instead of `422`, and the unloadable-list upload comes back `200` instead of `503`. "accepts a multi-file campaign" passes already, which proves `makeVpkMulti` writes something `missionFromVpk` reads.

- [ ] **Step 4: Accept the option**

In `src/routes/campaigns.ts` line 20, find:

```ts
import { missionFromVpk } from '../vpk.js';
```

Replace with:

```ts
import { listVpkPaths, missionFromVpk } from '../vpk.js';
import { collisionMessage, consistencyCollisions, loadConsistencyList } from '../consistencyList.js';
```

At the end of `interface CampaignRouteOpts` (lines 43 to 47), find:

```ts
  maxUploadBytes?: number;
}
```

Replace with:

```ts
  maxUploadBytes?: number;
  /** Where the enforced file list is read from. Production leaves this unset
   *  and gets the committed consistency/configs/l4d_consistency.cfg; tests
   *  point it at a missing file to exercise the refuse-everything path. */
  consistencyListPath?: string;
}
```

- [ ] **Step 5: Load the list once, at registration**

Find (line 56):

```ts
  const maxUploadBytes = opts.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;
```

Replace with:

```ts
  const maxUploadBytes = opts.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;
  // Read once, at startup. The list changes only with a deploy, which
  // restarts this process anyway. Null means it could not be trusted, and the
  // upload route then refuses rather than checking nothing; the loader has
  // already said why on stderr.
  const forcedPaths = loadConsistencyList(opts.consistencyListPath);
```

- [ ] **Step 6: Refuse**

In the `POST /api/admin/campaigns` handler, directly after the `if (!mission) { ... }` block (line 197), find:

```ts
      const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
```

Replace with:

```ts
      // After the mission check, so a file that is not a campaign at all gets
      // the plainer message, and before anything is renamed into place or
      // written to the database, so a refusal leaves nothing behind (the
      // finally below removes the temp file).
      if (!forcedPaths) {
        return reply.code(503).send({
          error: 'the enforced file list could not be loaded, so uploads are refused until it is; see the server log',
        });
      }
      let shipped: string[];
      try {
        shipped = listVpkPaths(tmp);
      } catch {
        // The mission entry parsed but the directory after it is cut short.
        // A rejected upload, not a crashed request, as in missionFromVpk.
        return reply.code(400).send({ error: 'that VPK has a damaged file directory' });
      }
      const collisions = consistencyCollisions(shipped, forcedPaths);
      if (collisions.length > 0) {
        return reply.code(422).send({ error: collisionMessage(collisions), collisions });
      }

      const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
```

- [ ] **Step 7: Let `buildServer` pass the option through**

In `src/server.ts`, at the end of `interface ServerDeps` (lines 85 to 88), find:

```ts
  maxUploadBytes?: number;
}
```

Replace with:

```ts
  maxUploadBytes?: number;
  /** Overrides where the campaign uploader reads the enforced file list from.
   *  Injected in tests only; production reads the committed cfg. */
  consistencyListPath?: string;
}
```

And where `campaignRoutes` is registered (lines 716 to 719), find:

```ts
    installTargets: deps.installTargets, maxUploadBytes: deps.maxUploadBytes,
  });
```

Replace with:

```ts
    installTargets: deps.installTargets, maxUploadBytes: deps.maxUploadBytes,
    consistencyListPath: deps.consistencyListPath,
  });
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/campaignRoutes.test.ts tests/vpk.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/routes/campaigns.ts src/server.ts tests/campaignRoutes.test.ts tests/fixtures/makeVpk.ts
git commit -m "Refuse a campaign VPK that ships a file the server enforces"
```

---

### Task 12: Check what is already installed

The route only protects future uploads. The spec: "Existing published campaigns are checked once by a script and any collision is fixed before the list goes live." A game server mounts every VPK in its addons directory, whether or not the site put it there (map packs, the Passifice mission override), so the check covers every `.vpk` in the directory and labels the ones that belong to a campaign row.

The logic lives in `src/` so it is typechecked and unit tested (`tsconfig.json` includes `src` and `tests`, not `scripts`); the script is a thin CLI over it, in the style of `scripts/repair-survivors-alive.ts`.

**Files:**
- Create: `src/campaignCollisions.ts`
- Create: `scripts/check-campaign-collisions.ts`
- Test: `tests/campaignCollisions.test.ts` (new)

**Interfaces:**
- Consumes: `consistencyCollisions`, `loadConsistencyList` (Task 10); `listVpkPaths`; `listCampaigns(db)` from `src/customCampaigns.ts`; `makeVpkMulti` (Task 11).
- Produces: `interface VpkCheck { filename: string; slug: string | null; state: 'draft' | 'published' | null; result: 'ok' | 'collides' | 'unreadable'; collisions: string[] }` and `checkAddonsDir(db: DB, addonsDir: string, forced: string[]): VpkCheck[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/campaignCollisions.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { checkAddonsDir } from '../src/campaignCollisions.js';
import { makeVpk, makeVpkMulti } from './fixtures/makeVpk.js';

const FORCED = ['models/infected/hunter.mdl', 'scripts/game_sounds_weapons.txt'];

let db: DB;
let addons: string;
beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'addons-check-'));
});
afterEach(() => { rmSync(addons, { recursive: true, force: true }); });

const campaign = (slug: string, published: boolean) => {
  insertDraft(db, {
    slug, name: slug.toUpperCase(), vpkFilename: `${slug}.vpk`,
    sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [{ map: `${slug}1`, display: null, isFinale: true }]);
  if (published) publishCampaign(db, slug, slug.toUpperCase());
};

describe('checkAddonsDir', () => {
  it('passes a campaign that ships only its own files', () => {
    campaign('clean', true);
    makeVpkMulti(join(addons, 'clean.vpk'), [
      { ext: 'txt', dir: 'missions', name: 'clean', body: 'x' },
      { ext: 'bsp', dir: 'maps', name: 'clean1', body: 'x' },
    ]);
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'clean.vpk', slug: 'clean', state: 'published', result: 'ok', collisions: [] },
    ]);
  });

  it('names the enforced paths a published campaign overrides', () => {
    campaign('loud', true);
    makeVpkMulti(join(addons, 'loud.vpk'), [
      { ext: 'txt', dir: 'missions', name: 'loud', body: 'x' },
      { ext: 'txt', dir: 'Scripts', name: 'Game_Sounds_Weapons', body: 'x' },
    ]);
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'loud.vpk', slug: 'loud', state: 'published', result: 'collides', collisions: ['scripts/game_sounds_weapons.txt'] },
    ]);
  });

  it('checks a VPK nobody uploaded through the site, because srcds mounts it all the same', () => {
    makeVpk(join(addons, 'handmade.vpk'), { ext: 'mdl', dir: 'models/infected', name: 'hunter', body: 'x' });
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'handmade.vpk', slug: null, state: null, result: 'collides', collisions: ['models/infected/hunter.mdl'] },
    ]);
  });

  it('reports a campaign whose VPK is missing, and a file that is not a VPK', () => {
    campaign('gone', false);
    writeFileSync(join(addons, 'junk.vpk'), 'not a vpk at all');
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'junk.vpk', slug: null, state: null, result: 'unreadable', collisions: [] },
      { filename: 'gone.vpk', slug: 'gone', state: 'draft', result: 'unreadable', collisions: [] },
    ]);
  });

  it('skips the numbered data halves of a split archive', () => {
    writeFileSync(join(addons, 'big_000.vpk'), 'raw data, no directory');
    makeVpk(join(addons, 'big_dir.vpk'), { ext: 'bsp', dir: 'maps', name: 'big1', body: 'x', archiveIndex: 0 });
    expect(checkAddonsDir(db, addons, FORCED).map((c) => c.filename)).toEqual(['big_dir.vpk']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/campaignCollisions.test.ts`
Expected: FAIL, the whole file, with a module resolution error for `../src/campaignCollisions.js`.

- [ ] **Step 3: Write the module**

```ts
// src/campaignCollisions.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { listCampaigns } from './customCampaigns.js';
import { consistencyCollisions } from './consistencyList.js';
import { listVpkPaths } from './vpk.js';

export interface VpkCheck {
  filename: string;
  /** The custom campaign this VPK belongs to, or null for a VPK that was put
   *  in the addons directory by hand (a map pack, a mission override). Those
   *  are mounted by the game server all the same, so they are checked too. */
  slug: string | null;
  state: 'draft' | 'published' | null;
  result: 'ok' | 'collides' | 'unreadable';
  collisions: string[];
}

/**
 * Check every VPK in the addons directory against the enforced file list, plus
 * every campaign row whose VPK is not there at all.
 *
 * The upload route refuses new collisions; this is for what was installed
 * before that check existed. Read-only.
 */
export function checkAddonsDir(db: DB, addonsDir: string, forced: string[]): VpkCheck[] {
  const campaigns = new Map(listCampaigns(db).map((c) => [c.vpk_filename.toLowerCase(), c]));
  const onDisk = readdirSync(addonsDir)
    // pak01_000.vpk style files are the data half of a split archive and have
    // no directory of their own; their _dir.vpk is what lists the paths.
    .filter((f) => f.toLowerCase().endsWith('.vpk') && !/_\d{3}\.vpk$/i.test(f))
    .sort();

  const out: VpkCheck[] = [];
  const seen = new Set<string>();
  for (const filename of onDisk) {
    seen.add(filename.toLowerCase());
    const c = campaigns.get(filename.toLowerCase());
    const base = { filename, slug: c?.slug ?? null, state: c?.state ?? null };
    let paths: string[];
    try {
      paths = listVpkPaths(join(addonsDir, filename));
    } catch {
      out.push({ ...base, result: 'unreadable', collisions: [] });
      continue;
    }
    if (paths.length === 0) {
      out.push({ ...base, result: 'unreadable', collisions: [] });
      continue;
    }
    const collisions = consistencyCollisions(paths, forced);
    out.push({ ...base, result: collisions.length > 0 ? 'collides' : 'ok', collisions });
  }
  for (const [key, c] of campaigns) {
    if (!seen.has(key)) out.push({ filename: c.vpk_filename, slug: c.slug, state: c.state, result: 'unreadable', collisions: [] });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/campaignCollisions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the script**

```ts
// scripts/check-campaign-collisions.ts
/**
 * Check what is already installed against the enforced file list.
 *
 * The campaign uploader refuses a VPK that ships a path on the list, but every
 * campaign published before that check existed went in unchecked, and so did
 * anything copied into the addons directory by hand. A forced path that one of
 * them overrides disconnects every player on its maps. Run this once before the
 * list goes live, and again after regenerating the list (group 6).
 *
 *   npx tsx scripts/check-campaign-collisions.ts                 # ADDONS_DIR from .env
 *   ADDONS_DIR=/path/to/left4dead/addons npx tsx scripts/check-campaign-collisions.ts
 *
 * Read-only: it opens the database to label VPKs with their campaign and
 * writes nothing. Exits 0 when nothing collides, 1 when something does or a
 * VPK could not be read, 2 when it could not run at all.
 */
import { loadDotEnv } from './dotenv.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadConsistencyList } from '../src/consistencyList.js';
import { checkAddonsDir } from '../src/campaignCollisions.js';

loadDotEnv();
const config = loadConfig(process.env);
if (!config.addonsDir) {
  console.error('No ADDONS_DIR configured; nothing to check.');
  process.exit(2);
}
const forced = loadConsistencyList();
if (!forced) process.exit(2); // the loader has already said why

const db = openDb(config.dbPath);
const checks = checkAddonsDir(db, config.addonsDir, forced);

let bad = 0;
for (const c of checks) {
  const label = c.slug ? `${c.filename} (campaign ${c.slug}, ${c.state})` : `${c.filename} (not a site campaign)`;
  if (c.result === 'ok') {
    console.log(`ok        ${label}`);
  } else if (c.result === 'unreadable') {
    bad++;
    console.log(`UNREADABLE ${label}: missing, empty, or not a VPK directory`);
  } else {
    bad++;
    console.log(`COLLIDES  ${label}: ${c.collisions.length} enforced path(s)`);
    for (const p of c.collisions) console.log(`            ${p}`);
  }
}
console.log(`\n${checks.length} VPK(s) checked against ${forced.length} enforced paths in ${config.addonsDir}: ${bad} need attention.`);
process.exit(bad > 0 ? 1 : 0);
```

- [ ] **Step 6: Run it against the LOCAL test server**

```bash
ADDONS_DIR=/home/volence/l4d1-ds/server/left4dead/addons DB_PATH=/tmp/claude-check-collisions.db npx tsx scripts/check-campaign-collisions.ts; echo "exit=$?"
```

Expected (rehearsed 2026-09-19; the local server has one hand-installed VPK and no site campaigns):

```
ok        l4d1_mission_nav.vpk (not a site campaign)

1 VPK(s) checked against 652 enforced paths in /home/volence/l4d1-ds/server/left4dead/addons: 0 need attention.
exit=0
```

`DB_PATH` points at a throwaway file so the run cannot touch `data/pug.db`. Delete `/tmp/claude-check-collisions.db*` afterwards. Running it against the Dallas addons directory is step 6 of the README's local rollout list and is not part of this task.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/campaignCollisions.ts scripts/check-campaign-collisions.ts tests/campaignCollisions.test.ts
git commit -m "Check the VPKs already in an addons directory against the enforced list"
```

---

### Task 13: consistency/README.md

The README still describes Phase 1 (one file chosen by a cvar that no longer exists, "client side not answered"). Everything from `## Layout` to the end is replaced; the three sections above it (intro, "Why this exists", "How it is reached") are still true and stay, except the spec pointer.

**Files:**
- Modify: `consistency/README.md:6` (spec pointer), `:37-87` (everything from `## Layout` down)

**Interfaces:** none. Documentation only.

- [ ] **Step 1: Point at both specs**

On line 6, find:

```markdown
Spec: `docs/superpowers/specs/2026-09-18-file-consistency-design.md`.
```

Replace with:

```markdown
Specs: `docs/superpowers/specs/2026-09-18-file-consistency-design.md` (Phase 1, the
mechanism) and `docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md`
(Phase 2, the enforced list and marking who was rejected).
```

- [ ] **Step 2: Replace everything from `## Layout` to the end of the file with this**

````markdown
## Layout

- `extension/` the SourceMod extension. One native, no state, no hooks.
- `plugin/` `l4d_consistency.sp`: reads the list, forces it on every map start,
  and emits the `L4DC SIGNON_DROP` line.
- `configs/l4d_consistency.cfg` the enforced list. GENERATED and committed; never
  edited by hand.
- `../scripts/gen-consistency-list.ts` the generator, and its `--verify`.
- `../scripts/check-campaign-collisions.ts` checks the VPKs already on a server
  against the list.
- `Makefile`, `Dockerfile.build`, `build.sh` the extension build.

The web half lives in the app: `src/logParse.ts` and `src/logListener.ts` (the
drop line), `src/signonDrops.ts` and `src/signonDropNotify.ts` (storage, the admin
feed, the player DM), `src/consistencyList.ts` and `src/campaignCollisions.ts` (the
campaign uploader's refusal), and `web/src/routes/HelpConsistency.tsx` (the page a
dropped player is sent to).

## Building

    ./build.sh

Builds inside Ubuntu 22.04 and prints the highest GLIBC symbol required. **Never
build on the host**: Arch links GLIBC 2.4x and the Dallas box is 2.39.
`sourcetv/README.md` records that mistake being made once already. A correct
build reports `GLIBC_2.4`.

Output: `build/l4d_consistency.ext.so` (ELF 32-bit i386, matching the server).

The plugin compiles with the local test server's native spcomp:

    cd /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/scripting
    ./spcomp /home/volence/l4d/pug/consistency/plugin/l4d_consistency.sp \
      -i /home/volence/l4d/pug/consistency/plugin \
      -o /home/volence/l4d/pug/consistency/plugin/l4d_consistency.smx

The `.smx` is committed, unlike `plugin/pug-match.smx`, so a checkout is
installable without a compiler.

## The enforced list

`configs/l4d_consistency.cfg` is one game-relative path per line. `#` starts a
comment, and a `# group N: title` comment opens a group, which is what
`sm_consistency_status` reports per. **No wildcards at runtime**: a glob that
matches nothing is a silent zero, and a generated file is diffable.

    npx tsx scripts/gen-consistency-list.ts                     # groups 1 to 5 (652 paths)
    npx tsx scripts/gen-consistency-list.ts --commons           # also group 6, common infected
    npx tsx scripts/gen-consistency-list.ts --game /path/to/left4dead
    npx tsx scripts/gen-consistency-list.ts --verify /path/to/other/left4dead

Run from `pug/`. `--game` is a STOCK install and defaults to the local test server
(`/home/volence/l4d1-ds/server/left4dead`). Models, materials and particles are read
from its `pak01_dir.vpk`; sounds and scripts are loose files on L4D1 and are walked
on disk, resolved through `left4dead_dlc3` first and then `left4dead`, which is the
engine's own search order (several soundscripts exist only in the dlc3 directory).

`--verify` compares every loose file on the list, and `pak01_dir.vpk` itself,
against a second install and names anything that differs or is missing. **Run it
against a real client before trusting a server.** The engine checksums the
SERVER's copy, so one customised sound on the server would disconnect every stock
client, and that failure looks identical to everyone cheating at once.

After regenerating, in this order:

1. Read the diff. A rule that suddenly matches nothing shows up as deleted lines.
2. `npm test`. `tests/consistencyList.test.ts` pins the path count (652 for groups
   1 to 5) so that a changed list is always a deliberate commit; update the number
   in the same commit.
3. `npx tsx scripts/check-campaign-collisions.ts` against every server's addons
   directory, because a path that is newly forced may be one a published campaign
   already ships.
4. Copy the cfg to every game server (see Installing). The web reads its own copy
   from the repo checkout, which `deploy-web.sh` ships.

## Installing

    cp build/l4d_consistency.ext.so    <game>/left4dead/addons/sourcemod/extensions/
    cp plugin/l4d_consistency.smx      <game>/left4dead/addons/sourcemod/plugins/
    cp configs/l4d_consistency.cfg     <game>/left4dead/addons/sourcemod/configs/

The drop line reaches the web over the same `logaddress_add` feed `pug-match.smx`
uses, so it needs `log on` and nothing new in the server cfg.

## Cvars

| cvar | default | meaning |
|---|---|---|
| `l4d_consistency_enabled` | `1` | force the list on map start. Read at the NEXT map start |
| `sv_consistency` | `1` | the engine's own switch. Instant |

Two independent off switches on purpose. The failure mode of this feature is
disconnecting legitimate players, and recovery must not need a rebuild.

## Commands

- `sm_consistency_status` per group, forced N of M on this map, plus unresolved
  paths and the downloadables table's fill
- `sm_consistency_reload` re-read the cfg and force it now, for tuning on the test
  server. A path forced earlier this map stays forced until the next map
- `sm_consistency_force <path>` force one path now, for probing a single file

## The drop line

The client does the check and drops itself; the reason the server sees is the plain
"Disconnect by user." and the file name never reaches the server. What the plugin
can see is the signature: a human who left by their own hand, without ever being in
game, on a map that forced at least one file. It emits, over `LogToGame`:

    L4DC SIGNON_DROP steamid=<id> secs=<int, -1 if unknown> forced=<int> name=<rest of line>

`<id>` is a SteamID64 when the client slot is still valid and the event's
`STEAM_1:Y:Z` networkid otherwise; the web accepts both. The name is last and takes
the rest of the line, so it cannot forge an earlier field. **A cancelled loading
screen produces the same line.** Everything downstream treats it as a hint.

The line has no match token (most drops happen while people are still joining,
before any match exists), so the web admits it only from a game server's address,
the same address-pinned path the `!load_4v4p` match-create burst uses, and only
when `L4DC ` is the first thing after the engine's timestamp. That second rule is
what stops a player forging a drop for someone else by typing the line into chat:
the game server's address also sends every `say` line.

What the web does with it:

- stores it in `signon_drops`, and stamps `entered_after_at` when the same SteamID
  is next seen in game (the engine's "entered the game" line, or `PLAYER
  event=connect` during a match)
- DMs a player with a linked Discord account at once, with a link to
  `/help/consistency`: at most one DM per SteamID per hour, and a DM that fails is
  logged and never retried
- posts to the Discord admin feed on the SECOND drop inside ten minutes with no
  entry between, under the Problems toggle; one cancelled load posts nothing
- shows a "Connect drops" line, with the rows behind it, on the admin player page

## Custom campaigns

A forced path that a campaign VPK overrides would disconnect every player on that
campaign's maps, stock client or not, because the server checksums ITS copy and the
server has the campaign mounted. So the uploader refuses any VPK that ships a path
on the list, naming the paths (compared case-insensitively). If the list cannot be
read the uploader refuses everything rather than checking nothing.

What was installed before that check existed is covered by

    npx tsx scripts/check-campaign-collisions.ts

which checks every `.vpk` in `ADDONS_DIR`, site campaign or hand-copied, and exits
non-zero if anything collides. Fix or remove a colliding VPK before the list goes
live.

## Rollout

Local test server first, never Dallas, in this order. Nothing ships without step 1.

1. **The stock gate.** Full list applied, a stock client joins and plays a full
   map. Zero disconnects.
2. One modified file per group; expect the rejection naming it.
3. Loading time with the list on and off, same map, three runs each. Record the
   numbers under Status: they are what the group 6 decision is made on.
4. The drop line: a rejected client produces exactly one `SIGNON_DROP`, a loading
   cancel produces one too, a timeout and a kick produce none.
5. `npx tsx scripts/gen-consistency-list.ts --verify <a real client's left4dead>`.
6. `npx tsx scripts/check-campaign-collisions.ts` with `ADDONS_DIR` pointed at the
   Dallas addons directory. Anything that collides is fixed first.

Dallas, with the owner's go-ahead, on an EMPTY server:

1. Deploy the web first (`deploy-web.sh`), so the drop line has somewhere to land.
2. Stage the extension, the plugin and the cfg with `l4d_consistency_enabled 0`.
3. Flip it on over rcon: `l4d_consistency_enabled 1`. The client re-runs the check
   at every level change, so the flip never touches the map in progress; it takes
   effect for everyone, already connected or not, at the next map load.
4. Watch `sm_consistency_status` after that map load: forced 652, unresolved 0.

**Rollback is `sv_consistency 0` over rcon.** Instant, no restart, no map change.

Two traps in step 2, both from the cvar having no cfg of its own:

- The plugin creates `l4d_consistency_enabled` with a default of `1`, so a server
  restart during the staging window reloads it ENABLED. Keep the window short, or
  hold `sv_consistency 0` as well until the flip.
- Do not put `l4d_consistency_enabled 0` in a cfg that is exec'd on every map. The
  plugin reads the cvar once per map, in `OnMapStart`, and a cfg that re-asserts 0
  around every map start fights the flip: depending on which runs first, the flip
  either never takes effect or lasts exactly one map.

Group 6 (common infected) repeats local steps 1 to 3 and the Dallas staging as its
own rollout, after groups 1 to 5 have survived real matches.

## Status

- Phase 1 (the mechanism): done. All six file types the list uses (`.vmt .vtf .mdl
  .pcf .wav .txt`) produced a rejection naming the file on the local server with a
  real client, 2026-09-19.
- Phase 2 plugin and list: built, 652 paths in groups 1 to 5.
- Phase 2 web: parser, admission, storage, admin feed, DM, admin page, help page,
  uploader refusal and the collision script are built and tested.
- Not yet done: the local stock gate, the loading-time measurement, and everything
  under Dallas above.
````

- [ ] **Step 3: Check the house rule and the facts**

```bash
grep -c "$(printf '\342\200\224')" consistency/README.md
```

Expected: `0`.

Then read the new README against the code once: the cvar table must match `CreateConVar` calls in `l4d_consistency.sp` (there are two: `l4d_consistency_version` is informational and deliberately not listed), the three commands must match its three `RegAdminCmd` calls, and the generator flags must match the usage block at the top of `scripts/gen-consistency-list.ts`.

- [ ] **Step 4: Commit**

```bash
git add consistency/README.md
git commit -m "Document consistency Phase 2: the list, the drop line, rollout and rollback"
```

---

### Task 14: Verification

Nothing here touches Dallas. The end-to-end check runs the real backend on this workstation, on spare ports, against a scratch database, and feeds it hand-made datagrams.

**Files:** none modified.

- [ ] **Step 1: The whole suite**

Run: `npm test`
Expected: every file passes. At `9bac557` the suite was 149 files; this plan adds 7 (`logParseSignon`, `signonDrops`, `signonDropNotify`, `signonDropWiring`, `consistencyList`, `campaignCollisions`, and `web/src/routes/HelpConsistency`), so expect 156 files and roughly 2047 tests, all green.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: both `tsc` runs finish with no output.

- [ ] **Step 3: No em dashes crept in**

```bash
git diff --name-only 9bac557..HEAD | xargs grep -n "$(printf '\342\200\224')" ; echo "exit=$?"
```

Expected: no lines, `exit=1` (or `123` from xargs). Any hit is fixed by rephrasing, then re-run. Files that already contained one before this branch are not in scope, but none of the files this plan touches did.

- [ ] **Step 4: Start the real backend with a scratch database**

`npm run dev` will NOT do: it sets `DEV_MODE=1`, and in dev mode `buildServer` builds no log listener at all. Start it the production way, on spare ports. `dist/public` must exist for the static plugin, so build first.

```bash
npm run build
mkdir -p /tmp/claude-e2e && rm -f /tmp/claude-e2e/e2e.db /tmp/claude-e2e/e2e.db-wal /tmp/claude-e2e/e2e.db-shm
DB_PATH=/tmp/claude-e2e/e2e.db PORT=8099 LOG_LISTEN_PORT=27511 LOG_PUBLIC_ADDRESS=127.0.0.1:27511 npx tsx src/index.ts
```

Expected, within a few seconds: `pug-web listening on :8099 (devMode=false)`. Leave it running and use a second terminal for the rest. With no `servers` rows and the feed host `127.0.0.1`, the allowed source set is exactly `{127.0.0.1}`.

- [ ] **Step 5: Write the sender**

Save as `/tmp/claude-e2e/send.mjs`. It frames a line the way srcds does and, unlike the test helper, lets you choose the SOURCE address. On Linux every `127.x.y.z` address is loopback, so `127.0.0.2` is a genuine second sender with no setup.

```js
// usage: node send.mjs <source-address> <port> <log line body>
import dgram from 'node:dgram';
const [source, port, ...body] = process.argv.slice(2);
const text = Buffer.from(`L 09/19/2026 - 14:23:01: ${body.join(' ')}\n`, 'utf8');
const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
const s = dgram.createSocket('udp4');
s.bind(0, source, () => s.send(pkt, Number(port), '127.0.0.1', (err) => { s.close(); if (err) throw err; }));
```

- [ ] **Step 6: A disallowed address, an allowed address, and a chat forgery**

```bash
# 1. From an address that is not a game server. Must be ignored.
node /tmp/claude-e2e/send.mjs 127.0.0.2 27511 'L4DC SIGNON_DROP steamid=76561198000000009 secs=5 forced=652 name=spoofed from elsewhere'
# 2. From the allowed address, in the v0.2.0 STEAM_ form, with a name that tries to forge the steamid.
node /tmp/claude-e2e/send.mjs 127.0.0.1 27511 'L4DC SIGNON_DROP steamid=STEAM_1:1:35074132 secs=14 forced=652 name=Big Bill  x=y steamid=76561198000000009'
# 3. From the allowed address, but the marker is inside a chat line. Must be ignored.
node /tmp/claude-e2e/send.mjs 127.0.0.1 27511 '"griefer<7><STEAM_1:0:5><Survivor>" say "L4DC SIGNON_DROP steamid=76561198000000009 secs=3 forced=652 name=victim"'
sleep 1
sqlite3 /tmp/claude-e2e/e2e.db "SELECT id, steamid, name, secs_connected, forced_count, entered_after_at FROM signon_drops"
```

Expected, exactly one row (rehearsed 2026-09-19):

```
1|76561198030413993|Big Bill  x=y steamid=76561198000000009|14|652|
```

Read it as three results at once: the `127.0.0.2` datagram stored nothing; the `STEAM_1:1:35074132` id was normalised to `76561198030413993` and the forged `steamid=` stayed inside the name; the chat line stored nothing even though it came from an allowed address. If `76561198000000009` appears in the `steamid` column in ANY row, stop: that is either the address gate or the name rule failing.

- [ ] **Step 7: An entry stamps the drop**

```bash
node /tmp/claude-e2e/send.mjs 127.0.0.2 27511 '"Big Bill<61><STEAM_1:1:35074132><>" entered the game'
sleep 1
sqlite3 /tmp/claude-e2e/e2e.db "SELECT id, steamid, entered_after_at IS NOT NULL AS entered FROM signon_drops"
```

Expected: `1|76561198030413993|0` (the entry came from the disallowed address, so nothing was stamped).

```bash
node /tmp/claude-e2e/send.mjs 127.0.0.1 27511 '"Big Bill<61><STEAM_1:1:35074132><>" entered the game'
sleep 1
sqlite3 /tmp/claude-e2e/e2e.db "SELECT id, steamid, entered_after_at IS NOT NULL AS entered FROM signon_drops"
```

Expected: `1|76561198030413993|1`.

- [ ] **Step 8: The second-drop rule, by eye**

There is no Discord in this setup, so the feed has nowhere to post; what can be seen is the streak the post is decided on. Send two fresh drops for a new steamid more than 3 seconds apart (closer than that is treated as one duplicated datagram):

```bash
node /tmp/claude-e2e/send.mjs 127.0.0.1 27511 'L4DC SIGNON_DROP steamid=76561198005192652 secs=9 forced=652 name=mayhem'
sleep 4
node /tmp/claude-e2e/send.mjs 127.0.0.1 27511 'L4DC SIGNON_DROP steamid=76561198005192652 secs=8 forced=652 name=mayhem'
sleep 1
sqlite3 /tmp/claude-e2e/e2e.db "SELECT steamid, COUNT(*) FROM signon_drops WHERE entered_after_at IS NULL GROUP BY steamid"
```

Expected: `76561198005192652|2`. The post and the DM themselves are covered by `tests/signonDropNotify.test.ts` and `tests/discordAdminFeed.test.ts` against the fake transport; the first real ones happen after the owner-approved rollout.

- [ ] **Step 9: The pages**

With the backend from Step 4 still up, open `http://localhost:8099/help/consistency` (served from the build, through the SPA fallback) and confirm the page renders and the How to play FAQ entry links to it. The admin player page needs a signed-in admin and is covered by the component and API tests.

- [ ] **Step 10: Clean up**

Stop the backend (Ctrl+C), then:

```bash
rm -rf /tmp/claude-e2e
git status --short
```

Expected: a clean tree. `dist/` is gitignored.

- [ ] **Step 11: Optional, with a real client on the LOCAL test server only**

This is step 4 of the README's local rollout and needs a person at a game client, so it is not a gate for this plan. Install the Task 1 `.smx` and the cfg into `/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/`, start the backend as in Step 4, run `logaddress_add <this machine's LAN address>:27511` on the local srcds (not `127.0.0.1` if srcds was started with `-ip`: a socket bound to a public address cannot send to loopback, see the comment in the box's `local.cfg`), and add that LAN address as a `servers` row's `host` in the scratch database so it is an allowed source. Then connect with a modified file and expect one row whose `steamid` is 17 digits. Never point the Dallas box at a workstation.

---

## Self-Review

**Spec coverage.**

| spec requirement | task |
|---|---|
| Parser learns `L4DC ` alongside `PUG `, yields `signon_drop` | 2 |
| Admission by source address through the path the match-create burst uses | 3 (gate), 7 (the same allowlist `server.ts` already fills) |
| "Forged drop lines: admitted only from the game server's address, name field last" | 2 (name rule, stamp anchoring against chat forgery), 3 |
| Table `signon_drops(id, steamid, name, secs_connected, forced_count, at, entered_after_at)` | 4 (a test pins the exact column list) |
| `entered_after_at` filled by the next `PLAYER event=connect` or engine "entered the game" | 2 (parse the engine line), 4 (`markEntered`), 7 (both signals wired) |
| `AdminEvent` kind `signon_drop` under `admin_feed_problems` | 5 |
| Published on the second drop within ten minutes with no entry between; first drop stored, not posted | 4 (streak), 6 (rule), tests in 6 |
| Message: name, steamid, count, the quoted wording | 5 |
| DM on the first drop if Discord is linked, with the help link | 6 |
| At most one DM per steamid per hour; a failed DM logged, not retried | 6 |
| Admin player page: count, last time, link to rows | 8 |
| `/help/consistency`: the dialog, three causes, remove an addon, verify files, detail-grass cvars | 9 (a test per item) |
| Uploader intersects the VPK with the committed list and refuses, naming paths | 10, 11 |
| Existing published campaigns checked once by a script | 12 |
| Testing item 6: parser and admission tests, ten minute rule, DM rate limit, uploader refusal | 2, 3, 6, 11 |
| README: usage, generator, `--verify`, rollout, rollback | 13 |
| Plugin sends SteamID64, web accepts both forms (from the task brief, not the spec) | 1, 2 |

Out of this plan by design: the spec's "The plugin, Phase 2" section and the generator (already built in `bbba54e` and `9bac557`), spec testing items 1 to 5 (a person with a game client on the local server; listed in the README), the Dallas rollout, and group 6.

**Where this plan departs from the spec's wording, and why.**

- The spec says the uploader lives in `campaignInstall.ts`. The validation is in `src/routes/campaigns.ts`; the refusal goes there.
- The spec's feed event carries "count". This plan's carries `count` (the ten minute window) and `total` (all time). See "Interpretation decisions".
- The spec does not mention chat forgery. Admitting a token-less marker by address alone, while finding the marker with `indexOf` the way `PUG ` is found, would let any player forge a drop for any SteamID from chat. Task 2 anchors the marker to the start of the log message instead. The same weakness exists today for the `PUG <token> MATCH_CREATE` burst (the token there is plugin-generated and unregistered, so a chat line can carry a made-up one). That is a pre-existing issue next to the known roster forgery and is NOT fixed here; it is reported to the owner with this plan.

**Placeholder scan.** No TBD, TODO, "similar to", or step without its code. The two steps that are manual by nature (Task 9 Step 7, Task 14 Steps 4 to 9) give exact commands and exact expected output, rehearsed against a scratch copy of the tree on 2026-09-19; every code block in Tasks 1 to 12 was applied to that copy, where `npm test` (156 files, 2047 tests) and `npm run typecheck` passed and the plugin compiled.

**Type consistency.** `SignonDropInput { steamid, name, secs, forced }` (Task 4) is structurally satisfied by the `signon_drop` `LogEvent` (Task 2), which is why Task 7 passes the event straight to `onDrop`. `RecordedDrop.streak` and `.total` (Task 4) are what Task 6 copies into the admin event's `count` and `total` (Task 5). `signonDropSummary`'s return shape (Task 4) is the `signonDrops` field in `playerDetail` (Task 8) and in `AdminPlayerDetail` (Task 8), field for field. `CONSISTENCY_HELP_PATH` (Task 6) equals the route path in Task 9 and the `href` in Task 8. `DmFn` (Task 6) has the parameter order of `BotTransport.dm` (Task 6). `consistencyListPath` has the same name in `CampaignRouteOpts`, `ServerDeps` and the test helper (Task 11). `makeVpkMulti` is defined in Task 11 and consumed in Tasks 11 and 12 with the same entry shape.
