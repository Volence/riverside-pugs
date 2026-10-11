import { logoUrl } from '../api';

/** A team's logo, or its tag in a box when it has none. */
export function TeamBadge({ tag, logoKey, size = 40 }: { tag: string; logoKey: string | null; size?: number }) {
  return logoKey
    ? <img class="teambadge" src={logoUrl(logoKey)} alt="" width={size} height={size} />
    : <span class="teambadge teambadge--tag" aria-hidden="true">{tag}</span>;
}
