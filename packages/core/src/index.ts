/**
 * @baton/core — the contract between the three apps.
 *
 * The Zod schemas defining the agents' structured output are the same schemas
 * the database and the UI validate against. This package carries more weight
 * than its size suggests: one file rather than three copies that drift.
 *
 * Note the deliberate omission — this barrel does **not** re-export `./db`.
 * The agent imports `@baton/core` for schemas, constants and prompts, and must
 * never acquire a database client transitively. Database access is reached only
 * through the explicit `@baton/core/db` entry point.
 */

export * from "./alias-match.js";
export * from "./constants.js";
export * from "./consequence.js";
export * from "./intake/index.js";
export * from "./keys.js";
export * from "./normalise.js";
export * from "./prefilter.js";
export * from "./redact.js";
export * from "./timezone.js";
export * from "./value-signature.js";
export * from "./schemas/index.js";
export * from "./prompts/index.js";
