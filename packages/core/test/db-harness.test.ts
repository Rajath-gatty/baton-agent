/**
 * The integration test harness, tested.
 *
 * A harness whose safety guard has never been observed failing is
 * indistinguishable from one that always passes, so the guard cases here matter
 * more than the round trip: they are what stands between an integration test and
 * the development database.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl, setupTestDatabase, type TestDatabase } from "../src/db/testing.js";
import { people } from "../src/db/schema.js";

describe("the test database guard", () => {
  it("refuses to run with no TEST_DATABASE_URL", () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("refuses to run when the test URL is the application URL", () => {
    // The dangerous case: it looks configured. Without this the suite would
    // truncate the seeded six months and still report green.
    expect(() =>
      resolveTestDatabaseUrl({
        DATABASE_URL: "postgres://baton:baton@localhost:5433/baton",
        TEST_DATABASE_URL: "postgres://baton:baton@localhost:5433/baton",
      }),
    ).toThrow(/identical to DATABASE_URL/);
  });

  it("is not fooled by a trailing slash", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        DATABASE_URL: "postgres://baton:baton@localhost:5433/baton",
        TEST_DATABASE_URL: "postgres://baton:baton@localhost:5433/baton/",
      }),
    ).toThrow(/identical to DATABASE_URL/);
  });

  it("accepts a genuinely separate database", () => {
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: "postgres://baton:baton@localhost:5433/baton",
        TEST_DATABASE_URL: "postgres://baton:baton@localhost:5433/baton_test",
      }),
    ).toBe("postgres://baton:baton@localhost:5433/baton_test");
  });
});

describe("the test database itself", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("has the migrated schema", async () => {
    const rows = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    // The schema is 20 tables today. Asserting the floor rather than the exact
    // number so adding a table is not a failing test in an unrelated file.
    expect(Number([...rows][0]?.count ?? 0)).toBeGreaterThanOrEqual(20);
  });

  it("writes and reads back", async () => {
    await harness.truncate();
    await harness.db.insert(people).values({ displayName: "Priya Raghavan" });
    const rows = await harness.db.select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Priya Raghavan");
  });

  it("truncates between cases", async () => {
    // Depends on the row the previous case wrote, which is the behaviour under
    // test: without truncation that row is still here.
    await harness.truncate();
    const rows = await harness.db.select().from(people);
    expect(rows).toHaveLength(0);
  });

  it("keeps the applied-migration record through a truncation", async () => {
    // `__drizzle_migrations` lives in the `drizzle` schema, not `public`. If a
    // truncation reached it, the next run would replay every migration and fail
    // on an existing table.
    await harness.truncate();
    const rows = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from drizzle.__drizzle_migrations
    `);
    expect(Number([...rows][0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
