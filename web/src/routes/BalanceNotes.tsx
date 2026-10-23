import { useEffect } from 'preact/hooks';
import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { DocLayout } from '../components/DocLayout';
import { PatchEntryView } from './balance/PatchEntryView';

/** Fetches and renders one patch's full entry, independently of its
 *  siblings, so a slow or failing patch never blocks the rest of the list. */
function PatchPanel({ id }: { id: number }) {
  const { data, error } = useFetch((s) => api.balancePatch(id, s), [id]);
  // A link to #patch-N arrives before this panel exists, so the browser's own
  // jump lands at the top: jump once the entry is on the page.
  useEffect(() => {
    if (data && window.location.hash === `#patch-${id}`) document.getElementById(`patch-${id}`)?.scrollIntoView();
  }, [data, id]);
  return (
    // Anchored so the Game values page can link a change to its patch.
    <Panel id={`patch-${id}`}>
      {error ? (
        <Empty>Could not load this patch.</Empty>
      ) : !data ? (
        <Empty>Loading…</Empty>
      ) : (
        <PatchEntryView entry={data} />
      )}
    </Panel>
  );
}

/** The public balance patch notes page: every published patch, newest
 *  first, with its notes, its tracked setting changes, and what the numbers
 *  measured afterwards. */
export function BalanceNotes() {
  const { data, error } = useFetch((s) => api.balancePatches(s), []);

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Balance" title="Patch notes">
        <p class="patch-lede">
          Each balance patch, why it was made, and what the numbers measured afterwards. A change
          is only called a measured change when it is larger than normal game-to-game variation.
        </p>
        <p class="patch-lede muted">
          A measured change is a difference between the games played before and after a patch. It
          can also come from who was playing and which maps were played, so read it next to the notes.
        </p>
        <p class="patch-lede__link"><a class="btn btn--ghost btn--sm" href="/balance/values">Game values</a> <span>Every balance setting as it is now, next to vanilla.</span></p>
      </PageHeader>

      {error ? (
        <Empty>Could not load patch notes.</Empty>
      ) : !data ? (
        <Empty>Loading…</Empty>
      ) : data.patches.length === 0 ? (
        <Empty>No patch notes yet.</Empty>
      ) : (
        <DocLayout label="Patches" sections={data.patches.map((p) => ({ id: `patch-${p.id}`, label: p.name }))}>
          {data.patches.map((p) => <PatchPanel key={p.id} id={p.id} />)}
        </DocLayout>
      )}
    </div>
  );
}
