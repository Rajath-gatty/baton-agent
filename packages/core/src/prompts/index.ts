/**
 * Prompt versions and the six prompt bodies.
 *
 * `CURATOR_PROMPT_VERSION` is half of the curator cache key — the other half is
 * the message's `content_hash`. Bumping it invalidates every cached
 * classification and costs a fresh backfill, so it is bumped deliberately:
 * only when the change would alter what the Curator decides, not when a typo is
 * fixed in a comment.
 *
 * The other versions are recorded for provenance rather than caching. A finding
 * or brief that reads oddly can be traced to the prompt revision that produced
 * it.
 */

export { OBSERVATION_CONSTRAINT } from "./constraints.js";
export { JSON_OUTPUT_CONTRACT, composePrompt } from "./shared.js";

export { CURATOR_SYSTEM_PROMPT } from "./curator.js";
export { CARTOGRAPHER_SYSTEM_PROMPT } from "./cartographer.js";
export { ASSESSOR_SYSTEM_PROMPT } from "./assessor.js";
export { RESTRAINT_SYSTEM_PROMPT } from "./restraint.js";
export { BRIEFER_SYSTEM_PROMPT } from "./briefer.js";
export { RESPONDENT_SYSTEM_PROMPT } from "./respondent.js";

export const CURATOR_PROMPT_VERSION = 1;
export const CARTOGRAPHER_PROMPT_VERSION = 1;
export const ASSESSOR_PROMPT_VERSION = 1;
export const RESTRAINT_PROMPT_VERSION = 1;
export const BRIEFER_PROMPT_VERSION = 1;
export const RESPONDENT_PROMPT_VERSION = 1;

/**
 * The pre-filter's version, stored on every message alongside its verdict.
 * Bumping it marks previously discarded messages for re-evaluation instead of
 * leaving them lost — the pre-filter is recall-biased, but a mistake it does
 * make should be recoverable.
 */
export const PREFILTER_VERSION = 1;

export const PROMPT_VERSIONS = {
  curator: CURATOR_PROMPT_VERSION,
  cartographer: CARTOGRAPHER_PROMPT_VERSION,
  assessor: ASSESSOR_PROMPT_VERSION,
  restraint: RESTRAINT_PROMPT_VERSION,
  briefer: BRIEFER_PROMPT_VERSION,
  respondent: RESPONDENT_PROMPT_VERSION,
} as const;
