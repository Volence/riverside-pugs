import { useEffect } from 'preact/hooks';
import { ENTITY_KIND } from '../../../src/replayFormat';
import { GHOST_COLOR, SLOT_COLORS, entityStyle, slotLabel } from './draw';
import { DEAD_COLOR, STATE_RINGS } from './stateRing';
import { PICTOGRAMS, type PictogramName } from './pictograms';
import { MARKER_KINDS } from './markers';

function Swatch({ color, ring }: { color: string; ring?: boolean }) {
  return <span class={`key__swatch${ring ? ' key__swatch--ring' : ''}`} style={{ color }} aria-hidden="true" />;
}

function Pict({ name }: { name: PictogramName }) {
  return (
    <svg class="key__pict" viewBox="0 0 20 20" aria-hidden="true"><path d={PICTOGRAMS[name]} fill="currentColor" /></svg>
  );
}

const ENTITY_ROWS: [number, string][] = [
  [ENTITY_KIND.COMMON, 'Common'], [ENTITY_KIND.WITCH, 'Witch'], [ENTITY_KIND.TANK_ROCK, 'Rock'],
  [ENTITY_KIND.TANK_AI, 'AI tank'], [ENTITY_KIND.SURVIVOR_BOT, 'Survivor bot'],
  [ENTITY_KIND.SMOKER_AI, 'AI smoker'], [ENTITY_KIND.BOOMER_AI, 'AI boomer'], [ENTITY_KIND.HUNTER_AI, 'AI hunter'],
];

/**
 * The legend, built from the same tables the canvas draws from, so adding a
 * state or a marker kind puts it here with no second edit.
 */
export function KeyPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="key" role="dialog" aria-label="Map key" onPointerDown={(e) => e.stopPropagation()}>
      <div class="key__head">
        <span class="label">Key</span>
        <button type="button" class="chip" onClick={onClose} aria-label="Close key">Close</button>
      </div>
      <div class="key__cols">
        <section>
          <h5>Players</h5>
          <ul>
            {SLOT_COLORS.map((c, i) => <li key={i}><Swatch color={c} ring />{slotLabel(i)}</li>)}
            <li><Swatch color={GHOST_COLOR} ring />Unspawned infected</li>
            <li><Swatch color={DEAD_COLOR} ring />Dead</li>
          </ul>
        </section>
        <section>
          <h5>State ring</h5>
          <ul>{STATE_RINGS.map((r) => <li key={r.key}><Swatch color={r.color} ring />{r.label} <span class="muted">{r.glyph}</span></li>)}</ul>
          <h5>Infected class</h5>
          <ul>{(Object.keys(PICTOGRAMS) as PictogramName[]).map((n) => <li key={n}><Pict name={n} />{n.charAt(0).toUpperCase() + n.slice(1)}</li>)}</ul>
        </section>
        <section>
          <h5>World</h5>
          <ul>{ENTITY_ROWS.map(([k, label]) => <li key={k}><Swatch color={entityStyle(k)!.color} />{label}</li>)}</ul>
        </section>
        <section>
          <h5>Events</h5>
          <ul>{MARKER_KINDS.map((k) => <li key={k.kind}><span class="key__tag" style={{ borderColor: k.color }}>{k.letter}</span>{k.label}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
