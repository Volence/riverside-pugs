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
      <h3 id="notes">Notes <span class="file-count">{d.sections.notes.length}</span></h3>
      {can('note') && (
        <form class="file-inline" onSubmit={(e) => {
          e.preventDefault();
          void run(() => peopleApi.note(d.steamid, note.trim())).then(() => setNote(''));
        }}>
          <input value={note} placeholder="Private staff note" aria-label="Note"
            onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !note.trim()}>Add note</button>
        </form>
      )}
      {d.sections.notes.length === 0 ? <p class="muted">No notes.</p> : (
        <ul class="file-notes">
          {d.sections.notes.map((n) => (
            <li key={n.id}>
              <span class="file-notes__who">{n.authorName ?? n.authorId} · {fmtTime(n.createdAt)}</span>
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {can('looked_at') && (
        <div class="file-looked">
          <h4>Looked at this file</h4>
          <p class="file-help">Takes this file off Needs a look until something new arrives.</p>
          <div class="file-inline">
            <input value={review} placeholder="What you found (optional)" aria-label="Review note"
              onInput={(e) => setReview((e.target as HTMLInputElement).value)} />
            <button class="chip" type="button" disabled={busy}
              onClick={() => run(() => peopleApi.lookedAt(d.steamid, review.trim())).then(() => setReview(''))}>
              Looked at this
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
