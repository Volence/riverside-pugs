/** Nav sections that group several pages under one item, the way HUD does
 *  (components/HudTabs.tsx): the nav shows the section once, and a strip at
 *  the top of each page moves between its pages. Each tab is a real link to
 *  its route, so deep links and the back button keep working.
 *
 *  A tab is [key, href, label, also?]: `also` are path prefixes that count as
 *  that tab too (a news post under News, Game values under the change log). */
type Tab = readonly [key: string, href: string, label: string, also?: readonly string[]];

export interface Section {
  /** The landmark's accessible name. */
  label: string;
  tabs: readonly Tab[];
}

/** Stats: what has been played. Leaderboard stays its own nav item (it is
 *  the page people open most), and Custom stays apart too: it is how to
 *  install custom campaigns, not numbers about them. */
export const STATS_SECTION: Section = {
  label: 'Stats',
  tabs: [
    ['matches', '/matches', 'Matches'],
    ['campaigns', '/maps', 'Campaigns'],
  ],
};

/** News: every post, the hand-written patch notes alone, and the change log
 *  the balance tracker keeps (with Game values under it). */
export const NEWS_SECTION: Section = {
  label: 'News',
  tabs: [
    ['news', '/news', 'News', ['/news/']],
    ['patch', '/patch-notes', 'Patch notes'],
    ['changelog', '/balance', 'Change log', ['/balance/']],
  ],
};

/** Which tab of the section a path belongs to, or null outside it. */
export function sectionTabFor(section: Section, path: string): string | null {
  for (const [key, href, , also = []] of section.tabs) {
    if (path === href || also.some((p) => path.startsWith(p))) return key;
  }
  return null;
}

export function SectionTabs({ section, active }: { section: Section; active: string }) {
  return (
    <nav class="tabs sectiontabs" aria-label={section.label}>
      {section.tabs.map(([key, href, label]) => (
        <a
          key={key}
          href={href}
          class={`tabs__tab${key === active ? ' is-active' : ''}`}
          aria-current={key === active ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
