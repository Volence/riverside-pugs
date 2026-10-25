import type { DB } from '../db.js';
import type { VoiceOps } from '../discord/transport.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import * as N from './entries.js';
import type { EventRow } from './events.js';

/** Discord's limit on a channel or category name. */
const NAME_MAX = 100;
/** A finished event keeps its team channels this long, so teams can talk
 *  over the final before the channels go. */
export const FINISHED_GRACE_MS = 10 * 60_000;

interface VoiceRow { entry_id: number; event_id: number; category_id: string; channel_id: string; created_at: string; deleted_at: string | null }

/** Events whose teams are known and not over: a team event once its entry
 *  list is final, a draft once its teams are published. */
const OPEN_SQL = `SELECT * FROM events WHERE status IN ('registration','checkin','live') AND locked_at IS NOT NULL
  AND (entry_kind = 'team' OR teams_made_at IS NOT NULL) ORDER BY id`;

/** Match statuses from the room opening to the result standing: the match's
 *  two team channels sit under a heading of its own meanwhile. */
const PLAYING = ['veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold'];
const PLAYING_SQL = PLAYING.map((x) => `'${x}'`).join(', ');

/**
 * When an entry's channel should go: at once for a team that dropped out, was
 * disqualified or was eliminated at a stage's end; FINISHED_GRACE_MS after the
 * match that knocked it out of an elimination bracket (its last finished
 * match there was a loss and no unfinished match has it); otherwise null.
 */
export function outSince(db: DB, entry: N.EntryRow): number | null {
  if (entry.status === 'dropped' || entry.status === 'disqualified' || entry.status === 'eliminated') return 0;
  const busy = db.prepare(
    `SELECT 1 FROM event_matches WHERE event_id = ? AND (entry_a = ? OR entry_b = ?) AND status NOT IN ('done','forfeit','bye') LIMIT 1`,
  ).get(entry.event_id, entry.id, entry.id);
  if (busy) return null;
  const last = db.prepare(
    `SELECT m.winner_entry, m.finished_at FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE m.event_id = ? AND (m.entry_a = ? OR m.entry_b = ?) AND m.status IN ('done','forfeit')
       AND s.type IN ('single_elim','double_elim')
     ORDER BY m.finished_at DESC, m.id DESC LIMIT 1`,
  ).get(entry.event_id, entry.id, entry.id) as { winner_entry: number | null; finished_at: string | null } | undefined;
  if (!last || last.winner_entry === null || last.winner_entry === entry.id) return null;
  return (last.finished_at ? Date.parse(last.finished_at) : 0) + FINISHED_GRACE_MS;
}

/** Open channels for every entry of a tournament booking's match: when both
 *  teams have one, the booking makes no voice of its own (bookings/voice.ts). */
export function teamVoiceCovers(db: DB, bookingId: number): boolean {
  const m = db.prepare('SELECT entry_a, entry_b FROM event_matches WHERE booking_id = ? ORDER BY id DESC LIMIT 1')
    .get(bookingId) as { entry_a: number | null; entry_b: number | null } | undefined;
  if (!m || m.entry_a === null || m.entry_b === null) return false;
  const open = db.prepare('SELECT 1 FROM event_entry_voice WHERE entry_id = ? AND deleted_at IS NULL');
  return !!open.get(m.entry_a) && !!open.get(m.entry_b);
}

/** The team's own channel, open, or null. */
export function teamVoiceChannel(db: DB, entryId: number): string | null {
  const row = db.prepare('SELECT channel_id FROM event_entry_voice WHERE entry_id = ? AND deleted_at IS NULL').get(entryId) as { channel_id: string } | undefined;
  return row?.channel_id ?? null;
}

/**
 * An event's team voice (owner 2026-10-24, after Draft Tourney #1: teams
 * were in the ban phase with nowhere to talk, because a match's voice is only
 * made once its server is booked). As soon as an event's teams are known, one
 * private category named after the event with a private voice channel per
 * team; each team's roster (starters, subs, coach) is let in and kept in step
 * every minute, so a replace or a stand-in gets the new player in and the old
 * one out. A team that drops out or is disqualified loses its channel; the
 * rest go a little after the event finishes (or at once on a cancel), with
 * everyone in them moved to the lobby first, as a booking's voice is.
 *
 * Same contract as BookingVoice: nothing here throws to its caller, a bot
 * without permissions or not connected leaves the event running exactly as
 * it would without voice, and a failure is reported to staff once.
 */
export class TeamVoice {
  /** Events whose channels could not be made in this process: reported once
   *  and not tried again until a restart. */
  private readonly failed = new Set<number>();
  /** Entries whose channel could not be deleted, already reported. */
  private readonly closeReported = new Set<number>();
  /** Who this process let in, per entry; empty after a restart, when the
   *  first sync lets everyone in again (setMemberAccess is idempotent). */
  private readonly granted = new Map<number, Set<string>>();
  private ticking = false;

  constructor(private readonly deps: { db: DB; voice: () => VoiceOps | null; now?: () => number }) {}

  private nowIso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private rowsOf(eventId: number): VoiceRow[] {
    return this.deps.db.prepare('SELECT * FROM event_entry_voice WHERE event_id = ? AND deleted_at IS NULL ORDER BY entry_id').all(eventId) as VoiceRow[];
  }

  /** The discord ids of an entry's roster. */
  private desired(entryId: number): Set<string> {
    const r = N.rosterOf(this.deps.db, entryId);
    const out = new Set<string>();
    for (const s of [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])]) {
      const id = getPlayer(this.deps.db, s)?.discord_id;
      if (id) out.add(id);
    }
    return out;
  }

  /** The minute tick: make, sync and close. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const voice = this.deps.voice();
      if (!voice) return;
      // Finished headings close first: a team going straight into its next
      // match must land under the new heading, not be moved back out of it
      // by the old one's close (Draft Tourney #1, matches 7 to 8 and 9).
      // Closing runs with voice switched off as well, so turning it off
      // never strands channels.
      await this.closeHeadings(voice);
      const enabled = getSetting(this.deps.db, 'discord_voice_enabled') === '1';
      if (enabled) {
        for (const ev of this.deps.db.prepare(OPEN_SQL).all() as EventRow[]) {
          try {
            await this.ensure(voice, ev);
            await this.sync(voice, ev);
            await this.headings(voice, ev);
          } catch (err) {
            console.error(`[events] team voice of event ${ev.id} failed:`, err);
          }
        }
      }
      await this.closeDone(voice);
    } catch (err) {
      console.error('[events] team voice tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Make the event's category and a channel per active entry, once. */
  private async ensure(voice: VoiceOps, ev: EventRow): Promise<void> {
    const { db } = this.deps;
    if (this.failed.has(ev.id)) return;
    // Made once per event: an entry restored after that gets no channel, and
    // its matches fall back to the booking's own voice (teamVoiceCovers).
    if (db.prepare('SELECT 1 FROM event_entry_voice WHERE event_id = ? LIMIT 1').get(ev.id)) return;
    const entries = N.entriesOf(db, ev.id).filter(N.isActive);
    if (entries.length === 0) return;
    try {
      const made = await voice.createTeamChannels(
        `${ev.name}: Teams`.slice(0, NAME_MAX),
        entries.map((e) => e.name.slice(0, NAME_MAX)),
        getSetting(db, 'discord_staff_role_id') || null,
      );
      const at = this.nowIso();
      const ins = db.prepare('INSERT INTO event_entry_voice (entry_id, event_id, category_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?)');
      db.transaction(() => entries.forEach((e, i) => ins.run(e.id, ev.id, made.categoryId, made.channelIds[i], at)))();
      if (made.staffDropped) {
        publishAdminEvent({
          kind: 'problem',
          text: `${ev.name}: Discord refused the staff role on the team voice channels, so staff cannot see them. Check the bot may grant discord_staff_role_id.`,
        });
      }
    } catch (err) {
      this.failed.add(ev.id);
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[events] ${ev.id}: creating the team voice channels failed:`, err);
      publishAdminEvent({ kind: 'problem', text: `${ev.name}: could not create the team voice channels (${why}). Matches fall back to their own voice.` });
    }
  }

  /** Let each roster in and the players no longer on it out (they are not
   *  kicked from the channel, as with a booking). */
  private async sync(voice: VoiceOps, ev: EventRow): Promise<void> {
    for (const row of this.rowsOf(ev.id)) {
      const entry = N.getEntry(this.deps.db, row.entry_id);
      if (!entry || !N.isActive(entry)) continue;
      const want = this.desired(row.entry_id);
      const had = this.granted.get(row.entry_id) ?? new Set<string>();
      this.granted.set(row.entry_id, had);
      for (const userId of want) {
        if (had.has(userId)) continue;
        try {
          await voice.setMemberAccess(row.channel_id, userId, true);
          had.add(userId);
        } catch (err) {
          console.error(`[events] entry ${row.entry_id}: letting ${userId} into team voice failed:`, err);
        }
      }
      for (const userId of [...had]) {
        if (want.has(userId)) continue;
        try {
          await voice.setMemberAccess(row.channel_id, userId, false);
          had.delete(userId);
        } catch (err) {
          console.error(`[events] entry ${row.entry_id}: taking ${userId} out of team voice failed:`, err);
        }
      }
    }
  }

  /** A heading for every match being played whose two teams both have a
   *  channel: a private category named after the match, right below the
   *  event's, with the two channels moved into it. */
  private async headings(voice: VoiceOps, ev: EventRow): Promise<void> {
    const { db } = this.deps;
    const matches = db.prepare(
      `SELECT m.id, m.entry_a, m.entry_b FROM event_matches m
       WHERE m.event_id = ? AND m.status IN (${PLAYING_SQL}) AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM event_match_voice v WHERE v.match_id = m.id) ORDER BY m.id`,
    ).all(ev.id) as { id: number; entry_a: number; entry_b: number }[];
    for (const m of matches) {
      const a = this.openRow(m.entry_a);
      const b = this.openRow(m.entry_b);
      if (!a || !b) continue;
      const name = (id: number) => N.getEntry(db, id)?.name ?? 'A team';
      try {
        const categoryId = await voice.createPrivateCategory(`${name(m.entry_a)} vs ${name(m.entry_b)}`.slice(0, NAME_MAX), a.category_id);
        db.prepare('INSERT INTO event_match_voice (match_id, event_id, category_id, created_at) VALUES (?, ?, ?, ?)').run(m.id, ev.id, categoryId, this.nowIso());
        for (const r of [a, b]) {
          await voice.moveChannel(r.channel_id, categoryId).catch((err: unknown) => {
            console.error(`[events] match ${m.id}: moving ${r.channel_id} under its heading failed:`, err);
          });
        }
      } catch (err) {
        // A heading is a nicety: the channels keep working where they are.
        // Recorded with no category so it is not tried every tick.
        console.error(`[events] match ${m.id}: creating its voice heading failed:`, err);
        db.prepare("INSERT OR IGNORE INTO event_match_voice (match_id, event_id, category_id, created_at, deleted_at) VALUES (?, ?, '', ?, ?)")
          .run(m.id, ev.id, this.nowIso(), this.nowIso());
      }
    }
  }

  /** Every heading whose match is no longer being played (or whose event is
   *  over): its channels go back under the event's category, then it goes. */
  private async closeHeadings(voice: VoiceOps): Promise<void> {
    const { db } = this.deps;
    const rows = db.prepare(
      `SELECT v.match_id, v.category_id, m.entry_a, m.entry_b FROM event_match_voice v
       JOIN event_matches m ON m.id = v.match_id JOIN events e ON e.id = v.event_id
       WHERE v.deleted_at IS NULL AND (m.status NOT IN (${PLAYING_SQL}) OR e.status IN ('finished','cancelled'))`,
    ).all() as { match_id: number; category_id: string; entry_a: number | null; entry_b: number | null }[];
    for (const h of rows) {
      for (const entryId of [h.entry_a, h.entry_b]) {
        const r = entryId === null ? undefined : this.openRow(entryId);
        if (!r || this.inOtherHeading(entryId!, h.match_id)) continue;
        await voice.moveChannel(r.channel_id, r.category_id).catch((err: unknown) => {
          console.error(`[events] match ${h.match_id}: moving ${r.channel_id} back failed:`, err);
        });
      }
      try {
        await voice.deleteChannel(h.category_id);
        db.prepare('UPDATE event_match_voice SET deleted_at = ? WHERE match_id = ?').run(this.nowIso(), h.match_id);
      } catch (err) {
        console.error(`[events] match ${h.match_id}: deleting its voice heading failed:`, err);
      }
    }
  }

  /** The entry's channel already sits under the open heading of another
   *  match still being played (a close that failed and is retried after the
   *  team's next match opened): it stays there. */
  private inOtherHeading(entryId: number, matchId: number): boolean {
    return !!this.deps.db.prepare(
      `SELECT 1 FROM event_match_voice v JOIN event_matches m ON m.id = v.match_id
       WHERE v.deleted_at IS NULL AND v.category_id <> '' AND v.match_id <> ? AND m.status IN (${PLAYING_SQL})
         AND (m.entry_a = ? OR m.entry_b = ?) LIMIT 1`,
    ).get(matchId, entryId, entryId);
  }

  private openRow(entryId: number): VoiceRow | undefined {
    return this.deps.db.prepare('SELECT * FROM event_entry_voice WHERE entry_id = ? AND deleted_at IS NULL').get(entryId) as VoiceRow | undefined;
  }

  /** Delete the channel of every entry that is out, and every channel and
   *  category of an event that is over. */
  private async closeDone(voice: VoiceOps): Promise<void> {
    const { db } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const rows = db.prepare(
      `SELECT v.*, e.status AS ev_status, e.finished_at AS ev_finished
       FROM event_entry_voice v JOIN events e ON e.id = v.event_id
       WHERE v.deleted_at IS NULL ORDER BY v.event_id, v.entry_id`,
    ).all() as (VoiceRow & { ev_status: string; ev_finished: string | null })[];
    const over = (r: (typeof rows)[number]) => r.ev_status === 'cancelled'
      || (r.ev_status === 'finished' && (r.ev_finished === null || Date.parse(r.ev_finished) + FINISHED_GRACE_MS <= now));
    const lobby = getSetting(db, 'discord_lobby_channel_id') || null;
    const closedEvents = new Set<number>();
    for (const r of rows) {
      const eventOver = over(r);
      if (!eventOver) {
        const entry = N.getEntry(db, r.entry_id);
        const out = entry ? outSince(db, entry) : 0;
        if (out === null || out > now) continue;
      }
      if (await this.deleteOne(voice, r.entry_id, r.channel_id, lobby)) {
        db.prepare('UPDATE event_entry_voice SET deleted_at = ? WHERE entry_id = ?').run(this.nowIso(), r.entry_id);
        this.granted.delete(r.entry_id);
        if (eventOver) closedEvents.add(r.event_id);
      }
    }
    // The category goes once none of its channels are left.
    for (const eventId of closedEvents) {
      if (this.rowsOf(eventId).length > 0) continue;
      const cat = db.prepare('SELECT category_id FROM event_entry_voice WHERE event_id = ? LIMIT 1').get(eventId) as { category_id: string } | undefined;
      if (!cat) continue;
      await voice.deleteChannel(cat.category_id).catch((err: unknown) => {
        console.error(`[events] ${eventId}: deleting the team voice category failed:`, err);
      });
    }
  }

  /** Move everyone in the channel to the lobby, then delete it; true when it
   *  is gone. A failure is reported once and retried next minute. */
  private async deleteOne(voice: VoiceOps, entryId: number, channelId: string, lobby: string | null): Promise<boolean> {
    if (lobby) {
      const members = await voice.channelMemberIds(channelId).catch(() => null);
      for (const userId of members ?? []) {
        await voice.move(userId, lobby).catch((err: unknown) => {
          console.error(`[events] entry ${entryId}: moving ${userId} to the lobby failed:`, err);
        });
      }
    }
    try {
      await voice.deleteChannel(channelId);
      this.closeReported.delete(entryId);
      return true;
    } catch (err) {
      console.error(`[events] entry ${entryId}: deleting its team voice failed:`, err);
      if (!this.closeReported.has(entryId)) {
        this.closeReported.add(entryId);
        const why = err instanceof Error ? err.message : String(err);
        publishAdminEvent({ kind: 'problem', text: `Could not delete a team voice channel (${why}). Retrying every minute; delete it by hand if this keeps up.` });
      }
      return false;
    }
  }
}
