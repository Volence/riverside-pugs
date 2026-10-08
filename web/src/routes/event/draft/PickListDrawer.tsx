// web/src/routes/event/draft/PickListDrawer.tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, eventsApi, type DraftCardsView } from '../../../api';

/** The captain's ordered pick list (staff read it on the desk) (drafts plan D2b1
 *  Rulings 1, 2, 13): Up, Down, Remove, Add and an explicit Save, so one
 *  reorder is not one server write. available is the room's free pool: a
 *  player picked since (or no longer in the pool) leaves the list, the Add
 *  choices and the save (controller ruling, Task 9). */
export function PickListDrawer({ slug, available, onClose }: { slug: string; available?: string[]; onClose: () => void }) {
  const [cards, setCards] = useState<DraftCardsView | null>(null);
  const [list, setList] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([eventsApi.draftCards(slug), eventsApi.draftList(slug)]).then(
      ([c, l]) => { setCards(c); setList(l.list); },
      () => setProblem('Could not load your pick list.'),
    );
  }, [slug]);

  const free = available ? new Set(available) : null;
  const isFree = (s: string) => free === null || free.has(s);
  const shown = list.filter(isFree);
  const nameOf = (s: string) => cards?.cards.find((c) => c.steamid === s)?.name ?? s;
  const edit = (fn: (l: string[]) => string[]) => { setSaved(null); setList((l) => fn(l.filter(isFree))); };
  const move = (i: number, d: -1 | 1) => edit((l) => {
    const j = i + d;
    if (j < 0 || j >= l.length) return l;
    const n = [...l];
    [n[i], n[j]] = [n[j]!, n[i]!];
    return n;
  });
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await eventsApi.saveDraftList(slug, shown);
      setList(r.list);
      setSaved('Saved.');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const rest = (cards?.cards ?? []).filter((c) => isFree(c.steamid) && !shown.includes(c.steamid)).sort((a, b) => b.sr - a.sr);

  return (
    <aside class="picklist" aria-label="My pick list">
      <header class="picklist__head">
        <h3>My pick list</h3>
        <button class="btn btn--ghost btn--sm" type="button" onClick={onClose}>Close</button>
      </header>
      <p class="muted">Used if captains pick live: when your turn comes and you are away, or your clock runs out, the site takes the highest player on this list who is still free. With no list, it takes the highest SR.</p>
      {problem && <p class="error" role="alert">{problem}</p>}
      {shown.length === 0 ? <p class="empty">Your list is empty.</p> : (
        <ol class="picklist__rows">
          {shown.map((s, i) => (
            <li key={s} class="picklist__row">
              <span class="picklist__name">{`${i + 1}. ${nameOf(s)}`}</span>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${nameOf(s)} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Move ${nameOf(s)} down`} disabled={i === shown.length - 1} onClick={() => move(i, 1)}>Down</button>
              <button class="btn btn--ghost btn--sm" type="button" aria-label={`Remove ${nameOf(s)}`} onClick={() => edit((l) => l.filter((x) => x !== s))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 && (
        <label class="picklist__add">
          Add a player
          <select value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) edit((l) => (l.includes(v) ? l : [...l, v])); }}>
            <option value="">Choose...</option>
            {rest.map((c) => <option key={c.steamid} value={c.steamid}>{`${c.name} (SR ${c.sr})`}</option>)}
          </select>
        </label>
      )}
      <div class="inlinerow">
        <button class="btn" type="button" disabled={busy || cards === null} onClick={() => void save()}>Save list</button>
        {saved && <span class="muted">{saved}</span>}
      </div>
    </aside>
  );
}
