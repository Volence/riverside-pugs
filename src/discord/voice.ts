import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import type { VoiceHook } from './sync.js';
import type { VoiceOps } from './transport.js';

const FORCE_DELETE_MS = 10 * 60 * 1000;

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
 * and an abandoned channel does not linger.
 */
export class VoiceChannels implements VoiceHook {
  /** Matches whose creation failed in this process. Not retried every 15 s
   *  pass: a permissions problem would otherwise spam the error log. */
  private failed = new Set<number>();

  constructor(private deps: { db: DB; voice: VoiceOps; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
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
      );
      db.prepare('INSERT INTO discord_voice (match_id, category_id, team_a_id, team_b_id) VALUES (?, ?, ?, ?)')
        .run(matchId, made.categoryId, made.teamAId, made.teamBId);
      for (const [team, channel] of [['a', made.teamAId], ['b', made.teamBId]] as const) {
        for (const userId of ids(team)) {
          try {
            if (await voice.memberVoiceChannel(userId)) await voice.move(userId, channel);
          } catch (err) {
            console.error(`[discord] moving ${userId} into team voice failed:`, err);
          }
        }
      }
    } catch (err) {
      this.failed.add(matchId);
      console.error(`[discord] creating voice channels for match ${matchId} failed:`, err);
    }
  }

  channelsFor(matchId: number): { teamAId: string; teamBId: string } | null {
    const row = this.deps.db.prepare(
      'SELECT team_a_id, team_b_id FROM discord_voice WHERE match_id = ? AND deleted_at IS NULL',
    ).get(matchId) as { team_a_id: string; team_b_id: string } | undefined;
    return row ? { teamAId: row.team_a_id, teamBId: row.team_b_id } : null;
  }

  async sweep(): Promise<void> {
    const { db, voice } = this.deps;
    const rows = db.prepare(
      `SELECT v.match_id, v.category_id, v.team_a_id, v.team_b_id, v.ended_at
       FROM discord_voice v JOIN matches m ON m.id = v.match_id
       WHERE v.deleted_at IS NULL AND m.state IN ('completed', 'aborted')`,
    ).all() as VoiceRow[];
    const now = this.now();
    for (const r of rows) {
      if (!r.ended_at) {
        r.ended_at = new Date(now).toISOString();
        db.prepare('UPDATE discord_voice SET ended_at = ? WHERE match_id = ?').run(r.ended_at, r.match_id);
      }
      try {
        const a = await voice.channelMemberCount(r.team_a_id);
        const b = await voice.channelMemberCount(r.team_b_id);
        const empty = (a ?? 0) === 0 && (b ?? 0) === 0;
        const overdue = now - Date.parse(r.ended_at) >= FORCE_DELETE_MS;
        if (!empty && !overdue) continue;
        for (const id of [r.team_a_id, r.team_b_id, r.category_id]) await voice.deleteChannel(id);
        db.prepare('UPDATE discord_voice SET deleted_at = ? WHERE match_id = ?').run(new Date(now).toISOString(), r.match_id);
      } catch (err) {
        console.error(`[discord] cleaning up voice for match ${r.match_id} failed:`, err);
      }
    }
  }
}
