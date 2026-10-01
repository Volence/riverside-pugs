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

/** Plan 2's scrim night banner: "Thursday 5:00 PM-9:00 PM", the window's
 *  weekday and start-end in the viewer's own time zone. The weekday is read
 *  off the start, same as everywhere else a start becomes a local label. */
export function nightRangeLabel(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${start.toLocaleDateString(undefined, { weekday: 'long' })} ${time(start)}-${time(end)}`;
}
