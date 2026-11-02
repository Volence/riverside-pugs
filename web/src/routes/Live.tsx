import { useEffect, useState } from 'preact/hooks';
import { api, eventsApi, type LiveEvent, type LiveMatch, type LivePlayer } from '../api';
import {
  campaignName, campaignTint, deriveLiveStats, fmtAgo, fmtBytes, labelFor, liveGroupStarts, mapName,
  orderLiveStatKeys,
} from '../format';
import { STATUS_LABEL, roundWhenText } from '../eventFormat';
import { useFetch } from '../hooks/useFetch';
import { QUEUE_SIZE } from '../queueSize';
import { Panel, PlayerLink } from '../components/bits';
import { SpectatePanel } from '../components/SpectatePanel';
import { StreamStrip } from '../components/StreamStrip';
import { PageHeader } from '../components/PageHeader';
import { VersusHeader } from '../components/VersusHeader';
import { StatTable, EventFeed } from '../components/StatTable';
import { Viewer } from '../replay/Viewer';
import { WinChart, fmtChance } from '../components/WinChart';
import type { WinLine } from '../api';

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

/** Events past their last match, left off the quiet page's Next event card. */
const OVER = new Set(['finished', 'cancelled']);

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
      {m.winLine && <LiveOdds line={m.winLine} />}
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
 * Both teams' chance right now as one split bar, the line so far behind a
 * toggle once a full map has been played. Same model as the finished match
 * page (src/winProb.ts): the scoreboard and the maps still to play, never
 * the ratings.
 */
export function LiveOdds({ line }: { line: WinLine }) {
  const p = line.points[line.points.length - 1].pA;
  const pctA = Math.round(p * 1000) / 10;
  return (
    <div class="liveodds">
      <div class="liveodds__labels">
        <span>Team A {fmtChance(p)}</span>
        <span class="muted">win chance</span>
        <span>Team B {fmtChance(1 - p)}</span>
      </div>
      <div class="liveodds__bar" role="img" aria-label={`Win chance: Team A ${fmtChance(p)}, Team B ${fmtChance(1 - p)}`}>
        <span class="liveodds__a" style={{ width: `${pctA}%` }} />
        <span class="liveodds__b" />
      </div>
      {line.points.length >= 3 && (
        <details class="liveodds__more">
          <summary>The line so far</summary>
          <WinChart line={line} />
        </details>
      )}
    </div>
  );
}

/**
 * What the Live page shows when no match is running, which is most of the time.
 *
 * "Nothing being played right now." was a dead end: true, and no reason to
 * still be on the page. This is the same fact plus the three things a reader
 * actually wants next: whether a game is close to starting, what is coming up
 * on the events side, and what the last one was.
 *
 * Fetched here rather than lifted into Live, so the polling loop above is not
 * made to carry data it never uses while a match IS live.
 */
function NothingLive() {
  const { data: queue } = useFetch((s) => api.queue(s), []);
  const { data: recent } = useFetch((s) => api.matches(s), []);
  // The events list 404s while the competitive switch keeps events to staff;
  // the card is simply left out then.
  const { data: events } = useFetch((s) => eventsApi.list(s), []);
  const last = recent?.matches?.[0] ?? null;
  const next = events?.events
    .filter((e) => !OVER.has(e.status))
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt))[0] ?? null;
  const count = queue?.count ?? 0;

  return (
    <div class="quiet">
      <p class="quiet__lede">
        <span class="quiet__dot" aria-hidden="true" />
        Nothing being played right now.
      </p>
      <div class="quiet__grid">
        <a class="quiet__card" href="/">
          <span class="eyebrow">Queue</span>
          <span class="quiet__big num">{count}<span class="quiet__of"> / {QUEUE_SIZE}</span></span>
          <span class="quiet__bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (count / QUEUE_SIZE) * 100)}%` }} /></span>
          <span class="quiet__line">
            {count === 0 ? 'Empty. Join and it starts filling.'
              : count >= QUEUE_SIZE - 2 ? `${QUEUE_SIZE - count} more and it pops.`
                : 'Waiting for players.'}
          </span>
          <span class="quiet__cta">{count === 0 ? 'Start the queue' : 'Join the queue'}</span>
        </a>

        {next && (
          <a class="quiet__card" href={`/event/${next.slug}`}>
            <span class="eyebrow">Next event</span>
            <span class="quiet__name">{next.name}</span>
            <span class="quiet__line">{roundWhenText(next.startsAt)}</span>
            <span class="quiet__line muted">{[next.statusLabel ?? STATUS_LABEL[next.status], next.format.join(', then ')].filter(Boolean).join(' · ')}</span>
            <span class="quiet__cta">Event page</span>
          </a>
        )}

        {last && (
          <a class="quiet__card" href={`/match/${last.id}`}
             style={{ '--campaign': campaignTint(last.campaign) } as Record<string, string>}>
            <span class="eyebrow">Last match · {fmtAgo(last.endedAt)}</span>
            <span class="quiet__name">{campaignName(last.campaign)}</span>
            <span class="quiet__big num">
              <span class={last.winner === 'a' ? 'is-won' : undefined}>{last.teamAScore}</span>
              <span class="quiet__of"> - </span>
              <span class={last.winner === 'b' ? 'is-won' : undefined}>{last.teamBScore}</span>
            </span>
            <span class="quiet__cta">Full stats</span>
          </a>
        )}
      </div>
      <p class="quiet__foot muted">
        New here? <a href="/how-to-play">How to play</a> walks through linking your account and joining your first game.
        {' '}<a href="/matches">All recent matches</a> · <a href="/leaderboard">Leaderboard</a>
      </p>
    </div>
  );
}
