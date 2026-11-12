import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { Autoexec } from './Autoexec';

describe('Autoexec builder', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('writes a typed hex colour into the cfg, as a legal float', () => {
    render(<Autoexec />);
    const hex = screen.getByLabelText('Teammate hex code') as HTMLInputElement;
    fireEvent.input(hex, { target: { value: '#ff8000' } });
    const pre = document.querySelector('.ax__cfg pre')!;
    expect(pre.textContent).toContain('cl_glow_survivor_r "1"');
    expect(pre.textContent).toContain('cl_glow_survivor_g "0.502"');
    expect(pre.textContent).toContain('cl_glow_survivor_b "0"');
  });

  it('ignores a hex code that is not a colour', () => {
    render(<Autoexec />);
    fireEvent.input(screen.getByLabelText('Teammate hex code'), { target: { value: '#xyz123' } });
    expect(document.querySelector('.ax__cfg pre')!.textContent).toContain('cl_glow_survivor_r "0.3"');
  });

  it('edits the colour-blind variant while that set is on', () => {
    render(<Autoexec />);
    fireEvent.click(screen.getByLabelText(/Edit and preview the colour-blind set/));
    fireEvent.input(screen.getByLabelText('Ability hex code'), { target: { value: '#00ff00' } });
    const text = document.querySelector('.ax__cfg pre')!.textContent!;
    expect(text).toContain('cl_glow_ability_colorblind_g "1"');
    expect(text).toContain('cl_glow_ability_r "1"');
  });

  it('labels the shared outline with the picked glow', () => {
    render(<Autoexec />);
    expect(screen.queryByText('Ghost teammate', { selector: '.ax__tag' })).toBeNull();
    fireEvent.click(screen.getByText('Ghost teammate', { selector: '.ax__name span' }));
    expect(screen.getByText('Ghost teammate', { selector: '.ax__tag' })).toBeTruthy();
  });
});
