import { useEffect, useState } from 'preact/hooks';
import { api, type StreamCard } from '../api';

const POLL_MS = 60_000;
const SHOWN = 5;

/**
 * One line at the top of Live.
 *
 * Renders nothing at all when nobody is live, because that page is already a
 * long scroll with a replay viewer per game and a quiet night should leave it
 * exactly as it was. Not sticky, for the same reason: a bar pinned to the top
 * would take space from the thing people came for.
 */
export function StreamStrip() {
  const [cards, setCards] = useState<StreamCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const v = await api.streams();
        // In-PUG first, so the avatars shown are the ones streaming the match
        // the viewer is looking at.
        if (!cancelled) setCards([...v.inPug, ...v.live]);
      } catch {
        // Leave whatever is up.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (cards.length === 0) return null;

  return (
    <a class="streamstrip" href="/streams">
      <span class="streamstrip__dot" aria-hidden="true" />
      <span class="streamstrip__avatars">
        {cards.slice(0, SHOWN).map((c) => (
          c.avatar
            ? <img key={c.steamid} class="streamstrip__avatar" src={c.avatar} alt={c.name} />
            : <span key={c.steamid} class="streamstrip__avatar streamstrip__avatar--blank" />
        ))}
      </span>
      <span class="streamstrip__text">
        {cards.length === 1 ? '1 streaming now' : `${cards.length} streaming now`}
      </span>
    </a>
  );
}
