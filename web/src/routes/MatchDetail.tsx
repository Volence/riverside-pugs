import { useRef, useState } from 'preact/hooks';
import { api, type MatchDetail as MatchDetailData, type MatchOngoing, type MatchPlayerStats, type ReportMoment, type Team } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, deriveLiveStats, fmtBytes, fmtDate, fmtLatency, mapName, orderStatKeysBySide, statGroupStarts, winnerLabel } from '../format';
import { clearLatencyByPlayer } from '../clearLatency';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { VersusHeader } from '../components/VersusHeader';
import { StatTable, EventFeed, DemoPlaybackHint, type StatRow } from '../components/StatTable';
import { ReportPlayer } from '../components/ReportPlayer';
import { EndorsePanel } from '../components/EndorsePanel';
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
  { matchId, ordinal, names, initialHalf, seekMs, onMoment }: {
    matchId: number; ordinal: number; names: Record<string, string>;
    /** The round a deep link asked for, already validated by the caller
     *  against this match's own rounds. Undefined for an ordinary visit. */
    initialHalf?: number;
    /** Only meaningful for `initialHalf`'s own round: see the seek prop below. */
    seekMs?: number;
    /** Given for a signed-in viewer: attach what is on screen to a report. */
    onMoment?: (m: ReportMoment) => void;
  },
) {
  const [half, setHalf] = useState(initialHalf ?? 1);
  const momentRef = useRef(0);
  const timeline = useFetch(
    (s) => api.replayTimeline(matchId, ordinal, half, s),
    [matchId, ordinal, half],
  );

  return (
    <>
      <div class="replay__rounds">
        <button class={`chip ${half === 1 ? 'is-on' : ''}`} onClick={() => setHalf(1)}>Round 1</button>
        <button class={`chip ${half === 2 ? 'is-on' : ''}`} onClick={() => setHalf(2)}>Round 2</button>
        {onMoment && (
          <button class="chip" type="button" title="Pause on what you want the moderators to see, then press this"
            onClick={() => onMoment({ ordinal, half, tMs: Math.round(momentRef.current) })}>
            Report this moment
          </button>
        )}
      </div>
      {/* A map played before recording existed has no match_replays row.
          Viewer renders its own "couldn't load" state for that, which is the
          right outcome; there is deliberately no second empty state here. */}
      <Viewer
        spec={{ kind: 'match', matchId, ordinal, half }}
        names={names}
        timeline={timeline.data?.entries}
        // The clip's timestamp belongs to initialHalf's round alone. Once the
        // round switch moves away from it this becomes undefined, so a stray
        // seek effect firing on the OTHER round's own first frames (a real
        // possibility: Viewer never remounts across a half switch, only its
        // spec changes) never lands the wrong moment.
        seekMs={initialHalf != null && half === initialHalf ? seekMs : undefined}
        momentRef={momentRef}
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

/** A clip's deep link into a specific moment: `?ordinal=&half=&t=`.
 *
 * Every field is independently untrustworthy (typed by hand, or stale
 * against a match that has since been reprocessed), so each is checked
 * against what this match actually has before being honoured, and anything
 * that fails falls back to `null`/`undefined` rather than ever selecting a
 * round the match does not have or seeking to a non-number.
 *
 * `URLSearchParams.get` returns `null` for a missing key, and `Number(null)`
 * is `0`, not `NaN` - a plain `Number(params.get(...))` would read an
 * ordinary visit with no query string at all as "ordinal 0, half 0", and
 * ordinal 0 is a real map on nearly every match. Missing keys are read as
 * `NaN` explicitly to keep that from ever happening.
 */
export function deepLinkFromQuery(
  search: string,
  maps: { ordinal: number }[],
  rounds: { ordinal: number; half: number }[],
): { ordinal: number | null; half: number | null; seekMs: number | undefined } {
  const params = new URLSearchParams(search);
  const num = (key: string): number => {
    const raw = params.get(key);
    // The empty string is as absent as a missing key, and it has to be said
    // out loud: Number('') is 0, so `?ordinal=` would otherwise read as a
    // perfectly valid ordinal 0 and pick a round nobody asked for.
    return raw === null || raw === '' ? NaN : Number(raw);
  };

  const qOrdinal = num('ordinal');
  const ordinal = Number.isInteger(qOrdinal) && maps.some((mp) => mp.ordinal === qOrdinal) ? qOrdinal : null;

  const qHalf = num('half');
  // A round is asked for only in terms of a map it belongs to: half 2 of a
  // map that never had one is never a target, even if half alone looks valid.
  const half = ordinal !== null && (qHalf === 1 || qHalf === 2)
    && rounds.some((r) => r.ordinal === ordinal && r.half === qHalf)
    ? qHalf : null;

  const qT = num('t');
  const seekMs = Number.isFinite(qT) ? qT : undefined;

  return { ordinal, half, seekMs };
}

/** A map's scoreline for the chip row and the heading, or the words "not
 *  recorded" when the API says the stored score is not a result. Muted either
 *  way; the caller decides the wrapper. An absent flag (older server) reads
 *  as recorded, the same way the other server-build fields are guarded. */
export function mapScoreLabel(mp: { teamAScore: number; teamBScore: number; recorded?: boolean }): string {
  return mp.recorded === false ? 'not recorded' : `${mp.teamAScore} - ${mp.teamBScore}`;
}

/**
 * What the ratings said before the match, against what happened.
 *
 * Only rendered when the server sent a forecast, which it does for admins
 * only. Deliberately not shown to players: a number saying a team was meant
 * to lose reads as an excuse, and it exists here to judge the balancer rather
 * than to explain a result.
 */
function ForecastPanel(
  { f, winner }:
  { f: NonNullable<MatchDetailData['forecast']>; winner: 'a' | 'b' | 'draw' | null },
) {
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const favoured = f.srGap === 0 ? null : f.srGap > 0 ? 'a' : 'b';
  // The odds follow mu, and SR subtracts twice the uncertainty, so the two can
  // point different ways. A team leading on SR with no skill lead is leading
  // because it is better understood, and saying that outright is the whole
  // point of showing both.
  const skillGap = Math.round(Math.abs(f.muGap) * 100);
  const stronger = Math.abs(f.muGap) < 0.05 ? null : f.muGap > 0 ? 'A' : 'B';
  // Was the paper favourite actually beaten? The interesting rows in a
  // balance audit are the upsets, so the page names one rather than leaving
  // the reader to compare two percentages against a scoreline.
  const upset = favoured !== null && winner !== null && winner !== 'draw' && winner !== favoured;
  const full = f.ratedA === 4 && f.ratedB === 4;
  return (
    <Panel>
      <h3>Forecast <span class="muted">(admin only)</span></h3>
      <table class="forecast__kv">
        <tbody>
          <tr>
            <th>Team A</th>
            <td>
              {f.srA} SR, {pct(f.winProbA)} to win
              {' '}<span class="muted">skill {f.muA.toFixed(2)} ± {f.sigmaA.toFixed(2)}</span>
            </td>
          </tr>
          <tr>
            <th>Team B</th>
            <td>
              {f.srB} SR, {pct(f.winProbB)} to win
              {' '}<span class="muted">skill {f.muB.toFixed(2)} ± {f.sigmaB.toFixed(2)}</span>
            </td>
          </tr>
          <tr>
            <th>Gap on SR</th>
            <td>{f.srGap === 0 ? 'even' : `${Math.abs(f.srGap)} SR to Team ${favoured === 'a' ? 'A' : 'B'}`}</td>
          </tr>
          <tr>
            <th>Gap on skill</th>
            <td>
              {stronger === null ? 'even' : `${skillGap} to Team ${stronger}`}
              {upset && <span class="muted"> · the underdog won</span>}
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        Mean SR of the rated players and the OpenSkill win probability, both from the ratings
        as they stood <strong>before</strong> this match rather than now.
        {' '}SR subtracts <strong>twice</strong> each player's rating uncertainty, so a team can
        lead on SR without being the stronger side: that is a team the system understands
        better, not a better team. The odds follow skill, and the balancer optimises the
        odds, so an even forecast next to a lopsided SR gap is the balancer working.
        {!full && ` Built from ${f.ratedA} v ${f.ratedB} players: a sub who played under half the maps is never rated, so they are not counted here either.`}
      </p>
    </Panel>
  );
}

/** Mirrors the wording on the Discord card (src/discord/presenter.ts
 *  STATE_LINE) so a player reads the same sentence on the site as in Discord. */
const ONGOING_LINE: Record<MatchOngoing['state'], string> = {
  waiting: 'Waiting for a server to free up.',
  configuring: 'Setting up the server.',
  live: 'The match is live right now.',
};

/**
 * What /match/:id shows while the match named in the URL is still being
 * played rather than finished.
 *
 * Every admin-feed post about a live match links to this same URL, and the
 * link has to keep working once the match ends: this is the page it shows in
 * between, not a dead end. There is no roster or score here on purpose: the
 * server only ever sends id, campaign and state for a match still in
 * progress, never the server address, the token or a password.
 */
function OngoingMatch({ data }: { data: MatchOngoing }) {
  return (
    <div class="page page--match">
      <Panel>
        <PageHeader eyebrow="In progress" title={`Match #${data.id}: ${campaignName(data.campaign)}`} />
        <Empty>
          Match #{data.id} is still being played. {ONGOING_LINE[data.state]}
          {' '}Watch it on the <a href="/live">Live page</a>, or come back here once it has finished.
        </Empty>
      </Panel>
    </div>
  );
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
  if (!data) return <PageSkeleton variant="match" panels={3} />;

  if (data.ongoing) return <OngoingMatch data={data} />;

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
    discordName: p.discordName,
    title: p.title,
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
      discordName: p.discordName,
      title: p.title,
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

  // An aborted match reached no result, so there is no winner to name and the
  // scoreline below is how far it got rather than a final score. Saying so
  // once, at the top, is what keeps the rest of the page readable as-is: every
  // panel under it is an honest record of what was captured before the match
  // ended, and none of it means what a completed match's numbers mean.
  //
  // A match VOIDED by an admin is also stored as 'aborted', but it did finish
  // and does have a real result, so it gets its own wording and keeps the
  // winner in the eyebrow.
  const voided = Boolean(match.voidedAt);
  const aborted = match.state === 'aborted' && !voided;
  const outcome = voided ? `${winnerLabel(match.winner!)} · voided`
    : aborted ? 'Aborted'
      : winnerLabel(match.winner!);

  // An admin integrity clip links here with `?ordinal=&half=&t=`, computed
  // once: it names the round the link was ABOUT, not whatever round is on
  // screen right now, so it must not be recomputed every render as `ordinal`
  // state below moves around under the user's own navigation.
  const deepLink = useState(() => deepLinkFromQuery(
    typeof location === 'undefined' ? '' : location.search, maps, rounds,
  ))[0];

  // One viewer, one map at a time. Four canvases each decoding a replay and
  // running an animation loop was the heaviest thing on the page, and nobody
  // watches four maps at once. The choice is in the URL hash so a link can
  // open on map 3; a validated deep-link ordinal wins over that when present.
  const [ordinal, setOrdinal] = useState<number | null>(
    () => deepLink.ordinal ?? initialOrdinal(maps, typeof location === 'undefined' ? '' : location.hash),
  );
  // A moment picked in the viewer, waiting in the report form below.
  const [moment, setMoment] = useState<ReportMoment | null>(null);
  const selectMap = (o: number) => {
    setOrdinal(o);
    if (typeof history !== 'undefined') history.replaceState(null, '', `#map-${o + 1}`);
  };
  const current = maps.find((mp) => mp.ordinal === ordinal) ?? maps[0];
  // The deep link only still applies while its own map is the one on screen;
  // navigating away and never seeing it re-applied (even back on the same
  // map, since MapReplay remounts on ordinal change anyway) is what keeps a
  // manual click from ever being fought by a link opened minutes earlier.
  const linkedHere = deepLink.ordinal !== null && ordinal === deepLink.ordinal;

  return (
    <div class="page page--match">
      <PageHeader
        eyebrow={`Match #${match.id} · ${outcome} · ${fmtDate(match.endedAt)}`}
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

      {(aborted || voided) && (
        <Panel>
          <p class="muted">
            {aborted
              ? 'This match was cancelled before it finished, so nothing here counts: no winner was '
                + 'recorded and nobody\u2019s rating moved. The scoreline is how far the two teams got, '
                + 'and the maps, stats and replays below are whatever was captured up to the moment it ended.'
              : `This match was voided by an admin${match.voidReason ? `: ${match.voidReason}` : ''}. `
                + 'It no longer counts anywhere, and the season\u2019s ratings were rebuilt without it.'}
          </p>
        </Panel>
      )}

      <VersusHeader
        teamA={teamPlayers('a').map((p) => p.name)}
        teamB={teamPlayers('b').map((p) => p.name)}
        scoreA={match.teamAScore}
        scoreB={match.teamBScore}
        eyebrowA={eyebrowA}
        eyebrowB={eyebrowB}
      />

      {/* Completed matches only, and only for a signed-in viewer: the panel
          asks the server whether THIS viewer may endorse here, and renders
          nothing when they may not. */}
      {match.state === 'completed' && me && <EndorsePanel matchId={match.id} />}

      <div class="stack">
        {data.forecast && <ForecastPanel f={data.forecast} winner={match.winner} />}

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
                Map {mp.ordinal + 1} · <a href={`/map/${encodeURIComponent(mp.map)}`}>{mapName(mp.map)}</a>
                <span class="muted"> · {mapScoreLabel(mp)}</span>
                {demo && <> · <a href={`/api/matches/${match.id}/demos/${demo.ordinal}`} download>
                  demo {fmtBytes(demo.bytes)}
                </a></>}
              </h3>
              {/* Keyed by map so the round switch inside resets to round 1
                  when the map changes, instead of carrying round 2 across. */}
              <MapReplay
                key={mp.ordinal}
                matchId={match.id}
                ordinal={mp.ordinal}
                names={playerNames}
                initialHalf={linkedHere ? deepLink.half ?? undefined : undefined}
                seekMs={linkedHere ? deepLink.seekMs : undefined}
                onMoment={me ? setMoment : undefined}
              />
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
                  <span class="demos__map">{mapName(d.map)}</span>
                  <span class="demos__size muted num">{fmtBytes(d.bytes)}</span>
                  <a class="demos__link" href={`/api/matches/${match.id}/demos/${d.ordinal}`} download>Download</a>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {me && (
          <Panel>
            <ReportPlayer matchId={match.id} moment={moment} onClearMoment={() => setMoment(null)} />
          </Panel>
        )}
      </div>
    </div>
  );
}
