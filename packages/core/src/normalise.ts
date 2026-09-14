/**
 * Text normalisation and content hashing.
 *
 * These are shared rather than local because the same string must normalise
 * identically in three places that never see each other: the worker writing
 * `person_aliases.normalised_alias`, the Cartographer's deterministic alias pass
 * inside the agent container, and the backfill script loading the seeded
 * transcript. A divergence between any two of them does not raise an error — it
 * silently stops matching, and a mention that should have resolved to a person
 * quietly becomes an unresolved one.
 */

import { createHash } from "node:crypto";

/**
 * Case-folds, strips the leading `@` of a handle, removes punctuation and collapses
 * whitespace. "Priya!", "@priya", "  PRIYA " all normalise to "priya".
 *
 * `\p{M}` — combining marks — is kept alongside letters and numbers, and that is not
 * incidental. Devanagari vowel signs and the virama are marks rather than letters, so
 * a class of `\p{L}\p{N}` alone turns "प्रिया" into "परय": a different string, matching
 * nothing, for a roster where names are written in more than one script.
 */
export function normaliseAlias(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Articles carry no identifying information in an asset name, and whether someone
 * writes "the van" or "van" is not a distinction the register should hold two rows
 * over.
 *
 * Removed wherever they appear as whole words rather than only at the start, so
 * "keys to the van" and "keys to van" reach the same key. This is more aggressive
 * than leading-only stripping and deliberately so: `normalised_key` exists to make
 * two spellings of one asset collide, and under-normalising produces the exact
 * failure `facts.match_key` was added to prevent.
 */
const ARTICLES = new Set(["the", "a", "an"]);

/**
 * Case-folds and de-articles an asset or capability name.
 *
 * This is what `assets.normalised_key` holds and what `facts.match_key` is built
 * from. Note that the committed seed plan fixture carries its own hand-written
 * `normalisedKey` values which are *not* de-articled ("the van" stays "the van").
 * That fixture is byte-compared against `buildPlan()` by a test, so it is left
 * alone: the worker computes its own key from the asset **name** and treats the
 * plan's key as a planning artifact.
 */
export function normaliseAssetKey(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned === "") return "";

  const kept = cleaned.split(" ").filter((word) => !ARTICLES.has(word));
  // An asset genuinely named "The A" would otherwise normalise to nothing, and an
  // empty key would collide with every other empty key.
  return kept.length === 0 ? cleaned : kept.join(" ");
}

/**
 * Half of the curator cache key, the other half being `prompt_version`.
 *
 * Hashes the text **exactly as stored**, with no normalisation, because the
 * property being bought is that an edit misses the cache. Normalising whitespace
 * here would let a corrected message reuse the classification of the text it
 * replaced, which is the one thing this key exists to prevent.
 *
 * Null text — a voice note or an image — hashes as the empty string. Those
 * messages are flagged `unprocessed` and never curated, so they share a hash
 * without consequence.
 */
export function contentHash(text: string | null): string {
  return createHash("sha256")
    .update(text ?? "", "utf8")
    .digest("hex");
}
