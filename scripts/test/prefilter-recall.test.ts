/**
 * Pre-filter recall against the planted corpus. `[F6]`
 *
 * **This is the test that stops the pre-filter quietly eating the demo.**
 *
 * The pre-filter is the one place in the pipeline where a mistake is invisible. A
 * discarded message is never curated, so it never becomes a fact, so it never appears in
 * the register — and nothing anywhere reports that it happened. Tightening a pattern to
 * save tokens can silently remove the stale-figure case that opens the video, and the
 * only symptom is a register that looks a bit thin.
 *
 * So every authored placement that carries a **non-noise** coverage row is asserted to
 * survive. Placements whose only coverage is `noise` are asserted to be discarded where
 * they are plain acknowledgements, because that is the filter working rather than failing.
 *
 * It runs against `scripts/fixtures/seed-plan.json`, which is committed, rather than the
 * rendered transcript, which is derived and gitignored. The placement text in the fixture
 * is the same string the renderer emits verbatim, so this needs no generated artifact and
 * runs on a fresh clone.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keepSignals, prefilter, PREFILTER_VERSION } from "@baton/core/intake";
import { PLAN_FIXTURE_PATH } from "../src/seed/paths.js";

interface Placement {
  id: string;
  text: string;
  coverage: string[];
  cases: string[];
  flags: { media?: string; forwarded?: boolean; editedTo?: string };
  note: string;
}

const plan = JSON.parse(readFileSync(PLAN_FIXTURE_PATH, "utf8")) as {
  placements: Placement[];
  cases: Record<string, { messageIds: string[] }>;
};

/**
 * Calls the filter the way the pipeline does.
 *
 * Media kind matters: a voice note is kept because it *is* media, not because of its
 * caption, and omitting it here would test a call the normaliser never makes.
 */
function filter(placement: Placement) {
  return prefilter({
    text: placement.text,
    mediaKind: placement.flags.media ?? null,
  });
}

/** A placement that exists to be noise, and nothing else. */
function isNoiseOnly(placement: Placement): boolean {
  return placement.coverage.length > 0 && placement.coverage.every((row) => row === "noise");
}

const carriers = plan.placements.filter((placement) => !isNoiseOnly(placement));
const noiseOnly = plan.placements.filter(isNoiseOnly);

describe("pre-filter recall over planted material", () => {
  it("has planted carriers to check, so these assertions are not vacuous", () => {
    expect(carriers.length).toBeGreaterThan(20);
  });

  it.each(carriers.map((placement) => [placement.id, placement] as const))(
    "keeps %s, which carries non-noise coverage",
    (_id, placement) => {
      const result = filter(placement);

      expect(
        result.verdict,
        `Discarded, losing coverage [${placement.coverage.join(", ")}]. Note: ${placement.note}`,
      ).toBe("candidate");
    },
  );

  it("keeps every message carrying a planted case", () => {
    // The five planted cases are the demo. Each is carried by at least one message, and
    // losing every carrier of one means the behaviour it proves cannot be shown.
    const byId = new Map(plan.placements.map((placement) => [placement.id, placement]));

    for (const [name, entry] of Object.entries(plan.cases)) {
      const survivors = entry.messageIds.filter((id) => {
        const placement = byId.get(id);
        if (placement === undefined) return false;
        return filter(placement).verdict === "candidate";
      });

      expect(survivors.length, `Planted case '${name}' has no surviving carrier`).toBeGreaterThan(
        0,
      );
    }
  });

  it("records a version on every verdict, kept and discarded alike", () => {
    // A discard with no version cannot be re-examined when the filter improves, so it is
    // lost rather than merely rejected.
    for (const placement of plan.placements) {
      expect(filter(placement).version).toBe(PREFILTER_VERSION);
    }
  });

  it("still discards the plain acknowledgements planted as noise", () => {
    // Recall is the priority, but a filter that keeps literally everything is not a
    // filter. At least some of the noise placements must actually be dropped.
    const dropped = noiseOnly.filter((placement) => filter(placement).verdict === "discarded");
    expect(dropped.length).toBeGreaterThan(0);
  });
});

describe("pre-filter precision", () => {
  it("discards bare acknowledgements even though 'thanks' is a participation signal", () => {
    // Ordering inside `prefilter` is what makes this pass: the acknowledgement check runs
    // before the signals, or every "thanks" in the chat becomes a candidate.
    for (const text of ["ok", "thanks", "thank you", "got it", "on it", "👍", "haha"]) {
      expect(prefilter({ text }).verdict, text).toBe("discarded");
    }
  });

  it("keeps a thanks-list, which is real participation evidence", () => {
    expect(prefilter({ text: "thanks to Ravi and Meera for the vet run today" }).verdict).toBe(
      "candidate",
    );
  });

  it("does not keep a message on a date word alone", () => {
    // A temporal reference is supporting, not triggering. Promoting it took the keep rate
    // to 81% against a design target of roughly one in five.
    expect(prefilter({ text: "Six calls today, four were about the same dog." }).verdict).toBe(
      "discarded",
    );
  });

  it("does not keep a message on length alone", () => {
    expect(
      prefilter({
        text: "the beagle from the gate has been adopted! family came back a second time and everything",
      }).verdict,
    ).toBe("discarded");
  });

  it("keeps the same words once an asset is named", () => {
    // The pair that shows why temporal reference is supporting rather than triggering.
    expect(prefilter({ text: "the van insurance is due next Tuesday" }).verdict).toBe("candidate");
  });
});

describe("pre-filter signals", () => {
  it("keeps media with no caption, so the gap stays visible", () => {
    const result = prefilter({ text: null, mediaKind: "voice" });
    expect(result.verdict).toBe("candidate");
    expect(result.signals).toContain("media");
  });

  it("discards an empty message with no media", () => {
    expect(prefilter({ text: "   " }).verdict).toBe("discarded");
  });

  it("keeps a spaced Indian mobile number", () => {
    // Ten consecutive digits was the original pattern, and it missed how a number is
    // actually written — including the planted emergency number.
    expect(keepSignals("call +91 98450 33221 if nobody answers")).toContain("contact_detail");
  });

  it("keeps a figure with a unit, which a bare number would not earn", () => {
    expect(keepSignals("we are running at 62 animals a month")).toContain("figure");
    expect(keepSignals("62 of them")).not.toContain("figure");
  });

  it("recognises reported speech, which becomes unverified hearsay", () => {
    expect(keepSignals("Kavya told me the vet said to wait ten days")).toContain("reported_speech");
  });

  it("recognises a termination, which retires a fact rather than superseding it", () => {
    expect(keepSignals("Green Paws are not renewing the sponsorship")).toContain("termination");
  });
});
