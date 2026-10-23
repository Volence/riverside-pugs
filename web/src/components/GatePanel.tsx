import type { ComponentChildren } from 'preact';

/**
 * The card a page shows when the viewer cannot use it yet: signed out, the
 * feature not open, or a page for a role they do not have. It says what the
 * page is for, lists what they would find there, and offers the one action
 * that gets them in (Sign in through Steam, back to this page) plus a link or
 * two to somewhere they can go now.
 */
export function GatePanel({ title, lead, points, signInNext, links, children }: {
  title: string;
  lead: string;
  points?: string[];
  /** Path to come back to after Steam sign-in; omit for no sign-in button. */
  signInNext?: string;
  links?: { href: string; label: string }[];
  children?: ComponentChildren;
}) {
  return (
    <section class="gate" aria-label={title}>
      <div class="gate__body">
        <h3 class="gate__title">{title}</h3>
        <p class="gate__lead">{lead}</p>
        {points && points.length > 0 && (
          <ul class="gate__points">
            {points.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        {children}
      </div>
      {(signInNext !== undefined || (links && links.length > 0)) && (
        <div class="gate__actions">
          {/* target _top: /auth/steam is a backend route, see Play.tsx. */}
          {signInNext !== undefined && (
            <a class="btn" href={`/auth/steam?next=${encodeURIComponent(signInNext)}`} target="_top" rel="noopener">Sign in through Steam</a>
          )}
          {links?.map((l) => <a key={l.href} class="btn btn--ghost" href={l.href}>{l.label}</a>)}
        </div>
      )}
    </section>
  );
}
