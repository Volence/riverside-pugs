import { describe, it, expect } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import { useCanvasSize, type CanvasSize } from './canvasSize';
import { canvasForAspect } from '../../../src/mapTransform';

const ASPECT = 0.7364;   // l4d_vs_farm04_barn: a portrait map

/**
 * A host for the hook that reports every size it renders with, and fakes the
 * layout happy-dom does not do: `clientWidth` is patched onto the element
 * before the hook's own ref callback sees it, so the effect's first read
 * finds a real width.
 */
function Probe(
  { mounted, width, sizes }: { mounted: boolean; width: number; sizes: CanvasSize[] },
) {
  const { size, ref } = useCanvasSize(ASPECT);
  sizes.push(size);
  const attach = (el: HTMLElement | null) => {
    if (el) Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    ref(el);
  };
  return mounted ? <div ref={attach} /> : <span>loading</span>;
}

describe('useCanvasSize', () => {
  it('falls back to the budget canvas for this shape until something is measured', () => {
    const sizes: CanvasSize[] = [];
    render(<Probe mounted={false} width={0} sizes={sizes} />);
    expect(sizes[0].cssW).toBe(canvasForAspect(ASPECT).width);
    expect(sizes[0].cssW / sizes[0].cssH).toBeCloseTo(ASPECT, 6);
  });

  // The element does not exist on the first render: the viewer shows a
  // loading line until the replay header arrives, and only then is there a
  // stage to measure. An effect keyed on a ref OBJECT runs once against null
  // and never looks again, which left the canvas stuck at its fallback size
  // forever. This is that bug.
  it('measures an element that only appears on a later render', async () => {
    const sizes: CanvasSize[] = [];
    const { rerender } = render(<Probe mounted={false} width={0} sizes={sizes} />);
    rerender(<Probe mounted width={640} sizes={sizes} />);
    await waitFor(() => {
      expect(sizes[sizes.length - 1].cssW).toBe(640);
    });
    const last = sizes[sizes.length - 1];
    expect(last.cssH).toBeCloseTo(640 / ASPECT, 6);
    expect(last.pixelW).toBe(Math.round(640 * last.ratio));
  });
});
