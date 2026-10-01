import type { ScrimReliability } from '../api';

/** Under this many counted bookings a side is "New": too few to say much. */
export const RECORD_MIN_BOOKED = 3;

/** A side's record in one line (plan 2): "Shown N of M", plus the no-shows
 *  and late cancels only when there are any, or "New" under 3 booked. */
export function recordText(r: ScrimReliability): string {
  if (r.booked < RECORD_MIN_BOOKED) return 'New';
  const parts = [`Shown ${r.shown} of ${r.booked}`];
  if (r.noShows > 0) parts.push(`No-shows ${r.noShows}`);
  if (r.lateCancels > 0) parts.push(`Late cancels ${r.lateCancels}`);
  return parts.join(' · ');
}

/** The board's badge, shown only while the record is public. */
export function reliableBadge(r: ScrimReliability): string {
  return r.booked < RECORD_MIN_BOOKED ? 'New' : `Reliable: ${r.shown} of ${r.booked} shown`;
}

export function RecordLine({ record, label }: { record: ScrimReliability; label?: string }) {
  return (
    <p class="scrimrecord">
      {label && <span class="muted">{label}: </span>}
      <span>{recordText(record)}</span>
    </p>
  );
}
