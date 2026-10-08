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
  return (
    <article class="draftcard" aria-label={card.name}>
      <header class="draftcard__head">
        <h4 class="draftcard__name">{card.name}</h4>
        <span class="draftcard__sr">{`SR ${card.sr}`}</span>
      </header>
      {trend && <p class="draftcard__line muted">{trend}</p>}
      <p class="draftcard__line">{`Survivor: ${card.survivor.siDamage} SI damage, ${card.survivor.commonKills} commons a game`}</p>
      <p class="draftcard__line">{`Infected: ${card.infected.damageAsSi} damage, ${card.infected.dpsLanded} DPs a game`}</p>
      {card.bestClass && <p class="draftcard__line">{`Best class: ${CLASS_NAME[card.bestClass.cls]}`}</p>}
      {card.skills.length > 0 && <p class="draftcard__line muted">{card.skills.slice(0, 4).map((s) => `${s.label} ${s.total}`).join(' · ')}</p>}
      <p class="draftcard__form" aria-label={card.form.length === 0 ? 'Recent form' : `Recent form: ${card.form.map((r) => RESULT[r]).join(', ')}`}>
        {card.pugs === 0 ? 'No PUGs yet' : card.form.length > 0 && (
          <>
            <span class="draftcard__formlabel muted" aria-hidden="true">{`Last ${card.form.length}`}</span>
            {card.form.map((r, i) => <span key={i} class={`chip draftcard__res draftcard__res--${r}`} title={RESULT[r]} aria-hidden="true">{r}</span>)}
          </>
        )}
      </p>
      {chemistry && <p class="draftcard__line">{`With you: ${chemistry.together} games, ${chemistry.wonTogether} won · Against you: ${chemistry.against}, you won ${chemistry.wonAgainst}`}</p>}
      {note && <p class="draftcard__note">{`Note: ${note}`}</p>}
      {action}
    </article>
  );
}
