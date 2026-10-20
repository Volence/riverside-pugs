import { useEffect, useState } from 'preact/hooks';
import type { WrappedSeason } from '../api';
import { freshWrapped, loadWrappedSeasons } from '../wrapped';

/** "Your Season 0 Wrapped is here", under the season banner on the home page
 *  for the first 30 days after a season's Wrapped is frozen. Nothing at all
 *  before the first one exists, or once it is old news. */
export function WrappedStrip({ path }: { path: string }) {
  const [fresh, setFresh] = useState<WrappedSeason | null>(null);
  const home = path === '/';
  useEffect(() => {
    if (!home) return;
    let live = true;
    void loadWrappedSeasons().then((list) => { if (live) setFresh(freshWrapped(list)); });
    return () => { live = false; };
  }, [home]);
  if (!home || !fresh) return null;
  return (
    <aside class="wrapped-strip" aria-label="Season Wrapped">
      <a href="/wrapped">{`Your ${fresh.name} Wrapped is here`}</a>
    </aside>
  );
}
