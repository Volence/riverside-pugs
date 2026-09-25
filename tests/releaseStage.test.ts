import { describe, expect, it } from 'vitest';
import type { RepoFile } from '../src/deployRepo.js';
import { cvarDiff, deploySlug, describeOps, passwordsSet, planBox, suggestBalance, validateTree, wantedFor, type Op } from '../src/releaseStage.js';

const f = (path: string, sha = 'h', mode = '100644', size = 1): RepoFile => ({ path, mode, blob: `b-${sha}`.padEnd(40, '0'), size, sha256: sha });

describe('deploySlug', () => {
  it('derives from the server name', () => {
    expect(deploySlug('Dallas')).toBe('dallas');
    expect(deploySlug('Riverside #3')).toBe('riverside-3');
    expect(deploySlug(' Chicago ')).toBe('chicago');
  });
});

describe('wantedFor and validateTree', () => {
  const tree = [
    f('overrides/left4dead/cfg/pug_match.cfg', 's1'),
    f('overrides/left4dead/cfg/local.cfg', 'shared-local'),
    f('boxes/chicago/left4dead/cfg/local.cfg', 'chi-local'),
    f('boxes/dallas/left4dead/cfg/server.cfg', 'dal-server'),
    f('deploy.sh', 'x'),
  ];
  it('maps overrides and the box layer, box wins, other boxes and repo files ignored', () => {
    const chi = wantedFor(tree, 'chicago');
    expect([...chi.keys()].sort()).toEqual(['left4dead/cfg/local.cfg', 'left4dead/cfg/pug_match.cfg']);
    expect(chi.get('left4dead/cfg/local.cfg')).toMatchObject({ sha256: 'chi-local', layer: 'box' });
    expect(wantedFor(tree, 'dallas').get('left4dead/cfg/local.cfg')).toMatchObject({ sha256: 'shared-local', layer: 'shared' });
  });
  it('refuses secrets, symlinks, unmanaged paths and oversized files', () => {
    expect(validateTree(tree)).toEqual([]);
    expect(validateTree([
      f('overrides/left4dead/cfg/secrets.cfg'),
      f('boxes/dallas/left4dead/cfg/link.cfg', 'h', '120000'),
      f('overrides/left4dead/maps/x.bsp'),
      f('overrides/left4dead/addons/sourcemod/plugins/big.smx', 'h', '100644', 30 * 1024 * 1024),
      f('overrides/left4dead/cfg/pug_balance.cfg'),
      f('boxes/dallas/left4dead/addons/sourcemod/data/pug_balance_watch.txt'),
    ])).toEqual([
      'secrets.cfg is never deployed: left4dead/cfg/secrets.cfg',
      'symlink: boxes/dallas/left4dead/cfg/link.cfg',
      'outside the managed folders: left4dead/maps/x.bsp',
      'over 20 MB: left4dead/addons/sourcemod/plugins/big.smx',
      'written by the site, never by a release: left4dead/cfg/pug_balance.cfg',
      'written by the site, never by a release: left4dead/addons/sourcemod/data/pug_balance_watch.txt',
    ]);
  });
});

describe('passwords in a cfg', () => {
  it('finds a non-empty rcon_password, sv_password or tv_password at line start, ignoring comments and empty values', () => {
    expect(passwordsSet('hostname "x"\nrcon_password "hunter2"\n  sv_password pug // x\ntv_password ""\n// rcon_password "old"\necho rcon_password nope\n'))
      .toEqual(['rcon_password', 'sv_password']);
    expect(passwordsSet('tv_password "watch"\r\nsv_password ""\n')).toEqual(['tv_password']);
  });
  it('refuses a release whose cfg sets rcon_password or sv_password, anywhere but secrets.cfg', () => {
    const tree = [f('boxes/dallas/left4dead/cfg/server.cfg', 'srv'), f('overrides/left4dead/cfg/local.cfg', 'loc'), f('overrides/left4dead/cfg/pug_match.cfg', 'pm')];
    const texts = new Map([
      ['boxes/dallas/left4dead/cfg/server.cfg', 'hostname x\nrcon_password "hunter2"\nsv_password ""\n'],
      ['overrides/left4dead/cfg/local.cfg', 'tv_password "watch"\n'],
      ['overrides/left4dead/cfg/pug_match.cfg', '// sv_password "x"\n'],
    ]);
    expect(validateTree(tree, texts)).toEqual([
      'rcon_password is set in left4dead/cfg/server.cfg (boxes/dallas/left4dead/cfg/server.cfg): move it into that box\'s secrets.cfg, which is never deployed',
    ]);
  });
});

describe('planBox', () => {
  const W = (sha: string) => ({ path: '', size: 1, sha256: sha, blob: `blob-${sha}`, layer: 'shared' as const });
  it('adds, updates, and deletes only what was shipped before', () => {
    const wanted = new Map([['left4dead/cfg/a.cfg', { ...W('new'), path: 'left4dead/cfg/a.cfg' }], ['left4dead/cfg/b.cfg', { ...W('b'), path: 'left4dead/cfg/b.cfg' }]]);
    const onBox = new Map([
      ['left4dead/cfg/a.cfg', { size: 1, sha256: 'old' }],
      ['left4dead/cfg/gone.cfg', { size: 1, sha256: 'g' }],
      ['left4dead/cfg/handmade.cfg', { size: 1, sha256: 'hm' }],
    ]);
    const shipped = new Map([['left4dead/cfg/gone.cfg', { sha256: 'g', blob: 'x' }], ['left4dead/cfg/a.cfg', { sha256: 'old', blob: 'y' }]]);
    const ops = planBox(wanted, onBox, shipped);
    expect(ops).toEqual([
      { path: 'left4dead/cfg/b.cfg', op: 'write', kind: 'add', size: 1, sha256: 'b', blob: 'blob-b', layer: 'shared' },
      { path: 'left4dead/cfg/a.cfg', op: 'write', kind: 'update', size: 1, sha256: 'new', blob: 'blob-new', layer: 'shared' },
      { path: 'left4dead/cfg/gone.cfg', op: 'remove' },
    ]);
    expect(planBox(wanted, new Map([['left4dead/cfg/a.cfg', { size: 1, sha256: 'new' }], ['left4dead/cfg/b.cfg', { size: 1, sha256: 'b' }]]), new Map())).toEqual([]);
  });
});

describe('wording', () => {
  it('describes ops in plain words', () => {
    const ops: Op[] = [
      { path: 'left4dead/addons/sourcemod/plugins/l4d_skypounce.smx', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' },
      { path: 'left4dead/addons/sourcemod/plugins/specrates.smx', op: 'remove' },
      { path: 'left4dead/cfg/local.cfg', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' },
      { path: 'left4dead/addons/sourcemod/gamedata/x.txt', op: 'write', kind: 'add', size: 1, sha256: 'x', blob: 'b' },
    ];
    expect(describeOps(ops)).toEqual([
      'plugin updated: l4d_skypounce', 'plugin removed: specrates',
      'cfg changed: cfg/local.cfg', 'file added: addons/sourcemod/gamedata/x.txt',
    ]);
  });
  it('diffs cvar lines, ignoring comments and commands', () => {
    const old = '// c\nz_tank_health 8000\nsm_cvar z_witch_health "1000"\nexec other.cfg\nz_gone 1\n';
    const neu = 'z_tank_health "7500" // lower\nsm_cvar z_witch_health "1000"\nexec other.cfg\nz_new 5\n';
    expect(cvarDiff(old, neu)).toEqual(['z_tank_health 8000 → 7500', 'z_new set to 5', 'z_gone no longer set']);
  });
  it('suggests not balance only for non-balance plugins with no watched cvar or file', () => {
    const k = { cvars: [{ cvar: 'z_tank_health' }], files: [{ path: 'cfg/pug_match.cfg' }], dirs: [], versionless: ['pug-match.smx'], ignored: ['l4d_tvwatch.smx'] };
    const tv: Op = { path: 'left4dead/addons/sourcemod/plugins/l4d_tvwatch.smx', op: 'write', kind: 'update', size: 1, sha256: 'x', blob: 'b' };
    const pm: Op = { ...tv, path: 'left4dead/addons/sourcemod/plugins/pug-match.smx' };
    const sky: Op = { ...tv, path: 'left4dead/addons/sourcemod/plugins/l4d_skypounce.smx' };
    const cfg: Op = { ...tv, path: 'left4dead/cfg/pug_match.cfg' };
    expect(suggestBalance([[tv, pm]], [], k)).toBe('not_balance');
    expect(suggestBalance([[sky]], [], k)).toBe('possibly_balance');
    expect(suggestBalance([[cfg]], [], k)).toBe('possibly_balance');
    expect(suggestBalance([[tv]], ['z_tank_health'], k)).toBe('possibly_balance');
  });
});
