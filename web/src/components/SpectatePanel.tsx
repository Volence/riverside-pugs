import { useState } from 'preact/hooks';
import type { SpectateInfo } from '../api';

/**
 * Watch a live match on SourceTV.
 *
 * Public: the broadcast runs on a delay (30 seconds today), which is what stops
 * a spectator relaying anything useful to a player, so the connect details do
 * not need hiding. Collapsed by default so it never competes with the match.
 */
export function SpectatePanel({ spectate }: { spectate: SpectateInfo }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const line = spectate.password
    ? `password ${spectate.password}; connect ${spectate.host}:${spectate.port}`
    : `connect ${spectate.host}:${spectate.port}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied; the line is on screen to copy by hand */
    }
  };

  if (!open) {
    return (
      <button class="chip spectate__open" type="button" onClick={() => setOpen(true)}>
        Watch on SourceTV
      </button>
    );
  }

  return (
    <div class="connect spectate">
      <p class="connect__how">
        Watch in game. The broadcast is {spectate.delay} seconds behind, so you cannot
        use it to help a team.
      </p>
      <div class="connect__line">
        <code>{line}</code>
        <button class="btn btn--block" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="muted connect__alt">
        Or <a href={`steam://connect/${spectate.host}:${spectate.port}/${spectate.password}`}>join through Steam</a>.
        Spectator slots are limited, so it can be full.
        {' '}<button class="chip" type="button" onClick={() => setOpen(false)}>Hide</button>
      </p>
    </div>
  );
}
