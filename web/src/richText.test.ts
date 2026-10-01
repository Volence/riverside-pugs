import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInline, parseRichText, safeHref, RICH_TEXT_MAX, type Block, type Inline } from './richText';

const t = (text: string): Inline => ({ kind: 'text', text });
const p = (...children: Inline[]): Block => ({ kind: 'paragraph', children });

describe('blocks', () => {
  it('reads headings of three levels, and a fourth # as text', () => {
    expect(parseRichText('# One\n## Two\n### Three\n#### Four')).toEqual([
      { kind: 'heading', level: 1, children: [t('One')] },
      { kind: 'heading', level: 2, children: [t('Two')] },
      { kind: 'heading', level: 3, children: [t('Three')] },
      p(t('#### Four')),
    ]);
    expect(parseRichText('#NoSpace')).toEqual([p(t('#NoSpace'))]);
  });

  it('joins lines into a paragraph with breaks, and a blank line starts the next', () => {
    expect(parseRichText('one\ntwo\r\n\r\nthree')).toEqual([p(t('one'), { kind: 'br' }, t('two')), p(t('three'))]);
    expect(parseRichText('')).toEqual([]);
    expect(parseRichText('\n\n  \n')).toEqual([]);
  });

  it('reads bullet and numbered lists, and a change of kind starts a new list', () => {
    expect(parseRichText('- a\n* b\n+ c\n1. d\n2) e\nafter')).toEqual([
      { kind: 'list', ordered: false, items: [[t('a')], [t('b')], [t('c')]] },
      { kind: 'list', ordered: true, items: [[t('d')], [t('e')]] },
      p(t('after')),
    ]);
    expect(parseRichText('intro\n- item')).toEqual([p(t('intro')), { kind: 'list', ordered: false, items: [[t('item')]] }]);
  });
});

describe('inlines', () => {
  it('reads bold and italic, nested either way', () => {
    expect(parseInline('**bold** and *it*')).toEqual([
      { kind: 'strong', children: [t('bold')] }, t(' and '), { kind: 'em', children: [t('it')] },
    ]);
    expect(parseInline('**a *b* c**')).toEqual([{ kind: 'strong', children: [t('a '), { kind: 'em', children: [t('b')] }, t(' c')] }]);
  });

  it('leaves unmatched or empty markers as text', () => {
    expect(parseInline('**open')).toEqual([t('**open')]);
    expect(parseInline('a * b')).toEqual([t('a * b')]);
    expect(parseInline('****')).toEqual([t('****')]);
    expect(parseInline('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
  });

  it('links [text](url) and bare URLs, http and https only', () => {
    expect(parseInline('[Rules](https://example.com/r) here')).toEqual([
      { kind: 'link', href: 'https://example.com/r', children: [t('Rules')] }, t(' here'),
    ]);
    expect(parseInline('See https://example.com/a, then http://x.org.')).toEqual([
      t('See '), { kind: 'link', href: 'https://example.com/a', children: [t('https://example.com/a')] },
      t(', then '), { kind: 'link', href: 'http://x.org/', children: [t('http://x.org')] }, t('.'),
    ]);
    expect(parseInline('[**Big**](https://e.com)')).toEqual([{ kind: 'link', href: 'https://e.com/', children: [{ kind: 'strong', children: [t('Big')] }] }]);
  });

  it('shows any other link as the text it is', () => {
    for (const src of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](data:text/html,hi)', '[x](//evil.com)', '[x](mailto:a@b.c)', '[x](https://)']) {
      expect(parseInline(src), src).toEqual([t(src)]);
    }
    expect(parseInline('javascript:alert(1)')).toEqual([t('javascript:alert(1)')]);
  });

  it('never puts a link inside a link', () => {
    expect(parseInline('[see https://a.com](https://b.com)')).toEqual([
      { kind: 'link', href: 'https://b.com/', children: [t('see https://a.com')] },
    ]);
  });
});

describe('hostile input', () => {
  it('keeps HTML as plain text', () => {
    expect(parseRichText('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')).toEqual([
      p(t('<script>alert(1)</script>'), { kind: 'br' }, t('<img src=x onerror=alert(1)>')),
    ]);
  });

  it('stops nesting after a few levels and still keeps every character', () => {
    const deep = '*'.repeat(40) + 'x' + '*'.repeat(40);
    const text = (n: Inline[]): string => n.map((x) => (x.kind === 'text' ? x.text : x.kind === 'br' ? '\n' : text(x.children))).join('');
    const out = parseInline(deep);
    expect(text(out).replace(/\*/g, '')).toBe('x');
  });

  it('parses very long input quickly, and no further than the cap', () => {
    const nasty = ['*'.repeat(9000), '['.repeat(9000), '[a]('.repeat(3000), 'https://'.repeat(1500), '**a'.repeat(4000)];
    for (const src of nasty) {
      const start = performance.now();
      const blocks = parseRichText(src);
      expect(performance.now() - start).toBeLessThan(500);
      expect(JSON.stringify(blocks).length).toBeLessThan(RICH_TEXT_MAX * 20);
    }
  });

  it('accepts only http and https URLs as links', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    expect(safeHref(' http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://exa mple.com')).toBeNull();
    expect(safeHref('ftp://example.com')).toBeNull();
  });

  it('the formatter and its component never build HTML strings', () => {
    for (const f of ['./richText.ts', './components/RichText.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });
});
