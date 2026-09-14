import { defineConfig } from "vitest/config";

/**
 * Agent tests run one file at a time.
 *
 * Not for isolation — nothing here touches a database — but for memory. Every file in
 * this workspace transitively loads the Strands SDK barrel, which is large and which
 * initialises eagerly. Run across the default worker pool, each worker pays that cost
 * separately and the run dies with `FATAL ERROR: Zone Allocation failed - process out
 * of memory`, or fails earlier and more confusingly with an `UNKNOWN: unknown error,
 * realpath` on a source file that is plainly present.
 *
 * Serialising is also simply faster here: one SDK load instead of several takes the
 * suite from roughly 18 seconds to 5.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
