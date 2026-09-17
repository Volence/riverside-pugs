import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Hub } from '../ws.js';
import { handleButton, type ControllerDeps } from './controller.js';
import { DiscordSync, type VoiceHook } from './sync.js';
import type { BotInteraction, BotTransport, InteractionReply, SlashCommandDef } from './transport.js';

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
    db: deps.db, matchmaker: deps.matchmaker, publicUrl: deps.config.publicUrl, ...deps.controller,
  };

  transport.onInteraction(async (i) => {
    if (i.kind === 'button') return handleButton(controllerDeps, i);
    if (deps.commands) return deps.commands.handle(i);
    return { ephemeral: true, payload: { content: 'Unknown command.', embeds: [], components: [] } };
  });
  if (deps.commands) {
    await transport.registerCommands(deps.commands.defs).catch((err) =>
      console.error('[discord] registering slash commands failed:', err));
  }

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
      await transport.destroy?.();
    },
  };
}
