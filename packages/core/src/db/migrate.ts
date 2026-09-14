/**
 * Migration runner.
 *
 * Run from `packages/core` on worker start, per the technical design. A dedicated
 * single connection is used: the migrator must not share the application pool.
 *
 * Drizzle's migrator takes its own transaction per migration file and records
 * applied migrations in `drizzle.__drizzle_migrations`, so running this twice is a
 * no-op rather than an error — which matters because the worker runs it on every
 * start, and Coolify restarts the worker whenever it exits.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(url: string): Promise<void> {
  // A dedicated single connection: the migrator must not share the app pool.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The tables that now exist, so `pnpm db:migrate` proves what it did instead of
 * printing "Migrations applied." whether or not anything was created.
 */
async function listTables(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    return rows.map((row) => row.table_name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Allow `pnpm db:migrate` to run this directly.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `loadDotEnv` rather than Node's built-in `process.loadEnvFile`: the built-in will not
  // override a name already in the environment, and counts one set to the empty string as
  // set — so a shell exporting empty placeholders silently beats a filled `.env`, and the
  // resulting error names a variable you can see is populated.
  //
  // Only the CLI path does this. The worker's configuration is validated eagerly from its
  // real environment, and silently reading a stray local `.env` inside a container would
  // be a way to migrate the wrong database.
  const { loadDotEnv } = await import("../env.js");
  loadDotEnv(fileURLToPath(new URL("../../../../.env", import.meta.url)));

  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    console.error("DATABASE_URL is not set, and no .env at the repository root supplied one.");
    process.exit(1);
  }

  await runMigrations(url);
  const tables = await listTables(url);
  console.log(`Migrations applied. ${tables.length} tables in public:`);
  console.log(tables.map((name) => `  ${name}`).join("\n"));
}
