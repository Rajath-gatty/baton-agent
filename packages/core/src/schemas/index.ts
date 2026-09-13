/**
 * Zod schemas shared by the agent, the worker and the web app.
 *
 * Every one of these is validated against a model response with retry-on-failure,
 * so they are separate files edited independently. Two rules hold across all six,
 * for the same reason: a cheap model's failure mode is not a crash but plausible
 * output that is subtly wrong.
 *
 *   - **Keep them flat.** Nested schemas are where cheap models break. Where a
 *     union would be the natural shape — the Respondent's four branches — the wire
 *     shape stays flat and the branch invariants are enforced by `superRefine`
 *     after parsing instead.
 *   - **Required and nullable, not optional.** A model asked for every key every
 *     time is more reliable than one deciding which keys apply.
 */

export * from "./envelope.js";
export * from "./curator.js";
export * from "./cartographer.js";
export * from "./assessor.js";
export * from "./restraint.js";
export * from "./briefer.js";
export * from "./respondent.js";
