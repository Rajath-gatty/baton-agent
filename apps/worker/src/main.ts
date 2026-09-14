/**
 * Worker entrypoint.
 *
 * Order matters. Migrations run before anything else, because both the intake
 * loop and the HTTP surface assume the schema exists. Then the HTTP server comes
 * up so the health check can pass, and only then do the loops start — a health
 * check that fails while migrations run would have Coolify restart the container
 * mid-migration.
 */

import { sql } from "drizzle-orm";
import { createDatabase, runMigrations } from "@baton/core/db";
import { loadConfig } from "./config.js";
import { createServer } from "./api/server.js";
import { createTransport } from "./agent/transport.js";

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

// The intake loop and the processing loop are separate: curation must never
// block polling, or one slow model call stalls the live demo. Both are started
// here once they exist.

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down`);
    server.close(() => {
      void transport.close().then(() => process.exit(0));
    });
  });
}
