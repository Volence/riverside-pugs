import { useCallback, useState } from 'preact/hooks';

export interface Toggles {
  hp: boolean;
  guns: boolean;
  events: boolean;
  chat: boolean;
  ci: boolean;
  entities: boolean;
  names: boolean;
  /** The map key/legend panel (Task 10). A boolean toggle, unlike
   *  `showKind`. */
  key: boolean;
  /** The event kind the Show select is narrowed to, or 'all'. Not a
   *  boolean, so it is excluded from the chip row's toggle keys. */
  showKind: string;
}

export const DEFAULT_TOGGLES: Toggles = {
  hp: true, guns: false, events: true, chat: true,
  ci: true, entities: true, names: true,
  key: false, showKind: 'all',
};

/** The boolean-valued toggle keys, i.e. every key except `showKind` (a
 *  string). `toggle(k)` only ever flips one of these. */
export type BoolToggle = Exclude<keyof Toggles, 'showKind'>;

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

export function useToggles(): [
  Toggles,
  (k: BoolToggle) => void,
  <K extends keyof Toggles>(k: K, v: Toggles[K]) => void,
] {
  const [toggles, setToggles] = useState<Toggles>(() => {
    try {
      return readToggles(localStorage.getItem(KEY));
    } catch {
      // Private browsing and blocked site data both throw on access rather
      // than returning null.
      return DEFAULT_TOGGLES;
    }
  });

  const toggle = useCallback((k: BoolToggle) => {
    setToggles((t) => {
      const next = { ...t, [k]: !t[k] };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not fatal */ }
      return next;
    });
  }, []);

  /** Set one field to an explicit value, for the non-boolean toggles
   *  (`showKind`) that a flip cannot express. */
  const set = useCallback(<K extends keyof Toggles>(k: K, v: Toggles[K]) => {
    setToggles((t) => {
      const next = { ...t, [k]: v };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not fatal */ }
      return next;
    });
  }, []);

  return [toggles, toggle, set];
}
