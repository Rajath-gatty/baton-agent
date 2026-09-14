/**
 * Domain constants shared by the agent, the worker and the web app.
 *
 * These live in one place because they are the contract between three
 * workspaces. Duplicating them would let the three drift, and a drifted
 * status string is a silent bug — a fact with an unrecognised status is
 * invisible to detection SQL rather than loudly wrong.
 */

/** The six asset kinds. Fixed by the design document; not extensible. */
export const ASSET_KINDS = [
  "account_login",
  "physical_item",
  "financial_control",
  "relationship",
  "document",
  "public_presence",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Asset sensitivity drives approval routing: a sensitive asset's approval goes
 * to the coordinator privately, never in front of twenty people.
 */
export const ASSET_SENSITIVITIES = ["normal", "sensitive"] as const;
export type AssetSensitivity = (typeof ASSET_SENSITIVITIES)[number];

/**
 * Only `active` facts are visible to detection SQL. `unverified` and
 * `pending_approval` are deliberately invisible, which is how the promise that
 * a pending change never appears in a finding is enforced in SQL rather than
 * in prompt text.
 */
export const FACT_STATUSES = [
  "active",
  "superseded",
  "retired",
  "unverified",
  "pending_approval",
] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** Statuses detection queries are permitted to see. */
export const DETECTABLE_FACT_STATUSES = ["active"] as const satisfies readonly FactStatus[];

/**
 * Four rendered subtypes over five detection queries: capability
 * single-coverage presents as `sole_holder` because to a coordinator it is the
 * same problem, and an owned and an unowned loose end differ only in phrasing.
 */
export const FINDING_SUBTYPES = ["sole_holder", "no_owner", "not_ours", "loose_end"] as const;
export type FindingSubtype = (typeof FINDING_SUBTYPES)[number];

export const FINDING_SEVERITIES = ["low", "medium", "high"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The Curator's five-way classification. Noise is a first-class outcome. */
export const CURATOR_CLASSIFICATIONS = [
  "durable_fact",
  "commitment",
  "participation_evidence",
  "lifecycle_event",
  "noise",
] as const;
export type CuratorClassification = (typeof CURATOR_CLASSIFICATIONS)[number];

/**
 * Question kinds. Only `approval` is restricted to the coordinator; the other
 * two accept an answer from any group member, because they are questions of
 * fact and the group is the authority on its own facts.
 */
export const QUESTION_KINDS = ["verification", "clarification", "approval"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * `queued` exists because of the ask budget: a question that cannot be asked
 * yet is stored rather than dropped, with a null `asked_at` so it does not
 * count against the rolling window.
 */
export const QUESTION_STATUSES = ["queued", "asked", "resolved", "obsolete"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Ask priority. Lower sorts first. Derived from kind, never stored. */
export const ASK_PRIORITY: Record<QuestionKind, number> = {
  approval: 0,
  clarification: 1,
  verification: 2,
};

/**
 * The ask budget, made numeric. "Rationed" without a number degrades into
 * whatever the register happens to generate on a busy week.
 */
export const ASK_BUDGET = {
  maxOpen: 2,
  maxPerRollingWindow: 3,
  rollingWindowHours: 24,
} as const;

/** The alias kinds identity resolution works over. */
export const ALIAS_KINDS = [
  "handle",
  "display_name",
  "nickname",
  "first_name",
  "role_reference",
] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const PERSON_STATUSES = ["member", "left", "unknown"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/** The five agent tasks the AgentCore container dispatches on. */
export const AGENT_TASKS = ["ingest", "assess", "brief", "respond", "resume"] as const;
export type AgentTask = (typeof AGENT_TASKS)[number];

/** The three fixed brief sections. Order is part of the contract. */
export const BRIEF_SECTIONS = ["only_they_held", "they_had_promised", "nobody_else_seen"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export const MESSAGE_SOURCES = ["telegram", "seed"] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export const PREFILTER_VERDICTS = ["candidate", "discarded"] as const;
export type PrefilterVerdict = (typeof PREFILTER_VERDICTS)[number];

/**
 * The Telegram update types the poll loop must request explicitly. The default
 * does not include `chat_member`, and the brief fires from a membership event.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "chat_member",
  "my_chat_member",
] as const;

/** An asset that has been retired is invisible to detection, like a retired fact. */
export const ASSET_STATUSES = ["active", "retired"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/**
 * Holdings are history: a transfer closes one row and opens another, and nothing
 * is ever overwritten. `released` is therefore a closed row rather than a
 * deletion, which is what makes "who held the van keys in March" answerable.
 */
export const HOLDING_STATUSES = ["active", "released"] as const;
export type HoldingStatus = (typeof HOLDING_STATUSES)[number];

/**
 * `abandoned` is distinct from `completed` because an undated intention someone
 * consciously decided not to do is not a loose end, and a brief should not
 * inherit it.
 */
export const COMMITMENT_STATUSES = ["open", "completed", "abandoned"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/**
 * A finding's subject class. This is the column that distinguishes the two
 * detection queries which both render as `sole_holder` — an asset with one
 * holder and a capability with one observed participant. Five queries, four
 * rendered subtypes, and this is where the fifth one goes.
 */
export const FINDING_TYPES = ["asset", "capability", "commitment"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/**
 * Where an ask is sent. Driven by `assets.sensitivity`: anything touching
 * financial control, credentials or an individual's holdings goes to the
 * coordinator privately, never in front of twenty people.
 */
export const QUESTION_TARGETS = ["group", "coordinator"] as const;
export type QuestionTarget = (typeof QUESTION_TARGETS)[number];

/**
 * A pending change is never silently adopted on timeout and never discarded.
 * `obsolete` is the third outcome: the answer arrived after the claim it was
 * about had already been superseded.
 */
export const PENDING_CHANGE_STATUSES = ["pending", "applied", "rejected", "obsolete"] as const;
export type PendingChangeStatus = (typeof PENDING_CHANGE_STATUSES)[number];

/**
 * Consequence is classified **deterministically** from the asset's kind and
 * sensitivity — it is never asked of a model. Whether a write is
 * high-consequence is fixed policy, and letting a cheap model decide would make
 * the approval gate itself unreliable, which is the one thing that must not be.
 * The model supplies confidence; code supplies consequence.
 */
export const CONSEQUENCE_LEVELS = ["low", "high"] as const;
export type ConsequenceLevel = (typeof CONSEQUENCE_LEVELS)[number];

/**
 * The three produce paths Restraint gates. Recorded on every quiet decision so
 * a test can assert the veto has not silently narrowed to findings during a
 * refactor — which is exactly how a structural guarantee decays.
 */
export const QUIET_DECISION_SCOPES = ["finding", "brief_line", "answer"] as const;
export type QuietDecisionScope = (typeof QUIET_DECISION_SCOPES)[number];

/** What kind of pipeline execution a `runs` row records. */
export const RUN_KINDS = ["backfill", "ingest", "sweep", "brief", "respond", "resume"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * `interrupted` is a successful outcome, not a failure: the run stopped to ask
 * the coordinator something and its snapshot is waiting in `agent_sessions`.
 */
export const RUN_STATUSES = ["running", "complete", "interrupted", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Same generator, same three sections, different opening line. An arrival brief
 * is scoped to what currently has no owner or a single holder.
 */
export const BRIEF_KINDS = ["departure", "arrival"] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

/**
 * Non-text media is logged with the `unprocessed` flag rather than dropped, so
 * a voice note that carried a fact is at least visible as a gap.
 */
export const MEDIA_KINDS = [
  "photo",
  "voice",
  "audio",
  "video",
  "document",
  "sticker",
  "other",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** A snapshot is `open` until the answer arrives, then resumed once and closed. */
export const AGENT_SESSION_STATUSES = ["open", "resumed", "closed"] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/**
 * The record kinds the Curator may extract. This is {@link CURATOR_CLASSIFICATIONS}
 * without `noise`, because noise is a classification of the *message* and never
 * produces a record — that asymmetry is the whole point of noise being a
 * first-class outcome rather than an empty extraction.
 */
export const CURATOR_RECORD_KINDS = [
  "durable_fact",
  "commitment",
  "participation_evidence",
  "lifecycle_event",
] as const satisfies readonly CuratorClassification[];
export type CuratorRecordKind = (typeof CURATOR_RECORD_KINDS)[number];

/** Lifecycle events the Curator can read out of prose, before Telegram confirms one. */
export const LIFECYCLE_KINDS = ["joined", "left"] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

/**
 * How the Cartographer resolved a mention. `cannot_determine` is a permitted
 * output, not a failure: it becomes a question rather than a coin flip, which is
 * the entire reason the model is invoked on ambiguity at all.
 */
export const IDENTITY_RESOLUTIONS = [
  "resolved",
  "ambiguous",
  "cannot_determine",
  "external",
] as const;
export type IdentityResolution = (typeof IDENTITY_RESOLUTIONS)[number];

/** Restraint's verdict. A withheld item becomes a quiet decision, never a silent drop. */
export const RESTRAINT_DECISIONS = ["surface", "withhold"] as const;
export type RestraintDecision = (typeof RESTRAINT_DECISIONS)[number];

/**
 * The Respondent's four branches. The three that are not `answer` are its most
 * valuable outputs — a tool that only speaks when it is certain is a tool nobody
 * can calibrate — so they are branches of the schema rather than a free-text
 * field the UI and the tests cannot depend on.
 */
export const RESPONDENT_OUTCOMES = [
  "answer",
  "stale_answer",
  "ambiguous_holder",
  "unknown",
] as const;
export type RespondentOutcome = (typeof RESPONDENT_OUTCOMES)[number];

/**
 * How old a fact must be before an answer quoting it carries a staleness
 * warning. Five months is the planted case in the seeded transcript, so this
 * threshold has to sit below that and above the ordinary rhythm of the group.
 */
export const STALE_FACT_THRESHOLD_DAYS = 90;

/**
 * How many candidate messages travel in one `ingest` request.
 *
 * Ten amortises the Curator's system prompt across ten classifications without
 * making a single failed call expensive to retry. The number is a contract rather
 * than a tuning knob: the Curator prompt forbids cross-message inference precisely
 * so that batching is invisible to the output, which is what makes the per-message
 * `content_hash` cache sound. Batches are formed from cache misses only, so their
 * composition changes on every run — and a classification that shifted when its
 * neighbours changed would make the cache silently wrong.
 */
export const INGEST_BATCH_SIZE = 10;
