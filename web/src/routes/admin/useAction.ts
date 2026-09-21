import { useState } from 'preact/hooks';
import { ApiError } from '../../api';
import { confirm, type ConfirmOptions } from '../../components/Confirm';

/** What `useAction` hands back as `run`.
 *
 *  Exported because four components take it as a prop, and each had its own
 *  hand-copied signature: when the confirm argument widened to accept an
 *  options object they all silently disagreed with the hook until the compiler
 *  caught it. One definition, imported. */
export type Run = (fn: () => Promise<unknown>, ask?: string | ConfirmOptions) => Promise<void>;

/** Run an admin mutation: busy flag, the server's own error message, then a
 *  reload so the page shows what actually happened. */
export function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run: Run = async (fn, ask) => {
    // The app's own dialog, not window.confirm. A string still works and
    // becomes the heading; pass an object to get a body and a named button.
    if (ask && !(await confirm(ask))) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { busy, error, run };
}

export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};
