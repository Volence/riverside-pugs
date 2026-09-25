import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/preact';
import { CrosshairBuilder } from './Builder';
import { DEFAULT_STATE, PRESETS } from './draw';
import { LIMITS } from './model';

afterEach(cleanup);

describe('CrosshairBuilder', () => {
  const setup = (state = DEFAULT_STATE, withImage = false) => {
    const set = vi.fn();
    const end = vi.fn();
    render(<CrosshairBuilder state={state} set={set} end={end} withImage={withImage} />);
    return { set, end };
  };

  it('moves a slider as a gesture, ended when the slider is let go', () => {
    const { set, end } = setup();
    const len = screen.getByRole('slider', { name: 'Length' });
    fireEvent.input(len, { target: { value: '12' } });
    expect(set).toHaveBeenLastCalledWith({ len: 12 }, true);
    expect(end).not.toHaveBeenCalled();
    fireEvent.change(len);
    expect(end).toHaveBeenCalledOnce();
  });

  it("gives every slider the range readState clamps to", () => {
    setup({ ...DEFAULT_STATE, shape: 'crossdot' });
    for (const [label, key] of [['Length', 'len'], ['Thickness', 'thick'], ['Gap', 'gap'], ['Dot size', 'dot']] as const) {
      const el = screen.getByRole('slider', { name: label }) as HTMLInputElement;
      expect([+el.min, +el.max, +el.step], label).toEqual([...LIMITS[key]]);
    }
    const [colour, outline] = screen.getAllByRole('slider', { name: 'Opacity' }) as HTMLInputElement[];
    expect([+colour.min, +colour.max]).toEqual(LIMITS.alpha.slice(0, 2));
    expect([+outline.min, +outline.max]).toEqual(LIMITS.oalpha.slice(0, 2));
  });

  it('applies a preset, a shape, a swatch and rounded ends as single steps', () => {
    const { set } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Dot' }));
    expect(set).toHaveBeenLastCalledWith(PRESETS.Dot);
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape' }), { target: { value: 't' } });
    expect(set).toHaveBeenLastCalledWith({ shape: 't' });
    fireEvent.click(screen.getByRole('button', { name: '#ffffff' }));
    expect(set).toHaveBeenLastCalledWith({ color: '#ffffff' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rounded ends' }));
    expect(set).toHaveBeenLastCalledWith({ round: true });
  });

  it('picks a colour as a gesture too, since the picker fires on every drag of it', () => {
    const { set, end } = setup();
    const picker = screen.getByLabelText('Colour');
    fireEvent.input(picker, { target: { value: '#123456' } });
    expect(set).toHaveBeenLastCalledWith({ color: '#123456' }, true);
    fireEvent.change(picker);
    expect(end).toHaveBeenCalledOnce();
  });

  it("offers the image shape only where the page can import one", () => {
    setup();
    expect(screen.queryByRole('option', { name: 'Imported image' })).toBeNull();
    cleanup();
    setup(DEFAULT_STATE, true);
    expect(screen.getByRole('option', { name: 'Imported image' })).toBeTruthy();
  });
});
