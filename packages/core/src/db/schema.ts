/**
 * Drizzle schema.
 *
 * Table definitions are the next unit of work — see the "Database schema"
 * section of the implementation checklist, which lists each table and calls out
 * the columns that carry design weight (`facts.match_key`,
 * `findings.dedupe_key`, `questions.asked_at` nullable, `holdings.holder`
 * nullable).
 *
 * Two structural guarantees are enforced here by absence, and they are worth
 * stating so that a later feature cannot quietly break them:
 *
 *   1. **There is no attendance table.** Coverage is inferred from
 *      participation evidence in conversation. There is nowhere to write a
 *      per-event attendance record even if a prompt asked for one.
 *
 *   2. **There is no per-person score column anywhere** — no completion rate,
 *      no reliability figure, no activity metric. The product's privacy
 *      guarantee is enforced by the schema rather than by prompt text, so it
 *      cannot be broken by a careless prompt or a late feature.
 *
 * Both are verified by inspection, and both belong in the README.
 */

import { pgEnum } from "drizzle-orm/pg-core";
import {
  ALIAS_KINDS,
  ASSET_KINDS,
  ASSET_SENSITIVITIES,
  CURATOR_CLASSIFICATIONS,
  FACT_STATUSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBTYPES,
  MESSAGE_SOURCES,
  PERSON_STATUSES,
  PREFILTER_VERDICTS,
  QUESTION_KINDS,
  QUESTION_STATUSES,
} from "../constants.js";

// Enums come first because every table below references them, and defining them
// from the shared constants means the database and the TypeScript types cannot
// disagree about what a valid status is.

export const assetKindEnum = pgEnum("asset_kind", ASSET_KINDS);
export const assetSensitivityEnum = pgEnum("asset_sensitivity", ASSET_SENSITIVITIES);
export const factStatusEnum = pgEnum("fact_status", FACT_STATUSES);
export const findingSubtypeEnum = pgEnum("finding_subtype", FINDING_SUBTYPES);
export const findingSeverityEnum = pgEnum("finding_severity", FINDING_SEVERITIES);
export const findingStatusEnum = pgEnum("finding_status", FINDING_STATUSES);
export const questionKindEnum = pgEnum("question_kind", QUESTION_KINDS);
export const questionStatusEnum = pgEnum("question_status", QUESTION_STATUSES);
export const aliasKindEnum = pgEnum("alias_kind", ALIAS_KINDS);
export const personStatusEnum = pgEnum("person_status", PERSON_STATUSES);
export const messageSourceEnum = pgEnum("message_source", MESSAGE_SOURCES);
export const prefilterVerdictEnum = pgEnum("prefilter_verdict", PREFILTER_VERDICTS);
export const curatorClassificationEnum = pgEnum("curator_classification", CURATOR_CLASSIFICATIONS);
