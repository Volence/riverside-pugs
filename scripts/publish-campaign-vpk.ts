/**
 * Publish a custom campaign VPK that is already on the web box, the same way
 * the admin page's upload + Publish does (src/routes/campaigns.ts), for files
 * too big to push through a browser comfortably (the L4D2 conversions are
 * 100-350 MB each).
 *
 *   tsx scripts/publish-campaign-vpk.ts <vpk> <admin steamid> [--needs-l4d2-pack] [--go]
 *
 * Without --go it only runs the upload checks and prints what it would do:
 * a versus mission in the VPK, no file the consistency list enforces, a slug
 * (from the mission name, as the upload route derives it) no campaign has.
 * With --go it copies the VPK into ADDONS_DIR as <slug>.vpk, writes the draft
 * (insertDraft: the last versus chapter is the finale), sets needs_l4d2_pack,
 * publishes, and installs onto every enabled server (installCampaign, the
 * same transports and per-server install rows the publish route writes).
 *
 * The running pug-web keeps its campaign registry cached, so restart it after
 * this (its startup sweep also builds the zipped download). A VPK copied onto
 * a running srcds is not mounted until that srcds restarts
 * (memory: l4d1-vpk-mount-needs-restart), and the campaign joins the pool
 * editor only once it is installed on every enabled server.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv } from './dotenv.js';

loadDotEnv();

const { openDb } = await import('../src/db.js');
const { loadConfig } = await import('../src/config.js');
const { logAdmin } = await import('../src/admin/audit.js');
const { CAMPAIGNS } = await import('../src/campaigns.js');
const { transportFor } = await import('../src/addonsTransport.js');
const { installCampaign } = await import('../src/campaignInstall.js');
const { chaptersOf, getCampaign, insertDraft, installsOf, publishCampaign, setNeedsL4d2Pack } = await import('../src/customCampaigns.js');
const { listVpkPaths, missionFromVpk } = await import('../src/vpk.js');
const { collisionMessage, consistencyCollisions, loadConsistencyList } = await import('../src/consistencyList.js');
type ServerRow = import('../src/serverPool.js').ServerRow;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const go = process.argv.includes('--go');
const needsPack = process.argv.includes('--needs-l4d2-pack');
const [vpk, adminId] = args;
if (!vpk || !/^\d{17}$/.test(adminId ?? '')) {
  console.error('usage: tsx scripts/publish-campaign-vpk.ts <vpk> <admin steamid64> [--needs-l4d2-pack] [--go]');
  process.exit(2);
}

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const addonsDir = config.addonsDir;
if (!addonsDir) throw new Error('ADDONS_DIR is not set');

const mission = missionFromVpk(vpk);
if (!mission) throw new Error(`${vpk}: no versus mission found`);
const forced = loadConsistencyList();
if (!forced) throw new Error('the enforced file list could not be loaded');
const collisions = consistencyCollisions(listVpkPaths(vpk), forced);
if (collisions.length > 0) throw new Error(collisionMessage(collisions));
const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
if (!slug) throw new Error('mission has no usable name');
if (CAMPAIGNS[slug] || getCampaign(db, slug)) throw new Error(`a campaign named ${slug} already exists`);
const dest = join(addonsDir, `${slug}.vpk`);
if (existsSync(dest)) throw new Error(`${dest} already exists`);

const sha256 = await new Promise<string>((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(vpk).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const sizeBytes = statSync(vpk).size;
console.log(`${slug}: "${mission.displayTitle}", ${sizeBytes} bytes, sha256 ${sha256.slice(0, 16)}, ` +
  `chapters ${mission.chapters.map((c) => c.map).join(' ')} (last is the finale)`);
if (!go) {
  console.log('checks passed; rerun with --go to publish');
  process.exit(0);
}

copyFileSync(vpk, dest);
insertDraft(db, { slug, name: mission.displayTitle, vpkFilename: `${slug}.vpk`, sizeBytes, sha256, uploadedBy: adminId },
  mission.chapters.map((c) => ({ map: c.map, display: c.display, isFinale: false })));
logAdmin(db, adminId, 'campaign_upload', slug, { name: mission.displayTitle, sizeBytes, via: 'claude publish-campaign-vpk' });
if (needsPack) setNeedsL4d2Pack(db, slug, true);
publishCampaign(db, slug, mission.displayTitle);
logAdmin(db, adminId, 'campaign_publish', slug, { from: mission.displayTitle, to: mission.displayTitle, via: 'claude publish-campaign-vpk' });

const servers = (db.prepare('SELECT * FROM servers WHERE enabled = 1').all() as ServerRow[])
  .map((s) => ({ id: s.id, transport: transportFor(s) }));
await installCampaign(db, slug, { sourcePath: dest, servers });
for (const i of installsOf(db, slug)) console.log(`  server ${i.server_id}: ${i.state}${i.error ? ` (${i.error})` : ''}`);
console.log(`chapters: ${chaptersOf(db, slug).map((c) => `${c.map}${c.is_finale ? ' (finale)' : ''}`).join(', ')}`);
