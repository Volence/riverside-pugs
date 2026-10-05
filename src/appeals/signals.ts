/** "Appeal N changed." Fired after the write has committed; the Discord
 *  reconciler (appealSync) listens. In process only, like banEvents. */
type Listener = (appealId: number) => void;
const listeners = new Set<Listener>();

export function publishAppealSignal(appealId: number): void {
  for (const fn of listeners) {
    try {
      fn(appealId);
    } catch (err) {
      console.error('[appeals] listener failed:', err);
    }
  }
}

export function subscribeAppealSignals(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
