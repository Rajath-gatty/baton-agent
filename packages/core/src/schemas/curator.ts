/**
 * Curator output. `[F7]` `[F11]`
 *
 * This is the flattest schema in the system, by deliberate choice. The Curator
 * runs on every candidate message — roughly eighty percent of token volume and
 * thousands of calls across a backfill — so any per-call conformance failure rate
 * compounds. Nested schemas are where cheap models break, so there is exactly one
 * level of nesting here: a message result carrying a list of records, each record
 * a flat bag of scalars.
 *
 * Two shape decisions follow from the same reasoning:
 *
 *   - Fields are **required and nullable** rather than optional. A model asked for
 *     every key every time is more reliable than one deciding which keys apply, and
 *     an explicit `null` is evidence the model considered the field rather than
 *     forgot it.
 *   - Mentions are returned **as written**. The Curator does not resolve identity;
 *     that is the Cartographer's single judgment, and a Curator that guessed would
 *     make ambiguity unrepresentable before anything could escalate it.
 *
 * Each message is classified **independently** — the prompt forbids cross-message
 * inference — which is what makes the per-message `content_hash` cache sound. That
 * is a correctness requirement, not a prompt style preference: batches are formed
 * from cache misses only, and batch composition changes on every run.
 */

import { z } from "zod";
import {
  ASSET_KINDS,
  ASSET_SENSITIVITIES,
  CURATOR_CLASSIFICATIONS,
  CURATOR_RECORD_KINDS,
  LIFECYCLE_KINDS,
} from "../constants.js";

/** 0 to 1. The Curator's own confidence in the record, not in the classification. */
const confidence = z.number().min(0).max(1);

export const curatorRecordSchema = z.object({
  kind: z.enum(CURATOR_RECORD_KINDS),
  /** The sentence Baton will store and later quote back. One claim, not a summary. */
  claim: z.string().min(1),
  confidence,

  /** Null for a record that is not about a thing — a capability, say. */
  assetKind: z.enum(ASSET_KINDS).nullable(),
  assetName: z.string().nullable(),
  /**
   * Recorded here because it drives approval routing and the deterministic
   * consequence classification downstream. The model supplies the signal; code
   * decides what to do about it.
   */
  sensitivity: z.enum(ASSET_SENSITIVITIES),

  /** Verbatim, as written: "Priya", "@priya_pc", "Pri", "the coordinator". */
  holderMention: z.string().nullable(),
  /** For participation evidence: everyone a thanks-list names. */
  subjectMentions: z.array(z.string()),
  capabilityName: z.string().nullable(),

  /** Verbatim: "next Tuesday", "end of the month". Kept so provenance can quote it. */
  deadlineText: z.string().nullable(),
  /**
   * The same date resolved to `YYYY-MM-DD` against the group's timezone, which the
   * prompt supplies. Resolving against UTC at IST shifts dates by a day and looks
   * like a bug in provenance rather than a timezone mistake.
   */
  deadlineDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .nullable(),

  /**
   * Someone relaying what a third party said. Written at low confidence with
   * `unverified` status, which keeps it out of detection SQL entirely.
   */
  isHearsay: z.boolean(),
  /** An arrangement explicitly ended. Retires the matched fact rather than superseding it. */
  isNegation: z.boolean(),
  lifecycleKind: z.enum(LIFECYCLE_KINDS).nullable(),
});
export type CuratorRecord = z.infer<typeof curatorRecordSchema>;

export const curatorMessageResultSchema = z.object({
  /** Echoed back from the request so a batch of ten cannot be misattributed. */
  messageId: z.string().min(1),
  classification: z.enum(CURATOR_CLASSIFICATIONS),
  /**
   * One line, stored on the fact and shown in the detail panel. A finding that
   * reads oddly is traceable to the sentence the Curator wrote about it.
   */
  reasoning: z.string(),
  /**
   * Empty for noise, and one message may carry several — a fact and a commitment
   * in the same sentence is common. An extractor obliged to find something in
   * every message produces a register full of jokes, so returning nothing here is
   * a first-class outcome rather than a failure.
   */
  records: z.array(curatorRecordSchema),
});
export type CuratorMessageResult = z.infer<typeof curatorMessageResultSchema>;

export const curatorOutputSchema = z.object({
  results: z.array(curatorMessageResultSchema),
});
export type CuratorOutput = z.infer<typeof curatorOutputSchema>;
