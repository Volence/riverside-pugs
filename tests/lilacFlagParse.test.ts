import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const parse = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const STAMP = 'L 09/21/2026 - 12:15:22: ';
const BODY = 'L4DL id=76561198030288393 cheat=5 banned=0';

describe('L4DL lilac flag line', () => {
  it('parses a suspicion', () => {
    expect(parse(STAMP + BODY)).toMatchObject({
      kind: 'lilac_flag', steamid: '76561198030288393', cheat: 5, banned: false,
    });
  });

  it('parses a ban', () => {
    expect(parse(STAMP + BODY.replace('banned=0', 'banned=1')))
      .toMatchObject({ kind: 'lilac_flag', banned: true });
  });

  // Same protection as the consistency drop and the input burst: the game
  // server relays every chat line on this stream, so the marker only counts
  // when it is the first thing after the engine's own timestamp.
  it('refuses a flag forged through chat', () => {
    expect(parse(`${STAMP}"x<2><STEAM_1:0:5><Infected>" say "${BODY}"`))
      .not.toMatchObject({ kind: 'lilac_flag' });
  });

  it('refuses a flag forged through a player name', () => {
    expect(parse(`${STAMP}"${BODY}<2><STEAM_1:0:5><Infected>" entered the game`))
      .not.toMatchObject({ kind: 'lilac_flag' });
  });

  it('refuses a bad steamid', () => {
    expect(parse(STAMP + BODY.replace('76561198030288393', 'nope'))).toBeNull();
  });

  it('refuses a cheat number outside what LilAC can emit', () => {
    expect(parse(STAMP + BODY.replace('cheat=5', 'cheat=99'))).toBeNull();
    expect(parse(STAMP + BODY.replace('cheat=5', 'cheat=-1'))).toBeNull();
  });

  it('refuses a missing field', () => {
    expect(parse(STAMP + 'L4DL id=76561198030288393 banned=0')).toBeNull();
  });

  // An old plugin (pre-0.2.0) sends none of the extra reason fields at all.
  // The line must still parse to exactly what it always did: no `reason`.
  it('an old-format line with no reason fields parses as before, with no reason', () => {
    const ev = parse(STAMP + BODY);
    expect(ev).toMatchObject({ kind: 'lilac_flag', steamid: '76561198030288393', cheat: 5, banned: false });
    expect(ev).not.toHaveProperty('reason');
  });

  describe('the aimbot reason (cheat 5)', () => {
    const AIMBOT_BODY = `${BODY} lflags=2 ldelta=12.3 ltd=470.5 maxd=80.2 totd=200.5 taps=10 taps1=8`;

    it('parses every field', () => {
      expect(parse(STAMP + AIMBOT_BODY)).toMatchObject({
        kind: 'lilac_flag', cheat: 5,
        reason: { lflags: 2, ldelta: 12.3, ltd: 470.5, maxd: 80.2, totd: 200.5, taps: 10, taps1: 8 },
      });
    });

    it('accepts the -1 unknown sentinel on every measurement', () => {
      const line = AIMBOT_BODY
        .replace('lflags=2', 'lflags=-1')
        .replace('ldelta=12.3', 'ldelta=-1.0')
        .replace('ltd=470.5', 'ltd=-1.0')
        .replace('maxd=80.2', 'maxd=-1.0')
        .replace('totd=200.5', 'totd=-1.0');
      expect(parse(STAMP + line)).toMatchObject({
        reason: { lflags: -1, ldelta: -1, ltd: -1, maxd: -1, totd: -1 },
      });
    });

    for (const bad of [
      'lflags=16', 'lflags=-2', 'lflags=1.5',
      'ldelta=-2', 'ldelta=100001', 'ldelta=nope',
      'ltd=-2', 'ltd=100001',
      'maxd=-2', 'maxd=100001',
      'totd=-2', 'totd=100001',
      'taps=-1', 'taps=1001', 'taps=1.5',
      'taps1=-1', 'taps1=1001',
    ]) {
      it(`rejects the whole line when ${bad} is malformed`, () => {
        const [key] = bad.split('=');
        const re = new RegExp(`${key}=[^\\s]+`);
        const line = AIMBOT_BODY.replace(re, bad);
        expect(parse(STAMP + line)).toBeNull();
      });
    }
  });

  describe('the aimlock reason (cheat 6)', () => {
    const AIMLOCK_BODY = 'L4DL id=76561198030288393 cheat=6 banned=0 maxd=45.0 totd=90.0 taps=6 taps1=5 '
      + 'ltarget_team=2 ltarget_class=0 ltarget_ghost=0';

    it('parses every field, with no lflags/ldelta/ltd (aimbot-only fields)', () => {
      const ev = parse(STAMP + AIMLOCK_BODY);
      expect(ev).toMatchObject({
        kind: 'lilac_flag', cheat: 6,
        reason: {
          maxd: 45, totd: 90, taps: 6, taps1: 5,
          ltarget_team: 2, ltarget_class: 0, ltarget_ghost: 0,
        },
      });
      expect((ev as unknown as { reason: Record<string, unknown> }).reason).not.toHaveProperty('lflags');
    });

    it('parses an infected target with the -1 unknown sentinel for ghost', () => {
      const line = AIMLOCK_BODY
        .replace('ltarget_team=2', 'ltarget_team=3')
        .replace('ltarget_class=0', 'ltarget_class=3')
        .replace('ltarget_ghost=0', 'ltarget_ghost=-1');
      expect(parse(STAMP + line)).toMatchObject({
        reason: { ltarget_team: 3, ltarget_class: 3, ltarget_ghost: -1 },
      });
    });

    for (const bad of ['ltarget_team=4', 'ltarget_team=-2', 'ltarget_class=9', 'ltarget_class=-2', 'ltarget_ghost=2', 'ltarget_ghost=-2']) {
      it(`rejects the whole line when ${bad} is malformed`, () => {
        const [key] = bad.split('=');
        const re = new RegExp(`${key}=[^\\s]+`);
        const line = AIMLOCK_BODY.replace(re, bad);
        expect(parse(STAMP + line)).toBeNull();
      });
    }

    // Round 1 fix, 2026-09-24: the flagged client's own team, so the site is
    // no longer stuck hedging off the target's side alone.
    it('parses the flagged player\'s own team (lself_team)', () => {
      expect(parse(STAMP + `${AIMLOCK_BODY} lself_team=3`)).toMatchObject({
        reason: { ltarget_team: 2, lself_team: 3 },
      });
    });

    it('accepts the -1 unknown sentinel for lself_team', () => {
      expect(parse(STAMP + `${AIMLOCK_BODY} lself_team=-1`)).toMatchObject({ reason: { lself_team: -1 } });
    });

    it('has no lself_team at all when the plugin did not send one', () => {
      const ev = parse(STAMP + AIMLOCK_BODY);
      expect((ev as unknown as { reason: Record<string, unknown> }).reason).not.toHaveProperty('lself_team');
    });

    for (const bad of ['lself_team=4', 'lself_team=-2', 'lself_team=1.5']) {
      it(`rejects the whole line when ${bad} is malformed`, () => {
        expect(parse(STAMP + `${AIMLOCK_BODY} ${bad}`)).toBeNull();
      });
    }
  });

  describe('the bhop reason (cheat 4)', () => {
    const BHOP_BODY = 'L4DL id=76561198030288393 cheat=4 banned=0 lbhops=14 ljump=22';

    it('parses every field', () => {
      expect(parse(STAMP + BHOP_BODY)).toMatchObject({
        kind: 'lilac_flag', cheat: 4, reason: { lbhops: 14, ljump: 22 },
      });
    });

    // The plugin sends lbhops=-1 (alongside ljump=-1) for every bhop flag on
    // a server still on stock LilAC, without the fork's reason forward: that
    // is the WHOLE rollout until every box carries it, so rejecting -1 here
    // dropped the bhop flag itself, not just its reason. -1 is LilAC's
    // "unknown" sentinel, same as every other reason field.
    it('accepts the -1 unknown sentinel on both lbhops and ljump', () => {
      expect(parse(STAMP + BHOP_BODY.replace('ljump=22', 'ljump=-1')))
        .toMatchObject({ reason: { ljump: -1 } });
      expect(parse(STAMP + BHOP_BODY.replace('lbhops=14', 'lbhops=-1')))
        .toMatchObject({ reason: { lbhops: -1 } });
    });

    for (const bad of ['lbhops=1001', 'lbhops=-2', 'ljump=100001', 'ljump=-2']) {
      it(`rejects the whole line when ${bad} is malformed`, () => {
        const [key] = bad.split('=');
        const re = new RegExp(`${key}=[^\\s]+`);
        const line = BHOP_BODY.replace(re, bad);
        expect(parse(STAMP + line)).toBeNull();
      });
    }
  });
});
