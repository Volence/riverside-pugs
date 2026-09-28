import { describe, it, expect } from 'vitest';
import {
  ENTITY_KIND, PLAYER_SLOTS, STATE, VERSION,
  encodeHeader, encodeFrame, parseReplay,
  type EntitySample, type Frame, type PlayerSample, type ReplayHeader, type Replay,
} from '../src/replayFormat.js';
import {
  buildDrill, drillTitle, estimateTemp, formatClock, frameIndexAt, lookbackItems,
  MAX_PLAUSIBLE_SPEED, WEAPON_CLASSNAMES,
} from '../src/drillSpec.js';

/**
 * Fixtures go through the real encoder and parser rather than being built as
 * objects, so the tests exercise the same side resolution (`infected` from
 * the header mask) a replay off disk gets. A hand-built Frame would let a
 * test pass that the byte path would fail.
 */

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i}`);
const NAMES: Record<string, string> = Object.fromEntries(IDS.map((id, i) => [id, `player${i}`]));
const LIVE = STATE.PRESENT | STATE.ALIVE;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: '', ordinal: 2, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_hospital03_sewers',
    startedUnix: 1789000000, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: [...IDS],
    // Slots 4-7 infected, as a version 3 writer says.
    infectedMask: 0xf0, sidesKnown: true, losKnown: false,
    ...over,
  };
}

function player(slot: number, over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
    health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0, ...over,
  };
}

/** A frame at `tMs` with every slot empty; `set` fills the ones a test needs. */
function frame(tMs: number, players: Partial<Record<number, Partial<PlayerSample>>> = {}, entities: EntitySample[] = []): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, s) => player(s, players[s] ?? {})),
    entities,
  };
}

function replayOf(frames: Frame[], h: Partial<ReplayHeader> = {}): Replay {
  const bytes = Buffer.concat([encodeHeader(header(h)), ...frames.map(encodeFrame)]);
  const r = parseReplay(bytes);
  if (!r) throw new Error('fixture did not parse');
  return r;
}

/** Ten frames a second from 0 to `seconds`, built by `at(tMs)`. */
function round(seconds: number, at: (tMs: number) => Frame): Frame[] {
  const out: Frame[] = [];
  for (let t = 0; t <= seconds * 1000; t += 100) out.push(at(t));
  return out;
}

const OPTS = { names: NAMES, matchId: 212, mapLabel: 'No Mercy 3' };

describe('frameIndexAt', () => {
  const frames = [frame(0), frame(100), frame(200), frame(300)];
  it('picks the last frame at or before the moment', () => {
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 150)).toBe(1);
    expect(frameIndexAt(frames, 200)).toBe(2);
    expect(frameIndexAt(frames, 99999)).toBe(3);
  });
  it('clamps a moment before the round to the first frame, and has nothing for no frames', () => {
    expect(frameIndexAt([frame(500), frame(600)], 10)).toBe(0);
    expect(frameIndexAt([], 10)).toBe(-1);
  });
});

describe('formatClock and drillTitle', () => {
  it('reads like the viewer clock', () => {
    expect(formatClock(758000)).toBe('12:38');
    expect(formatClock(5999)).toBe('0:05');
  });
  it('names the match when there is one', () => {
    expect(drillTitle(212, 'No Mercy 3', 2, 758000)).toBe('Match 212, No Mercy 3, round 2 at 12:38');
    expect(drillTitle(null, 'l4d_vs_farm01_hilltop', 1, 61000)).toBe('l4d_vs_farm01_hilltop, round 1 at 1:01');
  });
});

describe('buildDrill: shape and actors', () => {
  it('builds the DESIGN.md shape from the frame at or before the moment', () => {
    const frames = round(2, (t) => frame(t, {
      0: { state: LIVE, x: 100 + t / 10, y: -50, z: 8, yaw: 91.25, pitch: -4, health: 64, cls: 1, weapon: 4, clip: 8, reserve: 90 },
      4: { state: LIVE, x: 900, y: 900, z: 0, health: 250, cls: 3 },
    }));
    const spec = buildDrill(replayOf(frames), 1250, OPTS)!;
    expect(spec).toMatchObject({
      version: 1,
      map: 'l4d_vs_hospital03_sewers',
      title: 'Match 212, No Mercy 3, round 1 at 0:01',
      source: { matchId: 212, ordinal: 2, half: 1, tMs: 1200 },
    });
    const zoey = spec.actors.find((a) => a.name === 'player0')!;
    expect(zoey).toEqual({
      side: 'survivor', cls: 'zoey', name: 'player0',
      x: 220, y: -50, z: 8, yaw: 91.25, pitch: -4,
      vx: 100, vy: 0, vz: 0,
      health: 64, temp: 0, alive: true, ghost: false, incap: false,
      weapon: 'autoshotgun', clip: 8, reserve: 90, items: [],
    });
    const hunter = spec.actors.find((a) => a.name === 'player4')!;
    expect(hunter).toMatchObject({ side: 'infected', cls: 'hunter', health: 250, weapon: '', items: [], temp: 0 });
  });

  it('lets the caller override the ordinal and half the header carries', () => {
    const spec = buildDrill(replayOf([frame(0)]), 0, { ...OPTS, ordinal: 3, half: 2 })!;
    expect(spec.source).toMatchObject({ ordinal: 3, half: 2 });
    expect(spec.title).toBe('Match 212, No Mercy 3, round 2 at 0:00');
  });

  it('is null only for a replay with no frames', () => {
    expect(buildDrill(replayOf([]), 0, OPTS)).toBeNull();
    expect(buildDrill(replayOf([frame(0)]), 0, OPTS)).toMatchObject({ actors: [], entities: [] });
  });

  it('falls back to the raw map name and leaves out the match for a loose file', () => {
    const spec = buildDrill(replayOf([frame(0)]), 0, { names: {}, matchId: null })!;
    expect(spec.title).toBe('l4d_vs_hospital03_sewers, round 1 at 0:00');
    expect(spec.source.matchId).toBeNull();
  });

  it('leaves out the dead, the absent and unrostered slots', () => {
    const frames = [frame(0, {
      0: { state: LIVE, cls: 0 },
      1: { state: STATE.PRESENT, cls: 1 },          // dead
      2: { state: 0 },                               // empty slot
      3: { state: LIVE, cls: 2 },                    // unrostered below
    })];
    const slots = [...IDS];
    slots[3] = '';
    const spec = buildDrill(replayOf(frames, { slots }), 0, OPTS)!;
    expect(spec.actors.map((a) => a.name)).toEqual(['player0']);
  });

  it('reads the side from the header mask, not slot order', () => {
    // Second half: slots 0-3 are the infected now.
    const frames = [frame(0, { 0: { state: LIVE, cls: 5, health: 6000 }, 4: { state: LIVE, cls: 3 } })];
    const spec = buildDrill(replayOf(frames, { infectedMask: 0x0f }), 0, OPTS)!;
    expect(spec.actors.find((a) => a.name === 'player0')).toMatchObject({ side: 'infected', cls: 'tank', health: 6000 });
    expect(spec.actors.find((a) => a.name === 'player4')).toMatchObject({ side: 'survivor', cls: 'louis' });
  });

  it('keeps ghost and incap flags', () => {
    const frames = [frame(0, {
      0: { state: LIVE | STATE.INCAP, cls: 0, health: 300 },
      5: { state: LIVE | STATE.GHOST, cls: 1 },
    })];
    const spec = buildDrill(replayOf(frames), 0, OPTS)!;
    expect(spec.actors.find((a) => a.name === 'player0')).toMatchObject({ incap: true, ghost: false });
    expect(spec.actors.find((a) => a.name === 'player5')).toMatchObject({ side: 'infected', cls: 'smoker', ghost: true });
  });

  it('skips an infected player whose class it cannot recreate', () => {
    const frames = [frame(0, { 4: { state: LIVE, cls: 0 }, 5: { state: LIVE, cls: 4 }, 6: { state: LIVE, cls: 2 } })];
    const spec = buildDrill(replayOf(frames), 0, OPTS)!;
    expect(spec.actors.map((a) => a.cls)).toEqual(['boomer']);
  });

  it('gives an unknown name as empty rather than a SteamID', () => {
    const frames = [frame(0, { 0: { state: LIVE } })];
    expect(buildDrill(replayOf(frames), 0, { names: {}, matchId: 1 })!.actors[0].name).toBe('');
  });

  it('lists survivors before infected', () => {
    const frames = [frame(0, { 4: { state: LIVE, cls: 3 }, 0: { state: LIVE, cls: 2 } })];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.actors.map((a) => a.side)).toEqual(['survivor', 'infected']);
  });
});

describe('buildDrill: survivor characters and bots', () => {
  const bot = (ref: number, over: Partial<EntitySample> = {}): EntitySample => ({
    ref, kind: ENTITY_KIND.SURVIVOR_BOT, state: LIVE, x: ref * 10, y: 0, z: 0, health: 100, ...over,
  });

  it('turns survivor bots into nameless survivors with the characters the humans left', () => {
    const frames = [frame(0, {
      0: { state: LIVE, cls: 1 },   // zoey
      1: { state: LIVE, cls: 3 },   // louis
    }, [bot(20), bot(21, { health: 40, state: LIVE | STATE.INCAP })])];
    const spec = buildDrill(replayOf(frames), 0, OPTS)!;
    const survivors = spec.actors.filter((a) => a.side === 'survivor');
    expect(survivors.map((a) => [a.name, a.cls])).toEqual([
      ['player0', 'zoey'], ['player1', 'louis'], ['', 'bill'], ['', 'francis'],
    ]);
    expect(survivors[3]).toMatchObject({ x: 210, health: 40, incap: true, weapon: '', items: [], yaw: 0 });
  });

  it('keeps at most four survivors, humans first', () => {
    const frames = [frame(0, {
      0: { state: LIVE, cls: 0 }, 1: { state: LIVE, cls: 1 }, 2: { state: LIVE, cls: 2 },
    }, [bot(20), bot(21), bot(22)])];
    const survivors = buildDrill(replayOf(frames), 0, OPTS)!.actors.filter((a) => a.side === 'survivor');
    expect(survivors.map((a) => a.name)).toEqual(['player0', 'player1', 'player2', '']);
    expect(survivors.map((a) => a.cls)).toEqual(['bill', 'zoey', 'francis', 'louis']);
  });

  it('assigns characters in order for a version 1 file, which never recorded them', () => {
    const frames = [frame(0, { 0: { state: LIVE, cls: 3 }, 1: { state: LIVE, cls: 3 } }, [bot(20)])];
    const spec = buildDrill(replayOf(frames, { version: 1, sidesKnown: false, infectedMask: 0 }), 0, OPTS)!;
    expect(spec.actors.map((a) => a.cls)).toEqual(['bill', 'zoey', 'francis']);
  });

  it('never gives two survivors the same character', () => {
    const frames = [frame(0, { 0: { state: LIVE, cls: 1 }, 1: { state: LIVE, cls: 1 } })];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.actors.map((a) => a.cls)).toEqual(['zoey', 'bill']);
  });

  it('leaves out dead bots', () => {
    const frames = [frame(0, {}, [bot(20, { state: STATE.PRESENT })])];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.actors).toEqual([]);
  });

  it('derives a bot velocity by matching its entity ref in the neighbouring frames', () => {
    const frames = [0, 100, 200].map((t) => frame(t, {}, [bot(20, { x: t / 2 })]));
    expect(buildDrill(replayOf(frames), 100, OPTS)!.actors[0]).toMatchObject({ vx: 500, vy: 0 });
  });
});

describe('buildDrill: entities', () => {
  const ent = (kind: number, over: Partial<EntitySample> = {}): EntitySample => ({
    ref: 50 + kind, kind, state: LIVE, x: 1, y: 2, z: 3, health: 100, ...over,
  });

  it('keeps AI specials, the AI tank and the witch, and drops commons and rocks', () => {
    const frames = [frame(0, {}, [
      ent(ENTITY_KIND.WITCH, { health: 1000 }),
      ent(ENTITY_KIND.TANK_AI, { health: 6400 }),
      ent(ENTITY_KIND.HUNTER_AI, { health: 250 }),
      ent(ENTITY_KIND.SMOKER_AI), ent(ENTITY_KIND.BOOMER_AI),
      ent(ENTITY_KIND.COMMON), ent(ENTITY_KIND.TANK_ROCK),
    ])];
    const spec = buildDrill(replayOf(frames), 0, OPTS)!;
    expect(spec.entities.map((e) => e.kind).sort()).toEqual(['boomer', 'hunter', 'smoker', 'tank', 'witch']);
    expect(spec.entities.find((e) => e.kind === 'witch')).toEqual({ kind: 'witch', x: 1, y: 2, z: 3, health: 1000 });
    expect(spec.entities.find((e) => e.kind === 'tank')!.health).toBe(6400);
  });

  it('drops dead AI', () => {
    const frames = [frame(0, {}, [ent(ENTITY_KIND.HUNTER_AI, { state: STATE.PRESENT })])];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.entities).toEqual([]);
  });

  it('reads the witch from the last sampled frame when entities are sampled slower than players', () => {
    // entityHz 5 against playerHz 10: world entities only on every second frame.
    const frames = [
      frame(0, {}, [ent(ENTITY_KIND.WITCH, { x: 77 }), ent(ENTITY_KIND.HUNTER_AI, { x: 5 })]),
      frame(100, {}, [ent(ENTITY_KIND.HUNTER_AI, { x: 6 })]),
    ];
    const spec = buildDrill(replayOf(frames, { entityHz: 5 }), 100, OPTS)!;
    expect(spec.entities).toEqual([
      { kind: 'hunter', x: 6, y: 2, z: 3, health: 100 },
      { kind: 'witch', x: 77, y: 2, z: 3, health: 100 },
    ]);
  });

  it('does not reach back for a witch at the full entity rate', () => {
    const frames = [frame(0, {}, [ent(ENTITY_KIND.WITCH)]), frame(100)];
    expect(buildDrill(replayOf(frames), 100, OPTS)!.entities).toEqual([]);
  });
});

describe('velocity', () => {
  it('is a central difference over the neighbouring frames, in units per second', () => {
    const frames = round(1, (t) => frame(t, { 0: { state: LIVE, x: t, y: -t / 2, z: 0 } }));
    expect(buildDrill(replayOf(frames), 500, OPTS)!.actors[0]).toMatchObject({ vx: 1000, vy: -500, vz: 0 });
  });

  it('is one-sided on the last frame of the round', () => {
    const frames = round(1, (t) => frame(t, { 0: { state: LIVE, z: t / 5 } }));
    expect(buildDrill(replayOf(frames), 1000, OPTS)!.actors[0].vz).toBe(200);
  });

  it('is zero for a teleport-sized jump', () => {
    const frames = [
      frame(0, { 0: { state: LIVE, x: 0 } }),
      frame(100, { 0: { state: LIVE, x: 0 } }),
      frame(200, { 0: { state: LIVE, x: 5000 } }),
    ];
    const v = buildDrill(replayOf(frames), 100, OPTS)!.actors[0];
    expect(Math.hypot(5000 / 0.2)).toBeGreaterThan(MAX_PLAUSIBLE_SPEED);
    expect(v).toMatchObject({ vx: 0, vy: 0, vz: 0 });
  });

  it('ignores a neighbour from before a death or across a gap', () => {
    const frames = [
      frame(0, { 0: { state: STATE.PRESENT, x: 0 } }),
      frame(100, { 0: { state: LIVE, x: 500 } }),
      frame(5000, { 0: { state: LIVE, x: 600 } }),
    ];
    expect(buildDrill(replayOf(frames), 100, OPTS)!.actors[0]).toMatchObject({ vx: 0 });
  });

  it('is zero when there is only one frame', () => {
    expect(buildDrill(replayOf([frame(0, { 0: { state: LIVE, x: 5 } })]), 0, OPTS)!.actors[0].vx).toBe(0);
  });
});

describe('temp health estimate', () => {
  it('treats a raw 1 as none', () => {
    const frames = [frame(0, { 0: { state: LIVE, temp: 1 } })];
    expect(estimateTemp(frames, 0, 0)).toBe(0);
  });

  it('decays from the frame the buffer last changed, at 0.25 a second', () => {
    // Pills at 10 s (1 -> 50), drill moment at 50 s: 40 s of decay is 10.
    const frames = round(50, (t) => frame(t, { 0: { state: LIVE, temp: t >= 10000 ? 50 : 1 } }));
    const i = frames.length - 1;
    expect(estimateTemp(frames, i, 0)).toBe(40);
    expect(buildDrill(replayOf(frames), 50000, OPTS)!.actors[0].temp).toBe(40);
  });

  it('floors at zero once the pills are long gone', () => {
    const frames = round(300, (t) => frame(t, { 0: { state: LIVE, temp: t >= 1000 ? 50 : 1 } }));
    expect(estimateTemp(frames, frames.length - 1, 0)).toBe(0);
  });

  it('restarts the clock on a hit, which rewrites the buffer', () => {
    // Pills at 1 s to 50, hit at 60 s leaves 20 (already decayed and less
    // the damage), moment at 64 s: 4 s of decay from the hit is 1.
    const frames = round(64, (t) => frame(t, {
      0: { state: LIVE, temp: t < 1000 ? 1 : t < 60000 ? 50 : 20 },
    }));
    expect(estimateTemp(frames, frames.length - 1, 0)).toBe(19);
  });

  it('does not look back past a death', () => {
    // Died at 5 s; alive again from 6 s with temp 30 already set.
    const frames = round(10, (t) => frame(t, {
      0: { state: t >= 5000 && t < 6000 ? STATE.PRESENT : LIVE, temp: 30 },
    }));
    // 4 s of decay (6 s to 10 s), not 10 s.
    expect(estimateTemp(frames, frames.length - 1, 0)).toBe(29);
  });

  it('is zero for infected', () => {
    const frames = [frame(0, { 4: { state: LIVE, cls: 3, temp: 40 } })];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.actors[0].temp).toBe(0);
  });
});

describe('weapons and the item lookback', () => {
  it('maps every weapon id to its classname suffix', () => {
    expect(Object.values(WEAPON_CLASSNAMES)).toEqual([
      'pistol', 'smg', 'pumpshotgun', 'autoshotgun', 'rifle', 'hunting_rifle',
      'pipe_bomb', 'molotov', 'first_aid_kit', 'pain_pills',
    ]);
  });

  it('lists the most recent weapon per other slot since spawn, in slot order', () => {
    // Life: pistol, smg, molotov, pills, then rifle in hand (rifle replaced smg).
    const sequence = [1, 2, 8, 10, 9, 5];
    const frames = sequence.map((w, k) => frame(k * 100, { 0: { state: LIVE, weapon: w } }));
    expect(lookbackItems(frames, frames.length - 1, 0)).toEqual(['pistol', 'molotov', 'first_aid_kit', 'pain_pills']);
    const actor = buildDrill(replayOf(frames), 500, OPTS)!.actors[0];
    expect(actor.weapon).toBe('rifle');
    expect(actor.items).toEqual(['pistol', 'molotov', 'first_aid_kit', 'pain_pills']);
  });

  it('keeps the newer of two primaries when the current weapon is not a primary', () => {
    const frames = [2, 5, 1].map((w, k) => frame(k * 100, { 0: { state: LIVE, weapon: w } }));
    expect(lookbackItems(frames, 2, 0)).toEqual(['rifle']);
  });

  it('forgets what was carried before the last death', () => {
    const frames = [
      frame(0, { 0: { state: LIVE, weapon: 8 } }),
      frame(100, { 0: { state: STATE.PRESENT, weapon: 0 } }),
      frame(200, { 0: { state: LIVE, weapon: 1 } }),
      frame(300, { 0: { state: LIVE, weapon: 3 } }),
    ];
    expect(lookbackItems(frames, 3, 0)).toEqual(['pistol']);
  });

  it('gives an unknown weapon as empty', () => {
    const frames = [frame(0, { 0: { state: LIVE, weapon: 0 } })];
    expect(buildDrill(replayOf(frames), 0, OPTS)!.actors[0].weapon).toBe('');
  });
});
