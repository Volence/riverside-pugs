import { FREE, followSlotOf, type Follow } from './camera';
import { markerKindsPresent } from './markers';
import { slotLabel } from './draw';
import type { TimelineEntry } from './timeline';

/**
 * The two controls above the stage: Show picks the event kind, for narrows
 * to a player. "for" IS the follow row's selection (the owner's model:
 * pick the kind, then the player), so either control changes the other.
 */
export function MarkerFilters(
  { timeline, showKind, setShowKind, slots, names, follow, setFollow }: {
    timeline: TimelineEntry[]; showKind: string; setShowKind: (k: string) => void;
    slots: string[]; names: Record<string, string>; follow: Follow; setFollow: (f: Follow) => void;
  },
) {
  const kinds = markerKindsPresent(timeline);
  const followSlot = followSlotOf(follow);
  return (
    <div class="replay__filters">
      <label class="replay__filter">
        <span>Show</span>
        <select value={showKind} onChange={(e) => setShowKind((e.target as HTMLSelectElement).value)} aria-label="Show">
          <option value="all">All events</option>
          {kinds.map(({ kind, count }) => (
            <option key={kind.kind} value={kind.kind}>{kind.label} ({count})</option>
          ))}
        </select>
      </label>
      <label class="replay__filter">
        <span>for</span>
        <select
          value={followSlot === null ? '' : String(followSlot)}
          aria-label="for"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setFollow(v === '' ? FREE : { kind: 'slot', slot: Number(v) });
          }}
        >
          <option value="">Everyone</option>
          {slots.map((id, i) => id ? <option key={i} value={String(i)}>{names[id] || slotLabel(i)}</option> : null)}
        </select>
      </label>
    </div>
  );
}
