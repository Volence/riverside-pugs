import { describe, it, expect, beforeEach } from 'vitest';
import { parseLogDatagram, type LogEvent } from '../src/logParse.js';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias, canonicalise } from '../src/aliases.js';

const A = '76561198129925325';
const parseLogLine = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const line = (body: string) => `L 10/17/2026 - 21:04:13: ${body}`;
const BODY = `L4DM id=${A} k=sikill w=smg hs=1 dist=612 pre=143.5 back=12.0 cls=hunter v=3`;

describe('the sikill line', () => {
  it('parses what the plugin sends', () => {
    expect(parseLogLine(line(BODY))).toEqual({
      kind: 'si_kill', steamid: A, weapon: 'smg', headshot: true, dist: 612, pre: 143.5, back: 12, victimClass: 'hunter',
    });
  });

  it('reads back=-1 as unknown, in either form the plugin can print', () => {
    expect(parseLogLine(line(BODY.replace('back=12.0', 'back=-1.0')))).toMatchObject({ back: -1 });
    expect(parseLogLine(line(BODY.replace('back=12.0', 'back=-1')))).toMatchObject({ back: -1 });
  });

  it('takes the STEAM_ form a sv_lan box sends', () => {
    expect(parseLogLine(line(BODY.replace(A, 'STEAM_1:1:35074132')))).toMatchObject({ steamid: '76561198030413993' });
  });

  it('reads every class it should and the headshot flag both ways', () => {
    for (const cls of ['smoker', 'boomer', 'hunter']) {
      expect(parseLogLine(line(BODY.replace('cls=hunter', `cls=${cls}`)))).toMatchObject({ victimClass: cls });
    }
    expect(parseLogLine(line(BODY.replace('hs=1', 'hs=0')))).toMatchObject({ headshot: false });
  });

  it('refuses a kill forged through chat', () => {
    expect(parseLogLine(line(`"x<2><STEAM_1:0:5><Survivor>" say "${BODY}"`))).not.toMatchObject({ kind: 'si_kill' });
  });

  it('refuses anything the plugin could not have sent', () => {
    const bad = ['v=2', 'hs=2', 'dist=-1', 'dist=x', 'dist=100001', 'pre=180.5', 'pre=-3', 'back=-2', 'back=181', 'cls=tank', 'cls=witch', 'w=SMG', 'w='];
    for (const b of bad) {
      const key = b.split('=')[0];
      const body = BODY.replace(new RegExp(`${key}=\\S+`), b);
      expect(parseLogLine(line(body)), b).toBeNull();
    }
    expect(parseLogLine(line(BODY.replace(' cls=hunter', '')))).toBeNull();
    expect(parseLogLine(line(BODY.replace(A, 'nope')))).toBeNull();
  });
});

describe('canonicalise covers SI kills', () => {
  let db: DB;
  const ALT = '76561199861598482';
  beforeEach(() => {
    db = openDb(':memory:');
    for (const id of [A, ALT]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  });

  it('rewrites an alt\'s kill to the canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: A, by: 'admin' });
    const ev: LogEvent = { kind: 'si_kill', steamid: ALT, weapon: 'smg', headshot: true, dist: 600, pre: 10, back: 5, victimClass: 'hunter' };
    expect((canonicalise(db, ev) as { steamid: string }).steamid).toBe(A);
  });
});
