/**
 * The canvas's right-click menu: a short list of what can be done to the
 * thing under the pointer. It closes on a press anywhere outside it, on
 * Escape, and once an item has run; focus moves into it when it opens so
 * the keyboard can reach it.
 */
import { useEffect, useRef } from 'preact/hooks';

export interface MenuItem { label: string; run: () => void }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  // The latest onClose, so the window listeners (added once) never call a stale one.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, []);

  return (
    <ul ref={ref} class="hud__menu" role="menu" style={{ left: `${x}px`, top: `${y}px` }}>
      {items.map((it) => (
        <li key={it.label} role="none">
          <button type="button" role="menuitem" onClick={() => { it.run(); close.current(); }}>{it.label}</button>
        </li>
      ))}
    </ul>
  );
}
