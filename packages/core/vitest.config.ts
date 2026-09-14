import { defineConfig } from "vitest/config";

/**
 * Core tests run one file at a time.
 *
 * Only `db-harness.test.ts` touches the database today, so parallel execution
 * happens to be safe right now. It is set here anyway: the moment a second file in
 * this package truncates a table, the two would race and fail in whichever file
 * lost — a failure that reads like a bug in the code under test rather than a
 * shared fixture. Most files here test pure functions and cost milliseconds, so
 * serialising is close to free.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
