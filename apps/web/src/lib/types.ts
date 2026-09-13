/**
 * Local view types for the Baton admin UI.
 *
 * These are *render* types, not the persisted shape — the database schema does
 * not exist yet, and when it lands these will be derived from Drizzle rows via
 * the seam in `data.ts`. They are built on the domain vocabulary from
 * `@baton/core` so a status or subtype string can never drift from the contract
 * the agent and worker share.
 *
 * A note that governs every type below: no view type has a volunteer as its
 * subject. `holderName` and `personName` appear as *attributes of a capability
 * or an asset*, never as the thing a row is about. There is no reliability
 * score, no attendance count, no comparison field. Baton describes what the
 * organisation knows and who alone has been seen holding it — never what a
 * person can or cannot do.
 */

import type {
  AssetKind,
  AssetSensitivity,
  BriefSection,
  FactStatus,
  FindingSeverity,
  FindingStatus,
  FindingSubtype,
  PersonStatus,
  QuestionKind,
  QuestionStatus,
  TraceEntry,
} from "@baton/core";

/** An ISO-8601 timestamp string. Rendered in Asia/Kolkata; see `format.ts`. */
export type IsoTimestamp = string;

/**
 * A finding: the register's unit of exposure. Its `title` is always phrased
 * about a capability or an asset — "The clinic settlement is held by one
 * person", never a name as the grammatical subject. `holderName` is nullable
 * because a loose end or an unowned asset has no holder at all.
 */
export interface Finding {
  id: string;
  subtype: FindingSubtype;
  severity: FindingSeverity;
  status: FindingStatus;
  /** About a capability, never a person. */
  title: string;
  /** Why this matters to continuity, in the coordinator's terms. */
  whyItMatters: string;
  /** How many source messages support this finding. */
  evidenceCount: number;
  /** The assessor's confidence, 0–1. */
  confidence: number;
  /** The name of who alone has been seen holding this, if applicable. */
  holderName: string | null;
  /** Stable key that collapses re-detections of the same exposure. */
  dedupeKey: string;
  firstSeenAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
  /** The assessor's own account of why it raised this. */
  assessorReasoning: string;
  /** Present only when `status` is `dismissed`. */
  dismissalReason: string | null;
}

/**
 * A durable fact: something the organisation knows, extracted verbatim from a
 * message. The provenance chain lives on `sourceMessage`. `supersedes` points
 * at the fact this one replaced, forming a chain the panel walks.
 */
export interface Fact {
  id: string;
  status: FactStatus;
  /** The claim, in Baton's words. */
  statement: string;
  /** The message this was extracted from, quoted verbatim (redacted at render). */
  sourceMessage: SourceMessage;
  /** The prior fact this one superseded, if any. */
  supersedes: string | null;
  /** The topic this fact belongs to, e.g. "Clinic — Dr Rao". */
  topic: string;
  recordedAt: IsoTimestamp;
}

/**
 * A source message, stored verbatim because provenance depends on it.
 * `text` is the raw text; redaction happens at render via `redactCredentials`.
 */
export interface SourceMessage {
  id: string;
  /** The volunteer's display name — an attribute of the message, not a subject. */
  authorName: string;
  /** Raw text. Never rendered without `redactCredentials`. */
  text: string;
  sentAt: IsoTimestamp;
}

/**
 * A holding: a link between a person and an asset. `holder` is null when the
 * asset is owned by no one (a loose end). `isPersonalResource` marks something
 * that belongs to a volunteer personally — their own van — which the
 * organisation relies on but does not own, a distinct kind of exposure.
 */
export interface Holding {
  id: string;
  assetId: string;
  /** Null when no one has been seen holding this. */
  holder: string | null;
  isPersonalResource: boolean;
  /** Whether this holder has been seen exercising it, not whether they could. */
  lastSeenAt: IsoTimestamp | null;
  note: string;
}

/** An asset the organisation depends on. */
export interface Asset {
  id: string;
  kind: AssetKind;
  sensitivity: AssetSensitivity;
  /** A plain label, e.g. "Instagram — @streetpaws.blr". */
  label: string;
  description: string;
  recordedAt: IsoTimestamp;
}

/**
 * A person known to the register. Never the subject of a page. Present only so
 * a holder name can be resolved and a status shown; carries no score, rating,
 * attendance, or comparison.
 */
export interface Person {
  id: string;
  displayName: string;
  status: PersonStatus;
}

/** One line within a brief section. */
export interface BriefLine {
  /** The capability or commitment described, never a person as subject. */
  text: string;
  /** The fact this line traces back to, opened via the claim primitive. */
  factId: string | null;
}

/** A brief: what changed about the organisation's exposure, in three sections. */
export interface Brief {
  id: string;
  /** Human title, e.g. "Priya stepped back — 14 Aug". */
  title: string;
  /** The membership or lifecycle event that triggered this brief. */
  trigger: string;
  generatedAt: IsoTimestamp;
  read: boolean;
  /** The three fixed sections, keyed by `BriefSection`, order fixed by core. */
  sections: Record<BriefSection, BriefLine[]>;
}

/**
 * A question Baton wants answered. `askedAt` is null while `status` is
 * `queued` — a question rationed out by the ask budget is stored, not dropped,
 * and a null timestamp keeps it out of the rolling window.
 */
export interface Question {
  id: string;
  kind: QuestionKind;
  status: QuestionStatus;
  /** The question text, phrased as a matter of fact, not a judgement. */
  text: string;
  /** Why Baton needs this answered. */
  rationale: string;
  /** The fact or finding this question hangs off, if any. */
  factId: string | null;
  createdAt: IsoTimestamp;
  /** Null while queued. */
  askedAt: IsoTimestamp | null;
}

/**
 * A quiet decision: something Baton deliberately did NOT surface, and why. This
 * is the product's signature — restraint made visible. Reasoning is item-level
 * or org-level and is NEVER about a person.
 */
export interface QuietDecision {
  id: string;
  /** What was withheld, e.g. "Did not raise a second finding for the van keys". */
  summary: string;
  /** The reason, about the item or the organisation — never about a volunteer. */
  reasoning: string;
  /** Whether the reasoning is scoped to one item or the whole register. */
  scope: "item" | "org";
  decidedAt: IsoTimestamp;
}

/** A commitment a volunteer made, tracked so an unmet one becomes a loose end. */
export interface Commitment {
  id: string;
  /** What was promised, phrased about the task, e.g. "The vet forms would be filed". */
  text: string;
  /** The person who made it — an attribute, not the subject. */
  byName: string;
  madeAt: IsoTimestamp;
  /** When it was said to be due, if a date was given. */
  dueAt: IsoTimestamp | null;
  fulfilled: boolean;
  sourceMessageId: string;
}

/** One line of change since the coordinator last looked. */
export interface Diff {
  id: string;
  /** "added" | "changed" | "resolved" | "withheld" — what happened. */
  kind: "added" | "changed" | "resolved" | "withheld";
  /** The change described in one line, about a capability. */
  text: string;
  /** The fact or finding it concerns, if traceable. */
  factId: string | null;
  at: IsoTimestamp;
}

/**
 * A run: one pass of the agent over new messages. `trace` is the agent's own
 * account, the same `TraceEntry[]` shape core defines, stored so the activity
 * view reads from one database rather than CloudWatch.
 */
export interface Run {
  id: string;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  /** How many messages this run considered. */
  messagesConsidered: number;
  /** How many became durable facts. */
  factsRecorded: number;
  /** How many findings this run raised or updated. */
  findingsTouched: number;
  status: "complete" | "running" | "error";
  trace: TraceEntry[];
}
