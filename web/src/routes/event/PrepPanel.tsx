import { useEffect, useState } from 'preact/hooks';
import { ApiError, eventsApi, type PrefsView } from '../../api';
import { Panel } from '../../components/bits';
import { fullOrder, moveIn } from './prepOrder';

/** Plan T3a: what the match room's timers act from when a captain runs
 *  out of time, set up ahead of the match on the event page. */
export function PrepPanel({ slug, entryId, teamName }: { slug: string; entryId: number; teamName: string }) {
  const [p, setP] = useState<PrefsView | null>(null);
  const [four, setFour] = useState<string[]>([]);
  const [side, setSide] = useState<'' | 'survivors' | 'infected'>('');
  const [orders, setOrders] = useState<Record<number, string[]>>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    eventsApi.prefs(slug, entryId, ctl.signal).then((x) => {
      setP(x);
      setFour(x.defaultFour ?? []);
      setSide(x.side ?? '');
      setOrders(Object.fromEntries(x.stages.map((s) => [s.stageId, fullOrder(s.pool.map((c) => c.slug), s.order)])));
    }, () => { /* the panel just stays hidden */ });
    return () => ctl.abort();
  }, [slug, entryId]);

  if (!p) return null;
  const toggle = (s: string) => setFour((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]));
  const fourOk = four.length === 0 || four.length === 4;
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await eventsApi.savePrefs(slug, entryId, {
        defaultFour: four.length === 4 ? p.roster.map((r) => r.steamid).filter((s) => four.includes(s)) : null,
        side: side === '' ? null : side,
        campaigns: Object.fromEntries(Object.entries(orders)),
      });
      setNote({ ok: true, text: 'Saved.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (stageId: number, slugName: string) => p.stages.find((s) => s.stageId === stageId)?.pool.find((c) => c.slug === slugName)?.name ?? slugName;

  return (
    <Panel class="prep">
      <h3>{`Match prep: ${teamName}`}</h3>
      <section>
        <h4>Default four</h4>
        <p class="muted">Locked for you when your lineup timer runs out. Pick exactly 4, or none.</p>
        <div class="admin-checks">
          {p.roster.map((r) => (
            <label key={r.steamid}><input type="checkbox" aria-label={r.name} checked={four.includes(r.steamid)} onChange={() => toggle(r.steamid)} /> {r.name}</label>
          ))}
        </div>
      </section>
      <section>
        <h4>Side</h4>
        <p class="muted">Used when your side-choice timer runs out.</p>
        <select aria-label="Side" value={side} onChange={(e) => setSide((e.target as HTMLSelectElement).value as typeof side)}>
          <option value="">No preference (survivors first)</option>
          <option value="survivors">Survivors first</option>
          <option value="infected">Infected first</option>
        </select>
      </section>
      {p.stages.map((s) => (
        <section key={s.stageId}>
          <h4>{`Stage ${s.ordinal}: campaign order`}</h4>
          <p class="muted">When a ban timer runs out, the room bans your lowest campaign; when a pick timer runs out, it picks your highest.</p>
          <ol class="prep__order">
            {(orders[s.stageId] ?? []).map((slugName, i, list) => {
              const name = nameOf(s.stageId, slugName);
              const move = (by: -1 | 1) => setOrders((o) => ({ ...o, [s.stageId]: moveIn(list, i, by) }));
              return (
                <li key={slugName}>
                  <span>{name}</span>
                  <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(-1)}>Up</button>
                  <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => move(1)}>Down</button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {note && <p class={note.ok ? 'muted' : 'error'} role={note.ok ? undefined : 'alert'}>{note.text}</p>}
      <button class="btn" type="button" disabled={busy || !fourOk} onClick={() => { void save(); }}>Save match prep</button>
    </Panel>
  );
}
