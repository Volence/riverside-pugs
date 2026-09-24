import { describe, expect, it } from 'vitest';
import { findSlurs } from '../src/slurs.js';

describe('findSlurs', () => {
  // Every one of these is a real line (or a real name) from the chat history
  // scan of 2026-09-23, matches 13 to 147.
  it.each([
    'nigger',
    'nigga',
    'NIgga theres no nametags',
    'these niggas dont even land them half the time thats the worst part',
    'bitch ass nigga',
    'shut up nga',
    'niggascheating',
    'me dijeron que kong es nigga',
    'faggot pause',
    'Harry Fagger',
    'retards',
    'fake crash to get 4 spawns in tight retarded hallway with ai tank',
    'You\'re a retard',
    'my retarded nephew',
  ])('flags the real line %j', (line) => {
    expect(findSlurs(line)).not.toEqual([]);
  });

  it.each([
    ['n i g g a', 'spaced letters'],
    ['n.i.g.g.e.r', 'dotted letters'],
    ['n1gg3r', 'leetspeak'],
    ['niqqa', 'q for g'],
    ['NIIIIGGGGAAAA', 'stretched letters'],
    ['f4gg0t', 'leetspeak'],
    ['kys', 'kys'],
    ['just kill yourself', 'the phrase'],
    ['kill urself lol', 'the short phrase'],
    ['chink', 'ethnic slur'],
    ['spic', 'ethnic slur'],
    ['kike', 'ethnic slur'],
    ['wetback', 'ethnic slur'],
    ['beaner', 'ethnic slur'],
    ['tranny', 'slur'],
    ['maricon', 'Spanish slur'],
  ])('flags %j (%s)', (line) => {
    expect(findSlurs(line)).not.toEqual([]);
  });

  // False positives the matcher must never raise: each is either a real
  // harmless hit from the history scan or an ordinary word that shares letters.
  it.each([
    'blanco y negro / black and white.',
    'negro',
    'gay smoker',
    'Niagara falls',
    'snigger',
    'nice try',
    'night',
    'con',
    'reggae',
    'I can get u early',
    'spice',
    'gg niger delta',
    'fuck you',
    'stfu',
    'bitch',
    'ctmre',
    'retardant foam',
    'a n g e l',
    'n i c e',
    'i n g a m e',
    'hardtarget',
    'skys the limit',
  ])('leaves %j alone', (line) => {
    expect(findSlurs(line)).toEqual([]);
  });

  it('names what it found, once per word', () => {
    expect(findSlurs('nigga nigga faggot')).toEqual(['n-word', 'f-slur']);
  });
});
