/**
 * seed-transcript.ts — phase two of seed generation.
 *
 * Renders prose against the committed plan, in day-sized chunks so a model call
 * never has to hold six months in context, with the planted material rendered in
 * place rather than appended. Writes `messages` rows with `source = 'seed'`,
 * through the same normaliser as live traffic.
 *
 * Then verifies itself. After render, it re-scans its own output for every
 * coverage row and writes a report naming each row, the messages that satisfy
 * it, and any row with none. **A missing row is a non-zero exit, not a
 * warning** — the failure this prevents is silent: a transcript missing hearsay
 * material does not look broken, it looks fine, and the first sign of trouble is
 * a prompt nobody can evaluate because there is nothing for it to be right
 * about.
 *
 * Rows the scanner cannot verify by pattern are reported as *asserted by plan*,
 * traceable to the placement that claims them.
 *
 * It also asserts the account binding: if the person who will leave on camera is
 * not the seeded holder of the donation page, generation fails. The orphan case
 * is the first fifteen seconds of the video and it fails silently otherwise.
 */

import { COVERAGE_ROWS } from "./seed-plan.js";

interface CoverageReport {
  matched: Map<string, number>;
  assertedByPlan: Set<string>;
  missing: string[];
}

function report(result: CoverageReport): void {
  for (const row of COVERAGE_ROWS) {
    const count = result.matched.get(row);
    if (count !== undefined) {
      console.log(`  ok        ${row} (${count} messages)`);
    } else if (result.assertedByPlan.has(row)) {
      console.log(`  by plan   ${row}`);
    } else {
      console.log(`  MISSING   ${row}`);
    }
  }
}

async function main(): Promise<void> {
  console.log("seed-transcript: not implemented");

  const result: CoverageReport = {
    matched: new Map(),
    assertedByPlan: new Set(),
    missing: [...COVERAGE_ROWS],
  };

  report(result);

  if (result.missing.length > 0) {
    console.error(
      `\nCoverage incomplete: ${result.missing.length} of ${COVERAGE_ROWS.length} rows unmatched.`,
    );
    process.exitCode = 1;
  }
  return Promise.resolve();
}

await main();
