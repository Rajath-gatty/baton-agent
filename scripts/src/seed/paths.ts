/**
 * Where seed artifacts live.
 *
 * The **plan** is committed: it is the fixture that makes a regenerated transcript
 * exercise the same paths. The **transcript** is not — it is derived, large, and
 * regenerating it is one command, so committing it would only produce review noise and
 * merge conflicts.
 */

import { fileURLToPath } from "node:url";

const scriptsRoot = new URL("../../", import.meta.url);

/** Committed. `scripts/fixtures/seed-plan.json`. */
export const PLAN_FIXTURE_PATH = fileURLToPath(new URL("fixtures/seed-plan.json", scriptsRoot));

/** Gitignored. `scripts/out/seed-transcript.json`. */
export const TRANSCRIPT_PATH = fileURLToPath(new URL("out/seed-transcript.json", scriptsRoot));

/** Gitignored. The coverage report, kept next to the transcript it describes. */
export const COVERAGE_REPORT_PATH = fileURLToPath(new URL("out/coverage-report.txt", scriptsRoot));
