import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp({
  pool,
  jwtSecret: config.jwtSecret,
  webDist: config.webDist,
  production: config.production,
  maxAttempts: config.maxAttempts,
});
const server = app.listen(config.port, '0.0.0.0', () =>
  console.log(`Forecast API listening on port ${config.port}.`),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
