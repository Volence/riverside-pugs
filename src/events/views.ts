import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import * as E from './events.js';
import type * as V from './validate.js';
import { STAGE_LABEL, VETO_LABEL, chaptersLabel, rulesLines, stageSummary } from './format.js';

/** What the public event list and event page show (spec section 7). */

export interface EventListItem {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; startsAt: string; bannerKey: string | null;
  format: string[]; entries: number;
}
export interface EventStageView {
  ordinal: number; type: V.StageType; summary: string; veto: string; chapters: string; scheduling: V.Scheduling;
  rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[];
}
export interface EventEntryView { name: string; tag: string; seed: number | null; status: string }
export interface EventView {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; organizerName: string | null;
  bannerKey: string | null; startsAt: string; description: string; teamCap: number | null;
  eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules;
  stages: EventStageView[]; entries: EventEntryView[];
  finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
}

const OVER: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['finished', 'cancelled']);

function entryCount(db: DB, eventId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM event_entries WHERE event_id = ? AND status NOT IN ('dropped','disqualified')")
    .get(eventId) as { n: number }).n;
}

/** Open events soonest first, then finished and cancelled ones newest first.
 *  Drafts only for staff, admins and mods (Ruling 14). */
export function eventListItems(db: DB, o: { staff: boolean }): EventListItem[] {
  const rows = (db.prepare('SELECT * FROM events ORDER BY starts_at, id').all() as E.EventRow[])
    .filter((e) => o.staff || e.status !== 'draft');
  const ordered = [...rows.filter((e) => !OVER.has(e.status)), ...rows.filter((e) => OVER.has(e.status)).reverse()];
  return ordered.map((e) => ({
    slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, official: e.official === 1, startsAt: e.starts_at,
    bannerKey: e.banner_key,
    format: E.stagesOf(db, e.id).map((s) => STAGE_LABEL[s.type]),
    entries: entryCount(db, e.id),
  }));
}

/** The snapshot once published; before that (a draft an admin previews), the
 *  chosen ruleset as a tournament would play it. */
function stageRules(db: DB, s: E.StageRow): MatchRules | null {
  const json = s.rules_json
    ?? (db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(s.ruleset_id) as { rules_json: string } | undefined)?.rules_json;
  if (!json) return null;
  try {
    return rulesForKind('tournament', parseRules(json));
  } catch {
    return null;
  }
}

export function eventView(db: DB, ev: E.EventRow): EventView {
  const f = E.fieldsOf(ev);
  const rulesetName = db.prepare('SELECT name FROM rulesets WHERE id = ?');
  const configLabel = db.prepare('SELECT label FROM game_configs WHERE key = ?');
  return {
    slug: ev.slug, name: ev.name, status: ev.status, entryKind: ev.entry_kind, official: ev.official === 1,
    organizerName: getPlayer(db, ev.organizer_steamid)?.name ?? null, bannerKey: ev.banner_key,
    startsAt: ev.starts_at, description: ev.description, teamCap: ev.team_cap,
    eligibility: f.eligibility, checkin: f.checkin, roster: f.roster,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const st = E.stageSettingsOf(s);
      const rules = stageRules(db, s);
      return {
        ordinal: s.ordinal, type: st.type, summary: stageSummary(st.type, st.config, st.advanceCount),
        veto: VETO_LABEL[st.vetoType], chapters: chaptersLabel(st.chapters), scheduling: st.scheduling,
        rulesetName: (rulesetName.get(st.rulesetId) as { name: string } | undefined)?.name ?? null,
        rules: rules ? rulesLines(rules) : [],
        gameConfig: (configLabel.get(st.gameConfig) as { label: string } | undefined)?.label ?? st.gameConfig,
        campaigns: st.campaignPool.map((slug) => ({ slug, name: campaignDisplayName(db, slug) })),
      };
    }),
    entries: db.prepare(
      "SELECT name, tag, seed, status FROM event_entries WHERE event_id = ? AND status <> 'dropped' ORDER BY seed IS NULL, seed, id",
    ).all(ev.id) as EventEntryView[],
    finishedAt: ev.finished_at, cancelledAt: ev.cancelled_at, cancelReason: ev.cancel_reason,
  };
}
