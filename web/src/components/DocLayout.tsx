import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface DocSection { id: string; label: string }

/**
 * The shared help-page frame (How to play, the consistency help, custom
 * campaigns, patch notes): an "On this page" index beside the panels. On a
 * desktop the index is a sticky column on the left that marks the section
 * you are reading; on a phone it folds into a row of links above the first
 * panel, the way the How to play index always was.
 *
 * Each section id must be the id of a panel (or other element) inside
 * `children`, so the links and the highlight both find it.
 */
export function DocLayout({ sections, label = 'On this page', children }: {
  sections: DocSection[]; label?: string; children: ComponentChildren;
}) {
  const current = useCurrentSection(sections);
  const indexed = sections.length > 1;
  return (
    <div class={indexed ? 'doc' : 'doc doc--solo'}>
      {indexed && (
        <nav class="doc__toc" aria-label={label}>
          <p class="doc__toclabel">{label}</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={current === s.id ? 'location' : undefined}>{s.label}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div class="doc__body">{children}</div>
    </div>
  );
}

/** The section nearest the top of the screen, for the index highlight. A
 *  convenience: without IntersectionObserver (tests, very old browsers) the
 *  index simply has no highlight. */
function useCurrentSection(sections: DocSection[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const key = sections.map((s) => s.id).join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = sections.find((s) => seen.get(s.id));
      if (first) setCurrent(first.id);
    }, { rootMargin: '-15% 0px -60% 0px' });
    // Sections that load later (a patch panel, the campaign list) are picked
    // up by looking again once the page has settled.
    const observe = () => {
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && !seen.has(s.id)) { seen.set(s.id, false); io.observe(el); }
      }
    };
    observe();
    const t = window.setTimeout(observe, 1500);
    return () => { window.clearTimeout(t); io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return current;
}
