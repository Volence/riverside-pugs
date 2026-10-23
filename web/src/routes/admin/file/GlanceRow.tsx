import type { PlayerFileData, TimelineSource } from '../../../api';
import { fmtTime } from '../useAction';

/** One word per source, in the panel's own vocabulary. The badge is the same
 *  neutral shape for every source on purpose: colouring "LilAC" differently
 *  from "note" would read as a severity, and none of these is a verdict. */
export const SOURCE_LABEL: Record<TimelineSource, string> = {
  input: 'Input timing',
  lilac: 'Little Anti-Cheat',
  analyzer: 'Replay analyzer',
  drop: 'Connect drop',
  ticket: 'Ticket',
  penalty: 'Penalty',
  ban: 'Ban',
  note: 'Note',
  steam: 'Steam',
  discord_link: 'Discord',
  cvar: 'Client setting',
  conduct: 'Chat and names',
  spray: 'Crash spray',
  aim: 'Aim rules',
};

export function SourceBadge({ source }: { source: TimelineSource }) {
  return <span class="source-badge">{SOURCE_LABEL[source]}</span>;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** One count, as a tile that jumps to the section holding the rows behind
 *  it. A zero stays quiet; anything else reads at full strength. */
function Tile({ n, label, href }: { n: number; label: string; href: string }) {
  return (
    <a class={`file-tile${n === 0 ? ' is-zero' : ''}`} href={href}>
      <span class="file-tile__n">{n}</span>
      <span class="file-tile__label">{label}</span>
    </a>
  );
}

/** Is there anything here. Read before anything else on the page: the four
 *  counts, then what the last 30 days recorded, as neutral chips. */
export function GlanceRow({ d }: { d: PlayerFileData }) {
  const g = d.glance;
  return (
    <section class="file-glance" aria-label="At a glance">
      <div class="file-tiles">
        <Tile n={g.openTickets} label={plural(g.openTickets, 'open ticket', 'open tickets')} href="#tickets" />
        <Tile n={g.bans} label={plural(g.bans, 'ban on record', 'bans on record')} href="#standing" />
        <Tile n={g.penalties} label={plural(g.penalties, 'penalty', 'penalties')} href="#standing" />
        <Tile n={g.aliases} label={plural(g.aliases, 'merged account', 'merged accounts')} href="#identity" />
      </div>
      <div class="file-glance__notes">
        <p class="file-glance__recent">
          <span class="file-glance__label">Last 30 days</span>
          {g.evidence.length === 0
            ? <span class="muted">Nothing recorded.</span>
            : g.evidence.map((e) => (
              <span key={e.source} class="file-ev"><b>{e.count}</b> {SOURCE_LABEL[e.source]}</span>
            ))}
          {g.evidence.length > 0 && <span class="muted file-glance__hedge">Context to weigh, not a verdict.</span>}
        </p>
        {g.sharesAddressWith.length > 0 && (
          <p>Shares a connection with {g.sharesAddressWith.map((s) => s.name).join(', ')}</p>
        )}
        {g.steamFlags.map((f) => <p key={f.kind} class="muted">{f.text}</p>)}
        <p class="muted">
          {d.lastReview
            ? `Looked at by ${d.lastReview.reviewedByName ?? d.lastReview.reviewedBy} ${fmtTime(d.lastReview.reviewedAt)}${d.lastReview.note ? `: ${d.lastReview.note}` : ''}`
            : 'Nobody has marked this file looked at.'}
        </p>
      </div>
    </section>
  );
}
