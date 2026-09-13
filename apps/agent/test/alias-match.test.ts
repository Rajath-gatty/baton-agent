/**
 * Deterministic alias matching. `[F12]`
 *
 * The Cartographer's zero-cost path. Two properties matter more than raw accuracy:
 *
 *   - It must resolve the ordinary cases, or every mention becomes a model call and the
 *     cheapest agent in the system becomes one of the dearest.
 *   - It must **never break a tie**. "Priya" matching two people is the signal that
 *     produces a clarification question, and a resolver that picked the better score
 *     would convert that signal into a silent guess.
 */

import { describe, expect, it } from "vitest";
import type { AliasEntry } from "@baton/core";
import {
  AliasIndex,
  editDistanceWithin,
  needsEscalation,
  normaliseAlias,
} from "../src/agents/alias-match.js";

const alias = (personId: string, value: string, kind: AliasEntry["kind"] = "first_name") =>
  ({ personId, alias: value, kind, displayName: value }) satisfies AliasEntry;

describe("normaliseAlias", () => {
  it("folds case, strips a handle marker, and collapses whitespace", () => {
    expect(normaliseAlias("  @PRIYA  ")).toBe("priya");
    expect(normaliseAlias("Priya!")).toBe("priya");
    expect(normaliseAlias("Priya   Chandran")).toBe("priya chandran");
  });

  it("keeps non-Latin scripts intact", () => {
    // The group is Indian and names are written in more than one script; stripping
    // anything not [a-z] would silently erase whole aliases.
    expect(normaliseAlias("प्रिया")).toBe("प्रिया");
  });
});

describe("editDistanceWithin", () => {
  it("finds a one-character difference", () => {
    expect(editDistanceWithin("priya", "priyaa", 1)).toBe(1);
    expect(editDistanceWithin("ravi", "ravi", 1)).toBe(0);
  });

  it("returns null past the cap rather than a large number", () => {
    expect(editDistanceWithin("priya", "farhan", 1)).toBeNull();
  });
});

describe("AliasIndex", () => {
  it("resolves an exact match to one person", () => {
    const index = new AliasIndex([alias("p1", "Ravi")]);
    const match = index.resolve("ravi");

    expect(match).toMatchObject({ candidatePersonIds: ["p1"], method: "exact" });
    expect(needsEscalation(match)).toBe(false);
  });

  it("resolves a handle written with an @", () => {
    const index = new AliasIndex([alias("p1", "priya_pc", "handle")]);
    expect(index.resolve("@priya_pc").candidatePersonIds).toEqual(["p1"]);
  });

  it("returns both people when one alias means two, and escalates", () => {
    // The case the whole design turns on.
    const index = new AliasIndex([alias("p1", "Priya"), alias("p2", "Priya")]);
    const match = index.resolve("Priya");

    expect(match.candidatePersonIds.sort()).toEqual(["p1", "p2"]);
    expect(needsEscalation(match)).toBe(true);
  });

  it("matches a bare first name against a fuller recorded name", () => {
    const index = new AliasIndex([alias("p1", "Priya Chandran", "display_name")]);
    const match = index.resolve("Priya");

    expect(match).toMatchObject({ candidatePersonIds: ["p1"], method: "first-name" });
  });

  it("escalates when a first name matches two fuller names", () => {
    const index = new AliasIndex([
      alias("p1", "Priya Chandran", "display_name"),
      alias("p2", "Priya Menon", "display_name"),
    ]);

    expect(needsEscalation(index.resolve("Priya"))).toBe(true);
  });

  it("prefers an exact match over a fuzzy one rather than blending them", () => {
    // "ravi" is exactly p1 and one edit from p2's "ravu". Widening the exact match with
    // the typo match would manufacture an ambiguity that does not exist and send a
    // needless clarification question to the group.
    const index = new AliasIndex([alias("p1", "Ravi"), alias("p2", "Ravu")]);
    const match = index.resolve("Ravi");

    expect(match).toMatchObject({ candidatePersonIds: ["p1"], method: "exact" });
  });

  it("recovers from a single typo", () => {
    const index = new AliasIndex([alias("p1", "Farhan")]);
    expect(index.resolve("Farhen")).toMatchObject({
      candidatePersonIds: ["p1"],
      method: "typo",
    });
  });

  it("does not fuzzy-match very short mentions", () => {
    // At three characters or fewer, one edit away covers much of a roster.
    const index = new AliasIndex([alias("p1", "Ram")]);
    expect(index.resolve("Raj").candidatePersonIds).toEqual([]);
  });

  it("escalates a mention that matches nobody, since it may be an outsider", () => {
    const index = new AliasIndex([alias("p1", "Ravi")]);
    const match = index.resolve("the landlord");

    expect(match).toMatchObject({ candidatePersonIds: [], method: "none" });
    expect(needsEscalation(match)).toBe(true);
  });

  it("collapses duplicate aliases for the same person", () => {
    const index = new AliasIndex([alias("p1", "Ravi"), alias("p1", "ravi")]);
    expect(index.resolve("Ravi").candidatePersonIds).toEqual(["p1"]);
  });
});
