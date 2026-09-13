/**
 * seed-plan.ts — phase one of seed generation.
 *
 * Produces the deterministic plan: a fixed roster of twenty people with their
 * alias forms, a calendar of events across the six months, the asset inventory
 * across all six kinds, the capability areas, and an explicit placement for
 * every coverage row — which message carries it, on which date, from whom.
 *
 * This phase is pure data and its output is committed as a fixture, so a
 * regenerated transcript exercises the same paths. Writing prose first and
 * hoping the paths appear is the failure mode: the result reads well, exercises
 * maybe a third of the pipeline, and gives no signal about which third.
 */

/**
 * The coverage obligation, as data rather than prose, so `seed-transcript.ts`
 * can verify its own output against it and exit non-zero on a gap. The
 * authoritative list is the coverage table in the design document; this must
 * match it row for row.
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

/** Six months of history. The stale figure sits near the start of the window. */
export const SEED_MONTHS = 6;

/** The development slice, so backfill iteration stays cheap. */
export const SLICE_MONTHS = 2;

export const ROSTER_SIZE = 20;

async function main(): Promise<void> {
  console.log(
    `seed-plan: not implemented. ${COVERAGE_ROWS.length} coverage rows to place across ` +
      `${SEED_MONTHS} months for ${ROSTER_SIZE} people.`,
  );
  return Promise.resolve();
}

await main();
