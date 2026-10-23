// web/src/routes/event/draft/DraftCard.tsx
import type { ComponentChildren } from 'preact';
import type { PairChemistryView, PlayerCardView } from '../../../api';
import { CLASS_NAME, trendText } from './draftText';

/** The letters PlayerCardView.form uses (src/events/draftCards.ts), newest first. */
const RESULT = { W: 'Win', L: 'Loss', D: 'Draw' } as const;

/** One pool player's card (drafts plan D2b1 Ruling 3). note and chemistry
 *  arrive only for the viewers the server allows them. */
export function DraftCard({ card, note, chemistry, action }: {
  card: PlayerCardView; note?: string | null; chemistry?: PairChemistryView | null; action?: ComponentChildren;
}) {
  const trend = trendText(card.trend);
  // One block per side, the number first: a captain scans the figures, not
  // the sentence. Figures are per game.
  const stat = (value: number, label: string) => (
    <span class="draftcard__stat"><span class="draftcard__num">{value}</span> <span class="muted">{label}</span></span>
  );
  return (
    <article class="draftcard" aria-label={card.name}>
      <header class="draftcard__head">
        <h4 class="draftcard__name">{card.name}</h4>
        <span class="draftcard__sr">{`SR ${card.sr}`}</span>
      </header>
      {(trend || card.bestClass) && (
        <p class="draftcard__sub">
          {card.bestClass && <span class="teamchip">{`Best: ${CLASS_NAME[card.bestClass.cls]}`}</span>}
          {trend && <span class="muted">{trend}</span>}
        </p>
      )}
      <div class="draftcard__sides" title="Averages a game">
        <div class="draftcard__side">
          <span class="draftcard__sidelabel">Survivor</span>
          {stat(card.survivor.siDamage, 'SI dmg')}
          {stat(card.survivor.commonKills, 'commons')}
        </div>
        <div class="draftcard__side">
          <span class="draftcard__sidelabel">Infected</span>
          {stat(card.infected.damageAsSi, 'dmg')}
          {stat(card.infected.dpsLanded, 'DPs')}
        </div>
      </div>
      {card.skills.length > 0 && (
        <p class="draftcard__skills">{card.skills.slice(0, 4).map((s) => <span key={s.label} class="draftcard__skill"><span class="draftcard__num">{s.total}</span> <span class="muted">{s.label}</span></span>)}</p>
      )}
      <p class="draftcard__form" aria-label={card.form.length === 0 ? 'Recent form' : `Recent form: ${card.form.map((r) => RESULT[r]).join(', ')}`}>
        {card.pugs === 0 ? 'No PUGs yet' : card.form.length > 0 && (
          <>
            <span class="draftcard__formlabel muted" aria-hidden="true">{`Last ${card.form.length}`}</span>
            {card.form.map((r, i) => <span key={i} class={`draftcard__res draftcard__res--${r}`} title={RESULT[r]} aria-hidden="true">{r}</span>)}
          </>
        )}
      </p>
      {chemistry && <p class="draftcard__line">{`With you: ${chemistry.together} games, ${chemistry.wonTogether} won · Against you: ${chemistry.against}, you won ${chemistry.wonAgainst}`}</p>}
      {note && <p class="draftcard__note">{`Note: ${note}`}</p>}
      {action}
    </article>
  );
}
