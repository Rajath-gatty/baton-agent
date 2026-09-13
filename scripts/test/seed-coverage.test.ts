import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ASSET_KINDS } from "@baton/core";
import {
  COVERAGE_ROWS,
  PLANTED_CASES,
  ROSTER_SIZE,
  SLICE_MONTHS,
  type SeedPlan,
} from "../src/seed/plan-types.js";
import { buildPlan } from "../src/seed/plan.js";
import { renderTranscript } from "../src/seed/render.js";
import { rulesCoverEveryRow, scanCoverage } from "../src/seed/coverage.js";
import { PLAN_FIXTURE_PATH } from "../src/seed/paths.js";

/**
 * The coverage report is the only thing standing between a transcript that exercises the
 * whole pipeline and one that exercises a third of it while looking identical. So the
 * report itself is tested, not just run.
 *
 * The mutilated-plan case is the important one. A fail-closed check that has never been
 * observed failing is indistinguishable from a check that always passes, and this is the
 * check the design document says cannot be a warning.
 */

const plan = buildPlan();

describe("the plan", () => {
  it("is a roster of twenty with one coordinator", () => {
    expect(plan.people).toHaveLength(ROSTER_SIZE);
    expect(plan.people.filter((person) => person.isCoordinator)).toHaveLength(1);
  });

  it("spans all six asset kinds", () => {
    const kinds = new Set(plan.assets.map((asset) => asset.kind));
    expect([...kinds].sort()).toEqual([...ASSET_KINDS].sort());
  });

  it("places every coverage row or asserts it by plan", () => {
    const placed = new Set(plan.placements.flatMap((message) => message.coverage));
    const unaccounted = COVERAGE_ROWS.filter(
      (row) => !placed.has(row) && !plan.assertedByPlan.includes(row),
    );
    expect(unaccounted).toEqual([]);
  });

  it("carries all five planted cases, woven through the window rather than appended", () => {
    for (const planted of PLANTED_CASES) {
      const ids = plan.cases[planted].messageIds;
      expect(ids.length, planted).toBeGreaterThan(0);
    }

    // Appended material would cluster at one end. These sit across the window: April for
    // the orphan and the stale figure, September for the approval and the restraint.
    const caseDates = plan.placements
      .filter((message) => message.cases.length > 0)
      .map((message) => message.date);
    const months = new Set(caseDates.map((date) => date.slice(0, 7)));
    expect(months.size).toBeGreaterThan(1);
  });

  it("binds the volunteer who leaves on camera to the donation page", () => {
    // If these are two different people the orphan case does not fire, and it fails
    // silently — the brief simply appears with nothing interesting in it.
    const leaver = plan.people.find((person) => person.demoRole === "leaver");
    const donationPage = plan.placements.find(
      (message) => message.cases.includes("orphan") && message.text.includes("donation page"),
    );
    expect(leaver).toBeDefined();
    expect(donationPage?.senderId).toBe(leaver?.id);
  });

  it("puts the stale figure near the start of the window", () => {
    // It has to read as five months old on recording day. If it drifts later, the stale
    // answer case stops being about staleness.
    const stale = plan.placements.find((message) => message.cases.includes("stale_answer"));
    expect(stale).toBeDefined();
    expect(stale?.date.slice(0, 7)).toBe("2026-04");
  });

  it("matches the committed fixture", () => {
    // The fixture is committed so a regenerated transcript exercises the same paths. If it
    // drifts from the builder, the transcript renders material nobody reviewed.
    const fixture = readFileSync(PLAN_FIXTURE_PATH, "utf8");
    expect(fixture).toBe(`${JSON.stringify(plan, null, 2)}\n`);
  });

  it("is deterministic — two builds are identical", () => {
    expect(JSON.stringify(buildPlan())).toBe(JSON.stringify(plan));
  });
});

describe("the scanner", () => {
  it("has a rule or a plan assertion for every coverage row", () => {
    // Guards the guard: a row with neither would silently never be verified.
    expect(rulesCoverEveryRow(plan.assertedByPlan)).toEqual([]);
  });
});

describe("the rendered transcript", () => {
  const rendered = renderTranscript(plan);

  it("carries roughly four and a half thousand messages across six months", () => {
    expect(rendered.messages.length).toBeGreaterThan(4000);
    expect(rendered.messages.length).toBeLessThan(5000);
  });

  it("renders every placed message verbatim", () => {
    for (const placement of plan.placements) {
      const rendered_ = rendered.messages.find((message) => message.planMessageId === placement.id);
      expect(rendered_, placement.id).toBeDefined();
      // Media messages carry no text; everything else must be byte-identical, because the
      // scanner's patterns quote these sentences.
      if (placement.flags.media === undefined) {
        expect(rendered_?.text).toBe(placement.text);
      } else {
        expect(rendered_?.text).toBeNull();
      }
    }
  });

  it("satisfies every coverage row", () => {
    const result = scanCoverage(plan, rendered.messages);
    expect(result.missing).toEqual([]);
    expect(result.rows.every((row) => row.status !== "missing")).toBe(true);
    // The two rows a text scanner cannot honestly verify, and only those two. Compared as
    // a set: the report is ordered by the coverage table, not by the assertion list.
    expect(
      result.rows
        .filter((row) => row.status === "asserted_by_plan")
        .map((row) => row.row)
        .sort(),
    ).toEqual([...plan.assertedByPlan].sort());
  });

  it("is strictly ordered by sent_at", () => {
    // Supersession is order-dependent: a contradiction processed backwards silently
    // inverts a fact, so the transcript must not rely on the loader to sort it.
    for (let index = 1; index < rendered.messages.length; index += 1) {
      const previous = rendered.messages[index - 1]?.sentAt ?? "";
      const current = rendered.messages[index]?.sentAt ?? "";
      expect(previous <= current, `message ${index} is out of order`).toBe(true);
    }
  });

  it("gives every message a distinct, deterministic, negative telegram id", () => {
    // Negative and deterministic so re-seeding is idempotent under the unique constraint
    // on (chat_id, telegram_message_id) rather than duplicating six months.
    const ids = rendered.messages.map((message) => message.telegramMessageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id < 0)).toBe(true);
  });

  it("never has someone send a message before they joined or after they left", () => {
    const byId = new Map(plan.people.map((person) => [person.id, person] as const));
    for (const message of rendered.messages) {
      const person = byId.get(message.senderPlanId);
      const date = message.sentAt.slice(0, 10);
      if (person?.joinedAt != null) expect(date >= person.joinedAt).toBe(true);
      // The departure announcement is sent *on* the day they leave, so the bound is
      // inclusive on that date and exclusive after it.
      if (person?.leftAt != null) expect(date <= person.leftAt).toBe(true);
    }
  });
});

describe("the two-month development slice", () => {
  const slice = renderTranscript(plan, { months: SLICE_MONTHS });

  it("compresses the coverage rows into the shorter span rather than dropping them", () => {
    const result = scanCoverage(plan, slice.messages);
    expect(result.missing).toEqual([]);
  });

  it("keeps every placement, in the same relative order", () => {
    const placed = slice.messages
      .filter((message) => message.planMessageId !== null)
      .map((message) => message.planMessageId);
    expect(placed).toEqual(plan.placements.map((placement) => placement.id));
  });

  it("is proportionally as busy, not the whole transcript crammed in", () => {
    expect(slice.messages.length).toBeLessThan(renderTranscript(plan).messages.length / 2);
  });
});

describe("a mutilated plan exits non-zero", () => {
  /** Deep clone, so one mutilation cannot leak into the next test. */
  function clone(): SeedPlan {
    return JSON.parse(JSON.stringify(plan)) as SeedPlan;
  }

  it("reports the row as missing when its only material is removed", () => {
    const mutilated = clone();
    mutilated.placements = mutilated.placements.filter(
      (message) => !message.coverage.includes("hearsay"),
    );

    const result = scanCoverage(mutilated, renderTranscript(mutilated).messages);

    expect(result.missing).toContain("hearsay");
    // And the report says which sub-requirement failed, not merely that something did.
    const row = result.rows.find((candidate) => candidate.row === "hearsay");
    expect(row?.gaps.join(" ")).toContain("relayed claim");
  });

  it("reports the row as missing when the material is paraphrased", () => {
    // The failure mode a model-backed filler provider would introduce: the message is
    // still there and still reads fine, but the material it carried is gone.
    const mutilated = clone();
    for (const message of mutilated.placements) {
      if (message.coverage.includes("negation")) {
        message.text = "Spoke to Deepak about the sponsorship today, interesting chat.";
      }
    }

    const result = scanCoverage(mutilated, renderTranscript(mutilated).messages);
    expect(result.missing).toContain("negation");
  });

  it("reports a partial row as missing, not as matched", () => {
    // "One dated promise AND one undated intention" — half of it is a failure.
    const mutilated = clone();
    for (const message of mutilated.placements) {
      if (message.text.includes("I'll sort out the poster reprint")) {
        message.text = "Someone should look at the poster reprint.";
      }
    }

    const result = scanCoverage(mutilated, renderTranscript(mutilated).messages);
    expect(result.missing).toContain("commitment");
    const row = result.rows.find((candidate) => candidate.row === "commitment");
    expect(row?.hits.map((hit) => hit.label)).toContain("dated promise");
    expect(row?.gaps.join(" ")).toContain("undated intention");
  });

  it("reports a count-based row as missing when the material appears only once", () => {
    // Participation evidence requires thanks-lists more than once. One is not enough.
    const mutilated = clone();
    let seen = 0;
    for (const message of mutilated.placements) {
      if (!message.coverage.includes("participation_evidence")) continue;
      seen += 1;
      if (seen > 1) message.text = "Good camp yesterday, everyone worked hard.";
    }

    const result = scanCoverage(mutilated, renderTranscript(mutilated).messages);
    expect(result.missing).toContain("participation_evidence");
  });
});
