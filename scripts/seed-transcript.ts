/**
 * seed-transcript.ts — phase two of seed generation.
 *
 * Renders prose against the committed plan, in day-sized chunks so a model call never has
 * to hold six months in context, with the planted material rendered in place rather than
 * appended.
 *
 * Then verifies itself. After render it re-scans its own output for every coverage row and
 * writes a report naming each row, the messages that satisfy it, and any row with none.
 * **A missing row is a non-zero exit, not a warning** — the failure this prevents is
 * silent: a transcript missing hearsay material does not look broken, it looks fine, and
 * the first sign of trouble is a prompt nobody can evaluate because there is nothing for
 * it to be right about.
 *
 * Rows the scanner cannot verify by pattern are reported as *asserted by plan*, traceable
 * to the placement that claims them.
 *
 * It also asserts the account binding: every seeded person used on camera must be bound to
 * a real Telegram user id, supplied from the environment rather than committed. Without
 * `--allow-unbound` that is a hard failure, because the orphan case fails silently
 * otherwise — the brief simply appears with nothing interesting in it.
 *
 * Usage:
 *   pnpm seed:transcript                     full six months
 *   pnpm seed:transcript -- --months 2       the development slice
 *   pnpm seed:transcript -- --allow-unbound  before the demo accounts exist
 *
 * Writing to Postgres is deliberately **not** done here. Seeded messages must enter
 * through the same normaliser as live traffic, so `backfill.ts` loads this artifact
 * through it. A second insert path in this file would be a second normaliser, and the two
 * would drift.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEMO_ROLES, type SeedPlan } from "./src/seed/plan-types.js";
import { COVERAGE_REPORT_PATH, PLAN_FIXTURE_PATH, TRANSCRIPT_PATH } from "./src/seed/paths.js";
import { formatReport, rulesCoverEveryRow, scanCoverage } from "./src/seed/coverage.js";
import { buildPlan } from "./src/seed/plan.js";
import { renderTranscript } from "./src/seed/render.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const allowUnbound = process.argv.includes("--allow-unbound");

/**
 * The demo accounts, bound during seeding rather than by hand afterwards. Read from the
 * environment so no real user id is ever committed:
 *   SEED_TELEGRAM_ID_COORDINATOR, SEED_TELEGRAM_ID_LEAVER, SEED_TELEGRAM_ID_ARRIVER
 */
function resolveBindings(
  plan: SeedPlan,
): { role: string; personId: string; telegramUserId: number | null }[] {
  return DEMO_ROLES.map((role) => {
    const person = plan.people.find((candidate) => candidate.demoRole === role);
    if (person === undefined) {
      throw new Error(`plan binds nobody to demo role '${role}'`);
    }
    const raw = process.env[`SEED_TELEGRAM_ID_${role.toUpperCase()}`];
    const parsed = raw === undefined || raw === "" ? null : Number(raw);
    if (parsed !== null && !Number.isSafeInteger(parsed)) {
      throw new Error(`SEED_TELEGRAM_ID_${role.toUpperCase()} is not an integer: ${raw}`);
    }
    return { role, personId: person.id, telegramUserId: parsed };
  });
}

function main(): void {
  const fixture = readFileSync(PLAN_FIXTURE_PATH, "utf8");
  const plan = JSON.parse(fixture) as SeedPlan;

  // The fixture is committed so a regenerated transcript exercises the same paths — which
  // means an edited placement that nobody regenerated renders the *old* material and the
  // coverage report describes a file that no longer exists on disk. Rebuilding the plan
  // and comparing is exact and costs nothing, and it turns a confusing coverage failure
  // into the actual instruction.
  const rebuilt = `${JSON.stringify(buildPlan(), null, 2)}\n`;
  if (rebuilt !== fixture) {
    console.error(
      "The committed plan fixture is stale — the placements have changed since it was written.\n" +
        "Run `pnpm seed:plan` and commit the result, then render again.",
    );
    process.exit(1);
  }

  // Guards the guard. A row with no scanner rule and no plan assertion would report as
  // missing forever, or worse, be quietly dropped from the report if this were skipped.
  const unruled = rulesCoverEveryRow(plan.assertedByPlan);
  if (unruled.length > 0) {
    console.error(
      `Coverage rows with neither a scanner rule nor a plan assertion: ${unruled.join(", ")}`,
    );
    process.exit(1);
  }

  const monthsArg = arg("months");
  const months = monthsArg === undefined ? plan.months : Number(monthsArg);
  if (!Number.isFinite(months) || months <= 0) {
    console.error(`--months must be a positive number, got '${monthsArg}'`);
    process.exit(1);
  }

  const bindings = resolveBindings(plan);
  const unbound = bindings.filter((binding) => binding.telegramUserId === null);

  const rendered = renderTranscript(plan, { months });
  const result = scanCoverage(plan, rendered.messages);
  const report = formatReport(result, rendered.messages.length);

  mkdirSync(dirname(TRANSCRIPT_PATH), { recursive: true });
  writeFileSync(
    TRANSCRIPT_PATH,
    `${JSON.stringify(
      {
        planVersion: plan.planVersion,
        months,
        windowStart: rendered.windowStart,
        windowEnd: rendered.windowEnd,
        timezone: plan.timezone,
        source: "seed",
        fillerProvider: rendered.fillerProvider,
        accountBindings: bindings,
        messages: rendered.messages,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(COVERAGE_REPORT_PATH, report, "utf8");

  console.log(`seed-transcript: wrote ${TRANSCRIPT_PATH}`);
  console.log(
    `  window        ${rendered.windowStart} → ${rendered.windowEnd} (${months} month slice)`,
  );
  console.log(`  messages      ${rendered.messages.length}`);
  console.log(`  placed        ${plan.placements.length} verbatim from the plan`);
  console.log(`  filler        ${rendered.fillerProvider}`);
  console.log("");
  console.log(report.trimEnd());
  console.log("");

  for (const binding of bindings) {
    const state = binding.telegramUserId === null ? "UNBOUND" : String(binding.telegramUserId);
    console.log(`  binding  ${binding.role.padEnd(12)} ${binding.personId}  ${state}`);
  }

  if (result.missing.length > 0) {
    console.error(
      `\nCoverage incomplete: ${result.missing.length} rows unmatched — ${result.missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (unbound.length > 0 && !allowUnbound) {
    console.error(
      `\n${unbound.length} demo account(s) not bound to a real Telegram user id: ` +
        `${unbound.map((binding) => binding.role).join(", ")}.\n` +
        "Set SEED_TELEGRAM_ID_COORDINATOR / _LEAVER / _ARRIVER, or pass --allow-unbound " +
        "if the accounts do not exist yet. The orphan case fails silently without this.",
    );
    process.exit(1);
  }

  console.log("\nCoverage complete.");
}

main();
