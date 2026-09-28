import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createSupabaseStore } from './db/store.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[chatwithuss] ${err.message}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const store = createSupabaseStore(config.supabase);
const { app } = createApp({ config, store, logger });

const server = app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, appUrl: config.appUrl, apiVersion: config.shopify.apiVersion });
});

// Render sends SIGTERM on deploy — finish in-flight requests (webhooks!) before exiting.
function shutdown(signal) {
  logger.info('server.stopping', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('process.unhandled_rejection', { err }));
