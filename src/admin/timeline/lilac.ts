import type { DB } from '../../db.js';
import { ZOMBIE_CLASSES } from '../../replayFormat.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { id: number; match_id: number | null; kind: string; severity: string; detail: string; at: string }

/** integrity_flags.detail parsed back into numbers, the reverse of
 *  logParse.ts's lilacReasonDetail. Never throws: a key that is not a finite
 *  number (there should not be one, since only that function writes this
 *  column) is simply missing from the result, same as an old row that never
 *  had it. */
function detailFields(detail: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of detail.split(' ')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const v = Number(part.slice(eq + 1));
    if (Number.isFinite(v)) out[part.slice(0, eq)] = v;
  }
  return out;
}

/** LilAC's own flag bits (Lilac_AimbotFlags), plus our Total-Delta reading:
 *  ltd is not one of LilAC's bits, but its own doc treats a high total delta
 *  as reason enough on its own, so it is named alongside the bits it sets. */
function reasonNames(lflags: number, ltd: number | undefined): string {
  const names: string[] = [];
  if (lflags & 1) names.push('Angle-Repeat');
  if (lflags & 2) names.push('Autoshoot');
  if (lflags & 4) names.push('Aim-Snap');
  if (lflags & 8) names.push('Aim-Snap2');
  if (ltd !== undefined && ltd > 450) names.push('Total-Delta');
  return names.length ? names.join(', ') : 'none recorded';
}

/** The infected `<class>` an aimlock target sentence names, from
 *  `m_zombieClass`. Falls back to the raw number for a class this L4D1 build
 *  cannot name, rather than pretending it is one of the five it knows. */
function classNameOf(cls: number): string {
  return cls >= 1 && cls < ZOMBIE_CLASSES.length ? ZOMBIE_CLASSES[cls] : `class ${cls}`;
}

/** The sentence(s) an aimbot/aimlock/bhop reason adds after the existing
 *  summary. Empty when the row has no detail (an older row, or any cheat that
 *  is not one of the three that carry a reason), so those rows read exactly
 *  as they always have. */
function reasonSentences(kind: string, detail: string): string {
  if (!detail) return '';
  const f = detailFields(detail);
  const sentences: string[] = [];

  if (kind === 'aimbot' && f.lflags !== undefined && f.lflags >= 0) {
    sentences.push(`LilAC's reason: ${reasonNames(f.lflags, f.ltd)}.`);
  }

  if ((kind === 'aimbot' || kind === 'aimlock')
      && f.maxd !== undefined && f.totd !== undefined && f.taps !== undefined && f.taps1 !== undefined) {
    sentences.push(
      `Our measurement over the 1.5 s before: biggest one-tick aim change ${f.maxd} degrees, `
      + `total ${f.totd} degrees, ${f.taps} trigger presses, ${f.taps1} of them one tick long.`,
    );
  }

  if (kind === 'aimlock' && f.ltarget_team !== undefined && f.ltarget_team >= 0) {
    if (f.ltarget_team === 2) {
      const ghost = f.ltarget_ghost === 1 ? ' (a ghost)' : '';
      sentences.push(`Locked onto a survivor${ghost}.`);
      // We only know the TARGET's side. Without the flagged player's own
      // team on this row, the caveat is phrased off the target alone: L4D
      // shows survivors to infected through walls by design, so this can be
      // a legitimate lock rather than a cheat, and only if the flagged
      // player was actually playing infected at the time.
      sentences.push(
        'Infected players see survivors through walls in L4D, so this can be legitimate if the flagged player was infected.',
      );
    } else if (f.ltarget_team === 3) {
      const cls = f.ltarget_class !== undefined ? classNameOf(f.ltarget_class) : 'unknown';
      const ghost = f.ltarget_ghost === 1 ? ' (a ghost)' : '';
      sentences.push(`Locked onto an infected ${cls}${ghost}.`);
    }
  }

  if (kind === 'bhop' && f.lbhops !== undefined && f.lbhops >= 0) {
    sentences.push(`${f.lbhops} perfect hops in a row.`);
  }

  return sentences.length ? ` ${sentences.join(' ')}` : '';
}

/** Flags Little Anti-Cheat raised during play. No replay behind them, so
 *  there is nothing to watch: the value is the pattern, not the single hit.
 *  "suspected" is LilAC's own word and its own documentation says few and
 *  rare suspicions are usually false positives, which is why the line says
 *  that here too. The source column is filtered rather than assumed: the
 *  table takes flags from any plugin that wants to report one. */
export const lilacAdapter: TimelineAdapter = {
  source: 'lilac',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, match_id, kind, severity, detail, at FROM integrity_flags
       WHERE source = 'lilac' AND steamid IN (${marks(ids)})
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'lilac' as const,
      kind: r.kind,
      summary: (r.severity === 'banned'
        ? `Little Anti-Cheat banned this account on the game server for ${r.kind}.`
        : `Little Anti-Cheat suspected ${r.kind}. Few and rare suspicions are usually false positives; a run of them is what matters.`)
        + reasonSentences(r.kind, r.detail),
      matchId: r.match_id,
      replay: null,
      ref: { type: 'integrity_flag', id: r.id },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      "SELECT steamid, MAX(at) AS at FROM integrity_flags WHERE source = 'lilac' GROUP BY steamid",
    ).all() as { steamid: string; at: string }[];
  },
};
