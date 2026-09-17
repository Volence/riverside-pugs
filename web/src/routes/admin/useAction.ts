import { useState } from 'preact/hooks';
import { ApiError } from '../../api';

/** Run an admin mutation: busy flag, the server's own error message, then a
 *  reload so the page shows what actually happened. */
export function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
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
