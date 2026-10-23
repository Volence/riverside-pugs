import { useState } from 'preact/hooks';
import { adminApi, peopleApi, type FileAction, type MergePlan, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { fileUrl } from '../adminRoutes';
import { SteamAccountPanel } from '../SteamAccountPanel';
import { countryName } from '../../../countries';

/** Names played under, aliases, Discord history, the Steam account and
 *  shared connections, then the merge tool that all of it is evidence for. Moderators see every row
 *  here, network sightings included: the owner ruled on that the same day.
 *  Only the merge form (and, inside SteamAccountPanel, the Steam refresh) is
 *  admin-only.
 *
 *  The Steam account block reuses SteamAccountPanel rather than a second copy
 *  of it: the controller ruled that if that panel is ever retired, every fact
 *  it shows (and "Check now") has to survive here, and the surest way to keep
 *  that true is one component, not two that can drift. */
export function IdentitySection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const id = d.sections.identity;
  const [into, setInto] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [personChoice, setPersonChoice] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const countries = [...new Set(id.networks.map((n) => n.country).filter(Boolean))].map(countryName);

  const preview = async () => {
    setPlan(null);
    setPlanError('');
    try {
      const res = await adminApi.mergePlayer(d.steamid, into.trim(), true);
      setPlan(res.plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not read that account.');
    }
  };

  return (
    <Panel class="file-section">
      <h3 id="identity">Identity</h3>

      {(id.names?.length ?? 0) > 0 && (
        <>
          <h4>Names played under</h4>
          <ul class="file-rows">
            {id.names!.map((n) => (
              <li key={n.key} class="file-row file-row--name">
                <span class="file-row__name">{n.name}</span>
                <span class="file-row__fig">{n.matches} {n.matches === 1 ? 'match' : 'matches'} · {n.sources.map((src) => (src === 'steam' ? 'Steam' : 'in game')).join(' and ')}</span>
                <span class="muted file-row__when">first {fmtTime(n.firstSeen)}, last {fmtTime(n.lastSeen)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {id.discordHistory.length > 0 && (
        <>
          <h4>Discord accounts</h4>
          <ul class="file-rows">
            {id.discordHistory.map((h) => (
              <li key={`${h.discordId}-${h.linkedAt}`} class="file-row">
                <div class="file-row__main">
                  <span>{h.discordName || 'unknown'} <code>{h.discordId}</code></span>
                  <span class={`file-pill${h.unlinkedAt ? ' file-pill--lifted' : ' file-pill--ok'}`}>{h.unlinkedAt ? 'unlinked' : 'current'}</span>
                </div>
                <div class="file-row__meta">
                  {h.linkedBy === 'backfill' ? 'linked before history was kept' : `linked ${fmtTime(h.linkedAt)}`}
                  {h.unlinkedAt ? `, unlinked ${fmtTime(h.unlinkedAt)}${h.unlinkedBy === 'merge' ? ' by a merge' : ''}` : ''}
                </div>
                {h.others.map((o) => (
                  <div key={`${o.steamid}-${o.linkedAt}`} class="file-row__meta">
                    This Discord was {o.unlinkedAt ? 'previously' : 'also'} linked to{' '}
                    <a href={fileUrl(o.steamid)}>{o.name ?? o.steamid}</a>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      {(countries.length > 0 || id.sharesAddressWith.length > 0) && <h4>Connections</h4>}
      {countries.length > 0 && (
        <p class="file-help">Connects from {countries.join(', ')} · {id.networks.length} connection{id.networks.length === 1 ? '' : 's'} seen</p>
      )}
      {id.sharesAddressWith.length > 0 && (
        <>
          <p><strong>Seen on the same connection as:</strong></p>
          <ul class="file-rows">
            {id.sharesAddressWith.map((o) => (
              <li key={o.steamid} class="file-row file-row--line">
                <a href={fileUrl(o.steamid)}>{o.name}</a> <code>{o.steamid}</code>{' '}
                <span class="muted">
                  {o.seenCount} {o.seenCount === 1 ? 'connect' : 'connects'}
                  {o.country ? `, ${countryName(o.country)}` : ''}, last {fmtTime(o.lastSeen)}
                </span>
              </li>
            ))}
          </ul>
          <p class="file-help">
            A shared connection is not proof. A VPN, a household, a LAN cafe and two siblings all
            look like this. Check it against how they play before merging.
          </p>
        </>
      )}

      <div class="file-sub">
        <SteamAccountPanel
          d={{ steamid: d.steamid, steamAccount: id.steamAccount }}
          busy={busy}
          run={run}
          canRefresh={can('steam_refresh')}
          onSelect={(steamid) => { location.href = fileUrl(steamid); }}
        />
      </div>

      {(id.evaderPerson || can('looked_at')) && <h4>Known evader</h4>}
      {id.evaderPerson ? (
        <p>
          <span class="admin-status admin-status--banned">known evader</span>{' '}
          One of <a href="/admin/people/alts">{id.evaderPerson.label}</a>'s accounts
          {id.evaderPerson.closed ? ' (record closed)' : '. Every connection it uses is on the IP watch list.'}{' '}
          <span class="muted">Remove it from the Known evaders card on Alts.</span>
        </p>
      ) : can('looked_at') && (
        <form class="admin-merge" onSubmit={(e) => {
          e.preventDefault();
          const to = personChoice === 'new' ? { label: newLabel.trim() } : { personId: Number(personChoice) };
          const who = personChoice === 'new' ? newLabel.trim() : (id.evaderOptions ?? []).find((o) => String(o.id) === personChoice)?.label;
          void run(() => peopleApi.addToPerson(d.steamid, to), {
            title: `Add ${d.header.name} to ${who ?? 'that person'}?`,
            body: 'Every connection they have used, and any they use later, goes on the IP watch list, and their presses join the person\'s fingerprint. It does not ban anyone.',
            confirmLabel: 'Add to person',
          }).then(() => { setPersonChoice(''); setNewLabel(''); });
        }}>
          <select value={personChoice} aria-label="Known evader"
            onChange={(e) => setPersonChoice((e.target as HTMLSelectElement).value)}>
            <option value="">Add to person...</option>
            {(id.evaderOptions ?? []).map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
            <option value="new">New person</option>
          </select>
          {personChoice === 'new' && (
            <input value={newLabel} placeholder="Label (e.g. dethisa)" aria-label="New person label" maxLength={40}
              onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          )}
          <button class="btn" type="submit"
            disabled={busy || !personChoice || (personChoice === 'new' && !newLabel.trim())}>Add to person</button>
        </form>
      )}

      {(id.altHolds?.length ?? 0) > 0 && (
        <>
          <h4>Alt holds</h4>
          <p class="file-help"><a href="/admin/people/alts">Review on Alts</a></p>
          <ul class="file-rows">
            {id.altHolds!.map((h) => (
              <li key={h.id} class="file-row">
                {h.source === 'fingerprint'
                  ? (h.steamid === d.steamid
                    ? <>Held on a press fingerprint match with <strong>{h.personLabel ?? 'a known evader'}</strong> (nearest account <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>)</>
                    : <>The nearest account to <a href={fileUrl(h.steamid)}>{h.name}</a>, held on a fingerprint match with {h.personLabel ?? 'a known evader'}</>)
                  : h.steamid === d.steamid
                    ? <>Held because Discord {h.discordName || h.discordId} came from <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a></>
                    : <>Discord {h.discordName || h.discordId} moved from here to <a href={fileUrl(h.steamid)}>{h.name}</a>, which was held</>}
                {' '}
                <span class="muted">
                  {fmtTime(h.createdAt)}
                  {h.resolution ? `, ${h.resolution === 'cleared' ? 'lifted' : h.resolution} ${fmtTime(h.resolvedAt)}${h.resolvedByName ? ` by ${h.resolvedByName}` : ''}` : ', still on hold'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {id.aliases.length > 0 && <h4>Merged accounts</h4>}
      {id.aliases.length > 0 && (
        <ul class="file-rows">
          {id.aliases.map((a) => (
            <li key={a.steamid} class="file-row file-row--line">
              Merged in: <code>{a.steamid}</code> <span class="muted">since {fmtTime(a.created_at)}</span>{' '}
              {can('merge') && (
                <button class="chip" type="button" disabled={busy}
                  onClick={() => run(
                    () => adminApi.unaliasPlayer(a.steamid),
                    `Stop treating ${a.steamid} as ${d.header.name}? Their past matches stay merged; the account is just free to be its own identity again.`,
                  )}>Separate</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {can('merge') && (
        <div class="file-danger" id="merge">
          <h4>Merge into another account</h4>
          <p class="file-help">
            Merge this account into another, for one person playing on two Steam accounts.
            <strong> {d.header.name} disappears</strong> and everything they did moves to the account you name.
          </p>
          <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
            <input value={into} placeholder="SteamID64 to keep" aria-label="Merge into"
              onInput={(e) => { setInto((e.target as HTMLInputElement).value); setPlan(null); }} />
            <button class="btn" type="submit" disabled={busy || !/^\d{17}$/.test(into.trim())}>Preview</button>
          </form>
          {planError && <p class="error">{planError}</p>}
          {plan && (
            <div class="admin-merge__plan">
              <p><strong>{plan.matchesMoved}</strong> matches move, <strong>{plan.matchesCollapsed}</strong> of them had both accounts rostered.</p>
              <p class="muted">
                Season {plan.seasons.join(', ')} will be recomputed, which changes the rating of
                everyone who played in those matches, not only these two accounts. There is no undo.
              </p>
              <ul class="muted">
                {Object.entries(plan.rowsByTable).sort().map(([t, n]) => <li key={t}><code>{t}</code> {n}</li>)}
              </ul>
              <button class="btn" type="button" disabled={busy}
                onClick={() => run(
                  () => adminApi.mergePlayer(d.steamid, into.trim()),
                  `Merge ${d.header.name} into ${into.trim()} and recompute season ${plan.seasons.join(', ')}? This cannot be undone.`,
                )}>Merge and recompute</button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
