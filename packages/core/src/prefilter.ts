/**
 * The deterministic pre-filter. `[F6]`
 *
 * Six months of a twenty-person group is roughly four and a half thousand
 * messages, and only a fraction of them merit a model's attention. This is what
 * makes a year of history affordable — plain code, no model, run over every message
 * before the Curator sees anything.
 *
 * **Tuned for recall, not precision, and the asymmetry is the whole design.**
 * Wrongly keeping "haha same" costs a fraction of a cent. Wrongly discarding
 * "Sunrise Clinic lets us settle at month end" loses that knowledge before
 * anything was stored, and nothing downstream can recover it — there is no record
 * that a fact was ever there to miss. So the keep signals are deliberately broad,
 * and the discard side is narrow and confident.
 *
 * It lives in core rather than in the worker for the same reason the normaliser
 * does: backfill and live intake must apply the *same* filter. A seeded message
 * judged by different rules than a live one is drift, and it shows up as a seeded
 * behaviour path that mysteriously has no material.
 *
 * `PREFILTER_VERSION` is stamped on every verdict so a better filter can
 * re-examine everything a worse one rejected, instead of that knowledge being lost
 * permanently.
 */

import type { PrefilterVerdict } from "./constants.js";
import { PREFILTER_VERSION } from "./prompts/index.js";
import { containsCredential } from "./redact.js";
import { salientTokens } from "./value-signature.js";

/**
 * **When the rules in this file change, bump `PREFILTER_VERSION`.**
 *
 * It lives in `prompts/index.ts` beside the prompt versions rather than here,
 * because it was already there and one version constant is worth more than a
 * tidily-placed second one. Every message carries the version its verdict was
 * reached under, so raising it is what marks prior discards for re-evaluation.
 * Changing the rules without raising it means an improved filter never sees the
 * messages it was improved for — and nothing will fail to tell you.
 */

/**
 * A message this long is kept regardless of signals.
 *
 * The seeded coverage table requires a durable fact buried inside an otherwise
 * chatty message, specifically so a precision-tuned filter would lose it. Length
 * alone is what catches that case: the fact is in there somewhere and no keyword
 * rule is going to find it reliably.
 *
 * Seven rather than something comfortable like twelve, and the labelled corpus is
 * why. "the intake form template lives in my drive" and "good morning, the clinic
 * changed its terms" are both real durable facts carrying no figure, no date, no
 * modal verb, no handle and no capitalised name — eight and seven words
 * respectively. At twelve the filter dropped both. Group chatter that reaches seven
 * words is usually saying something, and keeping too much is the direction this
 * filter is supposed to fail in.
 */
const SUBSTANTIAL_WORDS = 7;

/** Gratitude only counts as participation evidence when it names people. */
const GRATITUDE_MIN_WORDS = 4;

/**
 * Which rule decided. Recorded for tests and diagnosis, not persisted — the schema
 * holds the verdict and the version, which is what behaviour depends on.
 */
export type PrefilterReason =
  | "no_text"
  | "reaction"
  | "credential"
  | "figure"
  | "temporal"
  | "commitment_language"
  | "holding_language"
  | "proper_noun"
  | "mention"
  | "url"
  | "gratitude"
  | "substantial_length"
  | "no_signal";

export interface PrefilterInput {
  text: string | null;
  /** Media with nothing to read. There is no text to classify, not a judgment. */
  isUnprocessed?: boolean;
}

export interface PrefilterResult {
  verdict: PrefilterVerdict;
  version: number;
  reason: PrefilterReason;
}

/**
 * Words that carry no durable information on their own.
 *
 * A message is treated as a reaction when it is short **and made entirely of these**
 * — which is more robust than matching whole phrases, because chat reactions
 * combine freely. "haha same", "ok cool", "yes exactly", "good morning all" and
 * "lol same here" are all reactions, and enumerating each combination would have
 * missed most of them.
 *
 * Chosen so that no word here can appear in a durable claim without company: "will"
 * and "do" are filler in "will do" but "I will call the printers on Tuesday" is
 * seven words and never reaches this test.
 */
const FILLER_WORDS = new Set([
  "haha",
  "hahaha",
  "hah",
  "lol",
  "lmao",
  "same",
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yeah",
  "no",
  "yep",
  "yup",
  "nope",
  "sure",
  "thanks",
  "thank",
  "you",
  "ty",
  "done",
  "noted",
  "agreed",
  "agree",
  "cool",
  "nice",
  "great",
  "good",
  "morning",
  "night",
  "evening",
  "gm",
  "gn",
  "hi",
  "hello",
  "hey",
  "all",
  "welcome",
  "congrats",
  "congratulations",
  "sorry",
  "oops",
  "true",
  "exactly",
  "here",
  "on",
  "it",
  "will",
  "do",
  "got",
  "sounds",
  "problem",
  "np",
  "please",
  "hmm",
  "oh",
  "wow",
  "too",
  "also",
  "1",
]);

/**
 * Above this length a message is never dismissed as a reaction, however casual its
 * vocabulary. Reactions are short by nature, and the cap stops a long sentence made
 * of common words from being thrown away.
 */
const REACTION_MAX_WORDS = 4;

/** Relative and named dates. "next Tuesday", "end of the month", "last week". */
const TEMPORAL =
  /\b(today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|january|feb|february|march|april|june|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|next\s+week|last\s+week|this\s+week|next\s+month|last\s+month|this\s+month|month\s+end|end\s+of\s+(?:the\s+)?month|end\s+of\s+(?:the\s+)?week|weekend|deadline|due)\b/i;

/** Promising, undertaking, asking someone to do something. */
const COMMITMENT =
  /\b(i'?ll|we'?ll|i\s+will|we\s+will|shall|going\s+to|gonna|need\s+to|needs\s+to|should|must|can\s+you|could\s+you|will\s+you|let\s+me|i\s+can|we\s+can|taking\s+care|sort\s+out|follow\s+up|chase|remind|promise)\b/i;

/**
 * Possession, access and responsibility — the vocabulary of who holds what, which
 * is the single most valuable thing the register stores.
 */
const HOLDING =
  /\b(has|have|had|holds?|holding|owns?|keeps?|keys?|access|login|log\s?in|password|account|signatory|contact|admin|credentials?|card|responsible|in\s+charge|manages?|managing|runs?|handles?|custody|belongs?|registered|settle|settles|invoice|receipt|bank|upi|otp)\b/i;

const MENTION = /@[\p{L}\p{N}_]{2,}/u;
const URL = /\b(?:https?:\/\/|www\.)\S+/i;
const GRATITUDE = /\b(thanks|thank\s+you|kudos|well\s+done|great\s+work|appreciate)\b/i;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * A short message made entirely of filler.
 *
 * Tested against the whole message rather than as a substring search, which is the
 * difference between discarding "good morning" and discarding "good morning, the
 * clinic changed its terms".
 */
function isReaction(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "");

  if (words.length === 0 || words.length > REACTION_MAX_WORDS) return false;
  return words.every((word) => FILLER_WORDS.has(word));
}

/**
 * A capitalised word that is not the first one.
 *
 * A crude proper-noun test, and it earns its place: "the van is Anil's" carries no
 * figure, no date, no modal verb and no handle, but it is exactly the kind of
 * durable fact the register exists to hold. Without this the filter would discard
 * it. Sentences after a full stop are counted as mid-message, which over-keeps
 * slightly — the correct direction to be wrong in.
 */
function hasMidMessageCapital(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.slice(1).some((word) => /^[\p{Lu}][\p{Ll}\p{M}]/u.test(word));
}

/** Nothing but emoji, punctuation or whitespace. */
function isSymbolsOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

/**
 * Classifies one message.
 *
 * Order matters twice over. Whole-message reactions are tested first, so a greeting
 * is not rescued by a keep signal it happens to contain. Everything after that is a
 * keep signal, and the default is discard — which is what holds the candidate rate
 * down to something a cheap model can afford across a six-month backfill.
 */
export function prefilter({ text, isUnprocessed = false }: PrefilterInput): PrefilterResult {
  const version = PREFILTER_VERSION;

  // Media with no caption. Not a judgment about content — there is no content.
  // The message is still stored, flagged `unprocessed`, so the gap is visible.
  if (isUnprocessed || text === null || text.trim() === "") {
    return { verdict: "discarded", version, reason: "no_text" };
  }

  if (isSymbolsOnly(text) || isReaction(text)) {
    return { verdict: "discarded", version, reason: "reaction" };
  }

  // First, because a credential in the group is worth surfacing whatever else the
  // message looks like.
  if (containsCredential(text)) {
    return { verdict: "candidate", version, reason: "credential" };
  }

  // Figures: currency, percentages, dates, bare counts. Shared with the value
  // signature, so "the figure that matters" means one thing across the system.
  if (salientTokens(text).length > 0) {
    return { verdict: "candidate", version, reason: "figure" };
  }

  if (TEMPORAL.test(text)) return { verdict: "candidate", version, reason: "temporal" };
  if (COMMITMENT.test(text)) {
    return { verdict: "candidate", version, reason: "commitment_language" };
  }
  if (HOLDING.test(text)) return { verdict: "candidate", version, reason: "holding_language" };
  if (MENTION.test(text)) return { verdict: "candidate", version, reason: "mention" };
  if (URL.test(text)) return { verdict: "candidate", version, reason: "url" };

  if (GRATITUDE.test(text) && wordCount(text) >= GRATITUDE_MIN_WORDS) {
    return { verdict: "candidate", version, reason: "gratitude" };
  }

  if (hasMidMessageCapital(text)) {
    return { verdict: "candidate", version, reason: "proper_noun" };
  }

  if (wordCount(text) >= SUBSTANTIAL_WORDS) {
    return { verdict: "candidate", version, reason: "substantial_length" };
  }

  return { verdict: "discarded", version, reason: "no_signal" };
}
