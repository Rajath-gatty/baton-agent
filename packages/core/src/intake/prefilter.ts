/**
 * The pre-filter. `[F6]`
 *
 * Deterministic heuristics over the seeded transcript, of which roughly one in five
 * should reach a model. This is what allows six agents to run on a cheap model at
 * all: it removes the four fifths of a volunteer group's chat that is logistics and
 * acknowledgement, before anything is paid for.
 *
 * **Tuned for recall, deliberately and asymmetrically.** A false keep costs a
 * fraction of a cent — the Curator classifies it as noise and nothing is stored. A
 * false discard loses knowledge before anything is stored, and nobody ever finds out.
 * So the rule is: keep unless the message looks like pure acknowledgement *and*
 * carries no signal at all. Precision only costs money; recall costs the product.
 *
 * `prefilter_version` is stored beside every verdict, kept and discarded alike, so an
 * improved filter can re-examine prior rejections instead of them being lost
 * permanently.
 *
 * No model, no database, no network. Given the same text and version this returns the
 * same verdict forever, which is what makes it testable against a labelled corpus.
 */

import { containsCredential } from "../redact.js";
import type { PrefilterVerdict } from "../constants.js";

/**
 * Bumping this marks previously discarded messages for re-evaluation.
 *
 * Declared here rather than imported from `prompts` because this is not a prompt and
 * its version moves for different reasons — a heuristic change, not a wording change.
 */
export const PREFILTER_VERSION = 1;

/** Why a message was kept. Recorded for tuning, and legible in a review. */
export type KeepSignal =
  | "asset_noun"
  | "holding_language"
  | "commitment_language"
  | "reported_speech"
  | "termination"
  | "figure"
  | "temporal_reference"
  | "money"
  | "participation"
  | "lifecycle"
  | "contact_detail"
  | "forward_marker"
  | "credential"
  | "media"
  | "substantial_length";

export interface PrefilterResult {
  verdict: PrefilterVerdict;
  version: number;
  /** Empty on a discard. More than one is common and is not a problem. */
  signals: KeepSignal[];
}

/**
 * Things a volunteer group holds. Nouns rather than verbs, because the noun is what
 * survives paraphrase: "who's got the van keys" and "keys for the van are with me"
 * share only "keys" and "van".
 *
 * Deliberately **not** general English. "number", "list", "page", "store" and "sheet"
 * were all in an earlier revision and each of them fires on ordinary chatter — they took
 * the keep rate up by roughly a third while carrying no planted material that other
 * signals did not already catch. "rate" is kept, because the question a volunteer
 * actually asks in the transcript is "what's our sterilisation rate these days".
 */
const ASSET_NOUNS =
  /\b(key|keys|login|logins|password|passwords|account|accounts|card|cards|van|vehicle|scooter|bike|truck|contact|contacts|code|codes|spreadsheet|form|forms|invoice|invoices|receipt|receipts|licen[cs]\w*|permit|registration|insurance|lease|agreement|contract|domain|website|inbox|email|drive|folder|cage|crate|carrier|kennel|microchip|scanner|printer|banner|template|kit|cylinder|generator|freezer|clinic|vet|sponsor\w*|donation|donor|supplier|vendor|landlord|bank|upi|paytm|arrangement|discount|rate|rates|album|instagram|facebook|whatsapp|notice|placement|placements|carer|carers|foster)\b/i;

/** Possession, access and transfer. The verbs that make a holding a holding. */
const HOLDING_LANGUAGE =
  /\b(i have|i've got|i got|has the|have the|holds|holding|keeps|keeping|kept|took|taken|gave|given|handed|hand over|handover|transferr?ed|passed|access|owns|owned|mine|my own|with me|at my|in my|custody|charge of|responsible for|looks after|looking after|manages|managing|admin|owner|route|routing|through me|only one who|nobody else)\b/i;

/**
 * A promise. Stems rather than exact forms — "renew", "renewing" and "renewed" are the
 * same commitment, and matching only the bare stem is how `pm037`'s "not renewing the
 * sponsorship" was missed on the first pass.
 */
const COMMITMENT_LANGUAGE =
  /\b(i'?ll|i will|we'?ll|we will|will do|can do|i can|let me|sort out|sort it|pick up|drop off|drop it|arrang\w*|organi[sz]\w*|schedul\w*|book\w*|order\w*|call them|follow up|chas\w*|send\w*|submit\w*|renew\w*|pay\w*|collect\w*|deliver\w*|remind me|take care of|happy to|going to)\b/i;

/**
 * Reported speech. `[F9]`
 *
 * Somebody relaying what a third party said is hearsay, written at low confidence with
 * `unverified` status — which keeps it out of detection SQL entirely. It is a first-class
 * path in the design, so it needs its own pattern: "Kavya told me the vet said..." has no
 * asset noun and no promise, and was discarded until this existed.
 */
const REPORTED_SPEECH =
  /\b(told me|told us|said that|said we|mentioned|according to|apparently|heard that|reckons|confirmed with|confirmed that|confirmed it|per the|as per)\b/i;

/**
 * Termination and negation. `[F8]`
 *
 * An arrangement explicitly ended retires a fact rather than superseding it, so the
 * ending has to reach the Curator. "Green Paws are not renewing the sponsorship, so that
 * arrangement is finished" is the planted negation case.
 */
const TERMINATION =
  /\b(no longer|not renew\w*|cancell?ed|finished|ended|terminated|withdrawn|pulled out|backed out|stopped|don'?t have|doesn'?t have|no more|not any more|not anymore|stepping|handing)\b/i;

/**
 * A figure the group quotes back. `[F8]`
 *
 * The planted stale-figure case is "our sterilisation rate is running at 62 animals a
 * month" — no money, no asset noun, and the single most important fact in the demo. A
 * bare number is noise; a number with a unit or a period is a claim.
 */
const FIGURE =
  /\b\d+\s*(animals|dogs|cats|puppies|kittens|people|volunteers|families|units|kg|kgs|litres|liters|bags|boxes|beds|slots|a month|a week|a day|per month|per week|per day|percent|%)\b/i;

/**
 * Anything that dates a claim. Kept broadly because the Curator resolves relative
 * dates and cannot resolve what it never sees.
 */
const TEMPORAL_REFERENCE =
  /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|last week|this week|next month|end of the month|eom|deadline|due|by the|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b|\b\d{1,2}[/-]\d{1,2}\b/i;

/** Rupee amounts, in the several forms a group actually writes them. */
const MONEY =
  /(₹|\brs\.?\s*\d|\binr\b|\brupees?\b|\b\d{3,}\s*(rs|rupees)\b|\blakh\b|\bcrore\b|\bbank details\b|\bsettle\b|\bpaying\b|\bpayment\b|\bfees?\b|\bcost\b)/i;

/** Thanks-lists and credit, which is where participation evidence comes from. */
const PARTICIPATION =
  /\b(thanks to|thank you to|thank you|thanks|shoutout|shout out|credit to|great work|well done|good job|nice work|appreciate|couldn'?t have|turned up|showed up|helped|volunteered|came along|was there)\b/i;

/**
 * Joining, leaving, stepping back. The events that fire a brief.
 *
 * Both planted lifecycle messages were missed on the first pass — "I'm moving to Pune so
 * I'm stepping away" matched neither "moving away" nor "stepping back", and an arrival
 * introduces itself rather than announcing a join. The patterns are looser accordingly.
 */
const LIFECYCLE =
  /\b(leaving|i'?m out|stepping (back|away|down|aside)|step back|moving (to|away|out)|relocating|can'?t continue|won'?t be able to continue|last day|joining|just joined|new here|welcome|introduce myself|taking over|handing over|hand(ing)? it over|quitting|resign\w*|been (a )?good|here to help|start where|needed help)\b/i;

/**
 * Phone numbers, emails and links — a contact is an asset the group depends on.
 *
 * The digit group tolerates a space or hyphen in the middle, because that is how an
 * Indian mobile number is actually written: "+91 98450 33221". Requiring ten consecutive
 * digits missed the planted emergency-number message entirely, which is also the message
 * the redaction tests use to prove an emergency number is *never* redacted.
 */
const CONTACT_DETAIL =
  /(\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|https?:\/\/|\bwww\.|(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b)/i;

/** A forward brought outside material in, and the register records where it came from. */
const FORWARD_MARKER = /\b(forwarded|fwd|shared from|posted (the|to)|from the group)\b/i;

/**
 * Pure acknowledgement. The only thing that earns a discard, and only when nothing
 * else in the message fires.
 *
 * Anchored whole-string rather than searched, because "ok" inside a sentence is not
 * an acknowledgement — "ok so who has the van keys" must survive.
 */
const ACKNOWLEDGEMENT =
  /^(ok(ay)?|k|kk|yes|yep|yeah|ya|no|nope|sure|fine|done|noted|got it|gotcha|right|cool|nice|great|thanks|thank you|thx|ty|welcome|np|no problem|any time|anytime|on it|will do|sounds good|agreed|same|me too|haha+|lol|hmm+|oh|ah|👍|🙏|❤️|😂|✅)[\s.!?]*$/i;

/** Only emoji and punctuation. Nothing to classify. */
const EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\p{P}]+$/u;

/**
 * Above this many words, a message counts as substantial.
 *
 * A **supporting** signal, not a triggering one. A long message in a volunteer group is
 * usually somebody telling a story — "the beagle from the gate has been adopted, family
 * came back a second time" — and keeping every long message put the keep rate at 81%
 * against a design target of roughly one in five, which would have quadrupled the
 * Curator's bill for chatter.
 */
const SUBSTANTIAL_WORD_COUNT = 12;

/**
 * Signals that keep a message on their own.
 *
 * Each of these is evidence that durable knowledge might be present: a thing the group
 * holds, possession or transfer of it, a promise, money, credit for work done, somebody
 * joining or leaving, or a contact detail.
 */
const TRIGGERING_PATTERNS: readonly (readonly [KeepSignal, RegExp])[] = [
  ["asset_noun", ASSET_NOUNS],
  ["holding_language", HOLDING_LANGUAGE],
  ["commitment_language", COMMITMENT_LANGUAGE],
  ["reported_speech", REPORTED_SPEECH],
  ["termination", TERMINATION],
  ["figure", FIGURE],
  ["money", MONEY],
  ["participation", PARTICIPATION],
  ["lifecycle", LIFECYCLE],
  ["contact_detail", CONTACT_DETAIL],
  ["forward_marker", FORWARD_MARKER],
];

/**
 * Signals that are only meaningful **alongside** a triggering one.
 *
 * A date word or a long sentence describes how people write in a chat, not what they are
 * writing about. "Six calls today, four were about the same dog" carries a temporal
 * reference and nothing durable; "the van insurance is due next Tuesday" carries the same
 * reference and matters, and it is the asset noun that tells them apart. Promoting these
 * to triggers is what took the keep rate to 81%.
 */
const SUPPORTING_PATTERNS: readonly (readonly [KeepSignal, RegExp])[] = [
  ["temporal_reference", TEMPORAL_REFERENCE],
];

/** Every signal a text fires. Exported so the corpus tests can assert on reasons. */
export function keepSignals(text: string): KeepSignal[] {
  const signals: KeepSignal[] = [];

  for (const [signal, pattern] of TRIGGERING_PATTERNS) {
    if (pattern.test(text)) signals.push(signal);
  }

  // A credential is never a fact in itself — the value is redacted everywhere it is
  // quoted — but the *event* of one being shared is exactly what the register needs.
  if (containsCredential(text)) signals.push("credential");

  return signals;
}

/** The supporting signals a text fires. Recorded, but they never keep a message alone. */
export function supportingSignals(text: string): KeepSignal[] {
  const signals: KeepSignal[] = [];

  for (const [signal, pattern] of SUPPORTING_PATTERNS) {
    if (pattern.test(text)) signals.push(signal);
  }
  if (text.trim().split(/\s+/).length >= SUBSTANTIAL_WORD_COUNT) {
    signals.push("substantial_length");
  }

  return signals;
}

export interface PrefilterInput {
  text: string | null;
  /** Media with no caption is logged rather than dropped, so a gap stays visible. */
  mediaKind?: string | null;
}

/**
 * Classifies one message.
 *
 * A verdict is produced for **every** message, kept and discarded alike, because a
 * discard with no recorded verdict cannot be re-evaluated when the version changes.
 *
 * **Where the recall bias actually lives.** Not in a catch-all that keeps everything
 * unrecognised — that produced an 81% keep rate on the seeded transcript, four times the
 * design's target, by keeping stories about adopted dogs. It lives in how broad the
 * triggering patterns are: many nouns, generous verb forms, questions kept as readily as
 * statements. A message that fires nothing has no signal of durable knowledge in it, and
 * keeping it would only pay a model to agree.
 */
export function prefilter(input: PrefilterInput): PrefilterResult {
  const text = (input.text ?? "").trim();
  const hasMedia = (input.mediaKind ?? null) !== null;

  // Media carries content this filter cannot read. It is kept as a candidate so the
  // gap is recorded rather than silently dropped — a voice note that carried a fact
  // should at least be visible as something Baton could not process.
  if (text === "" && hasMedia) {
    return { verdict: "candidate", version: PREFILTER_VERSION, signals: ["media"] };
  }

  if (text === "") {
    return { verdict: "discarded", version: PREFILTER_VERSION, signals: [] };
  }

  // Checked before the signals, not after, and this ordering is load bearing. A bare
  // "thanks" fires the participation pattern, so testing signals first would keep every
  // acknowledgement in the chat. Anchored whole-string, so "thanks to Ravi for the vet
  // run" — which is real participation evidence — is untouched.
  if (!hasMedia && (ACKNOWLEDGEMENT.test(text) || EMOJI_ONLY.test(text))) {
    return { verdict: "discarded", version: PREFILTER_VERSION, signals: [] };
  }

  const triggering = keepSignals(text);

  if (triggering.length > 0 || hasMedia) {
    return {
      verdict: "candidate",
      version: PREFILTER_VERSION,
      // Supporting signals are recorded on a kept message because they are useful when
      // tuning, but they are never what kept it.
      signals: [...triggering, ...supportingSignals(text), ...(hasMedia ? ["media" as const] : [])],
    };
  }

  return { verdict: "discarded", version: PREFILTER_VERSION, signals: [] };
}
