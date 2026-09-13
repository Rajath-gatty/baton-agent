/**
 * seed-plan.ts — phase one of seed generation.
 *
 * Produces the deterministic plan: a fixed roster of twenty people with their alias
 * forms, a calendar of events across the six months, the asset inventory across all six
 * kinds, the capability areas, and an explicit placement for every coverage row — which
 * message carries it, on which date, from whom.
 *
 * This phase is pure data. No model, no database, no network. Its output is committed as
 * a fixture, so a regenerated transcript exercises the same paths. Writing prose first
 * and hoping the paths appear is the failure mode: the result reads well, exercises maybe
 * a third of the pipeline, and gives no signal about which third.
 *
 * Every assertion in `plan.ts` runs before anything is written, so an invalid plan fails
 * here rather than producing a transcript that looks fine.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COVERAGE_ROWS, PLANTED_CASES } from "./src/seed/plan-types.js";
import { buildPlan } from "./src/seed/plan.js";
import { PLAN_FIXTURE_PATH } from "./src/seed/paths.js";

function main(): void {
  const plan = buildPlan();

  mkdirSync(dirname(PLAN_FIXTURE_PATH), { recursive: true });
  writeFileSync(PLAN_FIXTURE_PATH, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const placedRows = new Set(plan.placements.flatMap((message) => message.coverage));

  console.log(`seed-plan: wrote ${PLAN_FIXTURE_PATH}`);
  console.log(`  window        ${plan.windowStart} → ${plan.windowEnd} (${plan.months} months)`);
  console.log(`  people        ${plan.people.length}`);
  console.log(`  assets        ${plan.assets.length} across 6 kinds`);
  console.log(`  capabilities  ${plan.capabilities.length}`);
  console.log(`  events        ${plan.events.length}`);
  console.log(`  placements    ${plan.placements.length} authored messages`);
  console.log(
    `  coverage      ${placedRows.size}/${COVERAGE_ROWS.length} rows placed, ` +
      `${plan.assertedByPlan.length} asserted by plan`,
  );
  console.log(`  cases         ${PLANTED_CASES.length} planted, woven through the window`);

  for (const planted of PLANTED_CASES) {
    const entry = plan.cases[planted];
    console.log(`    ${planted.padEnd(17)} ${entry.messageIds.join(", ")}`);
  }
}

main();
