/**
 * Zod schemas shared by the agent, the worker and the web app.
 *
 * The envelope is complete. The six per-agent output schemas are the next
 * unit of work — see the `packages/core` section of the implementation
 * checklist. Each must stay **flat**: nested schemas are where cheap models
 * break, and the Curator's runs thousands of times so any per-call failure rate
 * compounds across the backfill.
 */

export * from "./envelope.js";
