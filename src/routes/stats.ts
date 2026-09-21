import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { createReadStream } from 'node:fs';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import {
  ENDORSE_ERROR_TEXT, allTitles, endorseState, giveEndorsement, pendingEndorsements,
} from '../endorsements.js';
import { resolveDemoPath } from '../demos.js';
import { publicUrlFor, type R2Config } from '../r2.js';
import { getLiveMatches, mapStatsFor, eventsFor } from '../liveView.js';

/** Every event a finished match can have. A four map night records around a
 *  thousand; the bound exists so a runaway feed cannot become a multi-megabyte
 *  page, not to window anything a real match produces. */
const MATCH_EVENT_LIMIT = 20_000;
import { getCampaignPool } from '../settings.js';
import { mapDetail, mapIndex } from '../playerStats.js';
import { displaySr, matchForecast } from '../rating.js';
import { currentSeasonId, getPlayer, saveProfileFields } from '../players.js';
import { getSession } from '../session.js';
import { STAT_DEFS, statDef } from '../statKeys.js';
import { roundAttribution, unrecordedOrdinals } from '../roundStats.js';
import { leaderboardData, profileData } from '../playerQueries.js';
import { listSeasons } from '../seasons.js';

export interface StatsRouteOpts { db: DB; demoDir?: string; r2?: R2Config | null }

const RECENT_MATCH_LIMIT = 50;

/** Strip self-only stats unless the requester IS the subject.
 *
 *  Enforced here rather than in the UI on purpose: a value the server sends is
 *  a value the viewer can read, regardless of what the page chooses to render. */
function visibleStats(
  raw: Record<string, number>, subject: string, viewer: string | null,
): Record<string, number> {
  // A null viewer is anonymous, and null never equals a steamid, so every
  // self-only stat is stripped. No special case needed.
  const isSelf = viewer !== null && viewer === subject;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const def = statDef(k);
    if (!def) continue;
    if (def.visibility === 'self' && !isSelf) continue;
    out[k] = v;
  }
  return out;
}

export async function statsRoutes(app: FastifyInstance, opts: StatsRouteOpts): Promise<void> {
  const { db } = opts;
  const demoDir = opts.demoDir ?? '';
  // These are PUBLIC read routes: a leaderboard nobody can see is not a
  // leaderboard, and people want to link results to friends who have not
  // signed up. The viewer is still identified when present, because
  // self-visibility stats depend on it. Everything that MUTATES state, and
  // the personal /api/state dashboard, stays behind requireActive in
  // routes/api.ts.
  const viewerOf = makeOptionalViewer(db);
  // The endorse routes are the exception to "public read routes" above: they
  // write, and what they read is one player's own choices.
  const requireActive = makeRequireActive(db);
  /** Whether an already-resolved active viewer is an admin. */
  const isAdminViewer = (steamid: string): boolean =>
    (db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(steamid) as
      { is_admin: number } | undefined)?.is_admin === 1;

  app.get('/api/leaderboard', async (req, reply) => {
    const raw = (req.query as { season?: string }).season;
    const data = leaderboardData(db, raw === undefined ? undefined : Number(raw));
    if (!data) return reply.code(404).send({ error: 'no such season' });
    return data;
  });

  app.get('/api/seasons', async () => ({ seasons: listSeasons(db) }));

  /** Per-stat ladder. `self`-visibility stats are refused here rather than
   *  filtered later: a "most skeeted" board is exactly what the private
   *  visibility rule exists to prevent, so it must not be reachable by URL. */
  app.get('/api/leaderboard/stat/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const def = statDef(key);
    // Rankability is about DIRECTION, not visibility. Those used to coincide,
    // because the only high_bad stats were also the only self-visibility ones,
    // so this gate read `visibility !== 'public'` and happened to be right.
    // Making times_skeeted public (2026-09-18) separated them and opened a
    // "most times skeeted" board at this URL. A stat where a high number is
    // bad is not a ranking, and `standings.ts` already gates on high_good for
    // the same reason.
    if (!def || def.visibility !== 'public' || def.direction !== 'high_good') {
      return reply.code(404).send({ error: 'unknown stat' });
    }

    const q = req.query as { season?: string; limit?: string };
    const seasonId = q.season ? Number(q.season) : currentSeasonId(db);
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 25) || 25), 1), 100);

    const rows = db.prepare(
      `SELECT mps.player_id AS steamid, p.name, p.avatar, SUM(mps.value) AS total
       FROM match_player_stats mps
       JOIN matches m ON m.id = mps.match_id
       JOIN players p ON p.steamid = mps.player_id
       WHERE mps.stat = ? AND m.season_id = ? AND m.state = 'completed'
       GROUP BY mps.player_id
       ORDER BY total DESC, p.name ASC
       LIMIT ?`,
    ).all(key, seasonId, limit);

    return { stat: def, seasonId, rows };
  });

  app.get('/api/players/:steamid', async (req, reply) => {
    const { steamid } = req.params as { steamid: string };
    const data = profileData(db, steamid, viewerOf(req));
    if (!data) return reply.code(404).send({ error: 'no such player' });
    return data;
  });

  /** A player editing their own profile. The steamid comes from the session
   *  and never from the body: there is no "edit as" and no admin override on
   *  this route, so a body carrying somebody else's id is ignored rather than
   *  honoured. A test pins that. */
  app.post('/api/profile', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid || !getPlayer(db, steamid)) {
      return reply.code(401).send({ error: 'not logged in' });
    }
    const result = saveProfileFields(db, steamid, req.body);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true };
  });

  /** What is being played right now. Public: the whole point is that someone
   *  who is not in the game, and may not have an account, can watch. Carries
   *  no stats, so there is nothing viewer-dependent to redact. */
  app.get('/api/live', async () => ({ matches: getLiveMatches(db) }));

  /** Every map that has been played, so the map pages are discoverable. */
  // `pool` is the current vote rotation, so the page can put what you might
  // actually play tonight above what you cannot. Out of rotation is not out of
  // sight: those campaigns keep every stat, they just sort below.
  app.get('/api/maps', async () => ({ maps: mapIndex(db), pool: getCampaignPool(db) }));

  /** Everyone's record on one map. Counterpart to the profile's by-map view. */
  app.get('/api/maps/:map', async (req, reply) => {
    const { map } = req.params as { map: string };
    const d = mapDetail(db, map);
    if (!d) return reply.code(404).send({ error: 'no such map' });
    return d;
  });

  app.get('/api/matches', async () => {
    const matches = db.prepare(
      `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT ?`,
    ).all(RECENT_MATCH_LIMIT);
    return { matches };
  });

  app.get('/api/matches/:id', async (req, reply) => {
    const viewer = viewerOf(req);
    const id = Number((req.params as { id: string }).id);
    // 'aborted' as well as 'completed'. An abandoned or reaped match used to
    // 404 here, which meant the Discord card's own "Match page" link led
    // nowhere and there was no record anywhere of who was in it or how far it
    // got. archiveAborted (src/matchArchive.ts) now writes the same
    // match_maps / match_players rows a completed match has, so everything
    // below serves one with no special case; a NULL `winner` is what tells
    // the page no result was reached. 'aborted' also covers a VOIDED match,
    // which is a completed one flipped over with voided_at set, so the void
    // reason rides along for the page to say so.
    const match = db.prepare(
      `SELECT id, campaign, state, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore,
              winner, voided_at AS voidedAt, void_reason AS voidReason
       FROM matches WHERE id = ? AND state IN ('completed', 'aborted')`,
    ).get(id);
    if (!match) return reply.code(404).send({ error: 'no such match' });
    // Per-map player stats come from the end-of-map snapshots kept by the
    // live pipeline; the authoritative dump only carries match totals. Absent
    // for any match played before that existed, hence the ?? {}.
    const byMap = mapStatsFor(db, id);
    // `recorded` false means the stored score is not a result (a round the
    // plugin could not attribute or read), and the page must say "not
    // recorded" instead of 0 to 0. See unrecordedOrdinals for the rule.
    const unrecorded = unrecordedOrdinals(db, id);
    const maps = (db.prepare(
      'SELECT ordinal, map, team_a_score AS teamAScore, team_b_score AS teamBScore FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(id) as { ordinal: number }[]).map((mp) => ({
      ...mp, stats: byMap.get(mp.ordinal) ?? {}, recorded: !unrecorded.has(mp.ordinal),
    }));
    const statRows = db.prepare(
      'SELECT player_id, stat, value FROM match_player_stats WHERE match_id = ?',
    ).all(id) as { player_id: string; stat: string; value: number }[];
    const byPlayer = new Map<string, Record<string, number>>();
    for (const sr of statRows) {
      const bucket = byPlayer.get(sr.player_id) ?? {};
      bucket[sr.stat] = sr.value;
      byPlayer.set(sr.player_id, bucket);
    }
    const titles = allTitles(db);
    const players = (db.prepare(
      `SELECT mp.player_id AS steamid, p.name, mp.team, mp.si_damage, mp.si_kills, mp.common_kills, mp.ff_dealt, mp.revives,
              rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
       FROM match_players mp
       JOIN players p ON p.steamid = mp.player_id
       LEFT JOIN rating_history rh ON rh.match_id = mp.match_id AND rh.player_id = mp.player_id
       WHERE mp.match_id = ?`,
    ).all(id) as any[]).map((p) => ({
      steamid: p.steamid, name: p.name, team: p.team,
      title: titles.get(p.steamid) ?? null,
      siDamage: p.si_damage, siKills: p.si_kills, commonKills: p.common_kills, ffDealt: p.ff_dealt, revives: p.revives,
      srDelta: p.mu_after === null ? 0
        : displaySr(p.mu_after, p.sigma_after) - displaySr(p.mu_before, p.sigma_before),
      stats: visibleStats(byPlayer.get(p.steamid) ?? {}, p.steamid, viewer),
    }));
    // Per-round side attribution. Derived, not stored: see src/roundStats.ts.
    // teamOf comes from match_players, which is the authoritative roster
    // written at completion, rather than from anything on the live feed.
    const teamOf = new Map(players.map((p) => [p.steamid, p.team as 'a' | 'b']));
    // roundAttribution carries score and endedAt through from the same
    // roundsFor() query it already runs internally. This used to run that
    // query a second time here and join the two results by array index; one
    // query, no positional join.
    const rounds = roundAttribution(db, id, teamOf);

    // Only demos for maps the match actually has. The recorder opens a demo
    // on every map load under the match token, including the post-finale
    // map the server rolls to after the match has ended, so a file can exist
    // for an ordinal match_maps never had. This route serves completed
    // matches only; the live view (getLiveMatches) keeps every demo because
    // its map list is still growing.
    const demos = db.prepare(
      `SELECT d.ordinal, d.map, d.bytes FROM match_demos d
       JOIN match_maps mm ON mm.match_id = d.match_id AND mm.ordinal = d.ordinal
       WHERE d.match_id = ? ORDER BY d.ordinal`,
    ).all(id);

    const nameOf = (sid: string) =>
      (players.find((p) => p.steamid === sid)?.name) ?? sid;
    // The WHOLE feed, with its timing. This used to take eventsFor's default,
    // which is the live page's 40-newest window, and dropped half and tMs on
    // the way out. A completed match is a record, not a ticker: the clear
    // latency table then saw two minutes of finale and did undefined minus
    // undefined for every pair (NaN averages, three players, 2026-09-13).
    const events = eventsFor(db, id, MATCH_EVENT_LIMIT).map((e) => ({
      seq: e.seq, kind: e.kind, mapOrdinal: e.mapOrdinal, half: e.half, tMs: e.tMs, value: e.value,
      actor: { steamid: e.actor, name: nameOf(e.actor) },
      target: e.target ? { steamid: e.target, name: nameOf(e.target) } : null,
    }));

    // Admin only, for judging whether the balancer is any good. Withheld from
    // players on purpose: "you were meant to lose" is not a thing anyone
    // should be able to read off a match page, and the same number would be
    // read as an excuse the moment it is public. Absent, not null, for a
    // non-admin, so the client cannot tell a forecast exists at all.
    const forecast = viewer && isAdminViewer(viewer) ? matchForecast(db, id) : undefined;

    return { match, maps, players, rounds, demos, events, statDefs: STAT_DEFS, ...(forecast ? { forecast } : {}) };
  });

  /** One player's endorse panel for one match: who they may endorse, what
   *  they already gave, what is left. Their own choices only. */
  app.get('/api/matches/:id/endorse', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return endorseState(db, Number((req.params as { id: string }).id), steamid);
  });

  /** Give one endorsement. The giver is the session and never the body, so a
   *  body naming somebody else as `from` is ignored. A test pins that. Every
   *  rule is enforced in src/endorsements.ts, which the Discord button calls
   *  as well. Not rate limited: nothing on this site is yet (September audit),
   *  and this belongs in that work when it lands. */
  app.post('/api/matches/:id/endorse', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const matchId = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { to?: unknown; kind?: unknown };
    if (typeof body.to !== 'string' || typeof body.kind !== 'string') {
      return reply.code(400).send({ error: 'to and kind are required', code: 'bad_kind' });
    }
    const r = Number.isInteger(matchId)
      ? giveEndorsement(db, { matchId, from: steamid, to: body.to, kind: body.kind })
      : { ok: false as const, error: 'no_match' as const };
    if (!r.ok) return reply.code(400).send({ error: ENDORSE_ERROR_TEXT[r.error], code: r.error });
    return { ok: true, remaining: r.remaining, state: endorseState(db, matchId, steamid) };
  });

  /** Recent matches this player can still endorse on, for the quiet bar. */
  app.get('/api/endorse/pending', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return { pending: pendingEndorsements(db, steamid) };
  });

  /**
   * Download one match demo. Public, at the user's request (2026-09-11).
   *
   * The bytes were behind a login because a demo is 100+ MB served off the
   * same two cores that are holding 100 tick, so anonymous bulk downloading
   * competes with srcds for I/O and bandwidth. That tradeoff has not gone
   * away; it was accepted deliberately so demos can be shared with people who
   * have no account. If the box ever starts struggling under demo traffic,
   * restoring `requireActive` here is the one-line fix.
   */
  app.get('/api/matches/:id/demos/:ordinal', async (req, reply) => {
    const { id, ordinal } = req.params as { id: string; ordinal: string };

    // R2 first. Once a demo is up there the bytes never come through this
    // process again: the redirect hands the browser straight to Cloudflare, the
    // friendly filename rides on the object's Content-Disposition, and the game
    // server's network is left for the game. The local branch below stays for
    // demos not yet swept and for an install with no R2 configured at all.
    const stored = db
      .prepare('SELECT r2_key AS r2Key FROM match_demos WHERE match_id = ? AND ordinal = ?')
      .get(Number(id), Number(ordinal)) as { r2Key: string | null } | undefined;
    if (stored?.r2Key && opts.r2) {
      return reply.redirect(publicUrlFor(opts.r2, stored.r2Key), 302);
    }

    const found = resolveDemoPath(db, Number(id), Number(ordinal), demoDir);
    if (!found) return reply.code(404).send({ error: 'no such demo' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(found.bytes));
    // Served under a SHORT name, not the on-disk one. The stored filename
    // carries a 32-char token, and `playdemo` takes the filename with no
    // extension, so the real name means typing 60+ characters into the Source
    // console with no tab completion. pug8-1 is match 8, map 1.
    const friendly = `pug${Number(id)}-${Number(ordinal) + 1}.dem`;
    reply.header('Content-Disposition', `attachment; filename="${friendly}"`);
    return reply.send(createReadStream(found.path));
  });
}
