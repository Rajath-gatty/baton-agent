/**
 * The value signature — the table that tunes restatement versus contradiction.
 *
 * This is the fuzzy rule in the system, so the cases are written as a table of
 * claim pairs with the verdict each pair must reach. When this needs tuning against
 * real seeded material, this table is the thing to edit — not the fact-writing
 * logic that consumes it.
 */

import { describe, expect, it } from "vitest";
import { salientTokens, valueSignature } from "../src/value-signature.js";

/** Convenience: do these two claims merge, or does the second supersede the first? */
function verdict(
  a: { holder?: string | null; claim: string },
  b: { holder?: string | null; claim: string },
): "merge" | "supersede" {
  const first = valueSignature({ holder: a.holder ?? null, claim: a.claim });
  const second = valueSignature({ holder: b.holder ?? null, claim: b.claim });
  return first === second ? "merge" : "supersede";
}

describe("holder claims are signed by identity", () => {
  it("merges a restatement naming the same holder in different words", () => {
    expect(
      verdict(
        { holder: "person-meera", claim: "Meera set up the Razorpay donation page" },
        { holder: "person-meera", claim: "the Razorpay page is Meera's" },
      ),
    ).toBe("merge");
  });

  it("supersedes when the holder changes, which is a transfer", () => {
    expect(
      verdict(
        { holder: "person-meera", claim: "Meera holds the bank signatory" },
        { holder: "person-anil", claim: "Anil holds the bank signatory" },
      ),
    ).toBe("supersede");
  });

  it("folds an external holder's name, so casing does not transfer an asset back and forth", () => {
    expect(
      verdict(
        { holder: "The Clinic", claim: "the clinic keeps the vaccination records" },
        { holder: "the clinic", claim: "records are with the clinic" },
      ),
    ).toBe("merge");
  });
});

describe("attribute claims are signed by their figures", () => {
  it("merges a reworded arrangement that carries no figure", () => {
    // The seeded restatement row: the same fact months later, different words.
    expect(
      verdict(
        { claim: "Sunrise Clinic lets us settle at month end" },
        { claim: "we can settle up with Sunrise at the end of the month" },
      ),
    ).toBe("merge");
  });

  it("supersedes when a figure changes, which is the clinic's terms changing", () => {
    // The seeded contradiction row.
    expect(
      verdict(
        { claim: "Sunrise Clinic lets us settle at month end" },
        { claim: "Sunrise Clinic now wants payment within 7 days" },
      ),
    ).toBe("supersede");
  });

  it("merges the same figure stated in a different sentence order", () => {
    expect(
      verdict(
        { claim: "we did 47 sterilisations in March" },
        { claim: "in March the count was 47 sterilisations" },
      ),
    ).toBe("merge");
  });

  it("supersedes when the figure itself moves", () => {
    // The stale-answer case depends on this: a changed rate must not merge and
    // present itself as freshly confirmed.
    expect(verdict({ claim: "the rate is 47 a month" }, { claim: "the rate is 62 a month" })).toBe(
      "supersede",
    );
  });

  it("treats a holder claim and an attribute claim as different values", () => {
    expect(verdict({ holder: "person-meera", claim: "x" }, { claim: "x" })).toBe("supersede");
  });
});

describe("salientTokens", () => {
  it("normalises thousands separators and decimals to one form", () => {
    expect(salientTokens("₹1,200")).toEqual(salientTokens("₹1200"));
    expect(salientTokens("₹1,200.00")).toEqual(salientTokens("₹1200"));
  });

  it("does not double-count the number inside a currency amount", () => {
    // Without blanking the matched span, "₹1,200" would yield both inr:1200 and
    // n:1200, and the signature would depend on extraction order.
    expect(salientTokens("₹1,200")).toEqual(["inr:1200"]);
  });

  it("recognises rupees written several ways", () => {
    expect(salientTokens("Rs. 500")).toEqual(["inr:500"]);
    expect(salientTokens("INR 500")).toEqual(["inr:500"]);
    expect(salientTokens("500 rupees")).toEqual(["inr:500"]);
  });

  it("recognises percentages", () => {
    expect(salientTokens("coverage is 45%")).toEqual(["pct:45"]);
    expect(salientTokens("coverage is 45 per cent")).toEqual(["pct:45"]);
  });

  it("recognises dates in both word orders and as ISO", () => {
    expect(salientTokens("8 April")).toEqual(["date:04-08"]);
    expect(salientTokens("April 8")).toEqual(["date:04-08"]);
    expect(salientTokens("2026-04-08")).toEqual(["date:2026-04-08"]);
  });

  it("keeps a bare count, which is the figure the stale answer turns on", () => {
    expect(salientTokens("we did 47 sterilisations")).toEqual(["n:47"]);
  });

  it("de-duplicates and sorts, so repetition and order do not matter", () => {
    expect(salientTokens("47 and 47 and 12")).toEqual(["n:12", "n:47"]);
  });

  it("returns nothing for a claim with no figures", () => {
    // An empty set is a legitimate signature, and the common case for arrangements.
    expect(salientTokens("we settle at month end")).toEqual([]);
  });
});
