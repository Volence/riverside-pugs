import type { SocialLink } from '../api';

/** A player's off-site links.
 *
 *  Every href here was built by the server from a per-platform template. This
 *  component constructs no URL except the Twitch one, whose only input is a
 *  login the server validated through OAuth, and which is encoded anyway. */
export function SocialChips(
  { links, twitchName }: { links?: SocialLink[]; twitchName?: string | null },
) {
  // Defaulted rather than required, because during a deploy a freshly loaded
  // bundle can talk to the previous server for a moment, and a profile page
  // that throws is a worse outcome than one missing its chips.
  const rows = links ?? [];
  if (!rows.length && !twitchName) return null;
  return (
    <div class="socialchips">
      {twitchName && (
        <a
          class="socialchip socialchip--twitch"
          href={`https://www.twitch.tv/${encodeURIComponent(twitchName)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="socialchip__label">Twitch</span>
          <span class="socialchip__handle">{twitchName}</span>
        </a>
      )}
      {rows.map((l) => (
        <a
          key={l.platform}
          class="socialchip"
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="socialchip__label">{l.label}</span>
          <span class="socialchip__handle">{l.handle}</span>
        </a>
      ))}
    </div>
  );
}
