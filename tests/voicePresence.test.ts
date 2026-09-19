import { describe, it, expect } from 'vitest';
import { VoicePresence } from '../src/discord/voicePresence.js';

describe('VoicePresence', () => {
  it('answers null until the gateway has reported voice states', () => {
    const v = new VoicePresence();
    expect(v.inVoice('1')).toBeNull();
  });

  it('knows who is in a channel after the initial load', () => {
    const v = new VoicePresence();
    v.setAll([['1', 'chan-a'], ['2', 'chan-b']]);
    expect(v.inVoice('1')).toBe(true);
    expect(v.inVoice('3')).toBe(false);
  });

  it('tracks joins, moves and leaves', () => {
    const v = new VoicePresence();
    v.setAll([]);
    v.update('1', 'chan-a');
    expect(v.inVoice('1')).toBe(true);
    v.update('1', 'chan-b');
    expect(v.inVoice('1')).toBe(true);
    v.update('1', null);
    expect(v.inVoice('1')).toBe(false);
  });

  it('tells listeners when someone leaves voice, not when they move', () => {
    const v = new VoicePresence();
    const left: string[] = [];
    v.onLeave((id) => left.push(id));
    v.setAll([['1', 'chan-a']]);
    v.update('1', 'chan-b');
    expect(left).toEqual([]);
    v.update('1', null);
    expect(left).toEqual(['1']);
  });

  it('a leave event before the load is known still reaches listeners', () => {
    const v = new VoicePresence();
    const left: string[] = [];
    v.onLeave((id) => left.push(id));
    v.update('1', null);
    expect(left).toEqual(['1']);
    expect(v.inVoice('1')).toBeNull();
  });

  it('a throwing listener does not stop the others', () => {
    const v = new VoicePresence();
    const left: string[] = [];
    v.onLeave(() => { throw new Error('boom'); });
    v.onLeave((id) => left.push(id));
    v.setAll([['1', 'a']]);
    v.update('1', null);
    expect(left).toEqual(['1']);
  });

  it('reset forgets everything, back to unknown', () => {
    const v = new VoicePresence();
    v.setAll([['1', 'a']]);
    v.reset();
    expect(v.inVoice('1')).toBeNull();
  });
});
