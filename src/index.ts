import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = await buildServer({ config, db });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`pug-web listening on :${config.port} (devMode=${config.devMode})`);
