import { useState } from 'preact/hooks';
import { peopleApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';

/** Notes, and the "looked at" that takes this file off Needs a look. Both
 *  are open to moderators: they are the two things a moderator does here. */
export function NotesSection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const [note, setNote] = useState('');
  const [review, setReview] = useState('');

  return (
    <Panel class="file-section">
      <h3 id="notes">Notes</h3>
      {can('note') && (
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => peopleApi.note(d.steamid, note.trim())).then(() => setNote(''));
        }}>
          <input value={note} placeholder="Private staff note" aria-label="Note"
            onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !note.trim()}>Add note</button>
        </form>
      )}
      {can('looked_at') && (
        <div class="admin-form">
          <input value={review} placeholder="What you found (optional)" aria-label="Review note"
            onInput={(e) => setReview((e.target as HTMLInputElement).value)} />
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => peopleApi.lookedAt(d.steamid, review.trim())).then(() => setReview(''))}>
            Looked at this
          </button>
          <span class="muted">
            Takes this file off Needs a look until something new arrives.
          </span>
        </div>
      )}
      {d.sections.notes.length === 0 ? <p class="muted">No notes.</p> : (
        <ul class="admin-list">
          {d.sections.notes.map((n) => (
            <li key={n.id}>
              <span class="muted">{n.authorName ?? n.authorId}, {fmtTime(n.createdAt)}:</span> {n.text}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
