/**
 * Per-task payload and context schemas.
 *
 * The envelope in `envelope.ts` leaves `payload` and `context` as `unknown` on
 * purpose, so adding a task does not touch the envelope. These are the schemas
 * each task handler validates its own input against.
 *
 * **Context is per-task, and the omissions are the design.** Hydrating the whole
 * register into every request would multiply cost by the size of the register, so
 * each task receives only what it can use. Two omissions in particular are load
 * bearing rather than incidental:
 *
 *   - **`ingest` does not receive the fact index.** The Curator classifies text;
 *     it does not consult the register. This is also what keeps the per-message
 *     `content_hash` cache sound: an extractor whose output depended on register
 *     state at call time could not be cached on message content alone.
 *   - **`brief` does not receive the whole register**, only the subject's
 *     holdings, their open commitments, and the coverage sets touching them.
 *
 * Every id crossing this boundary is a `string` rather than a branded uuid. The
 * agent never constructs an id and never writes one; it echoes back what the
 * worker sent so the worker can match a result to the row it came from.
 */

import { z } from "zod";
import {
  ALIAS_KINDS,
  ASSET_KINDS,
  ASSET_SENSITIVITIES,
  BRIEF_KINDS,
  FINDING_SEVERITIES,
  FINDING_SUBTYPES,
  FINDING_TYPES,
  QUIET_DECISION_SCOPES,
} from "../constants.js";
import { assessorOutputSchema } from "./assessor.js";
import { brieferOutputSchema } from "./briefer.js";
import { cartographerOutputSchema } from "./cartographer.js";
import { curatorOutputSchema } from "./curator.js";
import { respondentOutputSchema } from "./respondent.js";

/** An ISO 8601 instant. Serialised as a string because JSON has no date type. */
const isoTimestamp = z.string().min(1);

// ─────────────────────────────────────────────────────────────────────────────
// Shared context fragments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of `person_aliases`, flattened. Alias is deliberately not unique — two
 * volunteers can both be "Priya" — so the same alias may appear more than once
 * with different `personId`s. That repetition *is* the ambiguity signal the
 * Cartographer escalates on, so it must survive hydration rather than being
 * de-duplicated on the way in.
 */
export const aliasEntrySchema = z.object({
  personId: z.string().min(1),
  alias: z.string().min(1),
  kind: z.enum(ALIAS_KINDS),
  displayName: z.string().min(1),
});
export type AliasEntry = z.infer<typeof aliasEntrySchema>;

/** An entry in the assets index, enough for the Curator to reuse an existing name. */
export const assetEntrySchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(ASSET_KINDS),
  name: z.string().min(1),
  normalisedKey: z.string().min(1),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

/**
 * One claim in the fact index. A couple of hundred of these is a few thousand
 * tokens, which is precisely why this system has no vector store: the entire
 * retrievable surface fits in the request.
 */
export const factIndexEntrySchema = z.object({
  factId: z.string().min(1),
  claim: z.string().min(1),
  assetName: z.string().nullable(),
  assetSensitivity: z.enum(ASSET_SENSITIVITIES),
  holderPersonId: z.string().nullable(),
  holderDisplayName: z.string().nullable(),
  lastConfirmedAt: isoTimestamp,
  /**
   * Computed by the worker against the group's timezone, not by the model.
   * Arithmetic on dates is exactly the kind of work a cheap model gets subtly
   * wrong, and the staleness warning is unfalsifiable if the number is invented.
   */
  ageDays: z.number().int().nonnegative(),
  evidenceMessageIds: z.array(z.string()),
});
export type FactIndexEntry = z.infer<typeof factIndexEntrySchema>;

export const openCommitmentSchema = z.object({
  commitmentId: z.string().min(1),
  substance: z.string().min(1),
  ownerPersonId: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  promisedAt: isoTimestamp,
  deadline: isoTimestamp.nullable(),
  /** Days past the deadline, or past `promisedAt` where there is no deadline. */
  overdueDays: z.number().int().nullable(),
  evidenceMessageIds: z.array(z.string()),
});
export type OpenCommitment = z.infer<typeof openCommitmentSchema>;

export const holdingEntrySchema = z.object({
  holdingId: z.string().min(1),
  assetId: z.string().min(1),
  assetName: z.string().min(1),
  assetKind: z.enum(ASSET_KINDS),
  assetSensitivity: z.enum(ASSET_SENSITIVITIES),
  isPersonalResource: z.boolean(),
  /** How many other active holders the same asset has. Zero means sole holder. */
  otherActiveHolders: z.number().int().nonnegative(),
  evidenceFactIds: z.array(z.string()),
  evidenceMessageIds: z.array(z.string()),
});
export type HoldingEntry = z.infer<typeof holdingEntrySchema>;

export const coverageEntrySchema = z.object({
  capabilityId: z.string().min(1),
  capabilityName: z.string().min(1),
  /** People observed doing it. One is the capability variant of `sole_holder`. */
  observedPersonIds: z.array(z.string()),
  evidenceMessageIds: z.array(z.string()),
});
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

/**
 * Organisation-level facts every producing agent needs in order to phrase output
 * about this group rather than a generic one.
 */
export const orgContextSchema = z.object({
  orgName: z.string().min(1),
  /**
   * Relative dates resolve against this, never UTC. At IST, UTC shifts dates by a
   * day and reads as a bug in provenance rather than a timezone mistake.
   */
  timezone: z.string().min(1),
  /** The instant the worker started the run. The model is never asked "what is today". */
  now: isoTimestamp,
});
export type OrgContext = z.infer<typeof orgContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One candidate message. Batched ten at a time to amortise the system prompt,
 * but classified **independently** — the prompt forbids cross-message inference,
 * which is what makes per-message caching sound.
 */
export const candidateMessageSchema = z.object({
  messageId: z.string().min(1),
  /** As written. The Curator does not resolve identity; that is the Cartographer's job. */
  senderMention: z.string().min(1),
  sentAt: isoTimestamp,
  text: z.string().min(1),
  /** The text of the message this replies to, where there is one. Context, not a candidate. */
  replyToText: z.string().nullable(),
});
export type CandidateMessage = z.infer<typeof candidateMessageSchema>;

export const ingestPayloadSchema = z.object({
  messages: z.array(candidateMessageSchema).min(1),
});
export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

export const ingestContextSchema = z.object({
  org: orgContextSchema,
  aliases: z.array(aliasEntrySchema),
  assets: z.array(assetEntrySchema),
});
export type IngestContext = z.infer<typeof ingestContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// assess
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A candidate finding, produced by one of the five detection queries. The
 * Assessor receives these and never counts, groups or filters — SQL has already
 * done that. It supplies severity, phrasing, aggregation and suppression.
 */
export const findingCandidateSchema = z.object({
  /** The upsert target, echoed back unchanged. Built by the worker, never by the model. */
  dedupeKey: z.string().min(1),
  type: z.enum(FINDING_TYPES),
  subtype: z.enum(FINDING_SUBTYPES),

  /** What the finding is about, already resolved to a name by the worker. */
  subjectName: z.string().min(1),
  subjectAssetId: z.string().nullable(),
  subjectCapabilityId: z.string().nullable(),
  subjectCommitmentId: z.string().nullable(),
  assetKind: z.enum(ASSET_KINDS).nullable(),
  assetSensitivity: z.enum(ASSET_SENSITIVITIES).nullable(),

  /** A plain attribute. The finding is about the gap, not the person. */
  holderPersonId: z.string().nullable(),
  holderDisplayName: z.string().nullable(),

  evidenceFactIds: z.array(z.string()),
  evidenceMessageIds: z.array(z.string()),
  /**
   * How many messages support this. The Assessor suppresses below a threshold, and
   * a count it derived itself would be a count it could get wrong.
   */
  evidenceCount: z.number().int().nonnegative(),
  /** Quoted so a judgment about thin evidence has the evidence to hand. */
  evidenceExcerpts: z.array(z.string()),

  /** Which capability area this sits in, for aggregation. Null where there is none. */
  capabilityArea: z.string().nullable(),

  /**
   * The severity this key carried on the previous sweep, or null if the key is new.
   * **This is what gates Restraint on the findings path.** Sweeps re-derive
   * findings from scratch, so without it an ungated Restraint would re-veto the
   * same settled items on every sweep forever — the second-largest model consumer
   * in the system, producing no new information, and churning the quiet-decisions
   * strip between sweeps for no reason a coordinator can observe.
   */
  previousSeverity: z.enum(FINDING_SEVERITIES).nullable(),
});
export type FindingCandidate = z.infer<typeof findingCandidateSchema>;

export const assessPayloadSchema = z.object({
  candidates: z.array(findingCandidateSchema),
});
export type AssessPayload = z.infer<typeof assessPayloadSchema>;

export const assessContextSchema = z.object({
  org: orgContextSchema,
  openCommitments: z.array(openCommitmentSchema),
  /** People count only, never names: phrasing is about capabilities. */
  activeMemberCount: z.number().int().nonnegative(),
});
export type AssessContext = z.infer<typeof assessContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// brief
// ─────────────────────────────────────────────────────────────────────────────

export const briefPayloadSchema = z.object({
  kind: z.enum(BRIEF_KINDS),
  subjectPersonId: z.string().min(1),
  subjectDisplayName: z.string().min(1),
});
export type BriefPayload = z.infer<typeof briefPayloadSchema>;

export const briefContextSchema = z.object({
  org: orgContextSchema,
  /** The subject's active holdings. Not the whole inventory. */
  holdings: z.array(holdingEntrySchema),
  openCommitments: z.array(openCommitmentSchema),
  /** Only the coverage sets that touch the subject. */
  coverage: z.array(coverageEntrySchema),
});
export type BriefContext = z.infer<typeof briefContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// respond
// ─────────────────────────────────────────────────────────────────────────────

export const respondPayloadSchema = z.object({
  questionText: z.string().min(1),
  questionMessageId: z.string().min(1),
  askedByPersonId: z.string().nullable(),
  askedByMention: z.string().min(1),
});
export type RespondPayload = z.infer<typeof respondPayloadSchema>;

export const respondContextSchema = z.object({
  org: orgContextSchema,
  factIndex: z.array(factIndexEntrySchema),
  aliases: z.array(aliasEntrySchema),
  /**
   * Whether a new question may be asked at all. The budget itself is counted in
   * SQL against `questions`; the agent is told the answer rather than trusted to
   * remember it, because a prompt cannot count what it already asked.
   */
  askBudgetAvailable: z.boolean(),
  /** Above this, an answer carries a staleness warning. */
  staleThresholdDays: z.number().int().positive(),
});
export type RespondContext = z.infer<typeof respondContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// resume
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A resume carries the task it is resuming, so the container can rebuild the same
 * agent and restore the snapshot into it. The snapshot and the interrupt responses
 * travel on the envelope rather than here.
 */
export const resumePayloadSchema = z.object({
  /** The task that was interrupted. `resume` resuming itself is not meaningful. */
  originalTask: z.enum(["ingest", "assess", "brief", "respond"]),
});
export type ResumePayload = z.infer<typeof resumePayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Task results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A withheld item, on its way to a `quiet_decisions` row.
 *
 * `scope` records which produce path the decision came from, which is what lets a
 * test assert the veto has not silently narrowed to findings during a refactor —
 * leaving ungated the two surfaces a human actually reads aloud.
 */
export const quietDecisionRecordSchema = z.object({
  scope: z.enum(QUIET_DECISION_SCOPES),
  /** What was withheld, as text a coordinator can read. */
  withheld: z.string().min(1),
  /** Item-level or organisation-level. Never about a person. */
  reason: z.string().min(1),
  /** Present when the withheld item was a finding, so the strip can link to it. */
  findingDedupeKey: z.string().nullable(),
});
export type QuietDecisionRecord = z.infer<typeof quietDecisionRecordSchema>;

export const ingestResultSchema = z.object({
  curator: curatorOutputSchema,
  cartographer: cartographerOutputSchema,
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

export const assessResultSchema = z.object({
  findings: assessorOutputSchema.shape.findings,
  quietDecisions: z.array(quietDecisionRecordSchema),
});
export type AssessResult = z.infer<typeof assessResultSchema>;

export const briefResultSchema = z.object({
  brief: brieferOutputSchema,
  quietDecisions: z.array(quietDecisionRecordSchema),
});
export type BriefResult = z.infer<typeof briefResultSchema>;

export const respondResultSchema = z.object({
  reply: respondentOutputSchema,
  /**
   * An answer Restraint withheld leaves a quiet decision and no reply text. The
   * worker sends nothing to the group in that case, which is the entire point.
   */
  withheld: z.boolean(),
  quietDecisions: z.array(quietDecisionRecordSchema),
});
export type RespondResult = z.infer<typeof respondResultSchema>;
