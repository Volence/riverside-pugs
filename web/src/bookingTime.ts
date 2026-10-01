/** A `datetime-local` value ("2026-10-02T20:00") read in the viewer's own
 *  time zone, as an ISO string; null when empty or unreadable. */
export function toUtcIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const t = new Date(local).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "Fri 2 Oct, 20:00" in the viewer's zone. */
export function localLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The spec's "warns when the playlist will not fit". */
export function fitWarning(minutes: number, playlistMinutes: number): string | null {
  return playlistMinutes > minutes
    ? `These campaigns usually take about ${playlistMinutes} minutes; the booking is ${minutes}. Extend later, or pick fewer.`
    : null;
}
