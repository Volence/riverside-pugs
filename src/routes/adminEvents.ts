import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getPlayer } from '../players.js';
import { campaignRegistry } from '../campaignRegistry.js';
import * as E from '../events/events.js';
import * as V from '../events/validate.js';
import { stageSummary } from '../events/format.js';

export interface AdminEventRow {
  id: number; slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; startsAt: string; stages: number; updatedAt: string;
}
export interface AdminEventStage { id: number; ordinal: number; summary: string; settings: V.StageSettings; rulesSnapshotted: boolean }
export interface AdminEventDetail {
  id: number; slug: string; status: V.EventStatus; fields: V.EventFields; bannerKey: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  stages: AdminEventStage[];
  log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminEventOptions {
  campaigns: { slug: string; name: string }[]; defaultPool: string[];
  rulesets: { id: number; name: string }[]; defaultRulesetId: number | null;
  gameConfigs: { key: string; label: string }[];
  defaults: { eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules };
}

export function adminEventDetail(db: DB, ev: E.EventRow): AdminEventDetail {
  return {
    id: ev.id, slug: ev.slug, status: ev.status, fields: E.fieldsOf(ev), bannerKey: ev.banner_key, cancelReason: ev.cancel_reason,
    createdAt: ev.created_at, updatedAt: ev.updated_at,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const settings = E.stageSettingsOf(s);
      return { id: s.id, ordinal: s.ordinal, summary: stageSummary(settings.type, settings.config, settings.advanceCount), settings, rulesSnapshotted: s.rules_json !== null };
    }),
    log: E.eventLog(db, ev.id).map((l) => ({
      at: l.at, actorName: l.actor ? getPlayer(db, l.actor)?.name ?? l.actor : null, action: l.action,
      detail: JSON.parse(l.detail) as Record<string, unknown>,
    })),
  };
}

/**
 * The Events desk (tournaments plan T1a). Staff read it, admins write it
 * (Ruling 2): every GET takes an admin or a mod, every POST an admin only, so
 * a mod gets a 403 on any write. Not behind competitive_enabled (Ruling 13),
 * so events can be prepared while the switch is off. Every rule lives in
 * src/events/events.ts; a route maps the refusal to its status and sentence,
 * and on success adds logAdmin (Ruling 10) after the event's own transaction
 * has committed its event_log row.
 */
export async function adminEventRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, error: V.EventError) =>
    reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const idOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get('/api/admin/events', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const rows = db.prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_stages s WHERE s.event_id = e.id) AS stage_count
       FROM events e ORDER BY e.starts_at DESC, e.id DESC`,
    ).all() as (E.EventRow & { stage_count: number })[];
    const events: AdminEventRow[] = rows.map((e) => ({
      id: e.id, slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, startsAt: e.starts_at, stages: e.stage_count, updatedAt: e.updated_at,
    }));
    return { events };
  });

  app.get('/api/admin/events/options', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ctx = E.stageContext(db);
    const registry = campaignRegistry(db);
    const rulesets = db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all() as { id: number; name: string }[];
    const cup = rulesets.find((r) => r.name === 'Standard Cup');
    const options: AdminEventOptions = {
      campaigns: [...ctx.campaigns].map((slug) => ({ slug, name: registry.get(slug)?.name ?? slug })),
      defaultPool: ctx.defaultPool,
      rulesets,
      defaultRulesetId: cup?.id ?? rulesets[0]?.id ?? null,
      gameConfigs: db.prepare('SELECT key, label FROM game_configs WHERE enabled = 1 ORDER BY key').all() as { key: string; label: string }[],
      defaults: { eligibility: V.defaultEligibility(), checkin: V.defaultCheckin(), roster: V.defaultRoster() },
    };
    return options;
  });

  app.get('/api/admin/events/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const id = idOf((req.params as { id: string }).id);
    const ev = id === null ? undefined : E.getEvent(db, id);
    if (!ev) return refuse(reply, 'not_found');
    return adminEventDetail(db, ev);
  });

  app.post('/api/admin/events', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = E.createEvent(db, { by: me, fields: req.body ?? {} });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_create', r.value.id, { slug: r.value.slug, name: r.value.name });
    return reply.code(201).send({ id: r.value.id, slug: r.value.slug });
  });

  type Body = Record<string, unknown>;
  /** One admin action on one event (and maybe one of its stages): call the
   *  store, refuse or audit, answer { ok: true }. */
  const action = (
    path: string,
    name: string,
    call: (me: string, id: number, body: Body, stageId: number | null) => V.Checked<unknown>,
    detail: (body: Body, stageId: number | null) => object = () => ({}),
  ) => {
    app.post(path, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; stageId?: string };
      const id = idOf(p.id);
      if (id === null) return refuse(reply, 'not_found');
      const stageId = p.stageId === undefined ? null : idOf(p.stageId);
      if (p.stageId !== undefined && stageId === null) return refuse(reply, 'stage_not_found');
      const body = (req.body ?? {}) as Body;
      const r = call(me, id, body, stageId);
      if (!r.ok) return refuse(reply, r.error);
      logAdmin(db, me, name, id, detail(body, stageId));
      return { ok: true };
    });
  };

  action('/api/admin/events/:id', 'event_edit',
    (me, id, body) => E.updateEvent(db, { eventId: id, by: me, fields: body }),
    (body) => ({ fields: Object.keys(body) }));
  action('/api/admin/events/:id/stages', 'event_stage_add',
    (me, id, body) => E.addStage(db, { eventId: id, by: me, stage: body }),
    (body) => ({ type: body.type }));
  action('/api/admin/events/:id/stages/order', 'event_stages_reorder',
    (me, id, body) => E.reorderStages(db, { eventId: id, by: me, order: body.order }),
    (body) => ({ order: body.order }));
  action('/api/admin/events/:id/stages/:stageId', 'event_stage_edit',
    (me, id, body, stageId) => E.updateStage(db, { eventId: id, stageId: stageId!, by: me, stage: body }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/stages/:stageId/remove', 'event_stage_remove',
    (me, id, _body, stageId) => E.removeStage(db, { eventId: id, stageId: stageId!, by: me }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/publish', 'event_publish',
    (me, id) => E.publishEvent(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/open-registration', 'event_open_registration',
    (me, id) => E.openRegistration(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/cancel', 'event_cancel',
    (me, id, body) => E.cancelEvent(db, { eventId: id, by: me, reason: body.reason }),
    (body) => ({ reason: typeof body.reason === 'string' ? body.reason.slice(0, V.CANCEL_REASON_MAX) : null }));
}
