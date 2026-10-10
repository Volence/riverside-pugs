import { useState } from 'preact/hooks';
import { adminApi, type AbandonRecord } from '../../api';
import { fmtTime, type Run } from './useAction';

/** What one abandon did, for staff: "#N decided, Team A won" or "#N aborted". */
export function abandonOutcome(a: Pick<AbandonRecord, 'matchId' | 'decided'>): string {
  return a.decided ? `decided, Team ${a.decided.toUpperCase()} won and it was rated` : 'aborted, nobody else rated';
}

/** " · rating loss restored by X: why" once staff gave the loss back. */
export function restoredText(a: Pick<AbandonRecord, 'restoredAt' | 'restoredByName' | 'restoreReason'>): string {
  if (!a.restoredAt) return '';
  return ` · rating loss restored ${fmtTime(a.restoredAt)}${a.restoredByName ? ` by ${a.restoredByName}` : ''}${a.restoreReason ? `: ${a.restoreReason}` : ''}`;
}

/**
 * Restore rating (owner ruling 2026-10-10): give an abandoner back the
 * rating loss of one abandon, with a reason. Admin only; the caller decides
 * whether to show it. Lifting the ban does not do this by itself.
 */
export function RestoreRating({ matchId, steamid, who, busy, run }: { matchId: number; steamid: string; who: string; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button class="chip" type="button" disabled={busy} onClick={() => { setOpen(true); setReason(''); }}>
        Restore rating
      </button>
    );
  }
  return (
    <form class="admin-form" onSubmit={(e) => {
      e.preventDefault();
      void run(() => adminApi.restoreAbandonRating(matchId, steamid, reason.trim()), {
        title: `Restore ${who}'s rating from match #${matchId}?`,
        body: 'The rating loss for abandoning it is taken out and the season\'s ratings are recomputed. The ban and the match result stay as they are.',
        confirmLabel: 'Restore rating',
      }).then(() => { setOpen(false); setReason(''); });
    }}>
      <input value={reason} placeholder="Why it was not their fault" aria-label="Restore reason"
        onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      <button class="btn" type="submit" disabled={busy || !reason.trim()}>Restore</button>
      <button class="chip" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
