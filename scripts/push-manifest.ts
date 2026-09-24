/**
 * Build the fleet view's reference manifests and put them on the site.
 *
 *   npx tsx scripts/push-manifest.ts ~/l4d/deploy                  # to the site over ssh
 *   npx tsx scripts/push-manifest.ts ~/l4d/deploy --out /tmp/fleet # to a local dir
 *
 * repo.json: the deploy repo's overrides/ at HEAD (refuses uncommitted changes).
 * base.json: the Rotoblin-AZMod release the boxes were installed from, the
 * same ZIP install-server.sh downloads, cached in ~/.cache/pug-fleet.
 * Only paths, sizes and hashes leave this machine.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseManifest, repoManifest } from '../src/fleetManifest.js';

const args = process.argv.slice(2);
const deployDir = args[0];
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
if (!deployDir || deployDir.startsWith('--')) {
  console.error('usage: push-manifest.ts <deployDir> [--host root@45.32.199.85] [--remote-dir /home/pug/app/data/fleet] [--out <dir>]');
  process.exit(2);
}
const host = opt('--host', 'root@45.32.199.85');
const remoteDir = opt('--remote-dir', '/home/pug/app/data/fleet');
const out = opt('--out', '');

const install = readFileSync(join(deployDir, 'install-server.sh'), 'utf8');
const version = /^ROTO_VERSION=(\S+)/m.exec(install)?.[1];
if (!version) throw new Error('ROTO_VERSION not found in install-server.sh');
const url = `https://github.com/fbef0102/Rotoblin-AZMod/releases/download/${version}/l4d1_Roto-AZMod.zip`;

const cache = join(homedir(), '.cache', 'pug-fleet');
mkdirSync(cache, { recursive: true });
const zip = join(cache, `l4d1_Roto-AZMod-${version}.zip`);
if (!existsSync(zip)) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${zip}.part`, zip);
}
const x = mkdtempSync(join(tmpdir(), 'roto-'));
try {
  execFileSync('unzip', ['-q', zip, '-d', x]);
  const repo = await repoManifest(deployDir);
  const base = await baseManifest(x, `Rotoblin-AZMod ${version}`);
  console.log(`repo ${repo.label}: ${Object.keys(repo.files).length} files; base ${base.label}: ${Object.keys(base.files).length} files`);
  for (const m of [repo, base]) {
    const body = JSON.stringify(m);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${m.kind}.json.part`), body);
      renameSync(join(out, `${m.kind}.json.part`), join(out, `${m.kind}.json`));
    } else {
      const f = `${remoteDir}/${m.kind}.json`;
      const r = spawnSync('ssh', [host, `mkdir -p '${remoteDir}' && cat > '${f}.part' && chown pug:pug '${f}.part' && mv '${f}.part' '${f}'`], { input: body });
      if (r.status !== 0) throw new Error(`ssh write failed: ${r.stderr.toString()}`);
    }
  }
  console.log(out ? `written to ${out}` : `pushed to ${host}:${remoteDir}`);
} finally {
  rmSync(x, { recursive: true, force: true });
}
