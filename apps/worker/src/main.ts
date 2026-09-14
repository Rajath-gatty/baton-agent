/**
 * Worker entrypoint.
 *
 * Deliberately thin. All the behaviour lives in modules that a test can drive with a fake
 * Telegram client and a fake agent transport; this file only decides the order things
 * happen in and how the process dies. Anything with logic in it here would be the one
 * part of the worker nothing could test.
 *
 * **Startup order, and what each step protects:**
 *
 *   1. **Migrations first.** Both loops and the HTTP surface assume the schema exists.
 *   2. **HTTP second**, so `/health` can answer while the loops are still starting.
 *      Coolify restarts a container whose health check fails, and a check that failed
 *      during startup would restart the container mid-migration, forever.
 *   3. **Loops last.** Startup work that must precede polling — seeding settings,
 *      resolving the bot's own identity — is awaited inside `startWorkerRuntime`.
 *
 * `/health` reports only whether Postgres is reachable, and that is the whole contract.
 * It stays green while a tick is running, however long the tick takes, because a health
 * check that went red during a slow model call would have Coolify kill the container in
 * the middle of the pipeline — and the restart would bypass the worker's own backoff,
 * which is the mechanism that exists to stop unattended retry storms.
 */

import { sql } from "drizzle-orm";
import { createDatabase, runMigrations } from "@baton/core/db";
import { loadConfig } from "./config.js";
import { createServer } from "./api/server.js";
import { createTransport } from "./agent/transport.js";
import { startWorkerRuntime } from "./runtime/worker.js";

const config = loadConfig();

console.log("[worker] running migrations");
await runMigrations(config.DATABASE_URL);

const db = createDatabase({ url: config.DATABASE_URL });
const transport = createTransport(config);
console.log(`[worker] agent transport: ${transport.kind}`);

const app = createServer({
  config,
  db,
  isDatabaseReachable: async () => {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  },
});

const server = app.listen(config.PORT, () => {
  console.log(`[worker] http listening on ${config.PORT}`);
});

const runtime = await startWorkerRuntime({ db, config, transport });
console.log("[worker] intake and processing loops started");

/**
 * Shutdown.
 *
 * Loops first, then the queue drain inside `runtime.stop()`, then the HTTP server. A
 * queued outbound message lost on redeploy is a question a volunteer was about to be
 * asked, dropped with nothing anywhere recording that it happened.
 *
 * The signal handler is guarded because Coolify sends SIGTERM and then SIGKILL after a
 * grace period; a second SIGTERM arriving mid-drain must not start a second shutdown.
 */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down`);

    void (async () => {
      try {
        await runtime.stop();
        console.log("[worker] loops stopped and outbound queue drained");
      } catch (error) {
        console.error(
          `[worker] shutdown error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await transport.close();
        server.close(() => process.exit(0));
      }
    })();
  });
}
