import { useEffect, useState } from 'preact/hooks';
import { ApiError, entryLogoUrl, eventsApi, type MatchRoomView } from '../api';
import { Empty, PageSkeleton, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { useHubEvent } from '../hooks/useHubEvent';
import type { Session } from '../hooks/useLiveState';
import { whenText } from '../eventFormat';
import { PHASE_TEXT, clockText, holdText, logText } from './event/room/roomText';
import { VetoBoard } from './event/room/VetoBoard';
import { LineupPanel } from './event/room/LineupPanel';
import { ServerPanel } from './event/room/ServerPanel';
import { ConfirmPanel } from './event/room/ConfirmPanel';
import { SchedulePanel } from './event/room/SchedulePanel';
import { PausePanel } from './event/room/PausePanel';
import { GameCards, LineupColumns, MatchHero, useGameStats } from './event/room/MatchSheet';

/** Phases the page refetches in every 10 s. A result can close a room
 *  (server, hold) and a reset can reopen one (waiting) with no push. */
const POLLED = new Set(['waiting', 'ready', 'veto', 'lineup', 'server', 'connect', 'live', 'confirming', 'hold']);

/** A team's logo (only once it has one) next to its name, used in the room
 *  header and the ready check so both read the same way. */
function Team({ name, logoKey }: { name: string; logoKey: string | null | undefined }) {
  return (
    <span class="roomteam">
      {logoKey && <img class="evententry__logo" src={entryLogoUrl(logoKey)} alt="" width={28} height={28} />}
      <span>{name}</span>
    </span>
  );
}

/** One tournament match's room (plan T3a): ready check, veto, lineups. */
export function EventMatchPage({ slug, id, session: _session }: { slug: string; id: string; session: Session }) {
  const matchId = Number(id);
  const [v, setV] = useState<MatchRoomView | null>(null);
  const [missing, setMissing] = useState(false);
  // Only shown while there is no view yet: a failed refetch keeps the room on screen.
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const gameStats = useGameStats(v);

  const load = () => eventsApi.room(slug, matchId).then((x) => {
    setV(x);
    setFailed(false);
    setOffset(Date.parse(x.serverNow) - Date.now());
  }, (e) => {
    if (e instanceof ApiError && e.status === 404) setMissing(true);
    else setFailed(true);
  });

  useEffect(() => { void load(); }, [slug, id]);
  useHubEvent(['event_room'], () => { void load(); });
  useEffect(() => {
    if (!v || !POLLED.has(v.phase)) return undefined;
    const poll = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.phase]);
  const hasDeadline = !!v?.deadline;
  useEffect(() => {
    if (!hasDeadline) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [hasDeadline]);

  /** Returns whether `fn` went through, so a caller that needs to know (the
   *  Schedule panel's counter form, which should stay open on a refusal) can
   *  await it; everyone else just discards it with `void`. */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      setProblem(e instanceof ApiError ? e.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
      await load();
    }
    return ok;
  };

  if (missing || !Number.isInteger(matchId)) return <main class="page page--profile"><PageHeader title="Match" /><Empty>No such match.</Empty></main>;
  if (!v && failed) {
    return (
      <main class="page page--profile">
        <PageHeader title="Match" />
        <p class="error" role="alert">Could not load this match. <button class="btn btn--ghost btn--sm" type="button" onClick={() => { setFailed(false); void load(); }}>Try again</button></p>
      </main>
    );
  }
  if (!v) return <PageSkeleton variant="profile" panels={3} />;

  const left = v.deadline ? Date.parse(v.deadline) - (now + offset) : null;
  const me = v.me;
  const myReady = me ? v.ready[me.side] : true;
  const showVeto = v.phase === 'veto' || v.pool.some((c) => c.state !== 'open');
  const showLineups = v.phase === 'lineup' || v.phase === 'server' || v.lineups.aLocked || v.lineups.bLocked;
  // While lineups are open they are the one thing to do, so they lead the
  // page instead of sitting under the finished veto.
  const lineupFirst = v.phase === 'lineup';
  const board = <VetoBoard v={v} busy={busy} onAct={(step, action, campaign) => { void run(() => eventsApi.veto(slug, matchId, step, action, campaign)); }} />;
  // While lineups are open the picker is the panel; once both are set (or
  // the match moved on) the two fours show as profile-linked columns.
  const lineups = v.a && v.b && (
    <Panel>
      <h3>Lineups</h3>
      {v.phase === 'lineup'
        ? <LineupPanel v={v} busy={busy} onLock={async (ids) => { await run(() => eventsApi.lineup(slug, matchId, ids)); }} />
        : <LineupColumns v={v} stats={gameStats} />}
    </Panel>
  );
  const done = v.phase === 'done';
  const when = v.finishedAt ? whenText(v.finishedAt) : v.schedule?.scheduledAt ? whenText(v.schedule.scheduledAt) : null;
  return (
    <main class="page page--profile room">
      <PageHeader
        eyebrow={`${v.eventName} · ${v.roundLabel}`}
        title={`${v.a?.name ?? 'TBD'} vs ${v.b?.name ?? 'TBD'}`}
        aside={<span class={`teamchip roomphase roomphase--${v.phase}`}>{PHASE_TEXT[v.phase]}</span>}
      >
        <p class="room__sub">
          <a href={`/event/${v.eventSlug}`}>Back to {v.eventName}</a>
          {left !== null && <span class="room__clock"> · {clockText(left)} left</span>}
        </p>
      </PageHeader>
      {v.a && v.b && <MatchHero v={v} when={when} />}
      {problem && <p class="error" role="alert">{problem}</p>}
      {lineupFirst && lineups}
      {v.schedule && (v.phase === 'waiting' || v.phase === 'hold' || v.schedule.log.length > 0) && (
        <Panel>
          <h3>Schedule</h3>
          <SchedulePanel
            v={v} busy={busy}
            onPropose={(time, note) => { void run(() => eventsApi.propose(slug, matchId, time, note)); }}
            onRespond={(accept) => { void run(() => eventsApi.respond(slug, matchId, accept)); }}
            onCounter={(time, note) => run(() => eventsApi.counter(slug, matchId, time, note))}
            onWithdraw={() => { void run(() => eventsApi.withdrawProposal(slug, matchId)); }}
          />
        </Panel>
      )}
      {(v.phase === 'server' || v.phase === 'connect' || v.phase === 'live' || v.phase === 'confirming') && (
        <Panel>
          <h3>Server</h3>
          <ServerPanel v={v} now={now + offset} />
        </Panel>
      )}
      {v.pauses.length > 0 && (
        <Panel>
          <h3>Technical pauses</h3>
          <PausePanel v={v} />
        </Panel>
      )}
      {v.phase === 'ready' && v.a && v.b && (
        <Panel>
          <h3>Ready check</h3>
          <ul class="room__ready">
            {(['a', 'b'] as const).map((s) => (
              <li key={s}>
                <Team name={v[s]?.name ?? 'TBD'} logoKey={v[s]?.logoKey} />
                <span class={`teamchip${v.ready[s] ? ' teamchip--ready' : ''}`}>{v.ready[s] ? 'Ready' : 'Waiting'}</span>
              </li>
            ))}
          </ul>
          <p class="muted">{me?.manager
            ? 'Press Ready once your team is here. A team that is not ready when the clock runs out forfeits; if neither is, staff decide.'
            : 'Each captain presses Ready here. A team that is not ready when the clock runs out forfeits; if neither is, staff decide.'}</p>
          {me?.manager && !myReady && <button class="btn" type="button" disabled={busy} onClick={() => run(() => eventsApi.ready(slug, matchId))}>Ready</button>}
        </Panel>
      )}
      {done && v.games.length > 0 && (
        <Panel>
          <h3>{v.games.length === 1 ? 'Game' : 'Games'}</h3>
          <GameCards v={v} />
        </Panel>
      )}
      {done && showLineups && lineups}
      {showVeto && v.a && v.b && (
        <Panel>
          <h3>Veto</h3>
          {v.phase === 'veto' ? board : (
            // Done: the campaign and sides are in the Series panel, so the
            // full board folds away instead of filling a phone screen.
            <details class="room__vetodone">
              <summary>Show the bans and picks</summary>
              {board}
              {done && v.log.length > 0 && (
                <>
                  <h4 class="room__logtitle">Veto log</h4>
                  <ol class="room__log">{v.log.map((l) => <li key={l.step}>{logText(v, l)}</li>)}</ol>
                </>
              )}
            </details>
          )}
        </Panel>
      )}
      {!v.series && v.games.length > 0 && (
        <Panel>
          <h3>Games</h3>
          <ul class="room__games">
            {v.games.map((g) => (
              <li key={g.game}>{`Game ${g.game}: ${g.campaignName}${g.firstSurvivors ? ` · ${g.firstSurvivors === 'a' ? v.a?.name : v.b?.name} start as survivors` : ''}`}</li>
            ))}
          </ul>
        </Panel>
      )}
      {v.series && !done && (
        <Panel>
          <h3>Series</h3>
          <GameCards v={v} />
        </Panel>
      )}
      {showLineups && !lineupFirst && !done && lineups}
      {v.phase === 'confirming' && (
        <Panel>
          <h3>Result</h3>
          <ConfirmPanel
            v={v} now={now + offset} busy={busy}
            onConfirm={() => { void run(() => eventsApi.confirmResult(slug, matchId)); }}
            onDispute={(reason) => { void run(() => eventsApi.dispute(slug, matchId, reason)); }}
          />
        </Panel>
      )}
      {v.phase === 'hold' && (
        <Panel>
          <h3>On hold</h3>
          <p class="warning">Staff are looking at this match.</p>
          {v.holdReason && v.holdReason !== 'dispute' && <p>{`Reason: ${holdText(v.holdReason)}`}</p>}
          {v.dispute && <p>{`Disputed by ${v.dispute.byName} for ${v.dispute.side === 'a' ? v.a?.name ?? 'TBD' : v.b?.name ?? 'TBD'}: ${v.dispute.reason}`}</p>}
        </Panel>
      )}
      {done && !v.a && (
        <Panel>
          <h3>Result</h3>
          <p>This match is finished.</p>
        </Panel>
      )}
      {done && v.result?.forfeit && v.games.length === 0 && (
        <Panel>
          <h3>Result</h3>
          <p>{`Forfeit win for ${v.result.winner === 'a' ? v.a?.name : v.b?.name}.`}</p>
        </Panel>
      )}
      {v.log.length > 0 && !done && (
        <Panel>
          <h3>Veto log</h3>
          <ol class="room__log">{v.log.map((l) => <li key={l.step}>{logText(v, l)}</li>)}</ol>
        </Panel>
      )}
    </main>
  );
}

export default EventMatchPage;
