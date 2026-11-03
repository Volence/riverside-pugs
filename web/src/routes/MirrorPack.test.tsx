import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { MIRROR_PACK_URL, MirrorPack, gotAnyMirror } from './MirrorPack';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('mirror pack download', () => {
  it('offers the one zip, points at the L4D2 pack, and remembers the download', () => {
    render(<MirrorPack />);
    const links = [...document.querySelectorAll<HTMLAnchorElement>('#mirror-pack a')];
    expect(new Set(links.filter((a) => a.href.endsWith('.zip')).map((a) => a.href))).toEqual(new Set([MIRROR_PACK_URL]));
    expect(document.querySelector('#mirror-pack a[href="#l4d2-pack"]')).not.toBeNull();
    expect(gotAnyMirror()).toBe(false);
    fireEvent.click(document.querySelector('#mirror-pack .btn')!);
    expect(gotAnyMirror()).toBe(true);
    expect(document.querySelector('#mirror-pack .btn')!.textContent).toContain('Downloaded');
  });
});
