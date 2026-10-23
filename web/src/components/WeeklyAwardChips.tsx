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
    <section class="panel profawards" aria-label="Weekly awards">
      <h3>Weekly awards</h3>
      <ul class="profawards__list">
        {shown.map((a) => (
          <li class="profaward" key={a.award} title={`Weeks of ${a.weeks.map(weekName).join(', ')}`}>
            <span class="profaward__label">{a.label}</span>
            {a.count > 1 && <span class="profaward__count num" aria-label={`${a.count} weeks`}>x{a.count}</span>}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" class="btn btn--ghost btn--sm profawards__more" onClick={() => setOpen(true)}>+{hidden} more</button>
      )}
    </section>
  );
}
