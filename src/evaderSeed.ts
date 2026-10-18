/**
 * The known evaders at launch (spec section 4), owner-confirmed 2026-10-17.
 *
 * dethisa: five Steam accounts banned for evasion between 2026-09-23 and
 * 2026-10-17, plus every account still named "dethisa (pre-ban)". shove is
 * not evading: the record exists so a return is caught.
 *
 * The migration (src/evaderPeople.ts) reads DETHISA to know which evader
 * flags are the same person. The one-off seed (seedPeople, scripts/
 * seed-evader-people.ts) writes all of it, with an owner go-ahead and after a
 * DB backup.
 */

export interface SeedPerson {
  label: string;
  note: string;
  steam: readonly string[];
  /** Every players row with exactly this name is a member too. */
  steamByName: readonly string[];
  discord: readonly string[];
}

export const DETHISA: SeedPerson = {
  label: 'dethisa',
  note: 'Ban evader: telltale (09-23), sleepmark (09-25), ne (10-02), indianstreetfood (10-06), nepmir (10-16, aimbot in match 722).',
  steam: [
    '76561199238804333', // telltale
    '76561198990547138', // sleepmark
    '76561198373680118', // ne / dethisa
    '76561198032482558', // indianstreetfood
    '76561198129925325', // nepmir
  ],
  steamByName: ['dethisa (pre-ban)'],
  discord: ['286250932470153217', '852912263160791060', '617660733718659083'],
};

export const SHOVE: SeedPerson = {
  label: 'shove',
  note: 'Not evading. Recorded so a return is caught.',
  steam: ['76561198422117946', '76561199794242897'], // shove, Bella<3
  steamByName: [],
  discord: ['173483060682031104', '1547058677121421372'],
};

export const SEED_PEOPLE: readonly SeedPerson[] = [DETHISA, SHOVE];

/** The history replay must catch each of these as a dethisa candidate with
 *  that account taken out of the seed (spec section 5). */
export const REPLAY_REQUIRED: readonly { steamid: string; name: string }[] = [
  { steamid: '76561198032482558', name: 'indianstreetfood' },
  { steamid: '76561198129925325', name: 'nepmir' },
];
