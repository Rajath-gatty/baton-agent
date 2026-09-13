/**
 * Shared prompt scaffolding.
 *
 * Every agent returns JSON that is validated against a Zod schema on our side of
 * the SDK boundary, with the validation error fed back on retry. That places two
 * obligations on every prompt, and they are here rather than copied six times:
 *
 *   - **Ask for JSON and nothing else.** A cheap model's instinct is to wrap the
 *     object in prose or a fenced block. The parser tolerates a fence, but saying
 *     so plainly costs one line and removes a whole class of retry.
 *   - **Every key, every time.** The schemas are required-and-nullable rather than
 *     optional, because a model asked for every key is more reliable than one
 *     deciding which keys apply, and an explicit `null` is evidence the field was
 *     considered rather than forgotten.
 */

/**
 * Appended to every prompt. The JSON contract is the same for all six agents
 * because the validate-and-retry loop is the same for all six.
 */
export const JSON_OUTPUT_CONTRACT = [
  "Return one JSON object and nothing else. No preamble, no explanation, no markdown fence.",
  "Include every key described below on every object, every time.",
  "Where a key does not apply, return null — never omit it, and never invent a placeholder string.",
  "Never return a key that was not described.",
].join(" ");

/**
 * Composes a system prompt from its parts, so every prompt in the system has the
 * same shape and the JSON contract cannot be forgotten on a new one.
 */
export function composePrompt(sections: readonly string[]): string {
  return [...sections, JSON_OUTPUT_CONTRACT].join("\n\n");
}
