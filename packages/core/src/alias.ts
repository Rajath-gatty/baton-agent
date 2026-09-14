/**
 * Alias normalisation.
 *
 * One function, in core, because it is used in two places that **must** agree:
 * `person_aliases.normalised_alias` is written with it when identity is loaded, and
 * the Cartographer's deterministic matcher looks up against it. Two copies would be a
 * silent bug of the worst kind — every mention would escalate to the model for
 * clarification, the ask budget would fill with questions nobody needed to answer,
 * and nothing would look broken.
 *
 * `\p{M}` — combining marks — is kept alongside letters and numbers, and that is not
 * incidental. Devanagari vowel signs and the virama are marks rather than letters, so
 * a class of `\p{L}\p{N}` alone turns "प्रिया" into "परय": a different string,
 * matching nothing, for a roster where names are written in more than one script.
 */

/**
 * Case-folds, strips a leading handle marker, removes punctuation and collapses
 * whitespace. "Priya!", "@priya" and "  PRIYA " all normalise to "priya".
 */
export function normaliseAlias(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
