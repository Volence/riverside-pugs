import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FileSig, Manifest } from './fleetCompare.js';

/** Builders for the fleet view's reference manifests. Run on the owner's
 *  machine by scripts/push-manifest.ts; nothing here touches a server. */

type Runner = (cmd: string, args: string[]) => Promise<string>;
const execFileAsync = promisify(execFile);
const defaultRun: Runner = async (cmd, args) => (await execFileAsync(cmd, args, { maxBuffer: 32 << 20 })).stdout;
const sha = async (abs: string) => createHash('sha256').update(await readFile(abs)).digest('hex');

export async function hashTree(root: string, mapTo: string): Promise<Record<string, FileSig>> {
  const out: Record<string, FileSig> = {};
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out[`${mapTo}/${p}`] = { size: (await stat(join(root, p))).size, sha256: await sha(join(root, p)) };
    }
  };
  await walk('');
  return out;
}

export async function repoManifest(deployDir: string, run: Runner = defaultRun): Promise<Manifest> {
  const git = (...a: string[]) => run('git', ['-C', deployDir, ...a]);
  if ((await git('status', '--porcelain', '--', 'overrides')).trim() !== '') {
    throw new Error('overrides/ has uncommitted changes or untracked files; commit first so the manifest names a real commit');
  }
  const [hash, at] = (await git('log', '-1', '--format=%h%x09%cI')).trim().split('\t');
  const files: Record<string, FileSig> = {};
  // ls-files, not the directory: git-ignored files such as secrets.cfg never leave the machine.
  for (const p of (await git('ls-files', '-z', '--', 'overrides')).split('\0').filter(Boolean)) {
    const abs = join(deployDir, p);
    files[p.replace(/^overrides\//, '')] = { size: (await stat(abs)).size, sha256: await sha(abs) };
  }
  return { kind: 'repo', label: hash, at, files };
}

/** The two layers install-server.sh copies, in its order. */
export const BASE_LAYERS = [
  'l4d1_Roto-AZMod/Files Here/Linux Server Files/left4dead',
  'l4d1_Roto-AZMod/Files Here/Roto-AZMod Main files/left4dead',
];
/** What install-server.sh deletes after copying. */
export const BASE_DROPPED = [
  'left4dead/addons/metamod/bin/linux64/', 'left4dead/addons/metamod/bin/win64/',
  'left4dead/addons/sourcemod/bin/linux64/', 'left4dead/addons/stripper/bin/linux64/',
];

export async function baseManifest(extractedRoot: string, label: string): Promise<Manifest> {
  const files: Record<string, FileSig> = {};
  for (const layer of BASE_LAYERS) Object.assign(files, await hashTree(join(extractedRoot, layer), 'left4dead'));
  for (const p of Object.keys(files)) if (BASE_DROPPED.some((d) => p.startsWith(d))) delete files[p];
  return { kind: 'base', label, at: new Date().toISOString(), files };
}
