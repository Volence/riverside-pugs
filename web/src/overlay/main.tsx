import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { setCampaignNames } from '../format';
import { useFeed } from './useFeed';
import { Overlay, setOverlayKey } from './Scenes';
import { SCENES, LAYERS, type OverlayKey } from '../../../src/cast/types';
import './overlay.css';
import './overlayPage.css';

/**
 * OBS browser source entry (caster studio). /overlay/<scene>?k=<key>.
 * Renders one scene or layer at 1920x1080 on a transparent page; `program`
 * follows whatever scene the producer picked in the panel.
 */

function sceneFromPath(path: string): OverlayKey | null {
  const m = /^\/overlay\/([a-z]+)\/?$/.exec(path);
  const k = m?.[1];
  if (!k) return null;
  if (k === 'program' || (SCENES as readonly string[]).includes(k) || (LAYERS as readonly string[]).includes(k)) return k as OverlayKey;
  return null;
}

function App() {
  const params = new URLSearchParams(location.search);
  const key = params.get('k') ?? '';
  setOverlayKey(key);
  const which = sceneFromPath(location.pathname);
  const state = useFeed(which ? key : '');
  // A clock for countdowns and callout expiry, ticking on its own so they
  // move smoothly between polls.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  if (!which) return <p class="ov-refused">Unknown overlay. Copy the link from the caster studio.</p>;
  if (state.kind === 'loading') return null;
  if (state.kind === 'refused') return <p class="ov-refused">{state.error || 'This overlay link is not valid.'}</p>;
  const { feed, skewMs } = state;
  return <Overlay which={which} feed={feed} now={now + skewMs} />;
}

// Display names for custom campaigns, as the site registers them. Not awaited:
// a slug is an acceptable fallback on air for a second.
fetch('/api/campaigns/names').then((r) => (r.ok ? r.json() : null)).then((r: { names?: Record<string, string> } | null) => {
  if (r?.names) setCampaignNames(r.names);
}).catch(() => { /* slugs it is */ });

render(<App />, document.getElementById('overlay')!);
