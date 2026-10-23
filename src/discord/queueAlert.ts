import type { DB } from '../db.js';
import { getSetting } from '../settings.js';

/**
 * The "queue is almost full" ping (a player's idea, owner-approved 2026-10-23).
 *
 * One alert message at a time. It is posted when the main PUG queue reaches
 * the threshold, kept up to date by editing it while the queue moves (an edit
 * never pings, so 6/8 -> 7/8 costs nobody a notification), and closed by an
 * edit saying why once it is no longer worth jumping in for: the queue popped,
 * or it fell well back. A closed alert is a record, not an invitation.
 *
 * Everything lives in discord_messages (kind 'alert', ref = the post time in
 * ms), so a web restart neither forgets the cooldown nor loses the open
 * message it still has to close:
 *   - state 'open': the alert still standing, at most one;
 *   - 'popped' / 'emptied' / 'dropped' / 'off': closed, and why;
 *   - 'failed': Discord refused the post. Kept so the cooldown still counts
 *     from it, or an outage would retry on every pass all evening;
 *   - 'done': rows from the first version of the alert, which never closed.
 *
 * This is the main queue only. Side games, drafts, scrims and events never
 * pass through Matchmaker's queue, so nothing here can fire for them.
 */

export interface QueueAlertConfig {
  roleId: string;
  /** Queued players at which the alert goes out. */
  threshold: number;
  cooldownMs: number;
  /** Where it is posted: the alert channel setting, else the queue channel. */
  channelId: string;
}

/** How far under the threshold the queue must fall before the open alert is
 *  closed as "dropped". One or two leaving is ordinary churn while a queue
 *  fills, and closing then would only invite a second ping on the way back
 *  up; three under (3/8 at the default 6) is a queue that is not about to pop. */
export const ALERT_DROP_MARGIN = 2;

const DISCORD_ID = /^\d{17,20}$/;

/** The alert role, or null when queue alerts are off: no role id, or one
 *  that is not a Discord id (it would post a broken ping, and a toggle for it
 *  could only fail). The one reading of the setting that the alert, the
 *  queue card's button and /alerts all share. */
export function queueAlertRoleId(db: DB): string | null {
  const roleId = (getSetting(db, 'discord_pug_role_id') ?? '').trim();
  return DISCORD_ID.test(roleId) ? roleId : null;
}

/** The alert's settings, or null when it is off (see queueAlertRoleId). */
export function queueAlertConfig(db: DB, queueChannelId: string): QueueAlertConfig | null {
  const roleId = queueAlertRoleId(db);
  if (!roleId) return null;
  const threshold = Number(getSetting(db, 'queue_alert_threshold') ?? 6);
  const minutes = Number(getSetting(db, 'queue_alert_cooldown_minutes') ?? 45);
  const channel = (getSetting(db, 'discord_queue_alert_channel_id') ?? '').trim();
  return {
    roleId,
    threshold: Number.isInteger(threshold) && threshold >= 1 ? threshold : 6,
    cooldownMs: (Number.isFinite(minutes) && minutes >= 0 ? minutes : 45) * 60_000,
    channelId: DISCORD_ID.test(channel) ? channel : queueChannelId,
  };
}

/** Why an alert was closed. 'off': queue alerts were switched off (the role
 *  id cleared) while it stood, which says nothing about the queue. */
export type AlertClose = 'popped' | 'emptied' | 'dropped' | 'off';

export type AlertDecision =
  | { kind: 'none' }
  | { kind: 'post' }
  /** Edit the open alert to the current count. */
  | { kind: 'update' }
  | { kind: 'close'; why: AlertClose };

export interface AlertInput {
  /** Players in the main queue, counted as the queue card counts them: each
   *  person once, so a duo is two. */
  count: number;
  /** A ready check or campaign vote is running. The alert is left exactly
   *  as it is: the pop may yet fail and put people back in the queue. */
  popping: boolean;
  /** A pop became a match since the last look. Only this closes an alert as
   *  "match started": a failed ready check is not a match. */
  popped: boolean;
  threshold: number;
  cooldownMs: number;
  now: number;
  /** When the last alert was posted (or failed to be), or null for never. */
  lastAt: number | null;
  /** The open alert, and the count it last showed (null: not known, as after
   *  a restart). */
  open: { count: number | null } | null;
}

/** What to do with the alert on this pass. Pure, so every rule is tested
 *  without a transport. */
export function decideAlert(v: AlertInput): AlertDecision {
  if (v.open) {
    if (v.popped) return { kind: 'close', why: 'popped' };
    // Mid ready check the queue reads near empty, and closing or editing on
    // that would be wrong the moment the check fails and everyone who readied
    // is put back. Once it ends either way, the rules below pick it up again.
    if (v.popping) return { kind: 'none' };
    if (v.count === 0) return { kind: 'close', why: 'emptied' };
    if (v.count < v.threshold - ALERT_DROP_MARGIN) return { kind: 'close', why: 'dropped' };
    return v.count === v.open.count ? { kind: 'none' } : { kind: 'update' };
  }
  // Never while a pop is in progress: the people in it are already pinged by
  // the ready check, and anyone else would be joining a queue that just
  // emptied into it.
  if (v.popping) return { kind: 'none' };
  if (v.count < v.threshold) return { kind: 'none' };
  if (v.lastAt !== null && v.now - v.lastAt < v.cooldownMs) return { kind: 'none' };
  return { kind: 'post' };
}

export interface StoredAlert { ref: string; channel_id: string; message_id: string }

/** The alert still standing, if any. Newest first, should more than one ever
 *  be open: the older ones are closed by the caller as it finds them. */
export function openAlerts(db: DB): StoredAlert[] {
  return db.prepare(
    `SELECT ref, channel_id, message_id FROM discord_messages
     WHERE kind = 'alert' AND state = 'open' ORDER BY CAST(ref AS INTEGER) DESC`,
  ).all() as StoredAlert[];
}

/** When the newest alert was posted or attempted, in epoch ms, or null. The
 *  ref is that time: alerts have been keyed by it since the first version. */
export function lastAlertAt(db: DB): number | null {
  const row = db.prepare(
    "SELECT MAX(CAST(ref AS INTEGER)) AS at FROM discord_messages WHERE kind = 'alert'",
  ).get() as { at: number | null } | undefined;
  return row?.at ?? null;
}
