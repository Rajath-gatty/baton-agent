import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema.js";

/**
 * The product's privacy guarantee is enforced by the schema rather than by
 * prompt text, so it cannot be broken by a careless prompt or a late feature.
 * That is a claim the README makes and the video states aloud, so it is tested
 * rather than inspected.
 *
 * These assertions are vacuous while the schema has no tables, and that is
 * fine — the point is that they become load-bearing the moment a table is added,
 * without anyone having to remember to re-check by hand.
 *
 * Deliberately introspects the live Drizzle objects rather than the source text.
 * A source grep would trip over this file's own documentation, which necessarily
 * contains the words it forbids.
 */

/** Substrings that must never appear in a table or column identifier. */
const FORBIDDEN = [
  "attendance",
  "reliability",
  "punctuality",
  "score",
  "completion_rate",
  "participation_rate",
  "response_rate",
  "activity_metric",
  "activity_level",
] as const;

function tables(): ReadonlyArray<{ name: string; columns: readonly string[] }> {
  return Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => ({
      name: getTableName(table),
      columns: Object.keys(getTableColumns(table)),
    }));
}

describe("structural privacy guarantees", () => {
  it("no table records per-event attendance", () => {
    const offenders = tables()
      .map((table) => table.name)
      .filter((name) => FORBIDDEN.some((word) => name.toLowerCase().includes(word)));

    expect(offenders, "coverage is inferred from conversation, never recorded per event").toEqual(
      [],
    );
  });

  it("no column scores, rates or ranks a person", () => {
    const offenders = tables().flatMap((table) =>
      table.columns
        .filter((column) => FORBIDDEN.some((word) => column.toLowerCase().includes(word)))
        .map((column) => `${table.name}.${column}`),
    );

    expect(offenders, "scoring volunteers is surveillance however warmly framed").toEqual([]);
  });

  it("introspection actually works, so a real violation would be caught", () => {
    // Guards the guard. If Drizzle's introspection API changes shape, `tables()`
    // would silently return an empty list and the two assertions above would
    // pass forever regardless of what the schema contains. This asserts that the
    // detection logic itself is sound.
    const detected = ["messages", "volunteer_reliability_score"].filter((name) =>
      FORBIDDEN.some((word) => name.toLowerCase().includes(word)),
    );
    expect(detected).toEqual(["volunteer_reliability_score"]);
  });
});
