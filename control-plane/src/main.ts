import { loadConfig, loadDotEnvLocal } from './config.js';
import { startPurger } from './lifecycle.js';
import { NodeListeners } from './origins.js';
import { handleUpgrade } from './routes/proxy.js';
import { buildCtx, createServer, realDeps } from './server.js';

loadDotEnvLocal();
const config = loadConfig();
const ctx = buildCtx(config, realDeps(config));
const app = createServer(ctx);

ctx.orchestrator.resume();
ctx.scheduler.start();
const stopPurger = startPurger(ctx);
// Rollout of the root supervisor / split secrets: running Boxes on protocol 1 are restarted once.
void ctx.resources.upgradeOutdatedSupervisors((line) => console.log(`[upgrade] ${line}`));

// One Hono app, one listener per origin (origins.ts): API on PORT, the console on CONSOLE_PORT, and
// one port per app env. Each listener tags its requests with its port, which decides their role.
const listeners = new NodeListeners(app.fetch, (req, socket, head, port) => {
  handleUpgrade(ctx, req, socket, head, port).catch((err) => {
    console.error(`[proxy] upgrade on :${port}: ${(err as Error).message}`);
    socket.destroy();
  });
});
const missing = (['BOXLITE_API_KEY', 'NEON_API_KEY', 'NEON_ORG_ID'] as const).filter((k) => !process.env[k]);
void listeners
  .listen(config.port)
  .then(() => {
    console.log(`[cp] API on :${config.port} at ${config.publicUrl}, data ${config.dataDir}`);
    if (missing.length) console.log(`[cp] not configured: ${missing.join(', ')} (calls needing them fail with "unavailable")`);
    // The console and every env origin come up next: listeners, then their tunnels on this Box.
    // A new env's origin is brought up when it gets its port (Origins.envUrl).
    return ctx.origins.boot(listeners);
  })
  .then(() => console.log(`[cp] console on :${ctx.origins.consolePort} at ${ctx.origins.consoleUrl()}; listening on ${listeners.ports.length} ports`))
  .catch((err) => {
    console.error(`[cp] cannot listen: ${(err as Error).message}`);
    process.exit(1);
  });

const shutdown = () => {
  ctx.scheduler.stop();
  stopPurger();
  void listeners.close();
  ctx.store.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
