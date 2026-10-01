import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import * as R from '../rulesetStore.js';
import * as G from '../gameConfigStore.js';

/**
 * Setup > Rulesets and Setup > Game configs. Admins only, reads included
 * (mods have no Setup desk). Every rule lives in src/rulesetStore.ts and
 * src/gameConfigStore.ts, which also write the logAdmin row inside the same
 * transaction; a route maps a refusal to its status and sentence.
 */
export async function adminRulesetRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const refuseRuleset = (reply: FastifyReply, error: R.RulesetError) =>
    reply.code(R.RULESET_ERRORS[error].status).send({ error: R.RULESET_ERRORS[error].text });
  const refuseConfig = (reply: FastifyReply, error: G.GameConfigError) =>
    reply.code(G.GAME_CONFIG_ERRORS[error].status).send({ error: G.GAME_CONFIG_ERRORS[error].text });
  const idOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const body = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/admin/rulesets', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { rulesets: R.rulesetList(db) };
  });

  app.post('/api/admin/rulesets', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = R.createRuleset(db, { by: me, copyFrom: b.copyFrom, name: b.name });
    if (!r.ok) return refuseRuleset(reply, r.error);
    return reply.code(201).send({ id: r.value.id });
  });

  app.post('/api/admin/rulesets/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null) return refuseRuleset(reply, 'not_found');
    const b = body(req);
    const r = R.updateRuleset(db, { by: me, id, name: b.name, rules: b.rules });
    if (!r.ok) return refuseRuleset(reply, r.error);
    return { ok: true };
  });

  for (const [path, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/api/admin/rulesets/:id/${path}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const id = idOf((req.params as { id: string }).id);
      if (id === null) return refuseRuleset(reply, 'not_found');
      const r = R.setRulesetArchived(db, { by: me, id, archived });
      if (!r.ok) return refuseRuleset(reply, r.error);
      return { ok: true };
    });
  }

  app.get('/api/admin/game-configs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { gameConfigs: G.gameConfigList(db) };
  });

  app.post('/api/admin/game-configs', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = G.createGameConfig(db, { by: me, key: b.key, label: b.label, cfg: b.cfg });
    if (!r.ok) return refuseConfig(reply, r.error);
    return reply.code(201).send({ key: r.value.key });
  });

  app.post('/api/admin/game-configs/:key', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const b = body(req);
    const r = G.updateGameConfig(db, { by: me, key: (req.params as { key: string }).key, label: b.label, enabled: b.enabled });
    if (!r.ok) return refuseConfig(reply, r.error);
    return { ok: true };
  });

  app.post('/api/admin/game-configs/:key/delete', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = G.deleteGameConfig(db, { by: me, key: (req.params as { key: string }).key });
    if (!r.ok) return refuseConfig(reply, r.error);
    return { ok: true };
  });
}
