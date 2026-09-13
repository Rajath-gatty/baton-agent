/**
 * Restraint scope. `[F18]`
 *
 * **This is the test that stops the veto silently narrowing to findings during a
 * refactor.** The design's claim is that Restraint's scope is a property of the
 * container's wiring rather than of any one graph — registered on all three producing
 * tasks, so the two surfaces a human reads aloud cannot end up ungated.
 *
 * A claim like that decays quietly. Someone moves the gate inside `assess` because
 * that is where findings are, the briefs and answers keep working, nothing fails, and
 * the product's most distinctive behaviour is gone from two of the three places it was
 * promised. So the wiring is asserted directly.
 */

import { describe, expect, it } from "vitest";
import { RESTRAINT_ATTACHED_TASKS } from "../src/tasks/index.js";
import {
  PRODUCING_TASKS,
  RESTRAINT_SCOPE_BY_TASK,
  shouldGateFinding,
} from "../src/produce/gate.js";

describe("restraint scope", () => {
  it("is attached to exactly assess, brief and respond", () => {
    expect([...RESTRAINT_ATTACHED_TASKS].sort()).toEqual(["assess", "brief", "respond"]);
  });

  it("is not attached to ingest, which produces no outbound text", () => {
    expect(RESTRAINT_ATTACHED_TASKS.has("ingest")).toBe(false);
  });

  it("covers every producing task", () => {
    for (const task of PRODUCING_TASKS) {
      expect(RESTRAINT_ATTACHED_TASKS.has(task)).toBe(true);
    }
  });

  it("maps each producing task to a distinct quiet-decision scope", () => {
    // Distinct scopes are what let the quiet-decisions strip prove all three paths are
    // live. If two tasks shared a scope, a withheld answer would be indistinguishable
    // from a withheld brief line and the coverage claim would be unfalsifiable.
    const scopes = Object.values(RESTRAINT_SCOPE_BY_TASK);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.sort()).toEqual(["answer", "brief_line", "finding"]);
  });
});

describe("gating per output class", () => {
  it("judges a finding whose dedupe key is new", () => {
    expect(shouldGateFinding({ previousSeverity: null, severity: "high" })).toBe(true);
  });

  it("judges a finding whose severity changed", () => {
    expect(shouldGateFinding({ previousSeverity: "low", severity: "high" })).toBe(true);
  });

  it("does not re-judge a finding that is unchanged", () => {
    // The expensive case. Sweeps re-derive findings from scratch, so without this an
    // ungated Restraint would re-veto the same settled items on every sweep forever —
    // and the quiet-decisions strip would churn between sweeps for no observable reason.
    expect(shouldGateFinding({ previousSeverity: "medium", severity: "medium" })).toBe(false);
  });
});
