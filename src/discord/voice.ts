import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { publishAdminEvent } from '../adminFeed.js';
import type { VoiceHook } from './sync.js';
import type { VoiceOps } from './transport.js';

const FORCE_DELETE_MS = 10 * 60 * 1000;

/**
 * How long after this process starts the sweep refuses to act.
 *
 * A member count is only as good as discord.js's voice state cache, and that
 * cache is built from the gateway: for the first moments after a restart every
 * channel truthfully reports nobody in it. A sweep in that window reads
 * "empty", which skips the handback (it only runs for channels that are NOT
 * empty) and deletes channels with people sitting in them, dropping them out
 * of voice. A deploy is exactly when that would happen, which is exactly when
 * people have been told to expect a brief blip and would blame the blip.
 *
 * Thirty seconds against a gateway handshake that takes two or three. The cost
 * of waiting is a finished match's channels lingering half a minute longer.
 */
const SETTLE_MS = 30_000;

interface VoiceRow {
  match_id: number;
  category_id: string;
  team_a_id: string;
  team_b_id: string;
  ended_at: string | null;
}

/**
 * Per-match team voice channels.
 *
 * Everyone can see them, only that team's linked players can join. Players
 * already in some voice channel are moved in; nobody is pulled into voice who
 * was not there. Channels go once the match is over and they are empty, or
 * ten minutes after the end regardless, so a post-game chat is not cut off
 * and an abandoned channel does not linger. Anyone still in them at that
 * point is handed back to where they came from, or to the lobby, rather than
 * dropped out of voice with the channel.
 */
export class VoiceChannels implements VoiceHook {
  /** Matches whose creation failed in this process. Not retried every 15 s
   *  pass: a permissions problem would otherwise spam the error log. */
  private failed = new Set<number>();

  /** Matches already reported as having stranded someone. Dispersal runs twice
   *  for a match nobody could be moved out of, once when it ends and once when
   *  the force-delete fires, and the admin feed does not need to hear about the
   *  same failure twice. */
  private reported = new Set<number>();

  /** When this instance was built, which for the real one is process start. */
  private readonly startedMs: number;

  constructor(private deps: { db: DB; voice: VoiceOps; now?: () => number; settleMs?: number }) {
    this.startedMs = this.now();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Whether the voice state cache can be trusted yet. See SETTLE_MS. */
  private settled(): boolean {
    return this.now() - this.startedMs >= (this.deps.settleMs ?? SETTLE_MS);
  }

  async ensure(matchId: number): Promise<void> {
    const { db, voice } = this.deps;
    if (getSetting(db, 'discord_voice_enabled') !== '1') return;
    if (this.failed.has(matchId)) return;
    if (db.prepare('SELECT 1 FROM discord_voice WHERE match_id = ?').get(matchId)) return;

    const roster = db.prepare(
      'SELECT mp.team, p.discord_id FROM match_players mp JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ? ORDER BY mp.rowid',
    ).all(matchId) as { team: 'a' | 'b'; discord_id: string | null }[];
    const ids = (team: 'a' | 'b') => roster.filter((r) => r.team === team && r.discord_id).map((r) => r.discord_id!);

    try {
      const made = await voice.createMatchChannels(
        `PUG #${matchId}`,
        { label: 'Team A', userIds: ids('a') },
        { label: 'Team B', userIds: ids('b') },
        getSetting(db, 'discord_staff_role_id') || null,
      );
      db.prepare('INSERT INTO discord_voice (match_id, category_id, team_a_id, team_b_id) VALUES (?, ?, ?, ?)')
        .run(matchId, made.categoryId, made.teamAId, made.teamBId);
      const remember = db.prepare('INSERT OR REPLACE INTO discord_voice_origin (match_id, user_id, channel_id) VALUES (?, ?, ?)');
      for (const [team, channel] of [['a', made.teamAId], ['b', made.teamBId]] as const) {
        for (const userId of ids(team)) {
          try {
            const from = await voice.memberVoiceChannel(userId);
            if (!from) continue;
            // Remembered before the move, so the sweep can hand them back.
            remember.run(matchId, userId, from);
            await voice.move(userId, channel);
          } catch (err) {
            console.error(`[discord] moving ${userId} into team voice failed:`, err);
          }
        }
      }
    } catch (err) {
      this.failed.add(matchId);
      console.error(`[discord] creating voice channels for match ${matchId} failed:`, err);
      publishAdminEvent({ kind: 'problem', matchId, text: `Could not create team voice channels for match #${matchId}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  channelsFor(matchId: number): { teamAId: string; teamBId: string } | null {
    const row = this.deps.db.prepare(
      'SELECT team_a_id, team_b_id FROM discord_voice WHERE match_id = ? AND deleted_at IS NULL',
    ).get(matchId) as { team_a_id: string; team_b_id: string } | undefined;
    return row ? { teamAId: row.team_a_id, teamBId: row.team_b_id } : null;
  }

  /**
   * Hand everyone still sitting in the team channels back before those
   * channels vanish: the channel they were pulled out of, else the configured
   * lobby. Discord drops anyone left in a deleted voice channel out of voice
   * altogether, which is a rude way to end a post-game conversation.
   *
   * Never throws and never blocks the delete: a match whose channels outlive
   * their cleanup is worse than a player who has to rejoin voice by hand.
   */
  private async disperse(r: VoiceRow): Promise<void> {
    const { db, voice } = this.deps;
    const lobby = getSetting(db, 'discord_lobby_channel_id') || null;
    const origins = new Map(
      (db.prepare('SELECT user_id, channel_id FROM discord_voice_origin WHERE match_id = ?').all(r.match_id) as
        { user_id: string; channel_id: string }[]).map((o) => [o.user_id, o.channel_id] as const),
    );
    const doomed = new Set([r.team_a_id, r.team_b_id, r.category_id]);
    let stranded = 0;
    for (const channelId of [r.team_a_id, r.team_b_id]) {
      const members = await voice.channelMemberIds(channelId).catch(() => null);
      for (const userId of members ?? []) {
        const origin = origins.get(userId);
        // An origin inside this match is no help: it is about to go as well.
        const targets = [origin && !doomed.has(origin) ? origin : null, lobby].filter((c): c is string => !!c);
        let moved = false;
        for (const target of targets) {
          try {
            await voice.move(userId, target);
            moved = true;
            break;
          } catch (err) {
            console.error(`[discord] returning ${userId} to ${target} failed:`, err);
          }
        }
        if (!moved) stranded++;
      }
    }
    if (stranded > 0 && !this.reported.has(r.match_id)) {
      this.reported.add(r.match_id);
      publishAdminEvent({
        kind: 'problem',
        matchId: r.match_id,
        text: `Could not return ${stranded} player${stranded === 1 ? '' : 's'} to a voice channel when match #${r.match_id}'s channels were removed; they were dropped out of voice. Check the lobby channel id and the bot's Move Members permission.`,
      });
    }
  }

  async sweep(): Promise<void> {
    const { db, voice } = this.deps;
    // Nothing at all, not even the ended_at stamp: that stamp starts the
    // force-delete clock, and starting it from a sweep whose member counts
    // are meaningless is how a cold cache would still end up deleting an
    // occupied channel ten minutes later.
    if (!this.settled()) return;
    const rows = db.prepare(
      `SELECT v.match_id, v.category_id, v.team_a_id, v.team_b_id, v.ended_at
       FROM discord_voice v JOIN matches m ON m.id = v.match_id
       WHERE v.deleted_at IS NULL AND m.state IN ('completed', 'aborted')`,
    ).all() as VoiceRow[];
    const now = this.now();
    for (const r of rows) {
      const justEnded = !r.ended_at;
      // Held in a local as well as on the row: the row's type is nullable and
      // the narrowing that used to come from the `if` is gone now that the
      // branch is keyed off `justEnded`.
      const endedAt = r.ended_at ?? new Date(now).toISOString();
      if (justEnded) {
        r.ended_at = endedAt;
        db.prepare('UPDATE discord_voice SET ended_at = ? WHERE match_id = ?').run(endedAt, r.match_id);
      }
      try {
        // The match is over, so the teams go back where they came from now
        // rather than whenever the channels happen to be cleaned up. Waiting
        // left both teams sitting in separate channels after a game, which is
        // the opposite of what anyone wants once the gg is due.
        if (justEnded) await this.disperse(r);
        const a = await voice.channelMemberCount(r.team_a_id);
        const b = await voice.channelMemberCount(r.team_b_id);
        const empty = (a ?? 0) === 0 && (b ?? 0) === 0;
        const overdue = now - Date.parse(endedAt) >= FORCE_DELETE_MS;
        if (!empty && !overdue) continue;
        // Not redundant with the dispersal above: someone can rejoin a
        // channel in the window before it is deleted, and the ten minute
        // force is what catches anyone the first pass could not move.
        if (!empty) await this.disperse(r);
        for (const id of [r.team_a_id, r.team_b_id, r.category_id]) await voice.deleteChannel(id);
        db.prepare('UPDATE discord_voice SET deleted_at = ? WHERE match_id = ?').run(new Date(now).toISOString(), r.match_id);
        db.prepare('DELETE FROM discord_voice_origin WHERE match_id = ?').run(r.match_id);
      } catch (err) {
        console.error(`[discord] cleaning up voice for match ${r.match_id} failed:`, err);
      }
    }
  }
}
