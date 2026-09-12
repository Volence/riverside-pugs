import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { VersusHeader } from './VersusHeader';

afterEach(cleanup);

describe('VersusHeader', () => {
  it('lists both rosters and colors the leading score gold', () => {
    render(
      <VersusHeader
        teamA={['volence', 'dev_0001']} teamB={['Vodka', 'zeppelin']}
        scoreA={412} scoreB={289}
        eyebrowA="Team A · survivors first" eyebrowB="Team B · infected first"
      />,
    );
    expect(screen.getByText('volence · dev_0001')).toBeTruthy();
    expect(screen.getByText('Vodka · zeppelin')).toBeTruthy();
    expect(screen.getByText('412').classList.contains('versus__score--lead')).toBe(true);
    expect(screen.getByText('289').classList.contains('versus__score--lead')).toBe(false);
    expect(screen.getByText('Team A · survivors first')).toBeTruthy();
  });

  it('marks neither score on a tie', () => {
    render(<VersusHeader teamA={['a']} teamB={['b']} scoreA={100} scoreB={100} />);
    for (const el of screen.getAllByText('100')) {
      expect(el.classList.contains('versus__score--lead')).toBe(false);
    }
  });
});
