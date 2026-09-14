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
 *
 * **`fileParallelism` only protects within one run.** Nothing here can stop a second
 * suite starting alongside this one — which is why the root `test` script passes
 * `--workspace-concurrency=1`. Five vitest processes at once oversubscribe the machine
 * badly enough that database-backed cases exceed their time budget, and the resulting
 * timeouts look nothing like a scheduling problem.
 */
export default defineConfig({
  test: {
    fileParallelism: false,

    /**
     * Raised from the 5s default because these are integration tests: a single case
     * opens a transaction, truncates twenty-one tables, seeds rows and asserts against
     * them. Five seconds is enough on an idle machine and not enough on a busy one, so
     * the default made passing partly a function of what else was running — the worst
     * property a test can have, because it produces failures that are real-looking and
     * not reproducible.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
