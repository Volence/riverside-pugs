import { useState } from 'preact/hooks';
import { peopleApi, type KnownEvader } from '../../api';
import { SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';
import { countryName } from '../../countries';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction, type Run } from './useAction';
import { fileUrl, guideUrl } from './adminRoutes';

const LEVEL_LABEL = { alert: 'fingerprint only', loud: 'fingerprint and a second sign', hold: 'held' } as const;
const signText = (s: string): string => SIGN_TEXT[s as SecondSign] ?? s;

/**
 * Known evaders (src/evaderPeople.ts): one card per person, grouping every
 * account they have been caught on. Members' connections are on the IP watch
 * list, and the person's pooled hold times are what every new account is
 * checked against at the end of each match. A fingerprint alert says "could
 * be them": the guide explains how to read one.
 */
export function KnownEvaders({ isAdmin }: { isAdmin: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => peopleApi.evaders(s), []);
  const { busy, error, run } = useAction(reload);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');

  const create = () => run(async () => {
    await peopleApi.createEvader(label.trim(), note.trim());
    setLabel('');
    setNote('');
  });

  return (
    <Panel class="panel--table">
      <h3>Known evaders</h3>
      <p class="muted">
        One card per person who has evaded a ban, with every account they were caught on. Their connections are
        watched, and every new account is checked against how they hold infected buttons at the end of each
        match. <a href={guideUrl('fingerprint')}>How to read a fingerprint alert</a>
      </p>
      {error && <p class="error">{error}</p>}
      {loadError && <Empty>Could not load the known evaders.</Empty>}
      {data && data.people.length === 0 && <Empty>No known evaders.</Empty>}
      {data?.people.map((p) => <EvaderCard key={p.id} p={p} busy={busy} run={run} isAdmin={isAdmin} />)}
      <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={label} placeholder="New person (e.g. dethisa)" aria-label="New person label" maxLength={40}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <input value={note} placeholder="Note" aria-label="Note" maxLength={500}
          onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit" disabled={busy || !label.trim()}>Add person</button>
      </form>
    </Panel>
  );
}

function EvaderCard({ p, busy, run, isAdmin }: { p: KnownEvader; busy: boolean; run: Run; isAdmin: boolean }) {
  return (
    <div class="admin-cluster">
      <p>
        <strong>{p.label}</strong>{p.note && <span class="muted"> {p.note}</span>}{' '}
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => peopleApi.closePerson(p.id), {
            title: `Close the record for ${p.label}?`,
            body: 'Their connections stop being watched and new accounts stop being checked against them. The record is kept.',
            confirmLabel: 'Close record',
          })}>Close record</button>
      </p>
      <ul class="admin-list">
        {p.steam.map((s) => (
          <li key={s.steamid}>
            <a href={fileUrl(s.steamid)}>{s.name}</a> <span class="mono muted">{s.steamid}</span>
            {s.held && <> <span class="chip">on hold</span></>}
            {s.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
            <span class="muted"> {s.how}{s.lastSeen ? `, last seen ${fmtTime(s.lastSeen)}` : ''}</span>{' '}
            <button class="chip" type="button" disabled={busy}
              onClick={() => run(() => peopleApi.removeFromPerson(p.id, 'steam', s.steamid), {
                title: `Take ${s.name} off ${p.label}?`,
                body: 'The connections this account put on the watch list stop being watched.',
                confirmLabel: 'Remove',
              })}>Remove from person</button>
          </li>
        ))}
        {p.discord.map((d) => (
          <li key={d.id}>
            Discord <code>{d.id}</code> <span class="muted">{d.how}</span>{' '}
            <button class="chip" type="button" disabled={busy}
              onClick={() => run(() => peopleApi.removeFromPerson(p.id, 'discord', d.id), {
                title: `Take Discord ${d.id} off ${p.label}?`,
                body: 'The record stops listing this Discord account.',
                confirmLabel: 'Remove',
              })}>Remove Discord</button>
          </li>
        ))}
      </ul>
      {p.connections.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Connection</th><th>Country</th><th>Provider</th><th>Last seen</th></tr></thead>
            <tbody>
              {p.connections.map((c) => (
                <tr key={`${c.steamid}-${c.ipHash}`}>
                  <td class="mono">{c.ipHash.slice(0, 10)}</td>
                  <td>{c.country ? countryName(c.country) : 'unknown'}</td>
                  <td>{c.asOrg ?? 'unknown'}{c.vpn && <> <span class="chip">VPN or hosting</span></>}</td>
                  <td class="muted">{fmtTime(c.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.medians.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Median hold (ticks)</th><th>{p.label}</th><th>Everyone</th></tr></thead>
            <tbody>
              {p.medians.map((m) => (
                <tr key={m.cls}><td>{m.cls}</td><td>{m.person ?? '-'}</td><td>{m.population ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.alerts.length > 0 && (
        <>
          <p><strong>Fingerprint alerts</strong></p>
          <ul class="admin-list">
            {p.alerts.map((a) => (
              <li key={`${a.steamid}-${a.level}`}>
                <a href={fileUrl(a.steamid)}>{a.name}</a>{' '}
                <span class="muted">
                  {LEVEL_LABEL[a.level]}, #{a.rank} nearest, distance {a.distance.toFixed(3)} (limit {a.threshold.toFixed(3)})
                  {a.signs.length > 0 ? `, ${a.signs.map(signText).join(', ')}` : ''}
                  {a.matchId ? `, match #${a.matchId}` : ''}, {fmtTime(a.createdAt)}
                </span>
                {a.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
                {a.dismissed && <> <span class="chip">not them</span></>}
                {!a.dismissed && !a.banned && (
                  <>{' '}<button class="chip" type="button" disabled={busy}
                    onClick={() => run(() => peopleApi.dismissFingerprint(p.id, a.steamid), {
                      title: `${a.name} is not ${p.label}?`,
                      body: `${a.name} is never alerted on or held as ${p.label} again. They are still checked against every other known evader. An open hold is not lifted by this: lift it on the Alts list.`,
                      confirmLabel: 'Not them',
                    })}>Not them</button></>
                )}
                {isAdmin && !a.banned && (
                  <>{' '}<button class="btn btn--danger" type="button" disabled={busy}
                    onClick={() => run(() => peopleApi.banSamePerson(p.id, a.steamid), {
                      title: `Ban ${a.name} as ${p.label}?`,
                      body: `A permanent ban, shown on the public ban list as ban evasion. ${a.name} and their Discord join ${p.label}'s record.`,
                      confirmLabel: 'Ban as same person',
                      danger: true,
                    })}>Ban as same person</button></>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
