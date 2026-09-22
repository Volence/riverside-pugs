import { useEffect, useState } from 'preact/hooks';
import { peopleApi, type StaffChatLine } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel } from '../components/bits';
import { fmtClock } from '../format';

/** Where in the match a line was said, in words. */
export function chatWhen(l: Pick<StaffChatLine, 'mapOrdinal' | 'half' | 'tMs'>): string {
  const map = `Map ${l.mapOrdinal + 1}`;
  if (l.half < 0) return `${map}, before the first round`;
  const round = `round ${l.half}`;
  return l.tMs < 0 ? `${map}, ${round}, outside play` : `${map}, ${round}, ${fmtClock(l.tMs / 1000)}`;
}

/**
 * Every chat line of a finished match, for staff only.
 *
 * The replay timeline shows only what was said while a round clock ran. This
 * shows the rest as well (ready-ups, pauses, between rounds), which is where
 * a report about what someone said usually points. Opened from a Player File
 * with `?chat=<steamid>`, it marks that player's lines and scrolls to them.
 */
export function StaffChatLog({ matchId, highlight }: { matchId: number; highlight: string | null }) {
  const { data, error } = useFetch((s) => peopleApi.chat(matchId, s), [matchId]);
  const [onlyThem, setOnlyThem] = useState(false);
  const lines = data?.lines ?? [];
  const theirs = highlight ? lines.filter((l) => l.player === highlight || l.steamid === highlight) : [];
  const shown = onlyThem ? theirs : lines;

  useEffect(() => {
    if (!highlight || theirs.length === 0) return;
    document.getElementById('chat')?.scrollIntoView?.({ block: 'start' });
  }, [highlight, theirs.length > 0]);

  let lastWhere = '';
  return (
    <Panel class="chatlog">
      <h3 id="chat">Chat log</h3>
      <p class="muted">
        Staff only. Everything said in the match, including ready-ups, pauses and between rounds.
        Team chat and all chat are not told apart.
      </p>
      {error && <p class="error">Could not load the chat.</p>}
      {data && lines.length === 0 && <Empty>Nobody said anything in this match.</Empty>}
      {highlight && theirs.length > 0 && (
        <p>
          <label>
            <input type="checkbox" checked={onlyThem} onChange={() => setOnlyThem(!onlyThem)} />
            {' '}Only {theirs[0].name} ({theirs.length} line{theirs.length === 1 ? '' : 's'})
          </label>
        </p>
      )}
      {highlight && data && lines.length > 0 && theirs.length === 0 && (
        <p class="muted">This player said nothing in this match.</p>
      )}
      {shown.length > 0 && (
        <ol class="chatlog__lines">
          {shown.map((l) => {
            const where = l.half < 0 || l.tMs < 0 ? chatWhen(l) : `Map ${l.mapOrdinal + 1}, round ${l.half}`;
            const heading = where !== lastWhere ? where : null;
            lastWhere = where;
            const mine = highlight !== null && (l.player === highlight || l.steamid === highlight);
            return (
              <li key={l.seq} class={`chatlog__line${mine ? ' is-mine' : ''}`}>
                {heading && <div class="chatlog__where muted">{heading}</div>}
                <span class="chatlog__time muted num">{l.tMs >= 0 ? fmtClock(l.tMs / 1000) : ''}</span>
                <span class={`chatlog__who chatlog__who--${l.team ?? 'none'}`}>{l.name}</span>
                <span class="chatlog__msg">{l.message}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
