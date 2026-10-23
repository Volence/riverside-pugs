import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { DocLayout } from './DocLayout';
import { notesBlocks } from '../routes/balance/PatchEntryView';

afterEach(cleanup);

describe('DocLayout', () => {
  it('links each section in order', () => {
    const { container } = render(
      <DocLayout sections={[{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }]}>
        <section id="a" /><section id="b" />
      </DocLayout>,
    );
    const links = [...container.querySelectorAll('.doc__toc a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#a', '#b']);
    expect(links.map((a) => a.textContent)).toEqual(['First', 'Second']);
  });

  it('leaves the index out for a single section', () => {
    const { container } = render(<DocLayout sections={[{ id: 'a', label: 'Only' }]}><section id="a" /></DocLayout>);
    expect(container.querySelector('.doc__toc')).toBeNull();
  });
});

describe('notesBlocks', () => {
  it('reads a heading, a bullet list and plain paragraphs', () => {
    const text = 'Tanks moved. No more insta tanks.\n\nMap changes\n• No Mercy 1: later.\n• Dead Air 2: earlier.\n\nWeapon lock during tank\nWhile a tank is alive, you cannot swap.\nAmmo still works.';
    expect(notesBlocks(text)).toEqual([
      { heading: null, items: [], para: 'Tanks moved. No more insta tanks.' },
      { heading: 'Map changes', items: ['No Mercy 1: later.', 'Dead Air 2: earlier.'], para: null },
      { heading: 'Weapon lock during tank', items: [], para: 'While a tank is alive, you cannot swap.\nAmmo still works.' },
    ]);
  });

  it('keeps a one-line block and a sentence with a colon as paragraphs', () => {
    expect(notesBlocks('Unchanged: finales and every other ban.')).toEqual([
      { heading: null, items: [], para: 'Unchanged: finales and every other ban.' },
    ]);
    expect(notesBlocks('Note:\nsomething')[0].heading).toBeNull();
  });
});
