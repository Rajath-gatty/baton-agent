import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit reads a bare `process.env` — unlike the app's CLI entry points it does
 * not load the repository-root `.env`, so `studio`/`generate`/`push` would otherwise
 * see an empty `DATABASE_URL`. Load it here the same way `src/db/migrate.ts` does.
 *
 * Node's built-in loader (Node 20.6+) is used rather than importing the workspace's
 * own `loadDotEnv`, because this config runs before `dist` is built and importing the
 * compiled module would be a chicken-and-egg dependency.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No root .env is a normal state; the driver validation below reports what's missing.
}

export default defineConfig({
  dialect: "postgresql",
  /**
   * The **built** schema, not `src`. drizzle-kit bundles the entry it is given and
   * does not remap NodeNext's `.js` specifiers back onto `.ts` files, so
   * `src/db/schema.ts` importing `../constants.js` fails to resolve under it. Every
   * workspace here compiles to `dist`, so pointing at the output costs nothing and
   * removes a whole class of "works under tsx, fails under drizzle-kit" confusion.
   *
   * `db:generate` builds first, so this is never stale.
   */
  schema: "./dist/db/schema.js",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
