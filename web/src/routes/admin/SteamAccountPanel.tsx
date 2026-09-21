import type { AdminPlayerDetail, SteamAccount } from '../../api';
import { adminApi } from '../../api';
import { fmtTime, type Run } from './useAction';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const profileUrl = (steamid: string): string => `https://steamcommunity.com/profiles/${steamid}`;

/**
 * What Steam says about the account, next to what this site knows.
 *
 * Context for a human, worded that way on purpose. Everything here has an
 * innocent reading that is also the common one: new players have new
 * accounts, a VAC ban can be from another game years ago, a second PC hides
 * hours, and a household shares one library. The flags arrive already hedged
 * from the server; this only lays them out.
 */
export function SteamAccountPanel(
  { d, busy, run, onSelect }: { d: AdminPlayerDetail; busy: boolean; run: Run; onSelect: (steamid: string) => void },
) {
  const a = d.steamAccount ?? null;
  return (
    <section id="steam-account">
      <h4>Steam account</h4>
      <p class="muted">
        What Steam says about this account. Context to weigh with everything else on this page,
        not a verdict: each of these has an ordinary explanation, and it is usually the right one.
      </p>
      {a ? <Facts a={a} onSelect={onSelect} /> : (
        <p class="muted">Steam has not been asked about this account yet.</p>
      )}
      <p class="muted">
        <a href={profileUrl(d.steamid)} target="_blank" rel="noreferrer">Steam profile</a>
        {a ? ` · checked ${fmtTime(a.checkedAt)} · ` : ' · '}
        <button class="chip" type="button" disabled={busy} onClick={() => run(() => adminApi.steamRefresh(d.steamid))}>
          Check now
        </button>
      </p>
    </section>
  );
}

function Facts({ a, onSelect }: { a: SteamAccount; onSelect: (steamid: string) => void }) {
  const bans = a.bans;
  const banned = bans !== null && bans.vac + bans.game > 0;
  return (
    <>
      {a.flags.length > 0 && (
        <ul class="admin-list">
          {/* Not in the warning colour: these are notes, and a page that
              paints "new account" red has already reached a verdict. */}
          {a.flags.map((f) => {
            const cut = f.text.indexOf(': ');
            return (
              <li key={f.kind}>
                {cut < 0 ? f.text : <><strong>{f.text.slice(0, cut + 1)}</strong>{f.text.slice(cut + 1)}</>}
              </li>
            );
          })}
        </ul>
      )}
      <ul class="admin-list">
        <li>
          <span class="muted">Account: </span>
          {a.createdAt === null || a.ageDays === null ? 'age hidden' : (
            <>
              {plural(a.ageDays, 'day')} old, created {new Date(a.createdAt).toLocaleDateString()}
              {a.reference && a.daysBeforeReference !== null && (
                <span class="muted">
                  {' '}· created {plural(a.daysBeforeReference, 'day')} before{' '}
                  {a.reference.kind === 'first_match' ? 'their first match here' : 'they joined here'}
                </span>
              )}
            </>
          )}
        </li>
        <li>
          <span class="muted">Bans elsewhere: </span>
          {bans === null ? 'not known' : !banned ? 'No VAC or game bans' : (
            <span class="admin-warn">
              {[bans.vac ? plural(bans.vac, 'VAC ban') : '', bans.game ? plural(bans.game, 'game ban') : ''].filter(Boolean).join(', ')}
              {bans.daysSinceLast !== null && `, latest ${bans.daysSinceLast === 0 ? 'today' : `${plural(bans.daysSinceLast, 'day')} ago`}`}
            </span>
          )}
          {bans?.community && <span class="muted"> · community banned</span>}
          {bans && bans.economy !== 'none' && <span class="muted"> · trade: {bans.economy}</span>}
        </li>
        <li>
          <span class="muted">L4D1 hours: </span>
          {a.l4d1 === null && 'not known'}
          {a.l4d1?.state === 'visible' && `${a.l4d1.hours} h`}
          {a.l4d1?.state === 'not_owned' && 'not in their library (a borrowed copy does not show here)'}
          {a.l4d1?.state === 'hidden' && (
            a.l4d1.lastSeenHours === null ? 'hidden' : `hidden (${a.l4d1.lastSeenHours} h when last visible)`
          )}
        </li>
        <li>
          <span class="muted">Profile: </span>
          {a.visibility === 'public' ? 'Public' : a.visibility === 'private' ? 'Private' : 'not known'}
          {a.profileConfigured === false && <span class="muted"> · never set up</span>}
          <span class="muted"> · </span>
          {a.level === null ? 'level hidden' : `Level ${a.level}`}
        </li>
        {a.lender && (
          <li>
            <span class="muted">Family Sharing: </span>
            playing on a copy lent by{' '}
            {a.lender.player ? (
              <button class="chip" type="button" onClick={() => onSelect(a.lender!.player!.steamid)}>
                {a.lender.player.name}
              </button>
            ) : (
              <a href={profileUrl(a.lender.steamid)} target="_blank" rel="noreferrer">{a.lender.steamid}</a>
            )}
            {a.lender.player?.banned && <strong class="admin-warn"> · BANNED here</strong>}
            {a.lender.player === null && <span class="muted"> · not a player here</span>}
            <span class="muted"> · last seen {fmtTime(a.lender.seenAt)}</span>
          </li>
        )}
      </ul>
    </>
  );
}
