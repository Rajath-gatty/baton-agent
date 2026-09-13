/**
 * The seed plan's shape.
 *
 * Generation runs in two deterministic phases and this is the contract between
 * them. Phase one (`seed-plan.ts`) produces pure data — the roster, the calendar,
 * the inventory, and an explicit placement for every coverage row. Phase two
 * (`seed-transcript.ts`) renders prose against it and then re-scans its own output
 * against the same plan.
 *
 * The ordering is what keeps the output checkable. Writing prose first and hoping
 * the paths appear is the failure mode here: the result reads well, exercises maybe
 * a third of the pipeline, and gives no signal about which third.
 *
 * **Placed messages carry their exact text.** Filler chatter does not — the renderer
 * generates that. This split is deliberate: the load-bearing material is authored
 * where it can be reasoned about and matched by the scanner, and the filler is the
 * only place a model's texture is needed. A model paraphrasing the planted hearsay
 * message could silently destroy the coverage row it exists to satisfy.
 */

import type { AliasKind, AssetKind, AssetSensitivity, MediaKind } from "@baton/core";

/**
 * The coverage obligation, as data rather than prose, so the transcript can verify
 * its own output against it and exit non-zero on a gap. The authoritative list is
 * the coverage table in the design document; this matches it row for row.
 */
export const COVERAGE_ROWS = [
  "durable_fact",
  "commitment",
  "participation_evidence",
  "lifecycle",
  "noise",
  "prefilter_recall",
  "multiple_records_per_message",
  "restatement",
  "contradiction",
  "negation",
  "hearsay",
  "relative_dates",
  "identity_all_alias_kinds",
  "ambiguity_one_name_two_people",
  "six_asset_kinds",
  "transfer_of_holding",
  "personal_resource",
  "commitment_closure",
  "capability_coverage",
  "aggregation",
  "suppression",
  "answerable_question",
  "unknown",
  "credential_exposure",
  "media",
  "provenance_forwarded_and_edited",
] as const;
export type CoverageRow = (typeof COVERAGE_ROWS)[number];

/** The five planted cases. Four carry the video; the fifth is shown briefly. */
export const PLANTED_CASES = [
  "orphan",
  "restraint",
  "stale_answer",
  "provenance_click",
  "approval",
] as const;
export type PlantedCase = (typeof PLANTED_CASES)[number];

/**
 * The demo accounts, bound to seeded people during generation rather than by hand
 * afterwards. If the person who leaves on camera is not the seeded holder of the
 * donation page, the orphan case does not fire — and it fails silently, with the
 * brief simply appearing with nothing interesting in it.
 */
export const DEMO_ROLES = ["coordinator", "leaver", "arriver"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

/** Six months of history. The stale figure sits near the start of the window. */
export const SEED_MONTHS = 6;

/** The development slice, so backfill iteration stays cheap. */
export const SLICE_MONTHS = 2;

export const ROSTER_SIZE = 20;

export interface PlanPersonAlias {
  alias: string;
  kind: AliasKind;
}

export interface PlanPerson {
  id: string;
  displayName: string;
  /** Every form this person is referred to by. Identity resolution runs over these. */
  aliases: PlanPersonAlias[];
  /** Null means they were already in the group when the window opens. */
  joinedAt: string | null;
  /** Set only for the seeded departure, which happens before the live one. */
  leftAt: string | null;
  isCoordinator: boolean;
  /**
   * Which live Telegram account this person is played by on camera, if any. The
   * real user id is supplied at seed time from the environment, never committed.
   */
  demoRole: DemoRole | null;
}

export interface PlanAsset {
  id: string;
  kind: AssetKind;
  name: string;
  normalisedKey: string;
  sensitivity: AssetSensitivity;
  /** The van is actually someone's own car. That is `not_ours`, not a risk. */
  isPersonalResource: boolean;
}

export interface PlanCapability {
  id: string;
  name: string;
  normalisedKey: string;
}

export interface PlanEvent {
  id: string;
  date: string;
  kind: string;
  name: string;
  /** Who was there. Post-event thanks are generated from this. */
  participantIds: string[];
}

export interface PlannedMessageFlags {
  /** Attributed to the forwarder and flagged; the original author is not ours to claim. */
  forwarded?: true;
  forwardedFrom?: string;
  /**
   * The text after a later edit. The facts the old text produced are superseded
   * rather than mutated, which is the behaviour this exists to exercise.
   */
  editedTo?: string;
  /** Non-text media, logged with `unprocessed` rather than dropped. */
  media?: MediaKind;
}

export interface PlannedMessage {
  id: string;
  /** `YYYY-MM-DD` in the group's timezone, not UTC. */
  date: string;
  /** Minutes past local midnight, so a day's messages order without a full timestamp. */
  minute: number;
  senderId: string;
  /** Exact text. The renderer places this verbatim and never paraphrases it. */
  text: string;
  /** The coverage rows this message is placed to satisfy. May be empty for scene-setting. */
  coverage: CoverageRow[];
  /**
   * Which planted cases it belongs to. A list rather than one value because the cases
   * are woven through rather than appended: the message that establishes who set up the
   * donation page is also the message the provenance click lands on, and forcing a
   * choice between them would mean authoring the same fact twice.
   */
  cases: PlantedCase[];
  flags: PlannedMessageFlags;
  /** Why this message exists, for the coverage report's traceability. */
  note: string;
}

export interface SeedPlan {
  planVersion: number;
  months: number;
  /** Inclusive `YYYY-MM-DD` bounds of the seeded window. */
  windowStart: string;
  windowEnd: string;
  timezone: string;
  currency: "INR";
  orgName: string;
  coordinatorPersonId: string;
  people: PlanPerson[];
  assets: PlanAsset[];
  capabilities: PlanCapability[];
  events: PlanEvent[];
  /** Every authored message, in date order. */
  placements: PlannedMessage[];
  cases: Record<PlantedCase, { description: string; messageIds: string[] }>;
  /**
   * Rows a text scanner cannot honestly verify — that the prose reads as human, that
   * three exposures really sit inside one capability area. Reported as *asserted by
   * plan* and traceable to the placements that claim them. Weaker than a match, but
   * better than memory, because the claim is written down and attributable.
   */
  assertedByPlan: CoverageRow[];
}

/** The transcript's output shape: one row per message, ready for the normaliser. */
export interface RenderedMessage {
  /** Deterministic and negative, so re-seeding is idempotent under the unique
   * constraint on `(chat_id, telegram_message_id)` rather than duplicating six months. */
  telegramMessageId: number;
  /** ISO 8601 with the group's offset. */
  sentAt: string;
  senderPlanId: string;
  senderDisplayName: string;
  text: string | null;
  replyToTelegramMessageId: number | null;
  isForwarded: boolean;
  forwardedFrom: string | null;
  isEdited: boolean;
  editedText: string | null;
  mediaKind: MediaKind | null;
  /** Present only on placed messages. Filler carries no coverage obligation. */
  planMessageId: string | null;
  coverage: CoverageRow[];
  cases: PlantedCase[];
}
