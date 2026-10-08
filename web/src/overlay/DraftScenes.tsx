import { Backdrop, Countdown, Title, fmtClock } from './pieces';
import type { DraftReveal } from './draftReveal';
import type { CastDraftCard, CastDraftPlayer, CastDraftView, StudioState } from '../../../src/cast/types';

/**
 * The live draft scenes (drafts plan D2b2 Rulings 4, 7 and 8): the board,
 * on the clock, and the pick reveal as a big card (over the two draft
 * scenes) or a lower-third strip (the Pick reveal layer, and Program over
 * other scenes). Everything here is the public room (CastDraftView).
 */

/** One colour per team in round 1 order (Ruling 8). */
export const DRAFT_TEAM_COLORS: readonly string[] = ['#5b8fd9', '#d9913f', '#6fbf73', '#c76fd1', '#d9cf4f', '#4fc9d9', '#d95f7a', '#9a8f80'];
const CLASS_NAME = { hunter: 'Hunter', smoker: 'Smoker', boomer: 'Boomer', tank: 'Tank' } as const;
/** The last seconds of a pick turn the clock to the accent colour. */
const LOW_MS = 10_000;

const colorOf = (i: number): string => DRAFT_TEAM_COLORS[Math.max(0, i) % DRAFT_TEAM_COLORS.length]!;
const teamIndex = (d: CastDraftView, captain: string): number => d.teams.findIndex((t) => t.captain.steamid === captain);
const teamVar = (i: number) => ({ '--c': colorOf(i) } as Record<string, string>);

function nameIn(d: CastDraftView, steamid: string): string {
  for (const t of d.teams) {
    if (t.captain.steamid === steamid) return t.captain.name;
    const p = t.players.find((x) => x.steamid === steamid);
    if (p) return p.name;
  }
  return steamid;
}

/** Time left on the pick clock: the stored deadline against the overlay's
 *  server-synced now, or the frozen time left while paused. */
export function draftClockMs(d: CastDraftView, now: number): number | null {
  if (d.status === 'running' && d.deadlineAt) return Math.max(0, Date.parse(d.deadlineAt) - now);
  if (d.status === 'paused' && d.pausedLeftMs !== null) return d.pausedLeftMs;
  return null;
}

export function draftStatusLine(d: CastDraftView, leftMs: number | null): string {
  switch (d.status) {
    case 'ready': return 'The draft starts soon';
    case 'paused': return `Paused${leftMs !== null ? ` · ${fmtClock(leftMs)} left on the clock` : ''}`;
    case 'done': return 'Draft complete';
    case 'running': return d.onClock ? `Pick ${d.onClock.pickNo} of ${d.totalPicks} · Round ${d.onClock.round} · ${fmtClock(leftMs ?? 0)}` : 'Picking';
  }
}

function Face({ p, size }: { p: CastDraftPlayer; size: number }) {
  const box = { width: `${size}px`, height: `${size}px` };
  return p.avatar
    ? <img class="ov-dface" style={box} src={p.avatar} alt="" referrerpolicy="no-referrer" />
    : <span class="ov-dface ov-dface--none" style={{ ...box, fontSize: `${Math.round(size * 0.42)}px` }}>{[...p.name][0]?.toUpperCase() ?? '?'}</span>;
}

function Form({ form }: { form: CastDraftCard['form'] }) {
  return <span class="ov-dform">{form.slice(0, 5).map((r, i) => <i key={i} class={`ov-dform__r ov-dform__r--${r}`}>{r}</i>)}</span>;
}

export function DraftBoard({ studio, draft, now, reveal }: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }) {
  if (!draft) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="Draft board" /></div>;
  const up = draft.status === 'running' ? draft.onClock : null;
  const left = draftClockMs(draft, now);
  const dense = draft.teams.length > 5;
  return (
    <div class="ov-full">
      <Backdrop art="survivor-hilltop" />
      <Title studio={studio} fallback={draft.eventName} />
      <div class={`ov-dboard${dense ? ' ov-dboard--dense' : ''}`} style={{ '--n': String(Math.max(1, draft.teams.length)) } as Record<string, string>}>
        {draft.teams.map((t, i) => (
          <section key={t.captain.steamid} class={`ov-dboard__team${up?.captain === t.captain.steamid ? ' is-up' : ''}`} style={{ ...teamVar(i), animationDelay: `${i * 70}ms` } as Record<string, string>}>
            <header class="ov-dboard__cap">
              <Face p={t.captain} size={72} />
              <span class="ov-dboard__capname">{t.captain.name}</span>
              <span class="ov-dboard__sr">{`Captain · ${t.captain.sr} SR`}</span>
            </header>
            {Array.from({ length: draft.rounds }, (_, r) => {
              const p = t.players[r];
              const pickNo = t.slots[r];
              const isUp = !p && up !== null && pickNo === up.pickNo;
              const auto = p ? draft.picks.find((x) => x.steamid === p.steamid)?.auto === true : false;
              return (
                <div key={r} class={`ov-dboard__slot${p ? ' is-filled' : ''}${isUp ? ' is-up' : ''}`}>
                  <span class="ov-dboard__no">{pickNo ? `#${pickNo}` : `R${r + 1}`}</span>
                  {p ? (
                    <>
                      <Face p={p} size={52} />
                      <span class="ov-dboard__name">{p.name}</span>
                      <span class="ov-dboard__sr">{`${p.sr} SR${auto ? ' · Auto' : ''}`}</span>
                    </>
                  ) : <span class="ov-dboard__open">{isUp ? 'On the clock' : 'Open'}</span>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <p class="ov-dboard__foot">{draftStatusLine(draft, left)}</p>
      {reveal && <DraftRevealCard draft={draft} reveal={reveal} />}
    </div>
  );
}

function MiniCard({ card }: { card: CastDraftCard }) {
  return (
    <div class="ov-dmini">
      <Face p={card} size={56} />
      <div class="ov-dmini__body">
        <span class="ov-dmini__name">{card.name}</span>
        <span class="ov-dmini__line">{`${card.sr} SR · ${card.pugs} PUGs${card.bestClass ? ` · ${CLASS_NAME[card.bestClass]}` : ''}`}</span>
      </div>
      <Form form={card.form} />
    </div>
  );
}

export function OnTheClock({ studio, draft, now, reveal }: { studio: StudioState; draft: CastDraftView | null; now: number; reveal: DraftReveal | null }) {
  if (!draft) return <div class="ov-full"><Backdrop /><Title studio={studio} fallback="On the clock" /></div>;
  const up = draft.status === 'running' ? draft.onClock : null;
  const left = draftClockMs(draft, now);
  const ti = up ? teamIndex(draft, up.captain) : -1;
  const team = ti >= 0 ? draft.teams[ti]! : null;
  return (
    <div class="ov-full">
      <Backdrop art="infected-hunter" />
      <Title studio={studio} fallback={draft.eventName} />
      {team && up ? (
        <div class="ov-dclock" style={teamVar(ti)}>
          <section class="ov-dclock__who">
            <p class="ov-dclock__eyebrow">On the clock</p>
            <Face p={team.captain} size={200} />
            <h2 class="ov-stencil ov-dclock__name">{team.captain.name}</h2>
            {up.picker !== up.captain && <p class="ov-dclock__picker">{`${nameIn(draft, up.picker)} picks for the team`}</p>}
            <p class="ov-dclock__pick">{`Pick ${up.pickNo} of ${draft.totalPicks} · Round ${up.round}`}</p>
          </section>
          <section class="ov-dclock__time">
            <span class={`ov-dclock__clock${left !== null && left <= LOW_MS ? ' is-low' : ''}`} aria-label="Time left">{fmtClock(left ?? 0)}</span>
            <div class="ov-dclock__team">
              <p class="ov-dclock__label">Team so far</p>
              <ul>
                {[team.captain, ...team.players].map((p) => <li key={p.steamid}><Face p={p} size={44} /><span class="ov-dclock__tname">{p.name}</span><b>{p.sr}</b></li>)}
              </ul>
            </div>
          </section>
          <section class="ov-dclock__best">
            <p class="ov-dclock__label">Best available by SR</p>
            {draft.best.map((c) => <MiniCard key={c.steamid} card={c} />)}
          </section>
        </div>
      ) : (
        <div class="ov-dclock ov-dclock--idle">
          <p class="ov-stencil ov-dclock__idle">{draftStatusLine(draft, left)}</p>
          {draft.status === 'ready' && studio.countdownTo && <Countdown to={studio.countdownTo} now={now} label="Draft starts in" />}
        </div>
      )}
      {reveal && <DraftRevealCard draft={draft} reveal={reveal} />}
    </div>
  );
}

export function DraftRevealCard({ draft, reveal }: { draft: CastDraftView; reveal: DraftReveal }) {
  const p = reveal.pick;
  const card = draft.cards[p.steamid];
  return (
    <div class="ov-dreveal" key={reveal.key} style={teamVar(teamIndex(draft, p.captain))} role="status">
      <p class="ov-dreveal__pick">{`Pick ${p.pickNo} · Round ${p.round}${p.auto ? ' · Auto pick' : ''}`}</p>
      {card && <Face p={card} size={180} />}
      <h2 class="ov-stencil ov-dreveal__name">{p.name}</h2>
      <p class="ov-dreveal__to">{`to ${nameIn(draft, p.captain)}'s team`}</p>
      {card && (
        <dl class="ov-dreveal__stats">
          <div><dt>SR</dt><dd>{card.sr}</dd></div>
          <div><dt>PUGs</dt><dd>{card.pugs}</dd></div>
          <div><dt>SI dmg a game</dt><dd>{card.survivor.siDamage}</dd></div>
          {/* Not upper-cased: "DPS" reads as damage per second. */}
          <div><dt class="ov-keepcase">DPs a game</dt><dd>{card.infected.dpsLanded}</dd></div>
          {card.bestClass && <div><dt>Best class</dt><dd>{CLASS_NAME[card.bestClass]}</dd></div>}
        </dl>
      )}
      {card && <Form form={card.form} />}
    </div>
  );
}

export function DraftRevealStrip({ draft, reveal }: { draft: CastDraftView; reveal: DraftReveal }) {
  const p = reveal.pick;
  const card = draft.cards[p.steamid];
  return (
    <div class="ov-dstrip" key={reveal.key} style={teamVar(teamIndex(draft, p.captain))} role="status">
      <span class="ov-dstrip__pick">{`Pick ${p.pickNo}`}</span>
      {card && <Face p={card} size={64} />}
      <span class="ov-dstrip__name">{p.name}</span>
      <span class="ov-dstrip__to">{`to ${nameIn(draft, p.captain)}'s team${p.auto ? ' (auto pick)' : ''}`}</span>
      {card && <span class="ov-dstrip__sr">{`${card.sr} SR`}</span>}
    </div>
  );
}
