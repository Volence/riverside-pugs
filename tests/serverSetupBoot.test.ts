import { describe, expect, it } from 'vitest';
import { isBootGameType, waitForStartup, STARTUP_POLLS, BOOT_GAME_TYPE } from '../src/serverSetup.js';
import type { ServerRow } from '../src/serverPool.js';

const server = { id: 1, name: 'Riverside #5' } as unknown as ServerRow;

describe('waitForStartup', () => {
  it('stops polling once the box reports the pool boot mode', async () => {
    const seen = ['', '', BOOT_GAME_TYPE];
    let polls = 0;
    const rcon = async () => { const t = seen[Math.min(polls++, seen.length - 1)]; return [`"l4d_game_type_name" = "${t}" ( def. "" )`]; };
    await waitForStartup(rcon, server, async () => {});
    expect(polls).toBe(3);
  });

  it('still accepts a Pub boot (Rotoblin stock startup, NFO Chicago)', () => {
    expect(isBootGameType('Rotoblin Pub VS')).toBe(true);
    expect(isBootGameType('Roto-AZ / 4v4 VS')).toBe(true);
    expect(isBootGameType('Roto-AZ / 4v4 PUG')).toBe(false);
    expect(isBootGameType('')).toBe(false);
  });

  it('gives up after STARTUP_POLLS on a box that never reports a boot mode', async () => {
    let polls = 0;
    const rcon = async () => { polls++; return ['"l4d_game_type_name" = "Hunter Training" ( def. "" )']; };
    await waitForStartup(rcon, server, async () => {});
    expect(polls).toBe(STARTUP_POLLS);
  });
});
