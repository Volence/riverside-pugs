import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getServer } from '../serverPool.js';
import * as B from '../bookings/bookings.js';
import type { BookingRunner } from '../bookings/runner.js';

export interface AdminBookingRow {
  id: number; state: string; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  server: string | null; peak: { a: number; b: number }; endReason: string | null;
}

/**
 * The staff side of bookings (plan 4a): every open booking and those that
 * ended in the last day, with Cancel, Extend and End. Staff = admin or mod.
 * Not behind the competitive switch, so staff can always clean up after it
 * has been turned off. Every action is audited with logAdmin; a staff cancel
 * belongs to no side (scrim spec 3a: never counted against anyone).
 */
export async function adminBookingRoutes(app: FastifyInstance, opts: { db: DB; runner: BookingRunner | null }): Promise<void> {
  const { db, runner } = opts;
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, error: B.BookingError) =>
    reply.code(B.BOOKING_ERRORS[error].status).send({ error: B.BOOKING_ERRORS[error].text });
  const idOf = (params: unknown): number => Number((params as { id: string }).id);

  app.get('/api/admin/bookings', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = db.prepare('SELECT * FROM bookings WHERE ended_at IS NULL OR ended_at > ? ORDER BY starts_at, id').all(since) as B.BookingRow[];
    const bookings: AdminBookingRow[] = rows.map((b) => {
      const [a, s] = B.sidesOf(db, b.id);
      return {
        id: b.id, state: b.state, ending: b.ending_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
        aName: B.sideName(db, a), bName: B.sideName(db, s),
        server: b.server_id !== null ? getServer(db, b.server_id)?.name ?? null : null,
        peak: { a: a.peak_present, b: s.peak_present }, endReason: b.end_reason,
      };
    });
    return { bookings };
  });

  app.post('/api/admin/bookings/:id/cancel', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    const r = B.cancelBooking(db, { bookingId: id, by: me, staff: true, reason });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_cancel', id, { reason: typeof reason === 'string' ? reason : null });
    runner?.onCancelled(id, me, B.getBooking(db, id)?.cancel_reason ?? null);
    return { ok: true };
  });

  app.post('/api/admin/bookings/:id/extend', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const r = B.extendBooking(db, { bookingId: id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_extend', id, { endsAt: r.value.endsAt });
    runner?.onExtended(id);
    return { ok: true };
  });

  app.post('/api/admin/bookings/:id/end', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const r = B.endBooking(db, { bookingId: id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_end', id);
    runner?.settle(id);
    return { ok: true };
  });
}
