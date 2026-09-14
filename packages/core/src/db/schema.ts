/**
 * Drizzle schema. Nineteen tables, and the whole of what Baton believes.
 *
 * Four columns here carry far more weight than their one line suggests, and each
 * one omitted produces a specific, known failure rather than a compile error:
 *
 *   - `facts.match_key` — without it every mention of the van keys becomes
 *     another row and the register fills with active near-duplicates.
 *   - `findings.dedupe_key` — without it every sweep either duplicates the
 *     register or resurrects something already dismissed.
 *   - `questions.asked_at`, nullable with **no default** — a default of
 *     insertion time makes the ask budget's rolling window count questions that
 *     were never sent.
 *   - `holdings.holder_person_id`, nullable — null *is* the no-owner finding.
 *
 * Two structural guarantees are enforced here by absence, and both are asserted
 * by `test/privacy-guarantees.test.ts` rather than left to inspection:
 *
 *   1. **There is no attendance table.** Coverage is inferred from participation
 *      evidence in conversation. There is nowhere to write a per-event
 *      attendance record even if a prompt asked for one.
 *
 *   2. **There is no per-person score column anywhere** — no completion rate, no
 *      reliability figure, no activity metric. The product's privacy guarantee is
 *      enforced by the schema rather than by prompt text, so it cannot be broken
 *      by a careless prompt or a late feature.
 *
 * Timestamps are `timestamptz` throughout. Relative dates are resolved against
 * `app_settings.timezone` at curation time, not UTC — at IST, UTC would shift
 * dates by a day and look like a bug in provenance.
 */

import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  AGENT_SESSION_STATUSES,
  AGENT_TASKS,
  ALIAS_KINDS,
  ASSET_KINDS,
  ASSET_SENSITIVITIES,
  ASSET_STATUSES,
  BRIEF_KINDS,
  BRIEF_SECTIONS,
  COMMITMENT_STATUSES,
  CONSEQUENCE_LEVELS,
  CURATOR_CLASSIFICATIONS,
  FACT_STATUSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBTYPES,
  FINDING_TYPES,
  HOLDING_STATUSES,
  MEDIA_KINDS,
  MESSAGE_SOURCES,
  PENDING_CHANGE_STATUSES,
  PERSON_STATUSES,
  PREFILTER_VERDICTS,
  QUESTION_KINDS,
  QUESTION_STATUSES,
  QUESTION_TARGETS,
  QUIET_DECISION_SCOPES,
  RUN_KINDS,
  RUN_STATUSES,
} from "../constants.js";
import type { TraceEntry } from "../schemas/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
//
// Defined from the shared constants so the database and the TypeScript types
// cannot disagree about what a valid status is. A drifted status string is a
// silent bug: a fact with an unrecognised status is invisible to detection SQL
// rather than loudly wrong.
// ─────────────────────────────────────────────────────────────────────────────

export const assetKindEnum = pgEnum("asset_kind", ASSET_KINDS);
export const assetSensitivityEnum = pgEnum("asset_sensitivity", ASSET_SENSITIVITIES);
export const assetStatusEnum = pgEnum("asset_status", ASSET_STATUSES);
export const factStatusEnum = pgEnum("fact_status", FACT_STATUSES);
export const holdingStatusEnum = pgEnum("holding_status", HOLDING_STATUSES);
export const commitmentStatusEnum = pgEnum("commitment_status", COMMITMENT_STATUSES);
export const findingTypeEnum = pgEnum("finding_type", FINDING_TYPES);
export const findingSubtypeEnum = pgEnum("finding_subtype", FINDING_SUBTYPES);
export const findingSeverityEnum = pgEnum("finding_severity", FINDING_SEVERITIES);
export const findingStatusEnum = pgEnum("finding_status", FINDING_STATUSES);
export const questionKindEnum = pgEnum("question_kind", QUESTION_KINDS);
export const questionStatusEnum = pgEnum("question_status", QUESTION_STATUSES);
export const questionTargetEnum = pgEnum("question_target", QUESTION_TARGETS);
export const pendingChangeStatusEnum = pgEnum("pending_change_status", PENDING_CHANGE_STATUSES);
export const consequenceLevelEnum = pgEnum("consequence_level", CONSEQUENCE_LEVELS);
export const quietDecisionScopeEnum = pgEnum("quiet_decision_scope", QUIET_DECISION_SCOPES);
export const aliasKindEnum = pgEnum("alias_kind", ALIAS_KINDS);
export const personStatusEnum = pgEnum("person_status", PERSON_STATUSES);
export const messageSourceEnum = pgEnum("message_source", MESSAGE_SOURCES);
export const mediaKindEnum = pgEnum("media_kind", MEDIA_KINDS);
export const prefilterVerdictEnum = pgEnum("prefilter_verdict", PREFILTER_VERDICTS);
export const curatorClassificationEnum = pgEnum("curator_classification", CURATOR_CLASSIFICATIONS);
export const agentTaskEnum = pgEnum("agent_task", AGENT_TASKS);
export const agentSessionStatusEnum = pgEnum("agent_session_status", AGENT_SESSION_STATUSES);
export const runKindEnum = pgEnum("run_kind", RUN_KINDS);
export const runStatusEnum = pgEnum("run_status", RUN_STATUSES);
export const briefKindEnum = pgEnum("brief_kind", BRIEF_KINDS);
export const briefSectionEnum = pgEnum("brief_section", BRIEF_SECTIONS);

/** Every table gets one, so the activity panel can order by arrival. */
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Nullable: most of the roster appears only by name in six months of
     * conversation and was never bound to an account. Unique where present, so
     * intake can upsert on it.
     */
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    displayName: text("display_name").notNull(),
    status: personStatusEnum("status").notNull().default("unknown"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    /**
     * A bot cannot message someone who has never opened a chat with it, so a
     * brief can only be delivered directly where this is set. Everywhere else it
     * is copyable text for the coordinator to pass on.
     */
    privateChatId: bigint("private_chat_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("people_telegram_user_id_key").on(table.telegramUserId)],
);

export const personAliases = pgTable(
  "person_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** As written in the message. Kept verbatim so provenance quotes match. */
    alias: text("alias").notNull(),
    /** Case-folded and punctuation-stripped. What matching actually runs against. */
    normalisedAlias: text("normalised_alias").notNull(),
    kind: aliasKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Deliberately **not** unique on the alias. Two volunteers can both be
     * "Priya", and ambiguity is *detected* by an alias resolving to more than one
     * person — which is precisely when the Cartographer escalates instead of
     * guessing. A unique constraint here would make that case unrepresentable.
     */
    index("person_aliases_normalised_alias_idx").on(table.normalisedAlias),
    uniqueIndex("person_aliases_person_alias_kind_key").on(
      table.personId,
      table.normalisedAlias,
      table.kind,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Intake
// ─────────────────────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: messageSourceEnum("source").notNull(),
    /**
     * Only the configured chat is processed; anything else is ignored at intake.
     * Seeded messages enter through the same normaliser and are given the
     * configured chat id with a deterministic negative `telegram_message_id`
     * derived from their plan index, so the unique constraint below stays
     * meaningful and re-seeding is idempotent rather than duplicating six months.
     */
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),

    senderPersonId: uuid("sender_person_id").references(() => people.id),
    senderTelegramUserId: bigint("sender_telegram_user_id", { mode: "number" }),
    /** Kept even when the sender resolves, so a quote reads as it did that day. */
    senderDisplayName: text("sender_display_name"),

    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Nullable: a voice note or an image carries no text. */
    text: text("text"),
    /**
     * Half of the curator cache key, the other half being `prompt_version`. A
     * hash rather than the text itself so the cache stays narrow and an edit
     * naturally misses.
     */
    contentHash: text("content_hash").notNull(),

    /** Telegram's own reply pointer, and the resolved local row where we have it. */
    replyToTelegramMessageId: bigint("reply_to_telegram_message_id", { mode: "number" }),
    replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => messages.id),

    /** Attributed to the forwarder, and flagged — the original author is not ours to claim. */
    isForwarded: boolean("is_forwarded").notNull().default(false),
    forwardedFrom: text("forwarded_from"),
    isEdited: boolean("is_edited").notNull().default(false),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /**
     * Telegram never tells bots about deletions, so this is only ever set by a
     * coordinator action in the admin UI. It is not a delete: provenance is
     * withdrawn, and the row stays.
     */
    isWithdrawn: boolean("is_withdrawn").notNull().default(false),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    /** Non-text media, logged rather than dropped so the gap is at least visible. */
    isUnprocessed: boolean("is_unprocessed").notNull().default(false),
    mediaKind: mediaKindEnum("media_kind"),

    /** Written for every message, kept and discarded alike. */
    prefilterVerdict: prefilterVerdictEnum("prefilter_verdict"),
    prefilterVersion: integer("prefilter_version"),
    /** Null means not yet curated. An edit resets it, which re-curates. */
    curatedAt: timestamp("curated_at", { withTimezone: true }),

    /**
     * A question directed at Baton: an @-mention, or a reply to one of its messages, and
     * nothing else. Persisted rather than re-derived because the reply signal needs the
     * replied-to message's *sender*, and the bot's own messages are never stored — so
     * after intake the fact is unrecoverable from this table alone.
     */
    isQuestionToBot: boolean("is_question_to_bot").notNull().default(false),
    /**
     * When Baton replied. **This is what makes answering idempotent**: without it, every
     * pass would re-answer every question ever asked, and a restart would re-answer the
     * whole transcript in front of the group.
     */
    questionAnsweredAt: timestamp("question_answered_at", { withTimezone: true }),

    createdAt: createdAt(),
  },
  (table) => [
    /**
     * The polling offset may be committed after processing, so reprocessing after
     * a crash is expected. This is what makes intake an upsert instead of a
     * duplicate.
     */
    uniqueIndex("messages_chat_id_telegram_message_id_key").on(
      table.chatId,
      table.telegramMessageId,
    ),
    /** The processing loop's only query: candidates not yet curated. */
    index("messages_prefilter_verdict_curated_at_idx").on(table.prefilterVerdict, table.curatedAt),
    /** The respond pass's only query: questions to Baton not yet answered. */
    index("messages_is_question_to_bot_answered_idx").on(
      table.isQuestionToBot,
      table.questionAnsweredAt,
    ),
    /**
     * Supersession is order-dependent — a contradiction processed backwards
     * silently inverts a fact — so the processing loop reads in strict `sent_at`
     * order and needs this to do it cheaply.
     */
    index("messages_sent_at_idx").on(table.sentAt),
  ],
);

export const curatorCache = pgTable(
  "curator_cache",
  {
    contentHash: text("content_hash").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    /** The Curator's whole validated response for this message. */
    result: jsonb("result").notNull(),
    /** Lifted out of the result so "how much of six months was noise" is one query. */
    classification: curatorClassificationEnum("classification").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Built on day one, not as a later optimisation: it makes re-running backfill
     * free and fast, and iteration speed matters more than the money saved.
     *
     * The composite primary key **is** the `(content_hash, prompt_version)` index
     * the design calls for — a primary key is a unique btree index over exactly
     * these columns, in this order. A second index would be dead weight.
     */
    primaryKey({
      name: "curator_cache_pkey",
      columns: [table.contentHash, table.promptVersion],
    }),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge
// ─────────────────────────────────────────────────────────────────────────────

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: assetKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Case-folded, de-articled. What `facts.match_key` is built from. */
    normalisedKey: text("normalised_key").notNull(),
    /**
     * Drives approval routing and, with `kind`, the deterministic consequence
     * classification. Not a model's judgment.
     */
    sensitivity: assetSensitivityEnum("sensitivity").notNull().default("normal"),
    status: assetStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("assets_kind_normalised_key_key").on(table.kind, table.normalisedKey)],
);

export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalisedKey: text("normalised_key").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("capabilities_normalised_key_key").on(table.normalisedKey)],
);

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Nullable. A fact with no asset is answerable by the Respondent but can
     * never produce a risk finding — expected, not a bug.
     */
    assetId: uuid("asset_id").references(() => assets.id),
    claim: text("claim").notNull(),
    /**
     * A normalised asset reference plus a claim key. **Without this the register
     * fills with active near-duplicates:** there is no way to recognise that a
     * new message restates a fact already held, so every mention of the van keys
     * becomes another row and they all look current. A restatement matches here
     * and bumps `last_confirmed_at`; only a contradiction inserts a new row.
     */
    matchKey: text("match_key").notNull(),
    /**
     * How a restatement is told from a contradiction **within** a `match_key` group.
     *
     * Cached on the row for the same reason `match_key` is: it is derived, but the
     * derivation needs inputs the row does not otherwise keep. A holder claim is signed
     * by *who* holds the thing, and `facts` deliberately has no holder column — that
     * lives in `holdings`, as history. Recomputing would mean reaching through
     * `holdings.evidence_fact_id` to reconstruct what this claim once said, which is
     * both indirect and wrong once the holding has moved on.
     *
     * Equal signatures merge and bump `last_confirmed_at`; unequal signatures insert a
     * new row and set `supersedes_fact_id`.
     */
    valueSignature: text("value_signature"),
    confidence: real("confidence").notNull(),
    /**
     * Only `active` is visible to detection SQL. `unverified` and
     * `pending_approval` are deliberately invisible, which is how the promise
     * that a pending change never appears in a finding is enforced in SQL rather
     * than in prompt text.
     */
    status: factStatusEnum("status").notNull().default("active"),
    sensitivity: assetSensitivityEnum("sensitivity").notNull().default("normal"),

    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id),
    statedByPersonId: uuid("stated_by_person_id").references(() => people.id),
    statedAt: timestamp("stated_at", { withTimezone: true }).notNull(),
    /** Bumped by a restatement. This, minus now, is the age an answer quotes. */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull(),
    /** Appended to on restatement rather than replaced — provenance accumulates. */
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>().notNull().default([]),

    /** Set on the new row when a later message contradicts this one. */
    supersedesFactId: uuid("supersedes_fact_id").references((): AnyPgColumn => facts.id),
    /** Shown verbatim in the fact detail panel, so the reasoning is auditable. */
    curatorReasoning: text("curator_reasoning"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("facts_asset_id_status_idx").on(table.assetId, table.status),
    /** Merge-on-restatement looks up here, once per extracted record. */
    index("facts_match_key_status_idx").on(table.matchKey, table.status),
  ],
);

export const holdings = pgTable(
  "holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    /** **Nullable, and null is not missing data — null is the no-owner finding.** */
    holderPersonId: uuid("holder_person_id").references(() => people.id),
    /** Someone outside the group: the clinic's accountant, the printer's owner. */
    holderExternal: text("holder_external"),
    /** The van is actually someone's own property. That is `not_ours`, not a risk. */
    isPersonalResource: boolean("is_personal_resource").notNull().default(false),
    /**
     * Append-only history. A transfer closes one row by setting `released_at` and
     * opens another; nothing is overwritten, which is what keeps "who held the van
     * keys in March" answerable.
     */
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    status: holdingStatusEnum("status").notNull().default("active"),
    /** The fact this holding was derived from, for provenance on every claim. */
    evidenceFactId: uuid("evidence_fact_id").references(() => facts.id),
    createdAt: createdAt(),
  },
  (table) => [index("holdings_asset_id_status_idx").on(table.assetId, table.status)],
);

export const commitments = pgTable(
  "commitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    substance: text("substance").notNull(),
    /** Nullable: null is an unowned intent, which is its own kind of loose end. */
    ownerPersonId: uuid("owner_person_id").references(() => people.id),
    promisedAt: timestamp("promised_at", { withTimezone: true }).notNull(),
    /** Nullable: "I'll sort the printers" has no date, and that is the point. */
    deadline: timestamp("deadline", { withTimezone: true }),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id),
    completionEvidenceMessageId: uuid("completion_evidence_message_id").references(
      () => messages.id,
    ),
    status: commitmentStatusEnum("status").notNull().default("open"),
    /**
     * Ask-once-then-stop, enforced in data rather than in a prompt. A prompt
     * cannot remember that it already asked; a timestamp can.
     */
    askedOnceAt: timestamp("asked_once_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("commitments_status_deadline_idx").on(table.status, table.deadline)],
);

export const capabilityCoverage = pgTable(
  "capability_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /**
     * Inferred from participation evidence in conversation. Note what this table
     * does *not* do: it records that someone was seen doing something, never how
     * often or how well. There is no attendance table for it to aggregate.
     */
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("capability_coverage_capability_person_key").on(table.capabilityId, table.personId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Operational — declared before `findings`, which references a run
// ─────────────────────────────────────────────────────────────────────────────

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: runKindEnum("kind").notNull(),
  status: runStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),

  messagesRead: integer("messages_read").notNull().default(0),
  candidates: integer("candidates").notNull().default(0),
  factsExtracted: integer("facts_extracted").notNull().default(0),
  /**
   * The pre-filter's discards. Exposed because a coordinator reading "read 400,
   * extracted 3" needs to know 380 were never candidates, or the number reads as
   * a broken pipeline.
   */
  candidatesSkipped: integer("candidates_skipped").notNull().default(0),
  findingsProduced: integer("findings_produced").notNull().default(0),

  /**
   * Returned by the agent in its response payload — nodes visited, model used,
   * token counts, tool calls, and each agent's reasoning line — and stored here.
   * **Not** read from CloudWatch: the activity panel needs the trace in the same
   * database as everything else it renders.
   */
  trace: jsonb("trace").$type<TraceEntry[]>().notNull().default([]),
  error: text("error"),
  createdAt: createdAt(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  task: agentTaskEnum("task").notNull(),
  /** Strands' own session identifier, so a resume addresses the same session. */
  strandsSessionId: text("strands_session_id"),
  /**
   * The serialised snapshot. Held in Postgres rather than anywhere on AWS, which
   * is what keeps the agent container stateless and credential-free.
   */
  snapshot: jsonb("snapshot").notNull(),
  runId: uuid("run_id").references(() => runs.id),
  status: agentSessionStatusEnum("status").notNull().default("open"),
  resumedAt: timestamp("resumed_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The subject class, and the column that distinguishes the two detection
     * queries which both render as `sole_holder` — an asset with one holder, and a
     * capability with one observed participant. Five queries, four rendered
     * subtypes, and this is where the fifth one goes.
     */
    type: findingTypeEnum("type").notNull(),
    subtype: findingSubtypeEnum("subtype").notNull(),
    /**
     * **The most important column in the schema.** Sweeps re-derive findings from
     * scratch, so without it every sweep would either duplicate the register or
     * resurrect something already dismissed. Dismissals are recorded against the
     * key, which is what makes dismissal permanent.
     */
    dedupeKey: text("dedupe_key").notNull(),
    /** Phrased about a capability, never about a person. */
    title: text("title").notNull(),
    whyItMatters: text("why_it_matters").notNull(),
    severity: findingSeverityEnum("severity").notNull(),
    /** Separate from severity: how sure, not how bad. The two are not the same axis. */
    confidence: real("confidence").notNull(),
    status: findingStatusEnum("status").notNull().default("open"),

    subjectAssetId: uuid("subject_asset_id").references(() => assets.id),
    subjectCapabilityId: uuid("subject_capability_id").references(() => capabilities.id),
    subjectCommitmentId: uuid("subject_commitment_id").references(() => commitments.id),
    /** A plain attribute, rendered small. The finding is about the gap, not the person. */
    holderPersonId: uuid("holder_person_id").references(() => people.id),

    evidenceFactIds: jsonb("evidence_fact_ids").$type<string[]>().notNull().default([]),
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>().notNull().default([]),
    assessorReasoning: text("assessor_reasoning"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** "Already have a backup" and "not a problem" are different, and both are kept. */
    dismissalReason: text("dismissal_reason"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (table) => [
    /** Upsert target. Unique because a second row for one key *is* the bug. */
    uniqueIndex("findings_dedupe_key_key").on(table.dedupeKey),
    /**
     * The register's only query: open findings, worst first. `severity desc` works
     * because the enum is declared low → medium → high, so descending is
     * high → medium → low.
     */
    index("findings_status_severity_idx").on(table.status, table.severity.desc()),
  ],
);

export const quietDecisions = pgTable(
  "quiet_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Which produce path Restraint was gating. Recorded so a test can assert the
     * veto has not silently narrowed to findings during a refactor — a withheld
     * brief line and a withheld answer must each land here too.
     */
    scope: quietDecisionScopeEnum("scope").notNull(),
    /** What was withheld, as text a coordinator can read. */
    withheld: text("withheld").notNull(),
    /** Item-level or organisation-level. Never about a person. */
    reason: text("reason").notNull(),
    runId: uuid("run_id").references(() => runs.id),
    /** Present when the withheld item was a finding, so the strip can link to it. */
    findingDedupeKey: text("finding_dedupe_key"),
    createdAt: createdAt(),
  },
  (table) => [index("quiet_decisions_created_at_idx").on(table.createdAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Human loop
// ─────────────────────────────────────────────────────────────────────────────

export const pendingChanges = pgTable(
  "pending_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The write being held. Not stored as truth, not used in any finding. */
    proposedChange: jsonb("proposed_change").notNull(),
    /**
     * Derived deterministically from the asset's kind and sensitivity, never asked
     * of a model. Whether a write is high-consequence is fixed policy; letting a
     * cheap model decide would make the approval gate itself unreliable.
     */
    consequence: consequenceLevelEnum("consequence").notNull(),
    /**
     * Never silently adopted on a timeout and never discarded. `obsolete` is the
     * third outcome: the answer arrived after the claim had been superseded.
     */
    status: pendingChangeStatusEnum("status").notNull().default("pending"),
    assetId: uuid("asset_id").references(() => assets.id),
    factId: uuid("fact_id").references(() => facts.id),
    agentSessionId: uuid("agent_session_id").references(() => agentSessions.id),
    /** A second approval on the same asset queues behind the first via this link. */
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => pendingChanges.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("pending_changes_status_asset_id_idx").on(table.status, table.assetId)],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Priority is derived from this and never stored: approval outranking
     * clarification outranking verification is fixed policy, not a per-question
     * judgment.
     */
    kind: questionKindEnum("kind").notNull(),
    /** Group, or the coordinator privately. Driven by `assets.sensitivity`. */
    target: questionTargetEnum("target").notNull().default("group"),
    targetPersonId: uuid("target_person_id").references(() => people.id),
    askedText: text("asked_text").notNull(),
    /** The bot's own message id, so a Telegram reply can be matched back to it. */
    botTelegramMessageId: bigint("bot_telegram_message_id", { mode: "number" }),

    /**
     * `queued` is why this table exists in this shape: an ask that the budget
     * blocks is stored rather than dropped, so nothing is discarded and nothing is
     * asked twice.
     */
    status: questionStatusEnum("status").notNull().default("queued"),
    /**
     * **Nullable, with no default, deliberately.** A default of insertion time
     * would make the rolling 24-hour window count questions that were never sent,
     * and the budget would then silently throttle itself to nothing.
     */
    askedAt: timestamp("asked_at", { withTimezone: true }),

    answerText: text("answer_text"),
    answeredByPersonId: uuid("answered_by_person_id").references(() => people.id),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** How it ended: approved, rejected, answered, obsolete — in words. */
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    /** Strands' interrupt identity, so `resume` can address the right one. */
    interruptId: text("interrupt_id"),
    interruptName: text("interrupt_name"),
    pendingChangeId: uuid("pending_change_id").references(() => pendingChanges.id),
    factId: uuid("fact_id").references(() => facts.id),
    assetId: uuid("asset_id").references(() => assets.id),
    createdAt: createdAt(),
  },
  (table) => [
    /** Both halves of the ask budget count over this: open now, and asked recently. */
    index("questions_status_asked_at_idx").on(table.status, table.askedAt),
    index("questions_bot_telegram_message_id_idx").on(table.botTelegramMessageId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Briefs
// ─────────────────────────────────────────────────────────────────────────────

export const briefs = pgTable("briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Same generator, same three sections, different opening line. */
  kind: briefKindEnum("kind").notNull(),
  subjectPersonId: uuid("subject_person_id")
    .notNull()
    .references(() => people.id),
  runId: uuid("run_id").references(() => runs.id),
  triggeredByMessageId: uuid("triggered_by_message_id").references(() => messages.id),
  /** One plain sentence. Carries the empty case, which must not render as three empty sections. */
  openingLine: text("opening_line").notNull(),
  isEmpty: boolean("is_empty").notNull().default(false),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Drives the unread-brief banner. */
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const briefLines = pgTable(
  "brief_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    section: briefSectionEnum("section").notNull(),
    position: integer("position").notNull(),
    /**
     * Lines are rows rather than prose blocks because each one is individually
     * assignable and each carries its own evidence reference.
     */
    text: text("text").notNull(),
    evidenceFactIds: jsonb("evidence_fact_ids").$type<string[]>().notNull().default([]),
    evidenceMessageIds: jsonb("evidence_message_ids").$type<string[]>().notNull().default([]),
    subjectAssetId: uuid("subject_asset_id").references(() => assets.id),
    subjectCapabilityId: uuid("subject_capability_id").references(() => capabilities.id),
    subjectCommitmentId: uuid("subject_commitment_id").references(() => commitments.id),
    /** A record, not a notification. Baton does not chase people. */
    assignedToPersonId: uuid("assigned_to_person_id").references(() => people.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("brief_lines_brief_section_position_key").on(
      table.briefId,
      table.section,
      table.position,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Singletons
//
// Both are one-row tables, and the check constraint is what keeps them that way.
// A second `app_settings` row would give two chat ids and no error.
// ─────────────────────────────────────────────────────────────────────────────

export const coordinatorState = pgTable(
  "coordinator_state",
  {
    id: smallint("id").primaryKey().default(1),
    /**
     * Advances on view, which is what computes the since-you-last-looked diff —
     * and also why the video must be recorded before the URL is shared, or the
     * diff is empty when judges arrive.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("coordinator_state_single_row", sql`id = 1`)],
);

export const appSettings = pgTable(
  "app_settings",
  {
    id: smallint("id").primaryKey().default(1),
    /** The one chat that is processed. Messages from any other chat are ignored. */
    chatId: bigint("chat_id", { mode: "number" }),
    orgName: text("org_name"),
    /**
     * Relative dates resolve against this, not UTC. At IST, UTC would shift dates
     * by a day and look like a bug in provenance.
     */
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    /**
     * Only this person can approve a high-consequence write. Must be reassigned
     * before any approval can resolve if the coordinator is the one who leaves.
     */
    coordinatorPersonId: uuid("coordinator_person_id").references(() => people.id),
    introducedChatIds: jsonb("introduced_chat_ids").$type<number[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("app_settings_single_row", sql`id = 1`)],
);

/**
 * The worker's own bookkeeping. One row, like the two above.
 *
 * Distinct from `app_settings`, which is configuration a human sets, and from
 * `coordinator_state`, which is what a *reader* has seen. This is what the *process*
 * has done, and all three columns exist because the alternative is worse:
 *
 *   - `telegram_offset` — held here rather than in memory because the offset is
 *     committed **after** processing. In memory it would reset on every restart and
 *     Telegram would redeliver whatever it still holds, which is survivable only
 *     because intake upserts. On disk it makes restarts cheap instead of merely safe.
 *   - `last_sweep_fingerprint` — the periodic sweep short-circuits when the candidate
 *     set is unchanged, and that comparison has to survive a restart or the first
 *     sweep after every deploy pays for a full assessment that produces nothing new.
 *   - `last_sweep_at` — so the scheduler can tell "never swept" from "swept an hour
 *     ago", which are different decisions.
 */
export const workerState = pgTable(
  "worker_state",
  {
    id: smallint("id").primaryKey().default(1),
    /** Telegram's `getUpdates` offset: the next update id to ask for. */
    telegramOffset: bigint("telegram_offset", { mode: "number" }),
    /**
     * A digest of the last sweep's candidate set. Compared before invoking `assess`,
     * so an unchanged register costs no model call at all.
     */
    lastSweepFingerprint: text("last_sweep_fingerprint"),
    lastSweepAt: timestamp("last_sweep_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("worker_state_single_row", sql`id = 1`)],
);
