/**
 * A Steam Web API that answers from a table, for tests. Shapes are the
 * documented ones: GetPlayerBans has no `response` wrapper and spells its id
 * `SteamId`; a private profile answers GetOwnedGames and GetSteamLevel with an
 * empty `response`; IsPlayingSharedGame says "0" when nothing is borrowed.
 */
export interface FakeSteamAccount {
  /** Unix seconds. Left out by Steam when the profile is private. */
  timecreated?: number;
  visibility?: number;
  profilestate?: number;
  /** Absent: Steam returns no summary for this id at all. */
  noSummary?: boolean;
  bans?: { vac?: number; game?: number; daysSince?: number; community?: boolean; economy?: string };
  /** 'hidden': game details are private. null: visible, L4D1 not owned. */
  l4d1Minutes?: number | null | 'hidden';
  /** 'hidden' answers with an empty response, as a private profile does. */
  level?: number | 'hidden';
  lender?: string;
}

export interface FakeSteam {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Every URL asked for, in order. */
  calls: string[];
  /** Endpoint names (GetPlayerBans, ...) that throw, as a Steam outage does. */
  down: Set<string>;
  /** Endpoint names that answer with a non-2xx status. */
  refused: Set<string>;
}

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

export function fakeSteam(accounts: Record<string, FakeSteamAccount>): FakeSteam {
  const calls: string[] = [];
  const down = new Set<string>();
  const refused = new Set<string>();
  const fetch = async (raw: string): Promise<Response> => {
    calls.push(raw);
    const url = new URL(raw);
    const endpoint = url.pathname.split('/')[2];
    if (down.has(endpoint)) throw new Error(`${endpoint} is down`);
    if (refused.has(endpoint)) return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
    const ids = (url.searchParams.get('steamids') ?? '').split(',').filter(Boolean);
    const one = accounts[url.searchParams.get('steamid') ?? ''];
    switch (endpoint) {
      case 'GetPlayerSummaries':
        return ok({
          response: {
            players: ids.filter((id) => accounts[id] && !accounts[id].noSummary).map((id) => ({
              steamid: id,
              personaname: `persona ${id.slice(-3)}`,
              communityvisibilitystate: accounts[id].visibility ?? 3,
              ...(accounts[id].profilestate === undefined ? { profilestate: 1 } : { profilestate: accounts[id].profilestate }),
              ...(accounts[id].timecreated === undefined ? {} : { timecreated: accounts[id].timecreated }),
            })),
          },
        });
      case 'GetPlayerBans':
        return ok({
          players: ids.filter((id) => accounts[id]).map((id) => {
            const b = accounts[id].bans ?? {};
            return {
              SteamId: id,
              CommunityBanned: b.community ?? false,
              VACBanned: (b.vac ?? 0) > 0,
              NumberOfVACBans: b.vac ?? 0,
              DaysSinceLastBan: b.daysSince ?? 0,
              NumberOfGameBans: b.game ?? 0,
              EconomyBan: b.economy ?? 'none',
            };
          }),
        });
      case 'GetOwnedGames': {
        if (!one || one.l4d1Minutes === 'hidden') return ok({ response: {} });
        if (one.l4d1Minutes === null || one.l4d1Minutes === undefined) return ok({ response: { game_count: 0 } });
        return ok({ response: { game_count: 1, games: [{ appid: 500, playtime_forever: one.l4d1Minutes }] } });
      }
      case 'GetSteamLevel':
        return ok({ response: !one || one.level === undefined || one.level === 'hidden' ? {} : { player_level: one.level } });
      case 'IsPlayingSharedGame':
        return ok({ response: { lender_steamid: one?.lender ?? '0' } });
      default:
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
  };
  return { fetch, calls, down, refused };
}
