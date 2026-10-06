import type { MatchRoomView, RoomCampaign } from '../../../api';
import { stepText } from './roomText';

const teamName = (v: MatchRoomView, s: 'a' | 'b'): string => (s === 'a' ? v.a?.name ?? 'TBD' : v.b?.name ?? 'TBD');

const tileText = (v: MatchRoomView, c: RoomCampaign): string => {
  const who = c.by === null ? '' : teamName(v, c.by);
  if (c.state === 'banned') return `Banned by ${who}`;
  if (c.state === 'picked') return `Game ${c.game} picked by ${who}`;
  if (c.state === 'decider') return `Game ${c.game}, the decider`;
  return 'Open';
};

/** The pool, whose turn it is, and the buttons for the manager whose turn
 *  it is. onAct sends the step the page saw, so a step someone else took in
 *  the meantime is refused by the server, not applied twice. */
export function VetoBoard({ v, busy, onAct }: { v: MatchRoomView; busy: boolean; onAct: (step: number, action: string, campaign: string | null) => void }) {
  const n = v.next;
  const mine = !!n && n.kind !== 'wait' && v.me?.manager === true && v.me.side === n.by;
  const choosing = mine && n && (n.kind === 'ban' || n.kind === 'pick') ? n : null;
  return (
    <section class="vetoboard" aria-label="Veto">
      <p class="muted">{v.vetoSummary}</p>
      {n && <p class="vetoboard__turn"><strong>{stepText(v)}</strong></p>}
      <ul class="vetoboard__pool">
        {v.pool.map((c) => (
          <li key={c.slug} class={`vetotile vetotile--${c.state}`}>
            <span class="vetotile__name">{c.name}</span>
            <span class="vetotile__state">{tileText(v, c)}</span>
            {choosing && c.state === 'open' && (
              <button class="btn btn--sm" type="button" disabled={busy} onClick={() => onAct(choosing.step, choosing.kind, c.slug)}>
                {`${choosing.kind === 'ban' ? 'Ban' : 'Pick'} ${c.name}`}
              </button>
            )}
          </li>
        ))}
      </ul>
      {mine && n && n.kind === 'order' && (
        <div class="vetoboard__choice">
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'first', null)}>Go first</button>
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'second', null)}>Go second</button>
        </div>
      )}
      {mine && n && n.kind === 'side' && (
        <div class="vetoboard__choice">
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'survivors', null)}>Survivors first</button>
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'infected', null)}>Infected first</button>
        </div>
      )}
    </section>
  );
}
