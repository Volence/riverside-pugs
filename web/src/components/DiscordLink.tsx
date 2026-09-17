import { useState } from 'preact/hooks';
import { api, type Me } from '../api';

/** Where a backend-only route must be reached by a full navigation. preact-iso
 *  intercepts same-origin clicks unless target is set (see SignIn in Play). */
const BACKEND = { target: '_top', rel: 'noopener' } as const;

/** Connect or disconnect Discord, for the signed-in player's own profile. */
export function DiscordLinkCard({ me, onChange }: { me: Me; onChange?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!me.discordEnabled) return null;

  const unlink = async () => {
    setBusy(true);
    try {
      await api.unlinkDiscord();
      onChange?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="discordlink">
      <span class="eyebrow">Discord</span>
      {me.discord ? (
        <>
          <span class="discordlink__name">{me.discord.name}</span>
          <button class="btn btn--ghost" onClick={unlink} disabled={busy}>Disconnect</button>
        </>
      ) : (
        <>
          <span class="muted">Not connected. Link it to queue and ready up from Discord.</span>
          <a class="btn" href="/auth/discord" {...BACKEND}>Connect Discord</a>
        </>
      )}
    </div>
  );
}
