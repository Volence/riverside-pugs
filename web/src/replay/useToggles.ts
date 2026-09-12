import { useCallback, useState } from 'preact/hooks';

export interface Toggles {
  hp: boolean;
  guns: boolean;
  events: boolean;
  chat: boolean;
  ci: boolean;
  entities: boolean;
  names: boolean;
}

export const DEFAULT_TOGGLES: Toggles = {
  hp: true, guns: false, events: true, chat: true,
  ci: true, entities: true, names: true,
};

const KEY = 'replay.toggles';

/** Merge over the defaults rather than trusting what was stored.
 *
 *  Storage outlives releases. A value written before a toggle existed has no
 *  key for it, and spreading the defaults first is what stops that reading as
 *  "off" forever with no way for the user to find out why. */
export function readToggles(raw: string | null): Toggles {
  if (!raw) return DEFAULT_TOGGLES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_TOGGLES;
    return { ...DEFAULT_TOGGLES, ...(parsed as Partial<Toggles>) };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

export function useToggles(): [Toggles, (k: keyof Toggles) => void] {
  const [toggles, setToggles] = useState<Toggles>(() => {
    try {
      return readToggles(localStorage.getItem(KEY));
    } catch {
      // Private browsing and blocked site data both throw on access rather
      // than returning null.
      return DEFAULT_TOGGLES;
    }
  });

  const toggle = useCallback((k: keyof Toggles) => {
    setToggles((t) => {
      const next = { ...t, [k]: !t[k] };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not fatal */ }
      return next;
    });
  }, []);

  return [toggles, toggle];
}
