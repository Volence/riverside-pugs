# Discord Bot + Admin Panel Implementation Plan

> **For agentic workers:** executed inline overnight 2026-09-17 by the same session that wrote the spec (the owner was asleep, so no subagent review loop). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord as a full second surface (link, queue, ready, vote, connect, results, voice, slash commands) plus a web admin panel with bans, match control, settings, reports and no-show penalties.

**Architecture:** discord.js runs in-process behind a `BotTransport` seam; pure presenters render state into message payloads; a sync loop keeps posted messages in step on every hub broadcast. Admin is `/api/admin/*` behind `requireAdmin` plus a Preact `/admin` page. All new state is additive SQLite tables/columns.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, openskill, discord.js v14, Preact + preact-iso, vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-discord-bot-and-admin-design.md`

**Deviation from the writing-plans template, on purpose:** tasks list interfaces and the exact test cases rather than full code bodies. The implementer is the spec author working the same night; writing every body twice would halve what ships. Every interface named here is the one the code uses.

## Global Constraints

- No em dashes anywhere (code, comments, docs, commit messages, UI copy).
- Migrations additive only: `CREATE TABLE IF NOT EXISTS` in `SCHEMA`, `ensureColumn` for columns, new settings via `DEFAULT_SETTINGS`.
- Discord unconfigured (`DISCORD_CLIENT_ID` or bot vars unset) = site behaves exactly as before; every Discord route 404s.
- Tests never touch the network: `DiscordApi` and `BotTransport` are injected fakes.
- Behaviour shared by web and Discord lives in `Matchmaker` or a `src/` module, never in the bot layer.
- Run `npx vitest run` and `npm run typecheck` (one pre-existing error in `web/src/routes/Crosshair.tsx` is not ours) before every commit.
- Deploy only when no match is configuring/live and the queue is empty. Never touch the game server.

---

## Part A: Identity

### Task A1: Schema + player link functions
**Files:** Modify `src/db.ts`, `src/players.ts`. Test `tests/discordLink.test.ts`.
**Produces:**
- columns `players.discord_id TEXT`, `players.discord_name TEXT`; index `CREATE UNIQUE INDEX IF NOT EXISTS players_discord_id ON players(discord_id) WHERE discord_id IS NOT NULL`
- table `discord_link_codes(code TEXT PRIMARY KEY, discord_id TEXT NOT NULL, discord_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT)`
- setting `discord_required_role_id: ''`
- `linkDiscord(db, steamid, discordId, discordName): { ok: true } | { ok: false; error: 'discord_taken' }`
- `unlinkDiscord(db, steamid): void`
- `playerByDiscordId(db, discordId): PlayerRow | undefined`
- `createLinkCode(db, discordId, discordName): string`
- `consumeLinkCode(db, code, now = new Date()): { discordId: string; discordName: string } | null` (15 min TTL, single use)
- `PlayerRow` gains `discord_id: string | null; discord_name: string | null`
**Tests:** link then lookup; linking a discord id owned by another player returns `discord_taken` and changes neither row; relinking same player to same id is ok; unlink clears; code consumed once; expired code null; unknown code null.
- [ ] write tests, see fail, implement, pass, commit

### Task A2: DiscordApi + gate
**Files:** Create `src/discord/api.ts`, `src/discord/gate.ts`. Test `tests/discordGate.test.ts`.
**Produces:**
```ts
export interface DiscordApi {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  getCurrentUser(accessToken: string): Promise<{ id: string; username: string; globalName: string | null }>;
  getGuildMember(userId: string): Promise<{ roles: string[] } | null>; // null = not a member
}
export function fetchDiscordApi(cfg: DiscordConfig, fetchFn?: typeof fetch): DiscordApi;
export async function applyGate(db: DB, api: DiscordApi, steamid: string): Promise<boolean>; // true if now active
```
`DiscordConfig` in `src/config.ts`: `discord: { clientId, clientSecret, botToken, guildId, lobbyChannelId } | null` (null unless clientId+secret+token+guild set).
Gate rules: banned never changes; active stays active; invited with discord_id and membership (and required role if set) becomes active.
**Tests:** member activates; non-member stays invited; required role missing stays; banned untouched; no discord_id false.
- [ ] tests, implement, pass, commit

### Task A3: OAuth + link-code routes, login return-to
**Files:** Create `src/routes/discordAuth.ts`; modify `src/routes/auth.ts` (support `?next=` stored in signed cookie `pug_next`, relative paths only), `src/server.ts` (register, `ServerDeps.discordApi?`), `/api/me` adds `discord: { id, name } | null`. Test `tests/discordAuth.test.ts`.
**Routes:**
- `GET /auth/discord` (logged in) 302 to `https://discord.com/oauth2/authorize?client_id&redirect_uri=PUBLIC_URL/auth/discord/callback&response_type=code&scope=identify&state=S` where S = HMAC-SHA256(cookieSecret, steamid + ':' + ts) + ':' + ts, valid 10 min.
- `GET /auth/discord/callback?code&state` verify state for session steamid, exchange, get user, link, gate, 302 `/player/<steamid>?discord=linked|taken`.
- `POST /api/discord/link-code {code}` (logged in) consume, link, gate; `{ ok, active }` or 400 `invalid_code` / 409 `discord_taken`.
- `POST /api/discord/unlink` (logged in).
- All 404 when `config.discord` null.
**Tests:** unconfigured 404; authorize redirect carries client id and valid state; callback bad state 400; callback links and activates a guild member; taken 409/redirect; link-code happy path, reuse rejected; unlink; `/auth/steam?next=/link/discord?code=x` returns there after login; `next` of `//evil.com` ignored.
- [ ] tests, implement, pass, commit

### Task A4: Web link UI
**Files:** Create `web/src/routes/LinkDiscord.tsx`; modify `web/src/main.tsx`, `web/src/api.ts`, `web/src/routes/Profile.tsx` (own profile: Connect / linked name + Disconnect), `web/src/routes/Play.tsx` registration panel (Connect Discord as primary when configured; invite code secondary). `/api/me` gives `discordEnabled` too.
**Tests (routes.test.tsx):** link page posts code when signed in; shows sign-in button when not; profile shows Connect only for self.
- [ ] tests, implement, pass, commit

## Part B: Bot core

### Task B1: Hub subscribe + Matchmaker lobby events
**Files:** `src/ws.ts`, `src/matchmaker.ts`. Test `tests/matchmakerEvents.test.ts`.
**Produces:** `Hub.subscribe(fn: (event: string) => void): () => void`; `Matchmaker.on(listener: MatchmakerListener)` with `lobbyCompleted(lobbyId, matchId)`, `lobbyFailed(lobbyId, ready: string[], notReady: string[])`, `lobbyStarted(lobbyId, players: string[])`; `Matchmaker.lobbies(): { id: string; snapshot: LobbySnapshot }[]`.
**Tests:** subscribe receives broadcasts, unsubscribe stops; listener gets started/completed with the created match id; failed carries notReady.
- [ ] tests, implement, pass, commit

### Task B2: BotTransport, fake, discord_messages store
**Files:** Create `src/discord/transport.ts` (interface + types), `tests/fakes/fakeTransport.ts`, `src/discord/messageStore.ts`; schema table `discord_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(kind, ref))`.
```ts
export interface MessagePayload { content?: string; embeds: Embed[]; components: ActionRow[]; allowedMentionIds?: string[] }
export interface BotTransport {
  send(channelId: string, p: MessagePayload): Promise<string>;
  edit(channelId: string, messageId: string, p: MessagePayload): Promise<boolean>; // false = message gone
  remove(channelId: string, messageId: string): Promise<void>;
  onInteraction(h: (i: BotInteraction) => Promise<void>): void;
  registerCommands(defs: SlashCommandDef[]): Promise<void>;
  voice: VoiceOps; // Part C
}
```
**Tests:** store get/upsert/rekey/setState round trip.
- [ ] tests, implement, pass, commit

### Task B3: Presenter
**Files:** `src/discord/presenter.ts`, test `tests/discordPresenter.test.ts`.
**Produces:** `renderPanel(q: PanelView): MessagePayload`, `renderLobby(v: LobbyView): MessagePayload`, `renderMatch(v: MatchView): MessagePayload`, `renderResult(v: ResultView): MessagePayload`, `renderLobbyFailed(v)`, `renderCancelled()`. Views are plain data built by sync from DB + matchmaker (player label = `<@discordId>` if linked else name, SR).
**Tests:** panel slot lines and buttons (`q:join`, `q:leave`, link buttons to PUBLIC_URL); ready phase shows `<t:deadline:R>`, ticks, `l:<id>:ready`; vote phase one button per campaign with counts; match shows both teams, `m:<id>:connect`, voice mentions; result shows score, winner and SR deltas with sign; no em dashes in any rendered string.
- [ ] tests, implement, pass, commit

### Task B4: Controller (interactions)
**Files:** `src/discord/controller.ts`, test `tests/discordController.test.ts`.
**Produces:** `handleInteraction(deps: { db; matchmaker; config }, i: BotInteraction): Promise<InteractionReply>` where reply is `{ ephemeral: true; content: string; components? }`.
**Tests:** unlinked gets link button with a fresh code URL; banned refused; invited refused; join/leave call matchmaker and the site state reflects it; ready/vote for your lobby only; stale lobby id says the ready check is over; connect only for roster of a live match and contains the password; timed-out refused (after F, test added then).
- [ ] tests, implement, pass, commit

### Task B5: Sync loop
**Files:** `src/discord/sync.ts`, test `tests/discordSync.test.ts`.
**Produces:** `class DiscordSync { constructor(deps: { db; matchmaker; hub; transport; config; now? }); start(): Promise<void>; pass(): Promise<void>; stop(): void }`.
Behaviour: on start, cancel open lobby-ref match messages; ensure panel exists; subscribe to hub + matchmaker; debounce 1 s; 15 s interval. Pass: render panel; for each lobby ensure match message (post with mentions); for matches configuring/live/recently ended (message exists) render and edit when hash changed; on completed post result once and mark match message done; aborted marks aborted. Any new post triggers panel repost (delete + send) at most every 5 s.
**Tests:** start posts panel once, second start reuses stored id; queue change edits panel only; lobby start posts match message and reposts panel; lobby completed rekeys to match id; completion posts one result even over repeated passes; unchanged state does no edits; missing panel message (edit returns false) re-sends.
- [ ] tests, implement, pass, commit

### Task B6: discord.js adapter + wiring
**Files:** `package.json` (discord.js), `src/discord/djsTransport.ts`, `src/discord/index.ts` (`startBot`), `src/server.ts` (start when configured and not devMode; suppress webhook notify), `src/index.ts`.
No unit test for the adapter; typecheck + a startBot test with fake transport proving wiring and that unconfigured returns null.
- [ ] implement, typecheck, test, commit

## Part C: Voice

### Task C1: Voice channels
**Files:** `src/discord/voice.ts`, schema `discord_voice(match_id INTEGER PRIMARY KEY, category_id TEXT NOT NULL, team_a_id TEXT NOT NULL, team_b_id TEXT NOT NULL, ended_at TEXT, deleted_at TEXT)`, setting `discord_voice_enabled: '1'`, `VoiceOps` in transport: `createMatchChannels(matchId, teamA: string[], teamB: string[]): Promise<{categoryId; teamAId; teamBId}>`, `memberVoiceChannel(userId): Promise<string|null>`, `move(userId, channelId)`, `channelMemberCount(channelId): Promise<number|null>` (null = gone), `deleteChannels(ids: string[])`.
`ensureMatchVoice(deps, matchId)`, `sweepVoice(deps, now)`; called from sync.
**Tests:** creates once per match with linked ids only; moves only users in voice; disabled setting does nothing; sweep deletes when empty after end, forces at 10 min, treats gone as deleted; failure logged, no throw.
- [ ] tests, implement, pass, commit

## Part D: Slash commands

### Task D1: Extract profile/leaderboard queries
**Files:** Create `src/playerQueries.ts` with `leaderboardRows(db, seasonId)`, `profileSummary(db, steamid)`, `recentMatchesFor(db, steamid | null, limit)`; `src/routes/stats.ts` uses them. Existing stats tests must stay green.
- [ ] refactor, tests pass, commit

### Task D2: Commands
**Files:** `src/discord/commands.ts`, test `tests/discordCommands.test.ts`. Defs for `/profile [user]`, `/leaderboard`, `/matches [user]`, `/queue`, `/link`; `handleCommand(deps, i)` returns payload + ephemeral flag.
**Tests:** profile of linked user shows SR, record and match links; unlinked target message; leaderboard top 10 ranked only; matches lists links; link gives code url.
- [ ] tests, implement, pass, commit

## Part E: Admin

### Task E1: requireAdmin + audit + players API
**Files:** `src/routes/guards.ts` (`makeRequireAdmin`), `src/admin/audit.ts` (`logAdmin(db, adminId, action, target, detail)`), `src/admin/players.ts`, `src/routes/admin.ts`; schema `admin_actions`, `bans`, `player_notes`. Test `tests/adminPlayers.test.ts`.
Routes: `GET /api/admin/players?q=`, `GET /api/admin/players/:id`, `POST .../ban {reason, minutes?}`, `.../unban`, `.../activate`, `.../admin {isAdmin}`, `.../unlink-discord`, `.../notes {text}`, `GET /api/admin/audit`.
Ban removes from queue via matchmaker. Expired bans lifted by `liftExpiredBans(db)` in the 60 s reaper.
**Tests:** non-admin 403 on every route; ban sets status + row + audit + dequeues; unban; cannot remove own admin; expiry lifts; notes list.
- [ ] tests, implement, pass, commit

### Task E2: Matches, servers, queue, void + recompute
**Files:** `src/admin/matches.ts`, `src/rating.ts` (`recomputeSeasonRatings`), `src/routes/admin.ts`; columns `matches.voided_at`, `matches.void_reason`. Test `tests/adminMatches.test.ts`, `tests/recompute.test.ts`.
Routes: `GET /api/admin/overview` (open matches, servers, queue, recent completed), `POST /api/admin/matches/:id/abort`, `POST /api/admin/matches/:id/void {reason}`, `POST /api/admin/servers/:id/idle`, `POST /api/admin/queue/remove {steamid}`.
**Tests:** recompute reproduces incremental ratings; void excludes match and changes later ratings; abort releases server (fake releaser) and clears live; idle calls releaser; queue remove; audit rows.
- [ ] tests, implement, pass, commit

### Task E3: Settings schema + API
**Files:** `src/settingsSchema.ts`, routes `GET /api/admin/settings`, `PUT /api/admin/settings/:key {value}`. Test `tests/adminSettings.test.ts`.
**Tests:** unknown key 404; int bounds; campaigns subset validated against known campaigns; bool; saved + audited.
- [ ] tests, implement, pass, commit

### Task E4: Admin web page
**Files:** `web/src/routes/Admin.tsx` (+ small components under `web/src/components/admin/`), `web/src/api.ts`, nav link when `isAdmin`, styles. Tabs: Players, Matches, Reports, Settings, Audit.
**Tests (routes.test.tsx):** non-admin sees not-authorised; players tab lists and ban form posts.
- [ ] tests, implement, screenshot check, commit

## Part F: Reports + penalties

### Task F1: Penalties
**Files:** `src/penalties.ts`, schema `penalties`, settings `penalties_enabled '1'`, `penalty_window_days '7'`, `penalty_minutes '[5,15,60,1440]'`; hooks in `Matchmaker` (lobbyFailed -> ready_fail; join refuses), `src/noShow.ts` (rule 1 -> no_show), `stateFor.timeoutUntil`; admin clear route; Play page countdown. Test `tests/penalties.test.ts`.
**Tests:** ladder 5/15/60/1440/1440; window excludes old; cleared excluded; ready fail records only not-ready; no-show rule 1 records unconnected only, rule 2 none; join refused with until; disabled setting.
- [ ] tests, implement, pass, commit

### Task F2: Reports
**Files:** `src/reports.ts`, schema `reports`, routes `POST /api/matches/:id/reports`, `GET /api/matches/:id/report-eligibility`, admin `GET /api/admin/reports`, `POST /api/admin/reports/:id/resolve {status, note}`; web report dialog on MatchDetail; Reports tab. Test `tests/reports.test.ts`.
**Tests:** only roster, within 48 h, not self, target on roster, one per triple, text limit; admin resolve audited.
- [ ] tests, implement, pass, commit

## Ship

- [ ] full test + typecheck + build; screenshots of admin + link pages against a scratch DB copy with servers deleted
- [ ] deploy-web when safe; watch logs for bot login; verify panel in #queue-here via API read
- [ ] morning notes file + memory update
