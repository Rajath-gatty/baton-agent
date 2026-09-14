/**
 * The two keys the register's correctness rests on.
 *
 * Both are built here, by code, and never by a model. A model that invented a key
 * would be inventing the identity of a row — and since both keys are upsert
 * targets, a wrong one does not fail loudly. It silently duplicates, or silently
 * resurrects something a coordinator already dismissed.
 *
 *   - `facts.match_key` groups claims about the same aspect of the same asset, so a
 *     restatement can be recognised. Without it every mention of the van keys
 *     becomes another active row.
 *   - `findings.dedupe_key` is the identity of a finding across sweeps. Sweeps
 *     re-derive findings from scratch, so without it every sweep either duplicates
 *     the register or brings back a dismissal.
 */

import type { AssetKind, FindingSubtype, FindingType } from "./constants.js";
import { normaliseAssetKey } from "./normalise.js";

/**
 * Which aspect of a subject a claim speaks to.
 *
 * Two aspects, because they behave differently under restatement: who holds a
 * thing changes hands, while what the arrangement *is* changes terms. Keeping them
 * in separate key groups stops "Meera set up the page" and "the page settles at
 * month end" from ever being compared to each other.
 */
export type ClaimAspect = "holder" | "attribute";

/** Stopwords dropped from an assetless claim key. Ordinary connective prose. */
const CLAIM_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "we",
  "us",
  "our",
  "i",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "that",
  "this",
  "it",
  "they",
  "them",
  "has",
  "have",
  "had",
  "will",
  "with",
  "from",
  "by",
]);

/**
 * A coarse key for a claim that references no asset and no capability.
 *
 * Significant words, de-duplicated and sorted, so word order and connective prose
 * do not split one claim into two. This is the weakest of the three key forms and
 * that is acceptable: a fact with no asset can be answered by the Respondent but
 * can never produce a risk finding, so a near-duplicate here costs an extra row in
 * the register and nothing else.
 */
function claimKey(claim: string): string {
  const words = normaliseAssetKey(claim)
    .split(" ")
    .filter((word) => word !== "" && !CLAIM_STOPWORDS.has(word));
  return [...new Set(words)].sort().join("-");
}

export interface MatchKeyInput {
  /** Null where the claim references no asset. */
  assetKind: AssetKind | null;
  assetName: string | null;
  /** Used only when there is no asset — a capability-scoped claim. */
  capabilityName?: string | null;
  claim: string;
  aspect: ClaimAspect;
}

/**
 * Builds `facts.match_key`.
 *
 * Three shapes, tried in order of how well they identify the subject: an asset
 * reference, then a capability reference, then the claim's own significant words.
 * The aspect is always appended, so the holder of a thing and the terms of a thing
 * never collide.
 *
 * Readable rather than hashed on purpose. This column is the first thing anyone
 * looks at when the register fills with near-duplicates, and an opaque digest
 * would make that diagnosis guesswork.
 */
export function buildMatchKey({
  assetKind,
  assetName,
  capabilityName,
  claim,
  aspect,
}: MatchKeyInput): string {
  if (assetName !== null && assetName.trim() !== "") {
    const key = normaliseAssetKey(assetName);
    if (key !== "") return `${assetKind ?? "unknown"}:${key}#${aspect}`;
  }

  if (capabilityName !== undefined && capabilityName !== null && capabilityName.trim() !== "") {
    const key = normaliseAssetKey(capabilityName);
    if (key !== "") return `capability:${key}#${aspect}`;
  }

  return `claim:${claimKey(claim)}#${aspect}`;
}

/** Derives the aspect from whether the Curator named a holder. */
export function aspectFor(holderMention: string | null): ClaimAspect {
  return holderMention !== null && holderMention.trim() !== "" ? "holder" : "attribute";
}

export interface DedupeKeyInput {
  subtype: FindingSubtype;
  /**
   * The subject class. This is what distinguishes the two detection queries that
   * both render as `sole_holder` — an asset with one holder, and a capability with
   * one observed participant. Without it those two would share a key and the
   * second would overwrite the first.
   */
  type: FindingType;
  /** The subject's id. A uuid, so the key is stable across sweeps. */
  subjectId: string;
}

/**
 * Builds `findings.dedupe_key`.
 *
 * Built from ids rather than names, because a finding must keep its identity when
 * an asset is renamed — dismissals are recorded against this key, and a renamed
 * asset resurrecting a dismissed finding is exactly the failure the column exists
 * to prevent.
 */
export function buildDedupeKey({ subtype, type, subjectId }: DedupeKeyInput): string {
  return `${subtype}:${type}:${subjectId}`;
}
