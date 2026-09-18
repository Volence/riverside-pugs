import { loadConfig, missingDirs } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildServer({ config, db });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`pug-web listening on :${config.port} (devMode=${config.devMode})`);
for (const { name, path } of missingDirs(config)) {
  console.warn(`*** ${name}=${path} does not exist. Everything that reads it will come back empty, `
    + 'which looks like missing data rather than a wrong path. ***');
}
if (config.devMode) {
  console.warn('*** DEV MODE ENABLED: /api/dev/* routes allow unauthenticated login as any SteamID. Never run this in production. ***');
}
