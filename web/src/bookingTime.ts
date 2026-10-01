import type { SlotEstimate } from './api';

/** A `datetime-local` value ("2026-10-02T20:00") read in the viewer's own
 *  time zone, as an ISO string; null when empty or unreadable. */
export function toUtcIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const t = new Date(local).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "Fri 2 Oct, 20:00" in the viewer's zone. */
export function localLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A campaign the options do not list counts as the server's default. */
const DEFAULT_CAMPAIGN_MINUTES = 60;

/** The server's estimateMinutes, from the options: the base, plus each
 *  campaign's typical length and the slack, rounded up to the step and
 *  raised to the minimum. It is never capped: the campaign count is the
 *  only limit on a playlist. */
export function estimateSlot(e: SlotEstimate, playlist: string[]): number {
  const raw = e.base + playlist.reduce((sum, c) => sum + (e.perCampaign[c] ?? DEFAULT_CAMPAIGN_MINUTES) + e.slack, 0);
  return Math.max(e.min, Math.ceil(raw / e.step) * e.step);
}

/** "2 h 30", "2 h", or "30 min". */
export function slotLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m}`;
}

export const campaignsLabel = (n: number): string => `${n} campaign${n === 1 ? '' : 's'}`;

/** Under a form's campaign boxes: "About 2 h 30 for 2 campaigns". */
export const estimateLine = (minutes: number, campaigns: number): string => `About ${slotLabel(minutes)} for ${campaignsLabel(campaigns)}`;

/** On the board: "2 campaigns, about 2 h 30". */
export const slotSummary = (campaigns: number, minutes: number): string => `${campaignsLabel(campaigns)}, about ${slotLabel(minutes)}`;

/** The server's proposedPlaylist (src/scrims/rules.ts): the poster's and the
 *  accepter's picks alternate, poster first, repeats skipped, capped. */
export function mergedPlaylist(poster: string[], accepter: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < Math.max(poster.length, accepter.length); i++) {
    for (const c of [poster[i], accepter[i]]) {
      if (c !== undefined && !seen.has(c)) { seen.add(c); out.push(c); }
    }
  }
  return out.slice(0, max);
}

/** Plan 2's scrim night banner: "Thursday 5:00 PM-9:00 PM", the window's
 *  weekday and start-end in the viewer's own time zone. The weekday is read
 *  off the start, same as everywhere else a start becomes a local label. */
export function nightRangeLabel(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${start.toLocaleDateString(undefined, { weekday: 'long' })} ${time(start)}-${time(end)}`;
}
