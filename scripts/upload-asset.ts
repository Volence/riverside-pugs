/**
 * Put one immutable player download in R2 (the L4D2 VPK zip, the 4 GB exe...).
 *
 * Usage: npx tsx scripts/upload-asset.ts <local file> <key> <download filename> [content-type]
 *   e.g. npx tsx scripts/upload-asset.ts dist/left4dead.exe mappack/left4dead-4gb.exe left4dead.exe
 *
 * The key must carry the version (or never change): the object is served with an
 * immutable cache header. Credentials come from the environment or a .env beside
 * you, as with upload-mappack.ts; the upload is checked with a HEAD afterwards.
 */
import { stat } from 'node:fs/promises';
import { head, put, r2FromEnv } from '../src/r2.js';
import { loadDotEnv } from './dotenv.js';

loadDotEnv();
const [localPath, key, filename, contentType = 'application/octet-stream'] = process.argv.slice(2);
if (!localPath || !key || !filename) {
  console.error('Usage: npx tsx scripts/upload-asset.ts <local file> <key> <download filename> [content-type]');
  process.exit(1);
}
const r2 = r2FromEnv();
if (!r2) {
  console.error('R2 is not configured (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL).');
  process.exit(1);
}
const { size } = await stat(localPath);
console.log(`Uploading ${localPath} (${size.toLocaleString('en-US')} bytes) to ${r2.bucket}/${key} ...`);
await put(r2, key, localPath, {
  contentType,
  contentDisposition: `attachment; filename="${filename}"`,
  cacheControl: 'public, max-age=31536000, immutable',
});
const after = await head(r2, key).catch(() => null);
if (!after || after.bytes !== size) {
  console.error(`Stored object does not match: local ${size}, remote ${after ? after.bytes : 'missing'}. Do not link it.`);
  process.exit(1);
}
console.log(`Done: https://assets.riversidepug.com/${key}`);
process.exit(0);
