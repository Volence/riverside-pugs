import type { EndorseKind } from '../api';
import { fmtDelta, deltaClass } from '../format';
import { TitleTag } from './TitleTag';

/**
 * The rating hero: eyebrow, name in Anton, rating in gold Anton at hero size
 * with a season delta beside it, then a small grid of eyebrowed numbers.
 * The profile's hero and the leaderboard's side card are this one shape.
 *
 * The identity line (flag, pronouns), the bio and the title are optional,
 * because the leaderboard's side card uses this component too and has none
 * of them.
 */
export function Headliner(
  {
    eyebrow, name, rating, delta, stats, avatar,
    pronouns, countryCode, countryLabel, countryFlag, bio, title,
  }: {
    eyebrow: string;
    name: string;
    rating: number | null;
    delta?: number | null;
    stats: { label: string; value: string | number; tone?: 'win' | 'loss' }[];
    avatar?: string | null;
    pronouns?: string | null;
    countryCode?: string | null;
    countryLabel?: string | null;
    countryFlag?: string | null;
    bio?: string | null;
    /** The endorsement title, shown beside the name. */
    title?: EndorseKind | null;
  },
) {
  const hasIdentity = Boolean(countryFlag || pronouns);
  return (
    <section class={`panel headliner${avatar ? ' headliner--avatar' : ''}`}>
      {avatar && <img class="headliner__avatar" src={avatar} alt="" />}
      <p class="eyebrow headliner__eyebrow">{eyebrow}</p>
      <h2 class="headliner__name">{name}<TitleTag kind={title} /></h2>
      {hasIdentity && (
        <div class="headliner__identity">
          {countryFlag && (
            <span
              class="headliner__flag"
              title={countryLabel ?? countryCode ?? ''}
              aria-label={countryLabel ?? countryCode ?? ''}
            >
              {countryFlag}
            </span>
          )}
          {pronouns && <span class="headliner__pronouns">{pronouns}</span>}
        </div>
      )}
      {bio && <p class="headliner__bio">{bio}</p>}
      <div class="headliner__row">
        {rating === null
          ? <span class="headliner__unrated">Unrated this season</span>
          : <span class="headliner__rating num">{rating}</span>}
        {delta !== undefined && delta !== null && (
          <span class={`${deltaClass(delta)} headliner__delta`}>{fmtDelta(delta)}</span>
        )}
      </div>
      {stats.length > 0 && (
        <div class="headliner__stats">
          {stats.map((s) => (
            <div key={s.label}>
              <p class="eyebrow">{s.label}</p>
              <p class={`headliner__stat-value num${s.tone ? ` headliner__stat-value--${s.tone}` : ''}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
