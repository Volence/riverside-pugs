import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import Hud from './Hud';
import { TEX } from '../crosshair/draw';
import { encodeVPK } from '../vpk';
import { readVPK } from '../vpk/read';
import { memoryStore, _setHudStore, type HudStore } from '../hud/hudStore';
import { unregisterImport, baseFile } from '../hud/base';
import { hudId } from '../hud/upload';
import { sampleHud, asList, dropBlock } from '../hud/importFixtures';
import { encodeShare, validateDesign } from '../hud/design';
import { setupHudTests } from './hudTestKit';

// A switch for the tests of the page's own safety net: with it on, the
// import checks find nothing wrong, so a broken import gets as far as the
// draw, as one the checks miss would.
const checks = vi.hoisted(() => ({ skip: false }));
vi.mock('../hud/importCheck', async (original) => {
  const m = await original<typeof import('../hud/importCheck')>();
  return { ...m, importProblem: (id: string) => (checks.skip ? null : m.importProblem(id)) };
});

setupHudTests();

describe('Importing a HUD', () => {
  const files = sampleHud();
  const vpkFile = () => new File([encodeVPK(asList(files))], 'edgehud.vpk');
  let id = '';
  beforeEach(async () => { _setHudStore(memoryStore()); id = await hudId(files); });
  afterEach(() => { _setHudStore(null); unregisterImport(id); });
  const preset = () => screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement;
  const importFile = (f: File) => fireEvent.change(screen.getByLabelText('Import a HUD file'), { target: { files: [f] } });
  const BANNER = "This design was made on the imported HUD 'edgehud'. Import it again to edit or download it.";
  /** Click Download and hand back the bytes it saved. */
  const downloaded = async (): Promise<Uint8Array> => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:hud'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    return new Uint8Array(await blobs[0].arrayBuffer());
  };

  it('says which pictures an import names but neither ships nor the game has', async () => {
    const bare = sampleHud({ 'materials/vgui/hud/myart.vmt': null, 'materials/vgui/hud/myart.vtf': null });
    const bareId = await hudId(bare);
    try {
      render(<Hud />);
      importFile(new File([encodeVPK(asList(bare))], 'edgehud.vpk'));
      await screen.findByText(/^Imported edgehud\. This HUD names a picture it does not include and the game does not have \(vgui\/hud\/myart\)\./);
    } finally { unregisterImport(bareId); }
  });

  it('says nothing about pictures when the import ships its own', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
  });

  it('imports a .vpk from the Preset select and switches the design to it', async () => {
    render(<Hud />);
    expect(screen.getByRole('option', { name: 'Import a HUD...' })).toBeTruthy();
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    expect(preset().value).toBe(`imported:${id}`);
    expect(screen.getByRole('option', { name: 'Imported: edgehud' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kill / incap notices' })).toBeTruthy();
  });

  it('says in one line why a file is not a HUD, and leaves the design as it was', async () => {
    render(<Hud />);
    importFile(new File([encodeVPK([{ path: 'materials/x.vtf', data: new Uint8Array(4) }])], 'x.vpk'));
    await screen.findByText('This file has no scripts/hudlayout.res, so it is not a HUD');
    expect(preset().value).toBe('stock');
  });

  it("downloads the imported HUD with the upload's own files in it", async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    const got = readVPK(await downloaded());
    expect(got.get('sound/ui/edge.wav')).toEqual(files.get('sound/ui/edge.wav'));
  });

  it('opens a design whose HUD is not in this browser read-only, with Download off, until the HUD is imported again', async () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id, name: 'edgehud' } }));
    render(<Hud />);
    await screen.findByText(BANNER);
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Teammates' })).toBeNull();
    expect(preset().value).toBe(`imported:${id}`);
    importFile(vpkFile());
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
  });

  it('removes an imported HUD from this browser, and a design on it then shows the banner', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'remove' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Imported HUD to remove' }), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText(BANNER);
    expect(screen.queryByRole('option', { name: 'Imported: edgehud' })).toBeNull();
  });

  it('switches back to Stock and onto an import again from the Preset select', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
  });

  it('undoes a switch onto an import and a switch off it, back to the design and preset each started from', async () => {
    // Each switch is one undo step that holds the whole design: the import
    // empties the layout edits and the switch to Stock brings the fitted
    // teammates back, so Undo has to restore those as well as the preset.
    const saved = async (preset: string) => {
      await waitFor(() => expect(JSON.parse(localStorage.getItem('hud') ?? '{}').preset).toBe(preset));
      return JSON.parse(localStorage.getItem('hud')!);
    };
    const undo = () => fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    render(<Hud />);
    const onStock = await saved('stock');
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    const onImport = await saved('imported');
    expect(onImport.elements).toEqual({});
    expect(onStock.elements).not.toEqual({});

    undo();
    await waitFor(() => expect(preset().value).toBe('stock'));
    expect(await saved('stock')).toEqual(onStock);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(await saved('imported')).toEqual(onImport);

    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    expect((await saved('stock')).elements).toEqual(onStock.elements);

    undo();
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(await saved('imported')).toEqual(onImport);
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
  });

  it('still imports when this browser will not store it, and says it lasts only while the page is open', async () => {
    _setHudStore({ ...memoryStore(), put: () => Promise.reject(new Error('quota')) });
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText(/kept only until this page closes/);
    expect(preset().value).toBe(`imported:${id}`);
  });

  it('still imports, switches and downloads when this browser has no working storage at all', async () => {
    const no = () => Promise.reject(new Error('blocked'));
    const broken: HudStore = { get: no, put: no, list: no, delete: no };
    _setHudStore(broken);
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText(/kept only until this page closes/);
    expect(screen.getByRole('option', { name: 'Imported: edgehud' })).toBeTruthy();
    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(readVPK(await downloaded()).get('sound/ui/edge.wav')).toEqual(files.get('sound/ui/edge.wav'));
  });

  it("lists in the download note what the import left out and which of the HUD's files the editor replaced", async () => {
    // A design with a crosshair of its own keeps it on an upload that has no
    // crosshair texture, so the download writes altcrosshair.vmt over the
    // upload's own. gameinfo.txt is never imported.
    localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle', xhairArt: { kind: 'built', state: { shape: 'dot' } } }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, {
      get: (_t, k) => (...a: unknown[]) => {
        if (k === 'getImageData') return { data: new Uint8ClampedArray(TEX * TEX * 4) };
        if (k === 'createImageData') return { data: new Uint8ClampedArray((a[0] as number) * (a[1] as number) * 4) };
        if (k === 'measureText') return { width: 10 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
        return undefined;
      },
      set: () => true,
    }) as never);
    const withExtras = new Map(files);
    withExtras.set('gameinfo.txt', new Uint8Array([1]));
    withExtras.set('materials/vgui/hud/altcrosshair.vmt', new Uint8Array([2]));
    const extrasId = await hudId(new Map([...withExtras].filter(([p]) => p !== 'gameinfo.txt')));
    try {
      render(<Hud />);
      importFile(new File([encodeVPK(asList(withExtras))], 'edgehud.vpk'));
      await screen.findByText('Imported edgehud. Left out: gameinfo.txt.');
      await downloaded();
      await screen.findByText(
        "Saved my_hud.vpk. The editor's own copies replaced these files from your HUD: materials/vgui/hud/altcrosshair.vmt."
        + ' Left out when it was imported: gameinfo.txt.',
        { exact: false },
      );
    } finally { unregisterImport(extrasId); }
  });

  describe('an import the editor cannot show', () => {
    const TEAM = 'resource/ui/hud/teamdisplayhud.res';
    const broken = sampleHud({ [TEAM]: '// blank\r\n' });
    let badId = '';
    let store: HudStore;
    beforeEach(async () => { badId = await hudId(broken); store = memoryStore(); _setHudStore(store); });
    afterEach(() => { unregisterImport(badId); checks.skip = false; });
    /** A broken import already in this browser's store, as one made before the checks were, with the saved design on it. */
    const storedBroken = async () => {
      await store.put({ id: badId, name: 'blank', files: broken, bytes: 1, added: 1 });
      localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id: badId, name: 'blank' } }));
    };

    it('is refused at import in one line naming the file, and is neither stored nor listed', async () => {
      render(<Hud />);
      importFile(new File([encodeVPK(asList(broken))], 'blank.vpk'));
      await screen.findByText(/^This HUD's resource\/ui\/hud\/teamdisplayhud\.res /);
      expect(preset().value).toBe('stock');
      expect(await store.list()).toEqual([]);
      expect(screen.queryByRole('option', { name: 'Imported: blank' })).toBeNull();
    });

    it('is refused at import when it cannot be drawn, though every file has the right shape', async () => {
      const LOCAL = 'resource/ui/hud/localplayerdisplay.res';
      const noLocal = sampleHud({ [LOCAL]: dropBlock(baseFile('stock', LOCAL), 'LocalPlayer') });
      const noLocalId = await hudId(noLocal);
      try {
        render(<Hud />);
        importFile(new File([encodeVPK(asList(noLocal))], 'nolocal.vpk'));
        await screen.findByText(/^This HUD's resource\/ui\/hud\/localplayerdisplay\.res could not be shown \(/);
        expect(preset().value).toBe('stock');
        expect(await store.list()).toEqual([]);
      } finally { unregisterImport(noLocalId); }
    });

    it('when stored before the checks, opens locked with the reason and a way to remove it, and Stock still works', async () => {
      await storedBroken();
      render(<Hud />);
      await screen.findByText(/^The imported HUD 'blank' cannot be shown: This HUD's resource\/ui\/hud\/teamdisplayhud\.res /);
      expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    });

    it('when stored before the checks, is removed from the banner', async () => {
      await storedBroken();
      render(<Hud />);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove this imported HUD' }));
      await waitFor(async () => expect(await store.get(badId)).toBeUndefined());
      await screen.findByText('Removed blank from this browser.');
    });

    it('is caught by the page when it throws while drawing, and the page keeps working', async () => {
      checks.skip = true;
      await storedBroken();
      render(<Hud />);
      await screen.findByText(/^The imported HUD 'blank' cannot be shown: /);
      expect(screen.getByRole('button', { name: 'Remove this imported HUD' })).toBeTruthy();
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    });
  });

  describe('a design on an import this browser already has', () => {
    let store: HudStore;
    beforeEach(async () => {
      store = memoryStore(); _setHudStore(store);
      await store.put({ id, name: 'edgehud', files, bytes: 1, added: 1 });
    });
    const onImport = () => validateDesign({ v: 1, name: 'theirs', preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none' });
    const unlocked = async () => {
      await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Teammates' })).toBeTruthy());
      expect(screen.queryByText(BANNER)).toBeNull();
    };

    it('opens from a share link with the HUD loaded', async () => {
      location.hash = `#d=${await encodeShare(onImport())}`;
      render(<Hud />);
      await unlocked();
    });

    it('opens from a design file with the HUD loaded', async () => {
      render(<Hud />);
      await waitFor(() => expect(preset().value).toBe('stock'));
      const input = screen.getByLabelText('Import a HUD design file');
      fireEvent.change(input, { target: { files: [new File([JSON.stringify(onImport())], 'theirs.hud.json')] } });
      await screen.findByText('Imported theirs.');
      await unlocked();
    });

    it('comes back loaded on Undo after the HUD left memory', async () => {
      render(<Hud />);
      importFile(vpkFile());
      await screen.findByText('Imported edgehud.');
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      unregisterImport(id);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await unlocked();
    });

    it('is loaded by picking it in the Preset select when the design already names it', async () => {
      localStorage.setItem('hud', JSON.stringify(onImport()));
      // The store read at load fails once, so the design opens with the banner.
      const get = store.get.bind(store);
      let first = true;
      store.get = (x) => { if (first) { first = false; return Promise.reject(new Error('busy')); } return get(x); };
      render(<Hud />);
      await screen.findByText(BANNER);
      fireEvent.change(preset(), { target: { value: `imported:${id}` } });
      await unlocked();
    });
  });
});

describe('Splatter', () => {
  const stored = () => JSON.parse(localStorage.getItem('hud') ?? '{}');
  const row = (label: string) => within(screen.getByRole('group', { name: label }));
  const kindOf = (label: string) => screen.getByRole('combobox', { name: `${label} style` }) as HTMLSelectElement;
  const TEAM = 'Teammate card splatter';
  const TOP = 'Your health: top scratches';
  const BOTTOM = 'Your health: bottom scratches';

  it('shows three rows by label, each offering Stock, None, Fade and Image', () => {
    render(<Hud />);
    expect(screen.getByRole('heading', { name: 'Splatter' })).toBeTruthy();
    for (const label of [TEAM, TOP, BOTTOM]) {
      expect([...kindOf(label).options].map((o) => o.textContent), label).toEqual(['Stock', 'None', 'Fade', 'Image']);
    }
  });

  it("saves a Fade, and saves the teammate splatter's None as the child's hide", async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TEAM), { target: { value: 'fade' } });
    await waitFor(() => expect(stored().splatters?.splatTeam?.kind).toBe('fade'));
    fireEvent.change(kindOf(TEAM), { target: { value: 'none' } });
    await waitFor(() => expect(stored().children?.teamColumn?.BackgroundImage?.visible).toBe(false));
    expect(stored().splatters?.splatTeam?.kind).not.toBe('none');
    expect(kindOf(TEAM).value).toBe('none');
  });

  it('Reset to stock after a Fade removes the splatters', async () => {
    render(<Hud />);
    const reset = () => row(TOP).getByRole('button', { name: 'Reset to stock' }) as HTMLButtonElement;
    expect(reset().disabled).toBe(true);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    await waitFor(() => expect(stored().splatters?.splatTop?.kind).toBe('fade'));
    expect(reset().disabled).toBe(false);
    fireEvent.click(reset());
    await waitFor(() => expect(stored().splatters).toBeUndefined());
    expect(kindOf(TOP).value).toBe('stock');
  });

  it('disables the scratch rows on Modern and says why, and leaves the teammate row enabled', async () => {
    render(<Hud />);
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(kindOf(TOP).disabled).toBe(true));
    expect(kindOf(BOTTOM).disabled).toBe(true);
    expect(row(TOP).getByText('This preset hides the scratches.')).toBeTruthy();
    expect(kindOf(TEAM).disabled).toBe(false);
  });

  it('offers Colour by health on a scratch Fade only, and unticking it keeps the colours', async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TEAM), { target: { value: 'fade' } });
    expect(row(TEAM).queryByLabelText('Colour by health')).toBeNull();
    expect(row(TOP).queryByLabelText('Colour by health')).toBeNull();
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    const box = row(TOP).getByLabelText('Colour by health') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(stored().splatters?.splatTop?.keepColours).toBe(true));
  });

  it('draws the tint strip for a scratch Fade: Healthy, Hurt and Critical', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    for (const name of ['Healthy', 'Hurt', 'Critical']) {
      expect(row(TOP).getByRole('img', { name }).tagName).toBe('CANVAS');
    }
  });

  it('says so when the design is too big for this browser to keep', async () => {
    render(<Hud />);
    // Restored here, not left to the file's vi.restoreAllMocks: that does not
    // undo a spy on happy-dom's localStorage, and every later test's saves failed.
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
      await waitFor(() => expect(screen.getByText(
        'This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file.',
      )).toBeTruthy());
    } finally { spy.mockRestore(); }
  });

  it('keeps the too-big warning through a share link copy and a download, until a save succeeds', async () => {
    const TOO_BIG = 'This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file.';
    render(<Hud />);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    const url = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:hud');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
      await waitFor(() => expect(screen.getByText(TOO_BIG)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
      await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
      expect(screen.getByText(TOO_BIG)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /download/i }));
      await waitFor(() => expect(screen.getByText(/^Saved /)).toBeTruthy());
      expect(screen.getByText(TOO_BIG)).toBeTruthy();
      spy.mockRestore();
      fireEvent.change(kindOf(TOP), { target: { value: 'stock' } });
      await waitFor(() => expect(screen.queryByText(TOO_BIG)).toBeNull());
      expect(screen.getByText(/^Saved /)).toBeTruthy();
    } finally { spy.mockRestore(); url.mockRestore(); click.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('says an Image with no picture shows stock, with no tint strip or Colour by health', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
    expect(row(TOP).getByText('No picture yet (share links do not carry pictures), showing stock.')).toBeTruthy();
    expect(row(TOP).queryByLabelText('Colour by health')).toBeNull();
    expect(row(TOP).queryByRole('img', { name: 'Healthy' })).toBeNull();
  });

  it('tells a scratch row that light art works best, as the game multiplies it by the health colour', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
    expect(row(TOP).getByText(/Light or white art works best/)).toBeTruthy();
    fireEvent.change(kindOf(TEAM), { target: { value: 'image' } });
    expect(row(TEAM).queryByText(/Light or white art works best/)).toBeNull();
  });

  it('clears an upload error on Reset, on a change of kind and on Undo', async () => {
    render(<Hud />);
    const MSG = 'That image is over 4 MB.';
    const big = () => new File([new Uint8Array(4_000_001)], 'big.png', { type: 'image/png' });
    const fail = async () => {
      fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
      fireEvent.change(row(TOP).getByLabelText(`${TOP} image`), { target: { files: [big()] } });
      await waitFor(() => expect(row(TOP).getByText(MSG)).toBeTruthy());
    };
    await fail();
    fireEvent.click(row(TOP).getByRole('button', { name: 'Reset to stock' }));
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
    await fail();
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
    await fail();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
  });

  it('drops a splatter edit on a preset switch, and Undo brings it back', async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(stored().preset).toBe('modern'));
    expect(stored().splatters?.splatTop).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(stored().splatters?.splatTop).toEqual({ kind: 'fade' }));
  });

  it('keeps Reset usable on a row the preset disables, so a stale entry can be cleared', async () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, preset: 'modern', splatters: { splatTop: { kind: 'fade' } } }));
    render(<Hud />);
    await waitFor(() => expect(kindOf(TOP).disabled).toBe(true));
    const reset = row(TOP).getByRole('button', { name: 'Reset to stock' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => expect(stored().splatters?.splatTop).toBeUndefined());
  });

  it('Undo after choosing Fade brings the row back to Stock', () => {
    render(<Hud />);
    fireEvent.change(kindOf(BOTTOM), { target: { value: 'fade' } });
    expect(kindOf(BOTTOM).value).toBe('fade');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(kindOf(BOTTOM).value).toBe('stock');
  });
});
