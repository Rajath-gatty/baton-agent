/**
 * reset-demo.ts
 *
 * Restores the golden dump. Register actions are permanent by design — a
 * dismissal is recorded against a `dedupe_key` and never returns — so without
 * this the first curious judge who clicks Dismiss flattens the demo for everyone
 * after them.
 *
 * Also resets `coordinator_state.last_seen_at`, because the
 * since-you-last-looked diff advances on view and would otherwise be empty for
 * the second judge onward.
 *
 * Note the direction: the golden dump flows deployed -> local, never the
 * reverse. Overwriting it from a development machine destroys the reset point.
 */

async function main(): Promise<void> {
  console.log("reset-demo: not implemented");
  return Promise.resolve();
}

await main();
