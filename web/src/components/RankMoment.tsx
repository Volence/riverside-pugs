import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type RankMomentData, type StateSnapshot } from '../api';
import { playMoment } from '../rankMomentFx';

const SEEN_KEY = (steamid: string) => `rank-moment-seen:${steamid}`;

function seenMatch(steamid: string): number {
  try { return Number(localStorage.getItem(SEEN_KEY(steamid)) ?? 0) || 0; } catch { return 0; }
}
function markSeen(steamid: string, matchId: number): void {
  try { localStorage.setItem(SEEN_KEY(steamid), String(matchId)); } catch { /* private window: it may play again */ }
}

/**
 * The rank-up moment (src/rankMoment.ts): when your last match finished your
 * placement or moved you up a division, the next time the site is open it
 * plays the animation once, in a dialog over the page. Remembered per match
 * in this browser. Never over a ready check or a live match of yours: those
 * need the screen, and it waits until they are over. Off before Season 1:
 * the server answers null until then.
 */
export function RankMoment({ me, state }: { me: string | null; state: StateSnapshot | null }) {
  const [moment, setMoment] = useState<RankMomentData | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const busy = !!state?.match || !!state?.lobby;
  // Re-asked whenever the viewer's own match comes and goes, so it plays as
  // soon as they are back on the site after the match.
  const matchKey = state?.match?.id ?? 0;

  useEffect(() => {
    if (!me || busy) return;
    const ctl = new AbortController();
    api.rankMoment(ctl.signal).then((r) => {
      if (r.moment && r.moment.matchId > seenMatch(me)) setMoment(r.moment);
    }).catch(() => { /* a missing celebration is not an error worth showing */ });
    return () => ctl.abort();
  }, [me, busy, matchKey]);

  useEffect(() => {
    if (!moment || !stage.current) return;
    let gone = false;
    void playMoment(stage.current, moment, () => gone);
    return () => { gone = true; };
  }, [moment]);

  if (!moment || !me) return null;
  const close = () => { markSeen(me, moment.matchId); setMoment(null); };
  return (
    <div class="rankmoment" role="dialog" aria-modal="true"
         aria-label={moment.kind === 'placed' ? `You placed ${moment.to}` : `Ranked up to ${moment.to}`}
         onClick={(e) => { if (e.target === e.currentTarget) close(); }}
         onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div class="rankmoment__box">
        <div class="ru" ref={stage} />
        <button type="button" class="btn btn--block" onClick={close} autoFocus>Continue</button>
      </div>
    </div>
  );
}
