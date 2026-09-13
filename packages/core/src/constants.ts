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
