/**
 * Development bootstrap for the worker.
 *
 * Loads the repository-root `.env`, then hands over to the real entrypoint.
 *
 * **Why this file exists rather than loading `.env` inside `src/main.ts`.** The worker
 * holds the only database credentials in the system and is the only process that writes.
 * A deployed container must read its real environment, because absorbing a stray `.env`
 * copied into an image is precisely how you migrate or backfill the wrong database. So
 * production (`pnpm start` → `node dist/main.js`) never reads a file, and only this
 * development path does.
 *
 * **Why not `node --env-file`.** Node's built-in loader will not override a name already
 * in the environment, and treats one set to the empty string as set — so a shell
 * exporting empty placeholders beats a filled `.env` and the process dies naming a
 * variable you can see is populated.
 */

import { fileURLToPath } from "node:url";
import { loadDotEnv } from "@baton/core";

const result = loadDotEnv(fileURLToPath(new URL("../../.env", import.meta.url)), {
  override: true,
});

console.log(`[worker:dev] loaded ${result.applied.length} variables from .env`);
if (result.conflicts.length > 0) {
  console.log(
    `[worker:dev] .env overrode different shell values for: ${result.conflicts.join(", ")}`,
  );
}

await import("./src/main.js");
