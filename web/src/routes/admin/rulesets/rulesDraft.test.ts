import { describe, it, expect } from 'vitest';
import type { MatchRules } from '../../../api';
import { editableFrom, readRules, typedFrom } from './rulesDraft';

const CUP: MatchRules = {
  rated: false,
  pause: { limit: 3, seconds: 120, mutualUnpause: true, techPauses: 2, techSeconds: 300 },
  teamLock: true, playerMapControl: false, restartHalf: { allowed: false, lockAfterDamage: false },
  noShowGraceMinutes: 15, penalties: false, bosses: 'random_published', sideRule: 'higher_seed_chooses', spectate: { sideLocked: true },
  subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 }, disconnect: { teamSeconds: 600 }, staffCall: { cooldownSeconds: 180 }, series: { nextGameSeconds: 60 },
};
/** The Tournament play fields as CUP has them (plan T5). */
const T5 = { techSeconds: '300', reconnect: '600', subs: '2', subCharge: '0', cooldown: '180', nextGame: '60' };

describe('rules draft', () => {
  it('drops rated and penalties, and shows no limit as a blank field', () => {
    const e = editableFrom(CUP);
    expect('rated' in e || 'penalties' in e).toBe(false);
    expect(typedFrom(e)).toEqual({ limit: '3', seconds: '120', techPauses: '2', grace: '15', ...T5 });
    expect(typedFrom({ ...e, pause: { ...e.pause, limit: null, seconds: null } })).toMatchObject({ limit: '', seconds: '' });
  });

  it('reads blank pause fields as no limit and 0 as zero', () => {
    const e = editableFrom(CUP);
    expect(readRules(e, { limit: '', seconds: ' ', techPauses: '0', grace: '20', ...T5 })).toEqual({
      ok: true, value: { ...e, pause: { ...e.pause, limit: null, seconds: null, techPauses: 0 }, noShowGraceMinutes: 20 },
    });
    expect(readRules(e, { limit: '0', seconds: '60', techPauses: '1', grace: '5', ...T5 })).toMatchObject({ ok: true, value: { pause: { limit: 0, seconds: 60 } } });
  });

  it('refuses a blank grace or technical pauses and anything not a whole number', () => {
    const e = editableFrom(CUP);
    expect(readRules(e, { limit: '3', seconds: '120', techPauses: '2', grace: '', ...T5 })).toEqual({ ok: false, error: 'No-show grace needs a whole number.' });
    expect(readRules(e, { limit: '3', seconds: '120', techPauses: '', grace: '15', ...T5 })).toEqual({ ok: false, error: 'Technical pauses needs a whole number.' });
    expect(readRules(e, { limit: '2.5', seconds: '120', techPauses: '2', grace: '15', ...T5 }))
      .toEqual({ ok: false, error: 'Pauses per team needs a whole number, or leave it blank.' });
  });

  it('reads the Tournament play numbers, refusing a blank one with its label (plan T5)', () => {
    const e = editableFrom(CUP);
    const t = { ...typedFrom(e), techSeconds: '240', reconnect: '900', subs: '3', subCharge: '30', cooldown: '90', nextGame: '120' };
    expect(readRules(e, t)).toEqual({ ok: true, value: {
      ...e, pause: { ...e.pause, techSeconds: 240 }, disconnect: { teamSeconds: 900 }, subs: { ...e.subs, perMatch: 3, emergencyChargeSeconds: 30 },
      staffCall: { cooldownSeconds: 90 }, series: { nextGameSeconds: 120 },
    } });
    expect(readRules(e, { ...t, reconnect: '' })).toEqual({ ok: false, error: 'Reconnect time needs a whole number.' });
    expect(readRules(e, { ...t, nextGame: '1.5' })).toEqual({ ok: false, error: 'Next game after needs a whole number.' });
  });
});
