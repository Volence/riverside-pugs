import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { QUEUE_SIZE } from '../queue.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { createLinkCode, playerByDiscordId, type PlayerRow } from '../players.js';
import { spectateFor } from '../spectate.js';
import type { BotInteraction, InteractionReply, MessagePayload, RoleOps } from './transport.js';
import { getSetting } from '../settings.js';
import { ENDORSE_ERROR_TEXT, ENDORSE_LABEL, endorseState, giveEndorsement } from '../endorsements.js';
import { escapeName, renderEndorseKinds, renderEndorsePicker } from './presenter.js';

export interface ControllerDeps {
  db: DB;
  matchmaker: Matchmaker;
  publicUrl: string;
  /** Refusal layered on by no-show timeouts: a message, or null to allow. */
  queueBlock?: (steamid: string) => string | null;
  /** The ban explanation (reason, expiry) when bans carry one. */
  banMessage?: (steamid: string) => string;
  /** Add and remove the opt-in queue-alert role. Absent in tests that do not
   *  exercise it, and when absent the toggle says so rather than lying. */
  roles?: RoleOps;
}

const say = (content: string, extra: Partial<MessagePayload> = {}): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [], ...extra },
});

/** The reply an unlinked Discord user gets from anything that needs a player. */
export function linkPrompt(deps: ControllerDeps, userId: string, userName: string): InteractionReply {
  const code = createLinkCode(deps.db, userId, userName);
  return say(
    'Your Discord is not linked to a Steam account yet. Press the button, sign in with Steam once, and you are set. The link works for 15 minutes.',
    { components: [[{ kind: 'link', url: `${deps.publicUrl}/link/discord?code=${code}`, label: 'Link Steam account' }]] },
  );
}

/** Resolve the presser to an active player, or the reply that explains why not. */
function resolve(
  deps: ControllerDeps, i: { userId: string; userName: string },
): { player: PlayerRow } | { reply: InteractionReply } {
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player) return { reply: linkPrompt(deps, i.userId, i.userName) };
  if (player.status === 'banned') {
    return { reply: say(deps.banMessage?.(player.steamid) ?? 'You are banned from the PUG.') };
  }
  if (player.status !== 'active') {
    return {
      reply: say(
        'Your account is not active yet. Make sure your linked Discord account is in the Riverside server, then sign in on the website again, or use an invite code there.',
        { components: [[{ kind: 'link', url: `${deps.publicUrl}/`, label: 'Website' }]] },
      ),
    };
  }
  return { player };
}

/**
 * Every button the bot posts. Each calls exactly what the website's HTTP route
 * calls, so the two surfaces cannot disagree about who may do what.
 *
 * custom_id scheme: q:join, q:leave, l:<lobbyId>:ready,
 * l:<lobbyId>:vote:<campaign>, m:<matchId>:connect, m:<matchId>:endorse,
 * e:<matchId>:p:<steamid>, e:<matchId>:k:<steamid>:<kind>.
 *
 * Ticket buttons (t:<ticketId>:...) are routed to ticketButtons.ts before
 * they reach this function.
 */
export async function handleButton(
  deps: ControllerDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const parts = i.customId.split(':');
  const known = (parts[0] === 'q' && (parts[1] === 'join' || parts[1] === 'leave' || parts[1] === 'notify'))
    || (parts[0] === 'l' && parts.length >= 3)
    || (parts[0] === 'm' && (parts[2] === 'connect' || parts[2] === 'spectate' || parts[2] === 'endorse'))
    || (parts[0] === 'e' && parts.length >= 4 && (parts[2] === 'p' || parts[2] === 'k'));
  if (!known) return say('That button no longer does anything.');

  // Before resolve(), deliberately. Wanting to be told when games are filling
  // is not the same as being ready to play one, and someone who has not linked
  // their account yet is exactly who most needs the nudge to come back.
  if (parts[0] === 'q' && parts[1] === 'notify') return toggleAlertRole(deps, i.userId);

  const who = resolve(deps, i);
  if ('reply' in who) return who.reply;
  const steamid = who.player.steamid;
  const mm = deps.matchmaker;

  if (parts[0] === 'q' && parts[1] === 'join') {
    const block = deps.queueBlock?.(steamid);
    if (block) return say(block);
    if (mm.stateFor(steamid).queue.joined) return say(`You are already in the queue (${mm.publicQueue().count}/${QUEUE_SIZE}).`);
    const r = mm.join(steamid);
    if (!r.ok) return say(`Could not join: ${r.error}.`);
    const st = mm.stateFor(steamid);
    // Joining can be the eighth player, which pops the queue straight into a lobby.
    if (st.lobby) return say('You are in! The queue just popped, ready up on the match card.');
    return say(`You are in the queue (${st.queue.count}/${QUEUE_SIZE}).`);
  }

  if (parts[0] === 'q' && parts[1] === 'leave') {
    if (!mm.stateFor(steamid).queue.joined) return say('You are not in the queue.');
    mm.leave(steamid);
    return say('You left the queue.');
  }

  if (parts[0] === 'l') {
    const lobbyId = parts[1];
    const lobby = mm.stateFor(steamid).lobby;
    if (!lobby || lobby.id !== lobbyId) return say('That ready check is over, or it is not yours.');
    if (parts[2] === 'ready') {
      if (lobby.phase !== 'ready_check') return say('Everyone is ready already. Vote a campaign.');
      const r = mm.ready(steamid);
      if (!r.ok) return say(`Not yet: ${r.error}, then press Ready again.`);
      return say('You are ready.');
    }
    if (parts[2] === 'vote' && parts[3]) {
      const campaign = parts[3];
      if (lobby.phase !== 'map_vote') return say('Voting has not started yet. Ready up first.');
      if (!lobby.options.includes(campaign)) return say('That campaign is not an option in this vote.');
      mm.vote(steamid, campaign);
      return say(`You voted ${campaignDisplayName(deps.db, campaign)}.`);
    }
    return say('That button no longer does anything.');
  }

  // Endorsements. `steamid` is the LINKED player resolve() found, which is the
  // only identity these calls ever see: the Discord id alone authorises
  // nothing, and the steamid inside the custom id is only ever the RECIPIENT,
  // which giveEndorsement checks against the roster like any other input.
  if (parts[0] === 'm' && parts[2] === 'endorse') return endorsePicker(deps, Number(parts[1]), steamid);
  if (parts[0] === 'e') {
    const endorseMatch = Number(parts[1]);
    const target = parts[3];
    if (parts[2] === 'p') {
      const st = endorseState(deps.db, endorseMatch, steamid);
      if (!st.eligible) return say(ENDORSE_ERROR_TEXT[st.reason ?? 'no_match']);
      const c = st.candidates.find((x) => x.steamid === target);
      if (!c) return say(ENDORSE_ERROR_TEXT.target_not_rostered);
      const already = st.given.some((g) => g.to === target);
      if (st.remaining <= 0 || already) return endorsePicker(deps, endorseMatch, steamid);
      return { ephemeral: true, payload: renderEndorseKinds({ matchId: endorseMatch, steamid: target, name: c.name }) };
    }
    const r = giveEndorsement(deps.db, { matchId: endorseMatch, from: steamid, to: target, kind: parts[4] ?? '' });
    if (!r.ok) return endorsePicker(deps, endorseMatch, steamid, ENDORSE_ERROR_TEXT[r.error]);
    const st = endorseState(deps.db, endorseMatch, steamid);
    const name = st.candidates.find((x) => x.steamid === target)?.name ?? 'them';
    const kind = st.given.find((g) => g.to === target)?.kind;
    return endorsePicker(
      deps, endorseMatch, steamid,
      `Endorsed ${escapeName(name)}${kind ? ` as ${ENDORSE_LABEL[kind]}` : ''}.`,
    );
  }

  const matchId = Number(parts[1]);
  if (parts[2] === 'spectate') {
    // Public: the SourceTV delay is what makes watching safe, so this needs no
    // roster check. Still ephemeral, to keep the channel tidy.
    const tv = spectateFor(deps.db, serverOfMatch(deps.db, matchId));
    if (!tv) return say('That match has no SourceTV to watch.');
    const line = tv.password ? `password ${tv.password}; connect ${tv.host}:${tv.port}` : `connect ${tv.host}:${tv.port}`;
    return say(
      `Watch in game, ${tv.delay} seconds behind live:\n\`\`\`\n${line}\n\`\`\`Spectator slots are limited, so it can be full.`,
    );
  }

  // m:<matchId>:connect
  const match = mm.stateFor(steamid).match;
  if (!match || match.id !== matchId) return say('You are not on this match.');
  if (!match.connect) return say('The server is not ready yet. Try again in a moment.');
  const c = match.connect;
  return say(
    `Paste this into the L4D console (password first, or it fails):\n\`\`\`\npassword ${c.password}; connect ${c.host}:${c.port}\n\`\`\`Keep the password to yourself.`,
    { components: [[{ kind: 'link', url: `${deps.publicUrl}/`, label: 'Open on the website' }]] },
  );
}

/** The server a match is on, for the public spectate button. */
function serverOfMatch(db: ControllerDeps['db'], matchId: number): number | null {
  const row = db.prepare("SELECT server_id FROM matches WHERE id = ? AND state = 'live'")
    .get(matchId) as { server_id: number | null } | undefined;
  return row?.server_id ?? null;
}

/**
 * Toggle the opt-in queue-alert role.
 *
 * Reads the member's current roles rather than keeping our own record of who
 * opted in: Discord is the source of truth for that, someone can be given or
 * stripped of the role by hand, and a local copy would drift silently.
 *
 * A read that fails reports failure instead of guessing. Telling someone they
 * have been removed from a role they still hold, or the reverse, is worse than
 * asking them to try again.
 */
async function toggleAlertRole(deps: ControllerDeps, userId: string): Promise<InteractionReply> {
  const roleId = getSetting(deps.db, 'discord_pug_role_id');
  if (!roleId || !deps.roles) return say('Queue alerts are not set up on this server yet.');

  const has = await deps.roles.has(userId, roleId).catch(() => null);
  if (has === null) return say('Could not read your roles just now. Try that again in a moment.');

  try {
    if (has) {
      await deps.roles.remove(userId, roleId);
      return say('You will no longer be pinged when the queue fills up. Press it again to turn alerts back on.');
    }
    await deps.roles.add(userId, roleId);
    return say('You will be pinged when the queue is close to popping. Press it again to stop.');
  } catch (err) {
    console.error('[discord] alert role toggle failed:', err);
    // Almost always the bot's role sitting below the target role in the guild's
    // role list, which no amount of retrying fixes, so say something an admin
    // can act on rather than "try again".
    return say('Could not change that. An admin may need to move the bot\'s role above the alert role.');
  }
}

/** The picker, or the sentence explaining why this player gets none. */
function endorsePicker(deps: ControllerDeps, matchId: number, steamid: string, notice?: string): InteractionReply {
  const st = endorseState(deps.db, matchId, steamid);
  if (!st.eligible) return say(ENDORSE_ERROR_TEXT[st.reason ?? 'no_match']);
  const given = new Map(st.given.map((g) => [g.to, g.kind]));
  return {
    ephemeral: true,
    payload: renderEndorsePicker({
      matchId, budget: st.budget, remaining: st.remaining, notice,
      candidates: st.candidates.map((c) => ({ steamid: c.steamid, name: c.name, given: given.get(c.steamid) ?? null })),
    }),
  };
}
