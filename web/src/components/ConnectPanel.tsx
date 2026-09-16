import { useEffect, useRef, useState } from 'preact/hooks';

export interface ConnectInfo {
  host: string;
  port: number;
  password: string;
}

/**
 * How the eight actually get into the server.
 *
 * Both paths work, and both had to be corrected on 2026-09-16, the first time
 * a real person tried to join a real backend-driven match:
 *
 *   - the console line read `connect ...; password ...`, which connects first
 *     and sets the password afterwards. Source needs the password set BEFORE
 *     the connect attempt, so it always failed. Reversing it fixed it, and
 *     that order is asserted in the tests so it cannot drift back.
 *   - `steam://connect/host:port/password` does carry the password, but L4D1
 *     drops the player at a prompt with it PRE-FILLED and waits for Enter.
 *     Someone who does not press it sees "Bad password", which reads like the
 *     link is broken when it is one keystroke from working. Hence the note.
 *
 * The console line leads because it needs no such explanation.
 */
export function ConnectPanel({ connect }: { connect: ConnectInfo }) {
  const [copied, setCopied] = useState(false);
  // Password FIRST. Reversing these is the bug described above.
  const line = `password ${connect.password}; connect ${connect.host}:${connect.port}`;

  // Tracked so a page navigation within the 2s "Copied" window can cancel it;
  // otherwise the reset fires setState on an unmounted component.
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimeout.current !== null) clearTimeout(resetTimeout.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      resetTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The line is on screen to select by hand.
    }
  };

  return (
    <div class="connect">
      <p class="connect__how">Paste this into your Left 4 Dead console:</p>
      <div class="connect__line">
        <code>{line}</code>
        <button class="btn btn--block" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="muted connect__alt">
        Or{' '}
        <a href={`steam://connect/${connect.host}:${connect.port}/${connect.password}`}>
          join through Steam
        </a>
        . The password arrives already filled in, but the game waits for you to
        press Enter on it. Not pressing it looks exactly like "Bad password".
      </p>
    </div>
  );
}
