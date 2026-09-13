/**
 * Agent-side output handling.
 *
 * Three seams where a cheap model's plausible-but-wrong output is caught in code rather
 * than trusted, which is the design's stated defence: validate every response, and keep
 * the corrections deterministic so they cannot be lost to a prompt revision.
 */

import { describe, expect, it } from "vitest";
import type { RespondContext, RespondentOutput } from "@baton/core";
import { extractJsonObject } from "../src/model/structured.js";
import { keepKnownKeys, titlesNamingPeople } from "../src/agents/assessor.js";
import { reconcileWithIndex } from "../src/agents/respondent.js";

describe("extractJsonObject", () => {
  it("passes bare JSON through", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a fenced block", () => {
    // Tolerated rather than retried: the response was correct and re-asking costs a
    // whole call to get the same object back.
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips prose either side of the object", () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it("keeps nested braces intact", () => {
    const nested = '{"outer":{"inner":[1,2]}}';
    expect(extractJsonObject(`prose ${nested} more`)).toBe(nested);
  });

  it("returns the input unchanged when there is no object, so parsing fails loudly", () => {
    expect(extractJsonObject("I could not do that")).toBe("I could not do that");
  });
});

describe("assessor key discipline", () => {
  const finding = (dedupeKey: string, extra: Partial<{ aggregatedDedupeKeys: string[] }> = {}) => ({
    dedupeKey,
    type: "asset" as const,
    subtype: "sole_holder" as const,
    title: "Only one person can access the donation account",
    whyItMatters: "Donations stop if that access is lost.",
    severity: "high" as const,
    confidence: 0.9,
    suppress: false,
    suppressionReason: null,
    aggregatedDedupeKeys: [],
    reasoning: "one holder on a financial control",
    ...extra,
  });

  it("keeps findings whose dedupe key was a candidate", () => {
    const result = keepKnownKeys({ findings: [finding("a")] }, new Set(["a"]));
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it("drops an invented dedupe key rather than letting it upsert a row", () => {
    // The key is the upsert target, and dismissals are recorded against it. An invented
    // one would insert a duplicate every sweep and could resurrect a dismissal.
    const result = keepKnownKeys({ findings: [finding("a"), finding("invented")] }, new Set(["a"]));

    expect(result.findings.map((f) => f.dedupeKey)).toEqual(["a"]);
    expect(result.dropped).toEqual(["invented"]);
  });

  it("strips aggregation references to keys that do not exist", () => {
    const result = keepKnownKeys(
      { findings: [finding("a", { aggregatedDedupeKeys: ["b", "ghost"] })] },
      new Set(["a", "b"]),
    );

    expect(result.findings[0]?.aggregatedDedupeKeys).toEqual(["b"]);
  });

  it("flags a title that names a person", () => {
    const offending = titlesNamingPeople(
      [{ dedupeKey: "k", title: "Priya is the only one who can access the donation account" }],
      ["Priya Chandran"],
    );
    expect(offending).toEqual(["k"]);
  });

  it("accepts a title phrased about the capability", () => {
    const offending = titlesNamingPeople(
      [{ dedupeKey: "k", title: "Only one person can access the donation account" }],
      ["Priya Chandran"],
    );
    expect(offending).toEqual([]);
  });

  it("does not flag a name appearing inside a longer word", () => {
    const offending = titlesNamingPeople(
      [{ dedupeKey: "k", title: "Ravioli night has no owner" }],
      ["Ravi"],
    );
    expect(offending).toEqual([]);
  });
});

describe("respondent reconciliation", () => {
  const context = (ageDays: number): RespondContext => ({
    org: { orgName: "Test", timezone: "Asia/Kolkata", now: "2026-09-13T00:00:00.000Z" },
    factIndex: [
      {
        factId: "f1",
        claim: "Ravi has the van keys",
        assetName: "van keys",
        assetSensitivity: "normal",
        holderPersonId: "p1",
        holderDisplayName: "Ravi",
        lastConfirmedAt: "2026-04-01T00:00:00.000Z",
        ageDays,
        evidenceMessageIds: ["m1", "m2"],
      },
    ],
    aliases: [],
    askBudgetAvailable: true,
    staleThresholdDays: 90,
  });

  const reply = (overrides: Partial<RespondentOutput> = {}): RespondentOutput => ({
    outcome: "answer",
    answerText: "Ravi has the van keys.",
    factIds: ["f1"],
    evidenceMessageIds: [],
    ageDays: null,
    candidateHolderPersonIds: [],
    target: "group",
    followUpQuestion: null,
    reasoning: "one claim answers it",
    ...overrides,
  });

  it("overrules a model that called a five-month-old claim fresh", () => {
    // The branch exists so this cannot be lost to phrasing. A stale answer worded as
    // certain is one prompt revision away from a wrong decision by a volunteer.
    const result = reconcileWithIndex(reply(), context(150));

    expect(result.outcome).toBe("stale_answer");
    expect(result.ageDays).toBe(150);
  });

  it("leaves a genuinely fresh answer alone", () => {
    const result = reconcileWithIndex(reply(), context(20));

    expect(result.outcome).toBe("answer");
    expect(result.ageDays).toBe(20);
  });

  it("fills evidence message ids from the register rather than the model", () => {
    const result = reconcileWithIndex(reply(), context(20));
    expect(result.evidenceMessageIds).toEqual(["m1", "m2"]);
  });

  it("falls back to unknown when nothing it cited exists", () => {
    // Provenance that does not resolve is worse than none: it renders as a link a
    // coordinator clicks and finds nothing behind.
    const result = reconcileWithIndex(reply({ factIds: ["ghost"] }), context(20));

    expect(result.outcome).toBe("unknown");
    expect(result.answerText).toBeNull();
    expect(result.factIds).toEqual([]);
  });

  it("drops an unresolvable citation but keeps a real one", () => {
    const result = reconcileWithIndex(reply({ factIds: ["f1", "ghost"] }), context(20));
    expect(result.factIds).toEqual(["f1"]);
  });
});
