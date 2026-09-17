import { useEffect, useState } from 'preact/hooks';
import { api, type LiveEvent, type LiveMatch, type LivePlayer } from '../api';
import {
  campaignName, deriveLiveStats, fmtBytes, labelFor, liveGroupStarts, mapName, orderLiveStatKeys,
} from '../format';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { SpectatePanel } from '../components/SpectatePanel';
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
      <PageHeader eyebrow="Right now" title="Live" />

      {matches.length === 0 ? (
        <Panel><Empty>Nothing being played right now.</Empty></Panel>
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
                  <li key={p.steamid}><PlayerLink steamid={p.steamid} name={p.name} /></li>
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

