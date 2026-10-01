import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { publishAdminEvent } from '../adminFeed.js';
import type { VoiceOps } from '../discord/transport.js';
import { getBooking, sideName, sidesOf, voiceMembers, type Side } from './bookings.js';

/** Discord's limit on a channel or category name. */
const NAME_MAX = 100;

interface BookingVoiceRow {
  booking_id: number;
  category_id: string;
  side_a_id: string;
  side_b_id: string;
  deleted_at: string | null;
}

type Granted = Record<Side, Set<string>>;

/**
 * A booked scrim's private team voice (plan 4c, rulings 1 to 3): one category
 * named `Scrim: <side a> vs <side b>` with a voice channel per side, labelled
 * by the side's name, that only that side's accepted people (and staff, through
 * the staff role) can see. Made when the booking is ready, kept in step with
 * who is accepted every minute, and removed at the end of the booking after
 * everyone in it is moved to the lobby.
 *
 * Nothing here ever throws to the runner or blocks a booking: voice is a
 * convenience on top of a booked server, and a bot without permissions, a
 * channel deleted by hand or a bot that is not connected leaves the booking
 * running exactly as it would have without voice.
 */
export class BookingVoice {
  /** Bookings whose channels could not be made in this process: reported to
   *  staff once and not tried again, so a permissions problem does not post
   *  an admin event every minute. */
  private readonly failed = new Set<number>();
  /** Bookings with an ensure running, so two callers cannot both create. */
  private readonly creating = new Set<number>();
  /** Who this process gave access to, per booking and side. Seeded at
   *  creation; after a web restart it is empty, and the first sync re-grants
   *  everyone who should be in (setMemberAccess is idempotent). */
  private readonly granted = new Map<number, Granted>();

  constructor(private readonly deps: { db: DB; voice: () => VoiceOps | null; now?: () => number }) {}

  private nowIso(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private row(bookingId: number): BookingVoiceRow | undefined {
    return this.deps.db.prepare('SELECT * FROM booking_voice WHERE booking_id = ?').get(bookingId) as BookingVoiceRow | undefined;
  }

  /** The discord ids that belong in each side's channel (ruling 2). */
  private desired(bookingId: number): Record<Side, string[]> {
    const out: Record<Side, string[]> = { a: [], b: [] };
    for (const m of voiceMembers(this.deps.db, bookingId)) out[m.side].push(m.discordId);
    return out;
  }

  /** Make the channels if voice is on, the bot is connected, both sides have
   *  confirmed, and the booking has none yet. */
  async ensure(bookingId: number): Promise<void> {
    const { db } = this.deps;
    if (getSetting(db, 'discord_voice_enabled') !== '1') return;
    const voice = this.deps.voice();
    if (!voice) return;
    if (this.failed.has(bookingId) || this.creating.has(bookingId)) return;
    if (this.row(bookingId)) return;
    const b = getBooking(db, bookingId);
    if (!b || b.ending_at !== null) return;
    const sides = sidesOf(db, bookingId);
    const a = sides.find((s) => s.side === 'a');
    const bs = sides.find((s) => s.side === 'b');
    if (!a || !bs || a.confirmed_at === null || bs.confirmed_at === null) return;

    this.creating.add(bookingId);
    try {
      const want = this.desired(bookingId);
      const nameA = sideName(db, a);
      const nameB = sideName(db, bs);
      const made = await voice.createMatchChannels(
        `Scrim: ${nameA} vs ${nameB}`.slice(0, NAME_MAX),
        { label: nameA.slice(0, NAME_MAX), userIds: want.a },
        { label: nameB.slice(0, NAME_MAX), userIds: want.b },
        getSetting(db, 'discord_staff_role_id') || null,
        { privateView: true },
      );
      db.prepare('INSERT INTO booking_voice (booking_id, category_id, side_a_id, side_b_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(bookingId, made.categoryId, made.teamAId, made.teamBId, this.nowIso());
      this.granted.set(bookingId, { a: new Set(want.a), b: new Set(want.b) });
    } catch (err) {
      this.failed.add(bookingId);
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[booking] ${bookingId}: creating the scrim voice channels failed:`, err);
      publishAdminEvent({ kind: 'problem', text: `Booking ${bookingId}: could not create its private voice channels (${why}). The booking carries on without voice.` });
    } finally {
      this.creating.delete(bookingId);
    }
  }

  /** Give access to anyone accepted since the last look and take it from
   *  anyone no longer accepted (ruling 2: they are not kicked from the
   *  channel). Logs, never throws. */
  async sync(bookingId: number): Promise<void> {
    try {
      if (getSetting(this.deps.db, 'discord_voice_enabled') !== '1') return;
      const voice = this.deps.voice();
      if (!voice) return;
      const row = this.row(bookingId);
      if (!row || row.deleted_at !== null) return;
      const want = this.desired(bookingId);
      // No record (a web restart since the channels were made): what was
      // granted is unknown, so everyone who belongs is granted again.
      const had = this.granted.get(bookingId) ?? { a: new Set<string>(), b: new Set<string>() };
      this.granted.set(bookingId, had);
      for (const [side, channelId] of [['a', row.side_a_id], ['b', row.side_b_id]] as const) {
        const desired = new Set(want[side]);
        for (const userId of desired) {
          if (had[side].has(userId)) continue;
          try {
            await voice.setMemberAccess(channelId, userId, true);
            had[side].add(userId);
          } catch (err) {
            console.error(`[booking] ${bookingId}: letting ${userId} into side ${side} voice failed:`, err);
          }
        }
        for (const userId of [...had[side]]) {
          if (desired.has(userId)) continue;
          try {
            await voice.setMemberAccess(channelId, userId, false);
            had[side].delete(userId);
          } catch (err) {
            console.error(`[booking] ${bookingId}: taking ${userId} out of side ${side} voice failed:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[booking] ${bookingId}: syncing the scrim voice members failed:`, err);
    }
  }

  /** The booking is over (ruling 3): everyone in the two channels goes to
   *  the lobby channel when one is set, then both channels and the category
   *  are deleted. Best effort per step; never throws. With no bot connected
   *  nothing is done and the row stays, so a later close can still clean up. */
  async close(bookingId: number): Promise<void> {
    try {
      const voice = this.deps.voice();
      if (!voice) return;
      const row = this.row(bookingId);
      if (!row || row.deleted_at !== null) return;
      const lobby = getSetting(this.deps.db, 'discord_lobby_channel_id') || null;
      if (lobby) {
        for (const channelId of [row.side_a_id, row.side_b_id]) {
          const members = await voice.channelMemberIds(channelId).catch((err) => {
            console.error(`[booking] ${bookingId}: reading who is in ${channelId} failed:`, err);
            return null;
          });
          for (const userId of members ?? []) {
            try {
              await voice.move(userId, lobby);
            } catch (err) {
              console.error(`[booking] ${bookingId}: moving ${userId} to the lobby failed:`, err);
            }
          }
        }
      }
      for (const channelId of [row.side_a_id, row.side_b_id, row.category_id]) {
        try {
          await voice.deleteChannel(channelId);
        } catch (err) {
          console.error(`[booking] ${bookingId}: deleting voice channel ${channelId} failed:`, err);
        }
      }
      this.deps.db.prepare('UPDATE booking_voice SET deleted_at = ? WHERE booking_id = ?').run(this.nowIso(), bookingId);
      this.granted.delete(bookingId);
    } catch (err) {
      console.error(`[booking] ${bookingId}: closing the scrim voice failed:`, err);
    }
  }

  /** Close the channels of every booking that has ended but still has them:
   *  its wind-down ran with no bot connected (a web restart mid-end resumes
   *  the wind-down before the bot logs in), or an ensure finished after the
   *  close. Run by the minute tick; never throws. */
  async closeEnded(): Promise<void> {
    try {
      if (!this.deps.voice()) return;
      const ids = this.deps.db.prepare(
        `SELECT v.booking_id FROM booking_voice v JOIN bookings b ON b.id = v.booking_id
         WHERE v.deleted_at IS NULL AND b.ended_at IS NOT NULL`,
      ).all() as { booking_id: number }[];
      for (const { booking_id } of ids) await this.close(booking_id);
    } catch (err) {
      console.error('[booking] closing the voice of ended bookings failed:', err);
    }
  }
}
