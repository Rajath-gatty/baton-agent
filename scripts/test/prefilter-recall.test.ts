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
 *
 * **Scope, deliberately narrow.** Rule-level behaviour — which signal fires, the recall
 * floor over a labelled corpus, keep-rate bounds, reaction-before-signal ordering — is
 * owned by `packages/core/test/prefilter.test.ts`, beside the implementation. This file
 * asserts only what that one cannot: that the filter, whatever its rules, does not drop
 * the material the seeded demo depends on. Two files asserting the same rules is how they
 * come to disagree.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prefilter, PREFILTER_VERSION } from "@baton/core";
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
 * `isUnprocessed` is derived exactly as `fromRenderedMessage` derives it — media
 * present *and* no text to read. Deriving it differently here would test a call the
 * seed adapter never makes, which is the whole failure this file exists to catch: a
 * placement carrying a caption must be judged on that caption, not dismissed as an
 * unreadable file.
 */
function filter(placement: Placement) {
  const hasText = placement.text.trim() !== "";
  return prefilter({
    text: hasText ? placement.text : null,
    isUnprocessed: placement.flags.media !== undefined && !hasText,
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
        `Discarded (reason: ${result.reason}), losing coverage [${placement.coverage.join(
          ", ",
        )}]. Note: ${placement.note}`,
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

describe("the placements are judged on their text, not on their attachments", () => {
  // These two assertions are about the seam between the plan fixture and the seed
  // adapter, which is why they live here rather than in core. `isUnprocessed` is the
  // one input this file synthesises, so it is the one input it can get wrong.

  it("never dismisses a text-bearing placement as unreadable media", () => {
    // A `no_text` verdict on a placement that has words in it means the derivation
    // above is wrong — the caption was thrown away and the coverage row it carries
    // went with it, silently.
    const wrongly = plan.placements.filter(
      (placement) => placement.text.trim() !== "" && filter(placement).reason === "no_text",
    );

    expect(wrongly.map((placement) => `${placement.id}: ${placement.note}`)).toEqual([]);
  });

  it("judges a captioned attachment on its caption", () => {
    // The media coverage row is carried by placements that have both an attachment and
    // text. Under the adapter's rule they are not `unprocessed`, so the caption is
    // curated normally and the flag marks only a genuinely unreadable file.
    const captioned = plan.placements.filter(
      (placement) => placement.flags.media !== undefined && placement.text.trim() !== "",
    );

    for (const placement of captioned) {
      expect(filter(placement).reason, `${placement.id}: ${placement.note}`).not.toBe("no_text");
    }
  });
});
