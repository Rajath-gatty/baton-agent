/**
 * The integration test harness.
 *
 * Lives in core rather than in the worker because both the worker's tests and
 * the scripts' tests need a real database, and two harnesses would drift on the
 * one thing that matters here — which database they are allowed to destroy.
 *
 * Reached through the explicit `@baton/core/db/testing` entry point rather than
 * the `./db` barrel, so test-only code never loads in a production container.
 *
 * **The guard is the point of this module.** Integration tests truncate every
 * table between cases. Pointed at the development database that would destroy
 * the seeded six months and the golden reset point, and it would do so silently
 * — the tests would pass. So the URL is required to be explicitly separate, and
 * a harness that cannot prove that refuses to run at all.
 */

import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";

/**
 * Loads the repository root `.env` when the environment has not already supplied
 * the URLs. Vitest does not read `.env`, and requiring every contributor to
 * export two variables by hand before running tests is how integration tests end
 * up skipped.
 */
function loadRootEnvOnce(env: NodeJS.ProcessEnv): void {
  if (env["TEST_DATABASE_URL"] !== undefined && env["TEST_DATABASE_URL"] !== "") return;
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
  } catch {
    // No .env at the repository root. The check below reports the consequence
    // rather than failing on a missing file, which is not itself the problem.
  }
}

/**
 * Resolves the test database URL, or explains precisely what is wrong.
 *
 * Two failure modes, both fatal and both deliberate: no URL at all, and a URL
 * equal to `DATABASE_URL`. The second is the dangerous one — it looks configured.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  loadRootEnvOnce(env);

  const testUrl = env["TEST_DATABASE_URL"];
  if (testUrl === undefined || testUrl.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests truncate every table, so they " +
        "require a database separate from DATABASE_URL. See .env.example.",
    );
  }

  const appUrl = env["DATABASE_URL"];
  if (appUrl !== undefined && normaliseUrl(appUrl) === normaliseUrl(testUrl)) {
    throw new Error(
      "TEST_DATABASE_URL is identical to DATABASE_URL. Integration tests truncate every " +
        "table; running them against the development database would destroy the seeded " +
        "history and the golden reset point without failing a single assertion.",
    );
  }

  return testUrl;
}

/** Trailing slashes and surrounding whitespace do not make two URLs different. */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The tables to empty between cases, read from the database rather than from the
 * Drizzle objects.
 *
 * Introspection rather than a hand-kept list because a table added later must be
 * truncated too, and nobody will remember to add it here. Drizzle's own
 * `__drizzle_migrations` lives in the `drizzle` schema, so filtering to `public`
 * leaves the applied-migration record intact — otherwise every truncation would
 * make the next migration run think it had never run.
 */
async function publicTables(db: Database): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  return [...rows].map((row) => row.table_name);
}

/**
 * Empties every table in one statement.
 *
 * `CASCADE` because the schema is full of foreign keys and truncating in
 * dependency order by hand is a maintenance burden with no benefit. One
 * statement rather than one per table so it is atomic: a partial truncation
 * between cases is worse than none, since the next test starts from a state no
 * fixture describes.
 */
export async function truncateAllTables(db: Database): Promise<void> {
  const tables = await publicTables(db);
  if (tables.length === 0) return;

  const list = tables.map((name) => `"${name}"`).join(", ");
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}

export interface TestDatabase {
  db: Database;
  url: string;
  /** Empties every table. Call in `beforeEach`, not `afterEach` — a failed test's rows are worth reading. */
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Migrates the test database and returns a client for it.
 *
 * Migrations run every time. They are idempotent — Drizzle records what it has
 * applied — and running them here means a schema change never has to be applied
 * to the test database by hand, which is the kind of step that gets skipped and
 * then produces a failure that looks like a code bug.
 */
export async function setupTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDatabase> {
  const url = resolveTestDatabaseUrl(env);
  await runMigrations(url);

  // A small pool: these are single-threaded tests, and Postgres runs in a
  // container beside them.
  const db = createDatabase({ url, max: 2 });

  return {
    db,
    url,
    truncate: () => truncateAllTables(db),
    close: async () => {
      // drizzle-orm's postgres-js driver exposes the underlying client here.
      // Closing it matters: an open pool keeps the vitest process alive.
      const client = (
        db as unknown as { $client: { end: (opts?: { timeout?: number }) => Promise<void> } }
      ).$client;
      await client.end({ timeout: 5 });
    },
  };
}
