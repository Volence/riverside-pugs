import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Hub } from '../ws.js';
import { handleButton, type ControllerDeps } from './controller.js';
import { DiscordSync, type VoiceHook } from './sync.js';
import type { BotInteraction, BotTransport, InteractionReply, SlashCommandDef } from './transport.js';
import type { GuildMembership } from './membership.js';
import type { VoicePresence } from './voicePresence.js';

export interface BotDeps {
  config: Config;
  db: DB;
  matchmaker: Matchmaker;
  hub: Hub;
  /** Builds the gateway connection. Injected in tests. */
  connect: () => Promise<BotTransport & { destroy?(): Promise<void> }>;
  /** Extra controller hooks (bans, timeouts) supplied by later features. */
  controller?: Partial<Pick<ControllerDeps, 'queueBlock' | 'banMessage'>>;
  voice?: (transport: BotTransport) => VoiceHook;
  /** Filled from the server's member list for the queue gate. */
  membership?: GuildMembership;
  /** Filled from the server's voice states for the ready gate. */
  presence?: VoicePresence;
  /** Extra startup work that needs the connected transport (the admin feed). */
  onConnected?: (transport: BotTransport) => void | Promise<void>;
  /** Buttons outside the queue flow, by custom_id prefix (e.g. 'r:' for report cards). */
  extraButtons?: Record<string, (i: Extract<BotInteraction, { kind: 'button' }>) => Promise<InteractionReply>>;
  /** Modal submits outside the queue flow, by custom_id prefix, the same way. */
  extraModals?: Record<string, (i: Extract<BotInteraction, { kind: 'modal' }>) => Promise<InteractionReply>>;
  /** Which buttons answer with a modal. Handed to the transport, which has to
   *  know before it runs the handler: see BotTransport.onInteraction. */
  opensModal?: (customId: string) => boolean;
  /** Message context menu commands, by exact name. The names are what gets
   *  registered; the handler gets ids only, never the message's content. */
  messageCommands?: Record<string, (i: Extract<BotInteraction, { kind: 'message_command' }>) => Promise<InteractionReply>>;
  commands?: {
    defs: SlashCommandDef[];
    handle: (i: Extract<BotInteraction, { kind: 'command' }>) => Promise<InteractionReply>;
  };
}

export interface RunningBot {
  sync: DiscordSync;
  transport: BotTransport;
  stop(): Promise<void>;
}

/** Whether this process should run the bot at all. */
export function botEnabled(config: Config): boolean {
  return !!config.discord?.lobbyChannelId && !config.devMode;
}

/**
 * Connect and start the bot. Returns null when the bot is not configured. A
 * connection failure is thrown to the caller, which logs it and carries on:
 * the website never depends on Discord being up.
 */
export async function startBot(deps: BotDeps): Promise<RunningBot | null> {
  if (!botEnabled(deps.config)) return null;
  const channelId = deps.config.discord!.lobbyChannelId!;
  const transport = await deps.connect();
  const controllerDeps: ControllerDeps = {
    db: deps.db, matchmaker: deps.matchmaker, publicUrl: deps.config.publicUrl,
    roles: transport.roles, ...deps.controller,
  };

  transport.onInteraction(async (i) => {
    if (i.kind === 'button') {
      const prefix = Object.keys(deps.extraButtons ?? {}).find((p) => i.customId.startsWith(p));
      if (prefix) return deps.extraButtons![prefix](i);
      return handleButton(controllerDeps, i);
    }
    if (i.kind === 'modal') {
      const prefix = Object.keys(deps.extraModals ?? {}).find((p) => i.customId.startsWith(p));
      if (prefix) return deps.extraModals![prefix](i);
      return { ephemeral: true, payload: { content: 'That form no longer does anything.', embeds: [], components: [] } };
    }
    if (i.kind === 'message_command') {
      const run = deps.messageCommands?.[i.name];
      if (run) return run(i);
      return { ephemeral: true, payload: { content: 'That command no longer does anything.', embeds: [], components: [] } };
    }
    if (deps.commands) return deps.commands.handle(i);
    return { ephemeral: true, payload: { content: 'Unknown command.', embeds: [], components: [] } };
  }, { opensModal: deps.opensModal });
  const messageCommands = Object.keys(deps.messageCommands ?? {}).map((name) => ({ name }));
  if (deps.commands || messageCommands.length > 0) {
    await transport.registerCommands(deps.commands?.defs ?? [], messageCommands).catch((err) =>
      console.error('[discord] registering commands failed:', err));
  }

  if (deps.membership) {
    const m = deps.membership;
    await transport.watchMembers({ all: (ids) => m.setAll(ids), add: (id) => m.add(id), remove: (id) => m.remove(id) })
      .catch((err) => console.error('[discord] loading the member list failed; the queue gate allows everyone until it loads:', err));
  }
  if (deps.presence) {
    const p = deps.presence;
    await transport.watchVoice({ all: (states) => p.setAll(states), update: (id, ch) => p.update(id, ch) })
      .catch((err) => console.error('[discord] loading voice states failed; the ready gate allows everyone until it loads:', err));
  }
  await deps.onConnected?.(transport);

  const sync = new DiscordSync({
    db: deps.db,
    matchmaker: deps.matchmaker,
    hub: deps.hub,
    transport,
    publicUrl: deps.config.publicUrl,
    channelId,
    voice: deps.voice?.(transport),
  });
  await sync.start();

  return {
    sync,
    transport,
    async stop() {
      sync.stop();
      deps.membership?.reset();
      deps.presence?.reset();
      await transport.destroy?.();
    },
  };
}
