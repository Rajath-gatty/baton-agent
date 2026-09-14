/**
 * Consequence, and the four cells of the approval matrix.
 *
 * Consequence is policy with a fixed answer, so these are the assertions that stop it
 * drifting into judgment. The bottom-right cell — low consequence, low confidence,
 * recorded but *not* asked about — matters as much as the top-right: an agent that
 * escalates everything it is unsure about becomes noise and gets muted.
 */

import { describe, expect, it } from "vitest";
import {
  WEAK_EVIDENCE_CONFIDENCE,
  classifyConsequence,
  decideFactStatus,
} from "../src/consequence.js";
import { ASSET_KINDS } from "../src/constants.js";

describe("classifyConsequence", () => {
  it("treats financial control as high however it is flagged", () => {
    expect(classifyConsequence({ assetKind: "financial_control", sensitivity: "normal" })).toBe(
      "high",
    );
  });

  it("treats a login as high, because a credential leaves with its holder", () => {
    expect(classifyConsequence({ assetKind: "account_login", sensitivity: "normal" })).toBe("high");
  });

  it("raises any asset marked sensitive", () => {
    // The escape hatch that makes the other four kinds reachable: a relationship marked
    // sensitive is the named contact for something critical.
    expect(classifyConsequence({ assetKind: "relationship", sensitivity: "sensitive" })).toBe(
      "high",
    );
    expect(classifyConsequence({ assetKind: "document", sensitivity: "sensitive" })).toBe("high");
  });

  it("leaves an ordinary physical item low", () => {
    expect(classifyConsequence({ assetKind: "physical_item", sensitivity: "normal" })).toBe("low");
  });

  it("treats a claim about no particular thing as low", () => {
    expect(classifyConsequence({ assetKind: null, sensitivity: "normal" })).toBe("low");
  });

  it("classifies every asset kind without falling through", () => {
    for (const kind of ASSET_KINDS) {
      expect(["high", "low"]).toContain(
        classifyConsequence({ assetKind: kind, sensitivity: "normal" }),
      );
    }
  });
});

describe("decideFactStatus", () => {
  const strong = WEAK_EVIDENCE_CONFIDENCE + 0.1;
  const weak = WEAK_EVIDENCE_CONFIDENCE - 0.1;

  it("acts on a well-evidenced claim", () => {
    expect(
      decideFactStatus({ consequence: "low", confidence: strong, isHearsay: false }),
    ).toMatchObject({
      status: "active",
      requiresApproval: false,
    });
  });

  it("acts on a well-evidenced high-consequence claim, and records it", () => {
    expect(
      decideFactStatus({ consequence: "high", confidence: strong, isHearsay: false }),
    ).toMatchObject({
      status: "active",
      requiresApproval: false,
    });
  });

  it("stops and asks when the consequence is high and the evidence is weak", () => {
    const decision = decideFactStatus({ consequence: "high", confidence: weak, isHearsay: false });
    expect(decision.status).toBe("pending_approval");
    expect(decision.requiresApproval).toBe(true);
    // The reason is read aloud in the approval message, so it names the number.
    expect(decision.reason).toContain("0.6");
  });

  it("records low-consequence uncertainty without asking", () => {
    const decision = decideFactStatus({ consequence: "low", confidence: weak, isHearsay: false });
    expect(decision.status).toBe("unverified");
    expect(decision.requiresApproval).toBe(false);
  });

  it("treats hearsay as unverified whatever else is true of it", () => {
    // Confidence in having read the sentence correctly is not confidence that the third
    // party was right.
    for (const consequence of ["high", "low"] as const) {
      for (const confidence of [0.1, 0.99]) {
        expect(decideFactStatus({ consequence, confidence, isHearsay: true })).toMatchObject({
          status: "unverified",
          requiresApproval: false,
        });
      }
    }
  });

  it("puts the threshold exactly at the boundary, not above it", () => {
    expect(
      decideFactStatus({
        consequence: "high",
        confidence: WEAK_EVIDENCE_CONFIDENCE,
        isHearsay: false,
      }).status,
    ).toBe("active");
  });

  it("keeps every uncertain outcome out of detection SQL", () => {
    // pending_approval and unverified are both invisible to detection, which is how the
    // promise that a pending change never appears in a finding is kept.
    const uncertain = [
      decideFactStatus({ consequence: "high", confidence: weak, isHearsay: false }),
      decideFactStatus({ consequence: "low", confidence: weak, isHearsay: false }),
      decideFactStatus({ consequence: "low", confidence: 0.99, isHearsay: true }),
    ];
    for (const decision of uncertain) {
      expect(decision.status).not.toBe("active");
    }
  });
});
