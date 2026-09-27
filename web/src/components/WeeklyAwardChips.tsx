import { useState } from 'preact/hooks';
import type { PlayerAward } from '../api';

/** Kept small on purpose: one chip per award with a count, a handful shown,
 *  the rest behind a button, so a regular's profile does not fill with them. */
const MAX_CHIPS = 4;

const weekName = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function WeeklyAwardChips({ awards }: { awards: PlayerAward[] }) {
  const [open, setOpen] = useState(false);
  if (!awards.length) return null;
  const shown = open ? awards : awards.slice(0, MAX_CHIPS);
  const hidden = awards.length - shown.length;
  return (
    <div class="weekly-chips" aria-label="Weekly awards">
      <span class="weekly-chips__title">Weekly awards</span>
      {shown.map((a) => (
        <span class="weekly-chips__chip" key={a.award} title={`Weeks of ${a.weeks.map(weekName).join(', ')}`}>
          {a.count > 1 ? `${a.label} x${a.count}` : a.label}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" class="weekly-chips__more" onClick={() => setOpen(true)}>+{hidden} more</button>
      )}
    </div>
  );
}
