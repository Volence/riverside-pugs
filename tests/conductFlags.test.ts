import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { parseLogDatagram } from '../src/logParse.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { handleConduct } from '../src/conductFlags.js';
import { addAlias, canonicalise } from '../src/aliases.js';

const P = '76561199048276493';
const VICTIM = '76561199122132251';
const ALT = '76561199861598482';

const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

describe('PUGSAY and PUGNAME parsing', () => {
  it('reads a chat line, message last', () => {
    expect(parse(`PUGSAY steamid=${P} team=3 msg=he was on my angle`))
      .toEqual({ kind: 'say', steamid: P, team: 3, message: 'he was on my angle' });
  });

  it('reads a connect and a rename, name last', () => {
    expect(parse(`PUGNAME steamid=${P} event=connect name=zerovercome`))
      .toEqual({ kind: 'name', steamid: P, event: 'connect', name: 'zerovercome' });
    expect(parse(`PUGNAME steamid=${P} event=change name=nruom`))
      .toEqual({ kind: 'name', steamid: P, event: 'change', name: 'nruom' });
  });

  // The whole reason these lines exist: a player controls the message and
  // the name, so nothing typed there may move the steamid onto someone else.
  it('never takes a steamid from inside the message or the name', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 msg=x steamid=${VICTIM} team=3`))
      .toMatchObject({ steamid: P, team: 2, message: `x steamid=${VICTIM} team=3` });
    expect(parse(`PUGNAME steamid=${P} event=change name=a steamid=${VICTIM} event=connect`))
      .toMatchObject({ steamid: P, event: 'change', name: `a steamid=${VICTIM} event=connect` });
  });

  // An engine chat line always opens with a quote, so typing the marker
  // into chat can never make a line of ours.
  it('ignores the marker when it appears inside an engine chat line', () => {
    expect(parse(`"zero<22><STEAM_1:1:544005382><Infected>" say "PUGSAY steamid=${VICTIM} team=2 msg=nigger"`))
      .toBeNull();
  });

  it('keeps the message whole when the signature trailer follows it', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 msg=gg wp lseq=1790141171.12 mac=0a1b2c3d`))
      .toMatchObject({ message: 'gg wp' });
  });

  it.each([
    `PUGSAY steamid=123 team=2 msg=hi`,
    `PUGSAY steamid=${P} team=2 msg=`,
    `PUGSAY steamid=${P} team=2`,
    `PUGNAME steamid=${P} event=rename name=x`,
    `PUGNAME steamid=${P} event=change name=`,
  ])('rejects the malformed line %j', (line) => {
    expect(parse(line)).toBeNull();
  });
});

describe('canonicalise', () => {
  it('moves chat and names onto the main account', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'zero', avatar: null }, []);
    upsertPlayer(db, { steamid: ALT, name: 'alt', avatar: null }, []);
    addAlias(db, { steamid: ALT, canonical: P, by: 'admin' });
    expect(canonicalise(db, { kind: 'say', steamid: ALT, team: 2, message: 'x' })).toMatchObject({ steamid: P });
    expect(canonicalise(db, { kind: 'name', steamid: ALT, event: 'connect', name: 'x' })).toMatchObject({ steamid: P });
  });
});

describe('handleConduct', () => {
  let db: DB;
  let posted: AdminEvent[];
  let unsubscribe: () => void;
  const t0 = new Date('2026-09-23T03:34:06Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const flags = () => db.prepare("SELECT kind, detail FROM integrity_flags WHERE source = 'conduct' ORDER BY id").all();

  beforeEach(() => {
    db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'zero', avatar: null }, []);
    posted = [];
    unsubscribe = subscribeAdminEvents((e) => posted.push(e));
  });
  afterEach(() => unsubscribe());

  it('ignores clean chat and clean names', () => {
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'he was on my angle' }, null, t0);
    handleConduct(db, { kind: 'name', steamid: P, event: 'connect', name: 'zerovercome' }, null, t0);
    expect(posted).toEqual([]);
    expect(flags()).toEqual([]);
  });

  it('stores and posts a slur in chat', () => {
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'nigger' }, 1, t0);
    expect(posted).toEqual([{
      kind: 'conduct_flag', steamid: P, where: 'chat', text: 'nigger', slurs: ['n-word'], matchId: null, serverId: 1,
    }]);
    expect(flags()).toEqual([{ kind: 'chat', detail: 'nigger' }]);
  });

  it('names the live match the player is in', () => {
    db.prepare("INSERT INTO servers (id, name, host, port, rcon_port, rcon_password) VALUES (1, 'Dallas', '127.0.0.1', 27015, 27015, 'x')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (140, 1, 'live', 'no_mercy', 1, 'abc')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (140, ?, 'b')").run(P);
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'nigger' }, 1, t0);
    expect(posted[0]).toMatchObject({ matchId: 140 });
  });

  // One angry player must not flood the admin channel, but every line is
  // still evidence and stays on the file. A post needs a quiet minute since
  // the player's last slur, so a steady stream is one post, not one a minute.
  it('posts again only after a quiet minute, and stores every line', () => {
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'nigger' }, null, t0);
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'faggot' }, null, at(50));
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'retard' }, null, at(100));
    handleConduct(db, { kind: 'say', steamid: P, team: 3, message: 'kys' }, null, at(170));
    expect(posted.map((e) => (e as { text: string }).text)).toEqual(['nigger', 'kys']);
    expect(flags()).toHaveLength(4);
  });

  it('posts a bad name once per player per name, however often they reconnect', () => {
    handleConduct(db, { kind: 'name', steamid: P, event: 'connect', name: 'phat nickher' }, null, t0);
    handleConduct(db, { kind: 'name', steamid: P, event: 'connect', name: 'phat nickher' }, null, at(3600));
    handleConduct(db, { kind: 'name', steamid: P, event: 'change', name: 'n1gga' }, null, at(3700));
    // "phat nickher" is not a slur by the letter, so only the second name
    // posts. It is exactly the evasion a person has to judge.
    expect(posted.map((e) => (e as { text: string }).text)).toEqual(['n1gga']);
    handleConduct(db, { kind: 'name', steamid: P, event: 'connect', name: 'n1gga' }, null, at(9000));
    expect(posted).toHaveLength(1);
    expect(flags()).toEqual([{ kind: 'name', detail: 'n1gga' }]);
  });
});
