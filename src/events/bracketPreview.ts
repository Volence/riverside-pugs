import type { DB } from '../db.js';
import * as E from './events.js';
import * as P from './play.js';
import { bracketMatches, createBracket } from './bracket.js';
import { playEntriesOf, stageView, type StagePlayView } from './playViews.js';

/**
 * The projected bracket (owner 2026-11-14): before an event starts, the
 * bracket its current seeds would give, so teams can see a play-in round
 * and who they would meet. Built the way startEventFlow builds the real one
 * (planStage's createBracket over activeSeeded), so the two cannot disagree,
 * but in memory only: nothing is written, and a seed reorder shows on the
 * next read. Only an elimination first stage, only while every stage is
 * still pending, and only with at least 2 seeded teams. The rows carry
 * negative ids and status pending/waiting, so nothing links to a room.
 */
export async function bracketPreview(db: DB, ev: E.EventRow): Promise<StagePlayView | null> {
  if (ev.status === 'draft' || ev.status === 'cancelled' || ev.status === 'finished') return null;
  const stages = E.stagesOf(db, ev.id);
  if (stages.length === 0 || stages.some((s) => s.status !== 'pending')) return null;
  const first = stages.reduce((a, b) => (b.ordinal < a.ordinal ? b : a));
  const st = E.stageSettingsOf(first);
  if (st.type !== 'single_elim' && st.type !== 'double_elim') return null;
  const seeded = P.activeSeeded(db, ev.id);
  if (seeded.length < 2) return null;
  const data = await createBracket(st.type, st.config as never, seeded);
  const rows = bracketMatches(data).map((b, i) => ({
    id: -(i + 1), event_id: ev.id, stage_id: first.id, grp: b.group, round: b.round, slot: b.number, bm_match_id: b.bmId,
    entry_a: b.a, entry_b: b.b, status: b.state === 'ready' ? 'waiting' : 'pending', winner_entry: null, score_a: null, score_b: null,
    ready_a_at: null, ready_b_at: null, scheduled_at: null, schedule_source: null, not_before: null,
  }) as unknown as P.MatchRow);
  rows.sort((x, y) => x.grp - y.grp || x.round - y.round || x.slot - y.slot);
  return stageView(db, ev, first, rows, playEntriesOf(db, ev), { projected: true });
}
