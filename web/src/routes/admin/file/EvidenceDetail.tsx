import { useState } from 'preact/hooks';
import { adminApi, type IntegrityClip, type PlayerFileData } from '../../../api';
import { Empty, Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';

/** Clips sharing one player-round. Review state is keyed by the round, so
 *  the review control belongs to the round too: a control per clip marked up
 *  to five of them at once and typed into all their note boxes. */
function groupByRound(clips: IntegrityClip[]): { key: string; clips: IntegrityClip[] }[] {
  const out: { key: string; clips: IntegrityClip[] }[] = [];
  const at = new Map<string, { key: string; clips: IntegrityClip[] }>();
  for (const c of clips) {
    const key = `${c.matchId}/${c.ordinal}/${c.half}/${c.slot}`;
    let g = at.get(key);
    if (!g) { g = { key, clips: [] }; at.set(key, g); out.push(g); }
    g.clips.push(c);
  }
  return out;
}

const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));
const num3 = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(3));
const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

/** A clip's kind in words. Unknown kinds show as themselves. */
const CLIP_KIND: Record<string, string> = { ghost_track: 'ghost', hidden_track: 'hidden infected' };
const clipKind = (k: string): string => CLIP_KIND[k] ?? k;

/**
 * The numbers under the timeline rows, for the reader who wants them.
 *
 * The timeline says what happened; this says what it was measured from. The
 * analyzer wording is the board's own, kept as it was written for version 4,
 * including the rounds gate: a player with too few measured rounds is not
 * ranked at all, and says so rather than reading as a zero.
 */
export function EvidenceDetail(
  { d, busy, run, canReview }: { d: PlayerFileData; busy: boolean; run: Run; canReview: boolean },
) {
  const e = d.sections.evidence;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const a = e.analyzer;
  // Same key as groupByRound: matchId/ordinal/half/slot. A re-analysis
  // rewrites every clip, so review state lives on the round, not a clip.
  const roundsByKey = new Map(e.rounds.map((r) => [`${r.matchId}/${r.ordinal}/${r.half}/${r.slot}`, r]));

  return (
    <Panel class="file-section">
      <h3 id="evidence">The evidence behind these rows</h3>
      <p class="muted">
        Numbers and raw rows. Everything here is context to weigh against the replay and against
        each other; none of it decides anything on its own.
      </p>

      <h4>Replay analyzer</h4>
      {a === null ? <p class="muted">No analysed rounds for this player.</p> : (
        <>
          <p class="muted">
            {a.ranked ? `Rank ${a.rank} of ${a.of} ranked players` : 'Too few measured rounds to rank'}
            {' · '}{a.rounds} rounds, {a.eligibleRounds} with something to measure, {a.clips} clip{a.clips === 1 ? '' : 's'}
            {' · '}tracking {num3(a.trackShare)} ({pct(a.pFid)})
            {' · '}occupancy {num(a.occZ)} ({pct(a.pOcc)})
            {' · '}team gap {num(a.teamGap)} ({pct(a.pGap)})
          </p>
          <p class="muted">
            Hidden infected ({a.losRounds} rounds with line of sight, not in the rank):
            {' '}tracking {num3(a.hiddenShare)} ({pct(a.pHidden)})
            {' · '}pre-aim {num(a.hiddenOccZ)} ({pct(a.pHiddenOcc)})
            {' · '}on target at reveal {pct(a.revealShare)} of {a.reveals} ({pct(a.pReveal)})
            {' · '}hunters: tracking {num3(a.byClass.hunter.hiddenShare)}, pre-aim {num(a.byClass.hunter.hiddenOccZ)}, reveal {pct(a.byClass.hunter.revealShare)}
            {' · '}smokers: tracking {num3(a.byClass.smoker.hiddenShare)}, pre-aim {num(a.byClass.smoker.hiddenOccZ)}, reveal {pct(a.byClass.smoker.revealShare)}
            {' · '}boomers: tracking {num3(a.byClass.boomer.hiddenShare)}, pre-aim {num(a.byClass.boomer.hiddenOccZ)}, reveal {pct(a.byClass.boomer.revealShare)}
          </p>
        </>
      )}
      <details class="colkey">
        <summary>What these columns mean</summary>
        <dl class="colkey__list">
          <dt>Tracking</dt>
          <dd>
            Did the crosshair move with an invisible infected. Each two second window in which they
            stayed aimed near a ghost that was itself moving scores from 1, exactly the motion needed
            to follow it, down to 0. Sitting still aimed at a known spawn scores zero however good
            the spot was. It is a rate over the windows that could be scored, so it does not grow
            with playtime, and it reads n/a with too few windows to make a ratio of.
          </dd>
          <dt>Occupancy</dt>
          <dd>
            How much more often they were aimed at a ghost than this map's own looking habits
            predict, in standard deviations, averaged over their rounds. Knowing where infected
            spawn is already in the baseline, so only the excess counts. One round at 2 is nothing.
            An average that stays there is something.
          </dd>
          <dt>Team gap</dt>
          <dd>
            Their occupancy minus their own teammates' average in the same rounds, which cancels out
            a round where everyone was staring at the same doorway.
          </dd>
          <dt>Hidden tracking, pre-aim and reveal</dt>
          <dd>
            The same questions as tracking and occupancy, asked about spawned infected at the
            moments nobody on the survivor team could see them, from the line of sight the server
            records ten times a second. If a teammate could see it, the moment does not count, because
            a callout explains a crosshair honestly. "On target at reveal" is how often the crosshair
            was already on an infected the instant it came into view. These need eight rounds with
            line of sight, and reveal needs thirty reveals, before they read anything. They are
            shown, not ranked, until a calibration session has set what normal looks like. The
            percentiles in brackets compare only against ranked players, so a player who is not
            ranked (too few measured rounds) shows the raw numbers with no bracket beside them.
          </dd>
          <dt>Rank and n/a</dt>
          <dd>
            Rank is a place by the composite of those three percentiles, a sort key and not a claim,
            and only within the players with enough measured rounds to rank. Occupancy and team gap
            need a baseline for the map, so a map with too little history reads n/a rather than 0.
          </dd>
        </dl>
      </details>
      {e.clips.length === 0 && <Empty>No flagged moments from replay analysis for this player.</Empty>}
      <ul class="admin-list">
        {groupByRound(e.clips).map((g) => {
          const first = g.clips[0];
          const n = g.clips.length;
          // Review state is keyed by the round (matchId/ordinal/half/slot), the
          // same four fields every clip in the group carries, so a round's
          // triage is a lookup rather than something a clip carries itself.
          const round = roundsByKey.get(g.key);
          const reviewed = round !== undefined && round.reviewState !== 'new';
          return (
            <li key={g.key} class={reviewed ? 'muted' : ''}>
              <ul class="integrity-clips">
                {g.clips.map((c) => (
                  <li key={c.id}>
                    <a href={`/match/${c.matchId}?ordinal=${c.ordinal}&half=${c.half}&t=${c.startMs}`}>
                      Match #{c.matchId}
                    </a>
                    <span class="muted"> · {clipKind(c.kind)} · fidelity {c.score.toFixed(2)} · {((c.endMs - c.startMs) / 1000).toFixed(1)}s</span>
                  </li>
                ))}
              </ul>
              {reviewed && round && (
                <p class="muted">
                  {round.reviewState}{round.reviewNote ? `: ${round.reviewNote}` : ''}
                </p>
              )}
              {canReview && (
                <div class="admin-form">
                  <input value={notes[g.key] ?? ''} placeholder="Review note" aria-label="Review note for this round"
                    onInput={(e2) => setNotes({ ...notes, [g.key]: (e2.target as HTMLInputElement).value })} />
                  {/* Labelled with the count because the state is per ROUND:
                      one click settles every clip listed above it. */}
                  <button class="btn" type="button" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'reviewed', notes[g.key] ?? ''))}>
                    Mark this round reviewed ({n} {n === 1 ? 'clip' : 'clips'})
                  </button>
                  <button class="chip" type="button" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'dismissed', notes[g.key] ?? ''))}>
                    Dismiss this round
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <h4>Live anti-cheat</h4>
      {e.flags.length === 0 ? <p class="muted">Nothing flagged by the live anti-cheat.</p> : (
        <>
          <p class="muted">
            Raised by Little Anti-Cheat during play, not by replay analysis, so there is no clip to
            watch. Its own documentation says few and rare suspicions are usually false positives;
            a pattern is what matters.
          </p>
          <ul class="admin-list">
            {e.flags.map((f) => (
              <li key={f.id}>
                {fmtTime(f.at)}: <code>{f.kind}</code>
                {f.severity === 'banned' ? <strong class="admin-warn"> · banned by LilAC</strong> : <span class="muted"> · suspected</span>}
                {f.matchId ? <> · <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Input timing</h4>
      <p class="muted">
        Button timing that does not look like a hand, repeated across several separate bursts in
        one match. These are low-severity evidence to weigh against the replay, not a verdict:
        watch the round before acting on one.
      </p>
      {e.inputCaps.length > 0 && (
        <p class="admin-warn">
          Capture was cut short by the game server's per-round budget {e.inputCaps.length}
          {' '}time{e.inputCaps.length === 1 ? '' : 's'}, so bursts after that point in the round were
          never sent. Most recent:{' '}
          {e.inputCaps.slice(0, 3).map((c, i) => (
            <span key={`${c.at}-${c.kind}`}>
              {i > 0 ? ', ' : ''}{c.kind}{c.matchId ? <> in <a href={`/match/${c.matchId}`}>#{c.matchId}</a></> : null} ({fmtTime(c.at)})
            </span>
          ))}. No flag below does not mean a clean round there.
        </p>
      )}
      {e.inputFlags.length === 0 ? <p class="muted">Nothing flagged by input timing.</p> : (
        <ul class="admin-list">
          {e.inputFlags.map((f) => (
            <li key={f.id}>
              {fmtTime(f.at)}: <code>{f.signature}</code> on {f.hits} {f.kind} burst{f.hits === 1 ? '' : 's'}
              {f.matchId ? <> in <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
              <span class="muted"> · {f.severity}{f.note ? ` · holds: ${f.note}` : ''}</span>
              {f.bursts.length > 0 && (
                <details>
                  <summary class="muted">The bursts that counted</summary>
                  <ul class="admin-list">
                    {f.bursts.map((b) => (
                      <li key={b.id}>
                        {b.ratePerSec.toFixed(1)}/s over {b.presses} presses
                        {b.weapon ? <> on <code>{b.weapon}</code></> : null}
                        {b.hold
                          ? <> · held {b.hold.medianTicks} ticks median ({b.hold.minTicks} to {b.hold.maxTicks}, sd {b.hold.sdTicks.toFixed(1)}), {Math.round(b.hold.oneTickFrac * 100)}% one-tick · <strong>{b.annotation}</strong></>
                          : <span class="muted"> · no hold data</span>}
                        {b.wire === 1 && <span class="muted"> · plugin 0.1.0: server tick timing, ghosts not excluded</span>}
                      </li>
                    ))}
                  </ul>
                  <p class="muted">
                    wheel-like: nearly every press down for a single tick, which is a mouse wheel bind or a
                    script that taps with no hold. fixed-hold: a constant hold time, as a scripted macro has.
                    variable-hold: what a hand does. This describes the evidence; it does not change the flag.
                  </p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>Connect drops</h4>
      {e.signonDrops.count === 0 ? <p class="muted">None.</p> : (
        <>
          <p class="muted">
            Left while still loading in, on a map that was enforcing file consistency. Usually a
            rejected modified file, sometimes just a cancelled loading screen.
            {' '}<a href="/help/consistency">What players are told</a>.
          </p>
          <ul class="admin-list">
            {e.signonDrops.rows.map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)}: as {r.name}, {r.secsConnected < 0 ? 'time unknown' : `after ${r.secsConnected} s`},
                {' '}{r.forcedCount} files enforced
                {r.enteredAfterAt
                  ? <span class="muted"> · got in {fmtTime(r.enteredAfterAt)}</span>
                  : <span class="admin-warn"> · has not got in since</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
