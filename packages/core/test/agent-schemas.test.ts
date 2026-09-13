import { describe, expect, it } from "vitest";
import {
  assessorOutputSchema,
  brieferOutputSchema,
  cartographerOutputSchema,
  curatorOutputSchema,
  respondentOutputSchema,
  restraintOutputSchema,
} from "../src/schemas/index.js";
import type { RespondentOutput } from "../src/schemas/index.js";

/**
 * The pipeline depends on strict schema conformance, and a cheap model's failure
 * mode is not a crash but plausible output that is subtly wrong. Every response is
 * validated and retried with the validation error fed back, so what matters here is
 * not only that valid output parses but that each *specific* malformed shape is
 * rejected — an unrejected shape is one that reaches the register silently.
 *
 * The negative cases are therefore the point of this file. Each one corresponds to a
 * failure the design calls out by name: a suppressed candidate with no reason, a
 * withheld item with no reason, an empty brief rendered as three empty sections, a
 * stale answer that does not state its age.
 */

const record = {
  kind: "durable_fact" as const,
  claim: "Sunrise Clinic lets us settle at month end.",
  confidence: 0.9,
  assetKind: "relationship" as const,
  assetName: "Sunrise Clinic",
  sensitivity: "normal" as const,
  holderMention: "Priya",
  subjectMentions: [],
  capabilityName: null,
  deadlineText: null,
  deadlineDate: null,
  isHearsay: false,
  isNegation: false,
  lifecycleKind: null,
};

describe("curator output", () => {
  it("accepts noise with no records at all", () => {
    const parsed = curatorOutputSchema.safeParse({
      results: [
        {
          messageId: "m1",
          classification: "noise",
          reasoning: "A conditional about a second van the group does not own.",
          records: [],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts several records from one message", () => {
    const parsed = curatorOutputSchema.safeParse({
      results: [
        {
          messageId: "m2",
          classification: "durable_fact",
          reasoning: "Carries both an arrangement and a promise.",
          records: [
            record,
            {
              ...record,
              kind: "commitment",
              claim: "Priya will call the printers.",
              deadlineText: "tomorrow",
              deadlineDate: "2026-03-04",
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.results[0]?.records).toHaveLength(2);
  });

  it("rejects a confidence outside 0..1", () => {
    const parsed = curatorOutputSchema.safeParse({
      results: [
        {
          messageId: "m3",
          classification: "durable_fact",
          reasoning: "",
          records: [{ ...record, confidence: 1.4 }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a resolved date that is not YYYY-MM-DD", () => {
    // "next Tuesday" left unresolved would be stored as a deadline of nothing.
    const parsed = curatorOutputSchema.safeParse({
      results: [
        {
          messageId: "m4",
          classification: "commitment",
          reasoning: "",
          records: [{ ...record, kind: "commitment", deadlineDate: "next Tuesday" }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects noise as an extracted record kind", () => {
    // Noise classifies a message; it can never be a record. Allowing it would put
    // jokes in the register with a confidence attached.
    const parsed = curatorOutputSchema.safeParse({
      results: [
        {
          messageId: "m5",
          classification: "noise",
          reasoning: "",
          records: [{ ...record, kind: "noise" }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cartographer output", () => {
  it("accepts a resolved mention", () => {
    const parsed = cartographerOutputSchema.safeParse({
      attributions: [
        {
          recordIndex: 0,
          mention: "@priya_pc",
          resolution: "resolved",
          personId: "p1",
          candidatePersonIds: ["p1"],
          externalName: null,
          isPersonalResource: false,
          confidence: 0.95,
          reasoning: "Handle matches one alias exactly.",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts cannot_determine with two candidates", () => {
    // The branch that exists so the Cartographer never has to guess which Priya.
    const parsed = cartographerOutputSchema.safeParse({
      attributions: [
        {
          recordIndex: 1,
          mention: "Priya",
          resolution: "cannot_determine",
          personId: null,
          candidatePersonIds: ["p1", "p7"],
          externalName: null,
          isPersonalResource: false,
          confidence: 0.4,
          reasoning: "Two people answer to this first name and neither is nearer in context.",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown resolution", () => {
    const parsed = cartographerOutputSchema.safeParse({
      attributions: [
        {
          recordIndex: 0,
          mention: "Pri",
          resolution: "probably_priya",
          personId: null,
          candidatePersonIds: [],
          externalName: null,
          isPersonalResource: false,
          confidence: 0.5,
          reasoning: "",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("assessor output", () => {
  const finding = {
    dedupeKey: "asset:donation_page:sole_holder",
    type: "asset" as const,
    subtype: "sole_holder" as const,
    title: "Only one person has been seen managing the donation page",
    whyItMatters: "Donations stop if access is lost and nobody else has signed in.",
    severity: "high" as const,
    confidence: 0.8,
    suppress: false,
    suppressionReason: null,
    aggregatedDedupeKeys: [],
    reasoning: "Financial control with a single active holding.",
  };

  it("accepts a judged candidate", () => {
    expect(assessorOutputSchema.safeParse({ findings: [finding] }).success).toBe(true);
  });

  it("accepts aggregation across a capability area", () => {
    const parsed = assessorOutputSchema.safeParse({
      findings: [
        {
          ...finding,
          type: "capability",
          dedupeKey: "capability:foster_placement:sole_holder",
          aggregatedDedupeKeys: ["capability:foster_intake:sole_holder"],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects suppression with no reason", () => {
    // A suppressed candidate with no recorded reason is indistinguishable from a
    // dropped one, and the quiet-decisions strip has nothing to render.
    const parsed = assessorOutputSchema.safeParse({
      findings: [{ ...finding, suppress: true, suppressionReason: null }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("restraint output", () => {
  it("accepts a surfaced item with no reason", () => {
    const parsed = restraintOutputSchema.safeParse({
      decisions: [
        {
          itemRef: "asset:donation_page:sole_holder",
          scope: "finding",
          decision: "surface",
          reason: null,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a withholding on each of the three produce paths", () => {
    for (const scope of ["finding", "brief_line", "answer"] as const) {
      const parsed = restraintOutputSchema.safeParse({
        decisions: [
          {
            itemRef: `ref:${scope}`,
            scope,
            decision: "withhold",
            reason: "Nothing is blocked on this yet; raising it now would be noise.",
          },
        ],
      });
      expect(parsed.success, scope).toBe(true);
    }
  });

  it("rejects a withholding with no reason", () => {
    const parsed = restraintOutputSchema.safeParse({
      decisions: [{ itemRef: "x", scope: "answer", decision: "withhold", reason: "   " }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("briefer output", () => {
  const line = {
    section: "only_they_held" as const,
    text: "The donation page has no other recorded holder.",
    evidenceFactIds: ["f1"],
    evidenceMessageIds: ["m1"],
    subjectAssetId: "a1",
    subjectCapabilityId: null,
    subjectCommitmentId: null,
  };

  it("accepts lines across all three fixed sections", () => {
    const parsed = brieferOutputSchema.safeParse({
      kind: "departure",
      subjectPersonId: "p1",
      openingLine: "Meera left the group today. Three things appear to have gone with her.",
      isEmpty: false,
      lines: [
        line,
        { ...line, section: "they_had_promised", text: "An undated promise to call the printers." },
        {
          ...line,
          section: "nobody_else_seen",
          text: "Nobody else has been seen driving the van.",
        },
      ],
      reasoning: "Scoped to her observed holdings and open commitments.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the empty case as one plain sentence", () => {
    const parsed = brieferOutputSchema.safeParse({
      kind: "departure",
      subjectPersonId: "p2",
      openingLine: "Nothing appears to have left with them.",
      isEmpty: true,
      lines: [],
      reasoning: "No holdings, no open commitments, no sole coverage.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a brief with no lines that does not say so", () => {
    // Three empty sections read as broken software, and a coordinator who sees that
    // once stops opening briefs.
    const parsed = brieferOutputSchema.safeParse({
      kind: "arrival",
      subjectPersonId: "p3",
      openingLine: "Where a new person is most needed.",
      isEmpty: false,
      lines: [],
      reasoning: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown section", () => {
    const parsed = brieferOutputSchema.safeParse({
      kind: "departure",
      subjectPersonId: "p1",
      openingLine: "x",
      isEmpty: false,
      lines: [{ ...line, section: "what_they_were_bad_at" }],
      reasoning: "",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("respondent output", () => {
  const base: RespondentOutput = {
    outcome: "answer",
    answerText: "Fourteen, as of 2 September.",
    factIds: ["f1"],
    evidenceMessageIds: ["m1"],
    ageDays: 11,
    candidateHolderPersonIds: [],
    target: "group",
    followUpQuestion: null,
    reasoning: "One active fact, recently confirmed.",
  };

  it("accepts an answer with provenance", () => {
    expect(respondentOutputSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a stale answer that states its age", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "stale_answer",
      ageDays: 152,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an ambiguous holder with two candidates, routed privately", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "ambiguous_holder",
      answerText: "Two people are recorded as holding this and I cannot tell which.",
      candidateHolderPersonIds: ["p1", "p7"],
      target: "coordinator",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unknown that becomes a question", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "unknown",
      answerText: null,
      factIds: [],
      evidenceMessageIds: [],
      ageDays: null,
      followUpQuestion: "Does anyone know the current sterilisation rate?",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an answer with no fact behind it", () => {
    // Provenance on every claim is on the never-cut list.
    const parsed = respondentOutputSchema.safeParse({ ...base, factIds: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a stale answer with no age", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "stale_answer",
      ageDays: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an ambiguous holder with only one candidate", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "ambiguous_holder",
      candidateHolderPersonIds: ["p1"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown that nonetheless answers", () => {
    const parsed = respondentOutputSchema.safeParse({
      ...base,
      outcome: "unknown",
      answerText: "Probably fourteen.",
      factIds: [],
    });
    expect(parsed.success).toBe(false);
  });
});
