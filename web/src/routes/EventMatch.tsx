import { useEffect, useState } from 'preact/hooks';
import { ApiError, entryLogoUrl, eventsApi, type MatchRoomView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { useHubEvent } from '../hooks/useHubEvent';
import type { Session } from '../hooks/useLiveState';
import { PHASE_TEXT, clockText, logText } from './event/room/roomText';
import { VetoBoard } from './event/room/VetoBoard';
import { LineupPanel } from './event/room/LineupPanel';

const LIVE = new Set(['ready', 'veto', 'lineup']);

/** One tournament match's room (plan T3a): ready check, veto, lineups. */
export function EventMatchPage({ slug, id, session: _session }: { slug: string; id: string; session: Session }) {
  const matchId = Number(id);
  const [v, setV] = useState<MatchRoomView | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  const load = () => eventsApi.room(slug, matchId).then((x) => {
    setV(x);
    setOffset(Date.parse(x.serverNow) - Date.now());
  }, (e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); });

  useEffect(() => { void load(); }, [slug, id]);
  useHubEvent(['event_room'], () => { void load(); });
  useEffect(() => {
    if (!v || !LIVE.has(v.phase)) return undefined;
    const poll = setInterval(() => { void load(); }, 10_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.phase]);

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

  if (missing || !Number.isInteger(matchId)) return <main class="page page--profile"><PageHeader title="Match" /><Empty>No such match.</Empty></main>;
  if (!v) return <main class="page page--profile"><PageHeader title="Match" /></main>;

  const left = v.deadline ? Date.parse(v.deadline) - (now + offset) : null;
  const me = v.me;
  const myReady = me ? v.ready[me.side] : true;
  const showVeto = v.phase === 'veto' || v.pool.some((c) => c.state !== 'open');
  const showLineups = v.phase === 'lineup' || v.phase === 'server' || v.lineups.aLocked || v.lineups.bLocked;
  return (
    <main class="page page--profile room">
      <PageHeader
        title={`${v.a?.name ?? 'TBD'} vs ${v.b?.name ?? 'TBD'}`}
        aside={<span class={`teamchip roomphase roomphase--${v.phase}`}>{PHASE_TEXT[v.phase]}</span>}
      >
        <p class="room__sub">
          <a href={`/event/${v.eventSlug}`}>{v.eventName}</a> · {v.roundLabel}
          {left !== null && <span class="room__clock"> · {clockText(left)} left</span>}
        </p>
      </PageHeader>
      {problem && <p class="error" role="alert">{problem}</p>}
      {v.phase === 'ready' && v.a && v.b && (
        <Panel>
          <h3>Ready check</h3>
          <ul class="room__ready">
            {(['a', 'b'] as const).map((s) => (
              <li key={s}>
                {v[s]?.logoKey ? <img class="evententry__logo" src={entryLogoUrl(v[s]!.logoKey!)} alt="" width={28} height={28} /> : null}
                <span>{`${v[s]?.name ?? 'TBD'}: ${v.ready[s] ? 'ready' : 'waiting'}`}</span>
              </li>
            ))}
          </ul>
          {me?.manager && !myReady && <button class="btn" type="button" disabled={busy} onClick={() => run(() => eventsApi.ready(slug, matchId))}>Ready</button>}
        </Panel>
      )}
      {showVeto && v.a && v.b && (
        <Panel>
          <h3>Veto</h3>
          <VetoBoard v={v} busy={busy} onAct={(step, action, campaign) => { void run(() => eventsApi.veto(slug, matchId, step, action, campaign)); }} />
          {v.games.length > 0 && (
            <ul class="room__games">
              {v.games.map((g) => (
                <li key={g.game}>{`Game ${g.game}: ${g.campaignName}${g.firstSurvivors ? ` · ${g.firstSurvivors === 'a' ? v.a?.name : v.b?.name} start as survivors` : ''}`}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {showLineups && v.a && v.b && (
        <Panel>
          <h3>Lineups</h3>
          <LineupPanel v={v} busy={busy} onLock={(ids) => run(() => eventsApi.lineup(slug, matchId, ids))} />
        </Panel>
      )}
      {v.phase === 'server' && <Panel><p>Lineups locked. Staff are setting up the server; the connect details come from them.</p></Panel>}
      {v.phase === 'hold' && <Panel><p class="warning">{`On hold: staff are looking at this match.${v.holdReason ? ` (${v.holdReason})` : ''}`}</p></Panel>}
      {v.phase === 'done' && (
        <Panel>
          <p>{v.result
            ? (v.result.forfeit
              ? `Forfeit win for ${v.result.winner === 'a' ? v.a?.name : v.b?.name}.`
              : `${v.result.winner === 'a' ? v.a?.name : v.b?.name} won ${v.result.scoreA} to ${v.result.scoreB}.`)
            : 'This match is finished.'}
          </p>
        </Panel>
      )}
      {v.log.length > 0 && (
        <Panel>
          <h3>Veto log</h3>
          <ol class="room__log">{v.log.map((l) => <li key={l.step}>{logText(v, l)}</li>)}</ol>
        </Panel>
      )}
    </main>
  );
}

export default EventMatchPage;
