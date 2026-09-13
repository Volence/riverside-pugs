// web/src/styles/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { relativeLuminance } from '../replay/colorDistance';

const ROOT = join(__dirname, '..');
const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

/** `--name: value;` pairs from the :root block. */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('tokens.css', () => {
  const t = tokens();

  it('keeps body and muted text above AA on every surface they sit on', () => {
    for (const bg of ['bg', 'surface', 'surface-2']) {
      expect(contrast(t.text, t[bg]), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['text-bright'], t[bg]), `text-bright on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['text-muted'], t[bg]), `text-muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the accent usable as link text on the page and on panels', () => {
    expect(contrast(t.accent, t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.accent, t.surface)).toBeGreaterThanOrEqual(4.5);
    // The rating and win colors are used as text too.
    expect(contrast(t.rating, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.win, t.surface)).toBeGreaterThanOrEqual(4.5);
    // Ink on a filled accent button.
    expect(contrast(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('names the three fonts and nothing else', () => {
    expect(t['font-display']).toMatch(/^"Anton"/);
    expect(t['font-label']).toMatch(/^"Oswald"/);
    expect(t['font-body']).toMatch(/^"IBM Plex Sans"/);
    expect(css).not.toMatch(/Barlow/);
  });

  it('has square corners', () => {
    expect(t.radius).toBe('0');
    expect(t['radius-lg']).toBe('2px');
  });

  it('has retired amber and the old gold everywhere under web/src', () => {
    const forbidden = [
      /#e3892b/i, /#1a1206/i, /#f2cd6a/i, /227 137 43/, /242 205 106/, /Barlow/,
      /#e8b04b/i, /#7ec95e/i, /#d9534f/i, /#e35d5d/i, /#11130f/i, /#23261e/i,
    ];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const re of forbidden) expect(src, `${file} contains ${re}`).not.toMatch(re);
    }
  });
});
