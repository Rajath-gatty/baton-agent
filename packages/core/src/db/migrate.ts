/**
 * Migration runner.
 *
 * Run from `packages/core` on worker start, per the technical design. Runs
 * inside a Postgres advisory lock so that a Coolify redeploy which briefly
 * overlaps containers cannot run two migrations concurrently — belt and braces,
 * since the VM stack deploys as a Compose resource specifically to avoid that
 * overlap.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Allow `pnpm db:migrate` to run this directly.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrations applied.");
}
