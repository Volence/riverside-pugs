import { useState } from 'preact/hooks';
import { api, ApiError, type DuoView } from '../api';
import { Panel } from './bits';

/** Your duo and duo invites, above the queue (duo queue, Season 1). */
export function DuoPanel({ duo, refresh }: { duo: DuoView; refresh: () => void }) {
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      // A request that never reached the site (stew, Season 1 launch: End duo
      // did nothing until he turned his ad blocker off) says so, with the
      // Discord way round it.
      setError(err instanceof ApiError ? err.message
        : 'Could not reach the site. A browser extension such as an ad blocker may be blocking it; /duo and /unduo in Discord work too.');
    }
    refresh();
  };
  // No duo yet: say how to get one (players kept asking at the Season 1 launch).
  if (!duo.partner && duo.incoming.length === 0 && !duo.outgoing) {
    return (
      <p class="duopanel__hint">
        Duo queue: type <strong>/duo</strong> in Discord and pick your friend, or click <strong>Duo</strong> on
        their slot when they are in the queue. Once they accept, you always play on the same team.
      </p>
    );
  }
  const out = duo.outgoing;
  return (
    <Panel class="duopanel">
      <p class="eyebrow">Duo</p>
      {duo.partner && (
        <p>
          You are a duo with <strong>{duo.partner.name}</strong>. Either of you joining the queue brings the other,
          and you always play on the same team. End it here or with <strong>/unduo</strong> in Discord.{' '}
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => act(api.duoEnd)}>End duo</button>
        </p>
      )}
      {duo.incoming.map((i) => (
        <p key={i.id}>
          <strong>{i.from.name}</strong> wants to duo queue with you.{' '}
          <button type="button" class="btn btn--sm" onClick={() => act(() => api.duoAccept(i.id))}>Accept</button>{' '}
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => act(() => api.duoDecline(i.id))}>Decline</button>
        </p>
      ))}
      {out && (
        <p>
          Waiting for <strong>{out.to.name}</strong> to accept your duo invite.{' '}
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => act(() => api.duoCancel(out.id))}>Cancel</button>
        </p>
      )}
      {error && <p class="error">{error}</p>}
    </Panel>
  );
}
