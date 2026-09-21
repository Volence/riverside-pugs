import { useEffect, useState } from 'preact/hooks';
import { api, type PendingEndorsement } from '../api';

const KEY = 'endorse-dismissed';

/** Match ids the viewer waved away. localStorage can throw (private window,
 *  blocked site data), and a bar that cannot remember is still a bar. */
function readDismissed(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * One quiet line when you have unspent endorsements from a recent match.
 *
 * Not a notification: it only exists on a page you already opened, it goes
 * away for good when dismissed, and it never appears for anybody who has
 * nothing to give. Asked again on each navigation because that is when a
 * match you just finished becomes endorsable; the query is one indexed read.
 */
export function EndorseBar({ me, path }: { me: string | null; path: string }) {
  const [pending, setPending] = useState<PendingEndorsement[]>([]);
  const [dismissed, setDismissed] = useState<number[]>(readDismissed);

  useEffect(() => {
    if (!me) { setPending([]); return undefined; }
    const ac = new AbortController();
    api.endorsePending(ac.signal).then((r) => setPending(r.pending)).catch(() => setPending([]));
    return () => ac.abort();
  }, [me, path]);

  if (!me) return null;
  const next = pending.find((p) => !dismissed.includes(p.matchId) && path !== `/match/${p.matchId}`);
  if (!next) return null;

  const dismiss = () => {
    // Capped so the list cannot grow for ever; old ids are long past their
    // window and would never be offered again anyway.
    const ids = [...dismissed, next.matchId].slice(-50);
    setDismissed(ids);
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* remembered for this visit only */ }
  };

  return (
    <div class="endorsebar">
      <a href={`/match/${next.matchId}#endorse`}>
        You have {next.remaining} endorsement{next.remaining === 1 ? '' : 's'} to give from PUG #{next.matchId}
      </a>
      <button type="button" class="endorsebar__dismiss" aria-label="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
