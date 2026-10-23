import { entryLogoUrl, type ProfileEvent } from '../api';
import { Panel } from './bits';
import { fmtDate } from '../format';

/** First, second, third; anything past that is just a number. */
function placeText(n: number): string {
  if (n === 1) return 'Champions';
  if (n === 2) return '2nd place';
  if (n === 3) return '3rd place';
  return `${n}th place`;
}

function statusText(e: ProfileEvent): string {
  if (e.placement !== null) return placeText(e.placement);
  if (e.status === 'live') return 'Playing now';
  if (e.status === 'finished') return 'Finished';
  return 'Upcoming';
}

/**
 * The Events section of a profile (foundation spec, Profiles: a public
 * Tournament tab). Event games never count toward the PUG numbers on the same
 * page, so they are listed here only, by event, with the team played for.
 */
export function ProfileEvents({ events }: { events: ProfileEvent[] | undefined }) {
  if (!events || events.length === 0) return null;
  return (
    <Panel class="profileevents">
      <h3>Events</h3>
      <p class="muted">Tournament play. It never counts toward PUG rating or stats.</p>
      <ul class="profileevents__list">
        {events.map((e) => (
          <li key={`${e.slug}-${e.entry.id}`} class="profileevent">
            <div class="profileevent__head">
              {e.entry.logoKey
                ? <img class="evententry__logo" src={entryLogoUrl(e.entry.logoKey)} alt="" width={36} height={36} />
                : <span class="evententry__logo evententry__logo--none" aria-hidden="true">{(e.entry.tag || e.entry.name).slice(0, 3).toUpperCase()}</span>}
              <div class="profileevent__who">
                <a class="profileevent__name" href={`/event/${e.slug}`}>{e.name}</a>
                <span class="profileevent__meta">
                  {e.entry.name}{e.entry.tag ? ` [${e.entry.tag}]` : ''}{e.entry.captain ? ' · Captain' : ''} · {fmtDate(e.startsAt)}
                </span>
              </div>
              <div class="profileevent__result">
                <span class={`teamchip${e.placement === 1 ? ' profileevent__champ' : ''}`}>{statusText(e)}</span>
                <span class="profileevent__record num">{e.wins}-{e.losses}</span>
              </div>
            </div>
            {e.matches.length > 0 && (
              <ul class="profileevent__matches">
                {e.matches.map((m) => (
                  <li key={m.id}>
                    <a href={`/event/${e.slug}/match/${m.id}`}>
                      <span class={`result result--${m.result ?? 'none'}`}>{m.result === 'win' ? 'W' : m.result === 'loss' ? 'L' : '-'}</span>
                      <span class="profileevent__round">{m.roundLabel}</span>
                      <span class="profileevent__opp">vs {m.opponent ?? 'TBD'}</span>
                      <span class="profileevent__score num">
                        {m.forfeit ? 'Forfeit' : m.scoreFor !== null && m.scoreAgainst !== null ? `${m.scoreFor}-${m.scoreAgainst}` : ''}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
