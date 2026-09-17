import { useState } from 'preact/hooks';
import { api, type MatchDetail as MatchDetailData, type MatchPlayerStats, type Team } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, deriveLiveStats, fmtBytes, fmtDate, fmtLatency, orderStatKeysBySide, statGroupStarts, winnerLabel } from '../format';
import { clearLatencyByPlayer } from '../clearLatency';
import { Empty, Panel } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { VersusHeader } from '../components/VersusHeader';
import { StatTable, EventFeed, DemoPlaybackHint, type StatRow } from '../components/StatTable';
import { ReportPlayer } from '../components/ReportPlayer';
import { sideTotals } from '../matchTotals';
import { Viewer } from '../replay/Viewer';

/**
 * One map's round switch and replay viewer.
 *
 * Its own component, not inline in the `maps.map` callback, because the
 * round switch and the timeline fetch both need state and a hook cannot be
 * called from inside a plain array-map callback.
 */
function MapReplay(
  { matchId, ordinal, names }: { matchId: number; ordinal: number; names: Record<string, string> },
) {
  const [half, setHalf] = useState(1);
  const timeline = useFetch(
    (s) => api.replayTimeline(matchId, ordinal, half, s),
    [matchId, ordinal, half],
  );

  return (
    <>
      <div class="replay__rounds">
        <button class={`chip ${half === 1 ? 'is-on' : ''}`} onClick={() => setHalf(1)}>Round 1</button>
        <button class={`chip ${half === 2 ? 'is-on' : ''}`} onClick={() => setHalf(2)}>Round 2</button>
      </div>
      {/* A map played before recording existed has no match_replays row.
          Viewer renders its own "couldn't load" state for that, which is the
          right outcome; there is deliberately no second empty state here. */}
      <Viewer
        spec={{ kind: 'match', matchId, ordinal, half }}
        names={names}
        timeline={timeline.data?.entries}
      />
    </>
  );
}

/** Which team held which side in each half of one map, as one line under
 *  that map's stats, or null when nothing reliable is known.
 *
 *  This is the one fact the per-half round tables carried that the per-map
 *  table does not. The tables themselves went on 2026-09-13: skill stats are
 *  captured per match, so every per-round cell but the five core counters
 *  read n/a, and the page grew four panels of grey for one line of news. */
export function sideNote(rounds: MatchDetailData['rounds'], ordinal: number): string | null {
  const parts = rounds
    .filter((r) => r.ordinal === ordinal && r.reliable)
    .sort((a, b) => a.half - b.half)
    .map((r) => `Half ${r.half}: Team ${r.survTeam.toUpperCase()} survivors`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The map the page opens on: the one named in the URL hash (#map-2 is the
 *  second map) when it exists, else the first. A link to a specific map's
 *  replay is the whole reason the choice lives in the hash. */
export function initialOrdinal(maps: { ordinal: number }[], hash: string): number | null {
  if (maps.length === 0) return null;
  const m = /^#map-(\d+)$/.exec(hash);
  const wanted = m ? Number(m[1]) - 1 : NaN;
  return maps.some((mp) => mp.ordinal === wanted) ? wanted : maps[0].ordinal;
}

/** A map's scoreline for the chip row and the heading, or the words "not
 *  recorded" when the API says the stored score is not a result. Muted either
 *  way; the caller decides the wrapper. An absent flag (older server) reads
 *  as recorded, the same way the other server-build fields are guarded. */
export function mapScoreLabel(mp: { teamAScore: number; teamBScore: number; recorded?: boolean }): string {
  return mp.recorded === false ? 'not recorded' : `${mp.teamAScore} - ${mp.teamBScore}`;
}

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
  // Roster names for the viewer's follow row and timeline rail, keyed by
  // steamid the same way the replay frames' slots and the timeline's actors
  // are.
  const playerNames = Object.fromEntries(players.map((p) => [p.steamid, p.name]));
  // statDefs is a property of the server build, not of the match: a current
  // server always returns it. This guard is for new frontend JS running
  // against an older, not-yet-upgraded server that has no such field; sideTotals
  // treats a missing registry as "nothing has a known side" rather than crashing
  // on it.
  const statDefs = data.statDefs ?? [];

  // rounds is also a property of the server build, not of the match: a current
  // server always returns the field, using an empty array (not an omitted
  // field) to mean "round capture did not exist when this match was played".
  // Computed here, ahead of everything below that reads it, because the versus
  // header eyebrows below need the earliest round and the per-map round
  // sections further down need the full list.
  const rounds = data.rounds ?? [];
  // The versus header eyebrows name who played which side FIRST, so they must
  // come from the earliest round (lowest ordinal, then lowest half), not just
  // any round. An unreliable first round means attribution cannot be trusted,
  // so both eyebrows fall back to VersusHeader's plain "Team A"/"Team B"
  // defaults rather than asserting a side that might be wrong. Live matches
  // have no round data at all (their payload carries no survTeam), so they
  // always take the defaults too.
  const firstRound = [...rounds].sort((a, b) => a.ordinal - b.ordinal || a.half - b.half)[0];
  const eyebrowA = firstRound?.reliable
    ? `Team A · ${firstRound.survTeam === 'a' ? 'survivors' : 'infected'} first`
    : undefined;
  const eyebrowB = firstRound?.reliable
    ? `Team B · ${firstRound.survTeam === 'b' ? 'survivors' : 'infected'} first`
    : undefined;

  // The two teams' stats, split into what each did as survivors versus as
  // infected. This is the whole point of the headline cards below: a raw team
  // total mixes survivor performance with infected performance, which are the
  // two separate things that decide a versus match.
  const sideA = sideTotals(players, 'a', statDefs);
  const sideB = sideTotals(players, 'b', statDefs);
  const teamPlayers = (team: Team) => players.filter((p) => p.team === team);
  // ck (commons) and ff (friendly fire) are fixed match_players columns, not
  // registry keys, so sideTotals never sees them; sum them directly instead.
  // Neither needs side reasoning: commons only accrue as survivor and, like
  // siDamage below, the column is always captured, so a team total of 0 is a
  // real recorded fact rather than something to omit.
  const sumFixed = (team: Team, pick: (p: MatchPlayerStats) => number) =>
    teamPlayers(team).reduce((acc, p) => acc + pick(p), 0);

  const headlineCards: { label: string; sub?: string; a: number | undefined; b: number | undefined }[] = [
    {
      label: 'SI damage', sub: 'as survivors',
      a: sumFixed('a', (p) => p.siDamage), b: sumFixed('b', (p) => p.siDamage),
    },
    {
      label: 'Damage as SI', sub: 'as infected',
      a: sideA.infected.damage_as_si, b: sideB.infected.damage_as_si,
    },
    { label: 'Commons', a: sumFixed('a', (p) => p.commonKills), b: sumFixed('b', (p) => p.commonKills) },
    { label: 'Friendly fire', a: sumFixed('a', (p) => p.ffDealt), b: sumFixed('b', (p) => p.ffDealt) },
    { label: 'Tank damage', a: sideA.survivor.tank_damage, b: sideB.survivor.tank_damage },
    // Omitted rather than shown as a fabricated 0 when neither team recorded it.
  ].filter((c) => c.a !== undefined || c.b !== undefined);

  // The dump gives per-player totals as fixed columns plus a bag of skill
  // stats; fold them into one object so the match page and the live page share
  // exactly one table component and one column order.
  //
  // A player nothing was captured for (rostered after the dump's stats were
  // seeded, match 18) arrives with an empty bag and every fixed column at 0.
  // Those zeros are not a performance, and the table must not compare them
  // as one. From this side of the API the two facts the plan names (an empty
  // stats_json and no match_player_stats rows) are exactly "no skill stats
  // and nothing in the fixed columns", which is what is tested here.
  const wasCaptured = (p: typeof players[number]): boolean =>
    Object.keys(p.stats ?? {}).length > 0
    || [p.siDamage, p.siKills, p.commonKills, p.ffDealt, p.revives].some((v) => v !== 0);
  const rowFor = (p: typeof players[number]): StatRow => ({
    steamid: p.steamid,
    name: p.name,
    captured: wasCaptured(p),
    stats: deriveLiveStats({
      ck: p.commonKills, sidmg: p.siDamage, sikill: p.siKills,
      ff: p.ffDealt, rev: p.revives,
      ...(p.stats ?? {}),
    }),
  });
  const totalsA = players.filter((p) => p.team === 'a').map(rowFor);
  const totalsB = players.filter((p) => p.team === 'b').map(rowFor);
  // Ordered by side rather than by the live view's curated list. That list only
  // knows the columns the live card shows, and its fallback appended everything
  // else into one alphabetical tail shared by both sides, which interleaved
  // survivor and infected columns and separated stats from their own family.
  const cols = orderStatKeysBySide(
    Array.from(new Set([...totalsA, ...totalsB].flatMap((r) => Object.keys(r.stats)))),
    statDefs,
  );

  // Per map, "captured" is simply whether the end-of-map snapshot has a row
  // for this player; a late joiner is missing from the maps before they were
  // rostered.
  const mapRows = (mp: typeof maps[number], team: 'a' | 'b'): StatRow[] =>
    players.filter((p) => p.team === team).map((p) => ({
      steamid: p.steamid,
      name: p.name,
      captured: mp.stats?.[p.steamid] !== undefined,
      stats: deriveLiveStats(mp.stats?.[p.steamid] ?? {}),
    }));
  const hasMapStats = maps.some((mp) => Object.keys(mp.stats ?? {}).length > 0);

  // Derived from the event feed rather than the dump: latency is a property of
  // a pinned/cleared pair, not a counter any player accumulates.
  // Names come from the match roster, not from the event, because the feed
  // carries whatever name was resolved when the event was recorded while the
  // roster is what the rest of the page calls this player.
  const clearRows = clearLatencyByPlayer(data.events ?? []).map((r) => ({
    ...r, name: players.find((p) => p.steamid === r.steamid)?.name ?? r.name,
  }));

  // One viewer, one map at a time. Four canvases each decoding a replay and
  // running an animation loop was the heaviest thing on the page, and nobody
  // watches four maps at once. The choice is in the URL hash so a link can
  // open on map 3.
  const [ordinal, setOrdinal] = useState<number | null>(
    () => initialOrdinal(maps, typeof location === 'undefined' ? '' : location.hash),
  );
  const selectMap = (o: number) => {
    setOrdinal(o);
    if (typeof history !== 'undefined') history.replaceState(null, '', `#map-${o + 1}`);
  };
  const current = maps.find((mp) => mp.ordinal === ordinal) ?? maps[0];

  return (
    <div class="page page--match">
      <PageHeader
        eyebrow={`Match #${match.id} · ${winnerLabel(match.winner)} · ${fmtDate(match.endedAt)}`}
        title={campaignName(match.campaign)}
      >
        {headlineCards.length > 0 && (
          <Figures>
            {headlineCards.map((c) => (
              <Figure key={c.label} label={c.label} value={`${c.a ?? 'n/a'} - ${c.b ?? 'n/a'}`} sub={c.sub} />
            ))}
          </Figures>
        )}
      </PageHeader>

      <VersusHeader
        teamA={teamPlayers('a').map((p) => p.name)}
        teamB={teamPlayers('b').map((p) => p.name)}
        scoreA={match.teamAScore}
        scoreB={match.teamBScore}
        eyebrowA={eyebrowA}
        eyebrowB={eyebrowB}
      />

      <div class="stack">
        <Panel>
          <h3>Match totals</h3>
          <StatTable teamA={totalsA} teamB={totalsB} cols={cols} statDefs={statDefs} groupStarts={statGroupStarts} showTotals />
        </Panel>

        {clearRows.length > 0 && (
          <Panel>
            <h3>Clear latency</h3>
            {/* Not a column in the table above: that one is registry-driven and
                sums, while this is an average derived from the pinned/cleared
                event pair. No counter can express how fast someone was freed. */}
            <p class="muted">How long a pinned teammate waited to be freed, fastest first.</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Player</th><th class="num">Average</th><th class="num">Clears</th></tr>
                </thead>
                <tbody>
                  {clearRows.map((r) => (
                    <tr key={r.steamid}>
                      <td>{r.name}</td>
                      <td class="num">{fmtLatency(r.avgMs)}</td>
                      {/* The count is shown, not hidden, because an average
                          over one or two clears is noise and the reader has to
                          be able to see that for themselves. */}
                      <td class="num muted">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {current && (() => {
          const mp = current;
          const demo = data.demos?.find((d) => d.ordinal === mp.ordinal);
          const note = sideNote(rounds, mp.ordinal);
          return (
            <Panel>
              {maps.length > 1 && (
                <div class="replay__rounds match__maps" role="tablist" aria-label="Map">
                  {maps.map((m) => (
                    <button
                      key={m.ordinal}
                      class={`chip ${m.ordinal === mp.ordinal ? 'is-on' : ''}`}
                      role="tab"
                      aria-selected={m.ordinal === mp.ordinal}
                      onClick={() => selectMap(m.ordinal)}
                    >
                      Map {m.ordinal + 1}
                      <span class="muted num"> {mapScoreLabel(m)}</span>
                    </button>
                  ))}
                </div>
              )}
              <h3>
                Map {mp.ordinal + 1} · <a href={`/map/${encodeURIComponent(mp.map)}`}>{mp.map}</a>
                <span class="muted"> · {mapScoreLabel(mp)}</span>
                {demo && <> · <a href={`/api/matches/${match.id}/demos/${demo.ordinal}`} download>
                  demo {fmtBytes(demo.bytes)}
                </a></>}
              </h3>
              {/* Keyed by map so the round switch inside resets to round 1
                  when the map changes, instead of carrying round 2 across. */}
              <MapReplay key={mp.ordinal} matchId={match.id} ordinal={mp.ordinal} names={playerNames} />
              {Object.keys(mp.stats ?? {}).length > 0
                ? (
                  <StatTable
                    teamA={mapRows(mp, 'a')} teamB={mapRows(mp, 'b')}
                    cols={cols} statDefs={statDefs} groupStarts={statGroupStarts}
                  />
                  )
                : <p class="muted">Per-map stats were not captured for this match.</p>}
              {note && <p class="muted match__sides">{note}</p>}
            </Panel>
          );
        })()}

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
                  <span class="demos__map">{d.map}</span>
                  <span class="demos__size muted num">{fmtBytes(d.bytes)}</span>
                  <a class="demos__link" href={`/api/matches/${match.id}/demos/${d.ordinal}`} download>Download</a>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {me && (
          <Panel>
            <ReportPlayer matchId={match.id} />
          </Panel>
        )}
      </div>
    </div>
  );
}
