import { useEffect } from 'preact/hooks';
import { STATE, type PlayerSample } from '../../../src/replayFormat';
import { isSurvivor, slotColor, slotLabel } from './draw';
import { boxScore, columnsPresent, type BoxColumn, type BoxSide } from './boxScore';
import { formatTime } from './ReplayControls';
import type { TimelineEntry } from './timeline';

function SideTable(
  { side, label, players, columns, timeline, tMs, slots, names }: {
    side: BoxSide; label: string; players: PlayerSample[]; columns: BoxColumn[];
    timeline: TimelineEntry[]; tMs: number; slots: string[]; names: Record<string, string>;
  },
) {
  return (
    <section class="box__side">
      <h5>{label}</h5>
      {columns.length === 0 ? (
        <p class="muted box__none">Nothing recorded this round.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              {columns.map((c) => <th key={c.key}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const id = slots[p.slot] ?? '';
              const row = boxScore(timeline, tMs, id, side);
              return (
                <tr key={p.slot}>
                  <td class="box__who">
                    <span class="box__dot" style={{ color: slotColor(p.slot) }} aria-hidden="true" />
                    <span class="box__name">{names[id] || slotLabel(p.slot)}</span>
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} class={`num${row[c.key] === 0 ? ' is-zero' : ''}`}>{row[c.key]}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The running box score over the stage: what each player has done, and had
 * done to them, up to the playhead. Two tables, survivors and infected of
 * the current frame, in slot order with the map's colour dot so a row can be
 * matched to a dot without reading. Counts come from the round's events (see
 * boxScore.ts for the UDP caveat), so this is the same information as the
 * rail, arranged so it can be read in one glance while theater plays.
 */
export function StatsPanel(
  { timeline, tMs, players, slots, names, onClose }: {
    timeline: TimelineEntry[]; tMs: number; players: PlayerSample[];
    slots: string[]; names: Record<string, string>; onClose: () => void;
  },
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const present = players
    .filter((p) => (p.state & STATE.PRESENT) !== 0)
    .sort((a, b) => a.slot - b.slot);
  const shared = { timeline, tMs, slots, names };

  return (
    <div
      class="box"
      role="dialog"
      aria-label="Round stats"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="box__head">
        <span class="label">Stats <span class="num box__t">{formatTime(tMs)}</span></span>
        <button type="button" class="chip" onClick={onClose} aria-label="Close stats">Close</button>
      </div>
      <div class="box__cols">
        <SideTable side="survivor" label="Survivors" players={present.filter(isSurvivor)} columns={columnsPresent(timeline, 'survivor')} {...shared} />
        <SideTable side="infected" label="Infected" players={present.filter((p) => !isSurvivor(p))} columns={columnsPresent(timeline, 'infected')} {...shared} />
      </div>
    </div>
  );
}
