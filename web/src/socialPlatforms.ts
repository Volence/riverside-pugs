/** Labels and placeholders for the profile editor.
 *
 *  Deliberately carries no patterns and no URL builders. The server validates
 *  handles and the server builds every URL; duplicating either here would
 *  create a second answer to a question that must have exactly one, and the
 *  two would drift. The keys are pinned against the server's list by a test,
 *  so this file cannot silently fall out of step about which platforms exist. */
export const WEB_PLATFORMS = [
  { key: 'youtube', label: 'YouTube', placeholder: '@handle' },
  { key: 'x', label: 'X', placeholder: '@handle' },
  { key: 'bluesky', label: 'Bluesky', placeholder: 'name.bsky.social' },
  { key: 'tiktok', label: 'TikTok', placeholder: '@handle' },
] as const;
