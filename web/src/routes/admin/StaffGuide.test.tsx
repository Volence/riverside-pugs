import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { StaffGuide } from './StaffGuide';
import { LILAC_CHEATS } from '../../../../src/integrityFlags';
import { SIGNATURES } from '../../../../src/inputStats';

afterEach(cleanup);

describe('StaffGuide', () => {
  it('every index link lands on a section of the page', () => {
    const { container } = render(<StaffGuide />);
    const links = [...container.querySelectorAll('nav a')].map((a) => a.getAttribute('href')!.slice(1));
    expect(links.length).toBeGreaterThan(5);
    for (const id of links) expect(container.querySelector(`#${id}`), id).not.toBeNull();
  });

  // A new input signature or a LilAC cheat this guide cannot explain would
  // reach Needs a look with nothing for a moderator to read. noisemaker_spam
  // is TF2's and macro is off on our servers (lilac_macro 0), so neither can
  // arrive.
  it('explains every input signature and every LilAC cheat that can arrive', () => {
    const { container } = render(<StaffGuide />);
    const text = container.textContent!;
    for (const sig of SIGNATURES) expect(text, sig.name).toContain(sig.name);
    for (const name of Object.values(LILAC_CHEATS)) {
      if (name === 'noisemaker_spam' || name === 'macro') continue;
      expect(text, name).toContain(name);
    }
  });
});
