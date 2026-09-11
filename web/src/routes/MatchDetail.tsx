import { api, type MatchDetail as MatchDetailData, type MatchPlayerStats, type Team } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, deriveLiveStats, fmtBytes, fmtDate, orderLiveStatKeys, winnerLabel } from '../format';
import { Empty, Panel, Tile, Tiles } from '../components/bits';
import { StatTable, EventFeed, DemoPlaybackHint, type StatRow } from '../components/StatTable';
import { sideTotals } from '../matchTotals';

/** Why the round section has nothing to show, or null when it does.
 *
 *  An empty array means round capture did not exist when this match was
 *  played. That is not the same as a match with no rounds, and it must not
 *  render as an empty table. */
export function roundsMessage(rounds: MatchDetailData['rounds']): string | null {
  if (rounds.length === 0) return 'Round data was not captured for this match.';
  return null;
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
  // statDefs is a property of the server build, not of the match: a current
  // server always returns it. This guard is for new frontend JS running
  // against an older, not-yet-upgraded server that has no such field; sideTotals
  // treats a missing registry as "nothing has a known side" rather than crashing
  // on it.
  const statDefs = data.statDefs ?? [];

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

  // rounds is also a property of the server build, not of the match: a current
  // server always returns the field, using an empty array (not an omitted
  // field) to mean "round capture did not exist when this match was played".
  // This guard, like statDefs above, is for new frontend JS running against an
  // older server that omits the field entirely; roundsMessage treats the
  // empty-array case as "never captured" regardless of which path produced it.
  const rounds = data.rounds ?? [];
  const roundsMsg = roundsMessage(rounds);
  const roundOrdinals = Array.from(new Set(rounds.map((r) => r.ordinal))).sort((a, b) => a - b);
  const roundsForMap = (ordinal: number) =>
    rounds.filter((r) => r.ordinal === ordinal).sort((a, b) => a.half - b.half);
  const roundRows = (round: MatchDetailData['rounds'][number], team: 'a' | 'b'): StatRow[] =>
    players.filter((p) => p.team === team).map((p) => ({
      steamid: p.steamid,
      name: p.name,
      stats: deriveLiveStats(round.byPlayer?.[p.steamid] ?? {}),
    }));

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

      {headlineCards.length > 0 && (
        <Tiles>
          {headlineCards.map((c) => (
            <Tile
              key={c.label}
              label={c.label}
              value={`${c.a ?? 'n/a'} - ${c.b ?? 'n/a'}`}
              sub={c.sub}
            />
          ))}
        </Tiles>
      )}

      <div class="stack">
        <Panel>
          <h3>Match totals</h3>
          <StatTable teamA={totalsA} teamB={totalsB} cols={cols} statDefs={statDefs} showTotals />
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
                ? (
                  <StatTable
                    teamA={mapRows(mp, 'a')} teamB={mapRows(mp, 'b')}
                    cols={cols} statDefs={statDefs}
                  />
                  )
                : <p class="muted">Per-map stats were not captured for this match.</p>}
            </Panel>
          );
        })}

        {!hasMapStats && maps.length === 0 && (
          <Panel><Empty>No maps recorded.</Empty></Panel>
        )}

        {roundsMsg ? (
          <Panel>
            <h3>Rounds</h3>
            <Empty>{roundsMsg}</Empty>
          </Panel>
        ) : (
          roundOrdinals.map((ordinal) => {
            const mp = maps.find((m) => m.ordinal === ordinal);
            return (
              <Panel key={`rounds-${ordinal}`}>
                <h3>Map {ordinal + 1}{mp && <> · {mp.map}</>} rounds</h3>
                <div class="stack">
                  {roundsForMap(ordinal).map((round) => {
                    const infTeam: Team = round.survTeam === 'a' ? 'b' : 'a';
                    return (
                      <div key={round.half}>
                        <h4>
                          {round.reliable
                            ? <>Half {round.half} · Team {round.survTeam.toUpperCase()} survivors,
                              {' '}Team {infTeam.toUpperCase()} infected</>
                            : <>Half {round.half}, attribution unreliable</>}
                          {' · '}
                          {round.endedAt !== null
                            ? (
                              <span class="num">
                                {/* The score is always the survivor team's score. When the
                                    round is reliable, the heading above already names that
                                    team, so the bare number reads unambiguously. When it is
                                    not, the number needs its own label: which team survived
                                    is exactly the fact just declared untrustworthy, so a bare
                                    score would default to reading as Team A's. */}
                                {round.reliable ? '' : 'survivor score '}{round.score}
                              </span>
                              )
                            : <span class="muted">n/a</span>}
                        </h4>
                        {round.reliable ? (
                          <StatTable
                            teamA={roundRows(round, 'a')} teamB={roundRows(round, 'b')}
                            cols={cols} statDefs={statDefs}
                          />
                        ) : (
                          <p class="muted">Attribution for this round is unreliable and is not shown.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            );
          })
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
