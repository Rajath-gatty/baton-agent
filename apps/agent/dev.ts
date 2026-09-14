/**
 * Development bootstrap for the agent container.
 *
 * Loads the repository-root `.env`, then hands over to the real entrypoint.
 *
 * **Why this file exists rather than loading `.env` inside `src/server.ts`.** The design
 * requires a deployed container to read its *real* environment: silently absorbing a
 * stray `.env` that got copied into an image is a way to run against the wrong database
 * or the wrong model account. So production (`pnpm start` → `node dist/server.js`) must
 * never read a file, and only this development path does.
 *
 * **Why not `node --env-file` or `tsx --env-file`.** Both use Node's built-in loader,
 * which refuses to override a name already present in the environment and counts one set
 * to the empty string as present. A shell that exports empty placeholders — which is
 * exactly what this machine does for `MODEL_BASE_URL` — silently beats a correctly filled
 * `.env`, and the process dies reporting a variable you can see is set.
 *
 * The file wins here, deliberately, because in development the `.env` a developer edited
 * is the intent and an exported empty string never is.
 */

import { fileURLToPath } from "node:url";
import { loadDotEnv } from "@baton/core";

const result = loadDotEnv(fileURLToPath(new URL("../../.env", import.meta.url)), {
  override: true,
});

console.log(`[agent:dev] loaded ${result.applied.length} variables from .env`);
if (result.conflicts.length > 0) {
  console.log(
    `[agent:dev] .env overrode different shell values for: ${result.conflicts.join(", ")}`,
  );
}

await import("./src/server.js");
