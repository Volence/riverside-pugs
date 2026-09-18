import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { HudStrip } from './HudStrip';
import { STATE, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';

afterEach(cleanup);

const HEADER: ReplayHeader = {
  version: 2, token: '', ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'l4d_hospital01_apartment',
  startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
  slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  infectedMask: 0,
  sidesKnown: false,
};
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };

function players(): PlayerSample[] {
  return Array.from({ length: 8 }, (_, slot) => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
  }));
}

describe('HudStrip', () => {
  it('renders two labelled rows by default', () => {
    const { container } = render(
      <HudStrip players={players()} header={HEADER} names={NAMES} showHp showGuns={false} />,
    );
    expect(container.querySelectorAll('.hud-row')).toHaveLength(2);
    expect(container.querySelectorAll('.hudp')).toHaveLength(8);
  });

  // A survivor on 1 permanent and 90 temporary is not one hit from death, but
  // the readout said "1" and only the bar hinted otherwise.
  it('shows temporary health alongside permanent health', () => {
    const ps = players();
    ps[0] = { ...ps[0], health: 1, temp: 90 };
    const { container } = render(
      <HudStrip players={ps} header={HEADER} names={NAMES} showHp showGuns={false} />,
    );
    const hp = container.querySelector('.hudp__hp')!;
    expect(hp.textContent).toBe('1+90');
    expect(hp.querySelector('.hudp__hp-temp')!.textContent).toBe('+90');
  });

  it('shows no temporary reading when there is none', () => {
    const { container } = render(
      <HudStrip players={players()} header={HEADER} names={NAMES} showHp showGuns={false} />,
    );
    expect(container.querySelector('.hudp__hp')!.textContent).toBe('100');
    expect(container.querySelector('.hudp__hp-temp')).toBeNull();
  });

  // healthBar zeroes temp for a downed survivor on purpose: the record's temp
  // is whatever it was before they went down, and the number beside the bar
  // is a bleed-out reading rather than health.
  it('shows no temporary reading for a downed survivor', () => {
    const ps = players();
    ps[0] = { ...ps[0], state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP, health: 250, temp: 90 };
    const { container } = render(
      <HudStrip players={ps} header={HEADER} names={NAMES} showHp showGuns={false} />,
    );
    expect(container.querySelector('.hudp__hp-temp')).toBeNull();
  });

  it('renders survivors down the left edge and infected down the right in slot order', () => {
    const { container } = render(
      <HudStrip players={players()} header={HEADER} names={NAMES} showHp showGuns={false} layout="edges" />,
    );
    const left = [...container.querySelectorAll('.hud-edge--l .hudp__name')].map((n) => n.textContent);
    const right = [...container.querySelectorAll('.hud-edge--r .hudp__name')].map((n) => n.textContent);
    expect(left).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(right).toEqual(['smk', 'boom', 'hunt', 'tank']);
    expect(container.querySelector('.hud-row__label')).toBeNull();
  });
});
