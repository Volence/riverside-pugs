import { describe, it, expect } from 'vitest';
import { consoleText, quoted } from '../src/serverSetup.js';

describe('consoleText', () => {
  it('breaks up // so the console never reads the rest of the line as a comment', () => {
    expect(consoleText('(S)VI // Square4 Bass', 60)).toBe('(S)VI / / Square4 Bass');
    expect(consoleText('a///b', 60)).toBe('a/ / /b');
    expect(consoleText('a/"/b', 60)).toBe('a/ /b');
    expect(consoleText('a/b', 60)).toBe('a/b');
  });

  it('still drops quotes, semicolons and line breaks, and replaces non-ASCII', () => {
    expect(consoleText('a"b;c\nd ü', 60)).toBe('abcd ?');
  });

  it('cuts after neutralizing, so a cut never leaves a // behind', () => {
    expect(consoleText('ab//', 3)).toBe('ab/');
  });

  it('quoted() still takes a URL: inside quotes // is not a comment', () => {
    expect(quoted('https://riversidepug.com')).toBe('"https://riversidepug.com"');
  });
});
