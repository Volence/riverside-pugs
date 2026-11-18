import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { MIRROR_PACK_SAME_FILES, MIRROR_PACK_URL, MirrorPack, gotAnyMirror } from './MirrorPack';

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

  it('counts an earlier zip with the same maps as downloaded, and any other old one as updated', () => {
    expect(MIRROR_PACK_SAME_FILES.length).toBeGreaterThan(0);
    expect(MIRROR_PACK_SAME_FILES).not.toContain(MIRROR_PACK_URL);
    localStorage.setItem('mirror-downloads', JSON.stringify({ all: MIRROR_PACK_SAME_FILES[0] }));
    render(<MirrorPack />);
    expect(document.querySelector('#mirror-pack .btn')!.textContent).toContain('Downloaded');
    expect(document.querySelector('#mirror-pack .btn')!.textContent).not.toContain('Updated');
    cleanup();
    localStorage.setItem('mirror-downloads', JSON.stringify({ all: 'https://assets.riversidepug.com/mappack/some-older.zip' }));
    render(<MirrorPack />);
    expect(document.querySelector('#mirror-pack .btn')!.textContent).toContain('Updated');
  });
});
