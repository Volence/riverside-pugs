import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { RichText } from './RichText';

afterEach(cleanup);

describe('RichText', () => {
  it('renders each construct as its element', () => {
    const { container } = render(<RichText text={'# Title\n## Sub\n### Small\nA **b** *c*\nnext\n\n- one\n- two\n\n1. first\n\n[Site](https://riversidepug.com) https://example.com'} />);
    expect(container.querySelector('h3')?.textContent).toBe('Title');
    expect(container.querySelector('h4')?.textContent).toBe('Sub');
    expect(container.querySelector('h5')?.textContent).toBe('Small');
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('c');
    expect(container.querySelector('br')).toBeTruthy();
    expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['first']);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['Site', 'https://riversidepug.com/', '_blank', 'noopener noreferrer'],
      ['https://example.com', 'https://example.com/', '_blank', 'noopener noreferrer'],
    ]);
  });

  it('shows tags, entities and other schemes as text, never as markup', () => {
    const { container } = render(<RichText text={'<img src=x onerror="alert(1)"> &amp; [x](javascript:alert(1)) <a href="https://e.com">y</a>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://e.com/');
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> &amp; [x](javascript:alert(1)) <a href="');
  });
});
