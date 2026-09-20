import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { resolveCampaignForMap } from './campaignRegistry.js';
import { currentSeasonId } from './players.js';
import { publishAdminEvent } from './adminFeed.js';
import { QUEUE_SIZE } from './queue.js';

/** How long to wait after MATCH_CREATE before committing with whatever roster
 *  lines arrived. The burst is emitted in one tick by the plugin, so this only
 *  matters when MATCH_CREATE_END is the datagram that got dropped. */
const BURST_GRACE_MS = 5_000;

/** Players per side. A team over this is the signature of one person on two
 *  accounts, which is what `addLateJoiner` and `reportOverfull` exist for. */
const TEAM_SIZE = QUEUE_SIZE / 2;

export interface SelfStartedDeps {
  db: DB;
  /** Only `register` is used; typed narrowly so tests need no real socket. */
  listener: { register(token: string): void };
  /** Hand the allocated match id back to the plugin (rcon `sm_pug_setid`). */
  setMatchId: (token: string, matchId: number, serverId: number) => Promise<void>;
  /** Which server row a match from this datagram source belongs to. Null
   *  means "refuse to adopt". */
  resolveServerId: (source: string) => number | null;
  adminSteamIds?: string[];
  notify?: (msg: string) => void;
}

interface Pending {
  map: string | null;
  expected: number;
  roster: Map<string, { team: 'a' | 'b'; name: string }>;
  timer: ReturnType<typeof setTimeout> | null;
  committed: boolean;
  /** Sender of the first line seen for this token. */
  source: string;
}

/**
 * Adopts matches that were started from inside the game with `!load_4v4p`.
 *
 * The normal direction is backend -> plugin: we allocate a match, then tell the
 * server about it. This is the reverse. The plugin invents a token, announces a
 * roster over the lossy UDP feed, and we materialise the match rows and hand
 * back the id it could not know (`matches.id` is an autoincrement we own).
 *
 * Because the feed is UDP, the three line kinds can arrive in any order and any
 * of them can be missing. So roster lines are accumulated into a set keyed by
 * token, and a commit is triggered by whichever happens first: the expected
 * number of roster lines arriving, MATCH_CREATE_END, or a short grace timer.
 * Commit is guarded so it happens exactly once per token.
 */
export class SelfStartedMatches {
  private pending = new Map<string, Pending>();

  constructor(private deps: SelfStartedDeps) {}

  handle(ev: LogEvent, source = ''): void {
    switch (ev.kind) {
      case 'match_create': {
        const p = this.ensure(ev.token, source);
        p.map = ev.map;
        p.expected = ev.players;
        this.arm(ev.token, p);
        this.maybeCommit(ev.token);
        break;
      }
      case 'match_roster': {
        // A roster line for a match that is already live is a late joiner or
        // a sub the plugin rostered at a go-live (RosterLateJoiners). Add
        // them to the match directly; there is no burst to wait for.
        if (this.addLateJoiner(ev)) break;
        const p = this.ensure(ev.token, source);
        p.roster.set(ev.steamid, { team: ev.team, name: ev.name });
        this.maybeCommit(ev.token);
        break;
      }
      case 'match_create_end': {
        const p = this.ensure(ev.token, source);
        p.expected = ev.players;
        this.commit(ev.token);
        break;
      }
      default:
        break;
    }
  }

  /** True when the line belonged to a live match and was applied to it. A
   *  repeat of a line already applied is a no-op that still returns true. */
  private addLateJoiner(ev: Extract<LogEvent, { kind: 'match_roster' }>): boolean {
    const { db } = this.deps;
    const live = db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
      .get(ev.token) as { id: number } | undefined;
    if (!live) return false;

    // A roster line for a team that is already full is either a sub for
    // somebody who left, or a second account belonging to somebody already
    // on it. Nothing in the line distinguishes the two, so the account
    // decides: a sub is a person this site has seen sign in, and the shape
    // that has never been anything but an alt is a SteamID with no player row
    // at all, arriving mid-match, onto a team with no room.
    //
    // Refusing matters more than it looks. Letting it through does not just
    // add a name: it invents a player row, which earns a rating, which scores
    // the team as five-a-side for the rest of the match and every match after
    // (see the over-full tests). Refusing costs that account its stats for
    // this match, which is the right trade against corrupting everyone's.
    const already = db.prepare(
      'SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?',
    ).get(live.id, ev.steamid);
    if (!already && this.teamCount(live.id, ev.team) >= TEAM_SIZE) {
      const known = db.prepare("SELECT 1 FROM players WHERE steamid = ? AND status = 'active'")
        .get(ev.steamid);
      if (!known) {
        publishAdminEvent({
          kind: 'problem',
          matchId: live.id,
          text: `Refused to roster ${ev.name} (${ev.steamid}) onto team ${ev.team.toUpperCase()} of match #${live.id}: the team already has ${TEAM_SIZE} and that account has never signed in. Likely a second account for someone already on the team.`,
        });
        return true;
      }
      publishAdminEvent({
        kind: 'problem',
        matchId: live.id,
        text: `${ev.name} (${ev.steamid}) was rostered onto team ${ev.team.toUpperCase()} of match #${live.id}, which already had ${TEAM_SIZE}. Allowed as a sub because the account has signed in, but the team is now five.`,
      });
    }

    const admins = this.deps.adminSteamIds ?? [];
    const isAdmin = admins.includes(ev.steamid);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO players (steamid, name, avatar, status, is_admin)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(steamid) DO NOTHING`,
      ).run(ev.steamid, ev.name, isAdmin ? 'active' : 'invited', isAdmin ? 1 : 0);
      const r = db.prepare(
        'INSERT OR IGNORE INTO match_players (match_id, player_id, team, joined_map) VALUES (?, ?, ?, ?)',
      ).run(live.id, ev.steamid, ev.team, ev.joinedMap);
      if (r.changes > 0) console.log(`[selfStarted] match ${live.id}: rostered ${ev.steamid} on ${ev.team} at map ${ev.joinedMap}`);
    })();
    return true;
  }

  /** How many players are rostered on one side of a match. */
  private teamCount(matchId: number, team: 'a' | 'b'): number {
    const row = this.deps.db.prepare(
      'SELECT COUNT(*) AS n FROM match_players WHERE match_id = ? AND team = ?',
    ).get(matchId, team) as { n: number };
    return row.n;
  }

  /** Raise a problem for any side of a freshly adopted match that came in
   *  over TEAM_SIZE, naming the members so an admin can tell at a glance
   *  which two are one person. Published after the transaction commits, so a
   *  listener that throws cannot roll the match back. */
  private reportOverfull(matchId: number, p: Pending): void {
    for (const team of ['a', 'b'] as const) {
      const members = [...p.roster.entries()].filter(([, v]) => v.team === team);
      if (members.length <= TEAM_SIZE) continue;
      const who = members.map(([id, v]) => `${v.name} (${id})`).join(', ');
      publishAdminEvent({
        kind: 'problem',
        matchId,
        text: `Match #${matchId} was adopted with ${members.length} players on team ${team.toUpperCase()}, not ${TEAM_SIZE}: ${who}. Check for one person on two accounts before this match is rated.`,
      });
    }
  }

  private ensure(token: string, source: string): Pending {
    let p = this.pending.get(token);
    if (!p) {
      p = { map: null, expected: 0, roster: new Map(), timer: null, committed: false, source };
      this.pending.set(token, p);
    }
    return p;
  }

  /** Commit on the grace timer too, so a dropped MATCH_CREATE_END cannot strand
   *  a match that is already being played. */
  private arm(token: string, p: Pending): void {
    if (p.timer) return;
    p.timer = setTimeout(() => this.commit(token), BURST_GRACE_MS);
    // Never hold the process open for this.
    if (typeof p.timer === 'object' && 'unref' in p.timer) p.timer.unref();
  }

  private maybeCommit(token: string): void {
    const p = this.pending.get(token);
    if (!p || !p.map) return;
    if (p.expected > 0 && p.roster.size >= p.expected) this.commit(token);
  }

  private commit(token: string): void {
    const p = this.pending.get(token);
    if (!p || p.committed) return;
    if (!p.map || p.roster.size === 0) return;

    const campaign = resolveCampaignForMap(this.deps.db, p.map);
    if (!campaign) {
      // Better to drop the match than to file a custom or L4D2 map under a
      // real campaign and pollute that campaign's history.
      console.error(`[selfStarted] unknown map ${p.map}; refusing to adopt match ${token}`);
      this.finish(token, p);
      return;
    }

    const serverId = this.deps.resolveServerId(p.source);
    if (serverId === null) {
      console.error(`[selfStarted] no server row resolved; refusing to adopt match ${token}`);
      this.finish(token, p);
      return;
    }

    const { db } = this.deps;
    const existing = db.prepare('SELECT id FROM matches WHERE token = ?').get(token) as { id: number } | undefined;
    if (existing) {
      this.finish(token, p);
      return;
    }

    p.committed = true;
    let matchId: number;
    try {
      matchId = db.transaction(() => {
        // Insert-if-absent, never update: a player who has signed in already
        // has a real Steam persona and avatar, and an in-game nickname must
        // not overwrite them.
        const insPlayer = db.prepare(
          `INSERT INTO players (steamid, name, avatar, status, is_admin)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(steamid) DO NOTHING`,
        );
        const admins = this.deps.adminSteamIds ?? [];
        for (const [steamid, { name }] of p.roster) {
          const isAdmin = admins.includes(steamid);
          insPlayer.run(steamid, name, isAdmin ? 'active' : 'invited', isAdmin ? 1 : 0);
        }

        // went_live_at is deliberately NOT stamped. It is the no-show reaper's
        // scope guard (src/noShow.ts), and an adopted match can never satisfy
        // that reaper: its rule 1 counts match_players.connected_at, which is
        // fed only by `PLAYER ... event=connect`, which the plugin emits only
        // from OnClientPostAdminCheck for a client joining a match that
        // already holds a roster. SnapshotRoster builds an adopted roster from
        // players who are ALREADY in game, so the forward never fires for any
        // of them and all eight stay NULL forever. Stamping this column here
        // would enrol the match in the reaper and get it aborted ten minutes
        // after go-live while it was being played, with the box handed to the
        // next queue pop to changelevel everyone out of. The reaper exists for
        // web-driven matches, which setupMatch stamps.
        const id = Number(
          db
            .prepare(
              `INSERT INTO matches (season_id, state, campaign, server_id, token)
               VALUES (?, 'live', ?, ?, ?)`,
            )
            .run(currentSeasonId(db), campaign, serverId, token).lastInsertRowid,
        );

        const insMp = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
        for (const [steamid, { team }] of p.roster) insMp.run(id, steamid, team);

        // The box is now busy. Without this, claimIdle could hand the same
        // server to a match queued on the website while a PUG is being played
        // on it. finishMatch releases it again.
        db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(serverId);
        return id;
      })();
    } catch (err) {
      console.error(`[selfStarted] failed to adopt match ${token}:`, err);
      p.committed = false;
      this.finish(token, p);
      return;
    }

    // Nobody is dropped, unlike the late-joiner path. These players were all
    // on the server when the match was adopted, and which of a team's five is
    // the extra one is not knowable from the burst: the duplicate account may
    // well be the one that goes on to play. Losing a real player's whole match
    // is worse than an over-full roster, so the match is taken as reported and
    // the problem is raised instead. Outside the transaction, so that a
    // subscriber cannot roll back a match that is already being played.
    this.reportOverfull(matchId, p);

    // Register before the rcon round trip: MATCH_START can arrive immediately.
    this.deps.listener.register(token);

    // Fire and forget. If this fails the match is still recorded; the dump will
    // later mismatch on match id and finishMatch logs it rather than corrupting
    // anything. Losing the row entirely would be the worse outcome.
    void this.deps.setMatchId(token, matchId, serverId).catch((err) => {
      console.error(`[selfStarted] sm_pug_setid failed for match ${matchId}:`, err);
    });

    this.deps.notify?.(
      `🎮 Match #${matchId} started in-game: ${campaign} with ${p.roster.size} players`,
    );
    this.finish(token, p);
  }

  private finish(token: string, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(token);
  }
}
