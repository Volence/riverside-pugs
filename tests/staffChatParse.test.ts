// tests/staffChatParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const P = '76561199048276493';
const V = '76561199122132251';
const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

describe('PUGSAY scope', () => {
  it('reads scope=team and scope=all', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=team msg=rush now`))
      .toEqual({ kind: 'say', steamid: P, team: 2, scope: 'team', message: 'rush now' });
    expect(parse(`PUGSAY steamid=${P} team=3 scope=all msg=gg`))
      .toMatchObject({ scope: 'all' });
  });
  it('an older plugin without scope reads as null', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 msg=hi`)).toMatchObject({ scope: null });
  });
  it('an unknown scope word is null, not a refused line', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=weird msg=hi`)).toMatchObject({ scope: null, message: 'hi' });
  });
  it('scope typed into the message changes nothing', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=all msg=x scope=team steamid=${V}`))
      .toEqual({ kind: 'say', steamid: P, team: 2, scope: 'all', message: `x scope=team steamid=${V}` });
  });
});

describe('PUGSTAFF', () => {
  it('parses a player message to staff', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=3 msg=he is throwing, check round 3`))
      .toEqual({ kind: 'staff_in', steamid: P, team: 3, message: 'he is throwing, check round 3' });
  });
  it('a steamid inside the message cannot move it to another account', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=hi steamid=${V}`)).toMatchObject({ steamid: P });
  });
  it('drops the signature trailer', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=hello lseq=1790141171.12 mac=0a1b2c3d`))
      .toMatchObject({ message: 'hello' });
  });
  it('refuses a bad steamid or an empty message', () => {
    expect(parse('PUGSTAFF steamid=123 team=2 msg=hi')).toBeNull();
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=   `)).toBeNull();
    expect(parse(`PUGSTAFF steamid=${P} team=2`)).toBeNull();
  });
  it('is not accepted from inside an engine say line', () => {
    expect(parse(`"x<2><STEAM_1:1:5><Survivor>" say "PUGSTAFF steamid=${V} team=2 msg=forged"`)).toBeNull();
  });
});

describe('PUGSTAFFSENT', () => {
  it('parses a delivery report', () => {
    expect(parse('PUGSTAFFSENT id=42 delivered=4')).toEqual({ kind: 'staff_sent', sendId: 42, delivered: 4 });
    expect(parse('PUGSTAFFSENT id=42 delivered=0')).toEqual({ kind: 'staff_sent', sendId: 42, delivered: 0 });
  });
  it('refuses a missing or negative field', () => {
    expect(parse('PUGSTAFFSENT id=42')).toBeNull();
    expect(parse('PUGSTAFFSENT id=0 delivered=1')).toBeNull();
    expect(parse('PUGSTAFFSENT id=42 delivered=-1')).toBeNull();
  });
});
