import { api, type MatchPlayerStats, type Team } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, deriveLiveStats, fmtBytes, fmtDate, orderLiveStatKeys, winnerLabel } from '../format';
import { Empty, Panel, SrDelta } from '../components/bits';
import { StatTable, EventFeed, DemoPlaybackHint, type StatRow } from '../components/StatTable';

export function MatchDetail({ id, me }: { id: string; me: string | null }) {
  const { data, error } = useFetch((s) => api.match(id, s), [id]);

  if (error) {
    return (
      <div class="page page--match">
        <Panel><Empty>Match not found.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--match" />;

  const { match, maps, players } = data;

  // The dump gives per-player totals as fixed columns plus a bag of skill
  // stats; fold them into one object so the match page and the live page share
  // exactly one table component and one column order.
  const rowFor = (p: typeof players[number]): StatRow => ({
    steamid: p.steamid,
    name: p.name,
    stats: deriveLiveStats({
      ck: p.commonKills, sidmg: p.siDamage, sikill: p.siKills,
      ff: p.ffDealt, rev: p.revives,
      ...(p.stats ?? {}),
    }),
  });
  const totalsA = players.filter((p) => p.team === 'a').map(rowFor);
  const totalsB = players.filter((p) => p.team === 'b').map(rowFor);
  const cols = orderLiveStatKeys(
    Array.from(new Set([...totalsA, ...totalsB].flatMap((r) => Object.keys(r.stats)))),
  );

  const mapRows = (mp: typeof maps[number], team: 'a' | 'b'): StatRow[] =>
    players.filter((p) => p.team === team).map((p) => ({
      steamid: p.steamid,
      name: p.name,
      stats: deriveLiveStats(mp.stats?.[p.steamid] ?? {}),
    }));
  const hasMapStats = maps.some((mp) => Object.keys(mp.stats ?? {}).length > 0);

  return (
    <div class="page page--match">
      <div class="page__head">
        <div>
          <p class="eyebrow">Match #{match.id}</p>
          <h2>{campaignName(match.campaign)}</h2>
        </div>
        <div class="scoreline">
          <span class="scoreline__score num">{match.teamAScore} - {match.teamBScore}</span>
          <span class="muted">{winnerLabel(match.winner)} · {fmtDate(match.endedAt)}</span>
        </div>
      </div>

      <div class="stack">
        <Panel>
          <h3>Match totals</h3>
          <StatTable teamA={totalsA} teamB={totalsB} cols={cols} />
        </Panel>

        {maps.map((mp) => {
          const demo = data.demos?.find((d) => d.ordinal === mp.ordinal);
          return (
            <Panel key={mp.ordinal}>
              <h3>
                Map {mp.ordinal + 1} · <a href={`/map/${encodeURIComponent(mp.map)}`}>{mp.map}</a>
                <span class="muted"> · {mp.teamAScore} - {mp.teamBScore}</span>
                {demo && <> · <a href={`/api/matches/${match.id}/demos/${demo.ordinal}`} download>
                  demo {fmtBytes(demo.bytes)}
                </a></>}
              </h3>
              {Object.keys(mp.stats ?? {}).length > 0
                ? <StatTable teamA={mapRows(mp, 'a')} teamB={mapRows(mp, 'b')} cols={cols} />
                : <p class="muted">Per-map stats were not captured for this match.</p>}
            </Panel>
          );
        })}

        {!hasMapStats && maps.length === 0 && (
          <Panel><Empty>No maps recorded.</Empty></Panel>
        )}

        {data.events && data.events.length > 0 && (
          <Panel>
            <EventFeed events={data.events} maps={maps} />
          </Panel>
        )}

        {data.demos && data.demos.length > 0 && (
          <Panel>
            <h3>Demos</h3>
            <DemoPlaybackHint />
            <ul class="demos">
              {data.demos.map((d) => (
                <li class="demos__row" key={d.ordinal}>
                  <span>{d.map}</span>
                  <span class="muted num">{fmtBytes(d.bytes)}</span>
                  <a href={`/api/matches/${match.id}/demos/${d.ordinal}`} download>Download</a>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
