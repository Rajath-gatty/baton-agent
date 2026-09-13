/**
 * Plan assembly, and the assertions that make it fail closed.
 *
 * Every check here exists because the thing it checks fails *silently*. A roster with
 * nineteen people, a coverage row nobody placed, a capability that accidentally has
 * three participants instead of one — none of these look broken. They produce a
 * transcript that reads fine and a pipeline path that has never run, and the first sign
 * of trouble is a prompt nobody can evaluate because there is nothing for it to be
 * right about.
 *
 * The account binding is the sharpest of them. If the person who leaves on camera is not
 * the seeded holder of the donation page, the orphan case does not fire — the brief
 * simply appears with nothing interesting in it, which is the first fifteen seconds of
 * the video.
 */

import { ASSET_KINDS } from "@baton/core";
import {
  COVERAGE_ROWS,
  DEMO_ROLES,
  PLANTED_CASES,
  ROSTER_SIZE,
  SEED_MONTHS,
  type CoverageRow,
  type PlanPerson,
  type PlannedMessage,
  type SeedPlan,
} from "./plan-types.js";
import { assertSixAssetKinds, buildAssets, buildCapabilities } from "./inventory.js";
import { buildRoster } from "./roster.js";
import { CAPABILITY_POOLS, buildCalendar } from "./calendar.js";
import {
  ASSERTED_BY_PLAN,
  SEEDED_ARRIVAL,
  SEEDED_DEPARTURE,
  WINDOW_END,
  WINDOW_START,
  buildPlacements,
} from "./placements.js";
import { createRng } from "./rng.js";

export const PLAN_VERSION = 1;

/** Fixed, so the committed fixture is reproducible byte for byte. */
export const PLAN_SEED = 20260913;

export const ORG_NAME = "Paws & Claws Collective";
export const ORG_TIMEZONE = "Asia/Kolkata";

const CASE_DESCRIPTIONS: Record<(typeof PLANTED_CASES)[number], string> = {
  orphan:
    "The donation page owner is the volunteer who leaves on camera, so the brief appears " +
    "unprompted with an asset that now has no owner at all.",
  restraint:
    "A four-day-old undated promise with nothing blocked on it. Deliberately not raised, " +
    "and the reasoning is on screen.",
  stale_answer:
    "The sterilisation rate, stated once in April and never since. Answered with its age " +
    "attached rather than as a current figure.",
  provenance_click:
    "A brief line traceable to the five-month-old message that produced it, with its " +
    "sender and date.",
  approval:
    "One ambiguous message about financial control changing hands. Baton stops and asks " +
    "before writing rather than guessing.",
};

function fail(message: string): never {
  throw new Error(`seed plan is invalid: ${message}`);
}

function assertRoster(people: PlanPerson[]): void {
  if (people.length !== ROSTER_SIZE) {
    fail(`roster has ${people.length} people, expected ${ROSTER_SIZE}`);
  }
  const coordinators = people.filter((person) => person.isCoordinator);
  if (coordinators.length !== 1) {
    fail(`expected exactly one coordinator, found ${coordinators.length}`);
  }
  const ids = new Set(people.map((person) => person.id));
  if (ids.size !== people.length) fail("duplicate person ids");

  // Every alias kind must appear somewhere, because identity resolution has a coverage
  // row and a kind with no material has never been tested.
  const kinds = new Set(people.flatMap((person) => person.aliases.map((alias) => alias.kind)));
  for (const kind of ["handle", "display_name", "nickname", "first_name", "role_reference"]) {
    if (!kinds.has(kind as PlanPerson["aliases"][number]["kind"])) {
      fail(`no person carries an alias of kind '${kind}'`);
    }
  }

  // The ambiguity row needs a real collision: one first name, two people.
  const firstNames = new Map<string, number>();
  for (const person of people) {
    for (const alias of person.aliases) {
      if (alias.kind !== "first_name") continue;
      firstNames.set(alias.alias, (firstNames.get(alias.alias) ?? 0) + 1);
    }
  }
  const collisions = [...firstNames.entries()].filter(([, count]) => count > 1);
  if (collisions.length === 0) {
    fail("no first name resolves to two people, so the ambiguity path has no material");
  }
}

function assertLifecycle(people: PlanPerson[]): void {
  const departures = people.filter((person) => person.leftAt !== null);
  const arrivals = people.filter((person) => person.joinedAt !== null);
  if (departures.length === 0) fail("no seeded departure inside the window");
  if (arrivals.length === 0) fail("no seeded arrival inside the window");

  for (const person of departures) {
    if (person.leftAt === null || person.leftAt < WINDOW_START || person.leftAt > WINDOW_END) {
      fail(`${person.id} leaves outside the seeded window`);
    }
  }
  for (const person of arrivals) {
    if (
      person.joinedAt === null ||
      person.joinedAt < WINDOW_START ||
      person.joinedAt > WINDOW_END
    ) {
      fail(`${person.id} joins outside the seeded window`);
    }
  }
  if (departures[0]?.id !== SEEDED_DEPARTURE.personId) {
    fail("the seeded departure does not match the placement that announces it");
  }
  if (arrivals.find((person) => person.id === SEEDED_ARRIVAL.personId) === undefined) {
    fail("the seeded arrival does not match the placement that announces it");
  }
}

/**
 * One capability with several observed participants, one with exactly one. Both halves
 * of that coverage row are properties of the participation pools rather than of the
 * prose, which is why this row is reported as asserted by plan and checked here.
 */
function assertCapabilityShape(): void {
  const sizes = Object.entries(CAPABILITY_POOLS).map(
    ([name, pool]) => [name, pool.length] as const,
  );
  if (!sizes.some(([, size]) => size >= 3)) {
    fail("no capability has several observed participants");
  }
  if (!sizes.some(([, size]) => size === 1)) {
    fail("no capability has exactly one observed participant, so sole_holder has no material");
  }
}

function assertCoverage(placements: PlannedMessage[]): void {
  const placed = new Set(placements.flatMap((message) => message.coverage));
  const missing = COVERAGE_ROWS.filter(
    (row) => !placed.has(row) && !ASSERTED_BY_PLAN.includes(row),
  );
  if (missing.length > 0) {
    fail(`coverage rows with no placement: ${missing.join(", ")}`);
  }
  const unknown = [...placed].filter((row) => !COVERAGE_ROWS.includes(row as CoverageRow));
  if (unknown.length > 0) fail(`placements tag unknown coverage rows: ${unknown.join(", ")}`);
}

function assertCases(placements: PlannedMessage[]): void {
  for (const planted of PLANTED_CASES) {
    if (!placements.some((message) => message.cases.includes(planted))) {
      fail(`planted case '${planted}' has no message`);
    }
  }
}

/**
 * The binding the whole opening case rests on: the account that leaves on camera must be
 * the seeded owner of the donation page.
 */
function assertDemoBinding(people: PlanPerson[], placements: PlannedMessage[]): void {
  for (const role of DEMO_ROLES) {
    const bound = people.filter((person) => person.demoRole === role);
    if (bound.length !== 1) {
      fail(`expected exactly one person bound to demo role '${role}', found ${bound.length}`);
    }
  }

  const leaver = people.find((person) => person.demoRole === "leaver");
  const donationPageMessage = placements.find(
    (message) => message.cases.includes("orphan") && message.text.includes("donation page"),
  );
  if (donationPageMessage === undefined) {
    fail("no orphan-case message establishes who set up the donation page");
  }
  if (leaver === undefined || donationPageMessage.senderId !== leaver.id) {
    fail(
      "the volunteer who leaves on camera is not the seeded owner of the donation page, " +
        "so the orphan case would not fire",
    );
  }
}

export function buildPlan(): SeedPlan {
  const rng = createRng(PLAN_SEED);
  const people = buildRoster();
  const assets = buildAssets();
  const capabilities = buildCapabilities();
  const events = buildCalendar(people, WINDOW_START, WINDOW_END, rng);
  const placements = buildPlacements();

  assertRoster(people);
  assertLifecycle(people);
  assertSixAssetKinds(assets);
  assertCapabilityShape();
  assertCoverage(placements);
  assertCases(placements);
  assertDemoBinding(people, placements);

  const cases = Object.fromEntries(
    PLANTED_CASES.map((planted) => [
      planted,
      {
        description: CASE_DESCRIPTIONS[planted],
        messageIds: placements
          .filter((message) => message.cases.includes(planted))
          .map((message) => message.id),
      },
    ]),
  ) as SeedPlan["cases"];

  return {
    planVersion: PLAN_VERSION,
    months: SEED_MONTHS,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    timezone: ORG_TIMEZONE,
    currency: "INR",
    orgName: ORG_NAME,
    coordinatorPersonId:
      people.find((person) => person.isCoordinator)?.id ?? fail("no coordinator"),
    people,
    assets,
    capabilities,
    events,
    placements,
    cases,
    assertedByPlan: [...ASSERTED_BY_PLAN],
  };
}

/** Kept for the report line: how many kinds the inventory actually spans. */
export const ASSET_KIND_COUNT = ASSET_KINDS.length;
