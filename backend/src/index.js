import { startServer } from './transport/server.js';

/**
 * `startServer` is async now (schema creation is a network round trip), so a
 * failure to start is a rejected promise rather than a thrown exception. Without this handler an unreachable database would
 * surface as an unhandled rejection with no context -- which, on a host that
 * restarts the process, is an endless quiet crash loop.
 */
startServer().catch((err) => {
  console.error('failed to start:', err.message);
  process.exit(1);
});
