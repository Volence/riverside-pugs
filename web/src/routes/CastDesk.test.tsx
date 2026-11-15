import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import CastDesk from './CastDesk';

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });

describe('caster desk', () => {
  it('shows both sides as HP numbers, items, flow and the box score from the feed', () => {
    history.replaceState(null, '', '/cast/desk?sample');
    const { container } = render(<CastDesk />);
    const surv = [...container.querySelectorAll('.desk__surv tbody tr')].map((r) => r.querySelector('.desk__hp')?.textContent);
    // Sample: 71, 38+22 temp, 210 while down, 100.
    expect(surv).toEqual(['71', '60', '210', '100']);
    expect(container.querySelector('.desk__surv tbody tr:nth-child(2)')?.textContent).toContain('+22');
    expect(container.querySelector('.desk__surv tbody tr:nth-child(3) .desk__state')?.textContent).toBe('Down');
    const inf = [...container.querySelectorAll('.desk__inf tbody tr')].map((r) => r.querySelector('.desk__hp')?.textContent);
    expect(inf).toEqual(['250', '4,200', '-', '-']);
    expect(container.querySelector('.desk__tank')?.textContent).toContain('/ 6,000');
    expect(container.querySelector('.desk__surv')?.textContent).toContain('Kit Pills Molly');
    expect(container.querySelectorAll('.desk__boxtable tbody').length).toBe(2);
    expect(container.querySelector('.desk__maptable')?.textContent).toContain('(now)');
  });
});
