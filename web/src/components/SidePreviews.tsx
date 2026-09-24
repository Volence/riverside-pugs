import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

type Side = 'survivor' | 'infected';
const LABEL: Record<Side, string> = { survivor: 'Survivor', infected: 'Infected' };

/**
 * A shared HUD's preview in its box (`shotClass`, with `children` laid over
 * it, such as the card's badges), and under the box a Survivor / Infected
 * toggle when there is an infected side's preview too. Entries shared before
 * it existed have the survivor one alone and show no toggle. The toggle sits
 * under the picture, not on it, so it never hides a corner of the HUD. The
 * gallery card, the entry page and the share dialog all use it. Only the side
 * on show is in the page, so a gallery loads one image per card.
 */
export function SidePreviews(
  { survivor, infected, alt, imgClass, shotClass, lazy = false, children }: {
    survivor: string;
    infected: string | null | undefined;
    /** The image's alt text; the side is added to it when there are two. */
    alt: string;
    imgClass?: string;
    shotClass?: string;
    lazy?: boolean;
    children?: ComponentChildren;
  },
) {
  const [side, setSide] = useState<Side>('survivor');
  const shown: Side = infected ? side : 'survivor';
  const src = shown === 'infected' ? infected! : survivor;
  return (
    <>
      <div class={shotClass}>
        <img
          class={imgClass} src={src} alt={infected ? `${alt}, ${shown} side` : alt}
          {...(lazy ? { loading: 'lazy' as const } : {})}
        />
        {children}
      </div>
      {infected && (
        <div class="sidepv" role="group" aria-label="Preview side">
          {(['survivor', 'infected'] as const).map((s) => (
            <button
              key={s} type="button" class={`sidepv__btn${shown === s ? ' is-on' : ''}`}
              aria-pressed={shown === s} onClick={() => setSide(s)}
            >
              {LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
