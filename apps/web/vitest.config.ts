import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The admin UI's tests, which are integration tests against a real Postgres.
 *
 * Serial, and for the same reason the worker's suite is: these truncate every
 * table between cases, so two files running at once would land a truncation in the
 * middle of another file's assertions — which surfaces as a spray of foreign-key
 * failures in whichever file lost the race, and looks nothing like "these tests
 * share a database".
 *
 * The `@/` alias mirrors `tsconfig.json`, because the modules under test are the
 * ones the app imports and rewriting their import paths for the test would be
 * testing something else.
 *
 * What is deliberately **not** here: a jsdom environment or React rendering. The
 * seam these tests exist for is the one between the app and Postgres, and the
 * components have no logic left once the data is real — testing them would need a
 * browser to prove anything the checklist's observation pass does not already.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The seams are guarded with `server-only`, which throws when imported
      // outside a React Server Component environment. See the stub for why
      // neutralising it here loses nothing.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
