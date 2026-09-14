/**
 * The normalisation primitives.
 *
 * These are shared by three components that never see each other, so the
 * assertions here are the only thing keeping them in agreement.
 */

import { describe, expect, it } from "vitest";
import { contentHash, normaliseAlias, normaliseAssetKey } from "../src/normalise.js";

describe("normaliseAlias", () => {
  it("case-folds, strips a leading handle marker and collapses whitespace", () => {
    expect(normaliseAlias("Priya!")).toBe("priya");
    expect(normaliseAlias("@priya")).toBe("priya");
    expect(normaliseAlias("  PRIYA ")).toBe("priya");
    expect(normaliseAlias("@@priya_pc")).toBe("priyapc");
  });

  it("preserves combining marks, so Devanagari names do not become a different string", () => {
    // The whole reason the character class is \p{L}\p{N}\p{M} and not \p{L}\p{N}.
    // Dropping marks turns this into "परय", which matches nothing.
    expect(normaliseAlias("प्रिया")).toBe("प्रिया");
  });

  it("collapses interior whitespace so a display name matches however it was typed", () => {
    expect(normaliseAlias("Priya   Raghavan")).toBe("priya raghavan");
  });

  it("returns empty for a mention made only of punctuation", () => {
    expect(normaliseAlias("!!!")).toBe("");
  });
});

describe("normaliseAssetKey", () => {
  it("case-folds and de-articles", () => {
    expect(normaliseAssetKey("The van")).toBe("van");
    expect(normaliseAssetKey("Razorpay donation page")).toBe("razorpay donation page");
  });

  it("removes articles wherever they appear, not only at the start", () => {
    // "keys to the van" and "keys to van" are one asset, not two.
    expect(normaliseAssetKey("keys to the van")).toBe("keys to van");
    expect(normaliseAssetKey("keys to van")).toBe("keys to van");
  });

  it("makes two spellings of one asset collide", () => {
    expect(normaliseAssetKey("The Van Keys")).toBe(normaliseAssetKey("van keys"));
  });

  it("drops punctuation without joining words together", () => {
    expect(normaliseAssetKey("Sunrise Clinic's account")).toBe("sunrise clinic s account");
  });

  it("does not normalise an all-article name down to nothing", () => {
    // An empty key would collide with every other empty key.
    expect(normaliseAssetKey("The A")).toBe("the a");
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("Sunrise Clinic lets us settle at month end")).toBe(
      contentHash("Sunrise Clinic lets us settle at month end"),
    );
  });

  it("changes when the text is edited, so an edit misses the cache", () => {
    // The property the curator cache depends on. If a corrected message reused the
    // classification of the text it replaced, the edit would be invisible.
    expect(contentHash("we did 47 sterilisations")).not.toBe(
      contentHash("we did 74 sterilisations"),
    );
  });

  it("does not normalise whitespace away", () => {
    // Deliberate: any edit at all should miss, including a whitespace-only one.
    expect(contentHash("month end")).not.toBe(contentHash("month  end"));
  });

  it("treats null text as the empty string", () => {
    // Voice notes and images. Flagged unprocessed and never curated, so a shared
    // hash costs nothing.
    expect(contentHash(null)).toBe(contentHash(""));
  });
});
