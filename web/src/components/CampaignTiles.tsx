import { campaignName, campaignTint } from '../format';

export interface CampaignTileItem {
  slug: string;
  /** The eyebrow line: match count and last score, or "Unplayed". */
  sub: string;
  /** The campaign in focus (being voted on, or the page's subject). */
  active?: boolean;
  /** Unplayed or unavailable: rendered at reduced opacity. */
  muted?: boolean;
  /** Short marker shown beside the name, e.g. that it is in the vote
   *  rotation. Absent means no marker, not a blank one. */
  badge?: string;
}

/**
 * Campaigns as poster tiles: a dark gradient in the campaign's tint, a heavy
 * inset vignette, an eyebrow and the name in Anton at the bottom left.
 *
 * Pure: the callers decide which campaigns exist and what the eyebrow says.
 * With `onPick` the tiles are buttons (the campaign vote); without it they
 * are plain tiles (the Campaigns page).
 */
export function CampaignTiles(
  { items, onPick }: { items: CampaignTileItem[]; onPick?: (slug: string) => void },
) {
  return (
    <div class="ctiles">
      {items.map((it) => {
        const cls = `ctile${it.active ? ' is-active' : ''}${it.muted ? ' is-muted' : ''}`;
        const style = { '--campaign': campaignTint(it.slug) } as Record<string, string>;
        const body = (
          <>
            <span class="ctile__sub eyebrow">{it.sub}</span>
            <span class="ctile__name">{campaignName(it.slug)}</span>
            {it.badge && <span class="ctile__badge">{it.badge}</span>}
          </>
        );
        return onPick
          ? <button type="button" class={cls} style={style} key={it.slug} onClick={() => onPick(it.slug)}>{body}</button>
          : <div class={cls} style={style} key={it.slug}>{body}</div>;
      })}
    </div>
  );
}
