import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { ApiError, type DriftRow, type PatchDetail, type PatchSummary, type PublicEntry } from '../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: {
    balancePatches: vi.fn(), balanceDrift: vi.fn(), balancePatch: vi.fn(), editBalancePatch: vi.fn(),
    balancePublicPreview: vi.fn(), publishBalancePatch: vi.fn(),
    triageBalancePatch: vi.fn(), unfoldBalancePatch: vi.fn(), balanceIgnoredPlugins: vi.fn(), removeIgnoredPlugin: vi.fn(),
  },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { AdminPatches } = await import('./AdminPatches');

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { mockAdmin.balanceIgnoredPlugins.mockResolvedValue({ plugins: [] }); });

const patches: PatchSummary[] = [
  { id: 1, number: 1, name: 'Baseline', notes: '', source: 'historical', firstSeenAt: '2000-01-01 00:00:00', reviewed: true, rounds: 900, countedRounds: 850, servers: [], publishedAt: null },
  { id: 2, number: 2, name: null, notes: 'watch this one', source: 'detected', firstSeenAt: '2026-09-24 01:00:00', reviewed: false, rounds: 3, countedRounds: 0, servers: [], publishedAt: null },
];

const drift: DriftRow[] = [
  { serverId: 2, name: 'chicago', patchId: 2, since: 'x', differsFrom: [{ name: 'dallas', diff: 'added p:l4d_itemlimiter.smx' }] },
];

describe('AdminPatches', () => {
  it('lists patches with an approximate badge and shows drift', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: drift });

    render(<AdminPatches />);

    await waitFor(() => expect(screen.getByText('Baseline')).toBeTruthy());
    expect(screen.getByText('approximate')).toBeTruthy();
    expect(screen.getByText('Unnamed patch 2')).toBeTruthy();
    expect(screen.getByText(/chicago differs from dallas/)).toBeTruthy();
  });

  it('lists patches newest first', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    render(<AdminPatches />);
    await screen.findByText('Baseline');
    const names = screen.getAllByRole('row').slice(1).map((r) => r.querySelectorAll('td')[1]?.textContent);
    expect(names).toEqual(['Unnamed patch 2', 'Baseline']);
  });

  it('shows never played for an announced patch with no rounds', async () => {
    const announced: PatchSummary[] = [
      { id: 3, number: 3, name: 'Next up', notes: '', source: 'announced', firstSeenAt: '2026-09-24 02:00:00', reviewed: false, rounds: 0, countedRounds: 0, servers: [], publishedAt: null },
    ];
    mockAdmin.balancePatches.mockResolvedValue({ patches: announced });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });

    render(<AdminPatches />);

    expect(await screen.findByText('never played')).toBeTruthy();
  });

  it('shows all-clear when no server differs from another', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [] });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });

    render(<AdminPatches />);

    expect(await screen.findByText('All servers are running the same balance config.')).toBeTruthy();
  });

  it('opens a patch detail panel, renames it and marks it reviewed on save', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    const detail: PatchDetail = {
      ...patches[1],
      inputs: { 'p:l4d_itemlimiter.smx': '1.0' },
      diffVsPrevious: { added: ['p:l4d_itemlimiter.smx'], removed: [], changed: [{ key: 'p:pug-match.smx', from: '1', to: '2' }] },
    };
    mockAdmin.balancePatch.mockResolvedValue(detail);
    mockAdmin.editBalancePatch.mockResolvedValue({ ok: true });
    mockAdmin.balancePatches.mockResolvedValueOnce({ patches }).mockResolvedValue({ patches: [{ ...patches[1], name: 'Fall patch', reviewed: true }] });

    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Unnamed patch 2')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    await waitFor(() => expect(mockAdmin.balancePatch).toHaveBeenCalledWith(2));
    expect(await screen.findByText('added p:l4d_itemlimiter.smx')).toBeTruthy();
    expect(screen.getByText('p:pug-match.smx: 1 to 2')).toBeTruthy();
    expect((screen.getByLabelText('Patch notes') as HTMLTextAreaElement).value).toBe('watch this one');

    fireEvent.input(screen.getByLabelText('Patch name'), { target: { value: 'Fall patch' } });
    fireEvent.input(screen.getByLabelText('Patch notes'), { target: { value: 'confirmed safe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark reviewed' }));

    await waitFor(() => expect(mockAdmin.editBalancePatch)
      .toHaveBeenCalledWith(2, { name: 'Fall patch', notes: 'confirmed safe', reviewed: true }));
  });

  // A failed Details fetch used to be an unhandled promise rejection (no
  // .catch on the bare adminApi.balancePatch(...).then(setOpen)) and the
  // button silently did nothing. It must instead surface through the same
  // error banner the save action uses, with nothing left unhandled.
  it('shows an error when the Details fetch fails, with nothing unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
    window.addEventListener('unhandledrejection', onUnhandled);

    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    mockAdmin.balancePatch.mockRejectedValue(new ApiError(404, 'no such patch'));

    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Unnamed patch 2')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);

    expect(await screen.findByText('no such patch')).toBeTruthy();
    expect(screen.queryByLabelText('Patch name')).toBeNull();

    // Flush any microtask that would still be settling.
    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener('unhandledrejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('previews the public entry, publishes it, and surfaces a publish error', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    const detail: PatchDetail = { ...patches[1], inputs: null, diffVsPrevious: null };
    mockAdmin.balancePatch.mockResolvedValue(detail);
    const previewEntry: PublicEntry = {
      id: 2, number: 2, name: 'Unnamed patch 2', notes: 'Measured change: tanks die faster now.',
      source: 'detected', approximate: false, firstRound: null, lastRound: null,
      matches: 0, rounds: 0, publishedAt: null,
      previous: null, status: 'no_rounds', changes: null, changesUnavailable: null, live: true, effect: null,
    };
    mockAdmin.balancePublicPreview.mockResolvedValue(previewEntry);
    mockAdmin.publishBalancePatch.mockRejectedValueOnce(new ApiError(400, 'publishing needs notes'));

    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Unnamed patch 2')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    await waitFor(() => expect(mockAdmin.balancePatch).toHaveBeenCalledWith(2));
    expect(screen.getByText('Not public.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Measured change: tanks die faster now.')).toBeTruthy();
    expect(screen.getByText('Preview of the public entry')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(mockAdmin.publishBalancePatch).toHaveBeenCalledWith(2, true));
    expect(await screen.findByText('publishing needs notes')).toBeTruthy();
  });

  it('shows a public tag and an Unpublish button for a published patch', async () => {
    const publishedPatches: PatchSummary[] = [{ ...patches[1], publishedAt: '2026-09-20 12:00:00' }];
    mockAdmin.balancePatches.mockResolvedValue({ patches: publishedPatches });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    const detail: PatchDetail = { ...publishedPatches[0], inputs: null, diffVsPrevious: null };
    mockAdmin.balancePatch.mockResolvedValue(detail);

    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Unnamed patch 2')).toBeTruthy());
    expect(screen.getByText('public')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await waitFor(() => expect(mockAdmin.balancePatch).toHaveBeenCalledWith(2));

    expect(await screen.findByText(/Public since/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeTruthy();
  });
});

describe('AdminPatches triage', () => {
  const pending: PatchSummary = {
    id: 3, number: 3, name: null, notes: '', source: 'detected', firstSeenAt: '2026-09-24 03:00:00', reviewed: false,
    rounds: 2, countedRounds: 2, servers: [{ serverId: 1, name: 'dallas', lastSeenAt: 'x' }], publishedAt: null,
    triage: 'pending', foldedInto: null, onlyPluginsChanged: true, triageBase: { id: 1, number: 1, name: 'Baseline' },
    changes: ['plugin added: l4d_tvwatch'], plugins: ['l4d_tvwatch.smx'],
  };
  const setup = (list: PatchSummary[]) => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: list });
    mockAdmin.balanceDrift.mockResolvedValue({ servers: [] });
    mockAdmin.balanceIgnoredPlugins.mockResolvedValue({ plugins: [] });
    mockAdmin.triageBalancePatch.mockResolvedValue({ ok: true, target: 1 });
  };

  it('shows a triage card with the changes, the plugin hint and the servers, and folds or ignores', async () => {
    setup([patches[0], pending]);
    render(<AdminPatches />);
    expect(await screen.findByText('plugin added: l4d_tvwatch')).toBeTruthy();
    expect(screen.getByText(/Only plugins changed/)).toBeTruthy();
    expect(screen.getByText(/running on dallas/)).toBeTruthy();
    expect(screen.getByText('needs triage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not balance, fold just this once' }));
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'fold', into: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not balance, ignore these plugins from now on' }));
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'ignore', into: 1, plugins: ['l4d_tvwatch.smx'] }));
  });

  it('balance decision needs a name', async () => {
    setup([patches[0], pending]);
    render(<AdminPatches />);
    await screen.findByText('plugin added: l4d_tvwatch');
    const submit = screen.getByRole('button', { name: 'Balance patch' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Name for patch 3'), { target: { value: 'TV watch' } });
    fireEvent.click(submit);
    await waitFor(() => expect(mockAdmin.triageBalancePatch).toHaveBeenCalledWith(3, { decision: 'balance', name: 'TV watch', notes: '' }));
  });

  it('a patch folded into one that was folded later shows under the end of the chain', async () => {
    const mid: PatchSummary = { ...pending, id: 4, number: 4, triage: 'folded', foldedInto: 1, changes: ['plugin added: mid'] };
    const deep: PatchSummary = { ...pending, id: 5, number: 5, triage: 'folded', foldedInto: 4, changes: ['plugin added: deep'] };
    setup([patches[0], mid, deep]);
    render(<AdminPatches />);
    expect(await screen.findByText(/Includes 2 folded configs/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unfold patch 5' })).toBeTruthy();
  });

  it('never preselects a fold target that is not a balance patch', async () => {
    setup([patches[0], { ...pending, triageBase: { id: 2, number: 2, name: null } }]);
    render(<AdminPatches />);
    await screen.findByText('plugin added: l4d_tvwatch');
    expect((screen.getByLabelText('Fold target for patch 3') as HTMLSelectElement).value).toBe('1');
    expect(screen.queryByRole('button', { name: 'Not balance, ignore these plugins from now on' })).toBeNull();
  });

  it('offers no ignore button when more than plugins changed', async () => {
    setup([patches[0], { ...pending, onlyPluginsChanged: false, changes: ['z_tank_health 8000 -> 7500'], plugins: [] }]);
    render(<AdminPatches />);
    await screen.findByText('z_tank_health 8000 -> 7500');
    expect(screen.queryByText(/Only plugins changed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not balance, ignore these plugins from now on' })).toBeNull();
  });

  it('collapses a folded patch under its target with unfold, and lists ignored plugins with remove', async () => {
    setup([patches[0], { ...pending, triage: 'folded', foldedInto: 1, merged: true }]);
    mockAdmin.balanceIgnoredPlugins.mockResolvedValue({ plugins: [
      { file: 'l4d_tvwatch.smx', reason: '', addedBy: null, addedAt: null, source: 'knobs' },
      { file: 'x_noise.smx', reason: 'triage of patch #4', addedBy: '1', addedAt: '2026-09-24 00:00:00', source: 'site' },
    ] });
    mockAdmin.unfoldBalancePatch.mockResolvedValue({ ok: true });
    mockAdmin.removeIgnoredPlugin.mockResolvedValue({ ok: true });
    render(<AdminPatches />);
    expect(await screen.findByText(/Includes 1 folded config/)).toBeTruthy();
    expect(screen.getByText('#3: plugin added l4d_tvwatch')).toBeTruthy();
    expect(screen.queryByText('Unnamed patch 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold patch 3' }));
    await waitFor(() => expect(mockAdmin.unfoldBalancePatch).toHaveBeenCalledWith(3));
    expect(await screen.findByText('x_noise.smx')).toBeTruthy();
    expect(screen.getByText('(from balance/knobs.json)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove l4d_tvwatch.smx' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove x_noise.smx' }));
    await waitFor(() => expect(mockAdmin.removeIgnoredPlugin).toHaveBeenCalledWith('x_noise.smx'));
  });
});
