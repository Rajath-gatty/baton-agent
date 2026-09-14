/**
 * The two upsert keys.
 *
 * Both fail silently when wrong — one duplicates the register, the other
 * resurrects a dismissal — so the assertions here stand in for a failure that
 * would otherwise have no symptom.
 */

import { describe, expect, it } from "vitest";
import { aspectFor, buildDedupeKey, buildMatchKey } from "../src/keys.js";

describe("buildMatchKey", () => {
  it("groups two spellings of one asset under one key", () => {
    // Without this, every mention of the van keys becomes another active row.
    const a = buildMatchKey({
      assetKind: "physical_item",
      assetName: "The van keys",
      claim: "Anil has the van keys",
      aspect: "holder",
    });
    const b = buildMatchKey({
      assetKind: "physical_item",
      assetName: "van keys",
      claim: "the keys are with Anil",
      aspect: "holder",
    });
    expect(a).toBe(b);
  });

  it("keeps the holder and the terms of one asset in separate groups", () => {
    const holder = buildMatchKey({
      assetKind: "relationship",
      assetName: "Sunrise Clinic",
      claim: "Meera is our contact at Sunrise",
      aspect: "holder",
    });
    const attribute = buildMatchKey({
      assetKind: "relationship",
      assetName: "Sunrise Clinic",
      claim: "Sunrise lets us settle at month end",
      aspect: "attribute",
    });
    expect(holder).not.toBe(attribute);
  });

  it("separates assets of different kinds that share a name", () => {
    const document = buildMatchKey({
      assetKind: "document",
      assetName: "intake form",
      claim: "x",
      aspect: "attribute",
    });
    const login = buildMatchKey({
      assetKind: "account_login",
      assetName: "intake form",
      claim: "x",
      aspect: "attribute",
    });
    expect(document).not.toBe(login);
  });

  it("falls back to the capability when there is no asset", () => {
    const key = buildMatchKey({
      assetKind: null,
      assetName: null,
      capabilityName: "Foster placement",
      claim: "Divya has been placing fosters",
      aspect: "holder",
    });
    expect(key).toBe("capability:foster placement#holder");
  });

  it("falls back to the claim's significant words when there is neither", () => {
    // A fact with no asset can be answered but can never produce a finding, so a
    // coarse key here is acceptable.
    const key = buildMatchKey({
      assetKind: null,
      assetName: null,
      claim: "We are registered as a Section 8 company",
      aspect: "attribute",
    });
    expect(key.startsWith("claim:")).toBe(true);
    expect(key.endsWith("#attribute")).toBe(true);
  });

  it("reaches the same claim key regardless of word order and connectives", () => {
    const a = buildMatchKey({
      assetKind: null,
      assetName: null,
      claim: "the printers are in the back room",
      aspect: "attribute",
    });
    const b = buildMatchKey({
      assetKind: null,
      assetName: null,
      claim: "in the back room are the printers",
      aspect: "attribute",
    });
    expect(a).toBe(b);
  });

  it("stays human-readable, because this is the column read when diagnosing duplicates", () => {
    expect(
      buildMatchKey({
        assetKind: "public_presence",
        assetName: "Razorpay donation page",
        claim: "Meera set it up",
        aspect: "holder",
      }),
    ).toBe("public_presence:razorpay donation page#holder");
  });
});

describe("aspectFor", () => {
  it("is a holder claim when the Curator named a holder", () => {
    expect(aspectFor("Meera")).toBe("holder");
  });

  it("is an attribute claim otherwise", () => {
    expect(aspectFor(null)).toBe("attribute");
    expect(aspectFor("   ")).toBe("attribute");
  });
});

describe("buildDedupeKey", () => {
  it("is stable across sweeps for the same subject", () => {
    const key = { subtype: "sole_holder", type: "asset", subjectId: "asset-uuid" } as const;
    expect(buildDedupeKey(key)).toBe(buildDedupeKey(key));
  });

  it("distinguishes the two queries that both render as sole_holder", () => {
    // Five detection queries, four rendered subtypes. Without `type` in the key,
    // an asset finding and a capability finding would collide and one would
    // overwrite the other.
    expect(
      buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: "same-uuid" }),
    ).not.toBe(
      buildDedupeKey({ subtype: "sole_holder", type: "capability", subjectId: "same-uuid" }),
    );
  });

  it("distinguishes subtypes on the same subject", () => {
    expect(buildDedupeKey({ subtype: "no_owner", type: "asset", subjectId: "a" })).not.toBe(
      buildDedupeKey({ subtype: "not_ours", type: "asset", subjectId: "a" }),
    );
  });

  it("is built from the id, so renaming an asset cannot resurrect a dismissal", () => {
    // Dismissals are recorded against this key. A name-derived key would change
    // when the asset was renamed and the dismissed finding would return.
    expect(buildDedupeKey({ subtype: "no_owner", type: "asset", subjectId: "asset-1" })).toBe(
      "no_owner:asset:asset-1",
    );
  });
});
