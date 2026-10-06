import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { presetConfig } from '../../../../../src/events/vetoConfig';
import { VetoFields } from './VetoFields';

afterEach(cleanup);

describe('VetoFields', () => {
  it('fills the knobs from a preset and states the format in one sentence', () => {
    const change = vi.fn();
    render(<VetoFields value={presetConfig('ban_to_one', 7)} poolSize={7} onChange={change} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Veto format' }), { target: { value: 'loser_picks' } });
    expect(change).toHaveBeenCalledWith(presetConfig('loser_picks', 7));
  });

  it('reads Custom after a knob changes, and explains a config that cannot run', () => {
    const change = vi.fn();
    const { rerender } = render(<VetoFields value={presetConfig('loser_picks', 7)} poolSize={7} onChange={change} />);
    expect((screen.getByRole('combobox', { name: 'Veto format' }) as HTMLSelectElement).value).toBe('loser_picks');
    expect(screen.getByText(/the loser of each game picks the next/)).toBeTruthy();
    rerender(<VetoFields value={{ ...presetConfig('loser_picks', 7), banTo: 4 }} poolSize={7} onChange={change} />);
    expect((screen.getByRole('combobox', { name: 'Veto format' }) as HTMLSelectElement).value).toBe('custom');
    rerender(<VetoFields value={{ ...presetConfig('loser_picks', 7), banTo: 2 }} poolSize={7} onChange={change} />);
    expect(screen.getByText('Ban down to at least one campaign per game.')).toBeTruthy();
  });

  it('hides the knobs a Bo1 does not use', () => {
    render(<VetoFields value={presetConfig('ban_to_one', 7)} poolSize={7} onChange={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Later games' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Game 1 is picked by' })).toBeNull();
  });

  it('disables a preset the pool is too small for', () => {
    render(<VetoFields value={presetConfig('ban_to_one', 2)} poolSize={2} onChange={() => {}} />);
    expect((screen.getByRole('option', { name: /Pick and ban \(Bo3\) \(needs 5 campaigns\)/ }) as HTMLOptionElement).disabled).toBe(true);
  });
});
