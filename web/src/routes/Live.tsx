import { useEffect, useState } from 'preact/hooks';
import { api, type LiveEvent, type LiveMatch, type LivePlayer } from '../api';
import {
  campaignName, deriveLiveStats, fmtBytes, fmtDate, labelFor, liveGroupStarts, mapName,
  orderLiveStatKeys, winnerLabel,
} from '../format';
import { useFetch } from '../hooks/useFetch';
import { QUEUE_SIZE } from '../queueSize';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { SpectatePanel } from '../components/SpectatePanel';
import { StreamStrip } from '../components/StreamStrip';
import { PageHeader } from '../components/PageHeader';
import { VersusHeader } from '../components/VersusHeader';
import { StatTable, EventFeed } from '../components/StatTable';
import { Viewer } from '../replay/Viewer';

/** Name lookup for the viewer's follow row and timeline rail, from the
 *  rosters this card already has. */
function namesFor(m: LiveMatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [...m.teamA, ...m.teamB]) out[p.steamid] = p.name;
  return out;
}

/** How often to re-fetch. Polled rather than driven by the websocket nudge:
 *  `stale` is computed from elapsed time, so this page has to re-render on a
 *  timer regardless of whether anything was pushed. The plugin emits stats
 *  every 10s, so polling faster than that buys nothing. */
const POLL_MS = 5000;

/** Stats that are a level rather than a counter: shown as-is, never
 *  differenced. Mirrors LEVEL_KEYS in src/liveView.ts. */
const LEVEL_KEYS = new Set(['hp', 'hp_temp', 'hp_perm']);

export function Live({ me }: { me: string | null }) {
  const [matches, setMatches] = useState<LiveMatch[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.live();
        if (!cancelled) setMatches(res.matches);
      } catch {
        // Keep the last good render rather than blanking the page on a blip.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (matches === null) return <div class="page page--list" />;

  return (
    <div class="page page--list">
      <StreamStrip />
      <PageHeader eyebrow="Right now" title="Live" />

      {matches.length === 0 ? (
        <NothingLive />
      ) : (
        <div class="stack">
          {matches.map((m) => <LiveCard key={m.id} m={m} me={me} />)}
        </div>
      )}
    </div>
  );
}

function LiveCard({ m, me }: { m: LiveMatch; me: string | null }) {
  // Every table on the card shares one column set, derived from the cumulative
  // totals, so the same stat sits in the same place whichever table you read.
  const withDerived = (p: LivePlayer): LivePlayer =>
    ({ ...p, stats: deriveLiveStats(p.stats ?? {}) });
  const totalsA = m.teamA.map(withDerived);
  const totalsB = m.teamB.map(withDerived);
  const cols = orderLiveStatKeys(
    Array.from(new Set([...totalsA, ...totalsB].flatMap((p) => Object.keys(p.stats ?? {})))),
  );

  // What has happened on the map being played right now: cumulative minus
  // everything already banked by completed maps. The map rows carry their own
  // stats, so summing them gives the banked figure without a second payload.
  const banked = (steamid: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const mp of m.maps) {
      for (const [k, v] of Object.entries(mp.stats[steamid] ?? {})) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  };
  const currentOf = (players: LivePlayer[]) =>
    players.map((p) => {
      const b = banked(p.steamid);
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.stats ?? {})) {
        // Levels pass through untouched; only counters are net-of-banked.
        // Kept in step with LEVEL_KEYS in src/liveView.ts.
        stats[k] = LEVEL_KEYS.has(k) ? v : Math.max(0, v - (b[k] ?? 0));
      }
      return { ...p, stats: deriveLiveStats(stats) };
    });

  const mapPlayers = (mp: LiveMatch['maps'][number], players: LivePlayer[]) =>
    players.map((p) => ({ ...p, stats: deriveLiveStats(mp.stats[p.steamid] ?? {}) }));

  return (
    <Panel>
      <VersusHeader
        teamA={m.teamA.map((p) => p.name)}
        teamB={m.teamB.map((p) => p.name)}
        scoreA={m.teamAScore}
        scoreB={m.teamBScore}
        subline={
          <>
            {campaignName(m.campaign)} · {m.currentMap ?? 'starting up'} · map {m.maps.length + 1}
            {m.stale && <span class="live__stale"> · no signal</span>}
            {' · '}<a href={`/match/${m.id}`}>#{m.id}</a>
          </>
        }
      />
      {m.spectate && <SpectatePanel spectate={m.spectate} />}
      <Viewer spec={{ kind: 'live-match', matchId: m.id }} live names={namesFor(m)} />

      {cols.length === 0 ? (
        <div class="live__teams">
          {([['A', m.teamA], ['B', m.teamB]] as const).map(([label, players]) => (
            <div key={label}>
              <h4>Team {label}</h4>
              <ul class="live__roster">
                {players.map((p) => (
                  <li key={p.steamid}><PlayerLink steamid={p.steamid} name={p.name} discordName={p.discordName} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <>
          <section class="live__section">
            <h4>This map{m.currentMap ? ` · ${m.currentMap}` : ''}</h4>
            <StatTable teamA={currentOf(totalsA)} teamB={currentOf(totalsB)} cols={cols} />
          </section>

          {m.maps.map((mp) => (
            <section class="live__section" key={mp.ordinal}>
              <h4>
                Map {mp.ordinal + 1} · {mapName(mp.map)}
                <span class="muted"> · {mp.teamAScore} - {mp.teamBScore}</span>
                {(() => {
                  const demo = m.demos.find((d) => d.ordinal === mp.ordinal);
                  return demo
                    ? <> · <a href={`/api/matches/${m.id}/demos/${demo.ordinal}`} download>
                        demo {fmtBytes(demo.bytes)}
                      </a></>
                    : <span class="muted"> · demo recording</span>;
                })()}
              </h4>
              <StatTable
                teamA={mapPlayers(mp, m.teamA)}
                teamB={mapPlayers(mp, m.teamB)}
                cols={cols}
              />
            </section>
          ))}

          <section class="live__section">
            <h4>Match totals</h4>
            <StatTable teamA={totalsA} teamB={totalsB} cols={cols} />
          </section>
        </>
      )}

      {m.events.length > 0 && <EventFeed events={m.events} maps={m.maps} />}
    </Panel>
  );
}



/**
 * What the Live page shows when no match is running, which is most of the time.
 *
 * "Nothing being played right now." was a dead end: true, and no reason to
 * still be on the page. This is the same fact plus the two things a reader
 * actually wants next, which is whether a game is close to starting and what
 * the last one was.
 *
 * Fetched here rather than lifted into Live, so the polling loop above is not
 * made to carry data it never uses while a match IS live.
 */
function NothingLive() {
  const { data: queue } = useFetch((s) => api.queue(s), []);
  const { data: recent } = useFetch((s) => api.matches(s), []);
  const last = recent?.matches?.[0] ?? null;

  return (
    <div class="stack">
      <Panel>
        <Empty>Nothing being played right now.</Empty>
        {queue && (
          <p class="nothinglive__queue">
            {queue.count === 0
              ? <>The queue is empty. <a href="/">Join it</a> and it starts filling.</>
              : <><strong>{queue.count} of {QUEUE_SIZE}</strong> in the queue right now. <a href="/">Join</a>{queue.count >= QUEUE_SIZE - 2 ? ' and it pops.' : '.'}</>}
          </p>
        )}
        <p class="muted">
          New here? <a href="/how-to-play">How to play</a> walks through linking your
          account and joining your first game.
        </p>
      </Panel>

      {last && (
        <Panel>
          <h3>Last match</h3>
          <p class="nothinglive__last">
            <a href={`/match/${last.id}`}>{campaignName(last.campaign)}</a>
            {' · '}
            <span class="num">{last.teamAScore} - {last.teamBScore}</span>
            {last.winner ? <> · {winnerLabel(last.winner)}</> : null}
            {last.endedAt ? <span class="muted"> · {fmtDate(last.endedAt)}</span> : null}
          </p>
          <p class="muted"><a href="/matches">All recent matches</a> · <a href="/leaderboard">Leaderboard</a></p>
        </Panel>
      )}
    </div>
  );
}
