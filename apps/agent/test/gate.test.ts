/**
 * The produce-path gate. `[F18]`
 *
 * The scope test next door proves Restraint is *wired* to all three producing tasks.
 * This one proves it *works* on all three: that a withheld item leaves a
 * `quiet_decisions` row from the brief-line and answer paths as well as the findings
 * path, which is the specific assertion the design asks for.
 *
 * The model call is stubbed. Restraint's judgment is a judgment — asserting what it
 * decides would be a flaky test of a prompt. What is asserted here is the mechanism
 * around it: that a withholding is never a silent drop, that a bypassed item is not
 * charged for, and that an item nobody judged is withheld rather than surfaced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestraintOutput } from "@baton/core";
import type { RestraintItem } from "../src/agents/restraint.js";

const runRestraint = vi.hoisted(() => vi.fn());
vi.mock("../src/agents/restraint.js", () => ({ runRestraint }));

const { RestraintGate } = await import("../src/produce/gate.js");
const { TraceCollector } = await import("../src/model/trace.js");

function deps() {
  return {
    config: {} as never,
    trace: new TraceCollector(),
    dataApi: {} as never,
  };
}

/** Makes Restraint withhold everything it is asked about, with a reason. */
function withholdAll(reason: string) {
  return (items: readonly RestraintItem[]): Promise<RestraintOutput> =>
    Promise.resolve({
      decisions: items.map((item) => ({
        itemRef: item.itemRef,
        scope: item.scope,
        decision: "withhold" as const,
        reason,
      })),
    });
}

function surfaceAll(items: readonly RestraintItem[]): Promise<RestraintOutput> {
  return Promise.resolve({
    decisions: items.map((item) => ({
      itemRef: item.itemRef,
      scope: item.scope,
      decision: "surface" as const,
      reason: null,
    })),
  });
}

describe("the gate on every produce path", () => {
  beforeEach(() => {
    runRestraint.mockReset();
  });

  it.each([
    ["assess", "finding"],
    ["brief", "brief_line"],
    ["respond", "answer"],
  ] as const)("records a quiet decision when %s withholds", async (task, scope) => {
    runRestraint.mockImplementation(withholdAll("Rests on a single passing mention."));
    const gate = new RestraintGate(task, deps());

    const outcome = await gate.apply([
      { itemRef: "item-1", text: "something Baton might have said", supporting: {}, value: 1 },
    ]);

    expect(outcome.surfaced).toEqual([]);
    expect(outcome.quietDecisions).toHaveLength(1);
    expect(outcome.quietDecisions[0]).toMatchObject({
      scope,
      withheld: "something Baton might have said",
      reason: "Rests on a single passing mention.",
    });
  });

  it("surfaces the value, not the rendered text, when an item passes", async () => {
    runRestraint.mockImplementation(surfaceAll);
    const gate = new RestraintGate("brief", deps());

    const line = { section: "only_they_held", text: "The donation page login" };
    const outcome = await gate.apply([
      { itemRef: "l-0", text: line.text, supporting: {}, value: line },
    ]);

    expect(outcome.surfaced).toEqual([line]);
    expect(outcome.quietDecisions).toEqual([]);
  });

  it("carries the finding dedupe key onto the quiet decision so the strip can link", async () => {
    runRestraint.mockImplementation(withholdAll("Already settled."));
    const gate = new RestraintGate("assess", deps());

    const outcome = await gate.apply([
      {
        itemRef: "asset:donation_page:sole_holder",
        findingDedupeKey: "asset:donation_page:sole_holder",
        text: "Only one person can access the donation account",
        supporting: { severity: "high" },
        value: {},
      },
    ]);

    expect(outcome.quietDecisions[0]?.findingDedupeKey).toBe("asset:donation_page:sole_holder");
  });

  it("does not send an already-settled finding to the model at all", async () => {
    runRestraint.mockImplementation(surfaceAll);
    const gate = new RestraintGate("assess", deps());

    const outcome = await gate.apply([
      {
        itemRef: "settled",
        text: "unchanged since the last sweep",
        supporting: {},
        value: "kept",
        needsJudgement: false,
      },
      { itemRef: "changed", text: "severity moved to high", supporting: {}, value: "judged" },
    ]);

    // The bypassed item is surfaced, and only the changed one was put to the model.
    expect(outcome.surfaced.sort()).toEqual(["judged", "kept"]);
    const asked = runRestraint.mock.calls[0]?.[0] as RestraintItem[];
    expect(asked.map((item) => item.itemRef)).toEqual(["changed"]);
  });

  it("withholds an item Restraint returned no decision for", async () => {
    // Failing towards silence. An unjudged item has not been established as warranted,
    // and saying something it should not have is the worse failure.
    runRestraint.mockResolvedValue({ decisions: [] });
    const gate = new RestraintGate("respond", deps());

    const outcome = await gate.apply([
      { itemRef: "q-1", text: "an answer nobody judged", supporting: {}, value: "reply" },
    ]);

    expect(outcome.surfaced).toEqual([]);
    expect(outcome.quietDecisions).toHaveLength(1);
    expect(outcome.quietDecisions[0]?.reason).toMatch(/no restraint decision/i);
  });

  it("makes no model call when there is nothing to gate", async () => {
    runRestraint.mockImplementation(surfaceAll);
    const gate = new RestraintGate("assess", deps());

    const outcome = await gate.apply([]);

    expect(outcome).toEqual({ surfaced: [], quietDecisions: [] });
    expect(runRestraint).toHaveBeenCalledWith([], expect.anything());
  });
});
