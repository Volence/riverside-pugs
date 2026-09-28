import type { PracticeEndReason, PracticeKind, PracticeLease } from './api';

/** Minutes with nobody on before a lease closes itself. Mirrors IDLE_END_MS
 *  in src/practiceLeases.ts (the park is shared and gives its box back
 *  sooner). */
export const IDLE_MINUTES: Record<PracticeKind, number> = { park: 5, drill: 10 };

/**
 * Words for practice server leases (src/practiceLeases.ts), shared by the
 * Play page card, the invite page and the admin board so the three never
 * describe the same lease two ways.
 */

export const KIND_LABEL: Record<PracticeKind, string> = {
  park: 'Practice Park',
  drill: 'Drill server',
};

/** Why a lease ended, finishing the sentence "This practice server closed
 *  because ...". */
export const END_REASON: Record<PracticeEndReason, string> = {
  owner: 'whoever started it closed it',
  admin: 'an admin closed it',
  idle: 'nobody was on it',
  expired: 'its time ran out',
  preempted: 'a PUG needed the server (ranked matches always come first)',
  setup_failed: 'the server could not be set up',
  players_on_server: 'the server was not free after all',
  interrupted: 'the site restarted while it was being set up',
};

/** "1h 12m" past the hour, "12:04" under it. Lease times are long enough
 *  that seconds only matter at the very end. */
export function leaseClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The invite page of a lease, as a path. */
export const leasePath = (id: number) => `/practice/${id}`;

/** The END_REASON sentence ending for a lease, with the idle time its kind
 *  actually waited. */
export function endReasonText(reason: PracticeEndReason | null, kind: PracticeKind): string {
  if (reason === 'idle') return `nobody was on it for ${IDLE_MINUTES[kind]} minutes`;
  return END_REASON[reason ?? 'owner'];
}

/** What a lease that is still setting up is doing, as one sentence. The
 *  reset is a real srcds restart (30 to 60 seconds), and connecting during
 *  it just gets you dropped, so the line says to wait until it is loading. */
export function setupText(lease: Pick<PracticeLease, 'kind' | 'server' | 'setupPhase'>): string {
  const what = lease.kind === 'park' ? 'the Practice Park' : 'your drill server';
  if (lease.setupPhase === 'loading') {
    return `Loading ${what} on ${lease.server}. You can connect now; it finishes around you.`;
  }
  return `Resetting ${lease.server} for a clean start, which takes up to a minute. Connect once it is loading.`;
}
