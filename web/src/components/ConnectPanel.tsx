import { useEffect, useRef, useState } from 'preact/hooks';

export interface ConnectInfo {
  host: string;
  port: number;
  password: string;
}

/**
 * How the eight actually get into the server.
 *
 * Both a steam:// link and the console line on purpose: sv_password means this
 * is the only door in, so a protocol handler that misbehaves on one person's
 * machine must not be a locked door.
 */
export function ConnectPanel({ connect }: { connect: ConnectInfo }) {
  const [copied, setCopied] = useState(false);
  const line = `connect ${connect.host}:${connect.port}; password ${connect.password}`;

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
      <a class="btn btn--block" href={`steam://connect/${connect.host}:${connect.port}/${connect.password}`}>
        Join server
      </a>
      <p class="muted">or paste into console:</p>
      <div class="connect__line">
        <code>{line}</code>
        <button class="btn btn--ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
