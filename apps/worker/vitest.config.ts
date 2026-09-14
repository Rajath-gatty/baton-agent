import { defineConfig } from "vitest/config";

/**
 * Worker tests run one file at a time.
 *
 * Most of them are integration tests against a single real Postgres database and
 * they truncate every table between cases. Run in parallel, one file's truncation
 * lands in the middle of another file's test — which surfaces as a spray of
 * foreign-key and constraint failures in whichever file lost the race, not as
 * anything resembling "these tests share a database".
 *
 * The alternative is a database per worker, which is more machinery than a suite
 * this size earns. Serial costs a few seconds and cannot be got wrong later.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
