// web/src/routes/event/draft/DraftCard.tsx
import type { ComponentChildren } from 'preact';
import type { PairChemistryView, PlayerCardView } from '../../../api';
import { CLASS_NAME, statText, trendShort, trendText } from './draftText';

/** The letters PlayerCardView.form uses (src/events/draftCards.ts), newest first. */
export const RESULT = { W: 'Win', L: 'Loss', D: 'Draw' } as const;

/** The recent-form strip: one square per game, on one line. */
export const formLabel = (card: PlayerCardView): string =>
  card.form.length === 0 ? 'Recent form' : `Recent form: ${card.form.map((r) => RESULT[r]).join(', ')}`;
export function FormStrip({ card, labelled = true }: { card: PlayerCardView; labelled?: boolean }) {
  if (card.pugs === 0) return <span class="muted">No PUGs yet</span>;
  if (card.form.length === 0) return null;
  return (
    <span class="draftform" aria-label={labelled ? formLabel(card) : undefined}>
      {card.form.map((r, i) => <span key={i} class={`draftcard__res draftcard__res--${r}`} title={RESULT[r]} aria-hidden="true">{r}</span>)}
    </span>
  );
}

/** One pool player's card (drafts plan D2b1 Ruling 3), laid out for a captain
 *  reading it against a 75 second clock: name and SR first, then four per-game
 *  figures in one aligned row, then the skill counts, form, and the private
 *  lines. note and chemistry arrive only for the viewers the server allows. */
export function DraftCard({ card, note, chemistry, action }: {
  card: PlayerCardView; note?: string | null; chemistry?: PairChemistryView | null; action?: ComponentChildren;
}) {
  const trend = trendShort(card.trend);
  const up = card.trend.length >= 2 && card.trend[card.trend.length - 1]! >= card.trend[0]!;
  const cell = (value: number, label: string) => (
    <div class="draftstat"><dt class="draftstat__label">{label}</dt><dd class="draftstat__num">{statText(value)}</dd></div>
  );
  return (
    <article class="draftcard" aria-label={card.name}>
      <header class="draftcard__head">
        <h4 class="draftcard__name">{card.name}</h4>
        <span class="draftcard__sr">{card.sr}<span class="draftcard__srlabel"> SR</span></span>
      </header>
      {(trend || card.bestClass) && (
        <p class="draftcard__sub">
          {card.bestClass && <span class="teamchip" title="Best infected class by damage">{CLASS_NAME[card.bestClass.cls]}</span>}
          {trend && <span class={`draftcard__trend draftcard__trend--${up ? 'up' : 'down'}`} title={trendText(card.trend) ?? undefined}>{trend}</span>}
        </p>
      )}
      <div class="draftcard__stats" title="Averages a game">
        <span class="draftcard__group">Survivor</span>
        <span class="draftcard__group">Infected</span>
        <dl class="draftcard__cells">
          {cell(card.survivor.siDamage, 'SI dmg')}
          {cell(card.survivor.commonKills, 'Commons')}
          {cell(card.infected.damageAsSi, 'Damage')}
          {cell(card.infected.dpsLanded, 'DPs')}
        </dl>
      </div>
      {card.skills.length > 0 && (
        <p class="draftcard__skills">{card.skills.slice(0, 4).map((s) => <span key={s.label} class="draftcard__skill"><span class="draftcard__num">{s.total}</span> {s.label}</span>)}</p>
      )}
      <p class="draftcard__form" aria-label={formLabel(card)}>
        {card.form.length > 0 && card.pugs > 0 && <span class="draftcard__formlabel muted" aria-hidden="true">{`Last ${card.form.length}`}</span>}
        <FormStrip card={card} labelled={false} />
      </p>
      {chemistry && <p class="draftcard__line">{`With you: ${chemistry.together} games, ${chemistry.wonTogether} won · Against you: ${chemistry.against}, you won ${chemistry.wonAgainst}`}</p>}
      {note && <p class="draftcard__note">{`Note: ${note}`}</p>}
      {action && <div class="draftcard__action">{action}</div>}
    </article>
  );
}

/** The same pool as one row per player, for a captain who wants to compare
 *  everyone at once. Notes and chemistry stay on the cards; on a phone the
 *  figures drop out so the Pick button stays on screen. */
export function DraftPoolList({ cards, notes, action }: {
  cards: PlayerCardView[]; notes?: Record<string, string> | null; action?: (c: PlayerCardView) => ComponentChildren;
}) {
  return (
    <div class="table-wrap">
      <table class="draftlist">
        <thead>
          <tr>
            <th>Player</th><th class="num">SR</th><th>Class</th>
            <th class="num draftlist__wide" title="Survivor: SI damage a game">SI dmg</th><th class="num draftlist__wide" title="Infected: damage a game">Inf dmg</th>
            <th class="num draftlist__wide" title="Infected: damage pounces a game">DPs</th><th class="draftlist__wide">Form</th>{action && <th><span class="sr-only">Pick</span></th>}
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.steamid} aria-label={c.name}>
              <td class="draftlist__name">{c.name}{notes?.[c.steamid] && <span class="draftlist__note" title={notes[c.steamid]}> · note</span>}</td>
              <td class="num draftlist__sr">{c.sr}</td>
              <td>{c.bestClass ? CLASS_NAME[c.bestClass.cls] : ''}</td>
              <td class="num draftlist__wide">{statText(c.survivor.siDamage)}</td>
              <td class="num draftlist__wide">{statText(c.infected.damageAsSi)}</td>
              <td class="num draftlist__wide">{statText(c.infected.dpsLanded)}</td>
              <td class="draftlist__wide"><FormStrip card={c} /></td>
              {action && <td class="draftlist__act">{action(c)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
