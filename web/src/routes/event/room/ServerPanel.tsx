import { useState } from 'preact/hooks';
import type { MatchRoomView } from '../../../api';
import { clockText } from './roomText';

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** The booked server: waiting, setting up, ready (the connect line for those
 *  who may see it, who is on, the grace), or closed. */
export function ServerPanel({ v, now }: { v: MatchRoomView; now: number }) {
  const s = v.server;
  const [copied, setCopied] = useState(false);
  const aName = v.a?.name ?? 'TBD';
  const bName = v.b?.name ?? 'TBD';
  if (!s) return <p>Booking a server.</p>;
  if (s.state === 'waiting') return <p>{`Waiting for a server since ${hhmm(s.since)}. No box is free in the region right now; staff are told after 10 minutes.`}</p>;
  if (s.state === 'setup') return <p>{`Setting up ${s.name ?? 'the server'}.`}</p>;
  if (s.state === 'ended') return <p>The server is closed.</p>;
  const line = s.connect ? `connect ${s.connect.host}:${s.connect.port}; password ${s.connect.password}` : null;
  const copy = async () => {
    if (!line) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(line);
      } else {
        const ta = document.createElement('textarea');
        ta.value = line;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const grace = s.graceEndsAt ? Date.parse(s.graceEndsAt) - now : null;
  return (
    <div class="roomserver">
      {line ? (
        <p class="roomserver__connect">
          <code>{line}</code>
          <button class="btn btn--sm" type="button" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</button>
        </p>
      ) : <p>{`The teams are connecting to ${s.name ?? 'the server'}.`}</p>}
      {s.present && <p>{`On the server: ${aName} ${s.present.a} of 4, ${bName} ${s.present.b} of 4`}</p>}
      {grace !== null && <p class="roomserver__grace">{`Both teams need four on the server within ${clockText(grace)}, or the team that is short forfeits.`}</p>}
    </div>
  );
}
