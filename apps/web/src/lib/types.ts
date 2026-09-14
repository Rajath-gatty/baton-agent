/**
 * Local view types for the Baton admin UI.
 *
 * These are *render* types, not the persisted shape. `lib/data.ts` maps Drizzle
 * rows onto them, and the gap between the two is deliberate: the schema is
 * normalised for the worker's writes, while these are flattened for one page's
 * reading — a finding here carries its holder's name, not a `holder_person_id`.
 * They are built on the domain vocabulary from `@baton/core` so a status or
 * subtype string can never drift from the contract the agent and worker share.
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
  QuietDecisionScope,
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
  /**
   * The first fact in this finding's evidence, so the row is one gesture from
   * provenance like every other claim in the product.
   *
   * Read from `findings.evidence_fact_ids`, not parsed out of `dedupe_key`. The
   * key is built from ids of whatever the finding's *subject* is — an asset, a
   * capability, a commitment — and the fact panel takes a fact id, so deriving
   * one from the other would open the wrong thing. Null when the finding rests on
   * detection SQL alone, which is the ordinary case for `no_owner`: there is no
   * claim behind "nobody is recorded as holding this".
   */
  factId: string | null;
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
  /**
   * The Curator's own account of why this was kept — `facts.curator_reasoning`
   * in the schema. Null when the fact was written by the worker's deterministic
   * path rather than by a model, in which case the panel states the register's
   * rule for that status rather than inventing a reason.
   */
  curatorReasoning: string | null;
  /**
   * Whether the coordinator has withdrawn this claim's provenance.
   *
   * Telegram reports no deletions [F4], so a volunteer who deletes a message
   * leaves Baton still quoting it. This is the coordinator's only remedy: the
   * quote stops being shown while the fact, its status and its trail stay on the
   * record — deleting the fact outright would be a worse lie than a stale quote.
   */
  provenanceWithdrawn: boolean;
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
  /**
   * The fact whose claim put this asset on the register, if one did. Present so
   * a row in the inventory is a traceable claim rather than a bare label — the
   * inventory must be one gesture from provenance like every other surface.
   * Null when the asset was inferred from holdings alone; the row then renders
   * as plain text rather than manufacturing a link to the wrong thing.
   */
  factId: string | null;
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
  /**
   * The `brief_lines` row id. Present because filing a line is a write against
   * that row: identifying it by its text would file the wrong one the moment two
   * sections carried the same sentence.
   */
  id: string;
  /** The capability or commitment described, never a person as subject. */
  text: string;
  /** The fact this line traces back to, opened via the claim primitive. */
  factId: string | null;
  /**
   * Whether this line has already been filed as a record — `assigned_at` is set.
   * Carried on the read so a filed line still reads as filed after a reload,
   * rather than resetting to an unpressed button and inviting a second filing.
   */
  filed: boolean;
}

/**
 * The person a brief is *about* — the volunteer whose arrival or departure
 * triggered it — and whether Baton can reach them directly.
 *
 * `canDirectMessage` is false unless that person has previously opened a chat
 * with the bot, because Telegram forbids a bot writing first [F24]. The
 * distinction is surfaced rather than hidden: a disabled button with the reason
 * beside it is honest, while a button that silently fails is not. The copyable
 * text is offered either way, so the coordinator is never blocked.
 */
export interface BriefSubject {
  name: string;
  canDirectMessage: boolean;
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
  /** Who the brief concerns, and whether they are reachable. Null for a brief
   * triggered by a period rather than a person. */
  subject: BriefSubject | null;
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
  /**
   * Which produce path Restraint was gating — `quiet_decisions.scope`.
   *
   * The three real scopes, not an item/org axis: Restraint gates findings, brief
   * lines and answers, and which one it was is the thing worth showing. A strip
   * that only ever said "this item" could not reveal that the veto had silently
   * narrowed to findings, which is the failure the column exists to expose.
   */
  scope: QuietDecisionScope;
  /** The run that recorded it, so restraint is auditable back to a pass. */
  runId: string | null;
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
  /**
   * How many candidates the pre-filter discarded — `runs.candidates_skipped`.
   *
   * A stored count, not the arithmetic the panel used to do on the two numbers
   * above: "read 400, extracted 3" reads as a broken pipeline unless the 380 that
   * were never candidates are stated, and the difference between those two figures
   * is not that number.
   */
  candidatesSkipped: number;
  /** How many findings this run raised or updated. */
  findingsTouched: number;
  /**
   * The pass's outcome, in the three states the panel renders.
   *
   * Narrower than `runs.status`, which has four: `interrupted` — a run that
   * stopped to ask the coordinator something, with its snapshot waiting — reads as
   * `complete` here, because it is a successful outcome and the panel has no
   * fourth frame for it. `failed` reads as `error`.
   */
  status: "complete" | "running" | "error";
  trace: TraceEntry[];
}
