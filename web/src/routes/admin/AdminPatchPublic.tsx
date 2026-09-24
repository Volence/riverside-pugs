import { useState } from 'preact/hooks';
import { adminApi, type PatchDetail, type PatchSummary, type PublicEntry } from '../../api';
import { PatchEntryView } from '../balance/PatchEntryView';
import { fmtTime, type Run } from './useAction';

/** The "Public page" block of an open patch: whether it is public, Publish or
 *  Unpublish, and a Preview of the public entry. Render it with `key` set to
 *  the patch id so opening another patch clears the preview. */
export function AdminPatchPublic({ patch, listRow, run, busy }: {
  patch: PatchDetail; listRow: PatchSummary | undefined; run: Run; busy: boolean;
}) {
  const [preview, setPreview] = useState<PublicEntry | null>(null);
  // The open detail was fetched before any publish/unpublish, so its own
  // publishedAt can be stale; the reloaded list row is the source of truth
  // once it exists, and patch.publishedAt is only a fallback until it does.
  const publishedAt = listRow ? listRow.publishedAt : patch.publishedAt;
  const isPublic = !!publishedAt;
  return (
    <div class="admin-preview">
      <h4>Public page</h4>
      <p>{isPublic ? `Public since ${fmtTime(publishedAt)}.` : 'Not public.'}</p>
      <div class="admin-actions">
        <button
          class="btn"
          type="button"
          disabled={busy}
          onClick={() => void run(() => adminApi.publishBalancePatch(patch.id, !isPublic))}
        >
          {isPublic ? 'Unpublish' : 'Publish'}
        </button>
        <button
          class="btn"
          type="button"
          disabled={busy}
          onClick={() => void run(() => adminApi.balancePublicPreview(patch.id).then(setPreview))}
        >
          Preview
        </button>
      </div>
      {preview && (
        <div class="admin-preview__result">
          <h4>Preview of the public entry</h4>
          <PatchEntryView entry={preview} />
        </div>
      )}
      <p class="muted">Publishing needs a name, notes and at least one counted round.</p>
    </div>
  );
}
