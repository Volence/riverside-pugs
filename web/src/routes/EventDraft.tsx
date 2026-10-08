// web/src/routes/EventDraft.tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, eventsApi, type DraftPickView, type DraftRoomView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { useHubEvent } from '../hooks/useHubEvent';
import type { Session } from '../hooks/useLiveState';
import { playPopSound } from '../popSound';
import { clockText } from './event/room/roomText';
import { DraftCard } from './event/draft/DraftCard';
import { PickListDrawer } from './event/draft/PickListDrawer';
import { STATUS_TEXT, freshPicks, pickKey, sortedPool, type PoolSort } from './event/draft/draftText';

const HEARTBEAT_MS = 10_000;
/** A safety net under the hub push (a dropped socket, a status change made on the desk). */
const POLL_MS = 15_000;
const REVEAL_MS = 4_000;

/** The live draft room (drafts plan D2b1 Ruling 13). Everyone can watch; a
 *  captain or delegate also heartbeats, picks on their turn and edits their
 *  list. The server tailors what each viewer gets, so nothing private is
 *  hidden here: it was never sent. */
export function EventDraftPage({ slug, session: _session }: { slug: string; session: Session }) {
  const [v, setV] = useState<DraftRoomView | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<PoolSort>('sr');
  const [reveal, setReveal] = useState<DraftPickView | null>(null);
  const [drawer, setDrawer] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const wasOnClock = useRef(false);

  const load = () => eventsApi.draftRoom(slug).then((x) => {
    setV(x);
    setOffset(Date.parse(x.serverNow) - Date.now());
    setNow(Date.now());
    const r = freshPicks(seen.current, x.picks);
    seen.current = r.seen;
    const latest = r.fresh.at(-1);
    if (latest) setReveal(latest);
    if (x.me.onClock && !wasOnClock.current) playPopSound();
    wasOnClock.current = x.me.onClock;
  }, (e) => {
    setMissing(e instanceof ApiError && e.status === 404 ? 'No such draft.'
      : e instanceof ApiError && e.status === 409 ? 'The draft room opens once the cut is published.' : 'Could not load the draft room.');
  });

  useEffect(() => { void load(); }, [slug]);
  useHubEvent([v ? `draft:${v.eventId}` : 'draft:none'], () => { void load(); });
  useEffect(() => {
    if (!v || v.status === 'done') return undefined;
    const poll = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.status]);
  const deadline = v?.deadlineAt ?? null;
  useEffect(() => {
    if (!deadline) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [deadline]);
  const role = v?.me.role ?? null;
  useEffect(() => {
    if (!role) return undefined;
    const beat = () => { void eventsApi.draftHeartbeat(slug).catch(() => {}); };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    // A backgrounded tab throttles its timers: beat and refresh the moment it is seen again.
    const seenAgain = () => { if (document.visibilityState === 'visible') { beat(); void load(); } };
    document.addEventListener('visibilitychange', seenAgain);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', seenAgain); };
  }, [slug, role]);
  useEffect(() => {
    if (!reveal) return undefined;
    const t = setTimeout(() => setReveal(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (missing) return <div class="page"><PageHeader title="Draft room" /><Empty>{missing}</Empty></div>;
  if (!v) return <div class="page"><PageHeader title="Draft room" /></div>;

  const nameOf = (s: string) => v.order.find((o) => o.steamid === s)?.name ?? v.picks.find((p) => p.steamid === s)?.name
    ?? v.pool.find((c) => c.steamid === s)?.name ?? s;
  const left = deadline ? Date.parse(deadline) - (now + offset) : 0;
  const pool = sortedPool(v.pool, filter, sort);
  const onClock = v.status === 'running' ? v.onClock : null;
  const canPick = v.me.onClock && onClock !== null;

  return (
    <div class="page draftroom">
      <PageHeader eyebrow="Draft room" title={v.eventName}>
        <p class="room__sub"><a href={`/event/${v.slug}`}>Back to the event</a></p>
      </PageHeader>
      {problem && <p class="error" role="alert">{problem}</p>}
      {reveal && (
        <div class="draftreveal" role="status">
          <span class="draftreveal__pick">{`Pick ${reveal.pickNo}`}</span>
          <strong class="draftreveal__name">{reveal.name}</strong>
          <span>{`to ${nameOf(reveal.captain)}'s team${reveal.auto ? ' (auto pick)' : ''}`}</span>
        </div>
      )}
      <Panel class="draftclock">
        {onClock ? (
          <>
            <p class="draftclock__who">{v.me.onClock ? 'You are on the clock' : `${nameOf(onClock.captain)} is on the clock`}</p>
            {onClock.picker !== onClock.captain && <p class="muted">{`${nameOf(onClock.picker)} picks for the team`}</p>}
            <p class="draftclock__time" aria-label="Time left">{clockText(left)}</p>
            <p class="muted">{`Pick ${onClock.pickNo} of ${v.totalPicks} · Round ${onClock.round}`}</p>
          </>
        ) : v.status === 'paused' ? (
          <>
            <p class="draftclock__who">{STATUS_TEXT.paused}</p>
            {v.pausedLeftMs !== null && <p class="muted">{`${clockText(v.pausedLeftMs)} left on the clock`}</p>}
          </>
        ) : (
          <p>{STATUS_TEXT[v.status === 'none' || v.status === 'ready' ? v.status : 'done']}</p>
        )}
        {v.me.role === 'captain' && <button class="btn btn--ghost" type="button" onClick={() => setDrawer(true)}>My pick list</button>}
      </Panel>
      <Panel>
        <h3>Teams</h3>
        <div class="draftboard">
          {v.teams.map((t) => (
            <div key={t.captain.steamid} class={`draftboard__team${onClock?.captain === t.captain.steamid ? ' is-up' : ''}`}>
              <h4>{t.captain.name}</h4>
              <ol class="draftboard__slots">
                {[0, 1, 2].map((i) => <li key={i}>{t.players[i]?.name ?? <span class="muted">Open</span>}</li>)}
              </ol>
            </div>
          ))}
        </div>
      </Panel>
      {v.pool.length > 0 && (
        <Panel>
          <h3>Pool</h3>
          <div class="inlinerow draftpool__tools">
            <input type="search" aria-label="Find a player" placeholder="Find a player" value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
            <select aria-label="Sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as PoolSort)}>
              <option value="sr">SR, high to low</option>
              <option value="name">Name</option>
            </select>
          </div>
          {pool.length === 0 ? <Empty>No player matches that name.</Empty> : (
            <div class="draftpool">
              {pool.map((c) => (
                <DraftCard key={c.steamid} card={c} note={v.notes?.[c.steamid] ?? null} chemistry={v.me.chemistry?.[c.steamid] ?? null}
                  action={canPick ? (
                    <button class="btn" type="button" disabled={busy} onClick={() => void run(() => eventsApi.draftPick(slug, c.steamid, onClock!.pickNo))}>{`Pick ${c.name}`}</button>
                  ) : undefined} />
              ))}
            </div>
          )}
        </Panel>
      )}
      {v.picks.length > 0 && (
        <Panel>
          <h3>Pick log</h3>
          <ol class="draftlog" reversed>
            {[...v.picks].reverse().map((p) => (
              <li key={pickKey(p)}>
                <span>{`#${p.pickNo} ${nameOf(p.captain)} took ${p.name}`}</span>
                {p.auto && <span class="chip">Auto</span>}
              </li>
            ))}
          </ol>
        </Panel>
      )}
      {drawer && <PickListDrawer slug={slug} onClose={() => setDrawer(false)} />}
    </div>
  );
}

export default EventDraftPage;
