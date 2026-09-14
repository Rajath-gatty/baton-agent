/**
 * Intake — the normaliser and the pre-filter.
 *
 * Reached through the explicit `@baton/core/intake` entry point, and **not**
 * re-exported from the core barrel. Both are deterministic, database-free, and shared
 * by the worker's poll loop and `scripts/backfill.ts`, which is the whole point:
 * seeded messages must enter through the same normaliser as live traffic, and the only
 * way to guarantee that is for there to be one copy that neither process owns.
 */

export * from "./normalise.js";
export * from "./prefilter.js";
