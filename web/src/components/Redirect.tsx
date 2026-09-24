import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

/** Send the browser somewhere else and render nothing. For a URL that has
 *  moved but is still in bookmarks and in old Discord posts. */
export function Redirect({ to }: { to: string }) {
  const { route } = useLocation();
  useEffect(() => { route(to, true); }, [to]);
  return null;
}
