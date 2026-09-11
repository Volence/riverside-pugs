import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, eventKindDef, isKnownEventKind, eventKindKeys } from '../src/eventKinds.js';

describe('event kind registry', () => {
  it('has unique kinds', () => {
    const keys = EVENT_KINDS.map((d) => d.kind);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the same slug shape the plugin regex accepts', () => {
    // src/logParse.ts validates kind against /^[a-z_]{1,24}$/. A kind that
    // fails this is dropped on the wire and would never reach the database.
    for (const d of EVENT_KINDS) expect(d.kind).toMatch(/^[a-z_]{1,24}$/);
  });

  it('keeps the legacy dp kind, which is already in production data', () => {
    expect(isKnownEventKind('dp')).toBe(true);
  });

  it('gives every kind a verb for the feed', () => {
    for (const d of EVENT_KINDS) expect(d.verb.length).toBeGreaterThan(0);
  });

  it('resolves a known kind and rejects an unknown one', () => {
    expect(eventKindDef('pinned')?.side).toBe('infected');
    expect(eventKindDef('cleared')?.side).toBe('survivor');
    expect(eventKindDef('not_a_kind')).toBeUndefined();
    expect(isKnownEventKind('not_a_kind')).toBe(false);
  });

  it('lists every kind', () => {
    expect(eventKindKeys()).toHaveLength(EVENT_KINDS.length);
  });
});
