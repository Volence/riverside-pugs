import { api } from '../api';
import { useFetch } from '../hooks/useFetch';

/** The HUD section's routes, in tab order. The nav shows the section as one
 *  item; this strip, at the top of each of the three pages, moves between
 *  them. Each tab is a real link to its route, so deep links, share links and
 *  the back button all keep working. */
export type HudTab = 'hud' | 'crosshair' | 'community';

const TABS: readonly (readonly [HudTab, string, string])[] = [
  ['hud', '/hud', 'HUD editor'],
  ['crosshair', '/crosshair', 'Crosshair'],
  ['community', '/community', 'Community'],
];

/** Which tab a path belongs to, or null outside the section. A shared entry
 *  (/community/:id) counts as Community. */
export function hudTabFor(path: string): HudTab | null {
  for (const [key, href] of TABS) {
    if (path === href || path.startsWith(`${href}/`)) return key;
  }
  return null;
}

export function HudTabs({ active }: { active: HudTab }) {
  return (
    <nav class="tabs hudtabs" aria-label="HUD tools">
      {TABS.map(([key, href, label]) => (
        <a
          key={key}
          href={href}
          class={`tabs__tab${key === active ? ' is-active' : ''}`}
          aria-current={key === active ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
      <FeedbackLink />
    </nav>
  );
}

/** The HUD tools are new: a way to tell us what works, at the strip's right end. Nothing while the site has no Discord invite. */
function FeedbackLink() {
  const { data: site } = useFetch((sig) => api.site(sig), []);
  if (!site?.discordInviteUrl) return null;
  return (
    <a class="hudtabs__feedback" href={site.discordInviteUrl} target="_blank" rel="noopener noreferrer">
      New and in testing: send feedback on Discord
    </a>
  );
}
