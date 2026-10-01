import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { logAdmin } from '../admin/audit.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import * as T from '../teams/teams.js';
import { checkLogo, LOGO_MAX_BYTES } from '../community/validate.js';
import type { CommunityStore } from '../community/store.js';
import type { DmFn } from '../signonDropNotify.js';
import { teamInviteDm } from '../discord/teamButtons.js';

export interface TeamListItem { slug: string; name: string; tag: string; logoKey: string | null; members: number }
export interface MyTeamItem { slug: string; name: string; tag: string; logoKey: string | null; role: T.TeamRole }
export interface InviteItem { id: number; slug: string; name: string; tag: string; invitedByName: string | null; createdAt: string }
export interface TeamMemberView { steamid: string; name: string; avatar: string | null; role: T.TeamRole; joinedAt: string }
export interface TeamView {
  slug: string; name: string; tag: string; logoKey: string | null; createdAt: string; disbandedAt: string | null;
  captain: string; members: TeamMemberView[]; former: { steamid: string; name: string; leftAt: string }[];
  viewer: { role: T.TeamRole | null; staff: boolean };
  manage: { invites: { id: number; steamid: string; name: string; createdAt: string }[]; joinLinkToken: string | null } | null;
}

export interface TeamRoutesOpts {
  db: DB;
  store: () => CommunityStore;
  publicUrl: string;
  /** Null while the bot is not connected: invites are then site-only. */
  dm?: () => DmFn | null;
}

const NOT_FOUND = { error: 'not found' };
const SHA_PNG = /^([0-9a-f]{64})\.png$/;

export async function teamRoutes(app: FastifyInstance, opts: TeamRoutesOpts): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const isStaff = (steamid: string | null): boolean => {
    if (!steamid) return false;
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const nameOf = (steamid: string): string => getPlayer(db, steamid)?.name ?? steamid;

  /** The switch, for routes anyone may read: 404 to whoever it keeps out. A
   *  signed-in viewer always goes through competitiveAccess, same as every
   *  other route; a signed-out one is let through only once the switch is at
   *  `everyone` (competitivePublic), which is the "Public: logo, tag,
   *  roster..." part of the spec, not a weaker version of the switch. */
  const allowedViewer = (req: FastifyRequest, reply: FastifyReply): { viewer: string | null } | null => {
    const viewer = optionalViewer(req);
    const allowed = viewer ? competitiveAccess(db, viewer) : competitivePublic(db);
    if (!allowed) { reply.code(404).send(NOT_FOUND); return null; }
    return { viewer };
  };
  /** An active player the switch lets in, or the reply sent. A closed switch
   *  answers 404 before the login check, so nothing says the routes exist. */
  const allowedActive = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const refuse = (reply: FastifyReply, error: T.TeamError) =>
    reply.code(T.TEAM_ERRORS[error].status).send({ error: T.TEAM_ERRORS[error].text });
  const teamOf = (req: FastifyRequest): T.TeamRow | undefined =>
    T.getTeamBySlug(db, (req.params as { slug: string }).slug);
  /** A staff member acting on a team outside their own role there: audited.
   *  `ownRole` must be judged BEFORE the write (a captain transfer or a
   *  disband both change who holds a role), so every call site computes it
   *  first and passes it in rather than re-reading roleOf afterwards. A
   *  non-staff captain or co-captain acting on their own team is never
   *  audited, whatever `ownRole` says, because isStaff(by) is false for them. */
  const auditStaff = (by: string, ownRole: boolean, team: T.TeamRow, action: string, detail: object) => {
    if (isStaff(by) && !ownRole) logAdmin(db, by, action, team.id, { slug: team.slug, ...detail });
  };

  app.get('/api/teams', async (req, reply) => {
    if (!allowedViewer(req, reply)) return;
    const teams: TeamListItem[] = T.liveTeams(db).map((t) => ({
      slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, members: T.rosterSize(db, t.id),
    }));
    return { teams };
  });

  app.get('/api/teams/mine', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const teams: MyTeamItem[] = T.myTeams(db, me).map((t) => ({ slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, role: t.role }));
    const invites: InviteItem[] = T.pendingInvitesFor(db, me).map((i) => ({
      id: i.id, slug: i.slug, name: i.name, tag: i.tag, invitedByName: getPlayer(db, i.invited_by)?.name ?? null, createdAt: i.created_at,
    }));
    return { teams, invites, canCreate: T.canCreate(db, me) };
  });

  app.get('/api/teams/player-search', async (req, reply) => {
    if (!allowedActive(req, reply)) return;
    const q = String((req.query as { q?: unknown }).q ?? '').trim();
    if (q.length < 2) return { players: [] };
    const rows = db.prepare(
      `SELECT steamid, name, avatar FROM players WHERE status = 'active' AND lower(name) LIKE ? ESCAPE '\\' ORDER BY lower(name) LIMIT 10`,
    ).all(`${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { steamid: string; name: string; avatar: string | null }[];
    return { players: rows };
  });

  app.post('/api/teams', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const { name, tag } = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = T.createTeam(db, { creator: me, name, tag });
    if (!r.ok) return refuse(reply, r.error);
    return reply.code(201).send({ slug: r.value.slug });
  });

  app.get('/api/teams/join/:token', async (req, reply) => {
    if (!allowedActive(req, reply)) return;
    const t = T.teamByJoinToken(db, (req.params as { token: string }).token);
    if (!t) return refuse(reply, 'link_off');
    return { slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key };
  });

  app.post('/api/teams/join/:token', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const r = T.joinByLink(db, { token: (req.params as { token: string }).token, steamid: me });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.get('/api/teams/logos/:file', async (req, reply) => {
    if (!allowedViewer(req, reply)) return;
    const m = SHA_PNG.exec((req.params as { file: string }).file);
    if (!m || !db.prepare('SELECT 1 FROM teams WHERE logo_key = ?').get(m[1])) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readLogo(m[1]!);
    if (!bytes) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type('image/png').send(bytes);
  });

  for (const action of ['accept', 'decline', 'cancel'] as const) {
    app.post(`/api/teams/invites/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const inviteId = Number((req.params as { id: string }).id);
      if (!Number.isInteger(inviteId)) return refuse(reply, 'not_found');
      if (action === 'cancel') {
        const r = T.cancelInvite(db, { inviteId, by: me });
        if (!r.ok) return refuse(reply, r.error);
        return {};
      }
      const r = T.respondInvite(db, { inviteId, steamid: me, accept: action === 'accept' });
      if (!r.ok) return refuse(reply, r.error);
      return { slug: r.value.slug };
    });
  }

  app.get('/api/teams/:slug', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const role = v.viewer ? T.roleOf(db, t.id, v.viewer) : null;
    const staff = isStaff(v.viewer);
    const manager = staff || role === 'captain' || role === 'cocaptain';
    const view: TeamView = {
      slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key, createdAt: t.created_at, disbandedAt: t.disbanded_at,
      captain: t.captain_steamid,
      members: T.activeMembers(db, t.id).map((m) => {
        const p = getPlayer(db, m.steamid);
        return { steamid: m.steamid, name: p?.name ?? m.steamid, avatar: p?.avatar ?? null, role: m.role, joinedAt: m.joined_at };
      }),
      former: T.formerMembers(db, t.id).map((f) => ({ steamid: f.steamid, name: nameOf(f.steamid), leftAt: f.left_at })),
      viewer: { role, staff },
      manage: manager && !t.disbanded_at
        ? {
            invites: T.openInvitesOf(db, t.id).map((i) => ({ id: i.id, steamid: i.steamid, name: nameOf(i.steamid), createdAt: i.created_at })),
            joinLinkToken: staff || role === 'captain' ? t.join_link_token : null,
          }
        : null,
    };
    return view;
  });

  app.post('/api/teams/:slug/invites', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const target = String(((req.body ?? {}) as { steamid?: unknown }).steamid ?? '');
    const r = T.invitePlayer(db, { teamId: t.id, by: me, target });
    if (!r.ok) return refuse(reply, r.error);
    const discordId = getPlayer(db, target)?.discord_id;
    const dm = opts.dm?.();
    // A captain can invite, cancel and invite again as often as the rules
    // allow (the site invite above is unaffected); this only caps the DM, so
    // a loop of that cannot spam the target's Discord.
    const invite = T.getInvite(db, r.value.inviteId)!;
    if (discordId && dm && !T.invitedRecently(db, t.id, target, invite.created_at, invite.id)) {
      void dm(discordId, teamInviteDm({
        inviteId: r.value.inviteId, teamName: t.name, tag: t.tag, invitedByName: nameOf(me), url: `${opts.publicUrl}/team/${t.slug}`,
      })).catch((err) => console.warn(`[teams] could not DM ${target} about invite ${r.value.inviteId}:`, err instanceof Error ? err.message : err));
    }
    return reply.code(201).send({ inviteId: r.value.inviteId });
  });

  app.post('/api/teams/:slug/join-link', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.setJoinLink(db, { teamId: t.id, by: me, on: ((req.body ?? {}) as { on?: unknown }).on === true });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/leave', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.leaveTeam(db, { teamId: t.id, steamid: me });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/members/:steamid/kick', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.kickMember(db, { teamId: t.id, by: me, target: (req.params as { steamid: string }).steamid });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/teams/:slug/members/:steamid/role', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const r = T.setRole(db, { teamId: t.id, by: me, target: (req.params as { steamid: string }).steamid, role: ((req.body ?? {}) as { role?: unknown }).role });
    if (!r.ok) return refuse(reply, r.error);
    return {};
  });

  app.post('/api/teams/:slug/captain', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    // Judged before the write: transferCaptain demotes the old captain to
    // cocaptain, so reading the role afterwards would always say "not captain".
    const ownRole = T.roleOf(db, t.id, me) === 'captain';
    const target = String(((req.body ?? {}) as { steamid?: unknown }).steamid ?? '');
    const r = T.transferCaptain(db, { teamId: t.id, by: me, target, staff: isStaff(me) });
    if (!r.ok) return refuse(reply, r.error);
    auditStaff(me, ownRole, t, 'team_captain', { to: target });
    return {};
  });

  app.post('/api/teams/:slug/rename', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const ownRole = T.roleOf(db, t.id, me) === 'captain';
    const { name, tag } = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = T.renameTeam(db, { teamId: t.id, by: me, staff: isStaff(me), name, tag });
    if (!r.ok) return refuse(reply, r.error);
    auditStaff(me, ownRole, t, 'team_rename', { from: { name: t.name, tag: t.tag }, to: r.value });
    return r.value;
  });

  app.post('/api/teams/:slug/disband', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    // Judged before the write: after it nobody is captain any more.
    const ownRole = T.roleOf(db, t.id, me) === 'captain';
    const r = T.disbandTeam(db, { teamId: t.id, by: me, staff: isStaff(me) });
    if (!r.ok) return refuse(reply, r.error);
    auditStaff(me, ownRole, t, 'team_disband', { name: t.name });
    return {};
  });

  app.post('/api/teams/:slug/logo', { bodyLimit: Math.ceil(LOGO_MAX_BYTES * 1.4) + 1024 }, async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const t = teamOf(req);
    if (!t) return refuse(reply, 'not_found');
    const staff = isStaff(me);
    const role = T.roleOf(db, t.id, me);
    // Judged before the write: "own role" for a logo is captain OR cocaptain,
    // both already managers, unlike rename/disband/captain where only the
    // captain acts under their own role.
    const ownRole = role === 'captain' || role === 'cocaptain';
    if (!staff && !ownRole) return refuse(reply, 'not_manager');
    const raw = ((req.body ?? {}) as { png?: unknown }).png;
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'The logo is missing.' });
    const bytes = Buffer.from(raw, 'base64');
    const checked = checkLogo(bytes);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const store = opts.store();
    if (!(await store.canTake(bytes.length))) return reply.code(507).send({ error: 'The community shelf is full right now.' });
    const { name } = store.putLogo(bytes);
    const r = T.setLogoKey(db, { teamId: t.id, by: me, staff, logoKey: name });
    if (!r.ok) return refuse(reply, r.error);
    auditStaff(me, ownRole, t, 'team_logo', { logoKey: name });
    return { logoKey: name };
  });
}
